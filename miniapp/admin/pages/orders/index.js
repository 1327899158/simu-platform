const { request } = require('../../../utils/request');
const { getAdmin, denyAndExit } = require('../../utils/admin');
const { timeShort, fenToYuan } = require('../../../utils/format');

Page({
  data: { items: [], total: 0, loading: true, status: '', search: '', filterText: '全部订单' },
  onLoad() {
    if (!getAdmin()) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
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
    const labels = { QUOTING: '报价中', AWAITING_PAYMENT: '待支付', IN_PROGRESS: '执行中', DELIVERED: '待验收', COMPLETED: '已完成', CLOSED: '已关闭' };
    this.setData({ filterText: labels[this.data.status] || '全部订单' });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('GET', '/admin/orders', {
        status: this.data.status, search: this.data.search, limit: 100,
      }, { silent: true });
      const badge = { QUOTING: 'badge-blue', AWAITING_PAYMENT: 'badge-orange', IN_PROGRESS: 'badge-purple', DELIVERED: 'badge-orange', COMPLETED: 'badge-green', CLOSED: 'badge-gray' };
      this.setData({
        total: result.total,
        items: result.items.map((item) => ({
          ...item, amountText: fenToYuan(item.finalAmountFen == null ? item.budgetFen : item.finalAmountFen),
          createdText: timeShort(item.createdAt), badgeClass: badge[item.status] || 'badge-gray',
        })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '订单加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  open(e) { wx.navigateTo({ url: `/admin/pages/order-detail/index?id=${e.currentTarget.dataset.id}` }); },
});
