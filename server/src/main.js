'use strict';
/**
 * 仿真服务平台 · 最小闭环 Demo 后端
 * 零第三方依赖：node:http + node:sqlite + node:crypto（Node ≥ 22，需 --experimental-sqlite）
 * 启动：node --experimental-sqlite src/main.js
 */
const http = require('node:http');
const { config } = require('./config');
const { createRouter, sendJson, ApiError } = require('./lib/http');
const { startSweeper } = require('./services/pay-svc');

const router = createRouter();
require('./routes/auth').register(router);
require('./routes/dicts').register(router);
require('./routes/files').register(router);
require('./routes/orders').register(router);
require('./routes/market').register(router);
require('./routes/quotes').register(router);
require('./routes/payments').register(router);
require('./routes/chat').register(router);
router.get('/api/health', async (_req, res) =>
  sendJson(res, 200, { code: 0, data: { ok: true, now: new Date().toISOString() } }));

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  // CORS（开发者工具与本地联调友好；小程序真机不校验 CORS）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://local');
  const matched = router.match(req.method, u.pathname);
  try {
    if (!matched) throw new ApiError(404, 40400, '接口不存在');
    await matched.handler(req, res, matched.params, u.searchParams);
  } catch (e) {
    if (e instanceof ApiError) {
      sendJson(res, e.status, { code: e.code, message: e.message });
    } else {
      console.error('[500]', req.method, u.pathname, e);
      sendJson(res, 500, { code: 50000, message: '服务器内部错误' });
    }
  } finally {
    console.log(JSON.stringify({
      t: new Date().toISOString(), m: req.method, p: u.pathname,
      s: res.statusCode, ms: Date.now() - start,
    }));
  }
});

server.listen(config.port, () => {
  console.log(JSON.stringify({
    t: new Date().toISOString(), evt: 'listening', port: config.port,
    wxMock: config.wxMock, payProvider: config.payProvider, db: config.dbFile,
  }));
  startSweeper(); // 支付超时清扫（10s 一轮）
});

module.exports = { server };
