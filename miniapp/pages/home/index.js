/** 首页：按角色分流 —— 客户（发布入口+最近订单）/ 工程师（可接需求预览）。 */
const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');
const { isApproved, promptIdentity } = require('../../utils/identity');

Page({
  data: {
    role: '',
    user: null,
    canTakeOrders: false,
    // 客户
    recent: [],
    counts: { UNQUOTED: 0, AWAITING_CONFIRMATION: 0, AWAITING_PAYMENT: 0, IN_PROGRESS: 0, DELIVERED: 0 },
    unreadOrderCount: 0,
    // 工程师
    hall: [],
  },
  async onShow() {
    let user = ensureLogin();
    if (!user) return;
    try {
      user = await request('GET', '/me', null, { silent: true });
      wx.setStorageSync('user', user);
    } catch (_) {}
    const canTakeOrders = user.role === 'ENGINEER' && isApproved(user);
    this.setData({
      role: user.role,
      user,
      canTakeOrders,
    });
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar && tabBar.syncTabBar) tabBar.syncTabBar(user.role, '/pages/home/index');
    if (user.role === 'ENGINEER') {
      if (canTakeOrders) this.loadHall();
      else this.setData({ hall: [] });
    } else {
      this.loadCustomer();
    }
  },
  onPullDownRefresh() {
    const p = this.data.role === 'ENGINEER'
      ? (this.data.canTakeOrders ? this.loadHall() : Promise.resolve())
      : this.loadCustomer();
    p.finally(() => wx.stopPullDownRefresh());
  },

  // ---------- 客户 ----------
  async loadCustomer() {
    let data;
    try { data = await request('GET', '/orders/mine', { limit: 20 }); }
    catch (e) { wx.showToast({ title: e.message || '订单加载失败', icon: 'none' }); return; }
    const counts = { UNQUOTED: 0, AWAITING_CONFIRMATION: 0, AWAITING_PAYMENT: 0, IN_PROGRESS: 0, DELIVERED: 0, ...(data.counts || {}) };
    this.setData({
      counts,
      unreadOrderCount: Number(data.unreadCount || 0),
      recent: data.items.slice(0, 5).map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
        cls: STATUS_CLASS[o.status] || 'st-gray',
      })),
    });
  },
  goPublish() {
    if (this.data.role !== 'CUSTOMER') return wx.showToast({ title: '仅客户可以发布需求', icon: 'none' });
    if (!isApproved(this.data.user)) return promptIdentity('发布需求');
    wx.navigateTo({ url: '/pages/publish/index' });
  },
  async goOrders() {
    if (this.data.role !== 'CUSTOMER') return wx.showToast({ title: '仅客户可以查看我的订单', icon: 'none' });
    if (this.data.unreadOrderCount) {
      this.setData({ unreadOrderCount: 0 });
      request('POST', '/orders/mine/mark-read', null, { silent: true }).catch(() => {});
    }
    wx.navigateTo({ url: '/pages/orders/index' });
  },
  goMessages() { wx.switchTab({ url: '/pages/chat-list/index' }); },
  goMe() { wx.switchTab({ url: '/pages/me/index' }); },
  goProfile() { wx.navigateTo({ url: '/pages/profile-edit/index' }); },

  // ---------- 工程师 ----------
  async loadHall() {
    if (!this.data.canTakeOrders) return;
    const params = { limit: 5 };
    let data;
    try { data = await request('GET', '/market/orders', params); }
    catch (e) { wx.showToast({ title: e.message || '抢单大厅加载失败', icon: 'none' }); return; }
    this.setData({
      hall: data.items.map((o) => ({
        ...o, budgetY: fenToYuan(o.budgetFen), time: timeShort(o.createdAt),
      })),
    });
  },
  goMyQuotes() { wx.navigateTo({ url: '/pages/my-quotes/index' }); },
  goMarketHall() {
    if (this.data.role !== 'ENGINEER') return wx.showToast({ title: '仅工程师可以进入接单大厅', icon: 'none' });
    if (!this.data.canTakeOrders) return promptIdentity('进入接单大厅');
    wx.switchTab({ url: '/pages/market/index' });
  },
  // 大厅卡片上的快捷报价：与 order-detail 的 goQuote 参数格式保持一致
  quickQuote(e) {
    if (!this.data.canTakeOrders) return promptIdentity('报价');
    const { id, flexible, fen } = e.currentTarget.dataset;
    let url = `/pages/quote-form/index?orderId=${id}&flexible=${flexible}`;
    if (String(flexible) === '0' && fen) url += `&fixedFen=${fen}`;
    wx.navigateTo({ url });
  },
  openMarket(e) {
    if (!this.data.canTakeOrders) return promptIdentity('查看可接需求');
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=market` });
  },
  openMine(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=customer` });
  },
});
