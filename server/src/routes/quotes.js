'use strict';
/**
 * 报价。权限矩阵（方案 4.2.1）：
 *  - 工程师只能看到/改动自己的报价；报价被选中后不可修改
 *  - 客户（订单属主）可见本单全部报价
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { q, tx } = require('../db');
const { requireUser, requireEngineer } = require('../lib/auth-mw');
const { DICTS } = require('./dicts');

const quoteView = (qt, extra = {}) => ({
  id: qt.id,
  orderId: qt.orderId,
  amountFen: qt.amountFen,
  days: qt.days,
  solution: qt.solution,
  status: qt.status,
  statusText: DICTS.quoteStatus[qt.status] || qt.status,
  createdAt: qt.createdAt,
  updatedAt: qt.updatedAt,
  ...extra,
});

function register(router) {
  // POST /api/orders/:id/quotes { amountFen, days, solution } —— 提交（重复提交=修改）
  router.post('/api/orders/:id/quotes', async (req, res, params) => {
    const user = requireEngineer(req);
    const b = await readJson(req);
    const amountFen = v.int(b.amountFen, '报价金额(分)', { min: 100, max: 1000000000 });
    const days = v.int(b.days, '工期承诺(天)', { min: 1, max: 90 });
    const solution = v.str(b.solution, '技术方案', { min: 10, max: 3000 });
    const quote = tx(() => {
      const o = q.one(
        `SELECT id, status, customerId FROM orders WHERE id = ? AND deletedAt IS NULL`, params.id);
      if (!o) throw err.notFound('订单不存在');
      if (o.status !== 'QUOTING') throw err.conflict('该需求已停止报价');
      if (o.customerId === user.id) throw err.forbidden('不能给自己的需求报价');
      const exist = q.one(
        `SELECT * FROM quotes WHERE orderId = ? AND engineerId = ?`, params.id, user.id);
      if (exist) {
        if (exist.status === 'SELECTED') throw err.conflict('报价已被选中，不能修改');
        q.run(
          `UPDATE quotes SET amountFen = ?, days = ?, solution = ?, status = 'PENDING', updatedAt = ?
           WHERE id = ?`,
          amountFen, days, solution, nowIso(), exist.id
        );
        return q.one(`SELECT * FROM quotes WHERE id = ?`, exist.id);
      }
      const id = newId();
      q.run(
        `INSERT INTO quotes(id, orderId, engineerId, amountFen, days, solution, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?)`,
        id, params.id, user.id, amountFen, days, solution, nowIso(), nowIso()
      );
      return q.one(`SELECT * FROM quotes WHERE id = ?`, id);
    });
    ok(res, quoteView(quote));
  });

  // PATCH /api/quotes/:id —— 修改自己的待确认报价
  router.patch('/api/quotes/:id', async (req, res, params) => {
    const user = requireEngineer(req);
    const b = await readJson(req);
    const quote = tx(() => {
      const qt = q.one(`SELECT * FROM quotes WHERE id = ? AND engineerId = ?`, params.id, user.id);
      if (!qt) throw err.notFound('报价不存在');
      if (qt.status !== 'PENDING') throw err.conflict('仅待确认的报价可修改');
      const o = q.one(`SELECT status FROM orders WHERE id = ?`, qt.orderId);
      if (!o || o.status !== 'QUOTING') throw err.conflict('该需求已停止报价');
      q.run(
        `UPDATE quotes SET amountFen = COALESCE(?, amountFen), days = COALESCE(?, days),
           solution = COALESCE(?, solution), updatedAt = ? WHERE id = ?`,
        v.int(b.amountFen, '报价金额(分)', { min: 100, max: 1000000000, optional: true }) ?? null,
        v.int(b.days, '工期(天)', { min: 1, max: 90, optional: true }) ?? null,
        v.str(b.solution, '技术方案', { min: 10, max: 3000, optional: true }) ?? null,
        nowIso(), qt.id
      );
      return q.one(`SELECT * FROM quotes WHERE id = ?`, qt.id);
    });
    ok(res, quoteView(quote));
  });

  // DELETE /api/quotes/:id —— 撤回
  router.del('/api/quotes/:id', async (req, res, params) => {
    const user = requireEngineer(req);
    const r = q.run(
      `UPDATE quotes SET status = 'WITHDRAWN', updatedAt = ?
       WHERE id = ? AND engineerId = ? AND status = 'PENDING'`,
      nowIso(), params.id, user.id
    );
    if (r.changes === 0) throw err.conflict('仅待确认的报价可撤回');
    ok(res, { withdrawn: true });
  });

  // GET /api/quotes/mine?status=
  router.get('/api/quotes/mine', async (req, res, _p, query) => {
    const user = requireEngineer(req);
    const status = query.get('status');
    const cond = [`engineerId = ?`];
    const args = [user.id];
    if (status) { cond.push(`status = ?`); args.push(status); }
    const rows = q.all(
      `SELECT * FROM quotes WHERE ${cond.join(' AND ')} ORDER BY updatedAt DESC LIMIT 100`, ...args);
    ok(res, rows.map((qt) => {
      const o = q.one(`SELECT projectName, status, orderNo FROM orders WHERE id = ?`, qt.orderId);
      return quoteView(qt, {
        order: o ? { projectName: o.projectName, status: o.status, orderNo: o.orderNo } : null,
      });
    }));
  });

  // GET /api/orders/:id/quotes —— 客户查看本单全部报价
  router.get('/api/orders/:id/quotes', async (req, res, params) => {
    const user = requireUser(req);
    const o = q.one(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, params.id);
    if (!o) throw err.notFound('订单不存在');
    if (o.customerId !== user.id) throw err.forbidden('仅订单发布者可查看全部报价');
    const rows = q.all(
      `SELECT qt.*, u.nickname, u.avatarUrl FROM quotes qt
       JOIN users u ON u.id = qt.engineerId
       WHERE qt.orderId = ? AND qt.status != 'WITHDRAWN'
       ORDER BY qt.createdAt`, params.id);
    ok(res, rows.map((qt) => {
      const prof = q.one(
        `SELECT specialties, softwares, verifyStatus FROM engineer_profiles WHERE userId = ?`,
        qt.engineerId);
      const done = q.one(
        `SELECT COUNT(*) AS c FROM orders o JOIN quotes s ON o.selectedQuoteId = s.id
         WHERE s.engineerId = ? AND o.status = 'COMPLETED'`, qt.engineerId).c;
      return quoteView(qt, {
        engineer: {
          id: qt.engineerId,
          nickname: qt.nickname,
          avatarUrl: qt.avatarUrl,
          specialties: prof ? JSON.parse(prof.specialties || '[]') : [],
          completedCount: done,
        },
      });
    }));
  });
}

module.exports = { register };
