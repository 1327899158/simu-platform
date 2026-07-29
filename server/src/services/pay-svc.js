'use strict';
/**
 * 支付服务（云开发版）。
 * 下单：调用云托管「开放接口服务」代签名的内部地址 http://api.weixin.qq.com/_/pay/...
 * 回调：微信 → 云托管内部投递，回调请求已由 sidecar 解密，body 即事件明文。
 * 幂等：outTradeNo 唯一 + 事务内状态判断。
 */
const http = require('node:http');
const { err } = require('../lib/http');
const { newId, nowIso } = require('../lib/util');
const { config } = require('../config');
const { query, queryOne, tx } = require('../db');
const { ensureConversation, systemMessage } = require('./chat-svc');

/**
 * 向微信云托管代签名网关发 HTTP 请求（内部地址，无需签名）。
 * url: /v3/pay/transactions/jsapi 等（路径部分，不含 host）
 * 云托管内部自动处理：
 *   - 补全 appid / mchid
 *   - 添加 Authorization 签名头
 *   - 通知回调的证书验签与解密
 */
function wxpayRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname: 'api.weixin.qq.com',
      path: '/_/pay' + path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** 创建/复用支付单 */
async function createPayment(order) {
  const amountFen = config.payAmountOverrideFen || order.finalAmountFen;
  if (!amountFen || amountFen <= 0) throw err.conflict('订单金额异常');
  // 复用未过期的 PENDING 支付单
  const existing = await queryOne(
    `SELECT * FROM payments WHERE orderId = ? AND status = 'PENDING' AND amountFen = ?
     ORDER BY createdAt DESC LIMIT 1`,
    [order.id, amountFen]
  );
  if (existing) return existing;
  const id = newId();
  const outTradeNo = `${order.orderNo}T${Date.now().toString(36).toUpperCase()}`;
  await query(
    `INSERT INTO payments(id, orderId, outTradeNo, amountFen, createdAt) VALUES(?,?,?,?,?)`,
    [id, order.id, outTradeNo, amountFen, nowIso()]
  );
  return queryOne(`SELECT * FROM payments WHERE id = ?`, [id]);
}

/**
 * 调用云托管开放接口发起 JSAPI 下单。
 * 返回前端调起 wx.requestPayment 所需的五参数（由 sidecar 代签）。
 */
async function createJsapiOrder(order, openid) {
  const payment = await createPayment(order);
  const amountFen = payment.amountFen;

  const resp = await wxpayRequest('POST', '/transactions/jsapi', {
    description: `仿真服务·${order.projectName.slice(0, 30)}`,
    out_trade_no: payment.outTradeNo,
    notify_url: config.wxpayNotifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
    payer: { openid },
  });

  if (resp.status !== 200 || !resp.body) {
    throw err.bad(`微信支付下单失败(${resp.status}): ${JSON.stringify(resp.body)}`);
  }
  // resp.body 包含 prepay_id 及签名后的调起参数
  return { outTradeNo: payment.outTradeNo, amountFen, ...resp.body };
}

/**
 * 幂等落账（回调、查单兜底共用）。
 */
async function applyPaymentSuccess(outTradeNo, transactionId, rawEvent = null) {
  return tx(async (conn) => {
    const [rows] = await conn.execute(`SELECT * FROM payments WHERE outTradeNo = ?`, [outTradeNo]);
    const p = rows[0];
    if (!p) throw err.notFound('支付单不存在');
    if (p.status === 'SUCCESS') return { applied: false, reason: 'already-success' };

    await conn.execute(
      `UPDATE payments SET status='SUCCESS', transactionId=?, paidAt=?, raw=? WHERE id=?`,
      [transactionId, nowIso(), rawEvent ? JSON.stringify(rawEvent) : null, p.id]
    );
    const [r] = await conn.execute(
      `UPDATE orders SET status='IN_PROGRESS', paidAt=?, updatedAt=?
       WHERE id=? AND status='AWAITING_PAYMENT'`,
      [nowIso(), nowIso(), p.orderId]
    );
    if (r.affectedRows === 0) {
      await conn.execute(`UPDATE payments SET raw=? WHERE id=?`,
        [JSON.stringify({ warn: 'ORDER_NOT_AWAITING_PAYMENT', event: rawEvent }), p.id]);
      return { applied: false, reason: 'order-not-awaiting' };
    }
    // 建会话（conn 传入避免嵌套事务）
    const conv = await ensureConversation(p.orderId, conn);
    await systemMessage(conv.id, '订单已支付，工程师可以开始工作了。请双方在此沟通项目细节。', conn);
    return { applied: true };
  });
}

/**
 * 超时未支付回退（供云函数定时触发器调用）。
 */
async function sweepExpiredAwaitingPayment() {
  const deadline = new Date(Date.now() - config.payTimeoutSec * 1000).toISOString();
  const rows = await query(
    `SELECT id, selectedQuoteId FROM orders
     WHERE status = 'AWAITING_PAYMENT' AND selectedAt < ?`, [deadline]
  );
  for (const o of rows) {
    await tx(async (conn) => {
      const [r] = await conn.execute(
        `UPDATE orders SET status='QUOTING', selectedQuoteId=NULL,
           finalAmountFen=NULL, selectedAt=NULL, updatedAt=?
         WHERE id=? AND status='AWAITING_PAYMENT'`,
        [nowIso(), o.id]
      );
      if (!r.affectedRows) return;
      await conn.execute(
        `UPDATE quotes SET status='PENDING', updatedAt=?
         WHERE orderId=? AND status IN ('SELECTED','REJECTED')`,
        [nowIso(), o.id]
      );
      await conn.execute(
        `UPDATE payments SET status='FAILED' WHERE orderId=? AND status='PENDING'`,
        [o.id]
      );
    });
    console.log(JSON.stringify({ t: nowIso(), evt: 'pay-timeout-revert', orderId: o.id }));
  }
  return rows.length;
}

/** 启动内嵌定时清扫（云托管环境下备用，推荐用云函数定时触发）*/
function startSweeper() {
  const timer = setInterval(async () => {
    try { await sweepExpiredAwaitingPayment(); } catch (e) { console.error('sweep error', e); }
  }, 30 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { createPayment, createJsapiOrder, applyPaymentSuccess, sweepExpiredAwaitingPayment, startSweeper };
