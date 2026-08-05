const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');

Page({
  data: { profile: null, loading: true },
  async onLoad(query) {
    if (!ensureLogin()) return;
    if (!query.id) return wx.navigateBack();
    try {
      const profile = await request('GET', `/engineers/${query.id}/profile`);
      this.setData({ profile });
      wx.setNavigationBarTitle({ title: profile.nickname || '工程师资料' });
    } catch (e) {
      wx.showToast({ title: e.message || '资料加载失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    } finally {
      this.setData({ loading: false });
    }
  },
});
