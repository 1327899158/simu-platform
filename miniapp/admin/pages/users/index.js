const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { timeShort } = require('../../../utils/format');

Page({
  data: { items: [], total: 0, loading: true, search: '', role: '', status: '', canManage: false },
  onLoad() {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.setData({ canManage: hasPermission(admin, 'USER_STATUS_UPDATE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onSearchInput(e) { this.setData({ search: e.detail.value }); },
  search() { this.load(); },
  setRole(e) { this.setData({ role: e.currentTarget.dataset.value }); this.load(); },
  setStatus(e) { this.setData({ status: e.currentTarget.dataset.value }); this.load(); },
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
});
