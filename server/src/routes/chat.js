'use strict';
/**
 * 会话与消息路由（云开发版）。
 *
 * 实时推送主链路：小程序端 db.watch 监听云数据库 conv_messages 集合。
 * 历史消息 / 兜底：GET /api/conversations/:id/messages（轮询）。
 * 发送消息：POST /api/conversations/:id/messages
 *   - MySQL 主写（同步）
 *   - 云数据库触发 db.watch（fire-and-forget，走 publishMessageDoc 带超时兜底）
 */
const { readJson, ok, err } = require('../lib/http');
const { nowIso, v } = require('../lib/util');
const { query, queryOne } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { contentCheck, publishMessageDoc } = require('../services/chat-svc');
const { getStorage } = require('../tcb');

/** 云存储 tempFileURL 短期缓存，避免每次会话列表都发一堆 getTempFileURL。 */
const AVATAR_CACHE_TTL_MS = 60 * 1000;
const _avatarCache = new Map(); // fileID -> { url, expires }

/** 批量把 cloud:// avatarUrl 转成 https tempFileURL；直传的 https/URL 原样返回。 */
async function resolveAvatarUrls(rawUrls) {
  const out = new Map();
  const cloudIds = [];
  const now = Date.now();
  for (const u of rawUrls) {
    if (!u) continue;
    if (!u.startsWith('cloud://')) { out.set(u, u); continue; }
    const cached = _avatarCache.get(u);
    if (cached && cached.expires > now) { out.set(u, cached.url); continue; }
    cloudIds.push(u);
  }
  if (cloudIds.length) {
    try {
      const r = await getStorage().getTempFileURL({ fileList: cloudIds });
      const list = r.fileList || [];
      cloudIds.forEach((fid, i) => {
        const item = list[i];
        const url = item && item.tempFileURL ? item.tempFileURL : '';
        if (url) {
          out.set(fid, url);
          _avatarCache.set(fid, { url, expires: now + AVATAR_CACHE_TTL_MS });
        } else {
          out.set(fid, ''); // 拿不到就置空，前端走占位图
        }
      });
    } catch (e) {
      console.warn('[chat] resolveAvatarUrls failed', e.message);
      cloudIds.forEach((fid) => out.set(fid, ''));
    }
  }
  return out;
}

async function myConversation(user, convId) {
  const c = await queryOne(`SELECT * FROM conversations WHERE id = ?`, [convId]);
  if (!c) throw err.notFound('会话不存在');
  if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
  return c;
}

