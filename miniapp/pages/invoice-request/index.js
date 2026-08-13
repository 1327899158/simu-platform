const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');

Page({
  data: { orderId: '', user: null, invoice: null, invoiceTitle: '', taxNumber: '', email: '', customerNote: '', loading: true, submitting: false },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); },
  onShow() { const user = ensureLogin(); if (user) { this.setData({ user }); this.load(); } },
  async load() {
    if (!this.data.orderId) return;
    this.setData({ loading: true });
    try {
      const invoice = await request('GET', `/orders/${this.data.orderId}/invoice-request`, null, { silent: true });
      this.setData({ invoice });
    } catch (error) { wx.showToast({ title: error.message || '发票信息加载失败', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  onField(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  async submit() {
    if (this.data.submitting || this.data.invoice) return;
    if (this.data.user.role !== 'CUSTOMER') return wx.showToast({ title: '请到“我的 - 发票处理”处理申请', icon: 'none' });
    const { invoiceTitle, taxNumber, email, customerNote } = this.data;
    if (invoiceTitle.trim().length < 2) return wx.showToast({ title: '请填写发票抬头', icon: 'none' });
    this.setData({ submitting: true });
    try {
      await request('POST', `/orders/${this.data.orderId}/invoice-request`, { invoiceTitle: invoiceTitle.trim(), taxNumber: taxNumber.trim(), email: email.trim(), customerNote: customerNote.trim() });
      wx.showToast({ title: '申请已提交', icon: 'success' }); this.load();
    } catch (error) { wx.showToast({ title: error.message || '提交失败', icon: 'none' }); }
    finally { this.setData({ submitting: false }); }
  },
  goInvoices() { wx.navigateTo({ url: '/pages/invoices/index' }); },
});
