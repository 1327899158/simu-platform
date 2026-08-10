// 游客预览页仅展示大厅布局，不加载订单数据，也不开放报价操作。
Page({
  goTab(e) {
    const page = e.currentTarget.dataset.page;
    if (!page || page === 'market') return;
    wx.redirectTo({ url: `/pages/guest-${page}/index` });
  },
});
