# simu-platform 项目说明（给 AI 协作者）

仿真服务平台微信小程序 · 最小闭环 Demo。闭环：发需求→报价→选标→支付→会话→交付→确认。

## 命令
- 启动后端：`cd server && npm start`（Node ≥22.5，零第三方依赖，SQLite 落盘 data/simu.db）
- 闭环测试：`cd server && npm run e2e`（36 用例，必须全绿再提交改动）
- 小程序：微信开发者工具导入 miniapp/，本地设置勾选「不校验合法域名」

## 约定（改代码前必读）
- 金额一律「分」整数，字段后缀 Fen；前端展示才转元
- 订单状态机与报价可见性矩阵见 docs/api.md，任何状态变更必须用「带 where 状态条件的 UPDATE」乐观锁写法
- 支付落账唯一入口 services/pay-svc.js 的 applyPaymentSuccess（幂等），任何支付通道都必须走它
- 文件下载权限唯一入口 routes/files.js 的 canReadFile，切 COS 时保留
- API 契约（docs/api.md）是前后端唯一约定，改接口必须同步 miniapp 与 e2e
- Mock/真实切换全部走 server/.env 与 miniapp/utils/config.js，不写死在业务代码

## 生产路线
- prisma/schema.prisma 是 MySQL 蓝图；迁移 NestJS 的验收标准：小程序零改动、e2e 全绿（docs/upgrade.md 第 5 节）
