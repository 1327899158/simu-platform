const { ensureLogin, getUser, setAccountPassword } = require('../../utils/auth');
const { digits } = require('../../utils/input');

Page({
  data: { username: '', password: '', confirmPassword: '', phoneMasked: '', saving: false },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    if (user.hasPassword || user.username) {
      wx.redirectTo({ url: `/pages/reset-password/index?username=${encodeURIComponent(user.username || '')}` });
      return;
    }
    this.setData({ phoneMasked: user.phoneMasked || '已绑定手机号' });
  },
  onUsername(e) { this.setData({ username: digits(e.detail.value, 12) }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },
  onConfirmPassword(e) { this.setData({ confirmPassword: e.detail.value }); },
  async submit() {
    const { username, password, confirmPassword, saving } = this.data;
    if (saving) return;
    if (!/^\d{6,12}$/.test(username)) return wx.showToast({ title: '账号为6-12位数字', icon: 'none' });
    if (password.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' });
    if (password !== confirmPassword) return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    this.setData({ saving: true });
    try {
      const user = await setAccountPassword(username, password);
      wx.showToast({ title: '设置成功', icon: 'success' });
      if (user) wx.setStorageSync('user', user);
      setTimeout(() => wx.navigateBack(), 700);
    } catch (error) {
      wx.showToast({ title: error.message || '设置失败', icon: 'none' });
    } finally { this.setData({ saving: false }); }
  },
});
