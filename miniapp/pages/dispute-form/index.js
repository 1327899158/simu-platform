/**
 * 发起纠纷（云开发版）。
 * 从订单详情页进入：/pages/dispute-form/index?orderId=xxx
 */
const { ensureLogin } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');

const REASONS = [
  { key: 'QUALITY', label: '成果质量不符', icon: '📉' },
  { key: 'DELAY', label: '交付延迟', icon: '⏰' },
  { key: 'MISSING', label: '成果缺失', icon: '📭' },
  { key: 'PAYMENT', label: '费用争议', icon: '💳' },
  { key: 'COMMUNICATION', label: '沟通不畅', icon: '💬' },
  { key: 'OTHER', label: '其他', icon: '📌' },
];

Page({
  data: {
    orderId: '',
    reasons: REASONS,
    reasonType: '',
    description: '',
    uploading: false,
    uploads: [], // { fileId, name, sizeText }
    submitting: false,
  },
  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    if (!q.orderId) { wx.showToast({ title: '缺少订单ID', icon: 'none' }); return; }
    this.setData({ orderId: q.orderId });
  },
  pickReason(e) {
    this.setData({ reasonType: e.currentTarget.dataset.key });
  },
  onDesc(e) {
    this.setData({ description: e.detail.value });
  },
  async addEvidence() {
    if (this.data.uploading) return;
    if (this.data.uploads.length >= 5) { wx.showToast({ title: '最多上传 5 个证据文件', icon: 'none' }); return; }
    const that = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'all',
      success: async (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        that.setData({ uploading: true });
        wx.showLoading({ title: '上传中…', mask: true });
        try {
          // 证据文件不挂订单，走 dispute_evidence 关系表
          const up = await upload(f.path, { kind: 'DOC', name: f.name || 'evidence' });
          const sizeMB = f.size ? (f.size / 1024 / 1024).toFixed(2) : '未知';
          that.setData({
            uploads: [...that.data.uploads, { fileId: up.id || up.fileId, name: up.name || f.name, sizeText: `${sizeMB}MB` }],
          });
          wx.showToast({ title: '上传成功', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: e.message || '上传失败', icon: 'none' });
        } finally {
          wx.hideLoading();
          that.setData({ uploading: false });
        }
      },
    });
  },
  removeEvidence(e) {
    const idx = e.currentTarget.dataset.index;
    const uploads = this.data.uploads.slice();
    uploads.splice(idx, 1);
    this.setData({ uploads });
  },
  async submit() {
    if (this.data.submitting) return;
    if (!this.data.reasonType) { wx.showToast({ title: '请选择纠纷类型', icon: 'none' }); return; }
    const description = this.data.description.trim();
    if (description.length < 10) { wx.showToast({ title: '请填写不少于10字的纠纷说明', icon: 'none' }); return; }
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中…', mask: true });
    try {
      await request('POST', `/orders/${this.data.orderId}/dispute`, {
        reasonType: this.data.reasonType,
        description,
        fileIds: this.data.uploads.map((u) => u.fileId),
      });
      wx.hideLoading();
      wx.showModal({
        title: '纠纷已发起',
        content: '订单已暂停处理。双方可在48小时内进入纠纷详情补充证据，举证结束后由平台仲裁。',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
