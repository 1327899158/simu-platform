'use strict';
/**
 * 支付回调入口。
 * - Mock 通道：/api/payments/mock-notify 模拟微信服务器的成功通知（与真实回调走同一份幂等落账逻辑）
 * - 微信通道：/api/payments/notify 为 v3 回调占位——接入时在此完成
 *   平台证书验签 → APIv3 密钥 AES-256-GCM 解密 → applyPaymentSuccess(out_trade_no, transaction_id, evt)
 */
const { readJson, ok, sendJson, err } = require('../lib/http');
const { v } = require('../lib/util');
const { config } = require('../config');
const { mockConfirm } = require('../services/pay-svc');

function register(router) {
  // POST /api/payments/mock-notify { outTradeNo } —— 仅 mock 通道开放（模拟微信异步通知，无登录态）
  router.post('/api/payments/mock-notify', async (req, res) => {
    if (config.payProvider !== 'mock') throw err.forbidden('当前支付通道不支持模拟通知');
    const b = await readJson(req);
    const outTradeNo = v.str(b.outTradeNo, 'outTradeNo', { min: 5 });
    const r = mockConfirm(outTradeNo);
    ok(res, r);
  });

  // POST /api/payments/notify —— 微信支付 v3 真实回调占位
  router.post('/api/payments/notify', async (_req, res) => {
    if (config.payProvider !== 'wechat') {
      sendJson(res, 501, { code: 'FAIL', message: '微信支付通道未启用' });
      return;
    }
    // TODO(接入微信支付时实现)：
    // 1) 取 Wechatpay-Serial/Timestamp/Nonce/Signature 头，用微信平台证书验签，失败返回 401
    // 2) body.resource 用 APIv3 密钥 AES-256-GCM 解密得到事件 evt
    // 3) evt.trade_state === 'SUCCESS' 时调用 applyPaymentSuccess(evt.out_trade_no, evt.transaction_id, evt)
    // 4) 应答 { code: 'SUCCESS' }；处理失败返回 5xx 让微信重试
    sendJson(res, 501, { code: 'FAIL', message: '待接入商户凭据，见 docs/upgrade.md' });
  });
}

module.exports = { register };
