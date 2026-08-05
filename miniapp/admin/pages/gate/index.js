const { loadAdmin, denyAndExit } = require('../../utils/admin');

Page({
  data: { state: 'loading', message: '正在核验管理员身份…' },
  onLoad(options) {
    this.scene = options.scene ? decodeURIComponent(options.scene) : '';
    this.verify();
  },
  async verify() {
    this.setData({ state: 'loading', message: '正在核验管理员身份…' });
    try {
      await new Promise((resolve) => wx.login({ complete: resolve }));
      await loadAdmin();
      this.setData({ state: 'success', message: '身份验证通过，正在进入管理端…' });
      setTimeout(() => wx.redirectTo({ url: '/admin/pages/dashboard/index' }), 350);
    } catch (error) {
      this.setData({ state: 'error', message: error.message || '身份验证失败' });
      denyAndExit(error.message);
    }
  },
});
