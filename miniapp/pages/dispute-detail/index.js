/**
 * 纠纷详情（当事人 + 管理员共用）。
 * 当事人：/pages/dispute-detail/index?id=xxx
 * 管理员：/admin/pages/dispute-detail/index?id=xxx
 *
 * 通过传入 isAdmin=1 切换数据来源（/admin/disputes/:id），其余展示逻辑复用。
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');
const { timeShort, fenToYuan } = require('../../utils/format');

Page({
  data: {
    id: '', isAdmin: false, myId: '',
    dispute: null, msgs: [], text: '',
    uploading: false, sending: false,
  },
  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    if (!q.id) { wx.showToast({ title: '缺少纠纷ID', icon: 'none' }); return; }
    this.setData({ id: q.id, isAdmin: q.isAdmin === '1', myId: user.id });
  },
  onShow() { this.load(); },
  async load() {
    try {
      const prefix = this.data.isAdmin ? '/admin/disputes' : '/disputes';
      const d = await request('GET', `${prefix}/${this.data.id}`, null, { silent: true });
      this.setData({ dispute: this.normalize(d) });
    } catch (e) {
      wx.showToast({ title: e.message || '纠纷加载失败', icon: 'none' });
    }
  },
  normalize(d) {
    const statusCls = { OPEN: 'st-orange', RESOLVED: 'st-green', CANCELLED: 'st-gray' }[d.status] || 'st-gray';
    const msgs = (d.messages || []).map((m) => ({
      ...m,
      mine: !this.data.isAdmin && m.senderId === this.data.myId,
      adminMsg: this.data.isAdmin,
      time: timeShort(m.createdAt),
      sys: m.senderId === 'SYSTEM' || m.sender.kind === 'system',
      senderName: m.sender ? m.sender.nickname : (m.senderId === 'SYSTEM' ? '系统' : ''),
      senderKind: m.sender ? m.sender.kind : 'user',
    }));
    const evidence = (d.evidence || []).map((f) => ({ ...f, sizeText: this.sizeText(f.sizeBytes) }));
    return {
      ...d,
      refundY: d.refundAmountFen == null ? null : fenToYuan(d.refundAmountFen),
      createdText: timeShort(d.createdAt),
      resolvedText: timeShort(d.resolvedAt),
      statusCls,
      msgs,
      evidence,
    };
  },
  sizeText(bytes) {
    const size = Number(bytes || 0);
    if (!size) return '大小未知';
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
    return `${(size / 1024 / 1024).toFixed(2)}MB`;
  },
  onInput(e) { this.setData({ text: e.detail.value }); },
  async send() {
    const content = this.data.text.trim();
    if (!content) return;
    if (this.data.sending) return;
    this.setData({ sending: true });
    try {
      const prefix = this.data.isAdmin ? '/admin/disputes' : '/disputes';
      await request('POST', `${prefix}/${this.data.id}/messages`, { type: 'TEXT', content });
      this.setData({ text: '' });
      await this.load();
    } catch (e) {
      wx.showToast({ title: e.message || '发送失败', icon: 'none' });
    } finally {
      this.setData({ sending: false });
    }
  },
  async sendImage() {
    if (this.data.uploading) return;
    const that = this;
    wx.chooseMessageFile({
      count: 1, type: 'all',
      success: async (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        that.setData({ uploading: true });
        wx.showLoading({ title: '上传中…', mask: true });
        try {
          const up = await upload(f.path, { kind: 'IMAGE', name: f.name || 'image' });
          const prefix = this.data.isAdmin ? '/admin/disputes' : '/disputes';
          await request('POST', `${prefix}/${this.data.id}/messages`, { type: 'IMAGE', fileId: up.id || up.fileId });
          await this.load();
        } catch (e) {
          wx.showToast({ title: e.message || '发送失败', icon: 'none' });
        } finally {
          wx.hideLoading();
          that.setData({ uploading: false });
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
