/**
 * 忘记密码页面
 */
const { requestSmsCode, resetPassword } = require('../../utils/auth');

Page({
  data: {
    phone: '',
    smsCode: '',
    newPassword: '',
    confirmPassword: '',
    smsCountdown: 0,
    smsSending: false,
    loading: false,
    step: 1, // 1: 手机号 → 2: 验证码 + 新密码 → 3: 完成
  },

  async requestSms() {
    if (!this.data.phone) return wx.showToast({ title: '请输入手机号', icon: 'none' });
    if (!/^\d{11}$/.test(this.data.phone)) return wx.showToast({ title: '手机号格式不对', icon: 'none' });
    if (this.data.smsCountdown > 0) return;

    this.setData({ smsSending: true });
    try {
      const result = await requestSmsCode(this.data.phone, 'RESET_PWD');
      wx.showToast({ title: '验证码已发送', icon: 'success' });
      this.setData({ smsCountdown: result.nextRetry || 60, step: 2 });
      const timer = setInterval(() => {
        if (this.data.smsCountdown <= 0) {
          clearInterval(timer);
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
      await resetPassword(this.data.phone, this.data.newPassword, this.data.smsCode);
      wx.hideLoading();
      wx.showToast({ title: '重置成功，请重新登录', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '重置失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  onPhone(e) { this.setData({ phone: e.detail.value }); },
  onSmsCode(e) { this.setData({ smsCode: e.detail.value }); },
  onNewPassword(e) { this.setData({ newPassword: e.detail.value }); },
  onConfirmPassword(e) { this.setData({ confirmPassword: e.detail.value }); },
});
