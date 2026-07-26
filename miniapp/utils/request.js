/** 统一请求封装：自动带 token、401 静默刷新并重放一次、错误统一 toast。 */
const { BASE_URL } = require('./config');

const T = {
  get access() { return wx.getStorageSync('accessToken') || ''; },
  get refresh() { return wx.getStorageSync('refreshToken') || ''; },
  save(t) {
    wx.setStorageSync('accessToken', t.accessToken);
    wx.setStorageSync('refreshToken', t.refreshToken);
  },
  clear() {
    wx.removeStorageSync('accessToken');
    wx.removeStorageSync('refreshToken');
    wx.removeStorageSync('user');
  },
};

function raw(method, url, data, header = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      header: { 'Content-Type': 'application/json', ...header },
      success: resolve,
      fail: (e) => reject(new Error(e.errMsg || '网络错误')),
    });
  });
}

let refreshing = null;
function doRefresh() {
  if (!refreshing) {
    refreshing = raw('POST', '/auth/refresh', { refreshToken: T.refresh })
      .then((res) => {
        if (res.data && res.data.code === 0) { T.save(res.data.data); return true; }
        return false;
      })
      .catch(() => false)
      .finally(() => setTimeout(() => { refreshing = null; }, 0));
  }
  return refreshing;
}

function toLogin() {
  T.clear();
  wx.reLaunch({ url: '/pages/login/index' });
}

/**
 * request('GET', '/orders/mine', { status: 'QUOTING' })
 * GET 的 data 转 query；错误默认 toast，可传 { silent: true } 关闭。
 */
async function request(method, url, data, opt = {}) {
  const header = {};
  if (!opt.noAuth && T.access) header['Authorization'] = 'Bearer ' + T.access;
  let res = await raw(method, url, data, header);
  if (res.statusCode === 401 && !opt.noAuth && T.refresh) {
    const okFlag = await doRefresh();
    if (!okFlag) { toLogin(); throw new Error('登录已过期'); }
    header['Authorization'] = 'Bearer ' + T.access;
    res = await raw(method, url, data, header);
  }
  const body = res.data || {};
  if (res.statusCode === 200 && body.code === 0) return body.data;
  const msg = body.message || `请求失败(${res.statusCode})`;
  if (!opt.silent) wx.showToast({ title: msg, icon: 'none' });
  const e = new Error(msg);
  e.statusCode = res.statusCode;
  e.code = body.code;
  throw e;
}

/** 上传文件（wx.uploadFile 走 multipart，与后端解析器对应） */
function upload(filePath, { kind = 'DOC', orderId = '', name = '' } = {}) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: BASE_URL + '/files/upload',
      filePath,
      name: 'file',
      formData: { kind, orderId },
      header: { Authorization: 'Bearer ' + T.access },
      success(res) {
        try {
          const body = JSON.parse(res.data);
          if (body.code === 0) resolve(body.data);
          else reject(new Error(body.message || '上传失败'));
        } catch (e) { reject(e); }
      },
      fail: (e) => reject(new Error(e.errMsg || '上传失败')),
    });
  });
}

module.exports = { request, upload, tokens: T, toLogin };
