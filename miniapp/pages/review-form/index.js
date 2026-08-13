const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');

const STAR_ITEMS = [1, 2, 3, 4, 5];

Page({
  data: {
    orderId: '',
    editing: false,
    saving: false,
    order: null,
    rows: [
      { key: 'qualityScore', label: '质量', score: 0, stars: STAR_ITEMS },
      { key: 'attitudeScore', label: '态度', score: 0, stars: STAR_ITEMS },
      { key: 'speedScore', label: '速度', score: 0, stars: STAR_ITEMS },
      { key: 'professionalScore', label: '专业能力', score: 0, stars: STAR_ITEMS },
      { key: 'communicationScore', label: '沟通', score: 0, stars: STAR_ITEMS },
    ],
    content: '',
    contentLength: 0,
  },
  async onLoad(query) {
    if (!ensureLogin()) return;
    if (!query.orderId) {
      wx.showToast({ title: '缺少订单信息', icon: 'none' });
      return wx.navigateBack();
    }
    this.setData({ orderId: query.orderId, editing: query.edit === '1' });
    await this.loadOrder();
  },
  async loadOrder() {
    try {
      const order = await request('GET', `/orders/${this.data.orderId}`);
      if (order.status !== 'COMPLETED') throw new Error('仅已完成订单可评价');
      const review = order.review;
      if (this.data.editing && !review) throw new Error('尚未提交评价');
      if (review && Number(review.revisionCount || 0) >= 1) throw new Error('该评价已修改过，不能再次修改');
      const rows = this.data.rows.map((row) => ({ ...row, score: review ? Number(review[row.key]) : 0 }));
      const content = review ? review.content || '' : '';
      this.setData({ order, rows, content, contentLength: content.length });
      wx.setNavigationBarTitle({ title: review ? '修改评价' : '评价工程师' });
    } catch (e) {
      wx.showToast({ title: e.message || '评价信息加载失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },
  chooseStar(e) {
    const index = Number(e.currentTarget.dataset.index);
    const score = Number(e.currentTarget.dataset.score);
    if (!Number.isInteger(index) || score < 1 || score > 5) return;
    this.setData({ [`rows[${index}].score`]: score });
  },
  inputContent(e) {
    const content = String(e.detail.value || '').slice(0, 100);
    this.setData({ content, contentLength: content.length });
  },
  async submit() {
    if (this.data.saving) return;
    const data = {};
    for (const row of this.data.rows) {
      if (!row.score) {
        wx.showToast({ title: '请完成五项星级评分', icon: 'none' });
        return;
      }
      data[row.key] = row.score;
    }
    this.setData({ saving: true });
    try {
      await request(this.data.editing ? 'PATCH' : 'POST', `/orders/${this.data.orderId}/review`, {
        ...data,
        content: this.data.content,
      });
      wx.showToast({ title: this.data.editing ? '评价已修改' : '评价提交成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '提交失败', icon: 'none' });
    } finally {
      this.setData({ saving: false });
    }
  },
});
