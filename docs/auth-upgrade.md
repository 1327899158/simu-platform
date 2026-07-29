# 认证体系迁移部署指南

本文档说明登录/注册/找回密码从 **Demo（零依赖 Node + SQLite，Mock 通道）** 迁移到 **生产（NestJS + Prisma + MySQL + 腾讯云短信/真实微信 jscode2session）** 的步骤。

Demo 现已支持三种登录方式，全部真实可用，未配置第三方凭据时走 Mock：

| 方式 | Demo 接口 | 生产目标 |
|------|-----------|----------|
| 账号密码登录 | `POST /api/auth/login-password` | 不变（密码哈希换 argon2/bcrypt） |
| 手机验证码登录 | `POST /api/auth/login-sms` | 接腾讯云短信下发 |
| 微信授权登录 | `POST /api/auth/wx-login`（wx.login→code→jscode2session） | 真实 jscode2session |

配套：注册 `POST /api/auth/register`、找回密码 `POST /api/auth/password/forgot`、发送验证码 `POST /api/auth/sms/send`、token 刷新 `POST /api/auth/refresh`。

---

## 一、Demo 现状与开关

所有 Mock 行为由 `server/.env` 控制，不改代码即可切换：

| 变量 | 默认 | 说明 |
|------|------|------|
| `WX_MOCK` | 1 | 1=openid=`mock_`+code（同设备同角色=同账号，便于演示）；0=真实 jscode2session |
| `SMS_MOCK` | 1 | 1=验证码随发送接口返回（不真实下发），控制台打印；0=调腾讯云短信 |
| `JWT_SECRET` | dev-secret | 生产必须改随机长串 |
| `ACCESS_TTL_SEC` | 7200 | access token 有效期 |
| `REFRESH_TTL_SEC` | 2592000 | refresh token 有效期（30 天） |
| `PASSWORD_MIN_LEN` | 8 | 密码最小长度 |
| `SMS_CODE_TTL_SEC` | 300 | 验证码有效期 5 分钟 |
| `SMS_SEND_INTERVAL_SEC` | 60 | 同手机号同用途重发间隔 |

**Demo 联调方式**：保持 `WX_MOCK=1 SMS_MOCK=1`。点"获取验证码"后，验证码会以 toast 形式显示并在卡上以"测试验证码：xxxxxx"提示，可直接填入完成注册/登录/重置全流程；微信登录直接进入，无需真实 AppID。

---

## 二、密码体系迁移

Demo 用 Node 内置 `crypto.scryptSync`，存储格式 `scrypt$<salt-hex>$<hash-hex>`，零依赖、足够安全。

生产（NestJS）建议换 `argon2`（首选）或 `bcrypt`：

```ts
// 1) 装 argon2：pnpm add argon2
// 2) AuthService
import * as argon2 from 'argon2';
hashPassword(plain)   -> argon2.hash(plain)
verifyPassword(p, h)  -> argon2.verify(h, p)
```

迁移时对存量用户：旧 `scrypt$...` 格式可继续校验（保留 verifyPassword 作 fallback），用户首次登录成功后用 argon2 重新哈希并更新（平滑升级，无感）。

Prisma schema 已为 `User.passwordHash String?`（字段名对应），DTO 用 `class-validator` 加 `@MinLength(8) @IsString()`。

---

## 三、短信验证码迁移到腾讯云短信

Demo 把验证码存 SQLite `sms_codes` 表（phone/code/purpose/expiresAt/consumed），生产改 Redis 存（key 如 `sms:login:138xxxx`，TTL=有效期），便于水平扩展与自动过期。

**接入腾讯云短信**（`server/src/routes/auth.js` 的 `sendTencentSms` 是预留接入点）：

1. 开通腾讯云短信：签名审批（`随风仿真`）、正文模板审核（模板参数 `${1}`=验证码）。
2. 在 `server/.env` 配置：
   ```
   SMS_MOCK=0
   TENCENT_SECRET_ID=AKIDxxxx
   TENCENT_SECRET_KEY=xxxx
   TENCENT_SMS_SDK_APP_ID=1400xxxx
   TENCENT_SMS_SIGN=随风仿真
   TENCENT_SMS_TPL=1400xxx
   ```
3. 装官方 SDK：`pnpm add tencentcloud-sdk-nodejs-sms`，实现 `sendTencentSms`：
   ```ts
   const tencentcloud = require('tencentcloud-sdk-nodejs-sms');
   const { SmsClient } = tencentcloud.sms.v20210111;
   const client = new SmsClient({ credential: {
     secretId: cfg.tencentSms.secretId, secretKey: cfg.tencentSms.secretKey,
   }, region: 'ap-guangzhou' });
   await client.SendSms({
     SmsSdkAppId: cfg.tencentSms.sdkAppId,
     SignName: cfg.tencentSms.signName,
     TemplateId: cfg.tencentSms.templateId,
     PhoneNumberSet: [`+86${phone}`],
     TemplateParamSet: [code, String(cfg.smsCodeTtlSec / 60)],
   });
   ```
