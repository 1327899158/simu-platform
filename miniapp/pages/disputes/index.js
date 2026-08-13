/**
 * 我的纠纷列表（当事人）。
 */
const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { timeShort } = require('../../utils/format');

const TABS = [
  { key: '', label: '全部', dotCls: 'dot-purple' },
  { key: 'OPEN', label: '进行中', dotCls: 'dot-orange' },
  { key: 'RESOLVED', label: '已结案', dotCls: 'dot-green' },
  { key: 'CANCELLED', label: '已取消', dotCls: 'dot-gray' },
];

const BADGE = {
  OPEN: 'st-orange', RESOLVED: 'st-green', CANCELLED: 'st-gray',
};

Page({
  data: {
    tabs: TABS, tab: '',
    currentLabel: '全部', currentDotCls: 'dot-purple',
    items: [], loading: true,
  },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    this.load();
  },
  pickTab(e) {
    const key = e.currentTarget.dataset.key;
    const t = TABS.find((x) => x.key === key) || TABS[0];
    this.setData({
      tab: key,
      currentLabel: t.label,
      currentDotCls: t.dotCls,
    }, () => this.load());
  },
  async load() {
    this.setData({ loading: true });
    try {
      const items = await request('GET', '/disputes/mine', this.data.tab ? { status: this.data.tab } : {});
      this.setData({
        items: (items || []).map((d) => ({
          ...d,
          time: timeShort(d.createdAt),
          badgeCls: BADGE[d.status] || 'st-gray',
          statusText: d.statusText,
          orderName: d.order ? d.order.projectName : '订单',
          orderNo: d.order ? d.order.orderNo : '',
        })),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '纠纷加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },
  open(e) { wx.navigateTo({ url: `/pages/dispute-detail/index?id=${e.currentTarget.dataset.id}` }); },
});
