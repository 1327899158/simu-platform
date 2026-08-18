/**
 * 聊天室（云开发版）。
 *
 * 实时推送：db.watch 监听云数据库 conv_messages 集合（主链路）。
 * 历史消息：GET /api/conversations/:id/messages 轮询兜底（初次加载 + db.watch 不可用时）。
 */
const { ensureLogin, getUser } = require('../../utils/auth');
const { request, upload } = require('../../utils/request');
const { ENV_ID } = require('../../utils/config');
const { downloadAndOpen, formatDownloadError } = require('../../utils/cloud-file');
const { timeShort } = require('../../utils/format');

const POLL_MS = 4000;
const PULL_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('消息同步超时')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

Page({
  data: {
    convId: '', myId: '', myOpenid: '', myAvatar: '', role: '',
    msgs: [], text: '', lastId: 0,
    scrollTop: 0, _tick: 0,
    sending: false, imageSending: false,
    avatarSize: 48, bubbleMaxWidth: '70%', imageWidth: 360,
    peer: null,
    canSend: true, sendDisabledReason: '',
  },
  _watcher: null,
  _pollTimer: null,
  _pullInFlight: false,
  _pullQueued: false,
  _seenIds: new Set(),
  _shouldScrollBottom: false,

  onLoad(q) {
    const user = ensureLogin();
    if (!user) return;
    this._pullInFlight = false;
    this._pullQueued = false;
    this._seenIds = new Set();
    this.setData({
      convId: q.id,
      myId: user.id,
      myOpenid: user.openid || '',
      myAvatar: user.avatarUrl || '',
      role: user.role || '',
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
    this._pullQueued = false;
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
    if (!this.data.convId) return;
    if (this._pullInFlight) {
      this._pullQueued = true;
      return;
    }
    this._pullInFlight = true;
    try {
      const data = await withTimeout(
        request('GET', `/conversations/${this.data.convId}/messages`,
          { after: 0, limit: 100 }, { silent: true }),
        PULL_TIMEOUT_MS,
      );
      if (!data) return;
      const peerChange = data.peer && !this.data.peer;
      if (peerChange) this.setData({ peer: data.peer });
      const mapped = this._mapMsgs(data.items || []);
      this._seenIds = new Set(mapped.map((m) => m.id));
      this.setData({
        msgs: mapped,
        lastId: data.lastId,
        canSend: data.canSend !== false,
        sendDisabledReason: data.sendDisabledReason || '',
      });
      this._scrollBottom();
    } catch (e) {
      console.warn('[chat] pullHistory failed', e.message);
    } finally {
      this._finishPull();
    }
  },

  /** 增量拉取（after=lastId） */
  async _pullIncremental() {
    if (!this.data.convId) return;
    if (this._pullInFlight) {
      this._pullQueued = true;
      return;
    }
    this._pullInFlight = true;
    try {
      const data = await withTimeout(
        request('GET', `/conversations/${this.data.convId}/messages`,
          { after: this.data.lastId, limit: 50 }, { silent: true }),
        PULL_TIMEOUT_MS,
      );
      if (!data) return;
      this.setData({
        canSend: data.canSend !== false,
        sendDisabledReason: data.sendDisabledReason || '',
      });
      if (!data.items.length) {
        return;
      }
      const peerArrived = data.peer && !this.data.peer;
      if (peerArrived) this.setData({ peer: data.peer });
      const mapped = this._mapMsgs(data.items).filter((m) => !this._seenIds.has(m.id));
      mapped.forEach((m) => this._seenIds.add(m.id));
      if (!mapped.length) {
        this.setData({ lastId: Math.max(this.data.lastId, Number(data.lastId || 0)) });
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
    } catch (e) {
      console.warn('[chat] pullIncremental failed', e.message);
    } finally {
      this._finishPull();
    }
  },

  _finishPull() {
    this._pullInFlight = false;
    if (!this._pullQueued) return;
    this._pullQueued = false;
    setTimeout(() => this._pullIncremental(), 0);
  },

  _mapMsgs(items) {
    const myId = this.data.myId;
    const myAvatar = this.data.myAvatar || '';
    const peerAvatar = this.data.peer && this.data.peer.avatarUrl ? this.data.peer.avatarUrl : '';
    return items.map((m) => ({
      ...m,
      id: Number(m.id),
      mine: m.senderId === myId,
      sys: m.type === 'SYSTEM' || m.senderId === 'SYSTEM',
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

  /** 发送接口已经返回成功时立即上屏，不依赖 db.watch 或下一次轮询。 */
  _appendSentMessage(raw, localImgUrl = '') {
    const mapped = this._mapMsgs([{ ...raw, imgUrl: localImgUrl || raw.imgUrl || '' }])[0];
    if (!mapped || this._seenIds.has(mapped.id)) return;
    this._seenIds.add(mapped.id);
    this.setData({ msgs: this.data.msgs.concat(mapped) });
    this._scrollBottom();
  },

  // ---- 发消息 ----
  input(e) { this.setData({ text: e.detail.value }); },

  async send() {
    if (!this.data.canSend) {
      return wx.showToast({ title: this.data.sendDisabledReason || '当前会话不可发送消息', icon: 'none' });
    }
    const text = (this.data.text || '').trim();
    if (!text || this.data.sending) return;
    this.setData({ sending: true, text: '' }); // 乐观清空输入框
    try {
      const sent = await request('POST', `/conversations/${this.data.convId}/messages`, { type: 'TEXT', content: text });
      this._appendSentMessage(sent);
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
    if (!this.data.canSend) {
      wx.showToast({ title: this.data.sendDisabledReason || '当前会话不可发送消息', icon: 'none' });
      return;
    }
    if (this.data.imageSending) return;
    wx.chooseMedia({
      count: 1, mediaType: ['image'],
      success: async (r) => {
        const localPath = r.tempFiles[0].tempFilePath;
        this.setData({ imageSending: true });
        try {
          const up = await upload(localPath, { kind: 'IMAGE' });
          const sent = await request('POST', `/conversations/${this.data.convId}/messages`,
            { type: 'IMAGE', fileId: up.id });
          this._appendSentMessage(sent, localPath);
          this._shouldScrollBottom = true;
          await this._pullIncremental();
        } catch (e) {
          wx.showToast({ title: e.message || '发送失败', icon: 'none' });
        } finally {
          this.setData({ imageSending: false });
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
    if (!fid || this._fileDownloadInFlight) return;
    this._fileDownloadInFlight = true;
    wx.showLoading({ title: '下载中…', mask: true });
    try {
      const info = await request('GET', `/files/${fid}/url`, null, { silent: true });
      const result = await downloadAndOpen(info);
      if (result && result.notice) {
        wx.hideLoading();
        await new Promise((resolve) => wx.showModal({
          title: '文件已下载', content: result.notice, showCancel: false, complete: resolve,
        }));
      }
    } catch (err) {
      wx.hideLoading();
      const diagnostic = formatDownloadError(err);
      console.error('[chat-file] download failed', {
        fileId: fid,
        statusCode: err.statusCode || null,
        stage: err.stage || null,
        detail: err.detail || err.message || 'unknown',
        traceId: err.traceId || null,
      });
      wx.showModal({ title: '附件下载失败', content: diagnostic, showCancel: false });
    } finally {
      wx.hideLoading();
      this._fileDownloadInFlight = false;
    }
  },

  openSystemAction(e) {
    const orderId = e.currentTarget.dataset.oid;
    if (!orderId) return;
    const mode = this.data.role === 'ENGINEER' ? 'market' : 'customer';
    wx.navigateTo({ url: `/pages/order-detail/index?id=${orderId}&mode=${mode}` });
  },
});
