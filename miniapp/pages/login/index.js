/**
 * 登录页（云开发版 + 多种登录方式）。
 * 支持三种登录：微信一键、账号密码、手机验证码。
 */
const {
  login, loginByUsername, registerByPhone, loginByPhone,
  requestSmsCode, isLoggedIn, logout
} = require('../../utils/auth');

Page({
  data: {
    tab: 'wechat',      // wechat | username | phone
    role: '',           // customer | engineer
    roleText: '',
    loading: false,

    // 账号密码标签页
    isRegister: false,  // 注册 vs 登录
    username: '',
    password: '',
    passwordConfirm: '',

    // 手机验证码标签页
    phone: '',
    smsCode: '',
    smsCountdown: 0,
    smsSending: false,

    // 共通的角色选择
    selectingRole: false,
  },

  onLoad() {
    if (isLoggedIn()) wx.switchTab({ url: '/pages/home/index' });
  },

  // ========== Tab 切换 ==========
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ tab, role: '', username: '', password: '', phone: '', smsCode: '' });
  },

  // ========== 微信一键登录 ==========
  async wxLogin() {
    if (!this.data.role) {
      return wx.showToast({ title: '请先选择身份', icon: 'none' });
    }
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '登录中…', mask: true });
      await login(this.data.role);
      wx.hideLoading();
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  selectRole(e) {
    const role = e.currentTarget.dataset.role;
    this.setData({
      role,
      roleText: role === 'engineer' ? '工程师' : '客户',
    });
  },

  // ========== 账号密码 ==========
  toggleRegister(e) {
    // 根据 WXML 传入的 data-mode 设置登录/注册
    const mode = e.currentTarget.dataset.mode;
    if (mode === 'register') {
      this.setData({ isRegister: true, username: '', password: '', passwordConfirm: '' });
    } else {
      this.setData({ isRegister: false, username: '', password: '', passwordConfirm: '' });
    }
  },

  async accountLogin() {
    if (!this.data.username) return wx.showToast({ title: '请输入用户名', icon: 'none' });
    if (!this.data.password) return wx.showToast({ title: '请输入密码', icon: 'none' });
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '登录中…', mask: true });
      await loginByUsername(this.data.username, this.data.password);
      wx.hideLoading();
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  async accountRegister() {
    if (!this.data.username) return wx.showToast({ title: '请输入用户名（6-12位数字）', icon: 'none' });
    if (!/^\d{6,12}$/.test(this.data.username)) {
      return wx.showToast({ title: '用户名只能是6-12位数字', icon: 'none' });
    }
    if (!this.data.phone) return wx.showToast({ title: '请输入手机号', icon: 'none' });
    if (!/^\d{11}$/.test(this.data.phone)) return wx.showToast({ title: '手机号格式不对', icon: 'none' });
    if (!this.data.password) return wx.showToast({ title: '请输入密码（至少6位）', icon: 'none' });
    if (this.data.password.length < 6) return wx.showToast({ title: '密码至少6位', icon: 'none' });
    if (this.data.password !== this.data.passwordConfirm) {
      return wx.showToast({ title: '两次密码不一致', icon: 'none' });
    }
    if (!this.data.smsCode) return wx.showToast({ title: '请输入验证码', icon: 'none' });
    if (!/^\d{6}$/.test(this.data.smsCode)) return wx.showToast({ title: '验证码格式不对', icon: 'none' });

    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '注册中…', mask: true });
      await registerByPhone(
        this.data.username,
        this.data.phone,
        this.data.password,
        this.data.smsCode,
        this.data.role || 'customer'
      );
      wx.hideLoading();
      wx.showToast({ title: '注册成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '注册失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  goResetPassword() {
    wx.navigateTo({ url: '/pages/reset-password/index' });
  },

  // ========== 手机验证码 ==========
  async phoneRequestSms() {
    if (!this.data.phone) return wx.showToast({ title: '请输入手机号', icon: 'none' });
    if (!/^\d{11}$/.test(this.data.phone)) return wx.showToast({ title: '手机号格式不对', icon: 'none' });
    if (this.data.smsCountdown > 0) return;

    // 根据当前页面状态决定验证码类型
    let type = 'LOGIN';
    if (this.data.tab === 'username' && this.data.isRegister) {
      type = 'REGISTER';
    } else if (this.data.tab === 'phone') {
      type = 'LOGIN';
    }

    this.setData({ smsSending: true });
    try {
      const result = await requestSmsCode(this.data.phone, type);
      wx.showToast({ title: '验证码已发送', icon: 'success' });
      // 倒计时
      this.setData({ smsCountdown: result.nextRetry || 60 });
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

  async phoneLogin() {
    if (!this.data.phone) return wx.showToast({ title: '请输入手机号', icon: 'none' });
    if (!this.data.smsCode) return wx.showToast({ title: '请输入验证码', icon: 'none' });
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      wx.showLoading({ title: '登录中…', mask: true });
      await loginByPhone(this.data.phone, this.data.smsCode, this.data.role || 'customer');
      wx.hideLoading();
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 800);
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '登录失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  // ========== 输入事件 ==========
  onUsername(e) { this.setData({ username: e.detail.value }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },
  onPasswordConfirm(e) { this.setData({ passwordConfirm: e.detail.value }); },
  onPhone(e) { this.setData({ phone: e.detail.value }); },
  onSmsCode(e) { this.setData({ smsCode: e.detail.value }); },
});
