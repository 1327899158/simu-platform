# 接口清单（Demo 已全部实现并通过 e2e）

统一响应：成功 `{"code":0,"data":...}`；失败 `{"code":4xxxx,"message":"..."}`。
鉴权：`Authorization: Bearer <accessToken>`；401 后用 refreshToken 调 /auth/refresh 换新。

| 模块 | 接口 | 说明 / 权限 |
|---|---|---|
| 认证 | POST /api/auth/wx-login | code+roleHint，Mock/真实双模式，公开 |
| 认证 | POST /api/auth/refresh | 刷新令牌旋转，公开 |
| 认证 | GET /api/me · PATCH /api/me | 个人信息，登录用户 |
| 字典 | GET /api/dicts | 软件/方向/工期/状态文案，公开 |
| 文件 | POST /api/files/upload | multipart(file,kind,orderId?)，登录用户 |
| 文件 | GET /api/files/:id/url | 10 分钟签名下载地址，按权限矩阵 |
| 文件 | GET /api/files/raw/:id?exp&tk | 签名直下（wx.downloadFile 用） |
| 文件 | GET /api/orders/:id/files | 订单文件列表，按权限过滤 |
| 订单 | POST /api/orders | 发布需求，客户 |
| 订单 | GET /api/orders/mine?status&cursor&limit | 我的订单（游标分页），客户 |
| 订单 | GET /api/orders/:id | 详情（客户视角），属主 |
| 订单 | DELETE /api/orders/:id | 仅 QUOTING 可删（软删），属主 |
| 订单 | POST /api/orders/:id/select-quote | 选标（乐观锁事务），属主 |
| 订单 | POST /api/orders/:id/pay | 创建支付单返回调起参数，属主 |
| 订单 | GET /api/orders/:id/payment | 支付状态轮询，属主 |
| 订单 | POST /api/orders/:id/deliver | 交付（IN_PROGRESS→DELIVERED），被选工程师 |
| 订单 | POST /api/orders/:id/confirm | 验收（DELIVERED→COMPLETED），属主 |
| 订单 | POST /api/orders/:id/reject-delivery | 驳回交付回到执行中，属主 |
| 大厅 | GET /api/market/orders?direction&software&budgetMinFen&budgetMaxFen | 认证工程师 |
| 大厅 | GET /api/market/orders/:id | 工程师视角详情（客户身份支付后可见） |
| 报价 | POST /api/orders/:id/quotes | 提交（重复=修改），认证工程师 |
| 报价 | PATCH /api/quotes/:id · DELETE /api/quotes/:id | 修改/撤回，仅本人 PENDING |
| 报价 | GET /api/quotes/mine?status | 我的报价，工程师 |
| 报价 | GET /api/orders/:id/quotes | 全部报价，仅订单属主 |
| 支付 | POST /api/payments/mock-notify | 模拟异步通知（仅 mock 通道），公开 |
| 支付 | POST /api/payments/notify | 微信 v3 回调占位（wechat 通道） |
| 会话 | GET /api/conversations | 会话列表+未读数 |
| 会话 | GET /api/conversations/by-order/:orderId | 订单→会话 |
| 会话 | GET /api/conversations/:id/messages?after&limit | 增量拉取并置已读（轮询） |
| 会话 | POST /api/conversations/:id/messages | 发消息（TEXT/IMAGE/FILE，文本过内容检查） |
| 其他 | GET /api/health | 健康检查，公开 |

## 订单状态机

| 当前态 | 事件（触发方） | 次态 |
|---|---|---|
| QUOTING | 客户删除 | CLOSED（软删） |
| QUOTING | 客户选标 | AWAITING_PAYMENT（其余报价→REJECTED） |
| AWAITING_PAYMENT | 支付成功（回调，幂等） | IN_PROGRESS（自动建会话） |
| AWAITING_PAYMENT | 超时未支付（清扫任务） | QUOTING（报价恢复 PENDING） |
| IN_PROGRESS | 工程师交付 | DELIVERED |
| DELIVERED | 客户确认 | COMPLETED |
| DELIVERED | 客户驳回 | IN_PROGRESS |

## 报价可见性矩阵（e2e 用例 5 已验证）

| 数据 | 客户(属主) | 报价工程师本人 | 其他工程师 |
|---|---|---|---|
| 需求与文件 | 全部 | 全部（客户身份支付后可见） | 大厅摘要+报价期文件 |
| 某报价金额/方案 | 可见 | 仅自己 | 不可见 |
| 报价数量 | 可见 | 可见 | 可见 |
