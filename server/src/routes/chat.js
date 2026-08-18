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
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireUser, requireCustomer } = require('../lib/auth-mw');
const { contentCheck, publishConversationDoc, publishMessageDoc } = require('../services/chat-svc');

async function myConversation(user, convId) {
  const c = await queryOne(`SELECT * FROM conversations WHERE id = ?`, [convId]);
  if (!c) throw err.notFound('会话不存在');
  if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
  return c;
}

async function conversationSendAccess(c) {
  const state = await queryOne(
    `SELECT o.status AS orderStatus, o.deletedAt,
            selected.engineerId AS selectedEngineerId,
            offered.status AS quoteStatus
       FROM orders o
       LEFT JOIN quotes selected ON selected.id = o.selectedQuoteId
       LEFT JOIN quotes offered ON offered.orderId = o.id AND offered.engineerId = ?
      WHERE o.id = ?`,
    [c.engineerId, c.orderId]
  );
  if (!state || state.deletedAt) {
    return { canSend: false, reason: '订单已不存在，当前会话仅供查看' };
  }
  if (state.selectedEngineerId === c.engineerId) {
    return { canSend: true, reason: '' };
  }
  if (state.orderStatus === 'QUOTING' && state.quoteStatus === 'PENDING') {
    return { canSend: true, reason: '' };
  }
  return { canSend: false, reason: '报价阶段已结束，当前会话仅供查看' };
}

