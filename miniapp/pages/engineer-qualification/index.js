const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile, downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');

const DEFAULT_MAX_MB = 30;
const MAX_SUPPORTING = 10;

function sizeText(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

function imageMime(name, mime) {
  return String(mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(String(name || ''));
}

function statusText(status) {
  return status === 'APPROVED' ? '已通过' : status === 'REJECTED' ? '未通过' : '待审核';
}

Page({
  data: {
    loading: true, uploading: false, saving: false, uploadText: '',
    realName: '', phone: '', idCardNumber: '', verifyStatus: 'PENDING', verifyText: '待审核', reviewReason: '',
    idFront: null, idBack: null, files: [], maxSupportingFiles: MAX_SUPPORTING,
    maxFileMb: DEFAULT_MAX_MB, maxFileBytes: DEFAULT_MAX_MB * 1024 * 1024,
  },
  onLoad() {
    if (!ensureLogin()) return;
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const [identity, dicts] = await Promise.all([
        request('GET', '/identity', null, { silent: true }),
        request('GET', '/dicts', null, { silent: true }),
      ]);
      const all = identity.files || [];
      const decorate = (file) => file ? ({ ...file, sizeText: sizeText(file.sizeBytes), persisted: true }) : null;
      const maxFileMb = Number(dicts?.limits?.maxUploadMb) || DEFAULT_MAX_MB;
      this.setData({
        realName: identity.realName || '', phone: identity.phone || '', idCardNumber: identity.idCardNumber || '',
        verifyStatus: identity.verifyStatus || 'PENDING', verifyText: statusText(identity.verifyStatus),
        reviewReason: identity.reviewReason || '',
        idFront: decorate(all.find((file) => file.purpose === 'ID_FRONT')),
        idBack: decorate(all.find((file) => file.purpose === 'ID_BACK')),
        files: all.filter((file) => file.purpose === 'SUPPORTING').map(decorate),
        maxSupportingFiles: Number(identity.maxSupportingFiles || MAX_SUPPORTING),
        maxFileMb, maxFileBytes: Number(dicts?.limits?.maxUploadBytes) || maxFileMb * 1024 * 1024,
      });
    } catch (error) {
      wx.showToast({ title: error.message || '认证信息加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  onRealName(e) { this.setData({ realName: e.detail.value }); },
  onPhone(e) { this.setData({ phone: e.detail.value.replace(/\D/g, '').slice(0, 11) }); },
  onIdCard(e) { this.setData({ idCardNumber: e.detail.value.replace(/[^0-9Xx]/g, '').toUpperCase().slice(0, 18) }); },

  chooseIdImage(e) {
    if (this.data.uploading) return;
    const side = e.currentTarget.dataset.side;
    wx.showActionSheet({
      itemList: ['相机拍照', '从相册中选择'],
      success: ({ tapIndex }) => this.pickIdImage(side, tapIndex === 0 ? 'camera' : 'album'),
    });
  },
  pickIdImage(side, sourceType) {
    const accept = (items) => {
      const file = items && items[0];
      if (!file) return;
      this.uploadIdImage(side, {
        path: file.tempFilePath || file.path,
        name: `身份证${side === 'front' ? '人像面' : '国徽面'}_${Date.now()}.jpg`,
        size: Number(file.size || 0), mime: file.type || 'image/jpeg',
      });
    };
    if (wx.chooseMedia) {
      wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: [sourceType], success: (r) => accept(r.tempFiles) });
    } else {
      wx.chooseImage({ count: 1, sourceType: [sourceType], success: (r) => accept((r.tempFilePaths || []).map((path, i) => ({ path, size: r.tempFiles?.[i]?.size }))) });
    }
  },
  async uploadIdImage(side, file) {
    if (!file.path) return;
    if (!imageMime(file.name, file.mime)) {
      return wx.showModal({ title: '文件格式不支持', content: '身份证正反面只能上传图片文件。', showCancel: false });
    }
    if (file.size > this.data.maxFileBytes) {
      return wx.showModal({ title: '图片超过大小限制', content: `身份证图片不能超过 ${this.data.maxFileMb}MB。`, showCancel: false });
    }
    this.setData({ uploading: true, uploadText: '正在上传身份证…' });
    try {
      const result = await upload(file.path, { kind: 'IMAGE', name: file.name, mime: file.mime });
      const uploaded = { ...result, fileId: result.fileId || result.id, name: file.name, sizeBytes: file.size, sizeText: sizeText(file.size), previewUrl: file.path, persisted: false };
      const old = side === 'front' ? this.data.idFront : this.data.idBack;
      this.setData(side === 'front' ? { idFront: uploaded } : { idBack: uploaded });
      if (old && !old.persisted) this.cleanupUnlinked(old);
    } catch (error) { wx.showToast({ title: error.message || '身份证上传失败', icon: 'none' }); }
    finally { this.setData({ uploading: false, uploadText: '' }); }
  },

  chooseSupporting() {
    if (this.data.uploading) return;
    const rest = this.data.maxSupportingFiles - this.data.files.length;
    if (rest <= 0) return wx.showToast({ title: `最多上传 ${this.data.maxSupportingFiles} 份资料`, icon: 'none' });
    wx.showActionSheet({
      itemList: ['从微信聊天选择文件', '从相册中选择图片'],
      success: ({ tapIndex }) => tapIndex === 0 ? this.pickMessageFiles(rest) : this.pickMediaFiles(rest),
    });
  },
  pickMessageFiles(rest) {
    wx.chooseMessageFile({ count: Math.min(3, rest), type: 'all', success: (r) => this.uploadSupporting((r.tempFiles || []).map((file) => ({
      path: file.path, name: file.name || '认证材料', size: Number(file.size || 0), mime: file.type || '',
    }))) });
  },
  pickMediaFiles(rest) {
    const accept = (items) => this.uploadSupporting((items || []).map((file, index) => ({
      path: file.tempFilePath || file.path, name: `认证材料_${Date.now()}_${index + 1}.jpg`, size: Number(file.size || 0), mime: file.type || 'image/jpeg',
    })));
    if (wx.chooseMedia) wx.chooseMedia({ count: Math.min(3, rest), mediaType: ['image'], sourceType: ['album'], success: (r) => accept(r.tempFiles) });
    else wx.chooseImage({ count: Math.min(3, rest), sourceType: ['album'], success: (r) => accept((r.tempFilePaths || []).map((path, i) => ({ path, size: r.tempFiles?.[i]?.size }))) });
  },
  async uploadSupporting(selected) {
    const candidates = (selected || []).filter((file) => file.path);
    const oversized = candidates.find((file) => file.size > this.data.maxFileBytes);
    if (oversized) return wx.showModal({ title: '文件超过大小限制', content: `“${oversized.name}”超过 ${this.data.maxFileMb}MB。`, showCancel: false });
    this.setData({ uploading: true, uploadText: '正在上传资料…' });
    const added = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const file = candidates[i];
      try {
        this.setData({ uploadText: `正在上传 ${i + 1}/${candidates.length}` });
        const result = await upload(file.path, { kind: imageMime(file.name, file.mime) ? 'IMAGE' : 'DOC', name: file.name, mime: file.mime });
        added.push({ ...result, fileId: result.fileId || result.id, name: file.name, sizeBytes: file.size, sizeText: sizeText(file.size), persisted: false });
      } catch (error) { wx.showToast({ title: `${file.name} 上传失败`, icon: 'none' }); }
    }
    this.setData({ files: this.data.files.concat(added), uploading: false, uploadText: '' });
  },
  async cleanupUnlinked(file) {
    try {
      const result = await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
      deleteCloudFile(result.fileID).catch(() => {});
    } catch (_) {}
  },
  removeSupporting(e) {
    const index = Number(e.currentTarget.dataset.index);
    const file = this.data.files[index];
    if (!file) return;
    wx.showModal({ title: '删除认证材料', content: `确认删除“${file.name}”？`, success: async ({ confirm }) => {
      if (!confirm) return;
      try {
        const result = file.persisted
          ? await request('DELETE', `/identity/files/${file.fileId}`, null, { silent: true })
          : await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
        deleteCloudFile(result.fileID).catch(() => {});
        this.setData({ files: this.data.files.filter((_, i) => i !== index) });
        if (file.persisted) await this.refreshUser();
      } catch (error) { wx.showToast({ title: error.message || '删除失败', icon: 'none' }); }
    } });
  },
  async openFile(e) {
    const source = e.currentTarget.dataset.source;
    const file = source === 'front' ? this.data.idFront : source === 'back' ? this.data.idBack : this.data.files[Number(e.currentTarget.dataset.index)];
    if (!file) return;
    wx.showLoading({ title: '正在打开…', mask: true });
    try { await downloadAndOpen(await request('GET', `/files/${file.fileId}/url`, null, { silent: true })); }
    catch (error) { wx.showModal({ title: '资料打开失败', content: formatDownloadError(error), showCancel: false }); }
    finally { wx.hideLoading(); }
  },
  async submit() {
    if (this.data.saving || this.data.uploading) return;
    const { realName, phone, idCardNumber, idFront, idBack, files } = this.data;
    if (!realName.trim()) return wx.showToast({ title: '请填写真实姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '请填写正确手机号', icon: 'none' });
    if (!/^\d{17}[0-9X]$/.test(idCardNumber)) return wx.showToast({ title: '请填写正确身份证号', icon: 'none' });
    if (!idFront || !idBack) return wx.showToast({ title: '请上传身份证正反面', icon: 'none' });
    this.setData({ saving: true });
    wx.showLoading({ title: '正在提交…', mask: true });
    try {
      await request('POST', '/identity/submit', {
        realName: realName.trim(), phone, idCardNumber,
        idFrontFileId: idFront.fileId, idBackFileId: idBack.fileId,
        supportingFileIds: files.map((file) => file.fileId),
      }, { silent: true });
      await this.refreshUser();
      await this.load();
      wx.showModal({ title: '提交成功', content: '身份认证资料已提交，请等待管理员审核。', showCancel: false });
    } catch (error) { wx.showModal({ title: '提交失败', content: error.message || '请稍后重试', showCancel: false }); }
    finally { wx.hideLoading(); this.setData({ saving: false }); }
  },
  async refreshUser() {
    const user = await request('GET', '/me', null, { silent: true });
    if (user) wx.setStorageSync('user', user);
  },
});
