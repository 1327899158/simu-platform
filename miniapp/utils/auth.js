/** 登录：Mock 模式用本机持久化 mockId（同设备同角色=同账号）；真实模式 wx.login 换 code。 */
const { WX_MOCK } = require('./config');
const { request, tokens } = require('./request');

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('wx.login 失败'))),
      fail: () => reject(new Error('wx.login 失败')),
    });
  });
}

function mockCode(role) {
  const key = 'mockId:' + role;
  let id = wx.getStorageSync(key);
  if (!id) {
    id = 'dev' + Math.random().toString(36).slice(2, 10);
    wx.setStorageSync(key, id);
  }
  return id + '-' + role; // 保证客户/工程师是两个不同账号
}

async function login(roleHint) {
  const code = WX_MOCK ? mockCode(roleHint) : await wxLoginCode();
  const data = await request('POST', '/auth/wx-login', { code, roleHint }, { noAuth: true });
  tokens.save(data);
  wx.setStorageSync('user', data.user);
  return data.user;
}

const getUser = () => wx.getStorageSync('user') || null;
const setUser = (u) => wx.setStorageSync('user', u);
const isLoggedIn = () => !!(wx.getStorageSync('accessToken') && getUser());

/** 页面 onShow 里调用：未登录跳登录页，返回 user 或 null */
function ensureLogin() {
  if (isLoggedIn()) return getUser();
  wx.reLaunch({ url: '/pages/login/index' });
  return null;
}

module.exports = { login, getUser, setUser, isLoggedIn, ensureLogin };
