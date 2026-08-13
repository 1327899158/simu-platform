# 管理员分包部署与启用

本版本采用同一小程序 AppID 下的普通分包：

- 管理入口：`admin/pages/gate/index`
- 普通首页、登录页和“我的”页面不显示管理入口
- 小程序码只负责打开入口，不授予权限
- 所有 `/api/admin/*` 接口均由服务端 `requireAdmin()` 鉴权
- 管理员身份独立存放在 `admin_accounts`，不修改 `users.role`

## 1. 配置首位超级管理员

首位管理员必须已经至少登录过一次当前小程序，以便 `users` 表中存在对应记录。

在 CloudBase MySQL 中查询管理员对应的用户：

```sql
SELECT id, openid, username, nickname, phone
FROM users
WHERE deletedAt IS NULL
ORDER BY createdAt DESC;
```

然后在云托管服务的环境变量中选择一种方式配置：

```text
ADMIN_BOOTSTRAP_OPENIDS=管理员的OpenID
```

或：

```text
ADMIN_BOOTSTRAP_USER_IDS=管理员的users.id
```

多个值用英文逗号分隔。OpenID 方案只对服务端环境变量生效，不要把该值放进小程序代码、二维码 `scene` 或前端缓存。

服务重新部署后，该白名单用户第一次访问 `/api/admin/me` 时会被幂等写入 `admin_accounts`，角色为 `SUPER_ADMIN`。环境变量白名单是首位管理员的恢复通道，正式运营时应严格控制云托管配置权限。

## 2. 部署顺序

1. 在云托管配置 `ADMIN_BOOTSTRAP_OPENIDS` 或 `ADMIN_BOOTSTRAP_USER_IDS`。
2. 部署本目录下的 `server` 服务。
3. 确认启动日志包含 `"adminBootstrapConfigured":true` 和 `"db-init-ok"`。
4. 使用微信开发者工具打开 `miniapp`，上传并发布同一个小程序版本。
5. 发布成功后再生成正式管理员小程序码。

服务启动时会幂等创建：

- `admin_accounts`
- `admin_audit_logs`

并为 `engineer_profiles` 补充审核说明、审核时间和审核人字段。

如果要让工程师身份认证真正进入“待审核”流程，还需要在正式环境设置：

```text
ALLOW_ENGINEER_SELF_VERIFY=false
```

当前演示环境若继续保持自主认证，工程师可能在管理员审核前自行变为已通过状态。

## 3. 生成专用管理员小程序码

通过微信“不限制的小程序码”接口生成，目标页面设置为：

```text
admin/pages/gate/index
```

`scene` 可以使用普通入口标识，例如：

```text
admin_entry
```

`scene` 不是密码，服务端不会根据它授予权限。即使二维码被普通用户获得，`/api/admin/me` 和后续管理接口也会返回 403。

生成正式码时，目标页面必须已经存在于已发布的小程序版本中。不要在前端或仓库中保存 AppSecret；小程序码应从受控的服务端脚本、微信公众平台能力或企业内部工具生成。

## 4. 首次验收

使用白名单管理员微信扫码：

1. 进入“管理员安全入口”。
2. 服务端验证通过后跳转到“管理总览”。
3. 验证用户、工程师、订单和操作日志页面均可进入。

再用一个不在白名单且不在 `admin_accounts` 的微信扫码：

1. 页面应提示“当前账号没有管理员权限”。
2. 随后返回普通首页。
3. 直接请求任何 `/api/admin/*` 接口均应得到 403。

## 5. 当前管理权限

| 管理角色 | 权限范围 |
|---|---|
| `SUPER_ADMIN` | 全部管理权限 |
| `OPERATOR` | 总览、用户状态、工程师只读、订单只读及安全关闭、日志 |
| `AUDITOR` | 总览、用户/工程师/订单只读、日志 |
| `ENGINEER_REVIEWER` | 总览、身份认证审核、订单只读 |

当前“强制关闭订单”只允许处理 `QUOTING`（待报价）订单。待支付、执行中、待验收和已完成订单涉及资金或履约，接口会拒绝关闭，避免管理员误操作影响支付逻辑。
