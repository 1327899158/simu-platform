# 云开发部署完整指南

你的环境 ID 已经配好了：`cloud1-d8gh7xyw56d7c185f`

## 第一步：云开发控制台 → 开通 MySQL

1. 打开 https://console.cloud.tencent.com/tcb → 切到环境 `cloud1-d8gh7xyw56d7c185f`
2. 左侧 **数据库** → 选择 **MySQL** → 点 **开通**
3. 选择配置（默认 Serverless 即可）
4. 开通成功后，进入 **MySQL 管理界面**，记录以下信息：
   - **MySQL 连接地址** （格式：`xxx.gz.cdb.tencentcdb.com:3306`）
   - **MySQL 用户名** （通常 `root`）
   - **MySQL 密码** （平台生成，一定要复制保存！）

---

## 第二步：云托管服务配置

### 2.1 环境变量设置

云开发控制台 → **云托管** → 服务 `simu-api` → **版本管理** → 选最新版本 → **环境变量**

填入以下变量：

| 变量名 | 值 | 说明 |
|-------|----|----|
| `NODE_ENV` | `production` | 生产环境 |
| `CLOUDBASE_ENV_ID` | `cloud1-d8gh7xyw56d7c185f` | 你的环境 ID |
| `WX_APPID` | `wx14085d227567dd7d` | 小程序 AppID |
| `MAX_UPLOAD_MB` | `30` | 单个附件上限（MB，允许 1-100）；修改后前端自动同步 |
| `MYSQL_ADDRESS` | `xxx.gz.cdb.tencentcdb.com:3306` | ← 从第一步复制 |
| `MYSQL_USERNAME` | `root` | ← 从第一步复制 |
| `MYSQL_PASSWORD` | `**your-password**` | ← 从第一步复制 |
| `MYSQL_DATABASE` | `simu` | 保持不变 |
| `WXPAY_NOTIFY_URL` | `http://simu-api.cloud1-d8gh7xyw56d7c185f.wxcloudrun/api/pay/notify` | 支付回调地址 |
| `PAY_TIMEOUT_SEC` | `1800` | 支付超时（秒） |
| `PAY_AMOUNT_OVERRIDE_FEN` | ~~`1`~~ | **生产环境一定要删除或留空**！否则所有订单只能实付 0.01 元 |

### 2.2 配置订单附件读取权限

工程师需要读取客户上传的云文件，因此云存储不能使用“仅创建者可读”。进入：

云开发控制台 → **云存储** → **权限设置** → **自定义安全规则**，填写
[`docs/cloud-storage.rules.json`](docs/cloud-storage.rules.json) 中的规则：

```json
{
  "read": "auth != null",
  "write": "auth != null && resource.openid == auth.openid"
}
```

业务文件 ID 仍然只会在后端订单权限校验通过后返回；不要把读取规则设置成无条件 `true`。
规则修改后通常需要等待 1-3 分钟，再用客户和工程师两个账号分别测试。

### 2.3 绑定代码仓库（CI/CD）

云托管 → `simu-api` → **版本管理** → **新建版本** → 选择 **代码库**

- 授权 GitHub/Gitee/微信代码托管
- 选择你的 `simu-platform` 仓库
- **构建目录** 填 `server/`（Dockerfile 所在目录）
- **构建分支** 选 `main`

保存后，推送 `server/` 的代码变更会自动触发构建。

### 2.4 灰度发布（可选但推荐）

新建版本后，先点 **灰度发布**，配置：
- 灰度比例：10%（先放 10% 流量）
- 等 24 小时无错后，点 **全量发布**

---

## 第三步：微信支付配置

### 3.1 开通微信支付服务

云开发 → **开放接口服务** → **微信支付服务** → **新建支付实例**

- 选择你的商户号和 AppID
- 勾选「JSAPI 支付」「消息签名与加密」

### 3.2 更新后端支付配置

部署后编辑 `server/src/services/pay-svc.js` 中的 `createJsapiOrder` 函数，如果云托管代签名返回的格式不一样，据实调整（参考官方文档 https://cloud.tencent.com/document/product/1220/53357）。

---

## 第四步：云函数部署

### 4.1 本地安装工具

```bash
npm install -g @cloudbase/cli
tcb login
```

### 4.2 部署支付超时扫描函数

```bash
cd cloudfunctions/pay-timeout-sweep
npm install
cd ..

tcb fn deploy pay-timeout-sweep --env cloud1-d8gh7xyw56d7c185f --root .
```

### 4.3 部署自动完成函数

```bash
cd auto-complete-orders
npm install
cd ..

tcb fn deploy auto-complete-orders --env cloud1-d8gh7xyw56d7c185f --root .
```

### 4.4 配置定时触发器

云开发 → **云函数** → 选函数 → **触发器** → **新建触发器**

**pay-timeout-sweep**：
- 触发器类型：定时触发
- Cron 表达式：`0 */2 * * * * *`（每 2 分钟）

**auto-complete-orders**：
- Cron 表达式：`0 0 2 * * * *`（每天凌晨 2 点 UTC）

### 4.5 配置云函数环境变量

函数详情 → **环境变量** 填：

