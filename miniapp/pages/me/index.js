const { ensureLogin, login, getUser, logout } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { BASE_URL } = require('../../utils/config');

const ORIGIN = BASE_URL.replace(/\/api$/, '');

// 将相对路径头像 URL 补全为绝对路径，存入 storage 保证重启后仍可用
function resolveAvatar(user) {
  if (!user || !user.avatarUrl) return user;
  const url = user.avatarUrl.startsWith('/') ? ORIGIN + user.avatarUrl : user.avatarUrl;
  return { ...user, avatarUrl: url };
}

Page({
  data: { user: null, roleText: '' },
  async onShow() {
    // 先用缓存快速渲染（缓存里已是绝对路径，可直接显示）
    const cached = ensureLogin();
    if (!cached) return;
    this.setData({ user: cached, roleText: cached.role === 'ENGINEER' ? '工程师' : '客户' });
    // 后台刷新最新数据
    try {
      const fresh = await request('GET', '/me');
      const resolved = resolveAvatar(fresh);
      wx.setStorageSync('user', resolved);   // 存绝对路径，下次启动可直接用
      this.setData({ user: resolved, roleText: resolved.role === 'ENGINEER' ? '工程师' : '客户' });
    } catch (e) { /* 离线时静默，沿用缓存 */ }
  },
  goEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' });
  },
  goOrders() {
    wx.navigateTo({ url: '/pages/orders/index' });
  },
  goMyQuotes() {
    wx.navigateTo({ url: '/pages/my-quotes/index' });
  },
  goResetPassword() {
    wx.navigateTo({ url: '/pages/reset-password/index' });
  },
  async switchRole() {
    const cur = getUser();
    const target = cur.role === 'ENGINEER' ? 'customer' : 'engineer';
    wx.showModal({
      title: '切换角色（演示）',
      content: `将以「${target === 'engineer' ? '工程师' : '客户'}」身份重新登录`,
      success: async (r) => {
        if (!r.confirm) return;
        await login(target);
        wx.switchTab({ url: '/pages/home/index' });
      },
    });
  },
  logout() {
    logout();
  },
});
