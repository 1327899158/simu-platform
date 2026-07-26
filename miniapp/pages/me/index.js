const { ensureLogin, login, getUser } = require('../../utils/auth');
const { request, tokens } = require('../../utils/request');
Page({
  data: { user: null, roleText: '' },
  async onShow() {
    const user = ensureLogin();
    if (!user) return;
    try {
      const fresh = await request('GET', '/me');
      wx.setStorageSync('user', fresh);
      this.setData({ user: fresh, roleText: fresh.role === 'ENGINEER' ? '工程师' : '客户' });
    } catch (e) {
      this.setData({ user, roleText: user.role === 'ENGINEER' ? '工程师' : '客户' });
    }
  },
  async switchRole() {
    const cur = getUser();
    const target = cur.role === 'ENGINEER' ? 'customer' : 'engineer';
    wx.showModal({
      title: '切换角色（演示）',
      content: `将以「${target === 'engineer' ? '工程师' : '客户'}」身份重新登录`,
      success: async (r) => {
        if (!r.confirm) return;
        await login(target);
        wx.switchTab({ url: '/pages/home/index' });
      },
    });
  },
  logout() {
    tokens.clear();
    wx.reLaunch({ url: '/pages/login/index' });
  },
});
