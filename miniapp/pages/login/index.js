/**
 * 登录页（云开发版）。
 *
 * 云开发版大幅简化：只保留「选角色 → 微信一键登录」流程。
 * openid 由微信网关自动注入，无需 jscode2session / JWT / 手机验证码。
 *
 * 保留角色选择是因为首次登录时服务端需要 roleHint 决定用户角色。
 */
const { login, isLoggedIn, getUser } = require('../../utils/auth');

Page({
  data: {
    role: '',        // 'customer' | 'engineer'
    roleText: '',
    loading: false,
  },

  onLoad() {
    // 已登录直接进首页
    if (isLoggedIn()) wx.switchTab({ url: '/pages/home/index' });
  },

  selectRole(e) {
    const role = e.currentTarget.dataset.role;
    this.setData({
      role,
      roleText: role === 'engineer' ? '工程师' : '客户',
    });
  },

  async doLogin() {
    if (!this.data.role) {
      return wx.showToast({ title: '请先选择身份', icon: 'none' });
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '登录中…', mask: true });
      const user = await login(this.data.role);
      wx.hideLoading();
      wx.showToast({
        title: user.nickname ? `欢迎，${user.nickname}` : '登录成功',
        icon: 'success',
        duration: 1000,
      });
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '登录失败，请重试', icon: 'none' });
    }
    this.setData({ loading: false });
  },
});
