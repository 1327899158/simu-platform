'use strict';
/** 字典：仿真软件 / 仿真方向 / 工期选项 / 状态文案映射（取自原方案 3.1.2）。 */
const { ok } = require('../lib/http');
const { config } = require('../config');
const { queryOne } = require('../db');

const DICTS = {
  softwares: [
    'ANSYS全系列', 'ABAQUS', 'COMSOL Multiphysics', 'NASTRAN', 'LS-DYNA',
    'ADAMS', 'RecurDyn', 'HyperMesh', 'MATLAB/Simulink', 'OpenFOAM',
    'STAR-CCM+', 'Radioss', 'Salome', 'FreeCAD', 'EDEM',
    'ICEM CFD', 'Gmsh', '其他',
  ],
  directions: [
    '结构分析', '流体分析', '热分析', '多物理场耦合', '电磁场分析',
    '声学分析', '优化设计', '可靠性分析', '碰撞安全', '微观结构仿真', '其他',
  ],
  deliveryOptions: [
    { key: 'fast', label: '快速（1-3天）', days: 3 },
    { key: 'standard', label: '标准（4-7天）', days: 7 },
    { key: 'relaxed', label: '宽松（8-15天）', days: 15 },
    { key: 'custom', label: '自定义', days: null },
  ],
  orderStatus: {
    QUOTING: '报价中',
    AWAITING_PAYMENT: '待支付',
    IN_PROGRESS: '执行中',
    DELIVERED: '待验收',
    COMPLETED: '已完成',
    REFUND_PENDING: '退款确认中',
    CANCELLED: '已取消',
    CLOSED: '已关闭',
    DISPUTING: '纠纷中',
  },
  quoteStatus: {
    PENDING: '待客户确认',
    SELECTED: '已选中',
    REJECTED: '未选中',
    WITHDRAWN: '已撤回',
  },
  limits: {
    maxUploadMb: config.uploadMaxMb,
    maxUploadBytes: config.uploadMaxBytes,
    maxOrderAttachments: 20,
  },
};

function register(router) {
  router.get('/api/dicts', async (_req, res) => ok(res, DICTS));

  // 游客首页只需要可公开展示的聚合指标；不返回任何用户、订单或评价明细。
  router.get('/api/guest/stats', async (_req, res) => {
    const stats = await queryOne(
      `SELECT
        (SELECT COUNT(*)
           FROM users u
           JOIN engineer_profiles ep ON ep.userId = u.id
          WHERE u.role = 'ENGINEER'
            AND u.status = 'ACTIVE'
            AND EXISTS (SELECT 1 FROM identity_verifications iv
                         WHERE iv.userId=u.id AND iv.verifyStatus='APPROVED')) AS approvedEngineers,
        (SELECT COUNT(*)
           FROM orders
          WHERE status = 'COMPLETED' AND deletedAt IS NULL) AS completedOrders,
        (SELECT COUNT(*)
           FROM orders
          WHERE deletedAt IS NULL) AS allOrders,
        (SELECT COUNT(*)
           FROM orders
          WHERE status IN ('IN_PROGRESS', 'DELIVERED')
            AND deletedAt IS NULL) AS activeProjects,
        (SELECT COUNT(*)
           FROM orders
          WHERE status = 'QUOTING' AND deletedAt IS NULL) AS openOrders,
        (SELECT COUNT(*)
           FROM quotes
          WHERE status <> 'WITHDRAWN') AS quoteCount,
        (SELECT COUNT(*)
           FROM users
          WHERE role = 'CUSTOMER'
            AND status = 'ACTIVE'
            AND deletedAt IS NULL) AS customerCount,
        (SELECT COALESCE(SUM(viewCount), 0)
           FROM orders
          WHERE deletedAt IS NULL) AS totalViews,
        (SELECT COUNT(*) FROM engineer_reviews) AS reviewCount,
        (SELECT AVG((qualityScore + attitudeScore + speedScore +
          COALESCE(professionalScore, (qualityScore + attitudeScore + speedScore) / 3) +
          COALESCE(communicationScore, (qualityScore + attitudeScore + speedScore) / 3)) / 5)
           FROM engineer_reviews) AS averageReview`
    );

    ok(res, {
      approvedEngineers: Number(stats?.approvedEngineers || 0),
      completedOrders: Number(stats?.completedOrders || 0),
      allOrders: Number(stats?.allOrders || 0),
      activeProjects: Number(stats?.activeProjects || 0),
      openOrders: Number(stats?.openOrders || 0),
      quoteCount: Number(stats?.quoteCount || 0),
      customerCount: Number(stats?.customerCount || 0),
      totalViews: Number(stats?.totalViews || 0),
      reviewCount: Number(stats?.reviewCount || 0),
      averageReview: stats?.averageReview == null ? null : Number(stats.averageReview),
    });
  });
  console.log(JSON.stringify({ t: new Date().toISOString(), evt: 'guest-stats-route-registered-via-dicts' }));
}

module.exports = { register, DICTS };
