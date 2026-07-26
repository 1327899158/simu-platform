/**
 * 后端地址：
 * - 开发者工具本地联调：http://127.0.0.1:3000/api（工具里勾选「不校验合法域名」）
 * - 真机预览：改为电脑局域网 IP，如 http://192.168.1.8:3000/api（手机与电脑同一 WiFi）
 * - 部署后：https://api.你的域名/api
 * WX_MOCK 与 server/.env 的 WX_MOCK 保持一致。
 */
module.exports = {
  BASE_URL: 'http://127.0.0.1:3000/api',
  WX_MOCK: true,
};
