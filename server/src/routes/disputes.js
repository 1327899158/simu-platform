'use strict';
/**
 * 纠纷路由（云开发版）。
 *
 * 当事人（客户 / 选中工程师）：
 *   POST /api/orders/:id/dispute           发起纠纷（冻结订单）
 *   GET  /api/disputes/mine                我的纠纷列表
 *   GET  /api/disputes/:id                 纠纷详情（含消息/证据）
 *   GET  /api/orders/:id/dispute           查询订单是否有进行中纠纷
 *   POST /api/disputes/:id/messages        纠纷线程发言
 *   POST /api/disputes/:id/cancel          发起人取消纠纷
 *
 * 管理员（DISPUTE_READ / DISPUTE_RESOLVE）：
 *   GET  /api/admin/disputes               纠纷列表
 *   GET  /api/admin/disputes/:id           纠纷详情
 *   POST /api/admin/disputes/:id/resolve   仲裁结案（改状态 + 退款登记）
 *   POST /api/admin/disputes/:id/refund    退款登记状态更新
 */
const { readJson, ok, err } = require('../lib/http');
const { v, maskPhone, nowIso, parseDbDate } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { requireAdmin, writeAdminAudit } = require('../lib/admin-mw');
const {
  REASON_TYPES, VERDICTS, ORDER_ACTIONS,
  findOpenDispute, isOrderParty,
  createDispute, cancelDispute, resolveDispute, updateRefund,
} = require('../services/dispute-svc');

const REASON_TEXT = {
  QUALITY: '成果质量不符', DELAY: '交付延迟', MISSING: '成果缺失',
  PAYMENT: '费用争议', COMMUNICATION: '沟通不畅', OTHER: '其他',
};
const VERDICT_TEXT = {
  NONE: '待仲裁', CUSTOMER_FAVOR: '支持买家', ENGINEER_FAVOR: '支持工程师', PARTIAL: '部分支持',
};
const STATUS_TEXT = { OPEN: '进行中', RESOLVED: '已结案', CANCELLED: '已取消' };
const REFUND_TEXT = { NONE: '无', PENDING: '待退款', PROCESSED: '已退款', FAILED: '退款失败' };
const ACTION_TEXT = {
  KEEP: '恢复原状', FORCE_COMPLETE: '强制完成', REOPEN: '重新执行', CLOSE: '关闭订单',
};
const MAX_EVIDENCE_PER_PARTY = 20;

function evidenceWindow(d) {
  const createdMs = parseDbDate(d.createdAt).getTime();
  const fallbackMs = createdMs + 48 * 60 * 60 * 1000;
  const parsedDeadline = d.evidenceDeadlineAt ? parseDbDate(d.evidenceDeadlineAt).getTime() : fallbackMs;
  const deadlineMs = Number.isFinite(parsedDeadline) ? parsedDeadline : fallbackMs;
  const remainingSeconds = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
  return {
    evidenceDeadlineAt: new Date(deadlineMs).toISOString(),
    evidenceOpen: d.status === 'OPEN' && remainingSeconds > 0,
    evidenceRemainingSeconds: d.status === 'OPEN' ? remainingSeconds : 0,
    arbitrationReady: d.status === 'OPEN' && remainingSeconds === 0,
  };
}

function disputeView(d, extra = {}) {
  return {
    id: d.id,
    orderId: d.orderId,
    initiatorId: d.initiatorId,
    reasonType: d.reasonType,
    reasonText: REASON_TEXT[d.reasonType] || d.reasonType,
    description: d.description,
    status: d.status,
    statusText: STATUS_TEXT[d.status] || d.status,
    orderStatusAtOpen: d.orderStatusAtOpen,
    refundAmountFen: d.refundAmountFen == null ? null : Number(d.refundAmountFen),
    refundStatus: d.refundStatus,
    refundStatusText: REFUND_TEXT[d.refundStatus] || d.refundStatus,
    refundTransactionId: d.refundTransactionId || null,
    verdict: d.verdict,
    verdictText: VERDICT_TEXT[d.verdict] || d.verdict,
    orderAction: d.orderAction,
    orderActionText: ACTION_TEXT[d.orderAction] || d.orderAction,
    resolutionNote: d.resolutionNote || '',
    resolvedBy: d.resolvedBy || null,
    resolvedAt: d.resolvedAt || null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...evidenceWindow(d),
    ...extra,
  };
}

