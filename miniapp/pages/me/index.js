const { ensureLogin, login, getUser, logout, promoteToEngineer } = require('../../utils/auth');
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

function verifyView(user) {
  const profile = user && user.engineer;
  const status = user?.identity?.verifyStatus || profile?.verifyStatus || user?.verifyStatus || 'PENDING';
  const fileCount = Number(user?.identity?.fileCount || profile?.qualificationFileCount || 0);
  return {
    verifyStatus: status,
    verifyText: status === 'APPROVED' ? '已通过' : status === 'REJECTED' ? '未通过' : '待审核',
    qualificationFileCount: fileCount,
    // 已提交材料后必须等待管理员审核，避免演示自主认证绕过已发起的人工审核。
    showSelfVerify: user?.role === 'ENGINEER' && status !== 'APPROVED' && !fileCount,
  };
}

Page({
  data: { user: null, roleText: '', verifyStatus: 'UNAPPLIED', verifyText: '未申请', showSelfVerify: true, selfVerifyLoading: false },
  async onShow() {
    // 先用缓存快速渲染（缓存里已是绝对路径，可直接显示）
    const cached = ensureLogin();
    if (!cached) return;
    this.setData({ user: cached, roleText: cached.role === 'ENGINEER' ? '工程师' : '客户', ...verifyView(cached) });
    let tabBar = this.getTabBar && this.getTabBar();
    if (tabBar && tabBar.syncTabBar) tabBar.syncTabBar(cached.role, '/pages/me/index');
    // 后台刷新最新数据
    try {
      const fresh = await request('GET', '/me');
      const resolved = resolveAvatar(fresh);
      wx.setStorageSync('user', resolved);   // 存绝对路径，下次启动可直接用
      this.setData({ user: resolved, roleText: resolved.role === 'ENGINEER' ? '工程师' : '客户', ...verifyView(resolved) });
      tabBar = this.getTabBar && this.getTabBar();
      if (tabBar && tabBar.syncTabBar) tabBar.syncTabBar(resolved.role, '/pages/me/index');
    } catch (e) { /* 离线时静默，沿用缓存 */ }
  },
  goEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' });
  },
  goOrders() {
    if (!this.data.user || this.data.user.role !== 'CUSTOMER') {
      return wx.showToast({ title: '工程师账号没有客户订单入口', icon: 'none' });
    }
    wx.navigateTo({ url: '/pages/orders/index' });
  },
  goMyQuotes() {
    wx.navigateTo({ url: '/pages/my-quotes/index' });
  },
  goMyReviews() {
    wx.navigateTo({ url: '/pages/my-reviews/index' });
  },
  goInvoices() {
    wx.navigateTo({ url: '/pages/invoices/index' });
  },
  goQualification() {
    wx.navigateTo({ url: '/pages/engineer-qualification/index' });
  },
  goMyDisputes() {
    wx.navigateTo({ url: '/pages/disputes/index' });
  },
  goResetPassword() {
    wx.navigateTo({ url: '/pages/reset-password/index' });
  },
  goAccountSecurity() {
    const user = this.data.user || {};
    if (user.username) {
      wx.navigateTo({ url: `/pages/reset-password/index?username=${encodeURIComponent(user.username)}` });
      return;
    }
    wx.navigateTo({ url: '/pages/account-security/index' });
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
  async selfVerifyEngineer() {
    if (this.data.selfVerifyLoading) return;
    const result = await new Promise((resolve) => {
      wx.showModal({
        title: '自主认证（调试）',
        content: '该操作仅用于当前演示和联调，会立即将当前账号设为身份认证已通过。正式上线前请关闭此开关。',
        confirmText: '确认认证',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      });
    });
    if (!result.confirm) return;
    this.setData({ selfVerifyLoading: true });
    wx.showLoading({ title: '认证中…', mask: true });
    try {
      const user = await promoteToEngineer();
      this.setData({
        user,
        roleText: '工程师',
        ...verifyView(user),
      });
      wx.showToast({ title: '认证已通过', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: e.message || '认证失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ selfVerifyLoading: false });
    }
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
