'use strict';
/** 抢单大厅（工程师侧）。客户联系信息按方案约定：支付成功前不暴露。 */
const { ok, err } = require('../lib/http');
const { q } = require('../db');
const { requireEngineer } = require('../lib/auth-mw');
const { orderView, quoteCountOf } = require('./orders');

function register(router) {
  // GET /api/market/orders?direction=&software=&budgetMinFen=&budgetMaxFen=&cursor=&limit=
  router.get('/api/market/orders', async (req, res, _p, query) => {
    const user = requireEngineer(req);
    const limit = Math.min(parseInt(query.get('limit') || '20', 10) || 20, 50);
    const cursor = query.get('cursor');
    const cond = [`status = 'QUOTING'`, `deletedAt IS NULL`];
    const args = [];
    if (query.get('budgetMinFen')) { cond.push(`budgetFen >= ?`); args.push(parseInt(query.get('budgetMinFen'), 10)); }
    if (query.get('budgetMaxFen')) { cond.push(`budgetFen <= ?`); args.push(parseInt(query.get('budgetMaxFen'), 10)); }
    // SQLite 无 JSON 索引，标签过滤用 LIKE（生产版为 MySQL JSON_CONTAINS / 关联标签表）
    if (query.get('direction')) { cond.push(`directionTags LIKE ?`); args.push(`%${query.get('direction')}%`); }
    if (query.get('software')) { cond.push(`softwareTags LIKE ?`); args.push(`%${query.get('software')}%`); }
    if (cursor) { cond.push(`createdAt < ?`); args.push(cursor); }
    const rows = q.all(
      `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`,
      ...args, limit
    );
    ok(res, {
      items: rows.map((o) => {
        const mine = q.one(
          `SELECT id, status FROM quotes WHERE orderId = ? AND engineerId = ?`, o.id, user.id);
        return orderView(o, {
          quoteCount: quoteCountOf(o.id),
          myQuote: mine || null,
          description: o.description.slice(0, 80) + (o.description.length > 80 ? '…' : ''),
        });
      }),
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // GET /api/market/orders/:id —— 工程师视角详情
  router.get('/api/market/orders/:id', async (req, res, params) => {
    const user = requireEngineer(req);
    const o = q.one(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, params.id);
    if (!o) throw err.notFound('订单不存在');
    const myQuote = q.one(
      `SELECT id, amountFen, days, solution, status FROM quotes
       WHERE orderId = ? AND engineerId = ?`, o.id, user.id);
    const iAmSelected = !!(o.selectedQuoteId && myQuote && o.selectedQuoteId === myQuote.id);
    if (o.status !== 'QUOTING' && !myQuote) throw err.forbidden('该需求已停止报价');
    // 支付后才向被选中工程师展示客户身份（方案 4.1.3）
    const customer = (iAmSelected && ['IN_PROGRESS', 'DELIVERED', 'COMPLETED'].includes(o.status))
      ? q.one(`SELECT nickname, avatarUrl FROM users WHERE id = ?`, o.customerId)
      : null;
    ok(res, {
      ...require('./orders').orderView(o, {}),
      quoteCount: quoteCountOf(o.id),
      myQuote: myQuote || null,
      iAmSelected,
      customer,
    });
  });
}

module.exports = { register };