/** 组装纠纷详情（含订单信息、当事人、证据、消息） */
async function disputeDetail(d) {
  const order = await queryOne(
    `SELECT id, orderNo, projectName, status, customerId, selectedQuoteId FROM orders WHERE id = ?`,
    [d.orderId]
  );
  const customer = order
    ? await queryOne(`SELECT id, nickname, avatarUrl, phone FROM users WHERE id = ?`, [order.customerId])
    : null;
  let engineer = null;
  if (order && order.selectedQuoteId) {
    const q = await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [order.selectedQuoteId]);
    if (q) {
      engineer = await queryOne(`SELECT id, nickname, avatarUrl, phone FROM users WHERE id = ?`, [q.engineerId]);
    }
  }
  const evidence = await query(
    `SELECT f.id, f.fileID, f.name, f.kind, f.mime, f.sizeBytes,
            ev.uploaderId, ev.createdAt, u.nickname AS uploaderName, u.role AS uploaderRole
       FROM dispute_evidence ev
       JOIN uploaded_files f ON f.id = ev.fileId
       JOIN users u ON u.id = ev.uploaderId
      WHERE ev.disputeId = ? ORDER BY ev.createdAt ASC`, [d.id]
  );
  const messages = await query(
    `SELECT id, senderId, type, content, fileId, createdAt
       FROM dispute_messages WHERE disputeId = ? ORDER BY id ASC LIMIT 500`, [d.id]
  );
  // 消息发送者身份（普通用户取昵称，管理员取 displayName，SYSTEM 特殊标记）
  const senderIds = [...new Set(messages.map((m) => m.senderId))];
  let senderMap = {};
  if (senderIds.length) {
    const marks = senderIds.map(() => '?').join(',');
    const users = await query(
      `SELECT id, nickname, avatarUrl FROM users WHERE id IN (${marks})`, senderIds
    );
    for (const u of users) senderMap[u.id] = { kind: 'user', nickname: u.nickname, avatarUrl: u.avatarUrl };
    const admins = await query(
      `SELECT a.id, a.displayName, u.avatarUrl
         FROM admin_accounts a LEFT JOIN users u ON u.id = a.userId
        WHERE a.id IN (${marks})`, senderIds
    );
    for (const a of admins) senderMap[a.id] = { kind: 'admin', nickname: a.displayName || '管理员', avatarUrl: a.avatarUrl || '' };
  }
  return disputeView(d, {
    order: order ? {
      id: order.id, orderNo: order.orderNo, projectName: order.projectName, status: order.status,
    } : null,
    customer: customer ? {
      id: customer.id, nickname: customer.nickname || '客户', avatarUrl: customer.avatarUrl || '',
      phoneMasked: maskPhone(customer.phone),
    } : null,
    engineer: engineer ? {
      id: engineer.id, nickname: engineer.nickname || '工程师', avatarUrl: engineer.avatarUrl || '',
      phoneMasked: maskPhone(engineer.phone),
    } : null,
    evidence: evidence.map((f) => ({
      id: f.id, fileId: f.id, fileID: f.fileID, name: f.name, kind: f.kind,
      mime: f.mime || '', sizeBytes: Number(f.sizeBytes || 0), uploaderId: f.uploaderId, createdAt: f.createdAt,
      uploaderName: f.uploaderName || (f.uploaderRole === 'ENGINEER' ? '工程师' : '客户'),
      uploaderRole: f.uploaderRole,
    })),
    messages: messages.map((m) => ({
      id: Number(m.id),
      senderId: m.senderId,
      type: m.type,
      content: m.content,
      fileId: m.fileId,
      createdAt: m.createdAt,
      sender: m.senderId === 'SYSTEM'
        ? { kind: 'system', nickname: '系统' }
        : (senderMap[m.senderId] || { kind: 'user', nickname: '未知用户', avatarUrl: '' }),
    })),
  });
}

