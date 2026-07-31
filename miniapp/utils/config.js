/**
 * 云开发初始化与请求封装（云开发版）。
 * 使用 wx.cloud.callContainer 替代 wx.request + JWT Bearer token。
 */

const ENV_ID = 'cloud1-d8gh7xyw56d7c185f'; // ← 改为你的云开发环境 ID
const SERVICE_NAME = 'simu-api'; // 云托管服务名

module.exports = {
  ENV_ID,
  SERVICE_NAME,
  // 兼容旧代码，BASE_URL 仅本地调试用
  BASE_URL: 'http://127.0.0.1:8787/api',
};
