const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');
const TABS = [
  { key: '', countKey: 'ALL', label: '全部', dotCls: 'dot-purple' },
  { key: 'QUOTING', countKey: 'QUOTING', label: '待报价', dotCls: 'dot-blue' },
  { key: 'AWAITING_PAYMENT', countKey: 'AWAITING_PAYMENT', label: '待支付', dotCls: 'dot-orange' },
  { key: 'IN_PROGRESS', countKey: 'IN_PROGRESS', label: '执行中', dotCls: 'dot-cyan' },
  { key: 'DELIVERED', countKey: 'DELIVERED', label: '待验收', dotCls: 'dot-pink' },
  { key: 'COMPLETED', countKey: 'COMPLETED', label: '已完成', dotCls: 'dot-green' },
];
Page({
  data: { tabs: TABS, tab: '', currentLabel: '全部', currentDotCls: 'dot-purple', currentCount: 0, filterOpen: false, items: [] },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    if (user.role !== 'CUSTOMER') {
      wx.showToast({ title: '仅客户可以查看我的订单', icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }), 500);
      return;
    }
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  toggleFilter() { this.setData({ filterOpen: !this.data.filterOpen }); },
  pickTab(e) {
    const key = e.currentTarget.dataset.key;
    const t = this.data.tabs.find((x) => x.key === key);
    this.setData({
      tab: key,
      currentLabel: t ? t.label : '全部',
      currentDotCls: t ? t.dotCls : 'dot-purple',
      currentCount: t ? Number(t.count || 0) : 0,
      filterOpen: false,
    }, () => this.load());
  },
  async load() {
    let data;
    try {
      data = await request('GET', '/orders/mine', this.data.tab ? { status: this.data.tab } : {});
    } catch (e) {
      wx.showToast({ title: e.message || '订单加载失败', icon: 'none' });
      return;
    }
    const counts = data.counts || {};
    const tabs = TABS.map((item) => ({ ...item, count: Number(counts[item.countKey] || 0) }));
    const current = tabs.find((item) => item.key === this.data.tab) || tabs[0];
    this.setData({
      tabs,
      currentDotCls: current.dotCls,
      currentCount: current.count,
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
