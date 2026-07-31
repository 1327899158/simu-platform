'use strict';
/** 抢单大厅（云开发版）。 */
const { ok, err } = require('../lib/http');
const { v } = require('../lib/util');
const { query, queryOne, parseJson } = require('../db');
const { requireEngineer } = require('../lib/auth-mw');
const { orderView, quoteCountOf } = require('./orders');

function register(router) {
  // GET /api/market/orders?direction=&software=&budgetMinFen=&budgetMaxFen=&cursor=&limit=
  router.get('/api/market/orders', async (req, res, _p, q_) => {
    const user = await requireEngineer(req);
    const limit = q_.get('limit') ? v.int(q_.get('limit'), 'limit', { min: 1, max: 50 }) : 20;
    const cursor = q_.get('cursor');
    const cond = [`status = 'QUOTING'`, `deletedAt IS NULL`];
    const args = [];
    if (q_.get('budgetMinFen')) { cond.push('budgetFen >= ?'); args.push(v.int(q_.get('budgetMinFen'), 'budgetMinFen', { min: 0, max: 1000000000 })); }
    if (q_.get('budgetMaxFen')) { cond.push('budgetFen <= ?'); args.push(v.int(q_.get('budgetMaxFen'), 'budgetMaxFen', { min: 0, max: 1000000000 })); }
    // MySQL JSON_SEARCH 模糊匹配（LIKE 降级兼容）
    if (q_.get('direction')) { cond.push(`directionTags LIKE ?`); args.push(`%${q_.get('direction')}%`); }
    if (q_.get('software')) { cond.push(`softwareTags LIKE ?`); args.push(`%${q_.get('software')}%`); }
    if (cursor) { cond.push('createdAt < ?'); args.push(cursor); }
    const rows = await query(
      `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit}`,
      args);
    const items = await Promise.all(rows.map(async (o) => {
      const mine = await queryOne(
        `SELECT id, status FROM quotes WHERE orderId=? AND engineerId=?`, [o.id, user.id]);
      return orderView(o, {
        quoteCount: await quoteCountOf(o.id),
        myQuote: mine || null,
        description: o.description.slice(0, 80) + (o.description.length > 80 ? '…' : ''),
      });
    }));
    ok(res, {
      items,
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // GET /api/market/orders/:id
  router.get('/api/market/orders/:id', async (req, res, params) => {
    const user = await requireEngineer(req);
    const o = await queryOne(`SELECT * FROM orders WHERE id=? AND deletedAt IS NULL`, [params.id]);
    if (!o) throw err.notFound('订单不存在');
    const myQuote = await queryOne(
      `SELECT id, amountFen, days, solution, status FROM quotes WHERE orderId=? AND engineerId=?`,
      [o.id, user.id]);
    const iAmSelected = !!(o.selectedQuoteId && myQuote && o.selectedQuoteId === myQuote.id);
    if (o.status !== 'QUOTING' && !myQuote) throw err.forbidden('该需求已停止报价');
    let customer = null;
    if (iAmSelected && ['IN_PROGRESS', 'DELIVERED', 'COMPLETED'].includes(o.status)) {
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
