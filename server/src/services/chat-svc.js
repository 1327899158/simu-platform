'use strict';
/**
 * 会话服务（云开发版）。
 *
 * 会话消息「一写两存」：
 *   1. MySQL —— 主链路：分页历史、权限校验基准、送达状态。
 *   2. 云数据库 conv_messages —— 只作为 db.watch 触发信号，客户端拿到 change 后
 *      再走 REST 增量拉取。所以 **云 DB 写入必须是 fire-and-forget，且不能阻塞
 *      MySQL 事务**——否则一旦云托管内网通向 CloudBase 的 sidecar 抖动
 *      （169.254.0.23 ETIMEDOUT 90+s），整个业务链路会跟着挂掉。
 *
 * 变更（2026-07-31）：
 *   - `ensureConversation` / `systemMessage` 不再在事务连接内同步写云 DB；
 *     云 DB 写入抽成 `publish*` 系列函数，超时 3s，失败仅日志。
 *   - 调用方（pay-svc.applyPaymentSuccess）先提交 MySQL 事务，再触发云 DB 推送。
 */
const { newId, nowIso } = require('../lib/util');
const { config } = require('../config');
const { err } = require('../lib/http');
const { query, queryOne } = require('../db');
const { getDB } = require('../tcb');

/** 云 DB 写入统一超时（毫秒）。云托管到 CloudBase 的内网 sidecar 卡住时，
 *  超时能保证业务链路不被拖死。 */
const CLOUD_DB_TIMEOUT_MS = 3000;

/** 包裹一次 promise，超时抛错。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function fetchParticipantOpenids(customerId, engineerId) {
  const [c, e] = await Promise.all([
    queryOne(`SELECT openid FROM users WHERE id = ?`, [customerId]),
    queryOne(`SELECT openid FROM users WHERE id = ?`, [engineerId]),
  ]);
  return [c, e].map((r) => r && r.openid).filter(Boolean);
}

/** fire-and-forget：把 conversations 文档同步到云 DB（供 db.watch 参与方判断）。 */
function publishConversationDoc({ id, orderId, customerId, engineerId }) {
  setImmediate(async () => {
    try {
      const openids = await fetchParticipantOpenids(customerId, engineerId);
      await withTimeout(
        getDB().collection('conversations').add({
          data: {
            _id: id,
            orderId,
            _openid_participants: openids,
            participantUserIds: [customerId, engineerId],
            createdAt: new Date(),
            lastMsgAt: new Date(),
          },
        }),
        CLOUD_DB_TIMEOUT_MS,
        'cloud conversations.add',
      );
    } catch (e) {
      console.error('[chat-svc] publish conv failed', e.message);
    }
  });
}

/** fire-and-forget：把消息同步到云 DB（供 db.watch 推送）。 */
function publishMessageDoc({ convId, senderOpenid, senderUserId, type, content, fileId, sqlMsgId, participantsOpenids }) {
  setImmediate(async () => {
    try {
      const openids = participantsOpenids && participantsOpenids.length
        ? participantsOpenids
        : await (async () => {
            const conv = await queryOne(
              `SELECT customerId, engineerId FROM conversations WHERE id = ?`,
              [convId]
            );
            return conv ? await fetchParticipantOpenids(conv.customerId, conv.engineerId) : [];
          })();
      await withTimeout(
        getDB().collection('conv_messages').add({
          data: {
            convId,
            senderId: senderOpenid || senderUserId || 'SYSTEM',
            senderUserId: senderUserId || null,
            type,
            content,
            fileId: fileId || null,
            sqlMsgId: String(sqlMsgId),
            _openid_participants: openids,
            createdAt: new Date(),
          },
        }),
        CLOUD_DB_TIMEOUT_MS,
        'cloud conv_messages.add',
      );
    } catch (e) {
      console.error('[chat-svc] publish msg failed', e.message);
    }
  });
}

/**
 * 确保会话存在（支付成功后调用）。
 *
 * 云 DB 写入 **不再在事务里同步等待**；调用方拿到 conv 后如需推送，
 * 使用返回的 `_needsCloudPublish` 元信息在事务提交后触发 `publishConversationDoc`。
 *
 * @param {string} orderId
 * @param {import('mysql2').PoolConnection} [conn] 可选事务连接
 * @returns {Promise<Row & { _isNew: boolean }>}
 */
