/**
 * 订单详情（双角色合一）：
 *  mode=customer 客户视角：报价对比/选标/模拟支付/验收确认/驳回
 *  mode=market   工程师视角：需求详情/报价/交付
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');

Page({
  data: {
    id: '', mode: 'customer', role: '',
    order: null, quotes: [], files: [],
    paying: false, delivering: false, downloadingFileId: '',
    dispute: null,
    refundRequest: null,
    respondingRefund: false,
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

    // 查询待处理退款申请。工程师进入被选中的订单时，以弹窗完成同意/拒绝。
    let refundRequest = null;
    try {
      refundRequest = await request('GET', `/orders/${id}/refund-request`, null, { silent: true });
    } catch (e) {
      // 未选中工程师、无退款申请等场景不影响订单详情展示。
    }
    this.setData({ refundRequest });
    // 查询是否有进行中的纠纷（仅当事人可见）
    try {
      const dispute = await request('GET', `/orders/${id}/dispute`, null, { silent: true });
      this.setData({ dispute });
    } catch (e) {
      this.setData({ dispute: null });
    }

    // 文件列表（无权限时静默忽略）
    try {
      const files = await request('GET', `/orders/${id}/files`, null, { silent: true });
      this.setData({
        files: files.map((f) => ({
          ...f,
          fileId: f.fileId || f.id,
          sizeText: f.sizeBytes
            ? (f.sizeBytes / 1024 / 1024).toFixed(2) + 'MB'
            : '大小未知',
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
    if (!fid || this._fileDownloadInFlight) return;
    this._fileDownloadInFlight = true;
    this.setData({ downloadingFileId: fid });
    wx.showLoading({ title: '下载中…', mask: true });
    try {
      // 服务端只负责权限校验；云文件由小程序直接下载，避免后端临时链接超时。
      const info = await request('GET', `/files/${fid}/url`, null, { silent: true });
      const result = await downloadAndOpen(info);
      if (result && result.notice) {
        wx.hideLoading();
        await new Promise((resolve) => wx.showModal({
          title: '文件已下载', content: result.notice, showCancel: false, complete: resolve,
        }));
      }
    } catch (err) {
      wx.hideLoading();
      const diagnostic = formatDownloadError(err);
      console.error('[order-file] download failed', {
        fileId: fid,
        statusCode: err.statusCode || null,
        stage: err.stage || null,
        detail: err.detail || err.message || 'unknown',
        traceId: err.traceId || null,
      });
      wx.showModal({
        title: '附件下载失败',
        content: diagnostic,
        showCancel: false,
      });
    } finally {
      wx.hideLoading();
      this._fileDownloadInFlight = false;
      this.setData({ downloadingFileId: '' });
    }
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
  goReview() {
    const review = this.data.order && this.data.order.review;
    if (review && Number(review.revisionCount || 0) >= 1) {
      wx.showToast({ title: '该评价已修改过，不能再次修改', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: `/pages/review-form/index?orderId=${this.data.id}${review ? '&edit=1' : ''}`,
    });
  },
  goEngineerProfile(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/engineer-profile/index?id=${id}` });
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

  requestRefund() {
    const o = this.data.order;
    if (!o || this.data.refundRequest) return;
    wx.showModal({
      title: '发起退款申请',
      content: '申请将发送给工程师确认。同意后订单会标记为已取消；退款资金处理暂不执行。若工程师拒绝，订单将进入纠纷处理。',
      confirmText: '提交申请',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await request('POST', `/orders/${this.data.id}/refund-request`, {});
          wx.showToast({ title: '退款申请已提交', icon: 'success' });
          this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '退款申请提交失败', icon: 'none' });
        }
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

  async respondRefundRequest(e) {
    const action = typeof e === 'string' ? e : e.currentTarget.dataset.action;
    if (this.data.respondingRefund) return;
    this.setData({ respondingRefund: true });
    try {
      const result = await request('POST', `/orders/${this.data.id}/refund-request/respond`, { action });
      if (result.accepted) {
        wx.showToast({ title: '已同意退款，订单已取消', icon: 'success' });
        this.load();
      } else if (result.disputeId) {
        wx.showToast({ title: '已进入纠纷处理', icon: 'none' });
        setTimeout(() => wx.navigateTo({ url: `/pages/dispute-detail/index?id=${result.disputeId}` }), 400);
      }
    } catch (e) {
      wx.showToast({ title: e.message || '退款申请处理失败', icon: 'none' });
    } finally {
      this.setData({ respondingRefund: false });
    }
  },

  // ---------- 纠纷 ----------
  goDisputeForm() {
    wx.navigateTo({ url: `/pages/dispute-form/index?orderId=${this.data.id}` });
  },
  goDisputeDetail() {
    const d = this.data.dispute;
    if (d && d.id) wx.navigateTo({ url: `/pages/dispute-detail/index?id=${d.id}` });
    else wx.showToast({ title: '暂无纠纷', icon: 'none' });
  },
});
