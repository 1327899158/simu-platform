'use strict';
/** 订单（客户侧）：发布、列表、详情、删除、选标、支付、验收。状态机见 db.js 注释与文档。 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { config } = require('../config');
const { q, tx, nextOrderNo, parseJson } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { DICTS } = require('./dicts');
const { createPayment } = require('../services/pay-svc');
const { systemMessageForOrder } = require('../services/chat-svc');

function orderView(o, extra = {}) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    projectName: o.projectName,
    description: o.description,
    softwareTags: parseJson(o.softwareTags),
    directionTags: parseJson(o.directionTags),
    budgetFen: o.budgetFen,
    budgetFlexible: !!o.budgetFlexible,
    deliveryDays: o.deliveryDays,
    specialNote: o.specialNote,
    status: o.status,
    statusText: DICTS.orderStatus[o.status] || o.status,
    finalAmountFen: o.finalAmountFen,
    selectedQuoteId: o.selectedQuoteId,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    deliveredAt: o.deliveredAt,
    completedAt: o.completedAt,
    ...extra,
  };
}
const quoteCountOf = (orderId) =>
  q.one(`SELECT COUNT(*) AS c FROM quotes WHERE orderId = ? AND status != 'WITHDRAWN'`, orderId).c;

function register(router) {
  // POST /api/orders —— 发布需求（五步表单一次提交）
  router.post('/api/orders', async (req, res) => {
    const user = requireUser(req);
    if (user.role !== 'CUSTOMER') throw err.forbidden('仅客户可发布需求');
    const b = await readJson(req);
    const projectName = v.str(b.projectName, '项目名称', { min: 4, max: 60 });
    const description = v.str(b.description, '项目描述', { min: 20, max: 5000 });
    const softwareTags = v.arr(b.softwareTags, '仿真软件', { minLen: 1, maxLen: 10 });
    const directionTags = v.arr(b.directionTags, '仿真方向', { minLen: 1, maxLen: 10 });
    const deliveryDays = v.int(b.deliveryDays, '工期(天)', { min: 1, max: 90 });
    const budgetFen = v.int(b.budgetFen, '预算', { min: 100, max: 1000000000, optional: true });
    const specialNote = v.str(b.specialNote, '特殊要求', { max: 2000, optional: true });
    const fileIds = v.arr(b.fileIds, '文件', { maxLen: 20, optional: true }) || [];

    const order = tx(() => {
      const id = newId();
      q.run(
        `INSERT INTO orders(id, orderNo, customerId, projectName, description, softwareTags,
           directionTags, budgetFen, budgetFlexible, deliveryDays, specialNote, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, nextOrderNo(), user.id, projectName, description,
        JSON.stringify(softwareTags), JSON.stringify(directionTags),
        budgetFen ?? null, v.bool(b.budgetFlexible, true) ? 1 : 0,
        deliveryDays, specialNote ?? null, nowIso(), nowIso()
      );
      for (const fid of fileIds) {
        // 只允许把自己上传的、未挂订单的文件挂到新订单上
        q.run(`UPDATE files SET orderId = ? WHERE id = ? AND uploaderId = ? AND orderId IS NULL`,
          id, String(fid), user.id);
      }
      return q.one(`SELECT * FROM orders WHERE id = ?`, id);
    });
    ok(res, orderView(order, { quoteCount: 0 }));
  });

  // GET /api/orders/mine?status=&cursor=&limit=
  router.get('/api/orders/mine', async (req, res, _p, query) => {
    const user = requireUser(req);
    const status = query.get('status');
    const limit = Math.min(parseInt(query.get('limit') || '20', 10) || 20, 50);
    const cursor = query.get('cursor'); // 上一页最后一条的 createdAt
    const cond = [`customerId = ?`, `deletedAt IS NULL`];
    const args = [user.id];
    if (status) { cond.push(`status = ?`); args.push(status); }
    if (cursor) { cond.push(`createdAt < ?`); args.push(cursor); }
    const rows = q.all(
      `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`,
      ...args, limit
    );
    ok(res, {
      items: rows.map((o) => orderView(o, { quoteCount: quoteCountOf(o.id) })),
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // GET /api/orders/:id —— 客户视角详情（工程师请走 /api/market/orders/:id）
  router.get('/api/orders/:id', async (req, res, params) => {
    const user = requireUser(req);
    const o = q.one(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, params.id);
    if (!o) throw err.notFound('订单不存在');
    if (o.customerId !== user.id) throw err.forbidden();
    let engineer = null;
    if (o.selectedQuoteId) {
      engineer = q.one(
        `SELECT u.id, u.nickname, u.avatarUrl FROM quotes qt
         JOIN users u ON u.id = qt.engineerId WHERE qt.id = ?`, o.selectedQuoteId);
    }
    ok(res, orderView(o, { quoteCount: quoteCountOf(o.id), engineer }));
  });

  // DELETE /api/orders/:id —— 仅待报价可删（软删除并关闭）
  router.del('/api/orders/:id', async (req, res, params) => {
    const user = requireUser(req);
    tx(() => {
      const r = q.run(
        `UPDATE orders SET status = 'CLOSED', deletedAt = ?, updatedAt = ?
         WHERE id = ? AND customerId = ? AND status = 'QUOTING' AND deletedAt IS NULL`,
        nowIso(), nowIso(), params.id, user.id
      );
      if (r.changes === 0) throw err.conflict('仅「待报价」状态的自己订单可删除');
      q.run(`UPDATE quotes SET status = 'REJECTED', updatedAt = ? WHERE orderId = ? AND status = 'PENDING'`,
        nowIso(), params.id);
    });
    ok(res, { deleted: true });
  });

  // POST /api/orders/:id/select-quote { quoteId } —— 选标（乐观锁事务）
  router.post('/api/orders/:id/select-quote', async (req, res, params) => {
    const user = requireUser(req);
    const b = await readJson(req);
    const quoteId = v.str(b.quoteId, 'quoteId', { min: 1 });
    const result = tx(() => {
      const quote = q.one(
        `SELECT * FROM quotes WHERE id = ? AND orderId = ? AND status = 'PENDING'`,
        quoteId, params.id
      );
      if (!quote) throw err.conflict('该报价不可选（不存在或已失效）');
      const r = q.run(
        `UPDATE orders SET status = 'AWAITING_PAYMENT', selectedQuoteId = ?,
           finalAmountFen = ?, selectedAt = ?, updatedAt = ?
         WHERE id = ? AND customerId = ? AND status = 'QUOTING' AND deletedAt IS NULL`,
        quote.id, quote.amountFen, nowIso(), nowIso(), params.id, user.id
      );
      if (r.changes === 0) throw err.conflict('订单状态已变化，选标失败');
      q.run(`UPDATE quotes SET status = 'SELECTED', updatedAt = ? WHERE id = ?`, nowIso(), quote.id);
      q.run(
        `UPDATE quotes SET status = 'REJECTED', updatedAt = ?
         WHERE orderId = ? AND id != ? AND status = 'PENDING'`,
        nowIso(), params.id, quote.id
      );
      return q.one(`SELECT * FROM orders WHERE id = ?`, params.id);
    });
    ok(res, orderView(result));
  });

  // POST /api/orders/:id/pay —— 创建支付单，返回调起参数
  router.post('/api/orders/:id/pay', async (req, res, params) => {
    const user = requireUser(req);
    const o = q.one(
      `SELECT * FROM orders WHERE id = ? AND customerId = ? AND deletedAt IS NULL`,
      params.id, user.id
    );
    if (!o) throw err.notFound('订单不存在');
    if (o.status !== 'AWAITING_PAYMENT') throw err.conflict('订单不在待支付状态');
    const p = createPayment(o);
    if (config.payProvider === 'mock') {
      ok(res, {
        provider: 'mock',
        outTradeNo: p.outTradeNo,
        amountFen: p.amountFen,
        tip: '演示通道：前端弹「模拟收银台」，确认后调用 /api/payments/mock-notify',
      });
    } else {
      // PAY_PROVIDER=wechat：此处对接微信支付 v3 JSAPI 下单，见 docs/upgrade.md
      throw err.bad('微信支付通道未配置商户凭据（见 docs/upgrade.md 第 2 节）');
    }
  });

  // GET /api/orders/:id/payment —— 前端支付后轮询确认
  router.get('/api/orders/:id/payment', async (req, res, params) => {
    const user = requireUser(req);
    const o = q.one(`SELECT * FROM orders WHERE id = ?`, params.id);
    if (!o || o.customerId !== user.id) throw err.notFound('订单不存在');
    const p = q.one(
      `SELECT outTradeNo, amountFen, status, paidAt FROM payments
       WHERE orderId = ? ORDER BY createdAt DESC LIMIT 1`, params.id);
    ok(res, { orderStatus: o.status, payment: p || null });
  });

  // POST /api/orders/:id/deliver { fileIds?, note? } —— 被选中工程师交付
  router.post('/api/orders/:id/deliver', async (req, res, params) => {
    const user = requireUser(req);
    const b = await readJson(req);
    const note = v.str(b.note, '交付说明', { max: 1000, optional: true });
    const fileIds = v.arr(b.fileIds, '成果文件', { maxLen: 20, optional: true }) || [];
    tx(() => {
      const o = q.one(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, params.id);
      if (!o) throw err.notFound('订单不存在');
      const sel = o.selectedQuoteId ? q.one(`SELECT engineerId FROM quotes WHERE id = ?`, o.selectedQuoteId) : null;
      if (!sel || sel.engineerId !== user.id) throw err.forbidden('仅被选中的工程师可交付');
      const r = q.run(
        `UPDATE orders SET status = 'DELIVERED', deliveredAt = ?, updatedAt = ?
         WHERE id = ? AND status = 'IN_PROGRESS'`,
        nowIso(), nowIso(), params.id
      );
      if (r.changes === 0) throw err.conflict('订单不在执行中，无法交付');
      for (const fid of fileIds) {
        q.run(`UPDATE files SET orderId = ?, kind = 'RESULT' WHERE id = ? AND uploaderId = ?`,
          params.id, String(fid), user.id);
      }
      systemMessageForOrder(params.id, `工程师已提交交付成果${note ? '：' + note : ''}，请客户查收并确认。`);
    });
    ok(res, { delivered: true });
  });

  // POST /api/orders/:id/confirm —— 客户确认完成
  router.post('/api/orders/:id/confirm', async (req, res, params) => {
    const user = requireUser(req);
    tx(() => {
      const r = q.run(
        `UPDATE orders SET status = 'COMPLETED', completedAt = ?, updatedAt = ?
         WHERE id = ? AND customerId = ? AND status = 'DELIVERED'`,
        nowIso(), nowIso(), params.id, user.id
      );
      if (r.changes === 0) throw err.conflict('订单不在待验收状态');
      systemMessageForOrder(params.id, '客户已确认验收，订单完成。');
    });
    ok(res, { completed: true });
  });

  // POST /api/orders/:id/reject-delivery { reason } —— 客户驳回交付（简版）
  router.post('/api/orders/:id/reject-delivery', async (req, res, params) => {
    const user = requireUser(req);
    const b = await readJson(req);
    const reason = v.str(b.reason, '驳回原因', { min: 2, max: 500 });
    tx(() => {
      const r = q.run(
        `UPDATE orders SET status = 'IN_PROGRESS', deliveredAt = NULL, updatedAt = ?
         WHERE id = ? AND customerId = ? AND status = 'DELIVERED'`,
        nowIso(), nowIso(), params.id, user.id
      );
      if (r.changes === 0) throw err.conflict('订单不在待验收状态');
      systemMessageForOrder(params.id, `客户驳回了本次交付：${reason}`);
    });
    ok(res, { rejected: true });
  });
}

module.exports = { register, orderView, quoteCountOf };
