const { initCloud } = require('./utils/auth');
const { request } = require('./utils/request');
const UNREAD_POLL_MS = 10000;

App({
  globalData: { adminMode: false, unreadTotal: 0 },
  _unreadTimer: null,

  onLaunch() {
    // 初始化云开发 SDK
    initCloud();
    // 刷新用户信息
    this.refreshUser();
  },
  onShow() {
    // 管理分包使用独立数据流，进入管理模式后不轮询普通会话列表。
    if (this.globalData.adminMode) this.stopUnreadPoll();
    else this.startUnreadPoll();
  },
  onHide() {
    this.stopUnreadPoll();
  },

  async refreshUser() {
    const { getUser, saveUser } = require('./utils/auth');
    if (!getUser()) return;
    try {
      const user = await request('GET', '/me', null, { silent: true });
      if (user) saveUser(user);
    } catch (e) { /* 静默 */ }
  },

  startUnreadPoll() {
    this.stopUnreadPoll();
    this.fetchUnread();
    this._unreadTimer = setInterval(() => this.fetchUnread(), UNREAD_POLL_MS);
  },
  stopUnreadPoll() {
    if (this._unreadTimer) { clearInterval(this._unreadTimer); this._unreadTimer = null; }
  },

  async fetchUnread() {
    const { isLoggedIn } = require('./utils/auth');
    if (!isLoggedIn()) return;
    try {
      const list = await request('GET', '/conversations', null, { silent: true });
      const total = (list || []).reduce((sum, c) => sum + (c.unread || 0), 0);
      this.globalData.unreadTotal = total;
      const pages = getCurrentPages();
      const currentPage = pages.length ? pages[pages.length - 1] : null;
      const tabBar = currentPage && currentPage.getTabBar ? currentPage.getTabBar() : null;
      if (tabBar && tabBar.setUnreadTotal) tabBar.setUnreadTotal(total);
    } catch (e) { /* 静默 */ }
  },
});
