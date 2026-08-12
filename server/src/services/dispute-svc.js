'use strict';
/**
 * 纠纷服务（云开发版）。
 *
 * 职责：
 *   - 开单校验：订单阶段、当事人身份、同一订单唯一 OPEN 纠纷
 *   - 冻结 / 恢复订单状态（DISPUTING <-> orderStatusAtOpen）
 *   - 纠纷线程消息、证据关联
 *   - 管理员仲裁：改订单状态 + 登记退款诉求
 *
 * 冻结语义：发起纠纷时订单置为 DISPUTING，双方不能交付/验收/关闭；
 * 结案（orderAction=KEEP）或取消时恢复为发起时快照 orderStatusAtOpen。
 */
const { err } = require('../lib/http');
const { newId, nowIso } = require('../lib/util');
const { query, queryOne, tx } = require('../db');

// 允许发起纠纷的订单阶段（含待支付——按产品要求"任意已支付阶段"）
const DISPUTABLE_ORDER_STATUS = ['AWAITING_PAYMENT', 'IN_PROGRESS', 'DELIVERED', 'COMPLETED'];

const REASON_TYPES = ['QUALITY', 'DELAY', 'MISSING', 'PAYMENT', 'COMMUNICATION', 'OTHER'];
const VERDICTS = ['NONE', 'CUSTOMER_FAVOR', 'ENGINEER_FAVOR', 'PARTIAL'];
const ORDER_ACTIONS = ['KEEP', 'FORCE_COMPLETE', 'REOPEN', 'CLOSE'];
const EVIDENCE_WINDOW_HOURS = 48;

function evidenceDeadlineIso(baseMs = Date.now()) {
  return new Date(baseMs + EVIDENCE_WINDOW_HOURS * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
}

/** 解析行内返回的 message 类型字段，兼容 mysql2 返回的 [rows, fields] 或直接的行数组 */
function asRow(result) {
  if (!result) return null;
  // mysql2 conn.execute 返回 [rows, fields]；query 直接返回行数组
  const rows = Array.isArray(result[0]) ? result[0] : result;
  return (rows && rows.length) ? rows[0] : null;
}

/**
 * 获取订单的"当前当事人"：客户 + 选中工程师。
 * 返回 { customerId, engineerId }。若无选中工程师返回 engineerId=null。
 */
async function getOrderParties(orderId) {
  const o = await queryOne(`SELECT customerId, selectedQuoteId FROM orders WHERE id = ?`, [orderId]);
  if (!o) return null;
  let engineerId = null;
  if (o.selectedQuoteId) {
    const q = await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [o.selectedQuoteId]);
    if (q) engineerId = q.engineerId;
  }
  return { customerId: o.customerId, engineerId };
}

/**
 * 判断用户是否为订单当事人（客户或选中工程师）。
 */
async function isOrderParty(orderId, userId) {
  const p = await getOrderParties(orderId);
  if (!p) return false;
  return p.customerId === userId || (!!p.engineerId && p.engineerId === userId);
}

/** 查询订单上未关闭的纠纷（OPEN），无则返回 null */
async function findOpenDispute(orderId) {
  return queryOne(
    `SELECT * FROM disputes WHERE orderId = ? AND status = 'OPEN' ORDER BY createdAt DESC LIMIT 1`,
    [orderId]
  );
}

/** 查询某纠纷的当事人（用于消息/证据权限） */
async function getDisputeParties(disputeId) {
  const d = await queryOne(`SELECT orderId, initiatorId FROM disputes WHERE id = ?`, [disputeId]);
  if (!d) return null;
  const parties = await getOrderParties(d.orderId);
  if (!parties) return null;
  return { ...parties, initiatorId: d.initiatorId };
}

/**
 * 冻结订单：把订单状态置为 DISPUTING。
 * 仅在当前状态属于可冻结范围时生效（AWAITING_PAYMENT / IN_PROGRESS / DELIVERED / COMPLETED）。
 */
async function freezeOrder(conn, orderId, statusAtOpen) {
  const [r] = await conn.execute(
    `UPDATE orders SET status = 'DISPUTING', updatedAt = ?
     WHERE id = ? AND status = ?`,
    [nowIso(), orderId, statusAtOpen]
  );
  return r.affectedRows === 1;
}

/**
 * 恢复订单状态（结案 KEEP / 取消时）。
 * 仅当订单当前处于 DISPUTING 时恢复，防止覆盖其他状态流转。
 */
