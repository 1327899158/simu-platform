const { request } = require('../../../utils/request');
const { getAdmin, denyAndExit } = require('../../utils/admin');
const { timeShort } = require('../../../utils/format');

const ACTION_TEXT = {
  USER_STATUS_UPDATE: '修改用户状态', ENGINEER_REVIEW: '审核身份认证', IDENTITY_REVIEW: '审核身份认证', ORDER_FORCE_CLOSE: '关闭订单',
};

Page({
  data: { items: [], total: 0, loading: true },
  onLoad() {
    if (!getAdmin()) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('GET', '/admin/audit-logs', { limit: 100 }, { silent: true });
      this.setData({
        total: result.total,
        items: result.items.map((item) => ({
          ...item, actionText: ACTION_TEXT[item.action] || item.action,
          createdText: timeShort(item.createdAt), detailText: this.detailText(item.detail),
        })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '日志加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  detailText(detail) {
    if (!detail || typeof detail !== 'object') return '';
    const parts = [];
    if (detail.from || detail.to) parts.push(`${detail.from || '—'} → ${detail.to || '—'}`);
    if (detail.reason) parts.push(`原因：${detail.reason}`);
    return parts.join('；');
  },
});
