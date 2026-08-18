const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');

function sizeText(sizeBytes) {
  const size = Number(sizeBytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

Page({
  data: { orderId: '', user: null, invoice: null, invoiceTitle: '', taxNumber: '', email: '', customerNote: '', loading: true, submitting: false, downloadingFileId: '' },
  onLoad(q) { this.setData({ orderId: q.orderId || '' }); },
  onShow() { const user = ensureLogin(); if (user) { this.setData({ user }); this.load(); } },
  async load() {
    if (!this.data.orderId) return;
    this.setData({ loading: true });
    try {
      const invoice = await request('GET', `/orders/${this.data.orderId}/invoice-request`, null, { silent: true });
      if (invoice) {
        invoice.files = (invoice.files || []).map((file) => ({
          ...file,
          fileId: file.fileId || file.id,
          sizeText: sizeText(file.sizeBytes),
        }));
      }
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
  async downloadFile(e) {
    const fileId = e.currentTarget.dataset.id;
    if (!fileId || this.data.downloadingFileId) return;
    this.setData({ downloadingFileId: fileId });
    wx.showLoading({ title: '打开中…', mask: true });
    try {
      const info = await request('GET', `/files/${fileId}/url`, null, { silent: true });
      const result = await downloadAndOpen(info);
      if (result && result.notice) {
        wx.hideLoading();
        await new Promise((resolve) => wx.showModal({
          title: '文件已下载', content: result.notice, showCancel: false, complete: resolve,
        }));
      }
    } catch (error) {
      wx.showModal({ title: '发票文件打开失败', content: formatDownloadError(error), showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ downloadingFileId: '' });
    }
  },
  goInvoices() { wx.navigateTo({ url: '/pages/invoices/index' }); },
});