async function restoreOrder(conn, orderId, targetStatus) {
  const [r] = await conn.execute(
    `UPDATE orders SET status = ?, updatedAt = ?
     WHERE id = ? AND status = 'DISPUTING'`,
    [targetStatus, nowIso(), orderId]
  );
  return r.affectedRows === 1;
}

/**
 * 创建纠纷：校验 → 冻结订单 → 写 disputes → 关联证据。
 * @param {object} user 当前用户（当事人）
 * @param {object} payload { orderId, reasonType, description, fileIds }
 */
async function createDispute(user, { orderId, reasonType, description, fileIds }) {
  const o = await queryOne(
    `SELECT id, status, customerId, selectedQuoteId FROM orders WHERE id = ? AND deletedAt IS NULL`,
    [orderId]
  );
  if (!o) throw err.notFound('订单不存在');
  if (!DISPUTABLE_ORDER_STATUS.includes(o.status)) {
    throw err.conflict('当前订单状态不可发起纠纷');
  }
  if (o.customerId !== user.id) {
    // 仅客户或选中工程师可发起
    const q = o.selectedQuoteId
      ? await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [o.selectedQuoteId])
      : null;
    if (!q || q.engineerId !== user.id) throw err.forbidden('仅订单客户或选中工程师可发起纠纷');
  }
  const open = await findOpenDispute(orderId);
  if (open) throw err.conflict('该订单已存在进行中的纠纷');

  // 校验证据文件归属（可选）
  const ids = Array.isArray(fileIds) ? fileIds.slice(0, 20) : [];
  let evidenceFiles = [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const files = await query(
      `SELECT id, uploaderId, orderId FROM uploaded_files WHERE id IN (${marks})`, ids
    );
    if (files.length !== ids.length) throw err.bad('部分证据文件不存在');
    for (const f of files) {
      if (f.uploaderId !== user.id) throw err.forbidden('只能使用本人上传的证据文件');
    }
    evidenceFiles = files;
  }

  const id = newId();
  const now = nowIso();
  const evidenceDeadlineAt = evidenceDeadlineIso();
  const result = await tx(async (conn) => {
    const frozen = await freezeOrder(conn, orderId, o.status);
    if (!frozen) throw err.conflict('订单状态已变化，请刷新后重试');
    await conn.execute(
      `INSERT INTO disputes
         (id, orderId, initiatorId, reasonType, description, status,
          orderStatusAtOpen, evidenceDeadlineAt, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      [id, orderId, user.id, reasonType, description, o.status, evidenceDeadlineAt, now, now]
    );
    for (const f of evidenceFiles) {
      await conn.execute(
        `INSERT INTO dispute_evidence(disputeId, fileId, uploaderId, createdAt)
         VALUES(?, ?, ?, ?)`,
        [id, f.id, user.id, now]
      );
    }
    const rows = await conn.execute(`SELECT * FROM disputes WHERE id = ?`, [id]);
    return asRow(rows);
  });

  // 事务提交后给订单会话发系统消息（fire-and-forget）
  const { systemMessageForOrder } = require('./chat-svc');
  systemMessageForOrder(orderId, '买家发起了纠纷，订单已暂停处理。请双方在48小时内上传证据，举证结束后由平台仲裁。')
    .catch(() => {});
  return result;
}

/** 取消纠纷（仅 OPEN、发起人本人），订单恢复冻结前状态 */
async function cancelDispute(user, disputeId) {
  const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [disputeId]);
  if (!d) throw err.notFound('纠纷不存在');
  if (d.status !== 'OPEN') throw err.conflict('纠纷已结案或已取消');
  if (d.initiatorId !== user.id) throw err.forbidden('仅发起人可取消纠纷');
  await tx(async (conn) => {
    const restored = await restoreOrder(conn, d.orderId, d.orderStatusAtOpen);
    if (!restored) throw err.conflict('订单状态已变化，请刷新后重试');
    await conn.execute(
      `UPDATE disputes SET status = 'CANCELLED', updatedAt = ? WHERE id = ?`,
      [nowIso(), disputeId]
    );
  });
  const { systemMessageForOrder } = require('./chat-svc');
  systemMessageForOrder(d.orderId, '纠纷已由发起人取消，订单恢复处理。').catch(() => {});
  return { cancelled: true };
}

/** 发送纠纷线程消息（当事人或管理员） */
async function sendDisputeMessage(senderLabel, disputeId, { type, content, fileId }) {
  const d = await queryOne(`SELECT id, status FROM disputes WHERE id = ?`, [disputeId]);
  if (!d) throw err.notFound('纠纷不存在');
  if (d.status !== 'OPEN') throw err.conflict('纠纷已结束，无法继续发言');
  const now = nowIso();
  const result = await tx(async (conn) => {
    const [r] = await conn.execute(
      `INSERT INTO dispute_messages(disputeId, senderId, type, content, fileId, createdAt)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [disputeId, senderLabel, type, content, fileId, now]
    );
    await conn.execute(`UPDATE disputes SET updatedAt = ? WHERE id = ?`, [now, disputeId]);
    return { msgId: Number(r.insertId), createdAt: now };
  });
  return result;
}

