const { request } = require('../../../utils/request');
const { loadAdmin, hasPermission, denyAndExit } = require('../../utils/admin');

const filters = [
  { key: '', text: '全部' }, { key: 'REQUESTED', text: '待处理' }, { key: 'SELF_ISSUE', text: '自行开票中' },
  { key: 'PLATFORM_REQUESTED', text: '平台开票' }, { key: 'ISSUED', text: '已完成' }, { key: 'REJECTED', text: '不支持' },
];

Page({
  data: { items: [], filters, status: '', loading: true },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const admin = await loadAdmin();
      if (!hasPermission(admin, 'INVOICE_READ')) return denyAndExit('没有查看发票管理的权限');
      const suffix = this.data.status ? `?status=${this.data.status}` : '';
      const data = await request('GET', `/admin/invoices${suffix}`, null, { silent: true });
      this.setData({ items: data.items || [] });
    } catch (error) { wx.showToast({ title: error.message || '加载失败', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  select(e) { const status = e.currentTarget.dataset.status; this.setData({ status }); this.load(); },
});
