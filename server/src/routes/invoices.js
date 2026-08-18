'use strict';

// 发票业务流：管理申请、处理状态和自行开票文件；真实开票接口及平台服务费另行接入。
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireUser, requireCustomer, requireEngineer } = require('../lib/auth-mw');
const { requireAdmin } = require('../lib/admin-mw');
const { systemMessageForOrder } = require('../services/chat-svc');

const ALLOWED_INVOICE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'pdf', 'doc', 'docx',
]);

const STATUS_TEXT = Object.freeze({
  REQUESTED: '待工程师处理', SELF_ISSUE: '工程师自行开票中',
  PLATFORM_REQUESTED: '已申请平台开票', ISSUED: '已完成开票', REJECTED: '暂不支持开票',
});

function invoiceFileView(row) {
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

function invoiceView(row, extra = {}) {
  if (!row) return null;
  return {
    ...row,
    platformFeeFen: row.platformFeeFen == null ? null : Number(row.platformFeeFen),
    statusText: STATUS_TEXT[row.status] || row.status,
    ...extra,
  };
}

async function invoiceFilesOf(invoiceRequestId) {
  const rows = await query(
    `SELECT irf.fileId, f.name, f.kind, f.mime, f.sizeBytes, irf.createdAt
       FROM invoice_request_files irf
       JOIN uploaded_files f ON f.id = irf.fileId
      WHERE irf.invoiceRequestId = ?
      ORDER BY irf.createdAt ASC`,
    [invoiceRequestId]
  );
  return rows.map(invoiceFileView);
}

async function invoiceViewsWithFiles(rows) {
  if (!rows.length) return [];
  const files = await query(
    `SELECT irf.invoiceRequestId, irf.fileId, f.name, f.kind, f.mime, f.sizeBytes, irf.createdAt
       FROM invoice_request_files irf
       JOIN uploaded_files f ON f.id = irf.fileId
      WHERE irf.invoiceRequestId IN (${rows.map(() => '?').join(',')})
      ORDER BY irf.createdAt ASC`,
    rows.map((row) => row.id)
  );
  const grouped = new Map();
  for (const file of files) {
    if (!grouped.has(file.invoiceRequestId)) grouped.set(file.invoiceRequestId, []);
    grouped.get(file.invoiceRequestId).push(invoiceFileView(file));
  }
  return rows.map((row) => invoiceView(row, { files: grouped.get(row.id) || [] }));
}

function invoiceFileExtension(name) {
  const match = /\.([^.]+)$/.exec(String(name || '').trim().toLowerCase());
  return match ? match[1] : '';
}

async function getOrderParties(orderId) {
  return queryOne(
    `SELECT o.id, o.orderNo, o.projectName, o.status, o.customerId, q.engineerId
       FROM orders o LEFT JOIN quotes q ON q.id=o.selectedQuoteId
      WHERE o.id=? AND o.deletedAt IS NULL`, [orderId]
  );
}

async function assertParty(orderId, user) {
  const order = await getOrderParties(orderId);
  if (!order) throw err.notFound('订单不存在');
  if (order.customerId !== user.id && order.engineerId !== user.id) throw err.forbidden('仅订单双方可查看发票信息');
  return order;
}

function optionalString(body, key, label, max) {
  const value = body[key];
  if (value == null || value === '') return null;
  return v.str(value, label, { min: 1, max });
}

function register(router) {
  router.get('/api/orders/:id/invoice-request', async (req, res, params) => {
    const user = await requireUser(req);
    await assertParty(params.id, user);
    const row = await queryOne(`SELECT * FROM invoice_requests WHERE orderId=?`, [params.id]);
    const files = row ? await invoiceFilesOf(row.id) : [];
    ok(res, invoiceView(row, { files }));
  });

  router.post('/api/orders/:id/invoice-request', async (req, res, params) => {
    const customer = await requireCustomer(req);
    const body = await readJson(req);
    const invoiceTitle = v.str(body.invoiceTitle, '发票抬头', { min: 2, max: 120 });
    const taxNumber = optionalString(body, 'taxNumber', '纳税人识别号', 50);
    const email = optionalString(body, 'email', '接收邮箱', 120);
    const customerNote = optionalString(body, 'customerNote', '备注', 500);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err.bad('接收邮箱格式不正确');
    const result = await tx(async (conn) => {
      const [[order]] = await conn.execute(
        `SELECT o.id, o.status, o.customerId, q.engineerId
           FROM orders o LEFT JOIN quotes q ON q.id=o.selectedQuoteId
          WHERE o.id=? AND o.deletedAt IS NULL FOR UPDATE`, [params.id]
      );
      if (!order || order.customerId !== customer.id) throw err.notFound('订单不存在');
      if (order.status !== 'COMPLETED' || !order.engineerId) throw err.conflict('仅已完成且已选定工程师的订单可申请发票');
      const [[existing]] = await conn.execute(`SELECT id FROM invoice_requests WHERE orderId=? FOR UPDATE`, [params.id]);
      if (existing) throw err.conflict('该订单已提交发票申请');
      const now = nowIso();
      const id = newId();
      await conn.execute(
        `INSERT INTO invoice_requests(
          id, orderId, customerId, engineerId, invoiceTitle, taxNumber, email, customerNote,
          status, requestedAt, createdAt, updatedAt
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?)`,
        [id, params.id, customer.id, order.engineerId, invoiceTitle, taxNumber, email, customerNote, now, now, now]
      );
      return { id, orderId: params.id, status: 'REQUESTED', invoiceTitle, requestedAt: now };
    });
    systemMessageForOrder(params.id, '客户提交了发票申请，请在“我的 - 发票处理”中选择处理方式。', { senderId: customer.id, actionOrderId: params.id }).catch(() => {});
    ok(res, invoiceView(result, { files: [] }));
  });

  router.get('/api/invoices/mine', async (req, res) => {
    const engineer = await requireEngineer(req);
    const rows = await query(
      `SELECT ir.*, o.orderNo, o.projectName, u.nickname AS customerName
         FROM invoice_requests ir
         JOIN orders o ON o.id=ir.orderId JOIN users u ON u.id=ir.customerId
        WHERE ir.engineerId=? ORDER BY FIELD(ir.status,'REQUESTED','SELF_ISSUE','PLATFORM_REQUESTED','ISSUED','REJECTED'), ir.updatedAt DESC
        LIMIT 100`, [engineer.id]
    );
    ok(res, { items: await invoiceViewsWithFiles(rows) });
  });

  router.post('/api/invoices/:id/process', async (req, res, params) => {
    const engineer = await requireEngineer(req);
    const body = await readJson(req);
    const action = v.oneOf(String(body.action || '').toUpperCase(), '发票处理方式', ['SELF_ISSUE', 'PLATFORM_REQUESTED', 'ISSUED', 'REJECTED']);
    const engineerNote = optionalString(body, 'engineerNote', '处理说明', 500);
    const result = await tx(async (conn) => {
      const [[record]] = await conn.execute(`SELECT * FROM invoice_requests WHERE id=? AND engineerId=? FOR UPDATE`, [params.id, engineer.id]);
      if (!record) throw err.notFound('发票申请不存在');
      const isRequested = record.status === 'REQUESTED';
      if ((action === 'SELF_ISSUE' || action === 'PLATFORM_REQUESTED' || action === 'REJECTED') && !isRequested) {
        throw err.conflict('该申请已处理，请勿重复选择处理方式');
      }
      if (action === 'ISSUED' && !['SELF_ISSUE', 'PLATFORM_REQUESTED'].includes(record.status)) {
        throw err.conflict('请先选择开票处理方式');
      }
      if (action === 'ISSUED' && record.status === 'SELF_ISSUE') {
        throw err.conflict('自行开票请先上传发票文件，上传成功后将自动完成');
      }
      const now = nowIso();
      const handlingMode = action === 'SELF_ISSUE' ? 'SELF_ISSUE'
        : action === 'PLATFORM_REQUESTED' ? 'PLATFORM' : record.handlingMode;
      await conn.execute(
        `UPDATE invoice_requests SET status=?, handlingMode=?, engineerNote=COALESCE(?, engineerNote),
          handledAt=COALESCE(handledAt, ?), updatedAt=? WHERE id=?`,
        [action, handlingMode, engineerNote, now, now, record.id]
      );
      return { ...record, status: action, handlingMode, engineerNote: engineerNote || record.engineerNote, updatedAt: now };
    });
    const message = {
      SELF_ISSUE: '工程师将自行开具发票，请留意后续交付。',
      PLATFORM_REQUESTED: '工程师已申请平台协助开票。平台开票可能收取服务费，具体费用将由平台后续确认。',
      ISSUED: '工程师已标记发票处理完成，请留意接收邮箱或与工程师沟通。',
      REJECTED: '工程师暂不支持该订单的发票申请，请与工程师沟通。',
    }[action];
    systemMessageForOrder(result.orderId, message, { senderId: engineer.id, actionOrderId: result.orderId }).catch(() => {});
    ok(res, invoiceView(result, { files: await invoiceFilesOf(result.id) }));
  });

  // 工程师自行开票：上传电子发票文件后自动标记为已完成开票。
  router.post('/api/invoices/:id/files', async (req, res, params) => {
    const engineer = await requireEngineer(req);
    const body = await readJson(req);
    const rawFileIds = v.arr(body.fileIds, '发票文件', { minLen: 1, maxLen: 5 });
    const fileIds = rawFileIds.map((fileId) => v.str(fileId, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('发票文件包含重复项');

    const result = await tx(async (conn) => {
      const [[record]] = await conn.execute(
        `SELECT * FROM invoice_requests WHERE id=? AND engineerId=? FOR UPDATE`,
        [params.id, engineer.id]
      );
      if (!record) throw err.notFound('发票申请不存在');
      if (record.status !== 'SELF_ISSUE' || record.handlingMode !== 'SELF_ISSUE') {
        throw err.conflict('仅选择“自行开票”后可以上传发票文件');
      }

      const [files] = await conn.execute(
        `SELECT f.id AS fileId, f.uploaderId, f.orderId, f.name, f.kind, f.mime, f.sizeBytes,
                EXISTS(SELECT 1 FROM identity_verification_files ivf WHERE ivf.fileId=f.id) AS usedForIdentity,
                EXISTS(SELECT 1 FROM engineer_verification_files evf WHERE evf.fileId=f.id) AS usedForVerification,
                EXISTS(SELECT 1 FROM dispute_evidence de WHERE de.fileId=f.id) AS usedForDispute,
                EXISTS(SELECT 1 FROM refund_request_files rf WHERE rf.fileId=f.id) AS usedForRefund,
                EXISTS(SELECT 1 FROM invoice_request_files irf WHERE irf.fileId=f.id) AS usedForInvoice
           FROM uploaded_files f
          WHERE f.id IN (${fileIds.map(() => '?').join(',')})
          FOR UPDATE`,
        fileIds
      );
      if (files.length !== fileIds.length) throw err.bad('部分发票文件不存在，请删除后重新上传');
      for (const file of files) {
        if (file.uploaderId !== engineer.id) throw err.forbidden('不能使用其他用户上传的文件');
        if (file.orderId || file.usedForIdentity || file.usedForVerification
          || file.usedForDispute || file.usedForRefund || file.usedForInvoice) {
          throw err.conflict('文件已用于其他业务，请重新上传');
        }
        if (!['IMAGE', 'DOC'].includes(file.kind)
          || !ALLOWED_INVOICE_EXTENSIONS.has(invoiceFileExtension(file.name))) {
          throw err.bad('发票文件仅支持图片、PDF、Word 格式');
        }
      }

      const now = nowIso();
      for (const file of files) {
        await conn.execute(
          `INSERT INTO invoice_request_files(invoiceRequestId, fileId, uploaderId, createdAt)
           VALUES(?, ?, ?, ?)`,
          [record.id, file.fileId, engineer.id, now]
        );
      }
      await conn.execute(
        `UPDATE invoice_requests
            SET status='ISSUED', handledAt=COALESCE(handledAt, ?), updatedAt=?
          WHERE id=? AND status='SELF_ISSUE'`,
        [now, now, record.id]
      );
      return { ...record, status: 'ISSUED', updatedAt: now };
    });

    const files = await invoiceFilesOf(result.id);
    systemMessageForOrder(
      result.orderId,
      '工程师已上传电子发票，你可以在订单的发票详情中查看和下载。',
      { senderId: engineer.id, actionOrderId: result.orderId }
    ).catch(() => {});
    ok(res, invoiceView(result, { files }));
  });

  // 管理员先提供只读预览；平台开票的收费、审核与实际开具将独立接入。
  router.get('/api/admin/invoices', async (req, res, _params, q) => {
    await requireAdmin(req, 'INVOICE_READ');
    const status = String(q.get('status') || '').toUpperCase();
    if (status) v.oneOf(status, '发票状态', Object.keys(STATUS_TEXT));
    const rows = await query(
      `SELECT ir.*, o.orderNo, o.projectName, c.nickname AS customerName, e.nickname AS engineerName
         FROM invoice_requests ir JOIN orders o ON o.id=ir.orderId
         JOIN users c ON c.id=ir.customerId JOIN users e ON e.id=ir.engineerId
        ${status ? 'WHERE ir.status=?' : ''}
        ORDER BY ir.updatedAt DESC LIMIT 200`, status ? [status] : []
    );
    ok(res, { items: await invoiceViewsWithFiles(rows) });
  });
}

module.exports = { register, STATUS_TEXT };
