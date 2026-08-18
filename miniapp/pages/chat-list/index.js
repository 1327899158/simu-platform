const { ensureLogin, getUser } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { timeShort } = require('../../utils/format');
const { BASE_URL } = require('../../utils/config');
const ORIGIN = BASE_URL.replace(/\/api$/, '');

function resolveUrl(url) {
  return url && url.startsWith('/') ? ORIGIN + url : (url || '');
}

Page({
  data: { items: [], role: '', unreadTotal: 0 },
  onShow() {
    const user = ensureLogin();
    if (user) {
      this.setData({ role: user.role });
      const tabBar = this.getTabBar && this.getTabBar();
      if (tabBar && tabBar.syncTabBar) tabBar.syncTabBar(user.role, '/pages/chat-list/index');
      this.load();
    }
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    let data;
    try {
      data = await request('GET', '/conversations', null, { silent: true });
    } catch (e) {
      wx.showToast({ title: e.message || '消息列表加载失败', icon: 'none' });
      return;
    }
    const list = (data || []).map((c) => ({
      ...c,
      peer: { ...c.peer, avatarUrl: resolveUrl(c.peer?.avatarUrl) },
      time: timeShort(c.lastMsgAt),
      lastText: c.lastMessage
        ? (c.lastMessage.type === 'TEXT' || c.lastMessage.type === 'SYSTEM'
          ? c.lastMessage.content : '[文件]')
        : '暂无消息',
    }));
    this.setData({
      items: list,
      unreadTotal: list.reduce((s, c) => s + (c.unread || 0), 0),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/chat-room/index?id=${e.currentTarget.dataset.id}` }); },
  goOrder(e) {
    e.stopPropagation && e.stopPropagation();
    const { oid, role } = e.currentTarget.dataset;
    const mode = role === 'ENGINEER' ? 'market' : 'customer';
    wx.navigateTo({ url: `/pages/order-detail/index?id=${oid}&mode=${mode}` });
  },
});
