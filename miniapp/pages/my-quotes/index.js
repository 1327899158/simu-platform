const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort } = require('../../utils/format');

// 报价状态标签
const QUOTE_STATUS_TEXT = { PENDING: '待确认', SELECTED: '已选中', REJECTED: '未选中', WITHDRAWN: '已撤回' };
// 订单状态 → 额外徽标（覆盖报价状态，更有意义）
const ORDER_STATUS_BADGE = { IN_PROGRESS: '执行中', DELIVERED: '已交付', COMPLETED: '已完成', REFUND_PENDING: '退款确认中', CLOSED: '已关闭', CANCELLED: '已取消' };

const TABS = [
  { key: '', countKey: 'ALL', label: '全部', dotCls: 'dot-purple' },
  { key: 'PENDING', countKey: 'PENDING', label: '待确认', dotCls: 'dot-blue' },
  { key: 'SELECTED', countKey: 'SELECTED', label: '已选中', dotCls: 'dot-cyan' },
  { key: 'DELIVERED', countKey: 'DELIVERED', label: '已交付', dotCls: 'dot-pink' },
  { key: 'COMPLETED', countKey: 'COMPLETED', label: '已完成', dotCls: 'dot-green' },
  { key: 'REFUND_PENDING', countKey: 'REFUND_PENDING', label: '退款确认', dotCls: 'dot-orange' },
  { key: 'CANCELLED', countKey: 'CANCELLED', label: '已取消', dotCls: 'dot-gray' },
  { key: 'REJECTED', countKey: 'REJECTED', label: '未选中', dotCls: 'dot-red' },
  { key: 'WITHDRAWN', countKey: 'WITHDRAWN', label: '已撤回', dotCls: 'dot-gray' },
];

// 订单状态 badge 对应的 CSS class
const BADGE_CLASS = {
  PENDING: 'st-blue', SELECTED: 'st-cyan', REJECTED: 'st-gray', WITHDRAWN: 'st-gray',
  IN_PROGRESS: 'st-cyan', DELIVERED: 'st-purple', COMPLETED: 'st-green', REFUND_PENDING: 'st-orange', CLOSED: 'st-gray', CANCELLED: 'st-gray',
};

Page({
  data: { tabs: TABS, tab: '', currentLabel: '全部', currentDotCls: 'dot-purple', currentCount: 0, items: [] },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    if (user.role !== 'ENGINEER') {
      wx.showToast({ title: '仅工程师可以查看我的报价', icon: 'none' });
      setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) }), 500);
      return;
    }
    this.load();
  },
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
    const tab = this.data.tab;
    // 履约、退款确认和结束状态按订单状态筛，不传 status（报价状态里没有这些值）
    const orderStatusFilter = ['DELIVERED', 'COMPLETED', 'REFUND_PENDING', 'CANCELLED'].includes(tab) ? tab : null;
    const quoteStatusFilter = !orderStatusFilter && tab ? tab : null;
    let raw;
    try {
      raw = await request('GET', '/quotes/mine', quoteStatusFilter
        ? { status: quoteStatusFilter, includeCounts: '1' }
        : { includeCounts: '1' });
    } catch (e) {
      wx.showToast({ title: e.message || '报价加载失败', icon: 'none' });
      return;
    }
    const payload = Array.isArray(raw) ? { items: raw, counts: {} } : raw;
    const counts = payload.counts || {};
    const tabs = TABS.map((item) => ({ ...item, count: Number(counts[item.countKey] || 0) }));
    const current = tabs.find((item) => item.key === tab) || tabs[0];
    let items = payload.items || [];
    // 客户端二次过滤：按订单状态
    if (orderStatusFilter) {
      items = items.filter((x) => x.status === 'SELECTED' && x.order && x.order.status === orderStatusFilter);
    }
    this.setData({
      tabs,
      currentDotCls: current.dotCls,
      currentCount: current.count,
      items: items.map((x) => {
        const orderStatus = x.order && x.order.status;
        // 优先用订单状态（已交付/已完成/执行中）作为徽标，否则用报价状态
        const meaningfulOrderStatus = x.status === 'SELECTED' && ORDER_STATUS_BADGE[orderStatus];
        const badgeKey = meaningfulOrderStatus ? orderStatus : x.status;
        return {
          ...x,
          amountY: fenToYuan(x.amountFen),
          time: timeShort(x.updatedAt),
          badgeText: meaningfulOrderStatus || QUOTE_STATUS_TEXT[x.status] || x.status,
          badgeCls: BADGE_CLASS[badgeKey] || 'st-gray',
        };
      }),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.oid}&mode=market` }); },
  // 撤回报价（后端支持：仅 PENDING 状态可撤回）
  withdraw(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '撤回报价',
      content: '撤回后该报价将不再参与此需求竞争，确定撤回吗？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request('DELETE', `/quotes/${id}`);
          wx.showToast({ title: '已撤回', icon: 'success' });
          this.load();
        } catch (err2) {
          wx.showToast({ title: err2.message || '撤回失败', icon: 'none' });
        }
      },
    });
  },
  gotoMarket() { wx.switchTab({ url: '/pages/home/index' }); },
});
