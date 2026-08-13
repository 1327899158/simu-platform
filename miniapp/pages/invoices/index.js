const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');

Page({
  data: { items: [], loading: true, processingId: '' },
  onShow() { const user = ensureLogin(); if (user && user.role === 'ENGINEER') this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try { const data = await request('GET', '/invoices/mine'); this.setData({ items: data.items || [] }); }
    catch (error) { wx.showToast({ title: error.message || '加载失败', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  async process(e) {
    const { id, action } = e.currentTarget.dataset;
    if (!id || this.data.processingId) return;
    const prompt = action === 'SELF_ISSUE' ? '由你自行向客户开具发票。'
      : action === 'PLATFORM_REQUESTED' ? '将申请平台协助开票。平台开票可能收取服务费，具体费用由平台后续确认。'
        : action === 'ISSUED' ? '确认已完成开票？' : '确认暂不支持本次开票？';
    const confirmed = await new Promise((resolve) => wx.showModal({ title: '处理发票申请', content: prompt, confirmText: '确认', success: (r) => resolve(r.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    this.setData({ processingId: id });
    try { await request('POST', `/invoices/${id}/process`, { action }); wx.showToast({ title: '处理成功', icon: 'success' }); await this.load(); }
    catch (error) { wx.showToast({ title: error.message || '处理失败', icon: 'none' }); }
    finally { this.setData({ processingId: '' }); }
  },
  goOrder(e) { wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}&mode=market` }); },
});
