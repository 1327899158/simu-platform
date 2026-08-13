'use strict';
/**
 * 配置加载：读取环境变量（云托管自动注入 MYSQL_ADDRESS 等）。
 * 云开发版变化：
 *   - 移除 JWT / SQLite / 本地文件 / 短信相关配置
 *   - 新增 CLOUDBASE_ENV_ID / MYSQL_* 系列（云托管自动注入）
 *   - 微信支付通过云托管「开放接口服务」代签名，不再存储密钥
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

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const csv = (v) => String(v || '')
  .split(',').map((item) => item.trim()).filter(Boolean);

// 云托管 MySQL 注入的环境变量名（在容器内自动可用）
// 本地开发时在 .env 里手动填
const mysqlAddr = process.env.MYSQL_ADDRESS || '127.0.0.1:3306';
const [mysqlHost, mysqlPortStr] = mysqlAddr.split(':');
const uploadMaxMb = Math.max(1, Math.min(100, int(process.env.MAX_UPLOAD_MB, 30)));

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 80),

  // 云开发环境 ID（用于服务端调用云存储/云数据库）
  cloudbaseEnv: process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV_ID || '',

  // 微信小程序 AppID（用于校验 X-WX-APPID 头）
  wxAppid: process.env.WX_APPID || '',

  // 首位管理员引导白名单。仅服务端环境变量可配置，前端 scene 参数不能授予权限。
  // 推荐优先使用 OpenID；用户需至少登录过一次普通小程序以建立 users 记录。
  adminBootstrapOpenids: csv(process.env.ADMIN_BOOTSTRAP_OPENIDS),
  adminBootstrapUserIds: csv(process.env.ADMIN_BOOTSTRAP_USER_IDS),

  // 单个附件大小上限。修改云托管 MAX_UPLOAD_MB 后，前端会通过 /api/dicts 自动同步。
  uploadMaxMb,
  uploadMaxBytes: uploadMaxMb * 1024 * 1024,

  // 云托管 MySQL（容器内由平台注入，本地开发写 .env）
  mysql: {
    host: mysqlHost || '127.0.0.1',
    port: int(mysqlPortStr, 3306),
    user: process.env.MYSQL_USERNAME || 'root',
    password: process.env.MYSQL_PASSWORD || 'dev123456',
    database: process.env.MYSQL_DATABASE || 'simu',
  },

  // 微信支付（云托管代签名时 notify_url 用内部地址，mchid 仅部分接口需要显式传参）
  wxpayMchid: process.env.WXPAY_MCHID || '',
  // 支付回调地址（云托管内部：http://<服务名>.<env>.wxcloudrun/api/pay/notify）
  wxpayNotifyUrl: process.env.WXPAY_NOTIFY_URL || '',
  // 演示价开关：设为 1 则实付 0.01 元；生产必须留空
  payAmountOverrideFen: int(process.env.PAY_AMOUNT_OVERRIDE_FEN, 0) || null,
  payTimeoutSec: int(process.env.PAY_TIMEOUT_SEC, 30 * 60),
  // 支付模式：默认真实微信支付；仅显式设置 PAYMENT_MODE=mock 时启用模拟支付。
  paymentMode: String(process.env.PAYMENT_MODE || 'wechat').trim().toLowerCase() === 'mock'
    ? 'mock'
    : 'wechat',

  // 身份认证演示开关：当前阶段允许工程师自主认证通过，便于联调。
  // 正式上线前设置 ALLOW_ENGINEER_SELF_VERIFY=false 关闭。
  allowEngineerSelfVerify: process.env.ALLOW_ENGINEER_SELF_VERIFY !== 'false',

  // 身份证号使用 AES-256-GCM 加密保存。生产环境应设置独立且长期不变的随机密钥；
  // 未配置时使用云环境与数据库密码派生，保证升级可运行但不建议长期依赖。
  identityDataKey: process.env.IDENTITY_DATA_KEY || `${process.env.CLOUDBASE_ENV_ID || 'local'}:${process.env.MYSQL_PASSWORD || 'dev123456'}`,

  // 腾讯云短信（验证码、忘记密码等）
  sms: {
    secretId: process.env.TENCENT_SMS_SECRET_ID || '',
    secretKey: process.env.TENCENT_SMS_SECRET_KEY || '',
    region: process.env.TENCENT_SMS_REGION || 'ap-beijing',
    signName: process.env.TENCENT_SMS_SIGN_NAME || '仿真工坊',
    templateId: process.env.TENCENT_SMS_TEMPLATE_ID || '',
    sdkAppId: process.env.TENCENT_SMS_SDK_APP_ID || '',
    codeExpires: 5 * 60, // 验证码有效期：5 分钟
    sendCooldown: 60, // 同一手机号重复发送冷却：60 秒
  },

  // 认证与密码重置限流。全部按数据库固定时间窗口计数，多实例共享。
  authRate: {
    loginWindowSec: Math.max(1, int(process.env.LOGIN_RATE_WINDOW_SEC, 15 * 60)),
    loginAccountLimit: Math.max(1, int(process.env.LOGIN_ACCOUNT_FAIL_LIMIT, 5)),
    loginIpLimit: Math.max(1, int(process.env.LOGIN_IP_FAIL_LIMIT, 30)),
    resetSmsWindowSec: Math.max(1, int(process.env.RESET_SMS_WINDOW_SEC, 60 * 60)),
    resetSmsAccountLimit: Math.max(1, int(process.env.RESET_SMS_ACCOUNT_LIMIT, 5)),
    resetSmsIpLimit: Math.max(1, int(process.env.RESET_SMS_IP_LIMIT, 20)),
    resetVerifyWindowSec: Math.max(1, int(process.env.RESET_VERIFY_WINDOW_SEC, 15 * 60)),
    resetVerifyAccountLimit: Math.max(1, int(process.env.RESET_VERIFY_ACCOUNT_LIMIT, 5)),
    resetVerifyIpLimit: Math.max(1, int(process.env.RESET_VERIFY_IP_LIMIT, 20)),
    resetSuccessWindowSec: Math.max(1, int(process.env.RESET_SUCCESS_WINDOW_SEC, 24 * 60 * 60)),
    resetSuccessAccountLimit: Math.max(1, int(process.env.RESET_SUCCESS_ACCOUNT_LIMIT, 3)),
  },

  // 内容安全 Mock 词表
  bannedWords: (process.env.BANNED_WORDS || '违禁词,代刷,加微信私聊')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

module.exports = { config };
