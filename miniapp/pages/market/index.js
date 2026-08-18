const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort } = require('../../utils/format');
const { isApproved, promptIdentity } = require('../../utils/identity');

Page({
  data: {
    directions: [],
    category: '',
    sort: 'latest',
    items: [],
    stats: { allCount: 0, todayCount: 0 },
    loading: false,
  },

  async onLoad() {
    let user = ensureLogin();
    if (!user) return;
    try { user = await request('GET', '/me', null, { silent: true }); wx.setStorageSync('user', user); } catch (_) {}
    if (user.role !== 'ENGINEER' || !isApproved(user)) {
      if (user.role === 'ENGINEER') promptIdentity('进入接单大厅', true);
      else {
        wx.showToast({ title: '仅工程师可以进入接单大厅', icon: 'none' });
        setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 500);
      }
      return;
    }
    try {
      const dicts = await request('GET', '/dicts', null, { silent: true });
      this.setData({ directions: dicts.directions || [] });
    } catch (e) {
      wx.showToast({ title: e.message || '分类加载失败', icon: 'none' });
    }
    this._ready = true;
    await this.load();
  },

  onShow() {
    const user = wx.getStorageSync('user') || {};
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar && tabBar.syncTabBar) tabBar.syncTabBar(user.role, '/pages/market/index');
    if (this._ready && !this.data.loading) this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  async load() {
    if (this.data.loading) {
      this._reloadPending = true;
      return;
    }
    this.setData({ loading: true });
    const params = { sort: this.data.sort, limit: 50 };
    if (this.data.category) params.direction = this.data.category;
    try {
      const data = await request('GET', '/market/orders', params);
      this.setData({
        stats: data.stats || { allCount: 0, todayCount: 0 },
        items: (data.items || []).map((order) => ({
          ...order,
          budgetY: fenToYuan(order.budgetFen),
          time: timeShort(order.createdAt),
          hotValue: Number(order.quoteCount || 0) + Number(order.viewCount || 0),
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '仿真大厅加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
      if (this._reloadPending) {
        this._reloadPending = false;
        this.load();
      }
    }
  },

  pickCategory(e) {
    const category = e.currentTarget.dataset.value || '';
    if (category === this.data.category) return;
    this.setData({ category }, () => this.load());
  },

  pickSort(e) {
    const sort = e.currentTarget.dataset.value;
    if (!['latest', 'hot'].includes(sort) || sort === this.data.sort) return;
    this.setData({ sort }, () => this.load());
  },

  open(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=market` });
  },

  quickQuote(e) {
    const { id, flexible, fen } = e.currentTarget.dataset;
    let url = `/pages/quote-form/index?orderId=${id}&flexible=${flexible}`;
    if (String(flexible) === '0' && fen) url += `&fixedFen=${fen}`;
    wx.navigateTo({ url });
  },
});
