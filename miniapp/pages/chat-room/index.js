/** 聊天室：4 秒轮询增量拉取（方案A保底通道），支持文字与图片/文件消息。 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { BASE_URL } = require('../../utils/config');
const { timeShort } = require('../../utils/format');

const ORIGIN = BASE_URL.replace(/\/api$/, '');
const POLL_MS = 4000;

Page({
  data: { convId: '', myId: '', msgs: [], text: '', lastId: 0, scrollInto: '', sending: false },
  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    this.setData({ convId: q.id, myId: user.id });
  },
  onShow() {
    this.pull(true);
    this.timer = setInterval(() => this.pull(false), POLL_MS);
  },
  onHide() { clearInterval(this.timer); },
  onUnload() { clearInterval(this.timer); },

  async pull(first) {
    try {
      const data = await request(
        'GET', `/conversations/${this.data.convId}/messages`,
        { after: first ? 0 : this.data.lastId, limit: 100 }, { silent: true }
      );
      if (!data.items.length) return;
      const mapped = data.items.map((m) => ({
        ...m,
        mine: m.senderId === this.data.myId,
        sys: m.senderId === 'SYSTEM',
        time: timeShort(m.createdAt),
        anchor: 'm' + m.id,
      }));
      this.setData({
        msgs: first ? mapped : this.data.msgs.concat(mapped),
        lastId: data.lastId,
        scrollInto: 'm' + data.lastId,
      });
    } catch (e) { /* 网络抖动下静默，下一轮再试 */ }
  },

  input(e) { this.setData({ text: e.detail.value }); },
  async send() {
    const text = (this.data.text || '').trim();
    if (!text || this.data.sending) return;
    this.setData({ sending: true });
    try {
      await request('POST', `/conversations/${this.data.convId}/messages`, { type: 'TEXT', content: text });
      this.setData({ text: '' });
      await this.pull(false);
    } catch (e) { /* 违规词等已 toast */ }
    this.setData({ sending: false });
  },

  sendImage() {
    const that = this;
    wx.chooseMedia({
      count: 1, mediaType: ['image'],
      success: async (r) => {
        try {
          const up = await upload(r.tempFiles[0].tempFilePath, { kind: 'IMAGE' });
          await request('POST', `/conversations/${that.data.convId}/messages`, { type: 'IMAGE', fileId: up.fileId });
          that.pull(false);
        } catch (e) {}
      },
    });
  },

  async openFile(e) {
    const fid = e.currentTarget.dataset.fid;
    const type = e.currentTarget.dataset.type;
    try {
      const info = await request('GET', `/files/${fid}/url`);
      const full = ORIGIN + info.url;
      if (type === 'IMAGE') {
        wx.previewImage({ urls: [full] });
      } else {
        wx.downloadFile({
          url: full,
          success: (res) => wx.openDocument({
            filePath: res.tempFilePath, showMenu: true,
            fail: () => wx.showToast({ title: '已下载', icon: 'none' }),
          }),
        });
      }
    } catch (err) {}
  },
});
