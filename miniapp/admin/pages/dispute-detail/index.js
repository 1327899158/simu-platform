/**
 * 管理员：纠纷详情 + 仲裁
 */
const { request } = require('../../../utils/request');
const { getAdmin, hasPermission, denyAndExit } = require('../../utils/admin');
const { downloadAndOpen, formatDownloadError } = require('../../../utils/cloud-file');
const { timeShort, fenToYuan } = require('../../../utils/format');

const VERDICTS = [
  { key: 'CUSTOMER_FAVOR', label: '支持买家' },
  { key: 'ENGINEER_FAVOR', label: '支持工程师' },
  { key: 'PARTIAL', label: '部分支持' },
];
const ACTIONS = [
  { key: 'KEEP', label: '恢复原状' },
  { key: 'FORCE_COMPLETE', label: '强制完成' },
  { key: 'REOPEN', label: '重新执行' },
  { key: 'CLOSE', label: '关闭订单' },
];

Page({
  data: {
    id: '', dispute: null, loading: true, canResolve: false,
    verdict: '', orderAction: '', note: '', refundAmount: '',
    VERDICTS, ACTIONS, submitting: false,
  },
  onLoad(options) {
    const admin = getAdmin();
    if (!admin) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    if (!options.id) { wx.showToast({ title: '缺少纠纷ID', icon: 'none' }); return; }
    this.setData({
      id: options.id,
      canResolve: hasPermission(admin, 'DISPUTE_RESOLVE'),
    });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const d = await request('GET', `/admin/disputes/${this.data.id}`, null, { silent: true });
      const badge = d.status === 'OPEN' ? 'badge-orange' : d.status === 'RESOLVED' ? 'badge-green' : 'badge-gray';
      this.setData({
        dispute: {
          ...d,
          badgeClass: badge,
          createdText: timeShort(d.createdAt),
          resolvedText: timeShort(d.resolvedAt),
          deadlineText: this.dateTimeText(d.evidenceDeadlineAt),
          refundY: d.refundAmountFen == null ? null : fenToYuan(d.refundAmountFen),
          msgs: (d.messages || []).map((m) => ({
            ...m,
            sys: m.senderId === 'SYSTEM' || !!(m.sender && m.sender.kind === 'system'),
            senderName: m.sender ? m.sender.nickname : (m.senderId === 'SYSTEM' ? '系统' : '未知'),
            senderKind: m.sender ? m.sender.kind : 'user',
            time: timeShort(m.createdAt),
          })),
          evidence: (d.evidence || []).map((f) => ({
            ...f,
            sizeText: this.sizeText(f.sizeBytes),
            submittedText: timeShort(f.createdAt),
            uploaderText: f.uploaderRole === 'ENGINEER' ? '工程师' : '客户',
          })),
        },
      });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '纠纷加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
  sizeText(bytes) {
    const size = Number(bytes || 0);
    if (!size) return '大小未知';
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
    return `${(size / 1024 / 1024).toFixed(2)}MB`;
  },
  dateTimeText(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },
  pickVerdict(e) { this.setData({ verdict: e.currentTarget.dataset.key }); },
  pickAction(e) { this.setData({ orderAction: e.currentTarget.dataset.key }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  onRefund(e) { this.setData({ refundAmount: e.detail.value }); },
  async resolve() {
    if (this.data.submitting) return;
    if (!this.data.verdict) { wx.showToast({ title: '请选择仲裁结论', icon: 'none' }); return; }
    if (!this.data.orderAction) { wx.showToast({ title: '请选择订单处理方式', icon: 'none' }); return; }
    let refundAmountFen = null;
    const refundText = String(this.data.refundAmount || '').trim();
    if (refundText) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(refundText)) { wx.showToast({ title: '退款金额格式不正确', icon: 'none' }); return; }
      refundAmountFen = Math.round(Number(refundText) * 100);
    }
    const that = this;
    wx.showModal({
      title: '确认仲裁',
      content: '仲裁结案后订单状态将按所选方案变更，退款诉求将登记待处理。确认提交？',
      success: async (r) => {
        if (!r.confirm) return;
        that.setData({ submitting: true });
        wx.showLoading({ title: '提交中…', mask: true });
        try {
          await request('POST', `/admin/disputes/${that.data.id}/resolve`, {
            verdict: that.data.verdict,
            orderAction: that.data.orderAction,
            note: that.data.note.trim(),
            refundAmountFen,
          }, { silent: true });
          wx.hideLoading();
          wx.showToast({ title: '仲裁已提交', icon: 'success' });
          that.setData({ submitting: false });
          that.load();
        } catch (error) {
          wx.hideLoading();
          that.setData({ submitting: false });
          wx.showToast({ title: error.message || '仲裁失败', icon: 'none' });
        }
      },
    });
  },
  async openEvidence(e) {
    const file = this.data.dispute.evidence[e.currentTarget.dataset.index];
    if (!file) return;
    wx.showLoading({ title: '正在打开…', mask: true });
    try {
      const info = await request('GET', `/files/${file.fileId}/url`, null, { silent: true });
      await downloadAndOpen(info);
    } catch (error) {
      wx.showModal({ title: '文件打开失败', content: formatDownloadError(error), showCancel: false });
    } finally { wx.hideLoading(); }
  },
});
