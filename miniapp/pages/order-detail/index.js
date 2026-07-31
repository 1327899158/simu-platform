/**
 * 订单详情（双角色合一）：
 *  mode=customer 客户视角：报价对比/选标/模拟支付/验收确认/驳回
 *  mode=market   工程师视角：需求详情/报价/交付
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');

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
    let order;
    try {
      order = await request('GET', url);
    } catch (e) {
      wx.showToast({ title: e.message || '订单加载失败', icon: 'none' });
      return;
    }
    order.budgetY = fenToYuan(order.budgetFen);
    order.finalY = fenToYuan(order.finalAmountFen);
    order.time = timeShort(order.createdAt);
    order.cls = STATUS_CLASS[order.status] || 'st-gray';
    this.setData({ order });

    // 文件列表（无权限时静默忽略）
    try {
      const files = await request('GET', `/orders/${id}/files`, null, { silent: true });
      this.setData({
        files: files.map((f) => ({
          ...f,
          fileId: f.fileId || f.id,
          sizeText: (f.sizeBytes / 1024 / 1024).toFixed(2) + 'MB',
        })),
      });
    } catch (e) {
      this.setData({ files: [] });
      if (e.statusCode !== 403) wx.showToast({ title: e.message || '附件加载失败', icon: 'none' });
    }

    // 客户在报价阶段拉全部报价
    if (this.data.mode === 'customer' && ['QUOTING', 'AWAITING_PAYMENT'].includes(order.status)) {
      try {
        const quotes = await request('GET', `/orders/${id}/quotes`);
        this.setData({
          quotes: quotes.map((x) => ({
          ...x,
          amountY: fenToYuan(x.amountFen),
          engineer: x.engineer ? {
            ...x.engineer,
            avatarUrl: x.engineer.avatarUrl
              ? x.engineer.avatarUrl
              : '',
          } : x.engineer,
          })),
        });
      } catch (e) {
        wx.showToast({ title: e.message || '报价加载失败', icon: 'none' });
      }
    }
  },

  // ---------- 通用 ----------
  async download(e) {
    const fid = e.currentTarget.dataset.id;
    try {
      // 云开发版：url 是云存储临时链接（HTTPS，直接下载）
      const info = await request('GET', `/files/${fid}/url`);
      wx.showLoading({ title: '下载中…' });
      wx.downloadFile({
        url: info.url,
        success(res) {
          wx.hideLoading();
          if (res.statusCode !== 200) return wx.showToast({ title: '下载失败', icon: 'none' });
          wx.openDocument({
            filePath: res.tempFilePath,
            showMenu: true,
            fail: () => wx.showToast({ title: '文件打开失败，请重试', icon: 'none' }),
          });
        },
        fail() { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }); },
      });
    } catch (err) { wx.showToast({ title: err.message || '下载失败', icon: 'none' }); }
  },
  async goChat() {
    try {
      const c = await request('GET', `/conversations/by-order/${this.data.id}`);
      wx.navigateTo({ url: `/pages/chat-room/index?id=${c.id}` });
    } catch (e) { wx.showToast({ title: e.message || '聊天入口加载失败', icon: 'none' }); }
  },

  // ---------- 客户操作 ----------
  del() {
    wx.showModal({
      title: '删除订单', content: '仅待报价状态可删除，删除后不可恢复',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request('DELETE', `/orders/${this.data.id}`);
          wx.navigateBack();
        } catch (e) { wx.showToast({ title: e.message || '删除失败', icon: 'none' }); }
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
        try {
          await request('POST', `/orders/${this.data.id}/select-quote`, { quoteId: q.id });
          this.load();
        } catch (e) { wx.showToast({ title: e.message || '选定报价失败', icon: 'none' }); }
      },
    });
  },
  async pay() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      // 云开发版：服务端通过云托管开放接口代签名，返回 wx.requestPayment 五参数
      const p = await request('POST', `/orders/${this.data.id}/pay`, {}, { silent: true });

      if (p.mode === 'mock') {
        const confirmed = await new Promise((resolve) => {
          wx.showModal({
            title: '模拟支付',
            content: `模拟支付金额：¥${fenToYuan(p.amountFen || 0)}\n不会调用微信支付接口。`,
            confirmText: '确认支付',
            cancelText: '取消',
            success: resolve,
            fail: () => resolve({ confirm: false }),
          });
        });
        if (!confirmed.confirm) {
          this.setData({ paying: false });
          return;
        }
        await request('POST', `/orders/${this.data.id}/pay/mock-confirm`, {}, { silent: true });
        wx.showToast({ title: '支付成功（模拟）', icon: 'success' });
        this.load();
        this.setData({ paying: false });
      } else if (p.timeStamp) {
        // 真实微信支付（云托管代签名返回的五参数）
        wx.requestPayment({
          timeStamp: p.timeStamp,
          nonceStr: p.nonceStr,
          package: p.package,
          signType: p.signType || 'RSA',
          paySign: p.paySign,
          success: async () => {
            // 轮询等待回调落账
            for (let i = 0; i < 8; i++) {
              const st = await request('GET', `/orders/${this.data.id}/payment`, null, { silent: true });
              if (st && st.orderStatus === 'IN_PROGRESS') break;
              await new Promise((rs) => setTimeout(rs, 800));
            }
            wx.showToast({ title: '支付成功', icon: 'success' });
            this.load();
          },
          fail: (err) => {
            if (err.errMsg && err.errMsg.includes('cancel')) {
              wx.showToast({ title: '已取消支付', icon: 'none' });
            } else {
              wx.showToast({ title: '支付失败', icon: 'none' });
            }
          },
          complete: () => this.setData({ paying: false }),
        });
      } else {
        throw new Error('微信支付下单返回参数不完整');
      }
    } catch (e) {
      this.setData({ paying: false });
      wx.showToast({ title: e.message || '支付处理失败', icon: 'none' });
    }
  },
  confirmDone() {
    wx.showModal({
      title: '确认验收', content: '确认成果符合要求并完成订单？',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request('POST', `/orders/${this.data.id}/confirm`);
          wx.showToast({ title: '订单已完成', icon: 'success' });
          this.load();
        } catch (e) { wx.showToast({ title: e.message || '确认收货失败', icon: 'none' }); }
      },
    });
  },
  rejectDelivery() {
    const that = this;
    wx.showModal({
      title: '驳回交付', editable: true, placeholderText: '请填写驳回原因（至少2字）',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request('POST', `/orders/${that.data.id}/reject-delivery`, { reason: r.content || '不符合要求' });
          that.load();
        } catch (e) { wx.showToast({ title: e.message || '驳回交付失败', icon: 'none' }); }
      },
    });
  },

  // ---------- 工程师操作 ----------
  goQuote() {
    const o = this.data.order;
    let url = `/pages/quote-form/index?orderId=${this.data.id}&flexible=${o.budgetFlexible ? 1 : 0}`;
    if (!o.budgetFlexible && o.budgetFen) url += `&fixedFen=${o.budgetFen}`;
    if (o.myQuote) url += `&amountFen=${o.myQuote.amountFen}&days=${o.myQuote.days}&solution=${encodeURIComponent(o.myQuote.solution)}`;
    wx.navigateTo({ url });
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
            ids.push(up.id || up.fileId);
          }
          await request('POST', `/orders/${that.data.id}/deliver`, { fileIds: ids, note: '成果文件已上传' });
          wx.showToast({ title: '已交付，等待客户验收', icon: 'success' });
          that.load();
        } catch (e) { wx.showToast({ title: e.message || '交付失败', icon: 'none' }); }
        that.setData({ delivering: false });
      },
    });
  },
});
