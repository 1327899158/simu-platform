const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile, downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');

const MAX_FILES = 10;
const DEFAULT_MAX_MB = 30;

function sizeText(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function imageMime(name, mime) {
  return String(mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(name || ''));
}

Page({
  data: { files: [], loading: true, uploading: false, uploadText: '', maxFileMb: DEFAULT_MAX_MB, maxFileBytes: DEFAULT_MAX_MB * 1024 * 1024 },
  onLoad() {
    const user = ensureLogin();
    if (!user) return;
    if (user.role !== 'ENGINEER') {
      wx.showToast({ title: '仅工程师可提交资格资料', icon: 'none' });
      wx.navigateBack();
      return;
    }
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const [files, dicts] = await Promise.all([
        request('GET', '/engineer/verification-files', null, { silent: true }),
        request('GET', '/dicts', null, { silent: true }),
      ]);
      const maxFileMb = Number(dicts?.limits?.maxUploadMb) || DEFAULT_MAX_MB;
      this.setData({
        files: (files || []).map((file) => ({ ...file, sizeText: sizeText(file.sizeBytes) })),
        maxFileMb,
        maxFileBytes: Number(dicts?.limits?.maxUploadBytes) || maxFileMb * 1024 * 1024,
      });
    } catch (error) {
      wx.showToast({ title: error.message || '资料加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  choose() {
    if (this.data.uploading) return;
    const rest = MAX_FILES - this.data.files.length;
    if (rest <= 0) return wx.showToast({ title: `最多上传 ${MAX_FILES} 份资料`, icon: 'none' });
    wx.showActionSheet({
      itemList: ['从微信聊天选择文件', '从手机相册选择图片'],
      success: (result) => {
        if (result.tapIndex === 0) this.pickMessageFiles(rest);
        else this.pickMediaFiles(rest);
      },
    });
  },
  pickMessageFiles(rest) {
    wx.chooseMessageFile({
      count: Math.min(3, rest), type: 'all',
      success: (result) => this.uploadSelected((result.tempFiles || []).map((file) => ({
        path: file.path, name: file.name || '资格资料', size: Number(file.size || 0), mime: file.type || '',
      }))),
    });
  },
  pickMediaFiles(rest) {
    wx.chooseMedia({
      count: Math.min(3, rest), mediaType: ['image'], sourceType: ['album'],
      success: (result) => this.uploadSelected((result.tempFiles || []).map((file, index) => ({
        path: file.tempFilePath, name: `资格图片_${Date.now()}_${index + 1}.jpg`, size: Number(file.size || 0), mime: 'image/jpeg',
      }))),
    });
  },
  async uploadSelected(selected) {
    const candidates = (selected || []).filter((file) => file.path);
    if (!candidates.length) return;
    const oversized = candidates.find((file) => file.size > this.data.maxFileBytes);
    if (oversized) return wx.showModal({ title: '文件超过大小限制', content: `“${oversized.name}”超过 ${this.data.maxFileMb}MB，无法上传。`, showCancel: false });
    this.setData({ uploading: true, uploadText: '正在上传资料…' });
    const fileIds = [];
    const failed = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const file = candidates[i];
      this.setData({ uploadText: `正在上传 ${i + 1}/${candidates.length}` });
      try {
        const up = await upload(file.path, {
          kind: imageMime(file.name, file.mime) ? 'IMAGE' : 'DOC', name: file.name, mime: file.mime,
        });
        fileIds.push(up.fileId || up.id);
      } catch (error) { failed.push(file.name); }
    }
    try {
      if (fileIds.length) await request('POST', '/engineer/verification-files', { fileIds }, { silent: true });
      await this.refreshUser();
      await this.load();
      if (failed.length) wx.showModal({ title: '部分资料未上传', content: `${failed.join('、')} 上传失败，其余资料已提交审核。`, showCancel: false });
      else wx.showToast({ title: '资料已提交审核', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '资料提交失败', icon: 'none' });
    } finally { this.setData({ uploading: false, uploadText: '' }); }
  },
  async refreshUser() {
    const user = await request('GET', '/me', null, { silent: true });
    if (user) wx.setStorageSync('user', user);
  },
  remove(e) {
    const file = this.data.files[e.currentTarget.dataset.index];
    if (!file) return;
    wx.showModal({
      title: '删除资格资料', content: `确认删除“${file.name}”？删除后需重新审核。`,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const deleted = await request('DELETE', `/engineer/verification-files/${file.fileId}`, null, { silent: true });
          deleteCloudFile(deleted.fileID).catch(() => {});
          await this.refreshUser();
          await this.load();
          wx.showToast({ title: '已删除，等待重新审核', icon: 'success' });
        } catch (error) { wx.showToast({ title: error.message || '删除失败', icon: 'none' }); }
      },
    });
  },
  async open(e) {
    const file = this.data.files[e.currentTarget.dataset.index];
    if (!file) return;
    wx.showLoading({ title: '正在打开…', mask: true });
    try {
      const info = await request('GET', `/files/${file.fileId}/url`, null, { silent: true });
      await downloadAndOpen(info);
    } catch (error) {
      wx.showModal({ title: '资料打开失败', content: formatDownloadError(error), showCancel: false });
    } finally { wx.hideLoading(); }
  },
});
