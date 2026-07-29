const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { yuanToFen, fenToYuan } = require('../../utils/format');
Page({
  data: { orderId: '', amountYuan: '', days: '', solution: '', flexible: true, submitting: false },
  onLoad(q) {
    ensureLogin();
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
  input(e) { this.setData({ [e.currentTarget.dataset.f]: e.detail.value }); },
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    const days = parseInt(d.days, 10);
    if (!days || days < 1 || days > 90) return wx.showToast({ title: '工期 1-90 天', icon: 'none' });
    if ((d.solution || '').trim().length < 10) return wx.showToast({ title: '技术方案至少10个字', icon: 'none' });
    const body = { days, solution: d.solution.trim() };
    if (d.flexible) {
      const amountFen = yuanToFen(d.amountYuan);
      if (!amountFen || amountFen < 100) return wx.showToast({ title: '报价至少 1 元', icon: 'none' });
      body.amountFen = amountFen;
    }
    // 固定预算时不传 amountFen，后端会强制使用订单预算
    this.setData({ submitting: true });
    try {
      await request('POST', `/orders/${d.orderId}/quotes`, body);
      wx.showToast({ title: '报价已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) { this.setData({ submitting: false }); }
  },
});
