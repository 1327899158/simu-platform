const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { downloadAndOpen, formatDownloadError } = require('../../../utils/cloud-file');
const { timeShort } = require('../../../utils/format');

Page({
  data: { id: '', user: null, loading: true, canReview: false },
  onLoad(options) {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    if (!options.id) { wx.showToast({ title: '缺少用户ID', icon: 'none' }); return; }
    this.setData({ id: options.id, canReview: hasPermission(admin, 'IDENTITY_APPROVE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const user = await request('GET', `/admin/users/${this.data.id}`, null, { silent: true });
      const identity = user.identity || {};
      this.setData({ user: {
        ...user,
        roleText: user.role === 'ENGINEER' ? '工程师' : '客户',
        statusText: user.status === 'ACTIVE' ? '正常' : '已停用',
        createdText: timeShort(user.createdAt),
        sentReviews: (user.sentReviews || []).map((item) => ({ ...item, updatedText: timeShort(item.updatedAt) })),
        identity: {
          ...identity,
          statusText: identity.verifyStatus === 'APPROVED' ? '已通过' : identity.verifyStatus === 'REJECTED' ? '未通过' : '待审核',
          files: (identity.files || []).map((file) => ({
            ...file,
            purposeText: file.purpose === 'ID_FRONT' ? '身份证人像面' : file.purpose === 'ID_BACK' ? '身份证国徽面' : '补充材料',
          })),
        },
      } });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '用户资料加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  approveIdentity() {
    wx.showModal({ title: '认证审核确认', content: '确认通过该用户的身份认证？', success: ({ confirm }) => {
      if (confirm) this.submitIdentityReview('APPROVED', '身份认证审核通过');
    } });
  },
  rejectIdentity() {
    wx.showModal({ title: '驳回身份认证', editable: true, placeholderText: '请输入驳回原因（至少2个字）', success: ({ confirm, content }) => {
      if (!confirm) return;
      const reason = String(content || '').trim();
      if (reason.length < 2) return wx.showToast({ title: '请填写驳回原因', icon: 'none' });
      this.submitIdentityReview('REJECTED', reason);
    } });
  },
  async submitIdentityReview(status, reason) {
    try {
      await request('POST', `/admin/users/${this.data.id}/identity-review`, { status, reason }, { silent: true });
      wx.showToast({ title: status === 'APPROVED' ? '审核已通过' : '已驳回', icon: 'success' });
      this.load();
    } catch (error) { wx.showToast({ title: error.message || '审核失败', icon: 'none' }); }
  },
  async openIdentityFile(e) {
    const file = this.data.user?.identity?.files?.[e.currentTarget.dataset.index];
    if (!file) return;
    wx.showLoading({ title: '正在打开…', mask: true });
    try { await downloadAndOpen(await request('GET', `/admin/files/${file.fileId}/url`, null, { silent: true })); }
    catch (error) { wx.showModal({ title: '资料打开失败', content: formatDownloadError(error), showCancel: false }); }
    finally { wx.hideLoading(); }
  },
});