function register(router) {
  // GET /api/conversations —— 我的会话列表（含未读数与最后一条消息）
  router.get('/api/conversations', async (req, res) => {
    const user = await requireUser(req);
    const rows = await query(
      `SELECT * FROM conversations WHERE customerId = ? OR engineerId = ?
       ORDER BY lastMsgAt DESC LIMIT 50`, [user.id, user.id]);

    const enriched = await Promise.all(rows.map(async (c) => {
      const o = await queryOne(`SELECT projectName, orderNo, status FROM orders WHERE id = ?`, [c.orderId]);
      const peerId = c.customerId === user.id ? c.engineerId : c.customerId;
      const peerRow = await queryOne(`SELECT nickname, avatarUrl FROM users WHERE id = ?`, [peerId]);
      const peer = peerRow ? { nickname: peerRow.nickname, avatarUrl: peerRow.avatarUrl || '' } : null;
      const last = await queryOne(
        `SELECT type, content, fileId, createdAt FROM messages WHERE convId = ? ORDER BY id DESC LIMIT 1`, [c.id]);
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
        unread: Number(unreadRow?.c || 0),
        lastMsgAt: c.lastMsgAt,
      };
    }));

    ok(res, enriched);
  });

  // POST /api/orders/:orderId/quotes/:quoteId/conversation
  // 客户在选标前与某位已报价工程师建立一对一会话。
  router.post('/api/orders/:orderId/quotes/:quoteId/conversation', async (req, res, params) => {
    const customer = await requireCustomer(req);
    const result = await tx(async (conn) => {
      const [[order]] = await conn.execute(
        `SELECT id, customerId, status FROM orders
          WHERE id = ? AND deletedAt IS NULL FOR UPDATE`,
        [params.orderId]
      );
      if (!order) throw err.notFound('订单不存在');
      if (order.customerId !== customer.id) throw err.forbidden('仅订单发布者可以发起报价沟通');
      if (order.status !== 'QUOTING') throw err.conflict('订单已结束报价，不能再发起新的报价沟通');

      const [[quote]] = await conn.execute(
        `SELECT id, engineerId FROM quotes
          WHERE id = ? AND orderId = ? AND status = 'PENDING'`,
        [params.quoteId, order.id]
      );
      if (!quote) throw err.conflict('该报价已失效，无法发起沟通');

      const [[existing]] = await conn.execute(
        `SELECT * FROM conversations WHERE orderId = ? AND engineerId = ?`,
        [order.id, quote.engineerId]
      );
      if (existing) return { conversation: existing, isNew: false };

      const id = newId();
      const now = nowIso();
      await conn.execute(
        `INSERT INTO conversations(id, orderId, customerId, engineerId, lastMsgAt, createdAt)
         VALUES(?,?,?,?,?,?)`,
        [id, order.id, customer.id, quote.engineerId, now, now]
      );
      const [[conversation]] = await conn.execute(`SELECT * FROM conversations WHERE id = ?`, [id]);
      return { conversation, isNew: true };
    });

    if (result.isNew) publishConversationDoc(result.conversation);
    ok(res, { id: result.conversation.id });
  });

  // GET /api/conversations/by-order/:orderId
  // 履约聊天始终定位到最终被选中工程师，避免同一订单的报价会话互相串线。
  router.get('/api/conversations/by-order/:orderId', async (req, res, params) => {
    const user = await requireUser(req);
    const c = await queryOne(
      `SELECT c.*
         FROM orders o
         JOIN quotes q ON q.id = o.selectedQuoteId
         JOIN conversations c ON c.orderId = o.id AND c.engineerId = q.engineerId
        WHERE o.id = ?`,
      [params.orderId]
    );
    if (!c) throw err.notFound('会话尚未创建（支付成功后自动创建）');
    if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
    ok(res, { id: c.id });
  });

  // GET /api/conversations/:id/messages?after=0&limit=50 —— 轮询历史（兜底 + 历史加载）
  router.get('/api/conversations/:id/messages', async (req, res, params, query_) => {
    const user = await requireUser(req);
    const c = await myConversation(user, params.id);
    const sendAccess = await conversationSendAccess(c);
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
    const peer = peerRow
      ? { id: peerRow.id, nickname: peerRow.nickname, avatarUrl: peerRow.avatarUrl || '' }
      : null;

    // 小程序端可直接显示同环境的 cloud:// fileID，避免云托管后端获取
    // tempFileURL 时依赖内部凭据服务并阻塞聊天接口。
    const imageFileIds = rows
      .filter((m) => m.type === 'IMAGE' && m.fileId)
      .map((m) => m.fileId);
    const imageUrlMap = {};
    if (imageFileIds.length) {
      const files = await query(
        `SELECT id, fileID FROM uploaded_files WHERE id IN (${imageFileIds.map(() => '?').join(',')})`,
        imageFileIds
      );
      files.forEach((f) => { imageUrlMap[f.id] = f.fileID || ''; });
    }

    ok(res, {
      peer,
      canSend: sendAccess.canSend,
      sendDisabledReason: sendAccess.reason,
      items: rows.map((m) => ({
        id: Number(m.id),
        senderId: m.senderId,
        type: m.type,
        content: m.content,
        fileId: m.fileId,
        actionOrderId: m.type === 'SYSTEM' && m.fileId ? m.fileId : null,
        imgUrl: m.type === 'IMAGE' && m.fileId ? (imageUrlMap[m.fileId] || '') : '',
        createdAt: m.createdAt,
      })),
      lastId: rows.length ? Number(rows[rows.length - 1].id) : after,
    });
  });

  // POST /api/conversations/:id/messages { type, content?, fileId? }
  router.post('/api/conversations/:id/messages', async (req, res, params) => {
    const user = await requireUser(req);
    const c = await myConversation(user, params.id);
    const sendAccess = await conversationSendAccess(c);
    if (!sendAccess.canSend) throw err.conflict(sendAccess.reason);
    const b = await readJson(req);
    const type = v.oneOf(b.type || 'TEXT', '消息类型', ['TEXT', 'IMAGE', 'FILE']);
    let content = null;
    let fileId = null;
    let attachedFile = null;

    if (type === 'TEXT') {
      content = v.str(b.content, '消息内容', { min: 1, max: 2000 });
      await contentCheck(content, user.openid);
    } else {
      fileId = v.str(b.fileId, 'fileId', { min: 1 });
      const f = await queryOne(`SELECT * FROM uploaded_files WHERE id = ? AND uploaderId = ?`, [fileId, user.id]);
      if (!f) throw err.bad('文件不存在或不属于你');
      if (f.orderId && f.orderId !== c.orderId) throw err.forbidden('不能发送其他订单的文件');
      attachedFile = f;
      content = f.name;
    }

    // 1) MySQL 主写（同步，快）
    const now = nowIso();
    const msgId = await tx(async (conn) => {
      if (attachedFile && !attachedFile.orderId) {
        const [linked] = await conn.execute(
          `UPDATE uploaded_files SET orderId = ? WHERE id = ? AND uploaderId = ? AND orderId IS NULL`,
          [c.orderId, fileId, user.id]
        );
        if (linked.affectedRows !== 1) throw err.conflict('文件状态已变化，请重新发送');
        await conn.execute(
          `INSERT INTO order_attachments(orderId, fileId, uploaderId, purpose, createdAt)
           VALUES(?, ?, ?, 'CHAT', ?)`,
          [c.orderId, fileId, user.id, now]
        );
      } else if (attachedFile) {
        // 升级前已经挂到同一订单、但尚未建立关系记录的聊天文件在此补齐。
        // 若它本来就是需求/成果附件，唯一键会保留原有 purpose。
        await conn.execute(
          `INSERT IGNORE INTO order_attachments(orderId, fileId, uploaderId, purpose, createdAt)
           VALUES(?, ?, ?, 'CHAT', ?)`,
          [c.orderId, fileId, user.id, now]
        );
      }
      const [inserted] = await conn.execute(
        `INSERT INTO messages(convId, senderId, type, content, fileId, createdAt) VALUES(?,?,?,?,?,?)`,
        [c.id, user.id, type, content, fileId, now]
      );
      await conn.execute(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, [now, c.id]);
      return Number(inserted.insertId);
    });

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
