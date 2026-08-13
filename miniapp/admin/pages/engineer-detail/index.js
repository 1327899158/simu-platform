const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { downloadAndOpen, formatDownloadError } = require('../../../utils/cloud-file');
const { timeShort } = require('../../../utils/format');

function sizeText(bytes) {
  const size = Number(bytes || 0);
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(2)}MB`;
}

Page({
  data: { id: '', engineer: null, loading: true, canReview: false },
  onLoad(options) {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    if (!options.id) { wx.showToast({ title: '缺少工程师ID', icon: 'none' }); return; }
    this.setData({ id: options.id, canReview: hasPermission(admin, 'ENGINEER_APPROVE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const engineer = await request('GET', `/admin/engineers/${this.data.id}`, null, { silent: true });
      const badge = engineer.verifyStatus === 'APPROVED' ? 'badge-green' : engineer.verifyStatus === 'REJECTED' ? 'badge-red' : 'badge-orange';
      this.setData({ engineer: {
        ...engineer,
        badgeClass: badge,
        createdText: timeShort(engineer.createdAt),
        reviewedText: timeShort(engineer.reviewedAt),
        files: (engineer.files || []).map((file) => ({
          ...file, sizeText: sizeText(file.sizeBytes),
          purposeText: file.purpose === 'ID_FRONT' ? '身份证人像面' : file.purpose === 'ID_BACK' ? '身份证国徽面' : '补充材料',
        })),
        receivedReviews: (engineer.receivedReviews || []).map((item) => ({ ...item, updatedText: timeShort(item.updatedAt) })),
      } });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '资料加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  approve() { this.review('APPROVED', '确认通过该工程师的身份认证？'); },
  reject() {
    wx.showModal({
      title: '驳回身份认证', editable: true, placeholderText: '请输入驳回原因（至少2个字）',
      success: (result) => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (reason.length < 2) { wx.showToast({ title: '请填写驳回原因', icon: 'none' }); return; }
        this.submitReview('REJECTED', reason);
      },
    });
  },
  review(status, content) {
    wx.showModal({ title: '认证审核确认', content, success: (result) => { if (result.confirm) this.submitReview(status, '身份认证审核通过'); } });
  },
  async submitReview(status, reason) {
    try {
      await request('POST', `/admin/engineers/${this.data.id}/review`, { status, reason }, { silent: true });
      wx.showToast({ title: status === 'APPROVED' ? '审核已通过' : '已驳回', icon: 'success' });
      this.load();
    } catch (error) { wx.showToast({ title: error.message || '审核失败', icon: 'none' }); }
  },
  async openFile(e) {
    const file = this.data.engineer?.files?.[e.currentTarget.dataset.index];
    if (!file) return;
    wx.showLoading({ title: '正在打开…', mask: true });
    try {
      const info = await request('GET', `/admin/files/${file.fileId}/url`, null, { silent: true });
      await downloadAndOpen(info);
    } catch (error) {
      wx.showModal({ title: '资料打开失败', content: formatDownloadError(error), showCancel: false });
    } finally { wx.hideLoading(); }
  },
});
