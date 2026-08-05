const { request } = require('../../../utils/request');
const { getAdmin, denyAndExit } = require('../../utils/admin');
const { timeShort } = require('../../../utils/format');

Page({
  data: { id: '', user: null, loading: true },
  onLoad(options) {
    if (!getAdmin()) { denyAndExit('管理员会话不存在，请重新扫码进入。'); return; }
    if (!options.id) { wx.showToast({ title: '缺少用户ID', icon: 'none' }); return; }
    this.setData({ id: options.id });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true });
    try {
      const user = await request('GET', `/admin/users/${this.data.id}`, null, { silent: true });
      this.setData({ user: {
        ...user,
        roleText: user.role === 'ENGINEER' ? '工程师' : '客户',
        statusText: user.status === 'ACTIVE' ? '正常' : '已停用',
        createdText: timeShort(user.createdAt),
        sentReviews: (user.sentReviews || []).map((item) => ({ ...item, updatedText: timeShort(item.updatedAt) })),
      } });
    } catch (error) {
      if (error.statusCode === 403) denyAndExit(error.message);
      else wx.showToast({ title: error.message || '用户资料加载失败', icon: 'none' });
    } finally { this.setData({ loading: false }); }
  },
});
