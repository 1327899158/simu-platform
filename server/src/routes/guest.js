'use strict';

/**
 * 游客首页公开统计。
 * 只返回聚合后的业务数量，不返回用户、订单或评价的任何明细。
 */
const { ok } = require('../lib/http');
const { queryOne } = require('../db');

function register(router) {
  router.get('/api/guest/stats', async (_req, res) => {
    const stats = await queryOne(
      `SELECT
        (SELECT COUNT(*)
           FROM users u
           JOIN engineer_profiles ep ON ep.userId = u.id
          WHERE u.role = 'ENGINEER'
            AND u.status = 'ACTIVE'
            AND ep.verifyStatus = 'APPROVED') AS approvedEngineers,
        (SELECT COUNT(*)
           FROM orders
          WHERE status = 'COMPLETED' AND deletedAt IS NULL) AS completedOrders,
        (SELECT COUNT(*)
           FROM orders
          WHERE status = 'QUOTING' AND deletedAt IS NULL) AS openOrders,
        (SELECT COUNT(*)
           FROM quotes
          WHERE status <> 'WITHDRAWN') AS quoteCount,
        (SELECT COUNT(*) FROM engineer_reviews) AS reviewCount,
        (SELECT AVG((qualityScore + attitudeScore + speedScore) / 3)
           FROM engineer_reviews) AS averageReview`
    );

    ok(res, {
      approvedEngineers: Number(stats?.approvedEngineers || 0),
      completedOrders: Number(stats?.completedOrders || 0),
      openOrders: Number(stats?.openOrders || 0),
      quoteCount: Number(stats?.quoteCount || 0),
      reviewCount: Number(stats?.reviewCount || 0),
      averageReview: stats?.averageReview == null ? null : Number(stats.averageReview),
    });
  });
}

module.exports = { register };
