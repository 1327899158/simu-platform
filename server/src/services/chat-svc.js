'use strict';
/** 会话服务：确保会话存在、写系统消息、内容安全检查（Mock 词表，可替换为微信 msgSecCheck）。 */
const { newId, nowIso } = require('../lib/util');
const { err } = require('../lib/http');
const { config } = require('../config');
const { q } = require('../db');

/** 在事务内调用：支付成功后为订单建会话 */
function ensureConversation(orderId) {
  let conv = q.one(`SELECT * FROM conversations WHERE orderId = ?`, orderId);
  if (conv) return conv;
  const order = q.one(`SELECT * FROM orders WHERE id = ?`, orderId);
  const quote = q.one(`SELECT * FROM quotes WHERE id = ?`, order.selectedQuoteId);
  const id = newId();
  q.run(
    `INSERT INTO conversations(id, orderId, customerId, engineerId, lastMsgAt, createdAt)
     VALUES(?,?,?,?,?,?)`,
    id, orderId, order.customerId, quote.engineerId, nowIso(), nowIso()
  );
  return q.one(`SELECT * FROM conversations WHERE id = ?`, id);
}

function systemMessage(convId, content) {
  q.run(
    `INSERT INTO messages(convId, senderId, type, content, createdAt) VALUES(?,?,?,?,?)`,
    convId, 'SYSTEM', 'SYSTEM', content, nowIso()
  );
  q.run(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, nowIso(), convId);
}

function systemMessageForOrder(orderId, content) {
  const conv = q.one(`SELECT id FROM conversations WHERE orderId = ?`, orderId);
  if (conv) systemMessage(conv.id, content);
}

/**
 * 内容安全检查。Mock 实现：命中词表即拦截。
 * 上线前替换为微信 msgSecCheck（文本）/ mediaCheck（图片）真实调用——提审硬要求。
 */
function contentCheck(text) {
  if (!text) return;
  for (const w of config.bannedWords) {
    if (w && text.includes(w)) throw err.bad('内容包含违规词，已被拦截');
  }
}

module.exports = { ensureConversation, systemMessage, systemMessageForOrder, contentCheck };