/**
 * 管理员仲裁结案。
 * @param {object} admin 管理员记录（含 id）
 * @param {string} disputeId
 * @param {object} payload { verdict, orderAction, note?, refundAmountFen? }
 */
async function resolveDispute(admin, disputeId, { verdict, orderAction, note, refundAmountFen }) {
  const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [disputeId]);
  if (!d) throw err.notFound('纠纷不存在');
  if (d.status !== 'OPEN') throw err.conflict('该纠纷已处理');

  const targetStatus =
    orderAction === 'FORCE_COMPLETE' ? 'COMPLETED' :
    orderAction === 'REOPEN' ? 'IN_PROGRESS' :
    orderAction === 'CLOSE' ? 'CLOSED' : d.orderStatusAtOpen;

  const now = nowIso();
  await tx(async (conn) => {
    // 只有处于 DISPUTING 的订单才需要恢复/变更；KEEP 走恢复快照。
    if (orderAction !== 'KEEP') {
      const [r] = await conn.execute(
        `UPDATE orders SET status = ?, updatedAt = ? WHERE id = ? AND status = 'DISPUTING'`,
        [targetStatus, now, d.orderId]
      );
      if (r.affectedRows !== 1) throw err.conflict('订单状态已变化，无法按此仲裁方案处理');
    } else {
      const restored = await restoreOrder(conn, d.orderId, targetStatus);
      if (!restored) throw err.conflict('订单状态已变化，无法恢复');
    }

    await conn.execute(
      `UPDATE disputes
         SET status = 'RESOLVED', verdict = ?, orderAction = ?, resolutionNote = ?,
             refundAmountFen = ?, refundStatus = ?, resolvedBy = ?, resolvedAt = ?, updatedAt = ?
       WHERE id = ?`,
      [
        verdict, orderAction, note || null,
        refundAmountFen ?? null,
        refundAmountFen ? 'PENDING' : 'NONE',
        admin.id, now, now, disputeId
      ]
    );
  });

  const { systemMessageForOrder } = require('./chat-svc');
  const actionText = {
    FORCE_COMPLETE: '订单已强制完成',
    REOPEN: '订单已重新开启执行',
    CLOSE: '订单已关闭',
    KEEP: '订单已恢复原状态',
  }[orderAction] || '订单已恢复原状态';
  systemMessageForOrder(d.orderId, `平台已完成纠纷仲裁（${actionText}）。${note ? '说明：' + note : ''}`)
    .catch(() => {});
  return { resolved: true, orderStatus: targetStatus };
}

/** 更新退款登记状态（PENDING -> PROCESSED / FAILED，预留真实退款接入点） */
async function updateRefund(admin, disputeId, { refundStatus, refundTransactionId }) {
  const d = await queryOne(`SELECT * FROM disputes WHERE id = ?`, [disputeId]);
  if (!d) throw err.notFound('纠纷不存在');
  if (d.status !== 'RESOLVED') throw err.conflict('仅已结案纠纷可登记退款');
  await query(
    `UPDATE disputes SET refundStatus = ?, refundTransactionId = COALESCE(?, refundTransactionId), updatedAt = ?
     WHERE id = ?`,
    [refundStatus, refundTransactionId || null, nowIso(), disputeId]
  );
  return { updated: true, refundStatus };
}

module.exports = {
  DISPUTABLE_ORDER_STATUS,
  REASON_TYPES,
  VERDICTS,
  ORDER_ACTIONS,
  EVIDENCE_WINDOW_HOURS,
  evidenceDeadlineIso,
  getOrderParties,
  isOrderParty,
  findOpenDispute,
  getDisputeParties,
  createDispute,
  cancelDispute,
  sendDisputeMessage,
  resolveDispute,
  updateRefund,
};
