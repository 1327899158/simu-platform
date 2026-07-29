'use strict';
/**
 * 会话服务（云开发版）。
 * 会话消息「一写两存」：
 *   1. MySQL（分页历史 / 权限校验基准）
 *   2. 云开发文档数据库 conv_messages 集合（供小程序 db.watch 实时推送）
 */
const { newId, nowIso } = require('../lib/util');
const { config } = require('../config');
const { err } = require('../lib/http');
const { query, queryOne } = require('../db');
const { getDB } = require('../tcb');

/**
 * 确保会话存在（支付成功后调用）。
 * conn：可选，传入时在事务连接内执行（避免嵌套事务）
 */
async function ensureConversation(orderId, conn) {
  const exec = conn
    ? (sql, p) => conn.execute(sql, p).then(([r]) => r)
    : (sql, p) => query(sql, p);
  const getOne = conn
    ? (sql, p) => conn.execute(sql, p).then(([rows]) => rows[0] || null)
    : (sql, p) => queryOne(sql, p);

  let conv = await getOne(`SELECT * FROM conversations WHERE orderId = ?`, [orderId]);
  if (conv) return conv;

  const order = await getOne(`SELECT * FROM orders WHERE id = ?`, [orderId]);
  const quote = await getOne(`SELECT * FROM quotes WHERE id = ?`, [order.selectedQuoteId]);
  const id = newId();
  const now = nowIso();
  await exec(
    `INSERT INTO conversations(id, orderId, customerId, engineerId, lastMsgAt, createdAt)
     VALUES(?,?,?,?,?,?)`,
    [id, orderId, order.customerId, quote.engineerId, now, now]
  );

  // 同步在云数据库建会话文档（供 db.watch 安全规则判断参与方）
  try {
    await getDB().collection('conversations').add({
      data: {
        _id: id,
        orderId,
        _openid_participants: [order.customerId_openid || '', quote.engineerId_openid || ''],
        createdAt: new Date(),
        lastMsgAt: new Date(),
      },
    });
  } catch (e) {
    // 写云数据库失败不影响主流程，仅记录日志
    console.error('[chat-svc] cloud db write conv failed', e.message);
  }

  return getOne(`SELECT * FROM conversations WHERE id = ?`, [id]);
}

/**
 * 写系统消息（MySQL + 云数据库）。
 */
async function systemMessage(convId, content, conn) {
  const exec = conn
    ? (sql, p) => conn.execute(sql, p)
    : (sql, p) => query(sql, p);
  const now = nowIso();
  const [r] = await exec(
    `INSERT INTO messages(convId, senderId, type, content, createdAt) VALUES(?,?,?,?,?)`,
    [convId, 'SYSTEM', 'SYSTEM', content, now]
  );
  const msgId = r.insertId;
  await exec(`UPDATE conversations SET lastMsgAt = ? WHERE id = ?`, [now, convId]);

  // 同步写云数据库供 db.watch
  try {
    await getDB().collection('conv_messages').add({
      data: {
        convId,
        senderId: 'SYSTEM',
        type: 'SYSTEM',
        content,
        sqlMsgId: String(msgId),
        createdAt: new Date(),
      },
    });
  } catch (e) {
    console.error('[chat-svc] cloud db write msg failed', e.message);
  }
}

async function systemMessageForOrder(orderId, content) {
  const conv = await queryOne(`SELECT id FROM conversations WHERE orderId = ?`, [orderId]);
  if (conv) await systemMessage(conv.id, content);
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
  // const http = require('node:http');
  // await new Promise((resolve, reject) => {
  //   const body = JSON.stringify({ content: text, openid, scene: 2, version: 2 });
  //   const req = http.request({
  //     hostname: 'api.weixin.qq.com',
  //     path: '/_/wxa/msg_sec_check',
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  //   }, (res) => {
  //     let d = ''; res.on('data', c => d += c);
  //     res.on('end', () => {
  //       const r = JSON.parse(d);
  //       if (r.errcode !== 0) reject(new Error('内容违规'));
  //       else resolve();
  //     });
  //   });
  //   req.on('error', reject);
  //   req.write(body); req.end();
  // });
}

module.exports = { ensureConversation, systemMessage, systemMessageForOrder, contentCheck };
