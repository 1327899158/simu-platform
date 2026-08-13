# 接口清单（云开发版）

统一响应：
- 成功：`{"code":0,"data":...}`
- 失败：`{"code":<4xxxx|5xxxx>,"message":"..."}`

鉴权（两条通道，服务端按顺序判定）：
1. `X-Session-Token: <token>` —— 账号密码 / 手机号验证码登录用户。有 token 时 **优先**匹配。
2. `X-WX-OPENID: <openid>` —— 微信小程序场景，`wx.cloud.callContainer` 自动注入，无需业务代码处理。

未通过任一通道 → `401 code=40100`，前端会自动 `wx.reLaunch('/pages/login/index')`。

金额规则：所有金额字段以 **分** 为整数存储与传输，字段名后缀 `Fen`。前端展示时才转元。

---

## 一、认证 Auth（`server/src/routes/auth.js` + `auth-multi.js`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/auth/wx-login` | 公开 | 微信一键登录 / 首登建档 / **显式角色切换** |
| POST | `/api/auth/bind-phone` | 登录 | `button open-type="getPhoneNumber"` 授权换取手机号 |
| POST | `/api/auth/request-sms` | 公开 | 请求短信验证码（`REGISTER`/`LOGIN`/`RESET_PWD`） |
| POST | `/api/auth/register` | 公开 | 账号密码 + 短信验证码注册 |
| POST | `/api/auth/login` | 公开 | 账号密码登录，返回 session token |
| POST | `/api/auth/phone-login` | 公开 | 手机号 + 短信验证码登录 |
| POST | `/api/auth/reset-password` | 公开 | 忘记密码：手机号 + 短信码 + 新密码 |
| POST | `/api/auth/logout` | 登录 | 服务端吊销 sessionToken |
| POST | `/api/dev/promote-engineer` | 登录 | 演示阶段自主认证（`ALLOW_ENGINEER_SELF_VERIFY=true` 才启用） |
| GET  | `/api/me` | 登录 | 当前用户信息（含 engineer 详情） |
| PATCH| `/api/me` | 登录 | 更新昵称 / 头像 fileID / 工程师资料 |

### 关键请求体

`POST /api/auth/wx-login`
```json
{ "roleHint": "customer" | "engineer", "nickname"?: "...", "avatarUrl"?: "cloud://..." }
```
- 已存在用户会按 `roleHint` **显式切换角色**（内部通过 `switchUserRole` 完成，`requireUser` 不再自动改角色）。

`POST /api/auth/register`
```json
{
  "username": "123456",   // 6-12 位纯数字
  "phone":    "13800000000",
  "password": "至少6位",
  "smsCode":  "6 位数字",
  "roleHint": "customer" | "engineer"
}
```

`POST /api/auth/{login,phone-login,reset-password}`：字段与文档描述一致，返回 `{ token, user }`。

### 统一 userView 结构

`GET /api/me`、`POST /api/auth/{wx-login,login,phone-login,register}` 等接口返回的 `user` 结构一致：
```jsonc
{
  "id": "u_xxx",
  "role": "CUSTOMER" | "ENGINEER",
  "nickname": "...",
  "avatarUrl": "cloud://...",
  "openid": "...",
  "username": "...",
  "phone": "...",
  "verifyStatus": "APPROVED"|"PENDING"|"REJECTED"|null,
  "engineer": null | {                 // 仅工程师角色返回
    "realName": "...",
    "intro": "...",
    "specialties": ["结构分析", ...],  // 数组
    "softwares":   ["ANSYS全系列", ...],
    "verifyStatus": "APPROVED"
  }
}
```

---

## 二、字典 Dicts

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/dicts` | 公开 | 软件 / 方向 / 工期选项 / 状态文案映射 |

返回：`{ softwares:[], directions:[], deliveryOptions:[{key,label,days}], orderStatus:{...}, quoteStatus:{...} }`

---

## 三、文件 Files

**上传流程（云开发版）**：小程序端 `wx.cloud.uploadFile` 直传云存储 → 拿到 `fileID`（`cloud://env.bucket/path`）→ 调 `POST /api/files/commit` 写入 `uploaded_files`。发布订单时在同一事务内校验文件归属，并写入 `order_attachments`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/files/upload` | 登录 | multipart 上传（本地降级用；生产不走此接口） |
| POST | `/api/files/commit` | 登录 | wx.cloud.uploadFile 成功后落库 |
| GET  | `/api/files/:id/url` | 权限矩阵 | 鉴权后返回云存储 `fileID`，由小程序直接下载 |
| GET  | `/api/orders/:id/files` | 登录 | 订单文件列表（按可读权限过滤） |
| DELETE | `/api/files/:id` | 上传者 | 删除尚未绑定订单的元数据；生产环境由小程序随后清理云对象 |

`POST /api/files/commit`
```json
{
  "fileID": "cloud://xxx",
  "name": "model.stp",
  "kind": "MODEL" | "DOC" | "IMAGE" | "RESULT",   // 默认 DOC
  "orderId": "o_xxx"?,
  "sizeBytes": 12345?
}
```
返回 `{ id, fileID, fileId, name, kind, sizeBytes }`。前端把 `id`（即数据库里的 uploaded_files.id）作为 `fileIds` 传给发单 / 交付接口。

