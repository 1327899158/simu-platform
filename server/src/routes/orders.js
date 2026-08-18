'use strict';
/**
 * 订单路由（云开发版：MySQL 异步 + X-WX-OPENID 鉴权 + 云托管支付服务）。
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx, nextOrderNo, parseJson } = require('../db');
const { requireUser, requireCustomer, requireVerifiedCustomer, requireEngineer } = require('../lib/auth-mw');
const { DICTS } = require('./dicts');
const { createPayment, createJsapiOrder } = require('../services/pay-svc');
const { config } = require('../config');
const { systemMessageForOrder } = require('../services/chat-svc');
const { evidenceDeadlineIso } = require('../services/dispute-svc');

const REFUND_REQUESTABLE_ORDER_STATUS = ['IN_PROGRESS', 'DELIVERED'];
// 保留 COMPLETED 仅用于兼容升级前已存在的退款记录恢复状态，新申请不得使用。
const REFUND_RESTORABLE_ORDER_STATUS = [...REFUND_REQUESTABLE_ORDER_STATUS, 'COMPLETED'];

function refundFileView(row) {
  return {
    id: row.fileId || row.id,
    fileId: row.fileId || row.id,
    name: row.name,
    kind: row.kind,
    mime: row.mime || '',
    sizeBytes: Number(row.sizeBytes || 0),
    createdAt: row.createdAt,
  };
}

function refundRequestView(row, files = []) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    statusText: row.status === 'PENDING' ? '待工程师确认' : row.status === 'REJECTED' ? '工程师已拒绝' : row.status,
    reason: row.reason || '历史退款申请未填写理由',
    files: files.map(refundFileView),
    disputeId: row.disputeId || null,
    createdAt: row.createdAt,
    respondedAt: row.respondedAt || null,
  };
}

function customerQuotingText(quoteCount) {
  return Number(quoteCount || 0) > 0 ? '待确认' : '未报价';
}

async function refundFilesOf(refundRequestId) {
  return query(
    `SELECT rf.fileId, f.name, f.kind, f.mime, f.sizeBytes, rf.createdAt
       FROM refund_request_files rf
       JOIN uploaded_files f ON f.id = rf.fileId
      WHERE rf.refundRequestId = ?
      ORDER BY rf.createdAt ASC`,
    [refundRequestId]
  );
}

function orderView(o, extra = {}) {
  const { customerQuoteStage = false, ...rest } = extra;
  const quoteCount = rest.quoteCount;
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
    statusText: customerQuoteStage && o.status === 'QUOTING'
      ? customerQuotingText(quoteCount)
      : (DICTS.orderStatus[o.status] || o.status),
    finalAmountFen: o.finalAmountFen ? Number(o.finalAmountFen) : null,
    selectedQuoteId: o.selectedQuoteId,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    deliveredAt: o.deliveredAt,
    completedAt: o.completedAt,
    viewCount: Number(o.viewCount || 0),
    ...rest,
  };
}

async function quoteCountOf(orderId) {
  const r = await queryOne(
    `SELECT COUNT(*) AS c FROM quotes WHERE orderId = ? AND status != 'WITHDRAWN'`, [orderId]);
  return r ? r.c : 0;
}

/** 若订单处于纠纷中则抛出冲突，用于拦截任何推进订单状态的操作 */
async function assertNotDisputing(orderId) {
  const o = await queryOne(`SELECT status FROM orders WHERE id = ?`, [orderId]);
  if (o && o.status === 'DISPUTING') throw err.conflict('订单处于纠纷处理中，请等待平台仲裁');
  return o;
}

