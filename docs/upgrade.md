# Mock → 真实环境切换指南

Demo 的三个外部依赖（微信登录、微信支付、文件存储）都做成了开关式。拿到真实凭据后按本文逐项切换，业务代码不动。

## 1. 真实微信登录（约 10 分钟）

前提：已注册小程序（企业主体），拿到 AppID / AppSecret。

1. `server/.env`：`WX_MOCK=0`，填 `WX_APPID`、`WX_SECRET`（AppSecret 只放服务端，永不进小程序代码）。
2. `miniapp/utils/config.js`：`WX_MOCK: false`；`project.config.json` 的 `appid` 换成真实 AppID。
3. 前端会自动改走 `wx.login()` 取 code（`utils/auth.js` 已实现）。注意 code 一次性有效，登录失败要重新 `wx.login()`（错误码 40163 即 code 被复用）。
4. 服务器出口 IP 需加入小程序后台「开发设置 → 服务器域名/IP 白名单」（如启用了 IP 白名单）。

工程师认证：真实模式下新工程师为 `PENDING`，需要审核置为 `APPROVED`（Demo 阶段可直接改库，后续由 Web 管理后台完成——见方案 M2）。

## 2. 真实微信支付 v3（约 1-2 天，含商户平台配置）

前提：微信支付商户号已开通 JSAPI 支付、已关联小程序 AppID、已设置 APIv3 密钥、已下载商户私钥并记录证书序列号；服务已部署到有备案 HTTPS 域名的服务器（回调硬前提）。

接入点已在代码里留好，共三处：

1. **下单**：`server/src/routes/orders.js` 的 `POST /api/orders/:id/pay` 中 `payProvider==='wechat'` 分支。调用 `POST https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi`（appid、mchid、description、out_trade_no（用 `createPayment` 生成的）、notify_url、amount.total=分、payer.openid），拿到 prepay_id 后用**商户私钥 RSA-SHA256** 签出小程序调起五参数（timeStamp/nonceStr/package=`prepay_id=xxx`/signType=RSA/paySign）返回前端。
2. **前端调起**：`miniapp/pages/order-detail/index.js` 的 `pay()`，把「模拟收银台 modal」替换为 `wx.requestPayment(五参数)`，成功后仍走现有的轮询确认逻辑。
3. **回调**：`server/src/routes/payments.js` 的 `POST /api/payments/notify`。流程：取 `Wechatpay-Serial/Timestamp/Nonce/Signature` 请求头 → 用**微信平台证书/公钥**验签（注意：验签用平台证书，签名用商户私钥，方向相反，这是第一大坑）→ `body.resource` 用 APIv3 密钥 AES-256-GCM 解密 → `trade_state==='SUCCESS'` 时调用现成的 `applyPaymentSuccess(out_trade_no, transaction_id, evt)`（幂等逻辑已就位，重复通知安全）→ 应答 `{"code":"SUCCESS"}`。
4. **兜底**：建议加「主动查单」定时任务（下单后每 30 秒查一次共 10 次），查单结果同样喂给 `applyPaymentSuccess`；超时关单已由 `sweepExpiredAwaitingPayment` 实现，再补调用微信「关闭订单」接口即可。
5. 联调：`PAY_AMOUNT_OVERRIDE_FEN=1` 真实支付 0.01 元验证全链路，商户平台有「回调重发」工具可验证幂等。

零依赖实现验签/解密所需的 `crypto` 能力 Node 内置都有；迁移到 NestJS 后也可直接用 `wechatpay-node-v3` 等库减少手写。

## 3. 文件切换 COS 直传（约 1 天）

1. 创建私有读写存储桶，配置 CORS（来源 `https://servicewechat.com`），开版本控制。
2. 建 CAM 子账号，策略仅允许 `orders/*` 前缀的 PutObject/GetObject。
3. 服务端加 `POST /api/files/sts`（用 `qcloud-cos-sts` 签 15 分钟临时密钥，限定 `orders/{userId}/{uuid}/` 前缀）；`files.commit` 落库 cosKey。
4. 小程序端上传从 `wx.uploadFile` 换成 `cos-wx-sdk-v5` 的 `uploadFile`（自动分片/进度/续传），`utils/upload.js` 只改内部实现。
5. 下载：`GET /api/files/:id/url` 改为返回 COS 预签名 URL（10 分钟），**权限判断函数 `canReadFile` 原样保留**——这是模型文件保密的核心，别在切换时丢掉。

## 4. 内容安全（提审硬要求）

上线前把 `services/chat-svc.js` 的 `contentCheck` 替换为微信 `msgSecCheck`（文本，需 access_token 与用户 openid）与 `mediaCheck`（图片异步）。命中即拒发的交互前端已做好。同时在小程序后台完成 UGC 场景声明。

## 5. 迁移 NestJS + Prisma + MySQL（M1 后半程）

API 契约（docs/api.md）与表结构（prisma/schema.prisma）保持不变，迁移是机械工作：

1. `nest new server-nest`，模块划分照搬 `src/routes/` 的八个域。
2. `prisma migrate dev` 用蓝图生成 MySQL 迁移；`src/db.js` 里的每条 SQL 对应一个 Prisma 查询。
3. 事务：`tx(fn)` → `prisma.$transaction`；「带 where 状态条件的 UPDATE」→ `updateMany`（乐观锁写法一致）。
4. 鉴权：`lib/auth-mw.js` → NestJS Guard；校验：`lib/util.js` 的 v.* → class-validator DTO。
5. 迁移完成的判定标准：**不改一行小程序代码，`npm run e2e` 39 条用例全绿**（把 e2e 的 BASE 指向新服务即可）。
