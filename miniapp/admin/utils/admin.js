const { request } = require('../../utils/request');

const STORAGE_KEY = 'adminProfile';

async function loadAdmin() {
  const profile = await request('GET', '/admin/me', null, { silent: true });
  wx.setStorageSync(STORAGE_KEY, profile);
  const app = getApp();
  if (app) {
    app.globalData.adminMode = true;
    if (typeof app.stopUnreadPoll === 'function') app.stopUnreadPoll();
  }
  return profile;
}

function getAdmin() {
  return wx.getStorageSync(STORAGE_KEY) || null;
}

function hasPermission(profile, permission) {
  const list = (profile && profile.permissions) || [];
  return list.includes('*') || list.includes(permission);
}

function exitAdmin() {
  wx.removeStorageSync(STORAGE_KEY);
  const app = getApp();
  if (app) {
    app.globalData.adminMode = false;
    if (typeof app.startUnreadPoll === 'function') app.startUnreadPoll();
  }
  wx.reLaunch({ url: '/pages/home/index' });
}

function denyAndExit(message) {
  wx.removeStorageSync(STORAGE_KEY);
  wx.showModal({
    title: '无法进入管理端',
    content: message || '当前微信账号没有管理员权限。',
    showCancel: false,
    complete: () => {
      const app = getApp();
      if (app) {
        app.globalData.adminMode = false;
        if (typeof app.startUnreadPoll === 'function') app.startUnreadPoll();
      }
      wx.reLaunch({ url: '/pages/home/index' });
    },
  });
}

module.exports = { loadAdmin, getAdmin, hasPermission, exitAdmin, denyAndExit };