| 变量 | 值 |
|------|-----|
| `MYSQL_ADDRESS` | `xxx.gz.cdb.tencentcdb.com:3306` |
| `MYSQL_USERNAME` | `root` |
| `MYSQL_PASSWORD` | `**password**` |
| `MYSQL_DATABASE` | `simu` |
| `PAY_TIMEOUT_SEC` | `1800` |

---

## 第五步：云数据库安全规则（实时消息）

### 5.1 创建集合（如不存在）

云开发 → **数据库** → **集合** → **新建集合** `conv_messages`

### 5.2 设置权限

集合 `conv_messages` → **权限** → **自定义安全规则**

```json
{
  "read": "auth.openid in get(['database.conversations', doc.convId, 'read'])._openid_list || auth.openid in get(['database.conversations', doc.convId])._openid_participants",
  "write": "auth.openid == doc._openid || auth.openid in get(['database.conversations', doc.convId])._openid_participants",
  "create": "auth.openid != null",
  "update": false,
  "delete": false
}
```

### 5.3 创建 conversations 集合（元数据）

集合 `conversations` → **权限**：

```json
{
  "read": "auth.openid in doc._openid_participants",
  "write": false,
  "create": false,
  "update": false,
  "delete": false
}
```

后端在 `src/services/chat-svc.js` 中会自动向这个集合写入会话参与方 openid。

---

## 第六步：验证部署

### 6.1 后端健康检查

```bash
# 获取云托管地址
# 格式：http://simu-api.cloud1-d8gh7xyw56d7c185f.wxcloudrun

curl http://simu-api.cloud1-d8gh7xyw56d7c185f.wxcloudrun/api/health
```

返回 `{"code":0,"data":{"ok":true}}` 即成功。

### 6.2 小程序调试

打开微信开发者工具，登录任意角色，执行以下操作：

1. 发一个需求订单
2. 切换角色
3. 在抢单大厅看到该需求
4. 报价
5. 切回第一个角色，选标
6. 支付（此时调的是真实微信支付接口，金额为演示价 0.01 元）
7. 进入聊天室，发消息 → 应该是 **秒级到达**（db.watch 实时推送）

### 6.3 查看日志

云托管 → 版本 → **日志** 查看实时服务日志。

---

## 常见问题排查

### Q: 部署后访问 /api/health 超时

**A:** 检查云托管是否成功构建和部署。日志中是否有错误？如有，常见原因：
- `Dockerfile` 构建失败（依赖安装超时）
- MySQL 环境变量未配置或密码错
- 云托管没有开通（需要在 [腾讯云控制台](https://console.cloud.tencent.com/tcb) 开通云托管服务）

### Q: MySQL 连接失败

**A:** 
1. 确认密码复制正确（特别注意有无特殊字符）
2. 确认 `MYSQL_ADDRESS` 格式为 `host:3306`，不要加 `tcp://` 或其他前缀
3. 云函数的环境变量也要填一份（不会自动继承云托管的配置）

### Q: 小程序报 401 或连接超时

**A:**
1. 确认 `miniapp/utils/config.js` 的 `ENV_ID` 正确
2. 打开微信开发者工具 → 云开发，确认能正常访问（环境列表中有 `cloud1-d8gh7xyw56d7c185f`）
3. 检查小程序 AppID 是否与云开发环境 AppID 一致

### Q: 聊天消息不实时（轮询延迟较大）

**A:**
1. 检查 `conversations` 和 `conv_messages` 集合的权限规则是否正确
2. 打开浏览器控制台，看有无 `db.watch` 错误日志
3. 如果 db.watch 持续报错，会自动降级到 4 秒轮询兜底（不影响功能，只是延迟）

### Q: 支付没有回调（订单卡在 AWAITING_PAYMENT）

**A:**
1. 确认 `WXPAY_NOTIFY_URL` 正确：`http://simu-api.cloud1-d8gh7xyw56d7c185f.wxcloudrun/api/pay/notify`
2. 微信支付控制台 → 检查商户号是否已绑定 AppID
3. 云托管日志中有无 `POST /api/pay/notify` 的记录？如有 5xx，说明后端处理失败

---

## 生产环保安全清单

部署前**务必**检查：

- [ ] `server/.env` 中 `NODE_ENV=production`，`PAY_AMOUNT_OVERRIDE_FEN` **必须删除或留空**
- [ ] 云托管环境变量同步检查，`PAY_AMOUNT_OVERRIDE_FEN` **不配置**
- [ ] 云数据库集合安全规则已设置（不是公开可读）
- [ ] 云函数的 MySQL 密码已配置
- [ ] 微信支付已绑定商户号
- [ ] HTTPS 证书（云托管自动签发 Let's Encrypt，无需手动配）
- [ ] 备份方案（云开发有自动备份，但建议定期手动导出重要数据）

---

## 后续维护

- **监控告警**：云托管自带 CPU/内存/错误率监控，建议配置告警阈值
- **版本管理**：构建后可保留多个版本供灰度或快速回滚
- **日志审计**：云开发有日志存储，生产建议连接到腾讯云日志服务（CLS）
- **容量规划**：Serverless MySQL 按用量计费，QPS 较高时可升级为包年包月实例
