const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { timeShort } = require('../../../utils/format');

Page({
  data: { items: [], total: 0, loading: true, search: '', role: '', status: '', canManage: false, filterText: '全部用户' },
  onLoad() {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.setData({ canManage: hasPermission(admin, 'USER_STATUS_UPDATE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onSearchInput(e) { this.setData({ search: e.detail.value }); },
  search() { this.load(); },
  setRole(e) {
    const value = e.currentTarget.dataset.value;
    this.setData({ role: this.data.role === value ? '' : value }, () => { this.syncFilterText(); this.load(); });
  },
  setStatus(e) {
    const value = e.currentTarget.dataset.value;
    this.setData({ status: this.data.status === value ? '' : value }, () => { this.syncFilterText(); this.load(); });
  },
  syncFilterText() {
    const parts = [];
    if (this.data.role === 'CUSTOMER') parts.push('客户');
    if (this.data.role === 'ENGINEER') parts.push('工程师');
    if (this.data.status === 'ACTIVE') parts.push('正常');
    if (this.data.status === 'DISABLED') parts.push('已停用');
    this.setData({ filterText: parts.length ? parts.join(' · ') : '全部用户' });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('GET', '/admin/users', {
        search: this.data.search, role: this.data.role, status: this.data.status, limit: 100,
      }, { silent: true });
      const roleText = { CUSTOMER: '客户', ENGINEER: '工程师' };
      this.setData({
        total: result.total,
        items: result.items.map((item) => ({
          ...item, roleText: roleText[item.role] || item.role,
          createdText: timeShort(item.createdAt),
          statusText: item.status === 'ACTIVE' ? '正常' : '已停用',
          roleBadgeClass: item.role === 'ENGINEER' ? 'badge-purple' : 'badge-blue',
          verifyText: item.verifyStatus === 'APPROVED' ? '资格已通过' : item.verifyStatus === 'PENDING' ? '资格待审核' : item.verifyStatus === 'REJECTED' ? '资格已驳回' : '',
          verifyBadgeClass: item.verifyStatus === 'APPROVED' ? 'badge-green' : item.verifyStatus === 'REJECTED' ? 'badge-red' : 'badge-orange',
        })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '用户加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  changeStatus(e) {
    const { id, status, name } = e.currentTarget.dataset;
    const next = status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    wx.showModal({
      title: next === 'DISABLED' ? '停用用户' : '恢复用户',
      content: `${next === 'DISABLED' ? '停用' : '恢复'}“${name || id}”的账号？`,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await request('PATCH', `/admin/users/${id}/status`, { status: next }, { silent: true });
          wx.showToast({ title: next === 'DISABLED' ? '已停用' : '已恢复', icon: 'success' });
          this.load();
        } catch (error) { wx.showToast({ title: error.message || '操作失败', icon: 'none' }); }
      },
    });
  },
  open(e) {
    const { id, role } = e.currentTarget.dataset;
    if (!id) return;
    const url = role === 'ENGINEER'
      ? `/admin/pages/engineer-detail/index?id=${id}`
      : `/admin/pages/user-detail/index?id=${id}`;
    wx.navigateTo({ url });
  },
});
