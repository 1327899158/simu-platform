# 仿真服务平台小程序 · 云开发版

连接仿真客户与仿真工程师：**发需求 → 报价 → 选标 → 支付 → 会话 → 交付 → 确认** 的完整闭环。

**云开发版**基于微信小程序云开发（CloudBase Run 云托管 + 云数据库 + 云存储 + 微信支付服务）部署，无需自建服务器、不需 ICP 域名备案、不需手写支付证书签名。

- `server/` —— 后端。Node.js + mysql2，可直接打包为云托管容器镜像（含 Dockerfile）。
- `miniapp/` —— 微信小程序原生前端（wx.cloud.callContainer + wx.cloud.uploadFile + db.watch）。
- `cloudfunctions/` —— 云函数定时任务（支付超时扫描、自动完成订单）。
- `prisma/schema.prisma` —— 数据库蓝图（MySQL），与 server 表结构一一对应。
- `docs/` —— 接口清单、部署说明。

---

## 一、快速开始（本地开发）

### 前置条件

- Node.js ≥ 18
- Docker Desktop（本地 MySQL）
- 微信开发者工具（稳定版）
- 微信小程序 AppID（已开通云开发）

### 1. 填写配置

**小程序端** — 编辑 `miniapp/utils/config.js`：
```js
const ENV_ID = 'your-env-id';     // ← 改为你的云开发测试环境 ID
const SERVICE_NAME = 'simu-api';  // 云托管服务名
```

**后端** — 复制并编辑 `server/.env`：
```bash
cd server
# 关键配置：
# CLOUDBASE_ENV_ID=your-env-id
# WX_APPID=wx14085d227567dd7d
# PAY_AMOUNT_OVERRIDE_FEN=1   （演示价：实付 0.01 元）
```

### 2. 本地启动后端

```bash
cd server

# 启动本地 MySQL（一次性，之后直接 docker start simu-mysql）
docker run -d --name simu-mysql \
  -e MYSQL_ROOT_PASSWORD=dev123456 \
  -e MYSQL_DATABASE=simu \
  -p 3306:3306 mysql:8.0

# 安装依赖
npm install

# 启动（自动建表、监听 :3000）
npm run dev
```

看到 `{"evt":"listening","port":3000}` 即成功。

### 3. 打开小程序

1. 微信开发者工具 → 导入 `miniapp/` 目录（填写你的 AppID）
2. 工具 → 详情 → 本地设置 → 勾选「不校验合法域名」
3. 编译运行

---

## 二、演示脚本（10 步闭环）

1. 选「客户」角色 → 微信一键登录 → 首页「+ 提报需求」，五步表单发布（可上传模型文件/图片）。
2. 返回登录页，选「工程师」登录 → 首页抢单大厅看到该需求（可按方向/软件筛选）。
3. 进入详情 → 「我要报价」：金额、工期、技术方案。
4. 切回客户 → 订单详情看到报价 → 「选择该工程师」。
5. 「立即支付」→ 微信真实支付（演示价 0.01 元）→ 订单进入执行中。
6. 底部「消息」出现会话（**db.watch 实时推送**，秒级到达）。
7. 双方互发文字/图片。
8. 工程师在订单详情「上传成果并交付」（云存储直传）。
9. 客户下载成果 → 「确认验收，完成订单」。
10. 订单终态 COMPLETED。

---

## 三、部署到云托管（生产）

### 1. 开通云开发

