'use strict';
/** 会话与消息（轮询方案 A）。会话在支付成功时自动创建，双方为订单客户与被选中工程师。 */
const { readJson, ok, err } = require('../lib/http');
const { nowIso, v } = require('../lib/util');
const { q } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { contentCheck } = require('../services/chat-svc');

function myConversation(user, convId) {
  const c = q.one(`SELECT * FROM conversations WHERE id = ?`, convId);
  if (!c) throw err.notFound('会话不存在');
  if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
  return c;
}

const msgView = (m) => ({
  id: m.id,
  senderId: m.senderId,
  type: m.type,
  content: m.content,
  fileId: m.fileId,
  createdAt: m.createdAt,
});

function register(router) {
  // GET /api/conversations —— 我的会话列表（含未读数与最后一条消息）
  router.get('/api/conversations', async (req, res) => {
    const user = requireUser(req);
    const rows = q.all(
      `SELECT * FROM conversations WHERE customerId = ? OR engineerId = ?
       ORDER BY lastMsgAt DESC LIMIT 50`, user.id, user.id);
    ok(res, rows.map((c) => {
      const o = q.one(`SELECT projectName, orderNo, status FROM orders WHERE id = ?`, c.orderId);
      const peerId = c.customerId === user.id ? c.engineerId : c.customerId;
      const peer = q.one(`SELECT nickname, avatarUrl FROM users WHERE id = ?`, peerId);
      const last = q.one(
        `SELECT type, content, createdAt FROM messages WHERE convId = ? ORDER BY id DESC LIMIT 1`, c.id);
      const unread = q.one(
        `SELECT COUNT(*) AS c FROM messages
         WHERE convId = ? AND senderId != ? AND senderId != 'SYSTEM' AND readAt IS NULL`,
        c.id, user.id).c;
      return {
        id: c.id,
        orderId: c.orderId,
        order: o,
        peer,
        lastMessage: last || null,
        unread,
        lastMsgAt: c.lastMsgAt,
      };
    }));
  });

  // GET /api/conversations/by-order/:orderId —— 由订单跳转会话
  router.get('/api/conversations/by-order/:orderId', async (req, res, params) => {
    const user = requireUser(req);
    const c = q.one(`SELECT * FROM conversations WHERE orderId = ?`, params.orderId);
    if (!c) throw err.notFound('会话尚未创建（支付成功后自动创建）');
    if (c.customerId !== user.id && c.engineerId !== user.id) throw err.forbidden();
    ok(res, { id: c.id });
  });

  // GET /api/conversations/:id/messages?after=0&limit=50 —— 轮询增量拉取，自动置已读
  router.get('/api/conversations/:id/messages', async (req, res, params, query) => {
    const user = requireUser(req);
    const c = myConversation(user, params.id);
    const after = parseInt(query.get('after') || '0', 10) || 0;
    const limit = Math.min(parseInt(query.get('limit') || '50', 10) || 50, 100);
    const rows = q.all(
      `SELECT * FROM messages WHERE convId = ? AND id > ? ORDER BY id LIMIT ?`,
      c.id, after, limit);
    q.run(
      `UPDATE messages SET readAt = ? WHERE convId = ? AND senderId != ? AND readAt IS NULL`,
      nowIso(), c.id, user.id);
    ok(res, { items: rows.map(msgView), lastId: rows.length ? rows[rows.length - 1].id : after });
  });

  // POST /api/conversations/:id/messages { type: TEXT|IMAGE|FILE, content?, fileId? }
  router.post('/api/conversations/:id/messages', async (req, res, params) => {
    const user = requireUser(req);
    const c = myConversation(user, params.id);
    const b = await readJson(req);
    const type = v.oneOf(b.type || 'TEXT', '消息类型', ['TEXT', 'IMAGE', 'FILE']);
    let content = null;
    let fileId = null;
    if (type === 'TEXT') {
      content = v.str(b.content, '消息内容', { min: 1, max: 2000 });
      contentCheck(content); // 内容安全：上线前替换为微信 msgSecCheck
    } else {
      fileId = v.str(b.fileId, 'fileId', { min: 1 });
      const f = q.one(`SELECT * FROM files WHERE id = ? AND uploaderId = ?`, fileId, user.id);
      if (!f) throw err.bad('文件不存在或不属于你');
      if (!f.orderId) q.run(`UPDATE files SET orderId = ? WHERE id = ?`, c.orderId, fileId);
      content = f.name;
    }
    const r = q.run(
      `INSERT INTO messages(convId, senderId, type, content, fileId, createdAt) VALUES(?,?,?,?,?,?)`,
      c.id, user.id, type, content, fileId, nowIso());
    q.run(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, nowIso(), c.id);
    const m = q.one(`SELECT * FROM messages WHERE id = ?`, r.lastInsertRowid);
    ok(res, msgView(m));
  });
}

module.exports = { register };
