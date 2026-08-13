/**
 * 管理员：纠纷列表
 */
const { request } = require('../../../utils/request');
const { getAdmin, denyAndExit } = require('../../utils/admin');
const { timeShort, fenToYuan } = require('../../../utils/format');

const BADGE = { OPEN: 'badge-orange', RESOLVED: 'badge-green', CANCELLED: 'badge-gray' };
const REASON_ICON = { QUALITY: '📉', DELAY: '⏰', MISSING: '📭', PAYMENT: '💳', COMMUNICATION: '💬', OTHER: '📌' };

Page({
  data: { items: [], total: 0, loading: true, status: '', filterText: '全部纠纷' },
  onLoad() {
    if (!getAdmin()) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  setStatus(e) {
    const value = e.currentTarget.dataset.value;
    this.setData({ status: this.data.status === value ? '' : value }, () => { this.syncFilterText(); this.load(); });
  },
  syncFilterText() {
    const labels = { OPEN: '进行中', RESOLVED: '已结案', CANCELLED: '已取消' };
    this.setData({ filterText: labels[this.data.status] || '全部纠纷' });
  },
  async load() {
    this.setData({ loading: true });
    try {
      const result = await request('GET', '/admin/disputes', {
        status: this.data.status, limit: 100,
      }, { silent: true });
      this.setData({
        total: result.total,
        items: (result.items || []).map((item) => ({
          ...item,
          createdText: timeShort(item.createdAt),
          badgeClass: BADGE[item.status] || 'badge-gray',
          reasonIcon: REASON_ICON[item.reasonType] || '📌',
          refundText: item.refundAmountFen == null ? '—' : `¥${fenToYuan(item.refundAmountFen)}`,
          orderStatusText: item.order ? item.order.status : '',
          orderName: item.order ? item.order.projectName : '订单',
          orderNo: item.order ? item.order.orderNo : '',
          stageText: item.status === 'OPEN' ? (item.evidenceOpen ? '举证中' : '待仲裁') : item.statusText,
        })),
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '纠纷加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  open(e) { wx.navigateTo({ url: `/admin/pages/dispute-detail/index?id=${e.currentTarget.dataset.id}` }); },
});
