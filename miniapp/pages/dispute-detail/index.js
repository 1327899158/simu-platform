/** 纠纷详情：双方在发起后的 48 小时内补充证据，截止后等待平台仲裁。 */
const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');
const { timeShort, fenToYuan } = require('../../utils/format');

const MAX_EVIDENCE_PER_PARTY = 20;
const MAX_FILES_PER_UPLOAD = 5;

function pad2(value) { return String(value).padStart(2, '0'); }

Page({
  data: {
    id: '', myId: '', dispute: null,
    uploading: false, evidenceCountdown: '',
  },
  _countdownTimer: null,
  _deadlineMs: 0,

  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    if (!q.id) { wx.showToast({ title: '缺少纠纷ID', icon: 'none' }); return; }
    this.setData({ id: q.id, myId: user.id });
  },
  onShow() { this.load(); },
  onHide() { this.stopCountdown(); },
  onUnload() { this.stopCountdown(); },

  async load() {
    try {
      const d = await request('GET', `/disputes/${this.data.id}`, null, { silent: true });
      const dispute = this.normalize(d);
      this.setData({ dispute });
      this.startCountdown(dispute.evidenceDeadlineAt, dispute.evidenceOpen);
    } catch (e) {
      wx.showToast({ title: e.message || '纠纷加载失败', icon: 'none' });
    }
  },

  normalize(d) {
    const statusCls = { OPEN: 'st-orange', RESOLVED: 'st-green', CANCELLED: 'st-gray' }[d.status] || 'st-gray';
    const evidence = (d.evidence || []).map((f) => ({
      ...f,
      sizeText: this.sizeText(f.sizeBytes),
      timeText: timeShort(f.createdAt),
      uploaderText: f.uploaderId === this.data.myId
        ? '我提交的'
        : (f.uploaderRole === 'ENGINEER' ? '工程师提交' : '客户提交'),
    }));
    return {
      ...d,
      refundY: d.refundAmountFen == null ? null : fenToYuan(d.refundAmountFen),
      createdText: timeShort(d.createdAt),
      resolvedText: timeShort(d.resolvedAt),
      deadlineText: this.dateTimeText(d.evidenceDeadlineAt),
      statusCls,
      evidence,
      myEvidenceCount: evidence.filter((f) => f.uploaderId === this.data.myId).length,
    };
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
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  },

  startCountdown(deadlineAt, evidenceOpen) {
    this.stopCountdown();
    this._deadlineMs = new Date(deadlineAt).getTime();
    if (!evidenceOpen) {
      this.setData({ evidenceCountdown: '举证已结束' });
      return;
    }
    this.tickCountdown();
    if (Number.isFinite(this._deadlineMs) && this._deadlineMs > Date.now()) {
      this._countdownTimer = setInterval(() => this.tickCountdown(), 1000);
    }
  },

  stopCountdown() {
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    this._countdownTimer = null;
  },

  tickCountdown() {
    const remaining = Math.max(0, Math.ceil((this._deadlineMs - Date.now()) / 1000));
    if (!remaining) {
      this.stopCountdown();
      this.setData({ evidenceCountdown: '举证已结束', 'dispute.evidenceOpen': false });
      return;
    }
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    const seconds = remaining % 60;
    this.setData({ evidenceCountdown: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}` });
  },

  async addEvidence() {
    const dispute = this.data.dispute;
    if (!dispute || !dispute.evidenceOpen || this.data.uploading) return;
    const remainingSlots = MAX_EVIDENCE_PER_PARTY - Number(dispute.myEvidenceCount || 0);
    if (remainingSlots <= 0) {
      wx.showToast({ title: `每人最多提交${MAX_EVIDENCE_PER_PARTY}份证据`, icon: 'none' });
      return;
    }
    wx.chooseMessageFile({
      count: Math.min(MAX_FILES_PER_UPLOAD, remainingSlots),
      type: 'all',
      success: async (result) => {
        const files = result.tempFiles || [];
        if (!files.length) return;
        this.setData({ uploading: true });
        wx.showLoading({ title: '上传证据中…', mask: true });
        try {
          const fileIds = [];
          for (const file of files) {
            const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || '');
            const saved = await upload(file.path, {
              kind: isImage ? 'IMAGE' : 'DOC',
              name: file.name || 'evidence',
            });
            fileIds.push(saved.id || saved.fileId);
          }
          await request('POST', `/disputes/${this.data.id}/evidence`, { fileIds }, { silent: true });
          wx.showToast({ title: `已提交${fileIds.length}份证据`, icon: 'success' });
          await this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '证据上传失败', icon: 'none' });
          await this.load();
        } finally {
          wx.hideLoading();
          this.setData({ uploading: false });
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
