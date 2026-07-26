const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { fenToYuan, timeShort } = require('../../utils/format');
const TABS = [
  { key: '', label: '全部' }, { key: 'PENDING', label: '待确认' },
  { key: 'SELECTED', label: '已选中' }, { key: 'REJECTED', label: '未选中' },
  { key: 'WITHDRAWN', label: '已撤回' },
];
Page({
  data: { tabs: TABS, tab: '', items: [] },
  onShow() { if (ensureLogin()) this.load(); },
  switchTab(e) { this.setData({ tab: e.currentTarget.dataset.key }, () => this.load()); },
  async load() {
    const data = await request('GET', '/quotes/mine', this.data.tab ? { status: this.data.tab } : {});
    this.setData({
      items: data.map((x) => ({ ...x, amountY: fenToYuan(x.amountFen), time: timeShort(x.updatedAt) })),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.oid}&mode=market` }); },
});
