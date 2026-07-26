/**
 * 订单详情（双角色合一）：
 *  mode=customer 客户视角：报价对比/选标/模拟支付/验收确认/驳回
 *  mode=market   工程师视角：需求详情/报价/交付
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { BASE_URL } = require('../../utils/config');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');

const ORIGIN = BASE_URL.replace(/\/api$/, '');

Page({
  data: {
    id: '', mode: 'customer', role: '',
    order: null, quotes: [], files: [],
    paying: false, delivering: false,
  },
  onLoad(q) { this.setData({ id: q.id, mode: q.mode || 'customer' }); },
  onShow() {
    const user = ensureLogin();
    if (!user) return;
    this.setData({ role: user.role });
    this.load();
  },
  async load() {
    const { id, mode } = this.data;
    const url = mode === 'market' ? `/market/orders/${id}` : `/orders/${id}`;
    const order = await request('GET', url);
    order.budgetY = fenToYuan(order.budgetFen);
    order.finalY = fenToYuan(order.finalAmountFen);
    order.time = timeShort(order.createdAt);
    order.cls = STATUS_CLASS[order.status] || 'st-gray';
    this.setData({ order });

    // 文件列表（无权限时静默忽略）
    try {
      const files = await request('GET', `/orders/${id}/files`, null, { silent: true });
      this.setData({
        files: files.map((f) => ({ ...f, sizeText: (f.sizeBytes / 1024 / 1024).toFixed(2) + 'MB' })),
      });
    } catch (e) { this.setData({ files: [] }); }

    // 客户在报价阶段拉全部报价
    if (this.data.mode === 'customer' && ['QUOTING', 'AWAITING_PAYMENT'].includes(order.status)) {
      const quotes = await request('GET', `/orders/${id}/quotes`);
      this.setData({
        quotes: quotes.map((x) => ({ ...x, amountY: fenToYuan(x.amountFen) })),
      });
    }
  },

  // ---------- 通用 ----------
  async download(e) {
    const fid = e.currentTarget.dataset.id;
    try {
      const info = await request('GET', `/files/${fid}/url`);
      wx.showLoading({ title: '下载中…' });
      wx.downloadFile({
        url: ORIGIN + info.url,
        success(res) {
          wx.hideLoading();
          if (res.statusCode !== 200) return wx.showToast({ title: '下载失败', icon: 'none' });
          wx.openDocument({
            filePath: res.tempFilePath,
            showMenu: true,
            fail: () => wx.showToast({ title: `已下载：${info.name}`, icon: 'none' }),
          });
        },
        fail() { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }); },
      });
    } catch (err) {}
  },
  async goChat() {
    try {
      const c = await request('GET', `/conversations/by-order/${this.data.id}`);
      wx.navigateTo({ url: `/pages/chat-room/index?id=${c.id}` });
    } catch (e) {}
  },

  // ---------- 客户操作 ----------
  del() {
    wx.showModal({
      title: '删除订单', content: '仅待报价状态可删除，删除后不可恢复',
      success: async (r) => {
        if (!r.confirm) return;
        await request('DELETE', `/orders/${this.data.id}`);
        wx.navigateBack();
      },
    });
  },
  select(e) {
    const q = e.currentTarget.dataset;
    wx.showModal({
      title: '选择该工程师',
      content: `${q.nick} · ¥${q.amounty} · ${q.days}天，选定后进入支付`,
      success: async (r) => {
        if (!r.confirm) return;
        await request('POST', `/orders/${this.data.id}/select-quote`, { quoteId: q.id });
        this.load();
      },
    });
  },
  async pay() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      const p = await request('POST', `/orders/${this.data.id}/pay`);
      // Mock 收银台：真实通道此处改为 wx.requestPayment(五参数)
      wx.showModal({
        title: '模拟收银台（演示）',
        content: `支付金额：¥${fenToYuan(p.amountFen)}\n单号：${p.outTradeNo}`,
        confirmText: '确认支付',
        success: async (r) => {
          if (r.confirm) {
            await request('POST', '/payments/mock-notify', { outTradeNo: p.outTradeNo }, { noAuth: true });
            // 轮询确认落账（与真实支付后的处理一致）
            for (let i = 0; i < 5; i++) {
              const st = await request('GET', `/orders/${this.data.id}/payment`, null, { silent: true });
              if (st.orderStatus === 'IN_PROGRESS') break;
              await new Promise((rs) => setTimeout(rs, 500));
            }
            wx.showToast({ title: '支付成功', icon: 'success' });
            this.load();
          }
          this.setData({ paying: false });
        },
      });
    } catch (e) { this.setData({ paying: false }); }
  },
  confirmDone() {
    wx.showModal({
      title: '确认验收', content: '确认成果符合要求并完成订单？',
      success: async (r) => {
        if (!r.confirm) return;
        await request('POST', `/orders/${this.data.id}/confirm`);
        wx.showToast({ title: '订单已完成', icon: 'success' });
        this.load();
      },
    });
  },
  rejectDelivery() {
    const that = this;
    wx.showModal({
      title: '驳回交付', editable: true, placeholderText: '请填写驳回原因（至少2字）',
      success: async (r) => {
        if (!r.confirm) return;
        await request('POST', `/orders/${that.data.id}/reject-delivery`, { reason: r.content || '不符合要求' });
        that.load();
      },
    });
  },

  // ---------- 工程师操作 ----------
  goQuote() {
    const o = this.data.order;
    wx.navigateTo({
      url: `/pages/quote-form/index?orderId=${this.data.id}` +
        (o.myQuote ? `&amountFen=${o.myQuote.amountFen}&days=${o.myQuote.days}&solution=${encodeURIComponent(o.myQuote.solution)}` : ''),
    });
  },
  async deliver() {
    if (this.data.delivering) return;
    const that = this;
    wx.chooseMessageFile({
      count: 3, type: 'all',
      success: async (r) => {
        that.setData({ delivering: true });
        try {
          const ids = [];
          for (const f of r.tempFiles) {
            const up = await upload(f.path, { kind: 'RESULT', orderId: that.data.id });
            ids.push(up.fileId);
          }
          await request('POST', `/orders/${that.data.id}/deliver`, { fileIds: ids, note: '成果文件已上传' });
          wx.showToast({ title: '已交付，等待客户验收', icon: 'success' });
          that.load();
        } catch (e) {}
        that.setData({ delivering: false });
      },
    });
  },
});
