// 游客首页仅用于展示平台能力与页面结构，暂不接入业务操作。
Page({
  goTab(e) {
    const page = e.currentTarget.dataset.page;
    if (!page || page === 'home') return;
    wx.redirectTo({ url: `/pages/guest-${page}/index` });
  },
});
