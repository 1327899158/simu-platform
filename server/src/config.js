'use strict';
/**
 * 配置加载：读取 server/.env（如存在）与进程环境变量。
 * 所有开关式配置集中在此，Mock → 真实微信只改这里对应的环境变量。
 */
const path = require('node:path');
const fs = require('node:fs');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'simu.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'),

  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-prod',
  accessTtlSec: int(process.env.ACCESS_TTL_SEC, 2 * 3600),
  refreshTtlSec: int(process.env.REFRESH_TTL_SEC, 30 * 24 * 3600),

  // 微信登录：WX_MOCK=1 时不请求微信服务器，openid = 'mock_' + code
  wxMock: (process.env.WX_MOCK || '1') === '1',
  wxAppid: process.env.WX_APPID || '',
  wxSecret: process.env.WX_SECRET || '',

  // 支付：mock（演示）| wechat（微信支付v3，需商户凭据，见 docs/upgrade.md）
  payProvider: process.env.PAY_PROVIDER || 'mock',
  payTimeoutSec: int(process.env.PAY_TIMEOUT_SEC, 30 * 60), // 未支付自动回退
  payAmountOverrideFen: int(process.env.PAY_AMOUNT_OVERRIDE_FEN, 0) || null, // 演示价开关

  maxUploadBytes: int(process.env.MAX_UPLOAD_MB, 25) * 1024 * 1024,
  // 内容安全：Mock 词表拦截；接入微信 msgSecCheck 后替换 services/content-check.js
  bannedWords: (process.env.BANNED_WORDS || '违禁词,代刷,加微信私聊')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

if (config.env === 'production' && config.jwtSecret.includes('dev-secret')) {
  console.error('[config] 生产环境必须设置 JWT_SECRET'); process.exit(1);
}
if (config.env === 'production' && config.payProvider === 'mock') {
  console.error('[config] 生产环境禁止使用 mock 支付通道'); process.exit(1);
}

module.exports = { config };