function register(router) {
  // GET /api/conversations —— 我的会话列表（含未读数与最后一条消息）
  router.get('/api/conversations', async (req, res) => {
    const user = await requireUser(req);
    const rows = await query(
      `SELECT * FROM conversations WHERE customerId = ? OR engineerId = ?
       ORDER BY lastMsgAt DESC LIMIT 50`, [user.id, user.id]);

    // 1) 先把每个会话的 peer 原始 avatarUrl 收集起来，最后批量解 tempFileURL
    const peerRawUrls = [];
    const enriched = await Promise.all(rows.map(async (c) => {
      const o = await queryOne(`SELECT projectName, orderNo, status FROM orders WHERE id = ?`, [c.orderId]);
      const peerId = c.customerId === user.id ? c.engineerId : c.customerId;
      const peerRow = await queryOne(`SELECT nickname, avatarUrl FROM users WHERE id = ?`, [peerId]);
      const peer = peerRow ? { nickname: peerRow.nickname, avatarUrl: peerRow.avatarUrl || '' } : null;
      if (peer && peer.avatarUrl) peerRawUrls.push(peer.avatarUrl);
      const last = await queryOne(
        `SELECT type, content, createdAt FROM messages WHERE convId = ? ORDER BY id DESC LIMIT 1`, [c.id]);
      const unreadRow = await queryOne(
        `SELECT COUNT(*) AS c FROM messages
         WHERE convId = ? AND senderId != ? AND senderId != 'SYSTEM' AND readAt IS NULL`,
        [c.id, user.id]);
      return {
        id: c.id,
        orderId: c.orderId,
        order: o,
        peer,
        lastMessage: last || null,
        unread: unreadRow ? unreadRow.c : 0,
        lastMsgAt: c.lastMsgAt,
      };
    }));

    // 2) 一次批量解 tempFileURL，回填到 peer.avatarUrl
    const avatarMap = await resolveAvatarUrls(peerRawUrls);
    for (const item of enriched) {
      if (item.peer && item.peer.avatarUrl) {
        item.peer.avatarUrl = avatarMap.get(item.peer.avatarUrl) ?? item.peer.avatarUrl;
      }
    }
    ok(res, enriched);
  });

  // GET /api/conversations/by-order/:orderId
  router.get('/api/conversations/by-order/:orderId', async (req, res, params) => {
    const user = await requireUser(req);
    const c = await queryOne(`SELECT * FROM conversations WHERE orderId = ?`, [params.orderId]);
    if (!c) throw err.notFound('会话尚未创建（支付成功后自动创建）');
    if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
    ok(res, { id: c.id });
  });

  // GET /api/conversations/:id/messages?after=0&limit=50 —— 轮询历史（兜底 + 历史加载）
  router.get('/api/conversations/:id/messages', async (req, res, params, query_) => {
    const user = await requireUser(req);
    const c = await myConversation(user, params.id);
    const after = query_.get('after') ? v.int(query_.get('after'), 'after', { min: 0, max: 2147483647 }) : 0;
    const limit = query_.get('limit') ? v.int(query_.get('limit'), 'limit', { min: 1, max: 100 }) : 50;
    const rows = await query(
      `SELECT m.* FROM messages m
       WHERE m.convId = ? AND m.id > ? ORDER BY m.id LIMIT ${limit}`,
      [c.id, after]);

    // 置已读
    await query(
      `UPDATE messages SET readAt = ? WHERE convId = ? AND senderId != ? AND readAt IS NULL`,
      [nowIso(), c.id, user.id]);

    const peerId = c.customerId === user.id ? c.engineerId : c.customerId;
    const peerRow = await queryOne(`SELECT id, nickname, avatarUrl FROM users WHERE id = ?`, [peerId]);
    let peer = null;
    if (peerRow) {
      let avatarUrl = peerRow.avatarUrl || '';
      if (avatarUrl) {
        const m = await resolveAvatarUrls([avatarUrl]);
        avatarUrl = m.get(avatarUrl) ?? '';
      }
      peer = { id: peerRow.id, nickname: peerRow.nickname, avatarUrl };
    }

    // 批量获取图片临时链接
    const imageFileIds = rows
      .filter((m) => m.type === 'IMAGE' && m.fileId)
      .map((m) => m.fileId);
    const tempUrlMap = {};
    if (imageFileIds.length) {
      try {
        // fileId 字段存的是 uploaded_files.id，需要先查 fileID（云存储路径）
        const files = await query(
          `SELECT id, fileID FROM uploaded_files WHERE id IN (${imageFileIds.map(() => '?').join(',')})`,
          imageFileIds
        );
        const cloudIDs = files.map((f) => f.fileID);
        const result = await getStorage().getTempFileURL({ fileList: cloudIDs });
        const urlList = result.fileList || [];
        files.forEach((f, i) => {
          if (urlList[i]) tempUrlMap[f.id] = urlList[i].tempFileURL;
        });
      } catch (e) { console.error('[chat] getTempFileURL failed', e.message); }
    }

    ok(res, {
      peer,
      items: rows.map((m) => ({
        id: Number(m.id),
        senderId: m.senderId,
        type: m.type,
        content: m.content,
        fileId: m.fileId,
        imgUrl: m.type === 'IMAGE' && m.fileId ? (tempUrlMap[m.fileId] || '') : '',
        createdAt: m.createdAt,
      })),
      lastId: rows.length ? Number(rows[rows.length - 1].id) : after,
    });
  });

  // POST /api/conversations/:id/messages { type, content?, fileId? }
  router.post('/api/conversations/:id/messages', async (req, res, params) => {
    const user = await requireUser(req);
    const c = await myConversation(user, params.id);
    const b = await readJson(req);
    const type = v.oneOf(b.type || 'TEXT', '消息类型', ['TEXT', 'IMAGE', 'FILE']);
    let content = null;
    let fileId = null;

    if (type === 'TEXT') {
      content = v.str(b.content, '消息内容', { min: 1, max: 2000 });
      await contentCheck(content, user.openid);
    } else {
      fileId = v.str(b.fileId, 'fileId', { min: 1 });
      const f = await queryOne(`SELECT * FROM uploaded_files WHERE id = ? AND uploaderId = ?`, [fileId, user.id]);
      if (!f) throw err.bad('文件不存在或不属于你');
      // 未挂订单的文件自动关联当前会话的订单
      if (!f.orderId) await query(`UPDATE uploaded_files SET orderId = ? WHERE id = ?`, [c.orderId, fileId]);
      content = f.name;
    }

    // 1) MySQL 主写（同步，快）
    const now = nowIso();
    const r = await query(
      `INSERT INTO messages(convId, senderId, type, content, fileId, createdAt) VALUES(?,?,?,?,?,?)`,
      [c.id, user.id, type, content, fileId, now]);
    await query(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, [now, c.id]);
    const msgId = Number(r.insertId);

    // 2) 立即返回给前端；云 DB 推送 fire-and-forget（超时/失败不阻塞用户）
    ok(res, {
      id: msgId,
      senderId: user.id,
      type, content, fileId,
      createdAt: now,
    });
    publishMessageDoc({
      convId: c.id,
      senderOpenid: user.openid || user.id,
      senderUserId: user.id,
      type,
      content,
      fileId,
      sqlMsgId: msgId,
    });
  });

  // POST /api/conversations/:id/read —— 标记已读
  router.post('/api/conversations/:id/read', async (req, res, params) => {
    const user = await requireUser(req);
    const c = await myConversation(user, params.id);
    await query(
      `UPDATE messages SET readAt = ? WHERE convId = ? AND senderId != ? AND readAt IS NULL`,
      [nowIso(), c.id, user.id]);
    ok(res, { read: true });
  });
}

module.exports = { register };