单文件上限由云托管环境变量 `MAX_UPLOAD_MB` 控制，默认 `30`，允许范围为 `1-100`。`GET /api/dicts` 会把 `limits.maxUploadMb` 和 `limits.maxUploadBytes` 下发给小程序，前后端无需分别修改常量。

订单附件关系表 `order_attachments`：

| 字段 | 说明 |
|---|---|
| `orderId` | 订单 ID |
| `fileId` | `uploaded_files.id`，全局唯一绑定一个订单 |
| `uploaderId` | 上传用户 ID |
| `purpose` | `REQUIREMENT`（客户需求附件）、`RESULT`（工程师成果）或内部 `CHAT` 文件关联 |
| `createdAt` | 绑定时间 |

`GET /api/files/:id/url` 成功返回 `{ fileID, name, mime, sizeBytes }`。服务端只负责鉴权，不再生成临时 HTTPS 地址；小程序使用 `wx.cloud.downloadFile` 下载，避免云托管凭据链超时。

文件下载权限矩阵（`server/src/routes/files.js#canReadFile`，切换 COS 时保留）：
- 上传者本人 → 可读
- 订单客户 → 可读
- 已认证工程师（APPROVED）+ 订单为 `QUOTING` → 可读（报价期看需求文件）
- 已认证工程师 + `selectedQuote.engineerId === user.id` → 可读（选标后我是被选中的）
- 无 orderId 的 IMAGE（头像）→ 所有登录用户可读

---

## 四、订单 Orders

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST   | `/api/orders` | 客户 | 发布需求 |
| GET    | `/api/orders/mine` | 客户 | 我的订单（游标分页 `status&cursor&limit`） |
| GET    | `/api/orders/:id` | 属主 | 详情（客户视角） |
| DELETE | `/api/orders/:id` | 属主 | 仅 `QUOTING` 状态软删，同时把 `PENDING` 报价改为 `REJECTED` |
| POST   | `/api/orders/:id/select-quote` | 属主 | 选标：`QUOTING → AWAITING_PAYMENT`（事务乐观锁） |
| POST   | `/api/orders/:id/pay` | 属主 | 发起支付（mock/wechat 双模式） |
| POST   | `/api/orders/:id/pay/mock-confirm` | 属主 | 模拟支付确认（仅 `PAYMENT_MODE=mock`） |
| GET    | `/api/orders/:id/payment` | 属主 | 支付状态轮询 |
| POST   | `/api/orders/:id/deliver` | 被选工程师 | `IN_PROGRESS → DELIVERED` + 系统消息 |
| POST   | `/api/orders/:id/confirm` | 属主 | `DELIVERED → COMPLETED` |
| POST   | `/api/orders/:id/reject-delivery` | 属主 | `DELIVERED → IN_PROGRESS`，需带 `reason` |

`POST /api/orders`
```json
{
  "projectName": "...(4-60字)...",
  "description": "...(20-5000字)...",
  "softwareTags": ["ANSYS全系列", ...],   // 1-10
  "directionTags": ["结构分析", ...],     // 1-10
  "deliveryDays": 7,                     // 1-90
  "budgetFen": 500000?,                  // 分；可选（弹性预算可不传）
  "budgetFlexible": true,                // 默认 true
  "specialNote": "..."?,
  "fileIds": ["<uploaded_files.id>", ...]?
}
```

`POST /api/orders/:id/select-quote`
```json
{ "quoteId": "q_xxx" }
```

`POST /api/orders/:id/reject-delivery`
```json
{ "reason": "至少 2 字，最多 500 字" }
```

`POST /api/orders/:id/deliver`
```json
{ "fileIds": ["<uploaded_files.id>", ...], "note": "交付说明"? }
```

---

## 五、抢单大厅 Market

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/market/orders` | 已认证工程师 | 大厅列表，支持 `direction&software&budgetMinFen&budgetMaxFen&cursor&limit` 筛选 |
| GET | `/api/market/orders/:id` | 已认证工程师 | 工程师视角详情（含 `myQuote`、`iAmSelected`；被选中且订单进入执行后返回 `customer` 信息） |

大厅摘要会把 `description` 截断到前 80 字符，避免完整需求泄露给尚未被选中的工程师。

---

## 六、报价 Quotes

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST   | `/api/orders/:id/quotes` | 已认证工程师 | 提交（同一工程师重复提交即修改） |
| PATCH  | `/api/quotes/:id` | 本人且 `PENDING` | 修改（订单必须仍在 `QUOTING`） |
| DELETE | `/api/quotes/:id` | 本人且 `PENDING` | 撤回 → 置 `WITHDRAWN` |
| GET    | `/api/quotes/mine` | 已认证工程师 | 我的报价（可选 `?status=`） |
| GET    | `/api/orders/:id/quotes` | 订单属主 | 全部报价（含 engineer 摘要 + 累计完成数） |

`POST /api/orders/:id/quotes`
```json
{
  "days": 7,
  "solution": "…至少10字，最多3000字…",
  "amountFen": 500000     // 弹性预算(budgetFlexible=true)时必填；固定预算时不传
}
```

---

## 七、支付 Payments

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/pay/notify` | 公开（微信回调） | 云托管代解密后的支付事件回调，落账入口 |
| POST | `/api/orders/:id/pay/mock-confirm` | 属主 | 模拟支付确认（仅 `PAYMENT_MODE=mock`） |
| GET  | `/api/orders/:id/payment` | 属主 | 支付状态查询 |

