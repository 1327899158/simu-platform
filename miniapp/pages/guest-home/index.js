const { request } = require('../../utils/request');

// 游客首页仅展示平台能力；操作入口统一引导至登录。
Page({
  data: {
    activeBanner: 0,
    banners: [
      { theme: 'release', title: '快速发布需求', desc: '3 分钟完成发布，极速响应', icon: '🚀', action: '立即发布需求' },
      { theme: 'engineer', title: '匹配专业工程师', desc: '多领域工程师，为项目保驾护航', icon: '🧑‍🔬', action: '查看工程师服务' },
      { theme: 'secure', title: '全流程安心协作', desc: '报价透明、数据保护、交付可追溯', icon: '🛡️', action: '立即体验平台' },
    ],
    stats: {
      approvedEngineers: '—',
      completedOrders: '—',
      allOrders: '—',
      activeProjects: '—',
      openOrders: '—',
      quoteCount: '—',
      customerCount: '—',
      totalViews: '—',
      satisfaction: '—',
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
      const score = Number(result.averageReview || 0);
      this.setData({
        stats: {
          approvedEngineers: countText(result.approvedEngineers),
          completedOrders: countText(result.completedOrders),
          allOrders: countText(result.allOrders),
          activeProjects: countText(result.activeProjects),
          openOrders: countText(result.openOrders),
          quoteCount: countText(result.quoteCount),
          customerCount: countText(result.customerCount),
          totalViews: countText(result.totalViews),
          satisfaction: result.reviewCount && score ? `${Math.round(score / 5 * 100)}%` : '—',
        },
      });
    } catch (e) {
      // 服务端统计接口尚不可用时保留“—”，避免将演示数字误认为真实数据。
      console.warn('[guest-home] 统计数据加载失败：', e && (e.message || e.errMsg || e));
    } finally {
      this._loadingStats = false;
    }
  },

  onBannerChange(e) {
    this.setData({ activeBanner: e.detail.current });
  },

  goLogin() {
    wx.reLaunch({ url: '/pages/login/index' });
  },

  goTab(e) {
    const page = e.currentTarget.dataset.page;
    if (!page || page === 'home') return;
    wx.redirectTo({ url: `/pages/guest-${page}/index` });
  },
});