function register(router) {
  // POST /api/orders
  router.post('/api/orders', async (req, res) => {
    const user = await requireVerifiedCustomer(req);
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
    const cond = ['o.customerId = ?', 'o.deletedAt IS NULL'];
    const args = [user.id];
    const quoteExists = `EXISTS (SELECT 1 FROM quotes q WHERE q.orderId=o.id AND q.status != 'WITHDRAWN')`;
    if (status && status.trim()) {
      const requested = String(status).trim().toUpperCase();
      if (requested === 'UNQUOTED') cond.push(`o.status = 'QUOTING' AND NOT ${quoteExists}`);
      else if (requested === 'AWAITING_CONFIRMATION') cond.push(`o.status = 'QUOTING' AND ${quoteExists}`);
      else {
        v.oneOf(requested, '订单状态', Object.keys(DICTS.orderStatus));
        cond.push('o.status = ?'); args.push(requested);
      }
    }
    if (cursor && cursor.trim()) { cond.push('o.createdAt < ?'); args.push(cursor); }
    const rows = await query(
      `SELECT o.* FROM orders o WHERE ${cond.join(' AND ')} ORDER BY o.createdAt DESC LIMIT ${limit}`,
      args);
    const items = await Promise.all(rows.map(async (o) => {
      const quoteCount = await quoteCountOf(o.id);
      return orderView(o, { quoteCount, customerQuoteStage: true });
    }));
    const countRows = await query(
      `SELECT o.status, COUNT(*) AS c,
              SUM(CASE WHEN o.status='QUOTING' AND ${quoteExists} THEN 1 ELSE 0 END) AS awaitingConfirmation
         FROM orders o
        WHERE o.customerId = ? AND o.deletedAt IS NULL
        GROUP BY o.status`, [user.id]);
    const counts = { ALL: 0 };
    for (const row of countRows) {
      counts[row.status] = Number(row.c);
      counts.ALL += Number(row.c);
      if (row.status === 'QUOTING') {
        counts.AWAITING_CONFIRMATION = Number(row.awaitingConfirmation || 0);
        counts.UNQUOTED = Number(row.c) - counts.AWAITING_CONFIRMATION;
      }
    }
    const readState = await queryOne(`SELECT lastReadAt FROM customer_order_reads WHERE customerId=?`, [user.id]);
    let unreadCount = 0;
    if (readState?.lastReadAt) {
      const unread = await queryOne(
        `SELECT COUNT(*) AS c FROM orders
          WHERE customerId=? AND deletedAt IS NULL AND updatedAt > ?`, [user.id, readState.lastReadAt]);
      unreadCount = Number(unread?.c || 0);
    } else {
      // 第一次打开新版本时建立阅读基线，避免历史订单全部被误认为新提醒。
      await query(`INSERT IGNORE INTO customer_order_reads(customerId, lastReadAt) VALUES(?, ?)`, [user.id, nowIso()]);
    }
    ok(res, {
      items,
      counts,
      unreadCount,
      nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
    });
  });

  // 客户点击“我的订单”后确认已查看变更，首页红点随即消除。
  router.post('/api/orders/mine/mark-read', async (req, res) => {
    const user = await requireCustomer(req);
    const now = nowIso();
    await query(
      `INSERT INTO customer_order_reads(customerId, lastReadAt) VALUES(?, ?)
       ON DUPLICATE KEY UPDATE lastReadAt=VALUES(lastReadAt)`, [user.id, now]);
    ok(res, { readAt: now });
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
    const review = await queryOne(
      `SELECT id, qualityScore, attitudeScore, speedScore, professionalScore, communicationScore, content, revisionCount, createdAt, updatedAt
         FROM engineer_reviews WHERE orderId=? AND customerId=?`, [o.id, user.id]);
    const quoteCount = await quoteCountOf(o.id);
    ok(res, orderView(o, {
      quoteCount, customerQuoteStage: true,
      engineer,
      review: review ? {
        ...review,
        qualityScore: Number(review.qualityScore),
        attitudeScore: Number(review.attitudeScore),
        speedScore: Number(review.speedScore),
        professionalScore: review.professionalScore == null
          ? Number(((Number(review.qualityScore) + Number(review.attitudeScore) + Number(review.speedScore)) / 3).toFixed(1))
          : Number(review.professionalScore),
        communicationScore: review.communicationScore == null
          ? Number(((Number(review.qualityScore) + Number(review.attitudeScore) + Number(review.speedScore)) / 3).toFixed(1))
          : Number(review.communicationScore),
        revisionCount: Number(review.revisionCount || 0),
        content: review.content || '',
      } : null,
    }));
  });

  // GET /api/orders/:id/refund-request —— 当前待处理的退款申请（客户/选中工程师可见）
  router.get('/api/orders/:id/refund-request', async (req, res, params) => {
    const user = await requireUser(req);
    const order = await queryOne(
      `SELECT o.customerId, q.engineerId
         FROM orders o
         LEFT JOIN quotes q ON q.id = o.selectedQuoteId
        WHERE o.id = ? AND o.deletedAt IS NULL`,
      [params.id]
    );
    if (!order) throw err.notFound('订单不存在');
    if (order.customerId !== user.id && order.engineerId !== user.id) {
      throw err.forbidden('仅订单双方可查看退款申请');
    }
    const refundRequest = await queryOne(
      `SELECT * FROM refund_requests
        WHERE orderId = ? AND (status = 'PENDING' OR (status = 'REJECTED' AND disputeId IS NULL))
        ORDER BY createdAt DESC LIMIT 1`,
      [params.id]
    );
    const files = refundRequest ? await refundFilesOf(refundRequest.id) : [];
    ok(res, refundRequestView(refundRequest, files));
  });

  // POST /api/orders/:id/refund-request —— 客户发起退款，由选中工程师确认。
  router.post('/api/orders/:id/refund-request', async (req, res, params) => {
    const customer = await requireCustomer(req);
    const body = await readJson(req);
    const reason = v.str(body.reason, '退款理由', { min: 1, max: 1000 });
    const rawFileIds = v.arr(body.fileIds, '退款附件', { maxLen: 5, optional: true }) || [];
    const fileIds = rawFileIds.map((fileId) => v.str(fileId, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('退款附件包含重复文件');

    const result = await tx(async (conn) => {
      const [[order]] = await conn.execute(
        `SELECT o.*, q.engineerId
           FROM orders o
           JOIN quotes q ON q.id = o.selectedQuoteId
          WHERE o.id = ? AND o.customerId = ? AND o.deletedAt IS NULL
          FOR UPDATE`,
        [params.id, customer.id]
      );
      if (!order) throw err.notFound('订单不存在或尚未选定工程师');
      if (!REFUND_REQUESTABLE_ORDER_STATUS.includes(order.status)) {
        throw err.conflict('当前订单状态不可发起退款');
      }
      const [[pending]] = await conn.execute(
        `SELECT id FROM refund_requests
          WHERE orderId = ? AND status IN ('PENDING', 'REJECTED')
          FOR UPDATE`,
        [order.id]
      );
      if (pending) throw err.conflict('该订单已有退款申请；若已被拒绝，请申请客服介入处理');
      const [[dispute]] = await conn.execute(
        `SELECT id FROM disputes WHERE orderId = ? AND status = 'OPEN' FOR UPDATE`,
        [order.id]
      );
      if (dispute) throw err.conflict('订单存在进行中的纠纷，暂不能申请退款');

      let refundFiles = [];
      if (fileIds.length) {
        const [rows] = await conn.execute(
          `SELECT f.id AS fileId, f.uploaderId, f.orderId, f.name, f.kind, f.mime, f.sizeBytes,
                  EXISTS(SELECT 1 FROM engineer_verification_files evf WHERE evf.fileId = f.id) AS usedForVerification,
                  EXISTS(SELECT 1 FROM dispute_evidence de WHERE de.fileId = f.id) AS usedForDispute,
                  EXISTS(SELECT 1 FROM refund_request_files rf WHERE rf.fileId = f.id) AS usedForRefund
             FROM uploaded_files f
            WHERE f.id IN (${fileIds.map(() => '?').join(',')})
            FOR UPDATE`,
          fileIds
        );
        if (rows.length !== fileIds.length) throw err.bad('部分退款附件不存在，请删除后重新上传');
        for (const file of rows) {
          if (file.uploaderId !== customer.id) throw err.forbidden('不能使用其他用户上传的附件');
          if (file.orderId) throw err.conflict('退款附件已用于其他业务，请重新上传');
          if (file.usedForVerification || file.usedForDispute || file.usedForRefund) {
            throw err.conflict('退款附件已用于其他业务，请重新上传');
          }
          if (file.kind === 'RESULT') throw err.bad('成果文件不能作为退款申请附件');
        }
        refundFiles = rows;
      }

      const id = newId();
      const now = nowIso();
      const originalStatus = order.status;
      const [frozen] = await conn.execute(
        `UPDATE orders SET status = 'REFUND_PENDING', updatedAt = ?
          WHERE id = ? AND status = ?`,
        [now, order.id, originalStatus]
      );
      if (frozen.affectedRows !== 1) throw err.conflict('订单状态已变化，请刷新后重试');
      await conn.execute(
        `INSERT INTO refund_requests
           (id, orderId, customerId, engineerId, status, orderStatusAtRequest, reason, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        [id, order.id, customer.id, order.engineerId, originalStatus, reason, now, now]
      );
      for (const file of refundFiles) {
        await conn.execute(
          `INSERT INTO refund_request_files(refundRequestId, fileId, uploaderId, createdAt)
           VALUES(?, ?, ?, ?)`,
          [id, file.fileId, customer.id, now]
        );
      }
      return { id, orderId: order.id, status: 'PENDING', reason, createdAt: now, files: refundFiles };
    });
    systemMessageForOrder(
      params.id,
      `客户发起退款申请：${reason.length > 48 ? `${reason.slice(0, 48)}…` : reason}。请进入订单查看材料并确认同意或拒绝。`,
      { senderId: customer.id, actionOrderId: params.id }
    ).catch(() => {});
    ok(res, refundRequestView(result, result.files));
  });

  // POST /api/orders/:id/refund-request/respond { action: ACCEPT | REJECT }
  // 同意：订单标记为已取消（暂不执行真实退款）；拒绝：恢复订单，客户可自行决定是否申请客服介入。
  router.post('/api/orders/:id/refund-request/respond', async (req, res, params) => {
    const engineer = await requireEngineer(req);
    const body = await readJson(req);
    const action = v.oneOf(String(body.action || '').toUpperCase(), '退款处理结果', ['ACCEPT', 'REJECT']);
    const result = await tx(async (conn) => {
      const [[refundRequest]] = await conn.execute(
        `SELECT rr.*, o.status AS orderStatus
           FROM refund_requests rr
           JOIN orders o ON o.id = rr.orderId
          WHERE rr.orderId = ? AND rr.engineerId = ? AND rr.status = 'PENDING'
          FOR UPDATE`,
        [params.id, engineer.id]
      );
      if (!refundRequest) throw err.notFound('没有待处理的退款申请');
      if (refundRequest.orderStatus !== 'REFUND_PENDING') {
        throw err.conflict('订单状态已变化，无法处理退款申请');
      }
      const originalStatus = REFUND_RESTORABLE_ORDER_STATUS.includes(refundRequest.orderStatusAtRequest)
        ? refundRequest.orderStatusAtRequest : 'IN_PROGRESS';
      const now = nowIso();

      if (action === 'ACCEPT') {
        const [changed] = await conn.execute(
          `UPDATE orders
            SET status = 'CANCELLED', updatedAt = ?
            WHERE id = ? AND status = 'REFUND_PENDING'`,
          [now, refundRequest.orderId]
        );
        if (changed.affectedRows !== 1) throw err.conflict('订单状态已变化，无法取消');
        await conn.execute(
          `UPDATE refund_requests
              SET status = 'AGREED', respondedAt = ?, updatedAt = ?
            WHERE id = ? AND status = 'PENDING'`,
          [now, now, refundRequest.id]
        );
        return { accepted: true, orderStatus: 'CANCELLED', refundRequestId: refundRequest.id };
      }

      const [restored] = await conn.execute(
        `UPDATE orders
            SET status = ?, updatedAt = ?
          WHERE id = ? AND status = 'REFUND_PENDING'`,
        [originalStatus, now, refundRequest.orderId]
      );
      if (restored.affectedRows !== 1) throw err.conflict('订单状态已变化，无法拒绝退款申请');
      await conn.execute(
        `UPDATE refund_requests
            SET status = 'REJECTED', disputeId = NULL, respondedAt = ?, updatedAt = ?
          WHERE id = ? AND status = 'PENDING'`,
        [now, now, refundRequest.id]
      );
      return { accepted: false, rejected: true, orderStatus: originalStatus, refundRequestId: refundRequest.id };
    });

    const message = result.accepted
      ? '工程师已同意退款申请。订单已取消，退款资金处理将由平台后续处理。'
      : '工程师已拒绝退款申请。客户可在订单详情中选择“申请客服介入”。';
    systemMessageForOrder(
      params.id,
      message,
      { senderId: engineer.id, actionOrderId: params.id }
    ).catch(() => {});
    ok(res, result);
  });

  // POST /api/orders/:id/refund-request/escalate —— 客户在退款被拒后主动申请客服介入。
  router.post('/api/orders/:id/refund-request/escalate', async (req, res, params) => {
    const customer = await requireCustomer(req);
    const result = await tx(async (conn) => {
      const [[refundRequest]] = await conn.execute(
        `SELECT rr.*, o.status AS orderStatus
           FROM refund_requests rr JOIN orders o ON o.id=rr.orderId
          WHERE rr.orderId=? AND rr.customerId=?
          ORDER BY rr.createdAt DESC LIMIT 1 FOR UPDATE`, [params.id, customer.id]);
      if (!refundRequest || refundRequest.status !== 'REJECTED') {
        throw err.conflict('没有可申请客服介入的退款拒绝记录');
      }
      const originalStatus = REFUND_RESTORABLE_ORDER_STATUS.includes(refundRequest.orderStatusAtRequest)
        ? refundRequest.orderStatusAtRequest : 'IN_PROGRESS';
      if (refundRequest.orderStatus !== originalStatus) throw err.conflict('订单状态已变化，暂不能申请客服介入');
      const [[openDispute]] = await conn.execute(
        `SELECT id FROM disputes WHERE orderId=? AND status='OPEN' FOR UPDATE`, [refundRequest.orderId]);
      if (openDispute) throw err.conflict('订单已有进行中的纠纷');
      const now = nowIso();
      const disputeId = newId();
      const [frozen] = await conn.execute(
        `UPDATE orders SET status='DISPUTING', updatedAt=? WHERE id=? AND status=?`,
        [now, refundRequest.orderId, originalStatus]);
      if (frozen.affectedRows !== 1) throw err.conflict('订单状态已变化，请刷新后重试');
      await conn.execute(
        `INSERT INTO disputes
           (id, orderId, initiatorId, reasonType, description, status, orderStatusAtOpen, evidenceDeadlineAt, createdAt, updatedAt)
         VALUES(?, ?, ?, 'OTHER', ?, 'OPEN', ?, ?, ?, ?)`,
        [disputeId, refundRequest.orderId, customer.id,
          `客户退款申请被工程师拒绝，现申请客服介入处理。退款理由：${refundRequest.reason || '未填写'}`,
          originalStatus, evidenceDeadlineIso(), now, now]
      );
      // 客户决定申请客服介入时，将退款申请附件作为纠纷的首批证据。
      await conn.execute(
        `INSERT IGNORE INTO dispute_evidence(disputeId, fileId, uploaderId, createdAt)
         SELECT ?, fileId, uploaderId, createdAt
           FROM refund_request_files
          WHERE refundRequestId = ?`,
        [disputeId, refundRequest.id]
      );
      await conn.execute(
        `UPDATE refund_requests SET status='ESCALATED', disputeId=?, updatedAt=? WHERE id=? AND status='REJECTED'`,
        [disputeId, now, refundRequest.id]);
      return { disputeId, refundRequestId: refundRequest.id };
    });
    systemMessageForOrder(params.id, '客户已申请客服介入，订单进入纠纷处理，请双方在48小时内上传证据。', {
      senderId: customer.id, actionOrderId: params.id,
    }).catch(() => {});
    ok(res, result);
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
    await assertNotDisputing(params.id);
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
    await assertNotDisputing(params.id);
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
    await assertNotDisputing(params.id);
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