在 [微信公众平台](https://mp.weixin.qq.com) → 开发 → 云开发，创建两个环境（test / prod）。

### 2. 开通云托管与服务

云开发控制台 → 云托管 → 新建服务 `simu-api` → 开通 MySQL（Serverless）→ 开通「开放接口服务 → 微信支付服务」并绑定商户号。

### 3. 绑定代码仓库自动构建

云托管服务 → 版本管理 → 新建版本 → 选「代码库」→ 绑定 GitHub/Gitee，构建目录设为 `server/`（Dockerfile 在此）。推 main 分支自动触发构建。

### 4. 配置环境变量

| 变量 | 值 |
|------|----|
| `NODE_ENV` | `production` |
| `CLOUDBASE_ENV_ID` | 云开发环境 ID |
| `WX_APPID` | 小程序 AppID |
| `WXPAY_NOTIFY_URL` | `http://simu-api.<envId>.wxcloudrun/api/pay/notify` |
| `PAY_TIMEOUT_SEC` | `1800` |

> `MYSQL_ADDRESS/USERNAME/PASSWORD/DATABASE` 由平台自动注入，无需配置。

### 5. 部署云函数

```bash
npm install -g @cloudbase/cli
tcb login
tcb fn deploy pay-timeout-sweep --env your-env-id --root cloudfunctions
tcb fn deploy auto-complete-orders --env your-env-id --root cloudfunctions
```

在控制台为两个函数配置触发器：

- `pay-timeout-sweep`：Cron `0 */2 * * * * *`（每 2 分钟）
- `auto-complete-orders`：Cron `0 0 2 * * * *`（每天凌晨 2 点）

### 6. 配置云数据库安全规则

云数据库 → `conv_messages` 集合 → 权限 → 自定义规则：

```json
{
  "read": "auth.openid in get(['database.conversations', doc.convId])._openid_participants",
  "write": "auth.openid == doc._openid"
}
```

---

## 四、关键设计说明

### 鉴权

移除 JWT Bearer Token。小程序通过 `wx.cloud.callContainer` 发请求时，微信网关自动注入 `X-WX-OPENID`，服务端读取后 upsert 用户（`server/src/lib/auth-mw.js`）。

### 文件上传

`wx.cloud.uploadFile` 直传云存储，返回 fileID（`cloud://env.bucket/path`）→ 调 `POST /api/files/commit` 写 MySQL → 服务端完成订单权限校验后，小程序通过 `wx.cloud.downloadFile` 下载（失败时兼容临时地址）。

### 实时消息

发送时「一写两存」：MySQL（历史）+ 云数据库 `conv_messages`（db.watch 触发推送）。聊天室 `db.watch` 监听 → 秒级到达；4 秒轮询兜底。

### 微信支付

云托管「开放接口服务」代签名。业务代码调 `http://api.weixin.qq.com/_/pay/transactions/jsapi`（内部地址），sidecar 自动加签，返回五参数 → `wx.requestPayment`。回调走内部投递，无需公网 HTTPS。

---

## 五、与原自建版本对比

| 项目 | 原版本（自建） | 云开发版 |
|------|--------------|----------|
| 后端部署 | 轻量服务器 + Nginx + Docker Compose | 云托管自动构建容器 |
| 数据库 | node:sqlite → 生产 MySQL | 云托管 MySQL（Serverless） |
| 文件存储 | 本地磁盘 / COS + STS 签名 | 云存储 fileID 直传 |
| 鉴权 | JWT Bearer Token | X-WX-OPENID（微信注入） |
| 支付 | 自写 v3 证书 + 签名验签 | 云托管开放接口代签名 |
| 实时消息 | 轮询 | db.watch + 轮询兜底 |
| 备案 | 后端域名必须 ICP 备案 | 仅小程序备案 |
| CI/CD | GitHub Actions + SSH | 云托管控制台绑仓库 |

---

## 六、目录结构

```
server/
  src/main.js           HTTP 服务与路由装配
  src/config.js         环境变量
  src/db.js             MySQL 建表 + 事务/查询助手
  src/tcb.js            云开发 SDK 单例（云存储/云数据库）
  src/lib/auth-mw.js    X-WX-OPENID 鉴权（替代 JWT）
  src/routes/           auth · dicts · files · orders · market · quotes · payments · chat
  src/services/         pay-svc · chat-svc
  Dockerfile            云托管容器构建
  container.config.json 云托管服务配置
cloudfunctions/
  pay-timeout-sweep/    每 2 分钟扫超时未支付
  auto-complete-orders/ 每天凌晨 2 点自动完成
miniapp/
  utils/config.js       ENV_ID / SERVICE_NAME
  utils/request.js      callContainer 封装（+ 本地降级到 wx.request）
  utils/auth.js         云开发登录（移除 JWT token 管理）
  utils/upload.js       wx.cloud.uploadFile + commit
  pages/               同原版（login 简化为微信一键登录）
```
