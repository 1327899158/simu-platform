// 游客“我的”页面仅展示引导信息，暂不接入登录和资料功能。
Page({
  goTab(e) {
    const page = e.currentTarget.dataset.page;
    if (!page || page === 'profile') return;
    wx.redirectTo({ url: `/pages/guest-${page}/index` });
  },
});
