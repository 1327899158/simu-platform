'use strict';
/**
 * 订单路由（云开发版：MySQL 异步 + X-WX-OPENID 鉴权 + 云托管支付服务）。
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx, nextOrderNo, parseJson } = require('../db');
const { requireCustomer, requireEngineer } = require('../lib/auth-mw');
const { DICTS } = require('./dicts');
const { createPayment, createJsapiOrder } = require('../services/pay-svc');
const { config } = require('../config');
const { systemMessageForOrder } = require('../services/chat-svc');

function orderView(o, extra = {}) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    projectName: o.projectName,
    description: o.description,
    softwareTags: parseJson(o.softwareTags),
    directionTags: parseJson(o.directionTags),
    budgetFen: o.budgetFen ? Number(o.budgetFen) : null,
    budgetFlexible: !!o.budgetFlexible,
    deliveryDays: o.deliveryDays,
    specialNote: o.specialNote,
    status: o.status,
    statusText: DICTS.orderStatus[o.status] || o.status,
    finalAmountFen: o.finalAmountFen ? Number(o.finalAmountFen) : null,
    selectedQuoteId: o.selectedQuoteId,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    deliveredAt: o.deliveredAt,
    completedAt: o.completedAt,
    viewCount: Number(o.viewCount || 0),
    ...extra,
  };
}

async function quoteCountOf(orderId) {
  const r = await queryOne(
    `SELECT COUNT(*) AS c FROM quotes WHERE orderId = ? AND status != 'WITHDRAWN'`, [orderId]);
  return r ? r.c : 0;
}

function register(router) {
  // POST /api/orders
  router.post('/api/orders', async (req, res) => {
    const user = await requireCustomer(req);
    const b = await readJson(req);
    const projectName = v.str(b.projectName, '项目名称', { min: 4, max: 60 });
    const description = v.str(b.description, '项目描述', { min: 20, max: 5000 });
    const softwareTags = v.arr(b.softwareTags, '仿真软件', { minLen: 1, maxLen: 10 })
      .map((item) => v.str(item, '仿真软件', { min: 1, max: 60 }));
    const directionTags = v.arr(b.directionTags, '仿真方向', { minLen: 1, maxLen: 10 })
      .map((item) => v.str(item, '仿真方向', { min: 1, max: 60 }));
    if (new Set(softwareTags).size !== softwareTags.length) throw err.bad('仿真软件不能重复');
    if (new Set(directionTags).size !== directionTags.length) throw err.bad('仿真方向不能重复');
    const deliveryDays = v.int(b.deliveryDays, '工期(天)', { min: 1, max: 90 });
    const budgetFen = v.int(b.budgetFen, '预算', { min: 100, max: 1000000000, optional: true });
    const specialNote = v.str(b.specialNote, '特殊要求', { max: 2000, optional: true });
    const rawFileIds = v.arr(b.fileIds, '文件', { maxLen: 20, optional: true }) || [];
    const fileIds = rawFileIds.map((fid) => v.str(fid, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('附件列表包含重复文件');

    const order = await tx(async (conn) => {
      let attachmentFiles = [];
      if (fileIds.length) {
        const [rows] = await conn.execute(
          `SELECT id, uploaderId, orderId, kind
             FROM uploaded_files
            WHERE id IN (${fileIds.map(() => '?').join(',')})
            FOR UPDATE`,
          fileIds
        );
        if (rows.length !== fileIds.length) throw err.bad('部分附件不存在，请删除后重新上传');
        for (const file of rows) {
          if (file.uploaderId !== user.id) throw err.forbidden('不能使用其他用户上传的附件');
          if (file.orderId) throw err.conflict('附件已关联其他订单，请重新上传');
          if (file.kind === 'RESULT') throw err.bad('成果文件不能作为需求附件');
        }
        attachmentFiles = rows;
      }

      const id = newId();
      const orderNo = await nextOrderNo();
      const now = nowIso();
      await conn.execute(
        `INSERT INTO orders(id, orderNo, customerId, projectName, description, softwareTags,
           directionTags, budgetFen, budgetFlexible, deliveryDays, specialNote, createdAt, updatedAt)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, orderNo, user.id, projectName, description,
          JSON.stringify(softwareTags), JSON.stringify(directionTags),
          budgetFen ?? null, v.bool(b.budgetFlexible, true) ? 1 : 0,
          deliveryDays, specialNote ?? null, now, now]
      );
      for (const file of attachmentFiles) {
        const [linked] = await conn.execute(
          `UPDATE uploaded_files SET orderId = ? WHERE id = ? AND uploaderId = ? AND orderId IS NULL`,
          [id, file.id, user.id]);
        if (linked.affectedRows !== 1) throw err.conflict('附件状态已变化，请重新上传');
        await conn.execute(
          `INSERT INTO order_attachments(orderId, fileId, uploaderId, purpose, createdAt)
           VALUES(?, ?, ?, 'REQUIREMENT', ?)`,
          [id, file.id, user.id, now]
        );
      }
      const [rows] = await conn.execute(`SELECT * FROM orders WHERE id = ?`, [id]);
      return rows[0];
    });
    ok(res, orderView(order, { quoteCount: 0 }));
  });

  // GET /api/orders/mine?status=&cursor=&limit=
  router.get('/api/orders/mine', async (req, res, _p, q_) => {
    const user = await requireCustomer(req);
    const status = q_.get('status');
    const limit = q_.get('limit') ? v.int(q_.get('limit'), 'limit', { min: 1, max: 50 }) : 20;
    const cursor = q_.get('cursor');
    const cond = ['customerId = ?', 'deletedAt IS NULL'];
    const args = [user.id];
    if (status && status.trim()) { cond.push('status = ?'); args.push(status); }
    if (cursor && cursor.trim()) { cond.push('createdAt < ?'); args.push(cursor); }
    const rows = await query(
      `SELECT * FROM orders WHERE ${cond.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit}`,
      args);
    const items = await Promise.all(rows.map(async (o) => orderView(o, { quoteCount: await quoteCountOf(o.id) })));
    const countRows = await query(
      `SELECT status, COUNT(*) AS c FROM orders
       WHERE customerId = ? AND deletedAt IS NULL GROUP BY status`, [user.id]);
    const counts = { ALL: 0 };
    for (const row of countRows) {
      counts[row.status] = Number(row.c);
      counts.ALL += Number(row.c);
    }
    ok(res, {
      items,
      counts,
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // GET /api/orders/:id
  router.get('/api/orders/:id', async (req, res, params) => {
    const user = await requireCustomer(req);
    const o = await queryOne(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [params.id]);
    if (!o) throw err.notFound('订单不存在');
    if (o.customerId !== user.id) throw err.forbidden();
    let engineer = null;
    if (o.selectedQuoteId) {
      const row = await queryOne(
        `SELECT u.id, u.nickname, u.avatarUrl FROM quotes qt
         JOIN users u ON u.id = qt.engineerId WHERE qt.id = ?`, [o.selectedQuoteId]);
      if (row) engineer = { id: row.id, nickname: row.nickname, avatarUrl: row.avatarUrl };
    }
    ok(res, orderView(o, { quoteCount: await quoteCountOf(o.id), engineer }));
  });

  // DELETE /api/orders/:id
  router.del('/api/orders/:id', async (req, res, params) => {
    const user = await requireCustomer(req);
    await tx(async (conn) => {
      const [r] = await conn.execute(
        `UPDATE orders SET status='CLOSED', deletedAt=?, updatedAt=?
         WHERE id=? AND customerId=? AND status='QUOTING' AND deletedAt IS NULL`,
        [nowIso(), nowIso(), params.id, user.id]);
      if (!r.affectedRows) throw err.conflict('仅「待报价」状态的自己订单可删除');
      await conn.execute(
        `UPDATE quotes SET status='REJECTED', updatedAt=? WHERE orderId=? AND status='PENDING'`,
        [nowIso(), params.id]);
    });
    ok(res, { deleted: true });
  });

  // POST /api/orders/:id/select-quote { quoteId }
  router.post('/api/orders/:id/select-quote', async (req, res, params) => {
    const user = await requireCustomer(req);
    const b = await readJson(req);
    const quoteId = v.str(b.quoteId, 'quoteId', { min: 1 });
    const result = await tx(async (conn) => {
      const [[quote]] = await conn.execute(
        `SELECT * FROM quotes WHERE id=? AND orderId=? AND status='PENDING'`,
        [quoteId, params.id]);
      if (!quote) throw err.conflict('该报价不可选（不存在或已失效）');
      const [r] = await conn.execute(
        `UPDATE orders SET status='AWAITING_PAYMENT', selectedQuoteId=?,
           finalAmountFen=?, selectedAt=?, updatedAt=?
         WHERE id=? AND customerId=? AND status='QUOTING' AND deletedAt IS NULL`,
        [quote.id, quote.amountFen, nowIso(), nowIso(), params.id, user.id]);
      if (!r.affectedRows) throw err.conflict('订单状态已变化，选标失败');
      await conn.execute(`UPDATE quotes SET status='SELECTED', updatedAt=? WHERE id=?`, [nowIso(), quote.id]);
      await conn.execute(
        `UPDATE quotes SET status='REJECTED', updatedAt=? WHERE orderId=? AND id!=? AND status='PENDING'`,
        [nowIso(), params.id, quote.id]);
      const [[o]] = await conn.execute(`SELECT * FROM orders WHERE id=?`, [params.id]);
      return o;
    });
    ok(res, orderView(result));
  });

  // POST /api/orders/:id/pay
  router.post('/api/orders/:id/pay', async (req, res, params) => {
    const user = await requireCustomer(req);
    const o = await queryOne(
      `SELECT * FROM orders WHERE id=? AND customerId=? AND deletedAt IS NULL`,
      [params.id, user.id]);
    if (!o) throw err.notFound('订单不存在');
    if (o.status !== 'AWAITING_PAYMENT') throw err.conflict('订单不在待支付状态');

    // 模拟支付只创建正常支付单，不访问微信支付接口。
    if (config.paymentMode === 'mock') {
      const payment = await createPayment(o);
      ok(res, {
        mode: 'mock',
        outTradeNo: payment.outTradeNo,
        amountFen: Number(payment.amountFen),
        paymentStatus: payment.status,
      });
      return;
    }

    const openid = user.openid; // 小程序 openid，用于 JSAPI 下单
    if (!openid) throw err.bad('无法获取用户 openid，请通过小程序调用');
    const jsapiParams = await createJsapiOrder(o, openid);
    ok(res, jsapiParams);
  });

  // 注意：`GET /api/orders/:id/payment` 已迁移至 routes/payments.js，
  // 由支付模块统一维护支付相关查询，避免同名路由重复注册。

  // POST /api/orders/:id/deliver { fileIds?, note? }
  router.post('/api/orders/:id/deliver', async (req, res, params) => {
    const user = await requireEngineer(req);
    const b = await readJson(req);
    const note = v.str(b.note, '交付说明', { max: 1000, optional: true });
    const fileIds = v.arr(b.fileIds, '成果文件', { maxLen: 20, optional: true }) || [];
    await tx(async (conn) => {
      const [[o]] = await conn.execute(`SELECT * FROM orders WHERE id=? AND deletedAt IS NULL`, [params.id]);
      if (!o) throw err.notFound('订单不存在');
      const [[sel]] = await conn.execute(`SELECT engineerId FROM quotes WHERE id=?`, [o.selectedQuoteId || '']);
      if (!sel || sel.engineerId !== user.id) throw err.forbidden('仅被选中的工程师可交付');
      const [r] = await conn.execute(
        `UPDATE orders SET status='DELIVERED', deliveredAt=?, updatedAt=? WHERE id=? AND status='IN_PROGRESS'`,
        [nowIso(), nowIso(), params.id]);
      if (!r.affectedRows) throw err.conflict('订单不在执行中，无法交付');
      for (const fid of fileIds) {
        await conn.execute(
          `UPDATE uploaded_files SET orderId=?, kind='RESULT' WHERE id=? AND uploaderId=?`,
          [params.id, String(fid), user.id]);
      }
    });
    await systemMessageForOrder(params.id, `工程师已提交交付成果${note ? '：' + note : ''}，请客户查收并确认。`);
    ok(res, { delivered: true });
  });

  // POST /api/orders/:id/confirm
  router.post('/api/orders/:id/confirm', async (req, res, params) => {
    const user = await requireCustomer(req);
    await tx(async (conn) => {
      const [r] = await conn.execute(
        `UPDATE orders SET status='COMPLETED', completedAt=?, updatedAt=?
         WHERE id=? AND customerId=? AND status='DELIVERED'`,
        [nowIso(), nowIso(), params.id, user.id]);
      if (!r.affectedRows) throw err.conflict('订单不在待验收状态');
    });
    await systemMessageForOrder(params.id, '客户已确认验收，订单完成。');
    ok(res, { completed: true });
  });

  // POST /api/orders/:id/reject-delivery { reason }
  router.post('/api/orders/:id/reject-delivery', async (req, res, params) => {
    const user = await requireCustomer(req);
    const b = await readJson(req);
    const reason = v.str(b.reason, '驳回原因', { min: 2, max: 500 });
    await tx(async (conn) => {
      const [r] = await conn.execute(
        `UPDATE orders SET status='IN_PROGRESS', deliveredAt=NULL, updatedAt=?
         WHERE id=? AND customerId=? AND status='DELIVERED'`,
        [nowIso(), params.id, user.id]);
      if (!r.affectedRows) throw err.conflict('订单不在待验收状态');
    });
    await systemMessageForOrder(params.id, `客户驳回了本次交付：${reason}`);
    ok(res, { rejected: true });
  });
}

module.exports = { register, orderView, quoteCountOf };
