/**
 * 忘记密码页面
 */
const {
  getPasswordResetTarget,
  requestPasswordResetSms,
  resetPassword,
} = require('../../utils/auth');
const { digits } = require('../../utils/input');

Page({
  data: {
    username: '',
    phoneMasked: '',
    targetReady: false,
    targetLoading: false,
    smsCode: '',
    newPassword: '',
    confirmPassword: '',
    smsCountdown: 0,
    smsSending: false,
    loading: false,
    step: 1, // 1: 确认账号 → 2: 验证码 + 新密码 → 3: 完成
  },

  onLoad(options) {
    const cached = wx.getStorageSync('user') || {};
    let username = options && options.username ? decodeURIComponent(options.username) : '';
    if (!username && cached.username) username = String(cached.username);
    if (username) {
      this.setData({ username });
      setTimeout(() => this.confirmAccount(), 0);
    }
  },

  onUnload() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
  },

  async confirmAccount() {
    if (!/^\d{6,12}$/.test(this.data.username)) {
      wx.showToast({ title: '请输入6-12位数字用户名', icon: 'none' });
      return false;
    }
    if (this.data.targetLoading) return false;
    this.setData({ targetLoading: true });
    try {
      const target = await getPasswordResetTarget(this.data.username);
      this.setData({ phoneMasked: target.phoneMasked, targetReady: true });
      return true;
    } catch (e) {
      this.setData({ phoneMasked: '', targetReady: false });
      wx.showToast({ title: e.message || '账号确认失败', icon: 'none' });
      return false;
    } finally {
      this.setData({ targetLoading: false });
    }
  },

  async requestSms() {
    if (!this.data.targetReady) {
      const ready = await this.confirmAccount();
      if (!ready) return;
    }
    if (this.data.smsCountdown > 0) return;

    this.setData({ smsSending: true });
    try {
      const result = await requestPasswordResetSms(this.data.username);
      wx.showToast({
        title: result.sent === false ? (result.message || '请稍后再试') : '验证码已发送',
        icon: result.sent === false ? 'none' : 'success',
      });
      this.setData({
        phoneMasked: result.phoneMasked || this.data.phoneMasked,
        smsCountdown: result.nextRetry || 60,
        step: 2,
      });
      if (this.countdownTimer) clearInterval(this.countdownTimer);
      this.countdownTimer = setInterval(() => {
        if (this.data.smsCountdown <= 0) {
          clearInterval(this.countdownTimer);
          this.countdownTimer = null;
          this.setData({ smsCountdown: 0 });
        } else {
          this.setData({ smsCountdown: this.data.smsCountdown - 1 });
        }
      }, 1000);
    } catch (e) {
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
    this.setData({ smsSending: false });
  },

  async resetPassword() {
    if (!this.data.targetReady) return wx.showToast({ title: '请先确认账号', icon: 'none' });
    if (!this.data.smsCode) return wx.showToast({ title: '请输入验证码', icon: 'none' });
    if (!this.data.newPassword) return wx.showToast({ title: '请输入新密码', icon: 'none' });
    if (this.data.newPassword.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' });
    if (this.data.newPassword !== this.data.confirmPassword) {
      return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    }

    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '重置中…', mask: true });
      await resetPassword(this.data.username, this.data.newPassword, this.data.smsCode);
      wx.hideLoading();
      wx.showToast({ title: '重置成功，请重新登录', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '重置失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  onUsername(e) {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.setData({
      username: digits(e.detail.value, 12),
      phoneMasked: '',
      targetReady: false,
      smsCode: '',
      smsCountdown: 0,
      step: 1,
    });
  },
  onSmsCode(e) {
    const value = digits(e.detail.value, 6);
    this.setData({ smsCode: value });
    return value;
  },
  onNewPassword(e) { this.setData({ newPassword: e.detail.value }); },
  onConfirmPassword(e) { this.setData({ confirmPassword: e.detail.value }); },
});
