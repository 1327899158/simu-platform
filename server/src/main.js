'use strict';
/**
 * 主入口（云开发版）。
 * 变化：
 *   - 启动时运行 db.init() 建表
 *   - 移除 JWT/SQLite/文件相关中间件
 *   - 支付回调 /api/pay/notify 路径（不带 /api/payments/mock-notify）
 *   - CORS 仅允许开发调试，生产走云托管内部隧道不需要 CORS
 */
const http = require('node:http');
const { config } = require('./config');
const { createRouter, sendJson, ApiError } = require('./lib/http');
const { init: dbInit } = require('./db');
const { startSweeper } = require('./services/pay-svc');

const router = createRouter();
require('./routes/auth').register(router);
require('./routes/auth-multi').register(router);  // 新增：多种登录方式
require('./routes/dicts').register(router);
require('./routes/files').register(router);
require('./routes/identity').register(router);
require('./routes/orders').register(router);
require('./routes/market').register(router);
require('./routes/quotes').register(router);
require('./routes/reviews').register(router);
require('./routes/payments').register(router);
require('./routes/invoices').register(router);
require('./routes/disputes').register(router);
require('./routes/chat').register(router);
require('./routes/admin').register(router);

router.get('/api/health', async (_req, res) =>
  sendJson(res, 200, { code: 0, data: { ok: true, now: new Date().toISOString() } }));

const server = http.createServer(async (req, res) => {
  const start = Date.now();

  // CORS：仅开发环境允许跨域（云托管生产环境走内部隧道，无 CORS 需求）
  if (config.env !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-WX-OPENID, X-WX-APPID, X-WX-UNIONID, X-Dev-Openid, X-Session-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
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
      console.error('[500]', req.method, u.pathname, e.message, e.stack);
      sendJson(res, 500, { code: 50000, message: '服务器内部错误' });
    }
  } finally {
    console.log(JSON.stringify({
      t: new Date().toISOString(), m: req.method, p: u.pathname,
      s: res.statusCode, ms: Date.now() - start,
    }));
  }
});

async function bootstrap() {
  // 初始化数据库（建表）
  await dbInit();
  server.listen(config.port, '0.0.0.0', () => {
    console.log(JSON.stringify({
      t: new Date().toISOString(), evt: 'listening', port: config.port,
      env: config.env, cloudbaseEnv: config.cloudbaseEnv,
      engineerSelfVerify: config.allowEngineerSelfVerify,
      paymentMode: config.paymentMode,
      chatImageMode: 'direct-cloud-file-id',
      attachmentSchema: 'order-attachments-v1',
      maxUploadMb: config.uploadMaxMb,
      adminBootstrapConfigured: !!(
        config.adminBootstrapOpenids.length || config.adminBootstrapUserIds.length
      ),
    }));
    startSweeper(); // 支付超时清扫备用定时器（推荐用云函数触发器替代）

    // 云MySQL普通版防暂停心跳：每 15 分钟检测一次数据库连接
    if (config.env === 'production') {
      setInterval(async () => {
        try {
          const { query } = require('./db');
          await query('SELECT 1');
          console.log(JSON.stringify({
            t: new Date().toISOString(), evt: 'db-heartbeat', status: 'ok'
          }));
        } catch (e) {
          console.error(JSON.stringify({
            t: new Date().toISOString(), evt: 'db-heartbeat', error: e.message
          }));
        }
      }, 15 * 60 * 1000); // 15 分钟
    }
  });
}

bootstrap().catch((e) => { console.error('[bootstrap]', e); process.exit(1); });

module.exports = { server };
