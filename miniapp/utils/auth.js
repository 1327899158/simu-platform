/**
 * 认证工具（云开发版）。
 *
 * 云开发版变化：
 *   - 不再有 token（无 accessToken / refreshToken）
 *   - 用户身份由 wx.cloud.callContainer 自动注入 X-WX-OPENID，服务端直接识别
 *   - wx.login 仍然需要调用（云开发初始化需要），但 code 不再发给我们自己的后端
 *   - 登录状态：localStorage 存 user 对象，不存 token
 */
const { request } = require('./request');
const { ENV_ID } = require('./config');

/** 初始化云开发（app.js 启动时调用） */
function initCloud() {
  if (typeof wx.cloud !== 'undefined') {
    wx.cloud.init({ env: ENV_ID, traceUser: true });
  }
}

/**
 * 登录：调用 wx.login（云开发环境初始化），
 * 然后 callContainer 到 /api/auth/wx-login 完成用户注册/登录。
 * roleHint: 'customer' | 'engineer'
 */
async function login(roleHint = 'customer') {
  // 云开发环境需要 wx.login 初始化，但我们不用 code 去 jscode2session
  await new Promise((resolve, reject) => {
    wx.login({ success: resolve, fail: () => resolve({}) }); // 失败也继续（云开发内部处理）
  });

  // 发请求给云托管（X-WX-OPENID 由微信网关自动注入）
  const data = await request('POST', '/auth/wx-login', { roleHint });
  saveUser(data.user);
  return data.user;
}

/** 工程师身份自主认证（演示阶段；服务端可通过 ALLOW_ENGINEER_SELF_VERIFY 关闭） */
async function promoteToEngineer() {
  const user = await request('POST', '/dev/promote-engineer', {});
  saveUser(user);
  return user;
}

function saveUser(user) {
  if (user) wx.setStorageSync('user', user);
}

function saveSession(token) {
  if (token) wx.setStorageSync('sessionToken', token);
}

function getUser() {
  return wx.getStorageSync('user') || null;
}

function setUser(u) {
  wx.setStorageSync('user', u);
}

function isLoggedIn() {
  return !!getUser();
}

async function logout() {
  try {
    await request('POST', '/auth/logout', {}, { silent: true });
  } catch (e) {
    // Local cache must still be cleared when the network is unavailable.
  }
  wx.removeStorageSync('user');
  wx.removeStorageSync('sessionToken');
  wx.reLaunch({ url: '/pages/login/index' });
}

/**
 * 页面 onLoad / onShow 里调用：未登录跳登录页，返回 user 或 null。
 * 云开发版：本地有 user 缓存就视为已登录（openid 由网关保证）。
 */
function ensureLogin() {
  const user = getUser();
  if (!user) {
    wx.reLaunch({ url: '/pages/login/index' });
    return null;
  }
  return user;
}

/**
 * 刷新用户信息（从服务端重新拉取）。
 */
async function refreshUser() {
  try {
    const user = await request('GET', '/me', null, { silent: true });
    if (user) saveUser(user);
    return user;
  } catch (e) {
    return getUser();
  }
}

// -------- 多种登录方式 --------

/**
 * 账号密码登录
 */
async function loginByUsername(username, password) {
  const data = await request('POST', '/auth/login', { username, password });
  saveUser(data.user);
  saveSession(data.token);
  return data.user;
}

/**
 * 账号密码注册（需要先请求短信验证码）
 */
async function registerByPhone(username, phone, password, smsCode, roleHint = 'customer') {
  const data = await request('POST', '/auth/register', {
    username, phone, password, smsCode, roleHint,
  });
  saveUser(data.user);
  saveSession(data.token);
  return data.user;
}

/**
 * 手机号登录（验证码方式）
 */
async function loginByPhone(phone, smsCode, roleHint = 'customer') {
  const data = await request('POST', '/auth/phone-login', { phone, smsCode, roleHint });
  saveUser(data.user);
  saveSession(data.token);
  return data.user;
}

/**
 * 请求短信验证码
 * type: 'REGISTER' | 'LOGIN' | 'RESET_PWD'
 */
async function requestSmsCode(phone, type = 'LOGIN') {
  const data = await request('POST', '/auth/request-sms', { phone, type });
  return data; // { sent: true, nextRetry: 60 }
}

/**
 * 查询密码重置目标，只返回脱敏后的绑定手机号。
 */
async function getPasswordResetTarget(username) {
  return request('POST', '/auth/reset-password-target', { username }, { silent: true });
}

/**
 * 密码重置验证码由后端按用户名发送到绑定号码，客户端不传手机号。
 */
async function requestPasswordResetSms(username) {
  return request('POST', '/auth/request-sms', { username, type: 'RESET_PWD' }, { silent: true });
}

/**
 * 忘记密码重置
 */
async function resetPassword(username, newPassword, smsCode) {
  const data = await request('POST', '/auth/reset-password', {
    username, newPassword, smsCode,
  }, { silent: true });
  return data;
}

/** 手机号登录用户首次设置账号和密码。 */
async function setAccountPassword(username, password) {
  const data = await request('POST', '/auth/set-account-password', { username, password }, { silent: true });
  if (data && data.user) saveUser(data.user);
  return data && data.user;
}

module.exports = {
  initCloud,
  login,
  promoteToEngineer,
  loginByUsername,
  registerByPhone,
  loginByPhone,
  requestSmsCode,
  getPasswordResetTarget,
  requestPasswordResetSms,
  resetPassword,
  setAccountPassword,
  getUser, setUser, isLoggedIn, saveUser, saveSession, logout,
  ensureLogin, refreshUser,
};
