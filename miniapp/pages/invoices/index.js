const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile, downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');

const INVOICE_FILE_RE = /\.(jpe?g|png|gif|webp|bmp|heic|heif|pdf|docx?)$/i;

function sizeText(sizeBytes) {
  const size = Number(sizeBytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function withFileDisplay(item) {
  return {
    ...item,
    files: (item.files || []).map((file) => ({
      ...file,
      fileId: file.fileId || file.id,
      sizeText: sizeText(file.sizeBytes),
    })),
  };
}

Page({
  data: {
    items: [], loading: true, processingId: '',
    uploadOpen: false, uploadInvoiceId: '', invoiceUploads: [],
    uploading: false, submittingFiles: false, downloadingFileId: '',
  },
  onShow() { const user = ensureLogin(); if (user && user.role === 'ENGINEER') this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const data = await request('GET', '/invoices/mine');
      this.setData({ items: (data.items || []).map(withFileDisplay) });
    }
    catch (error) { wx.showToast({ title: error.message || '加载失败', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  async process(e) {
    const { id, action } = e.currentTarget.dataset;
    if (!id || this.data.processingId) return;
    const prompt = action === 'SELF_ISSUE' ? '选择后请上传电子发票，支持图片、PDF、Word 格式。'
      : action === 'PLATFORM_REQUESTED' ? '将申请平台协助开票。平台开票可能收取服务费，具体费用由平台后续确认。'
        : action === 'ISSUED' ? '确认已完成开票？' : '确认暂不支持本次开票？';
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '处理发票申请', content: prompt, confirmText: '确认', success: (r) => resolve(r.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    this.setData({ processingId: id });
    try {
      await request('POST', `/invoices/${id}/process`, { action });
      wx.showToast({ title: '处理成功', icon: 'success' });
      await this.load();
      if (action === 'SELF_ISSUE') {
        this.setData({ uploadOpen: true, uploadInvoiceId: id, invoiceUploads: [] });
      }
    }
    catch (error) { wx.showToast({ title: error.message || '处理失败', icon: 'none' }); }
    finally { this.setData({ processingId: '' }); }
  },
  openUpload(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ uploadOpen: true, uploadInvoiceId: id, invoiceUploads: [] });
  },
  chooseInvoiceFiles() {
    if (this.data.uploading || this.data.submittingFiles) return;
    const remaining = 5 - this.data.invoiceUploads.length;
    if (remaining <= 0) return wx.showToast({ title: '最多上传 5 个文件', icon: 'none' });
    const that = this;
    wx.chooseMessageFile({
      count: remaining,
      type: 'all',
      success: async (result) => {
        const selected = result.tempFiles || [];
        const invalid = selected.find((file) => !INVOICE_FILE_RE.test(file.name || ''));
        if (invalid) {
          wx.showToast({ title: '仅支持图片、PDF、Word', icon: 'none' });
          return;
        }
        that.setData({ uploading: true });
        wx.showLoading({ title: '上传中…', mask: true });
        const uploads = that.data.invoiceUploads.slice();
        const failures = [];
        for (const file of selected) {
          try {
            const name = file.name || '电子发票';
            const kind = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name) ? 'IMAGE' : 'DOC';
            const uploaded = await upload(file.path || file.tempFilePath, { kind, name });
            uploads.push({
              fileId: uploaded.id || uploaded.fileId,
              name: uploaded.name || name,
              sizeText: sizeText(file.size || uploaded.sizeBytes),
            });
            that.setData({ invoiceUploads: uploads });
          } catch (error) {
            failures.push(`${file.name || '文件'}：${error.message || '上传失败'}`);
          }
        }
        wx.hideLoading();
        that.setData({ uploading: false });
        if (failures.length) {
          wx.showModal({ title: '部分文件未上传', content: failures.join('\n').slice(0, 500), showCancel: false });
        }
      },
    });
  },
  async removeInvoiceFile(e) {
    if (this.data.uploading || this.data.submittingFiles) return;
    const index = Number(e.currentTarget.dataset.index);
    const file = this.data.invoiceUploads[index];
    if (!file) return;
    try {
      const deleted = await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
      const uploads = this.data.invoiceUploads.slice();
      uploads.splice(index, 1);
      this.setData({ invoiceUploads: uploads });
      if (deleted && deleted.fileID) deleteCloudFile(deleted.fileID).catch(() => {});
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败', icon: 'none' });
    }
  },
  closeUpload() {
    if (this.data.uploading || this.data.submittingFiles) return;
    const abandoned = this.data.invoiceUploads.slice();
    this.setData({ uploadOpen: false, uploadInvoiceId: '', invoiceUploads: [] });
    abandoned.forEach(async (file) => {
      try {
        const deleted = await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
        if (deleted && deleted.fileID) await deleteCloudFile(deleted.fileID);
      } catch (error) { /* 孤立文件由后续清理兜底 */ }
    });
  },
  async submitInvoiceFiles() {
    if (this.data.uploading || this.data.submittingFiles) return;
    if (!this.data.invoiceUploads.length) return wx.showToast({ title: '请先上传发票文件', icon: 'none' });
    this.setData({ submittingFiles: true });
    try {
      await request('POST', `/invoices/${this.data.uploadInvoiceId}/files`, {
        fileIds: this.data.invoiceUploads.map((file) => file.fileId),
      });
      this.setData({ uploadOpen: false, uploadInvoiceId: '', invoiceUploads: [] });
      wx.showToast({ title: '发票已交付', icon: 'success' });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '发票提交失败', icon: 'none' });
    } finally {
      this.setData({ submittingFiles: false });
    }
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
      wx.showModal({ title: '文件打开失败', content: formatDownloadError(error), showCancel: false });
    } finally {
      wx.hideLoading();
      this.setData({ downloadingFileId: '' });
    }
  },
  noop() {},
  goOrder(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=market` }); },
});
