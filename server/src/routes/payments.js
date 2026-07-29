'use strict';
/**
 * 支付路由（云开发版）。
 *
 * POST /api/orders/:id/pay
 *   → 调用云托管代签名接口下 JSAPI 单，返回调起参数
 *
 * POST /api/pay/notify
 *   → 微信支付回调（内部投递，已由云托管 sidecar 解密）
 *   → 注意：云托管版返回格式 { errcode: 0, errmsg: 'OK' }
 *
 * GET /api/orders/:id/payment
 *   → 前端轮询确认支付状态
 */
const { readJson, ok, sendJson, err } = require('../lib/http');
const { query, queryOne } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { createJsapiOrder, applyPaymentSuccess } = require('../services/pay-svc');
const { getOpenid } = require('../lib/auth-mw');

function register(router) {
  // POST /api/pay/notify —— 微信支付回调（@Public，内部投递不带 X-WX-OPENID）
  router.post('/api/pay/notify', async (req, res) => {
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { errcode: -1, errmsg: 'body parse error' });
      return;
    }
    // 云托管代解密：body 即 trade_state/out_trade_no/transaction_id 等字段
    if (body.trade_state !== 'SUCCESS') {
      sendJson(res, 200, { errcode: 0, errmsg: 'OK' });
      return;
    }
    try {
      await applyPaymentSuccess(body.out_trade_no, body.transaction_id, body);
    } catch (e) {
      // 幂等失败或业务异常：log 但仍返回成功避免微信重试
      console.error('[pay/notify]', e.message);
    }
    // 云托管版回调返回格式（注意：不是 v3 标准的 {code:"SUCCESS"} 格式）
    sendJson(res, 200, { errcode: 0, errmsg: 'OK' });
  });

  // GET /api/orders/:id/payment
  router.get('/api/orders/:id/payment', async (req, res, params) => {
    const user = await requireUser(req);
    const o = await queryOne(`SELECT * FROM orders WHERE id = ?`, [params.id]);
    if (!o || o.customerId !== user.id) throw err.notFound('订单不存在');
    const p = await queryOne(
      `SELECT outTradeNo, amountFen, status, paidAt FROM payments
       WHERE orderId = ? ORDER BY createdAt DESC LIMIT 1`, [params.id]);
    ok(res, { orderStatus: o.status, payment: p || null });
  });
}

module.exports = { register };
