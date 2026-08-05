const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');

Page({
  data: { loading: true, summary: { averageScore: null, reviewCount: 0 }, items: [] },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    if (user.role !== 'ENGINEER') {
      wx.showToast({ title: '仅工程师可查看我的评价', icon: 'none' });
      wx.navigateBack();
      return;
    }
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    try {
      const data = await request('GET', '/engineers/me/reviews');
      this.setData({
        summary: { averageScore: data.averageScore, reviewCount: data.reviewCount || 0 },
        items: (data.items || []).map((item) => ({
          ...item,
          scoreText: item.averageScore ? item.averageScore.toFixed(1) : '0.0',
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '评价加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
  goOrder(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/order-detail/index?id=${id}&mode=market` });
  },
});
