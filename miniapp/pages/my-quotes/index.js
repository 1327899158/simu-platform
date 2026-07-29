const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort } = require('../../utils/format');

// 报价状态标签
const QUOTE_STATUS_TEXT = { PENDING: '待确认', SELECTED: '已选中', REJECTED: '未选中', WITHDRAWN: '已撤回' };
// 订单状态 → 额外徽标（覆盖报价状态，更有意义）
const ORDER_STATUS_BADGE = { IN_PROGRESS: '执行中', DELIVERED: '已交付', COMPLETED: '已完成', CLOSED: '已关闭' };

const TABS = [
  { key: '', label: '全部' },
  { key: 'PENDING', label: '待确认' },
  { key: 'SELECTED', label: '已选中' },
  { key: 'DELIVERED', label: '已交付' },   // 按订单状态筛选
  { key: 'COMPLETED', label: '已完成' },   // 按订单状态筛选
  { key: 'REJECTED', label: '未选中' },
  { key: 'WITHDRAWN', label: '已撤回' },
];

// 订单状态 badge 对应的 CSS class
const BADGE_CLASS = {
  PENDING: 'st-blue', SELECTED: 'st-cyan', REJECTED: 'st-gray', WITHDRAWN: 'st-gray',
  IN_PROGRESS: 'st-cyan', DELIVERED: 'st-purple', COMPLETED: 'st-green', CLOSED: 'st-gray',
};

Page({
  data: { tabs: TABS, tab: '', currentLabel: '全部', filterOpen: false, items: [] },
  onShow() { if (ensureLogin()) this.load(); },
  toggleFilter() { this.setData({ filterOpen: !this.data.filterOpen }); },
  pickTab(e) {
    const key = e.currentTarget.dataset.key;
    const t = TABS.find((x) => x.key === key);
    this.setData({ tab: key, currentLabel: t ? t.label : '全部', filterOpen: false }, () => this.load());
  },
  async load() {
    const tab = this.data.tab;
    // 已交付/已完成是按订单状态筛，不传 status（quote status 里没有这两个值）
    const orderStatusFilter = tab === 'DELIVERED' || tab === 'COMPLETED' ? tab : null;
    const quoteStatusFilter = !orderStatusFilter && tab ? tab : null;
    const raw = await request('GET', '/quotes/mine', quoteStatusFilter ? { status: quoteStatusFilter } : {});
    let items = raw;
    // 客户端二次过滤：按订单状态
    if (orderStatusFilter) {
      items = items.filter((x) => x.order && x.order.status === orderStatusFilter);
    }
    this.setData({
      items: items.map((x) => {
        const orderStatus = x.order && x.order.status;
        // 优先用订单状态（已交付/已完成/执行中）作为徽标，否则用报价状态
        const badgeKey = ORDER_STATUS_BADGE[orderStatus] ? orderStatus : x.status;
        return {
          ...x,
          amountY: fenToYuan(x.amountFen),
          time: timeShort(x.updatedAt),
          badgeText: ORDER_STATUS_BADGE[orderStatus] || QUOTE_STATUS_TEXT[x.status] || x.status,
          badgeCls: BADGE_CLASS[badgeKey] || 'st-gray',
        };
      }),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.oid}&mode=market` }); },
});
