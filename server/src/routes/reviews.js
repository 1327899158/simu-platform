'use strict';
/** 客户对已完成订单的工程师评价，以及工程师公开评价资料。 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx, parseJson } = require('../db');
const { requireCustomer, requireUser } = require('../lib/auth-mw');

function score(value, label) {
  return v.int(value, label, { min: 1, max: 5 });
}

function reviewView(row, extra = {}) {
  if (!row) return null;
  const qualityScore = Number(row.qualityScore);
  const attitudeScore = Number(row.attitudeScore);
  const speedScore = Number(row.speedScore);
  // 旧版三维评价没有新字段；以原三项均分补齐展示和统计，保证历史评分不变。
  const legacyAverage = (qualityScore + attitudeScore + speedScore) / 3;
  const professionalScore = row.professionalScore == null ? legacyAverage : Number(row.professionalScore);
  const communicationScore = row.communicationScore == null ? legacyAverage : Number(row.communicationScore);
  return {
    id: row.id,
    orderId: row.orderId,
    qualityScore,
    attitudeScore,
    speedScore,
    professionalScore: Number(professionalScore.toFixed(1)),
    communicationScore: Number(communicationScore.toFixed(1)),
    averageScore: Number(((qualityScore + attitudeScore + speedScore + professionalScore + communicationScore) / 5).toFixed(1)),
    content: row.content || '',
    contentText: row.content || '该用户未给出评价',
    revisionCount: Number(row.revisionCount || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revisedAt: row.revisedAt,
    ...extra,
  };
}

async function ensureReviewableOrder(conn, orderId, customerId) {
  const [[order]] = await conn.execute(
    `SELECT o.id, o.orderNo, o.projectName, o.status, o.customerId, q.engineerId
       FROM orders o
       LEFT JOIN quotes q ON q.id=o.selectedQuoteId
      WHERE o.id=? AND o.customerId=? AND o.deletedAt IS NULL
      FOR UPDATE`,
    [orderId, customerId]
  );
  if (!order) throw err.notFound('订单不存在');
  if (order.status !== 'COMPLETED') throw err.conflict('仅已完成订单可评价');
  if (!order.engineerId) throw err.conflict('该订单未关联工程师，无法评价');
  return order;
}

function register(router) {
  // POST /api/orders/:id/review：首次评价，评价数据只能由订单发布者写入。
  router.post('/api/orders/:id/review', async (req, res, params) => {
    const user = await requireCustomer(req);
    const body = await readJson(req);
    const qualityScore = score(body.qualityScore, '质量评分');
    const attitudeScore = score(body.attitudeScore, '态度评分');
    const speedScore = score(body.speedScore, '速度评分');
    const professionalScore = score(body.professionalScore, '专业能力评分');
    const communicationScore = score(body.communicationScore, '沟通评分');
    const content = v.str(body.content, '评价内容', { max: 100, optional: true }) || null;
    const saved = await tx(async (conn) => {
      const order = await ensureReviewableOrder(conn, params.id, user.id);
      const [[existing]] = await conn.execute(
        `SELECT id FROM engineer_reviews WHERE orderId=? FOR UPDATE`, [order.id]);
      if (existing) throw err.conflict('该订单已评价；每单仅可修改一次');
      const now = nowIso();
      const id = newId();
      await conn.execute(
        `INSERT INTO engineer_reviews
          (id, orderId, customerId, engineerId, qualityScore, attitudeScore, speedScore, professionalScore, communicationScore, content, revisionCount, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?, ?,0,?,?)`,
        [id, order.id, user.id, order.engineerId, qualityScore, attitudeScore, speedScore, professionalScore, communicationScore, content, now, now]
      );
      const [[row]] = await conn.execute(`SELECT * FROM engineer_reviews WHERE id=?`, [id]);
      return row;
    });
    ok(res, reviewView(saved));
  });

  // PATCH /api/orders/:id/review：严格只允许一次修改，服务端而非前端计数。
  router.patch('/api/orders/:id/review', async (req, res, params) => {
    const user = await requireCustomer(req);
    const body = await readJson(req);
    const qualityScore = score(body.qualityScore, '质量评分');
    const attitudeScore = score(body.attitudeScore, '态度评分');
    const speedScore = score(body.speedScore, '速度评分');
    const professionalScore = score(body.professionalScore, '专业能力评分');
    const communicationScore = score(body.communicationScore, '沟通评分');
    const content = v.str(body.content, '评价内容', { max: 100, optional: true }) || null;
    const saved = await tx(async (conn) => {
      await ensureReviewableOrder(conn, params.id, user.id);
      const [[existing]] = await conn.execute(
        `SELECT * FROM engineer_reviews WHERE orderId=? AND customerId=? FOR UPDATE`,
        [params.id, user.id]
      );
      if (!existing) throw err.notFound('尚未提交评价');
      if (Number(existing.revisionCount || 0) >= 1) throw err.conflict('该评价已修改过，不能再次修改');
      const now = nowIso();
      await conn.execute(
        `UPDATE engineer_reviews
            SET qualityScore=?, attitudeScore=?, speedScore=?, professionalScore=?, communicationScore=?, content=?,
                revisionCount=1, revisedAt=?, updatedAt=?
          WHERE id=?`,
        [qualityScore, attitudeScore, speedScore, professionalScore, communicationScore, content, now, now, existing.id]
      );
      const [[row]] = await conn.execute(`SELECT * FROM engineer_reviews WHERE id=?`, [existing.id]);
      return row;
    });
    ok(res, reviewView(saved));
  });

  // GET /api/engineers/me/reviews：工程师只可查看自己的评价及汇总。
  router.get('/api/engineers/me/reviews', async (req, res) => {
    const user = await requireUser(req);
    if (user.role !== 'ENGINEER') throw err.forbidden('仅工程师可查看我的评价');
    const summary = await queryOne(
      `SELECT COUNT(*) AS reviewCount,
              AVG((qualityScore + attitudeScore + speedScore +
                   COALESCE(professionalScore, (qualityScore + attitudeScore + speedScore) / 3) +
                   COALESCE(communicationScore, (qualityScore + attitudeScore + speedScore) / 3)) / 5) AS averageScore
         FROM engineer_reviews WHERE engineerId=?`, [user.id]);
    const rows = await query(
      `SELECT r.*, o.orderNo, o.projectName, u.nickname AS customerNickname, u.avatarUrl AS customerAvatarUrl
         FROM engineer_reviews r
         JOIN orders o ON o.id=r.orderId
         JOIN users u ON u.id=r.customerId
        WHERE r.engineerId=?
        ORDER BY r.updatedAt DESC
        LIMIT 100`, [user.id]);
    const reviewCount = Number(summary?.reviewCount || 0);
    ok(res, {
      averageScore: reviewCount ? Number(Number(summary.averageScore).toFixed(1)) : null,
      reviewCount,
      items: rows.map((row) => reviewView(row, {
        order: { id: row.orderId, orderNo: row.orderNo, projectName: row.projectName },
        customer: { nickname: row.customerNickname || '客户', avatarUrl: row.customerAvatarUrl || '' },
      })),
    });
  });

  // GET /api/engineers/:id/profile：只返回工程师公开资料，不暴露手机号、openid 等私密数据。
  router.get('/api/engineers/:id/profile', async (req, res, params) => {
    await requireUser(req);
    const engineer = await queryOne(
      `SELECT u.id, u.nickname, u.avatarUrl, p.specialties, p.softwares, p.intro
         FROM users u JOIN engineer_profiles p ON p.userId=u.id
        WHERE u.id=? AND u.role='ENGINEER' AND u.status='ACTIVE' AND u.deletedAt IS NULL`,
      [params.id]);
    if (!engineer) throw err.notFound('工程师不存在');
    const summary = await queryOne(
      `SELECT COUNT(*) AS reviewCount,
              AVG((qualityScore + attitudeScore + speedScore +
                   COALESCE(professionalScore, (qualityScore + attitudeScore + speedScore) / 3) +
                   COALESCE(communicationScore, (qualityScore + attitudeScore + speedScore) / 3)) / 5) AS averageScore
         FROM engineer_reviews WHERE engineerId=?`, [engineer.id]);
    const rows = await query(
      `SELECT r.*, u.nickname AS customerNickname
         FROM engineer_reviews r JOIN users u ON u.id=r.customerId
        WHERE r.engineerId=? ORDER BY r.updatedAt DESC LIMIT 30`, [engineer.id]);
    const reviewCount = Number(summary?.reviewCount || 0);
    ok(res, {
      id: engineer.id,
      nickname: engineer.nickname || '工程师',
      avatarUrl: engineer.avatarUrl || '',
      specialties: parseJson(engineer.specialties),
      softwares: parseJson(engineer.softwares),
      intro: engineer.intro || '',
      reviewCount,
      averageScore: reviewCount ? Number(Number(summary.averageScore).toFixed(1)) : null,
      reviews: rows.map((row) => reviewView(row, { customerNickname: row.customerNickname || '客户' })),
    });
  });
}

module.exports = { register, reviewView };