async function ensureConversation(orderId, conn) {
  const exec = conn
    ? (sql, p) => conn.execute(sql, p).then(([r]) => r)
    : (sql, p) => query(sql, p);
  const getOne = conn
    ? (sql, p) => conn.execute(sql, p).then(([rows]) => rows[0] || null)
    : (sql, p) => queryOne(sql, p);

  const order = await getOne(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  if (!order || !order.selectedQuoteId) throw err.conflict('订单尚未选定工程师，无法创建会话');
  const quote = await getOne(`SELECT * FROM quotes WHERE id = ?`, [order.selectedQuoteId]);
  if (!quote) throw err.conflict('订单报价不存在，无法创建会话');

  const existing = await getOne(
    `SELECT * FROM conversations WHERE orderId = ? AND engineerId = ?`,
    [orderId, quote.engineerId]
  );
  if (existing) return Object.assign(existing, { _isNew: false });

  const id = newId();
  const now = nowIso();
  await exec(
    `INSERT INTO conversations(id, orderId, customerId, engineerId, lastMsgAt, createdAt)
     VALUES(?,?,?,?,?,?)`,
    [id, orderId, order.customerId, quote.engineerId, now, now]
  );

  const conv = await getOne(`SELECT * FROM conversations WHERE id = ?`, [id]);
  return Object.assign(conv, { _isNew: true });
}

/**
 * 写系统消息 —— MySQL 主写，云 DB 推送放到事务外。
 *
 * @returns {Promise<{ msgId: number, convId: string }>}
 */
async function systemMessage(convId, content, conn, meta = {}) {
  const exec = conn
    ? (sql, p) => conn.execute(sql, p)
    : async (sql, p) => {
        const rows = await query(sql, p);
        return [rows];
      };
  const now = nowIso();
  const senderId = meta.senderId || 'SYSTEM';
  const actionOrderId = meta.actionOrderId || null;
  const [r] = await exec(
    `INSERT INTO messages(convId, senderId, type, content, fileId, createdAt) VALUES(?,?,?,?,?,?)`,
    [convId, senderId, 'SYSTEM', content, actionOrderId, now]
  );
  const msgId = r.insertId;
  await exec(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, [now, convId]);
  return { msgId, convId };
}

/**
 * 供事务外调用：把系统消息推送到云 DB。
 */
function publishSystemMessage(convId, content, sqlMsgId, meta = {}) {
  publishMessageDoc({
    convId,
    senderOpenid: 'SYSTEM',
    senderUserId: meta.senderId || null,
    type: 'SYSTEM',
    content,
    fileId: meta.actionOrderId || null,
    sqlMsgId,
  });
}

async function systemMessageForOrder(orderId, content, meta = {}) {
  const conv = await queryOne(
    `SELECT c.id
       FROM orders o
       JOIN quotes q ON q.id = o.selectedQuoteId
       JOIN conversations c ON c.orderId = o.id AND c.engineerId = q.engineerId
      WHERE o.id = ?`,
    [orderId]
  );
  if (!conv) return;
  const { msgId } = await systemMessage(conv.id, content, null, meta);
  publishSystemMessage(conv.id, content, msgId, meta);
}

/**
 * 内容安全检查（Mock 词表；上线前替换为 msgSecCheck）。
 * 云开发版：调用 http://api.weixin.qq.com/_/wxa/msg_sec_check
 * 当前保留 Mock 实现，方便开发调试；上线前解注释真实检查。
 */
async function contentCheck(text, openid) {
  if (!text) return;
  // Mock 词表
  for (const w of config.bannedWords) {
    if (w && text.includes(w)) throw err.bad('内容包含违规词，已被拦截');
  }
  // TODO(上线前启用): 真实 msgSecCheck
}

module.exports = {
  ensureConversation,
  systemMessage,
  systemMessageForOrder,
  publishConversationDoc,
  publishMessageDoc,
  publishSystemMessage,
  contentCheck,
};