function register(router) {
  // ================= 当事人接口 =================

  // POST /api/orders/:id/dispute { reasonType, description, fileIds? }
  router.post('/api/orders/:id/dispute', async (req, res, params) => {
    const user = await requireUser(req);
    const b = await readJson(req);
    const reasonType = v.oneOf(String(b.reasonType || '').toUpperCase(), '纠纷类型', REASON_TYPES);
    const description = v.str(b.description, '纠纷说明', { min: 10, max: 3000 });
    const rawFileIds = v.arr(b.fileIds, '证据文件', { maxLen: 20, optional: true }) || [];
    const fileIds = rawFileIds.map((fid) => v.str(fid, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('证据文件列表包含重复文件');

    const dispute = await createDispute(user, { orderId: params.id, reasonType, description, fileIds });
    ok(res, disputeView(dispute));
  });

  // GET /api/orders/:id/dispute —— 查询订单进行中纠纷（前端 UI 用）
  router.get('/api/orders/:id/dispute', async (req, res, params) => {
    const user = await requireUser(req);
    if (!(await isOrderParty(params.id, user.id))) throw err.forbidden('仅当事人可查看纠纷状态');
    const d = await findOpenDispute(params.id);
    ok(res, d ? disputeView(d, {
      myRole: d.initiatorId === user.id ? 'INITIATOR' : 'OPPOSITE',
    }) : null);
  });

  // GET /api/disputes/mine?status=
  router.get('/api/disputes/mine', async (req, res, _p, q_) => {
    const user = await requireUser(req);
    const status = q_.get('status');
    const cond = [];
    const args = [];
    if (status && status.trim()) {
      v.oneOf(String(status).toUpperCase(), '纠纷状态', ['OPEN', 'RESOLVED', 'CANCELLED']);
      cond.push('d.status = ?'); args.push(String(status).toUpperCase());
    }
    const where = cond.length ? `AND ${cond.join(' AND ')}` : '';
    const rows = await query(
      `SELECT d.* FROM disputes d
        JOIN orders o ON o.id = d.orderId
       WHERE (
         o.customerId = ?
         OR d.initiatorId = ?
         OR EXISTS (
           SELECT 1 FROM quotes q
           WHERE q.id = o.selectedQuoteId AND q.engineerId = ?
         )
       ) ${where}
       ORDER BY d.createdAt DESC LIMIT 100`,
      [user.id, user.id, user.id, ...args]
    );
    const result = await Promise.all(rows.map(async (d) => {
      const order = await queryOne(
        `SELECT orderNo, projectName, status FROM orders WHERE id = ?`, [d.orderId]);
      return disputeView(d, {
        order: order || null,
        // 当前用户视角：是自己发起还是对方发起
        myRole: d.initiatorId === user.id ? 'INITIATOR' : 'OPPOSITE',
      });
    }));
    ok(res, result);
  });

  // GET /api/disputes/:id
  router.get('/api/disputes/:id', async (req, res, params) => {
    const user = await requireUser(req);
    const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [params.id]);
    if (!d) throw err.notFound('纠纷不存在');
    if (!(await isOrderParty(d.orderId, user.id))) throw err.forbidden('仅当事人可查看');
    const detail = await disputeDetail(d);
    ok(res, { ...detail, myRole: d.initiatorId === user.id ? 'INITIATOR' : 'OPPOSITE' });
  });

  // POST /api/disputes/:id/evidence { fileIds } —— 48 小时内补充证据。
  router.post('/api/disputes/:id/evidence', async (req, res, params) => {
    const user = await requireUser(req);
    const b = await readJson(req);
    const fileIds = v.arr(b.fileIds, '证据文件', { minLen: 1, maxLen: 5 })
      .map((id) => v.str(id, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('证据文件不能重复');

    const current = await queryOne(`SELECT orderId FROM disputes WHERE id = ?`, [params.id]);
    if (!current) throw err.notFound('纠纷不存在');
    if (!(await isOrderParty(current.orderId, user.id))) throw err.forbidden('仅纠纷当事人可补充证据');

    const result = await tx(async (conn) => {
      const [[d]] = await conn.execute(`SELECT * FROM disputes WHERE id = ? FOR UPDATE`, [params.id]);
      if (!d) throw err.notFound('纠纷不存在');
      if (d.status !== 'OPEN') throw err.conflict('纠纷已结束，不能继续补充证据');
      if (!evidenceWindow(d).evidenceOpen) throw err.conflict('48小时举证期已结束，不能继续上传');

      const [[countRow]] = await conn.execute(
        `SELECT COUNT(*) AS c FROM dispute_evidence WHERE disputeId = ? AND uploaderId = ?`,
        [d.id, user.id]
      );
      if (Number(countRow?.c || 0) + fileIds.length > MAX_EVIDENCE_PER_PARTY) {
        throw err.conflict(`每位当事人最多提交 ${MAX_EVIDENCE_PER_PARTY} 份证据`);
      }
      const [files] = await conn.execute(
        `SELECT id, uploaderId FROM uploaded_files WHERE id IN (${fileIds.map(() => '?').join(',')})`,
        fileIds
      );
      if (files.length !== fileIds.length || files.some((f) => f.uploaderId !== user.id)) {
        throw err.bad('部分文件不存在或不属于你');
      }
      const now = nowIso();
      let added = 0;
      for (const fileId of fileIds) {
        const [inserted] = await conn.execute(
          `INSERT IGNORE INTO dispute_evidence(disputeId, fileId, uploaderId, createdAt)
           VALUES(?, ?, ?, ?)`,
          [d.id, fileId, user.id, now]
        );
        added += Number(inserted.affectedRows || 0);
      }
      if (!added) throw err.conflict('所选文件已经提交过');
      await conn.execute(`UPDATE disputes SET updatedAt = ? WHERE id = ?`, [now, d.id]);
      return { added, evidenceDeadlineAt: evidenceWindow(d).evidenceDeadlineAt };
    });
    ok(res, result);
  });

  // 旧版纠纷对话接口已关闭，避免客户端绕过“仅上传证据”的页面限制。
  router.post('/api/disputes/:id/messages', async (req, res) => {
    await requireUser(req);
    throw err.conflict('纠纷对话已关闭，请在48小时举证期内上传证据文件');
  });

  // POST /api/disputes/:id/cancel —— 发起人取消
  router.post('/api/disputes/:id/cancel', async (req, res, params) => {
    const user = await requireUser(req);
    ok(res, await cancelDispute(user, params.id));
  });

  // ================= 管理员接口 =================

  // POST /api/admin/disputes/:id/messages —— 管理员在纠纷线程发言
  router.post('/api/admin/disputes/:id/messages', async (req, res, params) => {
    await requireAdmin(req, 'DISPUTE_READ');
    throw err.conflict('纠纷沟通功能已关闭，管理员请依据双方提交的证据进行仲裁');
  });

  // GET /api/admin/disputes?status=&limit=&offset=
  router.get('/api/admin/disputes', async (req, res, _p, q_) => {
    await requireAdmin(req, 'DISPUTE_READ');
    const limit = q_.get('limit') ? v.int(q_.get('limit'), 'limit', { min: 1, max: 100 }) : 30;
    const offset = q_.get('offset') ? v.int(q_.get('offset'), 'offset', { min: 0, max: 1000000 }) : 0;
    const status = String(q_.get('status') || '').toUpperCase();
    const cond = [];
    const args = [];
    if (status) { v.oneOf(status, '纠纷状态', ['OPEN', 'RESOLVED', 'CANCELLED']); cond.push('d.status = ?'); args.push(status); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS c FROM disputes d ${where}`, args);
    const rows = await query(
      `SELECT d.*, o.orderNo, o.projectName, o.status AS orderStatus,
              cu.nickname AS customerName, eng.nickname AS engineerName
         FROM disputes d
         JOIN orders o ON o.id = d.orderId
         JOIN users cu ON cu.id = o.customerId
         LEFT JOIN quotes sq ON sq.id = o.selectedQuoteId
         LEFT JOIN users eng ON eng.id = sq.engineerId
       ${where}
       ORDER BY d.createdAt DESC LIMIT ${limit} OFFSET ${offset}`, args
    );
    ok(res, {
      items: rows.map((d) => disputeView(d, {
        order: { id: d.orderId, orderNo: d.orderNo, projectName: d.projectName, status: d.orderStatus },
        customerName: d.customerName,
        engineerName: d.engineerName,
      })),
      total: Number(totalRow?.c || 0), limit, offset,
    });
  });

  // GET /api/admin/disputes/:id
  router.get('/api/admin/disputes/:id', async (req, res, params) => {
    await requireAdmin(req, 'DISPUTE_READ');
    const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [params.id]);
    if (!d) throw err.notFound('纠纷不存在');
    ok(res, await disputeDetail(d));
  });

  // POST /api/admin/disputes/:id/resolve { verdict, orderAction, note?, refundAmountFen? }
  router.post('/api/admin/disputes/:id/resolve', async (req, res, params) => {
    const { admin } = await requireAdmin(req, 'DISPUTE_RESOLVE');
    const b = await readJson(req);
    const verdict = v.oneOf(String(b.verdict || '').toUpperCase(), '仲裁结论', VERDICTS);
    const orderAction = v.oneOf(String(b.orderAction || '').toUpperCase(), '订单处理', ORDER_ACTIONS);
    const note = v.str(b.note, '仲裁说明', { max: 1000, optional: true });
    const refundAmountFen = b.refundAmountFen === undefined || b.refundAmountFen === null || b.refundAmountFen === ''
      ? null
      : v.int(b.refundAmountFen, '退款金额', { min: 0, max: 1000000000 });

    const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [params.id]);
    if (!d) throw err.notFound('纠纷不存在');
    if (evidenceWindow(d).evidenceOpen) throw err.conflict('举证期尚未结束，请在48小时举证期结束后再仲裁');

    const result = await resolveDispute(admin, params.id, { verdict, orderAction, note, refundAmountFen });

    await writeAdminAudit(req, admin, 'DISPUTE_RESOLVE', 'DISPUTE', params.id, {
      orderId: d.orderId,
      verdict, orderAction, refundAmountFen: refundAmountFen ?? null,
      fromStatus: d.status, toStatus: 'RESOLVED',
    });

    ok(res, { ...result, disputeId: params.id, verdict, orderAction, refundAmountFen: refundAmountFen ?? null });
  });

  // POST /api/admin/disputes/:id/refund { refundStatus, refundTransactionId? }
  router.post('/api/admin/disputes/:id/refund', async (req, res, params) => {
    const { admin } = await requireAdmin(req, 'DISPUTE_RESOLVE');
    const b = await readJson(req);
    const refundStatus = v.oneOf(String(b.refundStatus || '').toUpperCase(), '退款状态', ['PENDING', 'PROCESSED', 'FAILED']);
    const refundTransactionId = b.refundTransactionId
      ? v.str(b.refundTransactionId, '退款流水号', { max: 64, optional: true })
      : null;
    const result = await updateRefund(admin, params.id, { refundStatus, refundTransactionId });
    const d = await queryOne(`SELECT orderId, refundAmountFen FROM disputes WHERE id = ?`, [params.id]);
    await writeAdminAudit(req, admin, 'DISPUTE_REFUND_UPDATE', 'DISPUTE', params.id, {
      orderId: d?.orderId, refundStatus, refundAmountFen: d?.refundAmountFen ?? null,
    });
    ok(res, result);
  });
}

module.exports = { register, disputeView, disputeDetail, REASON_TEXT, VERDICT_TEXT, STATUS_TEXT, REFUND_TEXT };
