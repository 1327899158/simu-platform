'use strict';
/** 报价路由（云开发版：异步 MySQL）。 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx, parseJson } = require('../db');
const { requireUser, requireEngineer } = require('../lib/auth-mw');
const { DICTS } = require('./dicts');

const quoteView = (qt, extra = {}) => ({
  id: qt.id,
  orderId: qt.orderId,
  amountFen: Number(qt.amountFen),
  days: qt.days,
  solution: qt.solution,
  status: qt.status,
  statusText: DICTS.quoteStatus[qt.status] || qt.status,
  createdAt: qt.createdAt,
  updatedAt: qt.updatedAt,
  ...extra,
});

function register(router) {
  // POST /api/orders/:id/quotes
  router.post('/api/orders/:id/quotes', async (req, res, params) => {
    const user = await requireEngineer(req);
    const b = await readJson(req);
    const days = v.int(b.days, '工期承诺(天)', { min: 1, max: 90 });
    const solution = v.str(b.solution, '技术方案', { min: 10, max: 3000 });
    const quote = await tx(async (conn) => {
      const [[o]] = await conn.execute(
        `SELECT id, status, customerId, budgetFen, budgetFlexible FROM orders WHERE id=? AND deletedAt IS NULL`,
        [params.id]);
      if (!o) throw err.notFound('订单不存在');
      if (o.status !== 'QUOTING') throw err.conflict('该需求已停止报价');
      if (o.customerId === user.id) throw err.forbidden('不能给自己的需求报价');
      let amountFen;
      if (!o.budgetFlexible) {
        if (!o.budgetFen) throw err.conflict('该订单未设置预算且不允许协商，无法报价');
        amountFen = Number(o.budgetFen);
      } else {
        amountFen = v.int(b.amountFen, '报价金额(分)', { min: 100, max: 1000000000 });
      }
      const [[exist]] = await conn.execute(
        `SELECT * FROM quotes WHERE orderId=? AND engineerId=?`, [params.id, user.id]);
      if (exist) {
        if (exist.status === 'SELECTED') throw err.conflict('报价已被选中，不能修改');
        await conn.execute(
          `UPDATE quotes SET amountFen=?, days=?, solution=?, status='PENDING', updatedAt=? WHERE id=?`,
          [amountFen, days, solution, nowIso(), exist.id]);
        await conn.execute(`UPDATE orders SET updatedAt=? WHERE id=?`, [nowIso(), params.id]);
        const [[r]] = await conn.execute(`SELECT * FROM quotes WHERE id=?`, [exist.id]);
        return r;
      }
      const id = newId();
      const now = nowIso();
      await conn.execute(
        `INSERT INTO quotes(id, orderId, engineerId, amountFen, days, solution, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?)`,
        [id, params.id, user.id, amountFen, days, solution, now, now]);
      await conn.execute(`UPDATE orders SET updatedAt=? WHERE id=?`, [now, params.id]);
      const [[r]] = await conn.execute(`SELECT * FROM quotes WHERE id=?`, [id]);
      return r;
    });
    ok(res, quoteView(quote));
  });

  // PATCH /api/quotes/:id
  router.patch('/api/quotes/:id', async (req, res, params) => {
    const user = await requireEngineer(req);
    const b = await readJson(req);
    const quote = await tx(async (conn) => {
      const [[qt]] = await conn.execute(`SELECT * FROM quotes WHERE id=? AND engineerId=?`, [params.id, user.id]);
      if (!qt) throw err.notFound('报价不存在');
      if (qt.status !== 'PENDING') throw err.conflict('仅待确认的报价可修改');
      const [[o]] = await conn.execute(`SELECT status FROM orders WHERE id=?`, [qt.orderId]);
      if (!o || o.status !== 'QUOTING') throw err.conflict('该需求已停止报价');
      await conn.execute(
        `UPDATE quotes SET
           amountFen=COALESCE(?,amountFen), days=COALESCE(?,days),
           solution=COALESCE(?,solution), updatedAt=?
         WHERE id=?`,
        [v.int(b.amountFen, '报价金额', { min: 100, max: 1000000000, optional: true }) ?? null,
         v.int(b.days, '工期', { min: 1, max: 90, optional: true }) ?? null,
         v.str(b.solution, '技术方案', { min: 10, max: 3000, optional: true }) ?? null,
         nowIso(), qt.id]);
      await conn.execute(`UPDATE orders SET updatedAt=? WHERE id=?`, [nowIso(), qt.orderId]);
      const [[r]] = await conn.execute(`SELECT * FROM quotes WHERE id=?`, [qt.id]);
      return r;
    });
    ok(res, quoteView(quote));
  });

  // DELETE /api/quotes/:id
  router.del('/api/quotes/:id', async (req, res, params) => {
    const user = await requireEngineer(req);
    // query() 已经返回 mysql2 的 OkPacket；不能再按 [rows] 解构。
    const quote = await queryOne(`SELECT orderId FROM quotes WHERE id=? AND engineerId=? AND status='PENDING'`, [params.id, user.id]);
    if (!quote) throw err.conflict('仅待确认的报价可撤回');
    const now = nowIso();
    await tx(async (conn) => {
      const [r] = await conn.execute(
        `UPDATE quotes SET status='WITHDRAWN', updatedAt=? WHERE id=? AND engineerId=? AND status='PENDING'`,
        [now, params.id, user.id]);
      if (!r.affectedRows) throw err.conflict('仅待确认的报价可撤回');
      await conn.execute(`UPDATE orders SET updatedAt=? WHERE id=?`, [now, quote.orderId]);
    });
    ok(res, { withdrawn: true });
  });

  // GET /api/quotes/mine?status=
  router.get('/api/quotes/mine', async (req, res, _p, q_) => {
    const user = await requireEngineer(req);
    const status = q_.get('status');
    const cond = ['engineerId = ?'];
    const args = [user.id];
    if (status && status.trim()) { cond.push('status = ?'); args.push(status); }
    const rows = await query(
      `SELECT * FROM quotes WHERE ${cond.join(' AND ')} ORDER BY updatedAt DESC LIMIT 100`, args);
    const result = await Promise.all(rows.map(async (qt) => {
      const o = await queryOne(`SELECT projectName, status, orderNo FROM orders WHERE id=?`, [qt.orderId]);
      return quoteView(qt, { order: o ? { projectName: o.projectName, status: o.status, orderNo: o.orderNo } : null });
    }));
    if (q_.get('includeCounts') !== '1') {
      ok(res, result);
      return;
    }
    const countRows = await query(
      `SELECT qt.status AS quoteStatus, o.status AS orderStatus, COUNT(*) AS c
         FROM quotes qt LEFT JOIN orders o ON o.id = qt.orderId
        WHERE qt.engineerId = ?
        GROUP BY qt.status, o.status`, [user.id]);
    const counts = { ALL: 0, PENDING: 0, SELECTED: 0, DELIVERED: 0, COMPLETED: 0, REFUND_PENDING: 0, CANCELLED: 0, REJECTED: 0, WITHDRAWN: 0 };
    for (const row of countRows) {
      const count = Number(row.c);
      counts.ALL += count;
      if (Object.prototype.hasOwnProperty.call(counts, row.quoteStatus)) counts[row.quoteStatus] += count;
      if (row.quoteStatus === 'SELECTED' && ['DELIVERED', 'COMPLETED', 'REFUND_PENDING', 'CANCELLED'].includes(row.orderStatus)) {
        counts[row.orderStatus] += count;
      }
    }
    ok(res, { items: result, counts });
  });

  // GET /api/orders/:id/quotes
  router.get('/api/orders/:id/quotes', async (req, res, params) => {
    const user = await requireUser(req);
    const o = await queryOne(`SELECT * FROM orders WHERE id=? AND deletedAt IS NULL`, [params.id]);
    if (!o) throw err.notFound('订单不存在');
    if (user.role === 'CUSTOMER') {
      if (o.customerId !== user.id) throw err.forbidden('仅订单发布者可查看该需求报价');
    } else if (user.role === 'ENGINEER') {
      if (o.customerId === user.id) throw err.forbidden('不能以工程师身份查看自己的需求报价');
      if (o.status !== 'QUOTING') {
        const participated = await queryOne(
          `SELECT id FROM quotes WHERE orderId=? AND engineerId=? LIMIT 1`,
          [o.id, user.id]
        );
        if (!participated) throw err.forbidden('该需求已停止报价，仅参与过报价的工程师可查看');
      }
    } else {
      throw err.forbidden('当前身份不能查看报价');
    }
    const rows = await query(
      `SELECT qt.*, u.nickname, u.avatarUrl FROM quotes qt
       JOIN users u ON u.id = qt.engineerId
       WHERE qt.orderId=? AND qt.status != 'WITHDRAWN' ORDER BY qt.createdAt`, [params.id]);
    const result = await Promise.all(rows.map(async (qt) => {
      const prof = await queryOne(
        `SELECT specialties, softwares FROM engineer_profiles WHERE userId=?`, [qt.engineerId]);
      const doneRow = await queryOne(
        `SELECT COUNT(*) AS c FROM orders o JOIN quotes s ON o.selectedQuoteId=s.id
         WHERE s.engineerId=? AND o.status='COMPLETED'`, [qt.engineerId]);
      const ratingRow = await queryOne(
        `SELECT COUNT(*) AS reviewCount,
               AVG((qualityScore + attitudeScore + speedScore +
                    COALESCE(professionalScore, (qualityScore + attitudeScore + speedScore) / 3) +
                    COALESCE(communicationScore, (qualityScore + attitudeScore + speedScore) / 3)) / 5) AS averageScore
           FROM engineer_reviews WHERE engineerId=?`, [qt.engineerId]);
      const reviewCount = Number(ratingRow?.reviewCount || 0);
      return quoteView(qt, {
        isMine: user.role === 'ENGINEER' && qt.engineerId === user.id,
        engineer: {
          id: qt.engineerId,
          nickname: qt.nickname,
          avatarUrl: qt.avatarUrl,
          specialties: prof ? parseJson(prof.specialties) : [],
          completedCount: Number(doneRow?.c || 0),
          reviewCount,
          averageScore: reviewCount ? Number(Number(ratingRow.averageScore).toFixed(1)) : null,
        },
      });
    }));
    ok(res, result);
  });
}

module.exports = { register };
