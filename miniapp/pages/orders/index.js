const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');
const TABS = [
  { key: '', countKey: 'ALL', label: '全部', dotCls: 'dot-purple' },
  { key: 'UNQUOTED', countKey: 'UNQUOTED', label: '未报价', dotCls: 'dot-blue' },
  { key: 'AWAITING_CONFIRMATION', countKey: 'AWAITING_CONFIRMATION', label: '待确认', dotCls: 'dot-pink' },
  { key: 'AWAITING_PAYMENT', countKey: 'AWAITING_PAYMENT', label: '待支付', dotCls: 'dot-orange' },
  { key: 'IN_PROGRESS', countKey: 'IN_PROGRESS', label: '执行中', dotCls: 'dot-cyan' },
  { key: 'DELIVERED', countKey: 'DELIVERED', label: '待验收', dotCls: 'dot-pink' },
  { key: 'COMPLETED', countKey: 'COMPLETED', label: '已完成', dotCls: 'dot-green' },
  { key: 'REFUND_PENDING', countKey: 'REFUND_PENDING', label: '退款确认', dotCls: 'dot-orange' },
  { key: 'CANCELLED', countKey: 'CANCELLED', label: '已取消', dotCls: 'dot-gray' },
];
Page({
  data: { tabs: TABS, tab: '', currentLabel: '全部', currentDotCls: 'dot-purple', currentCount: 0, items: [] },
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
  pickTab(e) {
    const key = e.currentTarget.dataset.key;
    const t = this.data.tabs.find((x) => x.key === key);
    this.setData({
      tab: key,
      currentLabel: t ? t.label : '全部',
      currentDotCls: t ? t.dotCls : 'dot-purple',
      currentCount: t ? Number(t.count || 0) : 0,
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
    // 直接进入此页也视为已查看订单变更，避免红点只在首页入口才能消除。
    request('POST', '/orders/mine/mark-read', null, { silent: true }).catch(() => {});
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=customer` }); },
  gotoPublish() { wx.navigateTo({ url: '/pages/publish/index' }); },
});
