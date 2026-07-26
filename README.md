# 仿真服务平台小程序 · 最小闭环 Demo

连接仿真客户与仿真工程师：**发需求 → 报价 → 选标 → 支付 → 会话 → 交付 → 确认** 的完整闭环。

- `server/` —— 后端。**零第三方依赖**（Node ≥ 22.5 内置 http / sqlite / crypto），不需要 npm install、不需要 Docker、不需要 MySQL，一条命令启动。
- `miniapp/` —— 微信小程序原生前端（无 UI 库依赖，导入开发者工具即用）。
- `prisma/schema.prisma` —— 生产版数据库蓝图（MySQL），与 Demo 表结构一一对应。
- `docs/` —— 接口清单、Mock→真实（微信登录/微信支付/COS）切换指南。

## 一、5 分钟跑起来

### 1. 启动后端

```bash
cd server
npm start        # 即 node --experimental-sqlite src/main.js，默认 3000 端口
```

看到 `{"evt":"listening","port":3000,...}` 即成功。数据库文件自动生成在 `server/data/simu.db`。

（可选）先跑自动化闭环测试，确认一切正常：

```bash
npm run e2e      # 36 条用例：登录/发布/报价/选标/支付幂等/超时回退/会话/交付/越权/重启持久化
```

### 2. 打开小程序

1. 微信开发者工具 → 导入项目 → 选择 `miniapp/` 目录（AppID 用测试号即可）。
2. 工具右上角「详情 → 本地设置」勾选 **「不校验合法域名…」**（Demo 后端是 http://127.0.0.1:3000）。
3. 编译运行。

> 真机预览时，把 `miniapp/utils/config.js` 的 `BASE_URL` 改成电脑局域网 IP（如 `http://192.168.1.8:3000/api`），手机与电脑连同一 WiFi。

## 二、演示脚本（10 步闭环）

同一设备可用「我的 → 切换角色」在客户/工程师之间切换（两个独立账号）；双人演示则两台设备各选一个角色。

1. 以「客户」登录 → 首页「+ 提报需求」，五步表单发布（可上传模型压缩包/图片）。
2. 切换为「工程师」→ 首页抢单大厅看到该需求（可按方向/软件筛选）。
3. 进入详情 →「我要报价」：金额、工期、技术方案。
4. （可选）再换个角色/设备提交第二份报价，体验报价对比。
5. 切回「客户」→ 订单详情看到全部报价 → 「选择该工程师」。
6. 「立即支付」→ 模拟收银台确认（真实通道见 docs/upgrade.md）→ 订单进入执行中。
7. 底部「消息」出现会话（含系统消息）→ 双方互发文字/图片（4 秒内互达；违规词会被拦截）。
8. 工程师在订单详情「上传成果并交付」。
9. 客户收到交付 → 下载成果文件 → 「确认验收，完成订单」。
10. 订单终态 COMPLETED；重启后端数据不丢。

超时演示：选标后不支付，等 `PAY_TIMEOUT_SEC`（默认 1800 秒，可在 `server/.env` 改成 30 秒）后订单自动回退「待报价」，报价恢复待确认。

## 三、配置开关（server/.env，样例见 .env.example）

| 变量 | 默认 | 说明 |
|---|---|---|
| WX_MOCK | 1 | 1=Mock 登录；0=真实 jscode2session（需 WX_APPID/WX_SECRET） |
| PAY_PROVIDER | mock | mock=演示收银台；wechat=微信支付 v3（接入见 docs/upgrade.md） |
| PAY_TIMEOUT_SEC | 1800 | 选标后未支付自动回退秒数 |
| PAY_AMOUNT_OVERRIDE_FEN | 空 | 设为 1 则一切订单实付 0.01 元（现场演示用），生产必须留空 |
| MAX_UPLOAD_MB | 25 | Demo 单文件上限（生产改 COS 直传后可到 GB 级） |
| BANNED_WORDS | 内置 | Mock 内容安全词表（上线前必须替换为微信 msgSecCheck） |

## 四、这个 Demo 与生产版的关系

| 环节 | Demo 实现（本仓库） | 生产实现（见方案文档与 docs/upgrade.md） |
|---|---|---|
| 登录 | Mock openid | 微信 jscode2session（代码已就位，改 .env 即切） |
| 支付 | 模拟收银台 + 同一套幂等落账/超时回退逻辑 | 微信支付 v3 JSAPI + 回调验签解密（接入点已留好） |
| 文件 | 本地磁盘 + 签名 URL | 腾讯云 COS 直传（STS）+ CDN，权限模型不变 |
| 消息 | 4 秒轮询 | 轮询保底 + WebSocket 升级 |
| 数据库 | SQLite（node:sqlite） | 腾讯云 MySQL + Prisma（蓝图 prisma/schema.prisma） |
| 框架 | 零依赖 Node（分层：routes/services/lib） | NestJS 同构迁移，API 契约不变 |

业务核心（订单状态机、报价可见性矩阵、选标乐观锁、支付幂等、超时回退、文件权限、内容拦截）在 Demo 里就是**真实实现**，e2e 已验证，迁移时原样平移。

## 五、目录结构

```
server/
  src/main.js            HTTP 服务与路由装配
  src/config.js          环境变量与开关
  src/db.js              SQLite 表结构 + 事务/查询助手（对应 prisma 蓝图）
  src/lib/               http 路由器 / jwt / multipart / 校验 / 鉴权中间件
  src/routes/            auth · dicts · files · orders · market · quotes · payments · chat
  src/services/          pay-svc（幂等落账/超时清扫）· chat-svc（会话/系统消息/内容检查）
  test/e2e.mjs           36 条闭环用例（npm run e2e）
miniapp/
  utils/                 request（401静默刷新）· auth · 格式化 · 配置
  pages/                 login · home(双角色) · publish(五步) · orders · order-detail(双角色)
                         quote-form · my-quotes · chat-list · chat-room · me
docs/api.md              接口清单
docs/upgrade.md          Mock→真实切换 / NestJS 迁移指引
```
