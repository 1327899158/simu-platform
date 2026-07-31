/**
 * 聊天室（云开发版）。
 *
 * 实时推送：db.watch 监听云数据库 conv_messages 集合（主链路）。
 * 历史消息：GET /api/conversations/:id/messages 轮询兜底（初次加载 + db.watch 不可用时）。
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { ENV_ID } = require('../../utils/config');
const { timeShort } = require('../../utils/format');

const POLL_MS = 4000;

Page({
  data: {
    convId: '', myId: '', myOpenid: '', myAvatar: '',
    msgs: [], text: '', lastId: 0,
    scrollTop: 0, _tick: 0,
    sending: false,
    avatarSize: 48, bubbleMaxWidth: '70%', imageWidth: 360,
    peer: null,
  },
  _watcher: null,
  _pollTimer: null,
  _pullInFlight: false,
  _seenIds: new Set(),
  _shouldScrollBottom: false,

  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    this.setData({
      convId: q.id,
      myId: user.id,
      myOpenid: user.openid || '',
      myAvatar: user.avatarUrl || '',
    });
    this._calcSize();
  },

  _calcSize() {
    wx.getSystemInfo({
      success: (res) => {
        const w = res.windowWidth;
        let avatarSize = 48, bubbleMaxWidth = '70%', imageWidth = 360;
        if (w < 350) { avatarSize = 36; bubbleMaxWidth = '65%'; imageWidth = Math.round(w * 0.6 * 750 / res.screenWidth); }
        else if (w < 600) { avatarSize = 48; bubbleMaxWidth = '70%'; imageWidth = Math.round(w * 0.55 * 750 / res.screenWidth); }
        else { avatarSize = 56; bubbleMaxWidth = '60%'; imageWidth = Math.round(w * 0.45 * 750 / res.screenWidth); }
        this.setData({ avatarSize, bubbleMaxWidth, imageWidth });
      },
    });
  },

  async onShow() {
    this._shouldScrollBottom = true;
    // 先拉历史消息
    await this.pullHistory();
    // 启动 db.watch（主链路）
    this._startWatch();
    // 启动轮询兜底（db.watch 失败时保底）
    this._startPoll();
  },

  onHide() {
    this._stopWatch();
    this._stopPoll();
    getApp().fetchUnread && getApp().fetchUnread();
  },
  onUnload() {
    this._stopWatch();
    this._stopPoll();
  },

  // ---- db.watch 实时推送 ----
  _startWatch() {
    this._stopWatch();
    if (typeof wx.cloud === 'undefined') return; // 本地调试降级到轮询
    try {
      const db = wx.cloud.database({ env: ENV_ID });
      this._watcher = db.collection('conv_messages')
        .where({ convId: this.data.convId })
        .watch({
          onChange: (snap) => {
            if (!snap.docs || snap.type !== 'init') {
              // 收到新增事件：重新拉取增量
              this._pullIncremental();
            }
          },
          onError: (err) => {
            console.error('[db.watch] error', err);
            // db.watch 失败，轮询兜底继续运行
          },
        });
    } catch (e) {
      console.error('[db.watch] start failed', e);
    }
  },

  _stopWatch() {
    if (this._watcher) {
      try { this._watcher.close(); } catch (e) {}
      this._watcher = null;
    }
  },

  // ---- 轮询兜底 ----
  _startPoll() {
    this._stopPoll();
    this._pollTimer = setInterval(() => this._pullIncremental(), POLL_MS);
  },
  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  // ---- 消息拉取 ----
  /** 首次拉取历史消息（after=0） */
  async pullHistory() {
    try {
      const data = await request('GET', `/conversations/${this.data.convId}/messages`,
        { after: 0, limit: 100 }, { silent: true });
      if (!data) return;
      const peerChange = data.peer && !this.data.peer;
      if (peerChange) this.setData({ peer: data.peer });
      const mapped = this._mapMsgs(data.items || []);
      this._seenIds = new Set(mapped.map((m) => m.id));
      this.setData({ msgs: mapped, lastId: data.lastId });
      this._scrollBottom();
    } catch (e) { /* 静默 */ }
    finally { this._pullInFlight = false; }
  },

  /** 增量拉取（after=lastId） */
  async _pullIncremental() {
    if (!this.data.convId || this._pullInFlight) return;
    this._pullInFlight = true;
    try {
      const data = await request('GET', `/conversations/${this.data.convId}/messages`,
        { after: this.data.lastId, limit: 50 }, { silent: true });
      if (!data || !data.items.length) {
        this._pullInFlight = false;
        return;
      }
      const peerArrived = data.peer && !this.data.peer;
      if (peerArrived) this.setData({ peer: data.peer });
      const mapped = this._mapMsgs(data.items).filter((m) => !this._seenIds.has(m.id));
      mapped.forEach((m) => this._seenIds.add(m.id));
      if (!mapped.length) {
        this.setData({ lastId: Math.max(this.data.lastId, Number(data.lastId || 0)) });
        this._pullInFlight = false;
        return;
      }
      // peer 到达时，把已渲染的消息也补上 senderAvatar
      if (peerArrived && this.data.msgs.length) {
        this.setData({ msgs: this._mapMsgs(this.data.msgs) });
      }
      const shouldScroll = this._shouldScrollBottom;
      this._shouldScrollBottom = false;
      this.setData({ msgs: this.data.msgs.concat(mapped), lastId: data.lastId });
      if (shouldScroll) this._scrollBottom();
      this._pullInFlight = false;
    } catch (e) { /* 静默 */
      this._pullInFlight = false;
    }
  },

  _mapMsgs(items) {
    const myId = this.data.myId;
    const myAvatar = this.data.myAvatar || '';
    const peerAvatar = this.data.peer && this.data.peer.avatarUrl ? this.data.peer.avatarUrl : '';
    return items.map((m) => ({
      ...m,
      id: Number(m.id),
      mine: m.senderId === myId,
      sys: m.senderId === 'SYSTEM',
      senderAvatar: m.senderId === myId ? myAvatar : peerAvatar,
      time: timeShort(m.createdAt),
      anchor: 'm' + m.id,
      imgUrl: m.imgUrl || '',
    }));
  },

  _scrollBottom() {
    this.setData({ _tick: this.data._tick + 1 }, () => {
      this.setData({ scrollTop: 99999 + this.data._tick });
    });
  },

  // ---- 发消息 ----
  input(e) { this.setData({ text: e.detail.value }); },

  async send() {
    const text = (this.data.text || '').trim();
    if (!text || this.data.sending) return;
    this.setData({ sending: true, text: '' }); // 乐观清空输入框
    try {
      await request('POST', `/conversations/${this.data.convId}/messages`, { type: 'TEXT', content: text });
      this._shouldScrollBottom = true;
      await this._pullIncremental();
    } catch (e) {
      // 发送失败，回填文本并聚焦
      this.setData({ text });
      wx.showToast({ title: e.message || '消息发送失败', icon: 'none' });
    }
    this.setData({ sending: false });
  },

  sendImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'],
      success: async (r) => {
        try {
          const up = await upload(r.tempFiles[0].tempFilePath, { kind: 'IMAGE' });
          await request('POST', `/conversations/${this.data.convId}/messages`,
            { type: 'IMAGE', fileId: up.id });
          this._shouldScrollBottom = true;
          await this._pullIncremental();
        } catch (e) {
          wx.showToast({ title: e.message || '发送失败', icon: 'none' });
        }
      },
    });
  },

  previewImg(e) {
    const url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url], current: url });
  },

  async openFile(e) {
    const fid = e.currentTarget.dataset.fid;
    try {
      const info = await request('GET', `/files/${fid}/url`);
      wx.showLoading({ title: '下载中…' });
      wx.downloadFile({
        url: info.url,
        success: (res) => {
          wx.hideLoading();
          wx.openDocument({ filePath: res.tempFilePath, showMenu: true,
            fail: () => wx.showToast({ title: '已下载', icon: 'none' }) });
        },
        fail: () => { wx.hideLoading(); wx.showToast({ title: '下载失败', icon: 'none' }); },
      });
    } catch (err) { wx.showToast({ title: err.message || '文件打开失败', icon: 'none' }); }
  },
});
