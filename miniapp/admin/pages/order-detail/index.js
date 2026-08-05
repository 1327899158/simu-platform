const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { timeShort, fenToYuan } = require('../../../utils/format');

Page({
  data: { id: '', order: null, loading: true, canClose: false },
  onLoad(options) {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    if (!options.id) { wx.showToast({ title: '缺少订单ID', icon: 'none' }); return; }
    this.setData({ id: options.id, canClose: hasPermission(admin, 'ORDER_FORCE_CLOSE') });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const order = await request('GET', `/admin/orders/${this.data.id}`, null, { silent: true });
      const badge = { QUOTING: 'badge-blue', AWAITING_PAYMENT: 'badge-orange', IN_PROGRESS: 'badge-purple', DELIVERED: 'badge-orange', COMPLETED: 'badge-green', CLOSED: 'badge-gray' };
      this.setData({ order: {
        ...order,
        budgetText: fenToYuan(order.budgetFen), finalText: fenToYuan(order.finalAmountFen),
        selectedText: fenToYuan(order.selectedAmountFen), createdText: timeShort(order.createdAt),
        badgeClass: badge[order.status] || 'badge-gray',
        files: (order.files || []).map((f) => ({ ...f, sizeText: f.sizeBytes ? `${(f.sizeBytes / 1024 / 1024).toFixed(2)} MB` : '大小未知' })),
      } });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '订单加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  closeOrder() {
    wx.showModal({
      title: '关闭待报价订单', editable: true, placeholderText: '请输入关闭原因（至少2个字）',
      content: '关闭后，所有待确认报价将失效。支付或履约中的订单不能在此关闭。',
      success: async (result) => {
        if (!result.confirm) return;
        const reason = String(result.content || '').trim();
        if (reason.length < 2) { wx.showToast({ title: '请填写关闭原因', icon: 'none' }); return; }
        try {
          await request('POST', `/admin/orders/${this.data.id}/close`, { reason }, { silent: true });
          wx.showToast({ title: '订单已关闭', icon: 'success' });
          this.load();
        } catch (error) { wx.showToast({ title: error.message || '关闭失败', icon: 'none' }); }
      },
    });
  },
});
