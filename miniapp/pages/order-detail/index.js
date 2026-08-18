/**
 * 订单详情（双角色合一）：
 *  mode=customer 客户视角：报价对比/选标/模拟支付/验收确认/驳回
 *  mode=market   工程师视角：需求详情/报价/交付
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { deleteCloudFile, downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');
const { fenToYuan, timeShort, STATUS_CLASS } = require('../../utils/format');

function fileSizeText(sizeBytes) {
  if (!Number(sizeBytes)) return '大小未知';
  if (Number(sizeBytes) < 1024 * 1024) return `${(Number(sizeBytes) / 1024).toFixed(1)}KB`;
  return `${(Number(sizeBytes) / 1024 / 1024).toFixed(2)}MB`;
}

Page({
  data: {
    id: '', mode: 'customer', role: '',
    order: null, quotes: [], peerQuotes: [], files: [],
    paying: false, delivering: false, downloadingFileId: '',
    dispute: null,
    refundRequest: null,
    invoiceRequest: null,
    respondingRefund: false,
    refundFormOpen: false,
    refundReason: '',
    refundUploads: [],
    refundUploading: false,
    refundSubmitting: false,
    chatOpeningQuoteId: '',
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
      if (refundRequest) {
        refundRequest.files = (refundRequest.files || []).map((file) => ({
          ...file,
          fileId: file.fileId || file.id,
          sizeText: fileSizeText(file.sizeBytes),
        }));
      }
    } catch (e) {
      // 未选中工程师、无退款申请等场景不影响订单详情展示。
    }
    this.setData({ refundRequest });
    // 发票信息仅订单双方可读取；不存在申请时返回 null，不影响订单详情。
    try {
      const invoiceRequest = await request('GET', `/orders/${id}/invoice-request`, null, { silent: true });
      this.setData({ invoiceRequest });
    } catch (e) { this.setData({ invoiceRequest: null }); }
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

    // 客户用于选标；工程师用于了解同一需求中的其他工程师报价。
    const shouldLoadQuotes = (this.data.mode === 'customer'
      && ['QUOTING', 'AWAITING_PAYMENT'].includes(order.status))
      || this.data.mode === 'market';
    if (shouldLoadQuotes) {
      try {
        const quotes = await request('GET', `/orders/${id}/quotes`);
        const formattedQuotes = quotes.map((x) => ({
          ...x,
          amountY: fenToYuan(x.amountFen),
          engineer: x.engineer ? {
            ...x.engineer,
            avatarUrl: x.engineer.avatarUrl || '',
          } : x.engineer,
        }));
        this.setData({
          quotes: this.data.mode === 'customer' ? formattedQuotes : [],
          peerQuotes: this.data.mode === 'market'
            ? formattedQuotes.filter((quote) => !quote.isMine) : [],
        });
      } catch (e) {
        this.setData({ quotes: [], peerQuotes: [] });
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

  async goQuoteChat(e) {
    const quoteId = e.currentTarget.dataset.id;
    if (!quoteId || this.data.chatOpeningQuoteId) return;
    this.setData({ chatOpeningQuoteId: quoteId });
    try {
      const conversation = await request(
        'POST',
        `/orders/${this.data.id}/quotes/${quoteId}/conversation`,
        null,
        { silent: true }
      );
      wx.navigateTo({ url: `/pages/chat-room/index?id=${conversation.id}` });
    } catch (e2) {
      wx.showToast({ title: e2.message || '聊天入口加载失败', icon: 'none' });
    } finally {
      this.setData({ chatOpeningQuoteId: '' });
    }
  },

  // ---------- 客户操作 ----------
  del() {
    wx.showModal({
      title: '删除订单', content: '仅报价阶段的订单可删除，删除后不可恢复',
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
    this.setData({
      refundFormOpen: true,
      refundReason: '',
      refundUploads: [],
    });
  },

  onRefundReason(e) {
    this.setData({ refundReason: e.detail.value });
  },

  addRefundFiles() {
    if (this.data.refundUploading || this.data.refundSubmitting) return;
    const remaining = 5 - this.data.refundUploads.length;
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传 5 个附件', icon: 'none' });
      return;
    }
    const that = this;
    wx.chooseMessageFile({
      count: remaining,
      type: 'all',
      success: async (result) => {
        const chosen = result.tempFiles || [];
        if (!chosen.length) return;
        that.setData({ refundUploading: true });
        wx.showLoading({ title: '上传中…', mask: true });
        const uploaded = that.data.refundUploads.slice();
        const failures = [];
        for (const file of chosen) {
          try {
            const name = file.name || '退款材料';
            const kind = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) ? 'IMAGE' : 'DOC';
            const item = await upload(file.path || file.tempFilePath, { kind, name });
            uploaded.push({
              fileId: item.id || item.fileId,
              fileID: item.fileID || '',
              name: item.name || name,
              sizeText: fileSizeText(file.size || item.sizeBytes),
            });
            that.setData({ refundUploads: uploaded });
          } catch (e) {
            failures.push(`${file.name || '文件'}：${e.message || '上传失败'}`);
          }
        }
        wx.hideLoading();
        that.setData({ refundUploading: false });
        if (failures.length) {
          wx.showModal({
            title: uploaded.length ? '部分文件未上传' : '附件上传失败',
            content: failures.join('\n').slice(0, 500),
            showCancel: false,
          });
        } else {
          wx.showToast({ title: '附件已上传', icon: 'success' });
        }
      },
    });
  },
  goInvoiceRequest() {
    wx.navigateTo({ url: `/pages/invoice-request/index?orderId=${this.data.id}` });
  },

  escalateRefund() {
    const refund = this.data.refundRequest;
    if (!refund || refund.status !== 'REJECTED') return;
    wx.showModal({
      title: '申请客服介入',
      content: '工程师已拒绝退款申请。申请后订单将进入纠纷处理，双方可在48小时内上传证据。',
      confirmText: '申请介入',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const data = await request('POST', `/orders/${this.data.id}/refund-request/escalate`, {});
          wx.showToast({ title: '已申请客服介入', icon: 'success' });
          setTimeout(() => wx.navigateTo({ url: `/pages/dispute-detail/index?id=${data.disputeId}` }), 350);
        } catch (error) { wx.showToast({ title: error.message || '申请客服介入失败', icon: 'none' }); }
      },
    });
  },

  async removeRefundFile(e) {
    if (this.data.refundUploading || this.data.refundSubmitting) return;
    const index = Number(e.currentTarget.dataset.index);
    const file = this.data.refundUploads[index];
    if (!file) return;
    try {
      const deleted = await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
      const uploads = this.data.refundUploads.slice();
      uploads.splice(index, 1);
      this.setData({ refundUploads: uploads });
      if (deleted && deleted.fileID) deleteCloudFile(deleted.fileID).catch(() => {});
    } catch (err) {
      wx.showToast({ title: err.message || '附件删除失败', icon: 'none' });
    }
  },

  cancelRefundForm() {
    if (this.data.refundUploading || this.data.refundSubmitting) return;
    const abandoned = this.data.refundUploads.slice();
    this.setData({ refundFormOpen: false, refundReason: '', refundUploads: [] });
    // 表单取消后清理尚未绑定业务的临时文件，清理失败不阻塞页面操作。
    abandoned.forEach(async (file) => {
      try {
        const deleted = await request('DELETE', `/files/${file.fileId}`, null, { silent: true });
        if (deleted && deleted.fileID) await deleteCloudFile(deleted.fileID);
      } catch (e) { /* 后端的孤立文件清理任务可继续兜底 */ }
    });
  },

  async submitRefundRequest() {
    if (this.data.refundUploading || this.data.refundSubmitting) return;
    const reason = String(this.data.refundReason || '').trim();
    if (!reason) {
      wx.showToast({ title: '请填写退款理由', icon: 'none' });
      return;
    }
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认提交退款申请',
        content: '申请将发送给工程师确认；若工程师拒绝，你可以选择是否申请客服介入。',
        confirmText: '确认提交',
        success: (result) => resolve(!!result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ refundSubmitting: true });
    try {
      await request('POST', `/orders/${this.data.id}/refund-request`, {
        reason,
        fileIds: this.data.refundUploads.map((file) => file.fileId),
      });
      this.setData({ refundFormOpen: false, refundReason: '', refundUploads: [] });
      wx.showToast({ title: '退款申请已提交', icon: 'success' });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '退款申请提交失败', icon: 'none' });
    } finally {
      this.setData({ refundSubmitting: false });
    }
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
      } else if (result.rejected) {
        wx.showToast({ title: '已拒绝退款申请', icon: 'none' });
        this.load();
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
