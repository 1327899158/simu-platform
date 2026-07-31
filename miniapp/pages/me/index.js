const { ensureLogin, login, getUser, logout, saveSession, isLoggedIn } = require('../../utils/auth');
const { request } = require('../../utils/request');

// 云存储 fileID 或 https 开头的 URL 直接使用，相对路径补全为云存储临时链接
function resolveAvatar(user) {
  if (!user || !user.avatarUrl) return user;
  const url = user.avatarUrl;
  // cloud:// 开头 → 云存储 fileID，直接用
  // https:// 开头 → 已是完整 URL，直接用
  // 其他 → 尝试当作 fileID 处理（后端返回的可能是 fileID）
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
        // 微信用户走 wx-login，非微信用户直接修改 role
        const token = wx.getStorageSync('sessionToken');
        if (token) {
          // 非微信登录用户：直接调后端切换角色
          try {
            wx.showLoading({ title: '切换中…', mask: true });
            // 重新登录获取新 token + 新角色
            await login(target);
            wx.hideLoading();
            wx.switchTab({ url: '/pages/home/index' });
          } catch (e) {
            wx.hideLoading();
            wx.showToast({ title: e.message || '切换失败', icon: 'none' });
          }
        } else {
          // 微信用户
          try {
            await login(target);
            wx.switchTab({ url: '/pages/home/index' });
          } catch (e) {
            wx.showToast({ title: e.message || '切换失败', icon: 'none' });
          }
        }
      },
    });
  },
  logout() {
    logout();
  },
  // 微信授权获取手机号
  async onGetPhoneNumber(e) {
    if (e.detail.errMsg !== 'getPhoneNumber:ok') {
      return wx.showToast({ title: '已取消授权', icon: 'none' });
    }
    try {
      wx.showLoading({ title: '绑定中…', mask: true });
      const data = await request('POST', '/auth/bind-phone', { code: e.detail.code });
      wx.hideLoading();
      // 更新本地缓存
      wx.setStorageSync('user', data.user);
      this.setData({ user: data.user });
      wx.showToast({ title: '手机号已绑定', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '绑定失败', icon: 'none' });
    }
  },
});
