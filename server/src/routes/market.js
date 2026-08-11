'use strict';
/** 抢单大厅（云开发版）。 */
const { ok, err } = require('../lib/http');
const { v } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireEngineer } = require('../lib/auth-mw');
const { orderView, quoteCountOf } = require('./orders');

function register(router) {
  // GET /api/market/orders?direction=&software=&sort=latest|hot&cursor=&limit=
  router.get('/api/market/orders', async (req, res, _p, q_) => {
    const user = await requireEngineer(req);
    const limit = q_.get('limit') ? v.int(q_.get('limit'), 'limit', { min: 1, max: 50 }) : 20;
    const cursor = q_.get('cursor');
    const sort = q_.get('sort') || 'latest';
    if (!['latest', 'hot'].includes(sort)) throw err.bad('不支持的排序方式');
    const cond = [`o.status = 'QUOTING'`, `o.deletedAt IS NULL`, `o.customerId <> ?`];
    const args = [user.id];
    if (q_.get('budgetMinFen')) { cond.push('o.budgetFen >= ?'); args.push(v.int(q_.get('budgetMinFen'), 'budgetMinFen', { min: 0, max: 1000000000 })); }
    if (q_.get('budgetMaxFen')) { cond.push('o.budgetFen <= ?'); args.push(v.int(q_.get('budgetMaxFen'), 'budgetMaxFen', { min: 0, max: 1000000000 })); }
    // MySQL JSON_SEARCH 模糊匹配（LIKE 降级兼容）
    if (q_.get('direction')) {
      const direction = v.str(q_.get('direction'), '仿真方向', { min: 1, max: 60 });
      cond.push(`o.directionTags LIKE ?`);
      args.push(`%${direction}%`);
    }
    if (q_.get('software')) {
      const software = v.str(q_.get('software'), '仿真软件', { min: 1, max: 60 });
      cond.push(`o.softwareTags LIKE ?`);
      args.push(`%${software}%`);
    }
    if (cursor && sort === 'latest') { cond.push('o.createdAt < ?'); args.push(cursor); }
    const orderBy = sort === 'hot'
      ? '(quoteCount + o.viewCount) DESC, o.createdAt DESC'
      : 'o.createdAt DESC';
    const rows = await query(
      `SELECT o.*,
              (SELECT COUNT(*) FROM quotes qc
                WHERE qc.orderId = o.id AND qc.status != 'WITHDRAWN') AS quoteCount,
              mq.id AS myQuoteId, mq.status AS myQuoteStatus
         FROM orders o
         LEFT JOIN quotes mq ON mq.orderId = o.id AND mq.engineerId = ?
        WHERE ${cond.join(' AND ')}
        ORDER BY ${orderBy} LIMIT ${limit}`,
      [user.id, ...args]);
    const items = rows.map((o) => orderView(o, {
        quoteCount: Number(o.quoteCount || 0),
        myQuote: o.myQuoteId ? { id: o.myQuoteId, status: o.myQuoteStatus } : null,
        description: o.description.slice(0, 80) + (o.description.length > 80 ? '…' : ''),
      }));
    const stats = await queryOne(
      `SELECT COUNT(*) AS allCount,
              COALESCE(SUM(CASE
                WHEN createdAt >= DATE_SUB(DATE(DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR)), INTERVAL 8 HOUR)
                THEN 1 ELSE 0 END), 0) AS todayCount
         FROM orders
        WHERE status = 'QUOTING' AND deletedAt IS NULL AND customerId <> ?`,
      [user.id]);
    ok(res, {
      items,
      stats: {
        allCount: Number(stats?.allCount || 0),
        todayCount: Number(stats?.todayCount || 0),
      },
      nextCursor: sort === 'latest' && rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // GET /api/market/orders/:id
  router.get('/api/market/orders/:id', async (req, res, params) => {
    const user = await requireEngineer(req);
    let o = await queryOne(`SELECT * FROM orders WHERE id=? AND deletedAt IS NULL`, [params.id]);
    if (!o) throw err.notFound('订单不存在');
    if (o.customerId === user.id) throw err.forbidden('不能承接自己发布的需求');
    const myQuote = await queryOne(
      `SELECT id, amountFen, days, solution, status FROM quotes WHERE orderId=? AND engineerId=?`,
      [o.id, user.id]);
    const iAmSelected = !!(o.selectedQuoteId && myQuote && o.selectedQuoteId === myQuote.id);
    if (o.status !== 'QUOTING' && !myQuote) throw err.forbidden('该需求已停止报价');
    await tx(async (conn) => {
      const [recorded] = await conn.execute(
        `INSERT IGNORE INTO order_views(orderId, userId, createdAt) VALUES(?,?,UTC_TIMESTAMP(3))`,
        [o.id, user.id]);
      if (recorded.affectedRows === 1) {
        await conn.execute(`UPDATE orders SET viewCount = viewCount + 1 WHERE id = ?`, [o.id]);
      }
    });
    o = await queryOne(`SELECT * FROM orders WHERE id=? AND deletedAt IS NULL`, [params.id]);
    let customer = null;
    if (iAmSelected && ['IN_PROGRESS', 'DELIVERED', 'COMPLETED', 'REFUND_PENDING'].includes(o.status)) {
      const row = await queryOne(`SELECT nickname, avatarUrl FROM users WHERE id=?`, [o.customerId]);
      if (row) customer = { nickname: row.nickname, avatarUrl: row.avatarUrl };
    }
    ok(res, {
      ...orderView(o, {}),
      quoteCount: await quoteCountOf(o.id),
      myQuote: myQuote || null,
      iAmSelected,
      customer,
    });
  });
}

module.exports = { register };
