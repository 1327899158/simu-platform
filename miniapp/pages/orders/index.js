const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');
const TABS = [
  { key: '', label: '全部' }, { key: 'QUOTING', label: '待报价' },
  { key: 'AWAITING_PAYMENT', label: '待支付' }, { key: 'IN_PROGRESS', label: '执行中' },
  { key: 'DELIVERED', label: '待验收' }, { key: 'COMPLETED', label: '已完成' },
];
Page({
  data: { tabs: TABS, tab: '', items: [] },
  onShow() { if (ensureLogin()) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.key }, () => this.load()); },
  async load() {
    const data = await request('GET', '/orders/mine', this.data.tab ? { status: this.data.tab } : {});
    this.setData({
      items: data.items.map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
        cls: STATUS_CLASS[o.status] || 'st-gray',
      })),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=customer` }); },
});
