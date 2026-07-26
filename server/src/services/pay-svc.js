'use strict';
/**
 * 支付服务。
 * - createPayment：为待支付订单创建/复用支付单
 * - applyPaymentSuccess：支付成功落账（幂等）——回调、查单兜底、Mock 确认共用这一份逻辑
 * - sweepExpiredAwaitingPayment：超时未支付回退 QUOTING（定时清扫）
 * PAY_PROVIDER=wechat 时，下单/回调的对接点见 docs/upgrade.md（v3 JSAPI：
 * 下单→prepay_id→商户私钥RSA签调起参数；回调→平台证书验签→APIv3密钥AES-GCM解密→本函数落账）。
 */
const crypto = require('node:crypto');
const { err } = require('../lib/http');
const { newId, nowIso } = require('../lib/util');
const { config } = require('../config');
const { q, tx } = require('../db');
const { ensureConversation, systemMessage } = require('./chat-svc');

function createPayment(order) {
  const amountFen = config.payAmountOverrideFen || order.finalAmountFen;
  if (!amountFen || amountFen <= 0) throw err.conflict('订单金额异常');
  // 复用未过期的 PENDING 支付单（同金额），避免重复下单
  const existing = q.one(
    `SELECT * FROM payments WHERE orderId = ? AND status = 'PENDING' AND amountFen = ?
     ORDER BY createdAt DESC LIMIT 1`,
    order.id, amountFen
  );
  if (existing) return existing;
  const id = newId();
  const outTradeNo = `${order.orderNo}T${Date.now().toString(36).toUpperCase()}`;
  q.run(
    `INSERT INTO payments(id, orderId, outTradeNo, amountFen, createdAt) VALUES(?,?,?,?,?)`,
    id, order.id, outTradeNo, amountFen, nowIso()
  );
  return q.one(`SELECT * FROM payments WHERE id = ?`, id);
}

/**
 * 幂等落账。重复通知/查单重放安全：
 *  - 支付单已 SUCCESS → 直接返回 already
 *  - 订单不在 AWAITING_PAYMENT（如已超时回退）→ 记账但不推进订单，标记异常待人工/退款
 */
function applyPaymentSuccess(outTradeNo, transactionId, rawEvent = null) {
  return tx(() => {
    const p = q.one(`SELECT * FROM payments WHERE outTradeNo = ?`, outTradeNo);
    if (!p) throw err.notFound('支付单不存在');
    if (p.status === 'SUCCESS') return { applied: false, reason: 'already-success' };
    q.run(
      `UPDATE payments SET status = 'SUCCESS', transactionId = ?, paidAt = ?, raw = ? WHERE id = ?`,
      transactionId, nowIso(), rawEvent ? JSON.stringify(rawEvent) : null, p.id
    );
    const r = q.run(
      `UPDATE orders SET status = 'IN_PROGRESS', paidAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'AWAITING_PAYMENT'`,
      nowIso(), nowIso(), p.orderId
    );
    if (r.changes === 0) {
      // 钱到了但订单已不在待支付态（超时回退等）：真实系统走退款流程
      q.run(`UPDATE payments SET raw = ? WHERE id = ?`,
        JSON.stringify({ warn: 'ORDER_NOT_AWAITING_PAYMENT', event: rawEvent }), p.id);
      return { applied: false, reason: 'order-not-awaiting' };
    }
    const conv = ensureConversation(p.orderId);
    systemMessage(conv.id, '订单已支付，工程师可以开始工作了。请双方在此沟通项目细节。');
    return { applied: true };
  });
}

/** Mock 通道「支付成功」入口（仅 PAY_PROVIDER=mock 开放） */
function mockConfirm(outTradeNo) {
  if (config.payProvider !== 'mock') throw err.forbidden('当前支付通道不支持模拟确认');
  return applyPaymentSuccess(outTradeNo, 'MOCKTX' + crypto.randomBytes(6).toString('hex'));
}

/** 超时未支付：回退 QUOTING，释放选标，报价恢复待确认 */
function sweepExpiredAwaitingPayment() {
  const deadline = new Date(Date.now() - config.payTimeoutSec * 1000).toISOString();
  const rows = q.all(
    `SELECT id, selectedQuoteId FROM orders
     WHERE status = 'AWAITING_PAYMENT' AND selectedAt < ?`, deadline
  );
  for (const o of rows) {
    tx(() => {
      const r = q.run(
        `UPDATE orders SET status = 'QUOTING', selectedQuoteId = NULL,
           finalAmountFen = NULL, selectedAt = NULL, updatedAt = ?
         WHERE id = ? AND status = 'AWAITING_PAYMENT'`,
        nowIso(), o.id
      );
      if (r.changes === 0) return; // 并发下已被支付推进，跳过
      q.run(
        `UPDATE quotes SET status = 'PENDING', updatedAt = ?
         WHERE orderId = ? AND status IN ('SELECTED','REJECTED')`,
        nowIso(), o.id
      );
      q.run(
        `UPDATE payments SET status = 'FAILED' WHERE orderId = ? AND status = 'PENDING'`,
        o.id
      );
    });
    console.log(JSON.stringify({ t: nowIso(), evt: 'pay-timeout-revert', orderId: o.id }));
  }
  return rows.length;
}

function startSweeper() {
  const timer = setInterval(() => {
    try { sweepExpiredAwaitingPayment(); } catch (e) { console.error('sweep error', e); }
  }, 10 * 1000);
  timer.unref();
}

module.exports = { createPayment, applyPaymentSuccess, mockConfirm, sweepExpiredAwaitingPayment, startSweeper };
