const { ensureLogin } = require('../../utils/auth');
const { request } = require('../../utils/request');
const { timeShort } = require('../../utils/format');
Page({
  data: { items: [] },
  onShow() { if (ensureLogin()) this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const data = await request('GET', '/conversations', null, { silent: true }).catch(() => []);
    this.setData({
      items: (data || []).map((c) => ({
        ...c,
        time: timeShort(c.lastMsgAt),
        lastText: c.lastMessage
          ? (c.lastMessage.type === 'TEXT' || c.lastMessage.type === 'SYSTEM'
            ? c.lastMessage.content : '[文件]')
          : '暂无消息',
      })),
    });
  },
  open(e) { wx.navigateTo({ url: `/pages/chat-room/index?id=${e.currentTarget.dataset.id}` }); },
});
