const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');
const TABS = [
  { key: '', label: '全部' }, { key: 'QUOTING', label: '待报价' },
  { key: 'AWAITING_PAYMENT', label: '待支付' }, { key: 'IN_PROGRESS', label: '执行中' },
  { key: 'DELIVERED', label: '待验收' }, { key: 'COMPLETED', label: '已完成' },
];
Page({
  data: { tabs: TABS, tab: '', currentLabel: '全部', filterOpen: false, items: [] },
  onShow() { if (ensureLogin()) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  toggleFilter() { this.setData({ filterOpen: !this.data.filterOpen }); },
  pickTab(e) {
    const key = e.currentTarget.dataset.key;
    const t = TABS.find((x) => x.key === key);
    this.setData({ tab: key, currentLabel: t ? t.label : '全部', filterOpen: false }, () => this.load());
  },
  async load() {
    let data;
    try {
      data = await request('GET', '/orders/mine', this.data.tab ? { status: this.data.tab } : {});
    } catch (e) {
      wx.showToast({ title: e.message || '订单加载失败', icon: 'none' });
      return;
    }
    this.setData({
      items: data.items.map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
        cls: STATUS_CLASS[o.status] || 'st-gray',
        softwareText: (o.softwareTags || []).join('、'),
        directionText: (o.directionTags || []).join('、'),
      })),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=customer` }); },
  gotoPublish() { wx.navigateTo({ url: '/pages/publish/index' }); },
});
