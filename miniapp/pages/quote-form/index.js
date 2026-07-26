const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { yuanToFen } = require('../../utils/format');
Page({
  data: { orderId: '', amountYuan: '', days: '', solution: '', submitting: false },
  onLoad(q) {
    ensureLogin();
    this.setData({
      orderId: q.orderId,
      amountYuan: q.amountFen ? String(q.amountFen / 100) : '',
      days: q.days || '',
      solution: q.solution ? decodeURIComponent(q.solution) : '',
    });
  },
  input(e) { this.setData({ [e.currentTarget.dataset.f]: e.detail.value }); },
  async submit() {
    const d = this.data;
    if (d.submitting) return;
    const amountFen = yuanToFen(d.amountYuan);
    const days = parseInt(d.days, 10);
    if (!amountFen || amountFen < 100) return wx.showToast({ title: '报价至少 1 元', icon: 'none' });
    if (!days || days < 1 || days > 90) return wx.showToast({ title: '工期 1-90 天', icon: 'none' });
    if ((d.solution || '').trim().length < 10) return wx.showToast({ title: '技术方案至少10个字', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await request('POST', `/orders/${d.orderId}/quotes`, {
        amountFen, days, solution: d.solution.trim(),
      });
      wx.showToast({ title: '报价已提交', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) { this.setData({ submitting: false }); }
  },
});
