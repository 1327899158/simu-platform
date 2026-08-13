const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { timeShort } = require('../../../utils/format');

Page({
  data: { items: [], total: 0, loading: true, status: 'PENDING', search: '', canReview: false, filterText: '待审核' },
  onLoad() {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.setData({ canReview: hasPermission(admin, 'ENGINEER_APPROVE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onSearchInput(e) { this.setData({ search: e.detail.value }); },
  search() { this.load(); },
  setStatus(e) {
    const value = e.currentTarget.dataset.value;
    this.setData({ status: this.data.status === value ? '' : value }, () => { this.syncFilterText(); this.load(); });
  },
  syncFilterText() {
    const text = { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回' }[this.data.status] || '全部用户';
    this.setData({ filterText: text });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('GET', '/admin/engineers', {
        status: this.data.status, search: this.data.search, limit: 100,
      }, { silent: true });
      this.setData({
        total: result.total,
        items: result.items.map((item) => ({ ...item, createdText: timeShort(item.createdAt), reviewedText: timeShort(item.reviewedAt) })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '工程师加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  approve(e) { this.review(e.currentTarget.dataset.id, 'APPROVED', '确认通过该工程师的身份认证？'); },
  reject(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '驳回身份认证', editable: true, placeholderText: '请输入驳回原因（至少2个字）',
      success: (result) => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (reason.length < 2) { wx.showToast({ title: '请填写驳回原因', icon: 'none' }); return; }
        this.submitReview(id, 'REJECTED', reason);
      },
    });
  },
  review(id, status, content) {
    wx.showModal({ title: '认证审核确认', content, success: (r) => { if (r.confirm) this.submitReview(id, status, '身份认证审核通过'); } });
  },
  async submitReview(id, status, reason) {
    try {
      await request('POST', `/admin/engineers/${id}/review`, { status, reason }, { silent: true });
      wx.showToast({ title: status === 'APPROVED' ? '审核已通过' : '已驳回', icon: 'success' });
      this.load();
    } catch (error) { wx.showToast({ title: error.message || '审核失败', icon: 'none' }); }
  },
  open(e) { wx.navigateTo({ url: `/admin/pages/engineer-detail/index?id=${e.currentTarget.dataset.id}` }); },
});
