const { request } = require('../../../utils/request');
const { getAdmin, denyAndExit } = require('../../utils/admin');

function addPercent(items) {
  const max = Math.max(1, ...items.map((item) => Number(item.count || 0)));
  return items.map((item) => ({ ...item, percent: Math.max(item.count ? 8 : 0, Math.round(Number(item.count || 0) / max * 100)) }));
}

Page({
  data: { loading: true, data: null, orderStates: [], verifyStates: [], ratingStates: [], trend: [] },
  onLoad() {
    if (!getAdmin()) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const data = await request('GET', '/admin/data-preview', null, { silent: true });
      const trendMax = Math.max(1, ...(data.trend || []).flatMap((row) => [row.users, row.orders, row.reviews]));
      this.setData({
        data,
        orderStates: addPercent(data.orderStates || []),
        verifyStates: addPercent(data.verifyStates || []),
        ratingStates: addPercent((data.ratingStates || []).map((item) => ({ ...item, label: `${item.score} 星` }))),
        trend: (data.trend || []).map((row) => ({
          ...row,
          userHeight: Math.max(row.users ? 12 : 2, Math.round(row.users / trendMax * 120)),
          orderHeight: Math.max(row.orders ? 12 : 2, Math.round(row.orders / trendMax * 120)),
          reviewHeight: Math.max(row.reviews ? 12 : 2, Math.round(row.reviews / trendMax * 120)),
        })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '数据加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
});
