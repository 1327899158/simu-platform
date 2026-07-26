/** 首页：按角色分流 —— 客户（发布入口+最近订单）/ 工程师（抢单大厅+筛选）。 */
const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');

Page({
  data: {
    role: '',
    // 客户
    recent: [],
    counts: { QUOTING: 0, AWAITING_PAYMENT: 0, IN_PROGRESS: 0, DELIVERED: 0 },
    // 工程师
    dicts: null,
    fDirection: '',
    fSoftware: '',
    hall: [],
  },
  async onShow() {
    const user = ensureLogin();
    if (!user) return;
    this.setData({ role: user.role });
    if (!this.data.dicts) {
      try { this.setData({ dicts: await request('GET', '/dicts', null, { silent: true }) }); } catch (e) {}
    }
    user.role === 'ENGINEER' ? this.loadHall() : this.loadCustomer();
  },
  onPullDownRefresh() {
    const p = this.data.role === 'ENGINEER' ? this.loadHall() : this.loadCustomer();
    p.finally(() => wx.stopPullDownRefresh());
  },

  // ---------- 客户 ----------
  async loadCustomer() {
    const data = await request('GET', '/orders/mine', { limit: 20 });
    const counts = { QUOTING: 0, AWAITING_PAYMENT: 0, IN_PROGRESS: 0, DELIVERED: 0 };
    data.items.forEach((o) => { if (counts[o.status] !== undefined) counts[o.status] += 1; });
    this.setData({
      counts,
      recent: data.items.slice(0, 5).map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
        cls: STATUS_CLASS[o.status] || 'st-gray',
      })),
    });
  },
  goPublish() { wx.navigateTo({ url: '/pages/publish/index' }); },
  goOrders() { wx.navigateTo({ url: '/pages/orders/index' }); },

  // ---------- 工程师 ----------
  async loadHall() {
    const params = {};
    if (this.data.fDirection) params.direction = this.data.fDirection;
    if (this.data.fSoftware) params.software = this.data.fSoftware;
    const data = await request('GET', '/market/orders', params);
    this.setData({
      hall: data.items.map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
      })),
    });
  },
  pickDirection(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ fDirection: this.data.fDirection === v ? '' : v }, () => this.loadHall());
  },
  pickSoftware(e) {
    const v = e.currentTarget.dataset.v;
    this.setData({ fSoftware: this.data.fSoftware === v ? '' : v }, () => this.loadHall());
  },
  goMyQuotes() { wx.navigateTo({ url: '/pages/my-quotes/index' }); },
  openMarket(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=market` });
  },
  openMine(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=customer` });
  },
});
