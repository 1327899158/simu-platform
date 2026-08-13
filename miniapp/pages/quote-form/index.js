const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { yuanToFen, fenToYuan } = require('../../utils/format');
const { digits, money, validMoney } = require('../../utils/input');
const { isApproved, promptIdentity } = require('../../utils/identity');
Page({
  data: { orderId: '', amountYuan: '', days: '', solution: '', flexible: true, submitting: false },
  async onLoad(q) {
    let user = ensureLogin();
    if (!user) return;
    try { user = await request('GET', '/me', null, { silent: true }); wx.setStorageSync('user', user); } catch (_) {}
    if (user.role !== 'ENGINEER' || !isApproved(user)) {
      if (user.role === 'ENGINEER') promptIdentity('报价', true);
      else wx.showToast({ title: '仅工程师可以报价', icon: 'none' });
      if (user.role !== 'ENGINEER') setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }), 500);
      return;
    }
    const flexible = q.flexible !== '0';          // 0=固定预算，其余=弹性
    const fixedFen = q.fixedFen ? parseInt(q.fixedFen, 10) : 0;
    // 优先用已有报价金额，否则固定预算时自动填入预算值
    const amountYuan = q.amountFen
      ? String(q.amountFen / 100)
      : (!flexible && fixedFen ? fenToYuan(fixedFen) : '');
    this.setData({
      orderId: q.orderId,
      flexible,
      fixedFen,
      amountYuan,
      days: q.days || '',
      solution: q.solution ? decodeURIComponent(q.solution) : '',
    });
  },
  input(e) {
    const field = e.currentTarget.dataset.f;
    let value = e.detail.value;
    if (field === 'amountYuan') value = money(value);
    if (field === 'days') value = digits(value, 2);
    this.setData({ [field]: value });
    return value;
  },
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    if (!/^\d{1,2}$/.test(d.days)) return wx.showToast({ title: '工期请输入 1-90 的整数', icon: 'none' });
    const days = Number(d.days);
    if (days < 1 || days > 90) return wx.showToast({ title: '工期请输入 1-90 的整数', icon: 'none' });
    if ((d.solution || '').trim().length < 10) return wx.showToast({ title: '技术方案至少10个字', icon: 'none' });
    const body = { days, solution: d.solution.trim() };
    if (d.flexible) {
      if (!validMoney(d.amountYuan)) {
        return wx.showToast({ title: '报价请输入1至1000万元，最多两位小数', icon: 'none' });
      }
      const amountFen = yuanToFen(d.amountYuan);
      body.amountFen = amountFen;
    }
    // 固定预算时不传 amountFen，后端会强制使用订单预算
    this.setData({ submitting: true });
    try {
      await request('POST', `/orders/${d.orderId}/quotes`, body);
      wx.showToast({ title: '报价已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.showToast({ title: e.message || '报价提交失败', icon: 'none' });
      this.setData({ submitting: false });
    }
  },
});