前端发起支付流程（`miniapp/pages/order-detail/index.js#pay`）：
1. `POST /api/orders/:id/pay` → 返回：
   - **mock**：`{ mode:'mock', outTradeNo, amountFen, paymentStatus }`
   - **wechat**：`{ mode:'wechat', outTradeNo, amountFen, timeStamp, nonceStr, package, signType, paySign }`
2. mock：`wx.showModal` 二次确认 → `POST /api/orders/:id/pay/mock-confirm`。
3. wechat：`wx.requestPayment(...)` 五参数 → 成功后轮询 `GET /api/orders/:id/payment`。

**幂等落账唯一入口**：`server/src/services/pay-svc.js#applyPaymentSuccess`。所有支付通道最终都必须走它。

---

## 八、会话 Conversations

主链路：小程序端 `db.watch` 监听云数据库 `conv_messages` 集合，秒级到达。
兜底：4 秒轮询 `GET /api/conversations/:id/messages?after=...`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET  | `/api/conversations` | 登录 | 我的会话列表（含未读数、最后一条消息） |
| GET  | `/api/conversations/by-order/:orderId` | 参与方 | 由订单 → 会话 id（未支付前会 404） |
| GET  | `/api/conversations/:id/messages` | 参与方 | 增量拉取 + 置已读，`?after=<msgId>&limit=` |
| POST | `/api/conversations/:id/messages` | 参与方 | 发消息 `{ type: 'TEXT'\|'IMAGE'\|'FILE', content?, fileId? }` |
| POST | `/api/conversations/:id/read` | 参与方 | 显式置已读 |

发送消息：`TEXT` 走内容安全检查（Mock 词表，上线前替换 `msgSecCheck`）；`IMAGE`/`FILE` 使用 `uploaded_files.id`（不是 fileID）。服务端"一写两存"：MySQL messages 表 + 云数据库 `conv_messages` 集合。

---

## 九、其他

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |

---

## 十、订单状态机

| 当前态 | 事件（触发方） | 次态 |
|---|---|---|
| QUOTING          | 客户删除                       | CLOSED（软删） |
| QUOTING          | 客户选标                       | AWAITING_PAYMENT（其余报价→REJECTED） |
| AWAITING_PAYMENT | 支付成功（回调，幂等）         | IN_PROGRESS（自动建会话 + 系统消息） |
| AWAITING_PAYMENT | 超时未支付（清扫任务）         | QUOTING（报价恢复 PENDING、payments 置 FAILED） |
| IN_PROGRESS      | 工程师交付                     | DELIVERED |
| DELIVERED        | 客户确认                       | COMPLETED |
| DELIVERED        | 客户驳回                       | IN_PROGRESS |

状态变更强制约定：所有 `UPDATE orders SET status=?` 必须带 `WHERE ... AND status='<期望旧态>'` 条件（乐观锁），并根据 `affectedRows === 0` 抛冲突错误。

---

## 十一、报价可见性矩阵

| 数据 | 客户（属主） | 报价工程师本人 | 其他已认证工程师 |
|---|---|---|---|
| 需求详情与文件 | 全部 | 全部（选标后可见完整详情与所有文件） | 大厅摘要 + 报价期需求文件 |
| 某条报价金额/方案 | 可见 | 仅自己那条 | 不可见 |
| 报价总数 | 可见 | 可见 | 可见 |

---

## 十二、错误码约定

| code | 含义 |
|---|---|
| 40000 | 参数校验失败（`v.*` 抛出） |
| 40100 | 未登录 / 会话失效 |
| 40300 | 无权限 |
| 40400 | 资源不存在 |
| 40900 | 状态冲突（多用于状态机变更失败） |
| 42900 | 触发限流（例如短信发送） |
| 50000 | 服务器内部错误 |

---

## 十三、鉴权切换要点（历史对比）

- 已移除：`Authorization: Bearer <accessToken>`、`/api/auth/refresh`、SQLite 存储、`/api/files/raw/:id?exp&tk`、`/api/payments/mock-notify`。
- 新增 / 变更：
  - `X-WX-OPENID` 由微信网关注入，代替 JWT。
  - 账号密码 / 手机号登录使用 `X-Session-Token`（72h 有效，`server/src/lib/util.js#genSessionToken`）。
  - 文件下载改为小程序直连云存储，`GET /api/files/:id/url` 鉴权后返回 `fileID`。
  - 支付通过云托管「开放接口服务」代签名，回调走内部投递，无需公网 HTTPS。
  - `requireUser` 只做鉴权与首登建档，不再顺手改角色；显式角色切换通过 `switchUserRole`，仅在 `/api/auth/wx-login` 内调用。
