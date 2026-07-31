'use strict';
/**
 * 云开发 SDK 单例。
 * 云托管容器环境内会自动注入 TENCENTCLOUD_SECRETID/SECRETKEY/SESSIONTOKEN，
 * @cloudbase/node-sdk 会自动读取，无需手动配置密钥。
 * 本地开发时需在 .env 配置 CLOUDBASE_ENV_ID 及 secretId/secretKey。
 */
const cloudbase = require('@cloudbase/node-sdk');
const { config } = require('./config');

let _app = null;

function getApp() {
  if (!_app) {
    // 云托管环境内：credentialType 自动感知注入凭据
    // 本地开发：从环境变量读取
    const opts = { env: config.cloudbaseEnv };
    if (process.env.CLOUDBASE_SECRET_ID) {
      opts.secretId = process.env.CLOUDBASE_SECRET_ID;
      opts.secretKey = process.env.CLOUDBASE_SECRET_KEY;
    }
    _app = cloudbase.init(opts);
  }
  return _app;
}

/** 访问云数据库 */
function getDB() { return getApp().database(); }

/** 访问云存储（用于获取下载临时链接） */
function getStorage() { return getApp(); }

module.exports = { getApp, getDB, getStorage };
