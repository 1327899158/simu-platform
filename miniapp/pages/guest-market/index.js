const { request } = require('../../utils/request');

// 游客大厅展示机会与平台价值；涉及详情、筛选和报价的动作统一引导登录。
Page({
  data: {
    stats: {
      openOrders: '—',
      allOrders: '—',
      approvedEngineers: '—',
      quoteCount: '—',
    },
  },

  onShow() {
    this.loadPublicStats();
  },

  async loadPublicStats() {
    if (this._loadingStats) return;
    this._loadingStats = true;
    try {
      const result = await request('GET', '/guest/stats', null, { silent: true });
      const countText = (value) => Number(value || 0).toLocaleString('en-US');
      this.setData({
        stats: {
          openOrders: countText(result.openOrders),
          allOrders: countText(result.allOrders),
          approvedEngineers: countText(result.approvedEngineers),
          quoteCount: countText(result.quoteCount),
        },
      });
    } catch (e) {
      console.warn('[guest-market] 统计数据加载失败：', e && (e.message || e.errMsg || e));
    } finally {
      this._loadingStats = false;
    }
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  goTab(e) {
    const page = e.currentTarget.dataset.page;
    if (!page || page === 'market') return;
    wx.redirectTo({ url: `/pages/guest-${page}/index` });
  },
});