4. 安全加固：图形验证码/防刷（同 IP 限频）、验证码用途隔离（register/login/reset 不互通，Demo 已隔离）、一次性消费（Demo 已实现 `consumed` 标记，Redis 用 `DEL`）。

> 备选：微信「手机号快速验证组件」（`button open-type="getPhoneNumber"`，0.03 元/次）可在小程序端一键获取已绑定手机号，免短信成本，适合"本机号登录"。建议作为第四种快捷入口补充，不替代短信验证码（换机/号需要短信）。

---

## 四、微信授权登录迁移

Demo 已完整实现真实通道（`code2Session`），`WX_MOCK=0` 即生效：

1. `server/.env`：
   ```
   WX_MOCK=0
   WX_APPID=wx你的小程序AppID
   WX_SECRET=你的小程序secret
   ```
2. 小程序端 `miniapp/utils/auth.js` 的 `loginByWx` 已在 `WX_MOCK=false` 时走 `wx.login()` 拿真实 code（`miniapp/utils/config.js` 的 `WX_MOCK` 需同步置 false）。
3. 后端调 `https://api.weixin.qq.com/sns/jscode2session?appid=&secret=&js_code=&grant_type=authorization_code`，拿 `openid`+`session_key`，按 openid upsert User。
4. 坑：code 一次性有效，40163=code 已用，前端需重新 `wx.login()`。
5. 昵称头像：`getUserProfile` 已废弃，新方案用 `chooseAvatar` + 昵称输入（小程序基础库 2.21.2+）；当前 Demo 在真实模式下调 `wxGetUserProfile`，迁移时改为引导用户手动设置昵称头像。

NestJS 侧：`AuthService.wxLogin` 直接平移 `code2Session` 逻辑，差异仅在 HTTP 客户端（用 `@nestjs/axios` 的 `HttpService`）。

---

## 五、Token 体系迁移

Demo：JWT(HS256) 自实现 + `refresh_tokens` 表存 refresh token（一次性旋转）。生产保持同模型：

- 用 `@nestjs/jwt` 的 `JwtService` 签发/校验，payload 仅 `{ sub, role }`，access 2h。
- refresh token 改存 **Redis**（key=`refresh:<token>`，value=userId，TTL 30 天），吊销即 `DEL`；旋转逻辑不变（用后即删、签发新对）。
- `@Public()` 装饰器放行 `/auth/*`、支付回调、健康检查；其余路由默认 `JwtAuthGuard`。
- 401 静默刷新：前端 `miniapp/utils/request.js` 已实现——收到 401 自动用 refresh 换新并重放一次，失败才回登录页。迁移时此逻辑不动。

---

## 六、数据模型对照

Demo `users` 表已与 `prisma/schema.prisma` 的 `User` 模型字段对齐：

- `phone String? @unique`（手机号，账号密码/验证码登录主键）
- `openid String? @unique`（微信登录主键）
- `passwordHash String?`（Demo 用 ALTER 新增，Prisma 加该字段即可）
- `status UserStatus @default(ACTIVE)`

迁移时 Prisma schema 加 `passwordHash String?` 字段，`prisma migrate dev` 生成迁移。`sms_codes` 表生产不入库，改 Redis，不进 Prisma schema。

---

## 七、生产前检查清单

- [ ] `JWT_SECRET` 已设为 32+ 位随机串
- [ ] `WX_MOCK=0`、`WX_APPID`/`WX_SECRET` 为正式小程序凭据
- [ ] `SMS_MOCK=0`、腾讯云短信签名/模板已审批通过、凭据已配
- [ ] `ACCESS_TTL_SEC`/`REFRESH_TTL_SEC` 按策略设定，refresh 存 Redis
- [ ] 密码哈希换 argon2（或保留 scrypt 并按需升级）
- [ ] 短信加图形验证码 + 同 IP/手机号限频防刷
- [ ] `request/uploadFile` 合法域名为已备案 HTTPS 域名
- [ ] 《用户隐私政策》《用户服务协议》在注册入口可达
- [ ] 账号注销入口可用（提审硬性要求，见总体方案 8.1）

---

## 八、与本 Demo 的关系

| 环节 | Demo 实现 | 生产实现 |
|------|-----------|----------|
| 账号密码 | scrypt 哈希 + SQLite | argon2 + MySQL |
| 短信验证码 | SQLite 表 + Mock 返回 | Redis + 腾讯云短信 |
| 微信登录 | mock openid / 真实 jscode2session | 真实 jscode2session |
| token | 自实现 JWT + refresh 表 | @nestjs/jwt + Redis refresh |
| 鉴权中间件 | `lib/auth-mw.js` Bearer 校验 | NestJS JwtAuthGuard + @Public |

业务核心（注册/登录/重置/选角色/补资料/订单/支付/会话）在 Demo 里就是真实实现，迁移时**接口契约与字段不变，仅替换底层存储与第三方通道**，前端零改动。
