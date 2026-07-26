const { login } = require('../../utils/auth');
Page({
  data: { loading: '' },
  async go(e) {
    const role = e.currentTarget.dataset.role;
    if (this.data.loading) return;
    this.setData({ loading: role });
    try {
      await login(role);
      wx.switchTab({ url: '/pages/home/index' });
    } catch (err) { /* toast 已由 request 统一处理 */ }
    this.setData({ loading: '' });
  },
});
