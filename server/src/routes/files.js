'use strict';
/**
 * 文件模块（云开发版：云存储 fileID 体系）。
 *
 * 上传：由小程序端直接调用 wx.cloud.uploadFile 上传到云存储，返回 fileID。
 *       上传完成后前端调用 POST /api/files/commit 把 fileID 记录到 MySQL。
 *
 * 下载：GET /api/files/:id/url 完成权限校验并返回 fileID，
 *       小程序端通过 wx.cloud.downloadFile 直接下载。
 *
 * 权限：上传者本人 / 订单客户 / 报价期已认证工程师 / 被选中工程师。
 */
const { readJson, readBody, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { getStorage } = require('../tcb');
const { config } = require('../config');
const { getBoundary, parseMultipart } = require('../lib/multipart');
const path = require('node:path');

const KINDS = ['MODEL', 'DOC', 'IMAGE', 'RESULT'];
const MAX_UPLOAD_BYTES = config.uploadMaxBytes;
const MAX_ENGINEER_VERIFICATION_FILES = 10;

function assertCloudFileId(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) {
    throw err.bad('fileID 格式不合法，请使用云存储上传');
  }
  const authority = fileID.slice('cloud://'.length).split('/')[0];
  const fileEnv = authority.split('.')[0];
  if (config.cloudbaseEnv && fileEnv !== config.cloudbaseEnv) {
    throw err.bad('fileID 不属于当前云开发环境');
  }
}

async function assertOrderUploadAccess(user, orderId) {
  if (!orderId) return;
  const order = await queryOne(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [orderId]);
  if (!order) throw err.notFound('订单不存在');
  const selected = order.selectedQuoteId
    ? await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [order.selectedQuoteId])
    : null;
  if (order.customerId !== user.id && (!selected || selected.engineerId !== user.id)) {
    throw err.forbidden('无权向该订单上传文件');
  }
}

async function saveFileRecord(user, { fileID, name, kind, orderId, sizeBytes, mime }) {
  assertCloudFileId(fileID);
  // 文件已经由当前小程序通过 wx.cloud.uploadFile 直传成功。这里只验证
  // CloudBase 环境和业务权限，避免云托管后端访问内部凭据服务而长时间阻塞。
  await assertOrderUploadAccess(user, orderId);
  const id = newId();
  const createdAt = nowIso();
  await tx(async (conn) => {
    await conn.execute(
      `INSERT INTO uploaded_files(id, orderId, uploaderId, kind, name, fileID, sizeBytes, mime, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, orderId || null, user.id, kind, name, fileID, sizeBytes || 0, mime || null, createdAt]
    );
    if (orderId) {
      await conn.execute(
        `INSERT INTO order_attachments(orderId, fileId, uploaderId, purpose, createdAt)
         VALUES(?, ?, ?, ?, ?)`,
        [orderId, id, user.id, kind === 'RESULT' ? 'RESULT' : 'REQUIREMENT', createdAt]
      );
    }
  });
  return { id, fileID, fileId: id, name, kind, mime: mime || '', sizeBytes: sizeBytes || 0 };
}

async function orderFileAccess(user, order) {
  if (!user || !order) return null;
  if (order.customerId === user.id) return 'ALL';
  if (user.role !== 'ENGINEER') return null;
  const profile = await queryOne(
    `SELECT verifyStatus FROM identity_verifications WHERE userId = ?`, [user.id]);
  if (!profile || profile.verifyStatus !== 'APPROVED') return null;
  if (order.status === 'QUOTING') return 'REQUIREMENT';
  const selected = order.selectedQuoteId
    ? await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [order.selectedQuoteId])
    : null;
  return selected && selected.engineerId === user.id ? 'ALL' : null;
}

async function canReadFile(user, file) {
  if (!user) return false;
  if (file.uploaderId === user.id) return true;

  // 无订单关联的文件：先判断是否为纠纷证据（仅当事人/管理员可读），
  // 避免通用 IMAGE 规则把纠纷证据泄漏给所有登录用户。
  if (!file.orderId) {
    if (await canReadDisputeEvidence(user, file)) return true;
    const refundAccess = await refundRequestFileAccess(user, file);
    if (refundAccess !== null) return refundAccess;
    const invoiceAccess = await invoiceRequestFileAccess(user, file);
    if (invoiceAccess !== null) return invoiceAccess;
    // 头像等公开 IMAGE 所有登录用户均可读
    if (file.kind === 'IMAGE') return true;
    return false;
  }
  const order = await queryOne(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [file.orderId]);
  if (!order) return false;
  // 报价沟通可能发生在选标之前。聊天附件只对实际会话双方开放，不能按订单
  // 维度放给所有参与报价的工程师，也不能仅限制为最终被选中的工程师。
  if (file.purpose === 'CHAT') {
    const chat = await queryOne(
      `SELECT c.customerId, c.engineerId
         FROM messages m JOIN conversations c ON c.id = m.convId
        WHERE m.fileId = ? ORDER BY m.id DESC LIMIT 1`,
      [file.id]
    );
    return !!chat && (chat.customerId === user.id || chat.engineerId === user.id);
  }
  const access = await orderFileAccess(user, order);
  if (!access) return false;
  return access === 'ALL' || (file.purpose || (file.kind === 'RESULT' ? 'RESULT' : 'REQUIREMENT')) === 'REQUIREMENT';
}

/** 纠纷证据读取权限：当事人（客户/选中工程师）或管理员 */
async function canReadDisputeEvidence(user, file) {
  const row = await queryOne(
    `SELECT d.id, d.orderId, o.customerId, o.selectedQuoteId
       FROM dispute_evidence ev
       JOIN disputes d ON d.id = ev.disputeId
       JOIN orders o ON o.id = d.orderId
      WHERE ev.fileId = ?
      ORDER BY ev.createdAt DESC LIMIT 1`,
    [file.id]
  );
  if (!row) return false;
  if (row.customerId === user.id) return true;
  if (row.selectedQuoteId) {
    const q = await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [row.selectedQuoteId]);
    if (q && q.engineerId === user.id) return true;
  }
  // 管理员
  const admin = await queryOne(
    `SELECT id FROM admin_accounts WHERE userId = ? AND status = 'ACTIVE'`,
    [user.id]
  );
  return !!admin;
}

/** 退款申请附件读取权限：订单客户、选中工程师或管理员 */
async function refundRequestFileAccess(user, file) {
  const row = await queryOne(
    `SELECT o.customerId, q.engineerId
       FROM refund_request_files rf
       JOIN refund_requests rr ON rr.id = rf.refundRequestId
       JOIN orders o ON o.id = rr.orderId
       LEFT JOIN quotes q ON q.id = o.selectedQuoteId
      WHERE rf.fileId = ?
      ORDER BY rf.createdAt DESC LIMIT 1`,
    [file.id]
  );
  if (!row) return null;
  if (row.customerId === user.id || row.engineerId === user.id) return true;
  const admin = await queryOne(
    `SELECT id FROM admin_accounts WHERE userId = ? AND status = 'ACTIVE'`,
    [user.id]
  );
  return !!admin;
}

/** 发票文件读取权限：发票申请对应的客户、工程师或管理员 */
async function invoiceRequestFileAccess(user, file) {
  const row = await queryOne(
    `SELECT ir.customerId, ir.engineerId
       FROM invoice_request_files irf
       JOIN invoice_requests ir ON ir.id = irf.invoiceRequestId
      WHERE irf.fileId = ?
      ORDER BY irf.createdAt DESC LIMIT 1`,
    [file.id]
  );
  if (!row) return null;
  if (row.customerId === user.id || row.engineerId === user.id) return true;
  const admin = await queryOne(
    `SELECT id FROM admin_accounts WHERE userId = ? AND status = 'ACTIVE'`,
    [user.id]
  );
  return !!admin;
}

async function requireEngineerIdentity(req) {
  const user = await requireUser(req);
  if (user.role !== 'ENGINEER') throw err.forbidden('仅工程师可管理身份认证材料');
  return user;
}

function register(router) {
  // Local wx.uploadFile fallback. CloudBase deployments normally use
  // wx.cloud.uploadFile followed by /commit, but local mode also needs a real
  // endpoint instead of a 404.
  router.post('/api/files/upload', async (req, res) => {
    const user = await requireUser(req);
    const boundary = getBoundary(req.headers['content-type'] || '');
    if (!boundary) throw err.bad('上传请求缺少 multipart boundary');
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const parsed = parseMultipart(body, boundary);
    const file = parsed.files[0];
    if (!file || !file.data || !file.data.length) throw err.bad('未找到上传文件');
    const kind = KINDS.includes(parsed.fields.kind) ? parsed.fields.kind : 'DOC';
    const orderId = parsed.fields.orderId || null;
    const name = path.basename(parsed.fields.filename || file.filename || 'upload.bin').slice(0, 256);
    const cloudPath = `uploads/${user.id}/${Date.now()}_${newId().slice(1, 9)}_${name}`;
    let uploaded;
    try {
      uploaded = await getStorage().uploadFile({ cloudPath, fileContent: file.data });
      ok(res, await saveFileRecord(user, {
        fileID: uploaded.fileID, name, kind, orderId,
        sizeBytes: file.data.length, mime: file.contentType || '',
      }));
    } catch (e) {
      if (uploaded && uploaded.fileID) {
        try { await getStorage().deleteFile({ fileList: [uploaded.fileID] }); } catch (_) {}
      }
      throw e;
    }
  });

  /**
   * POST /api/files/commit { fileID, name, kind?, orderId?, sizeBytes? }
   * 前端 wx.cloud.uploadFile 成功后调此接口把 fileID 落库，返回 { id, fileID, name, kind }
   */
  router.post('/api/files/commit', async (req, res) => {
    const user = await requireUser(req);
    const b = await readJson(req);
    const fileID = v.str(b.fileID, 'fileID', { min: 10, max: 512 });
    const name = v.str(b.name, '文件名', { min: 1, max: 256 });
    const kind = KINDS.includes(b.kind) ? b.kind : 'DOC';
    const orderId = b.orderId ? v.str(b.orderId, 'orderId', { max: 32, optional: true }) : null;
    const mime = v.str(b.mime, 'MIME类型', { max: 128, optional: true }) || '';
    const sizeBytes = b.sizeBytes ? Number(b.sizeBytes) : 0;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw err.bad(`单个文件不能超过 ${config.uploadMaxMb}MB`);
    }

    ok(res, await saveFileRecord(user, { fileID, name, kind, orderId, sizeBytes, mime }));
  });

  // 身份认证材料：文件先按普通无订单附件提交，再通过关系表关联到工程师。
  // 这样既能复用云存储上传流程，也不会让资格文件落入订单附件权限范围。
  router.get('/api/engineer/verification-files', async (req, res) => {
    const user = await requireEngineerIdentity(req);
    const rows = await query(
      `SELECT f.id, f.fileID, f.name, f.kind, f.mime, f.sizeBytes, evf.createdAt
       FROM engineer_verification_files evf
       JOIN uploaded_files f ON f.id = evf.fileId
       WHERE evf.engineerId = ? ORDER BY evf.createdAt DESC`, [user.id]
    );
    ok(res, rows.map((file) => ({ ...file, fileId: file.id, sizeBytes: Number(file.sizeBytes || 0) })));
  });

  router.post('/api/engineer/verification-files', async (req, res) => {
    const user = await requireEngineerIdentity(req);
    const body = await readJson(req);
    const fileIds = v.arr(body.fileIds, '身份认证材料', { minLen: 1, maxLen: MAX_ENGINEER_VERIFICATION_FILES })
      .map((id) => v.str(id, '文件ID', { min: 1, max: 32 }));
    if (new Set(fileIds).size !== fileIds.length) throw err.bad('身份认证材料不能重复');
    const existingCount = await queryOne(
      `SELECT COUNT(*) AS count FROM engineer_verification_files WHERE engineerId = ?`, [user.id]
    );
    if (Number(existingCount.count || 0) + fileIds.length > MAX_ENGINEER_VERIFICATION_FILES) {
      throw err.bad(`身份认证材料最多上传 ${MAX_ENGINEER_VERIFICATION_FILES} 个文件`);
    }
    const marks = fileIds.map(() => '?').join(',');
    const files = await query(
      `SELECT id, orderId, uploaderId FROM uploaded_files WHERE id IN (${marks})`, fileIds
    );
    if (files.length !== fileIds.length || files.some((file) => file.uploaderId !== user.id || file.orderId)) {
      throw err.forbidden('只能提交本人上传的非订单文件');
    }
    const now = nowIso();
    await tx(async (conn) => {
      for (const fileId of fileIds) {
        await conn.execute(
          `INSERT INTO engineer_verification_files(engineerId, fileId, createdAt) VALUES(?, ?, ?)`,
          [user.id, fileId, now]
        );
        await conn.execute(
          `INSERT IGNORE INTO identity_verification_files(userId, fileId, purpose, createdAt)
           VALUES(?, ?, 'SUPPORTING', ?)`, [user.id, fileId, now]
        );
      }
      // 上传或补充资料意味着需要重新复核；演示自核验开关不改变资料的归属与访问控制。
      await conn.execute(
        `UPDATE engineer_profiles
         SET verifyStatus = 'PENDING', reviewReason = NULL, reviewedAt = NULL, reviewedBy = NULL
         WHERE userId = ?`, [user.id]
      );
      await conn.execute(
        `UPDATE identity_verifications
            SET verifyStatus='PENDING', reviewReason=NULL, reviewedAt=NULL, reviewedBy=NULL, updatedAt=?
          WHERE userId=?`, [now, user.id]
      );
    });
    ok(res, { attached: fileIds.length, maxFiles: MAX_ENGINEER_VERIFICATION_FILES, verifyStatus: 'PENDING' });
  });

  router.del('/api/engineer/verification-files/:id', async (req, res, params) => {
    const user = await requireEngineerIdentity(req);
    const file = await queryOne(
      `SELECT f.id, f.fileID, f.uploaderId
       FROM engineer_verification_files evf
       JOIN uploaded_files f ON f.id = evf.fileId
       WHERE evf.engineerId = ? AND evf.fileId = ?`, [user.id, params.id]
    );
    if (!file) throw err.notFound('身份认证材料不存在');
    if (file.uploaderId !== user.id) throw err.forbidden('无权删除该身份认证材料');
    await tx(async (conn) => {
      await conn.execute(`DELETE FROM engineer_verification_files WHERE engineerId = ? AND fileId = ?`, [user.id, file.id]);
      await conn.execute(`DELETE FROM identity_verification_files WHERE userId = ? AND fileId = ?`, [user.id, file.id]);
      await conn.execute(`DELETE FROM uploaded_files WHERE id = ? AND uploaderId = ?`, [file.id, user.id]);
      await conn.execute(
        `UPDATE engineer_profiles
         SET verifyStatus = 'PENDING', reviewReason = NULL, reviewedAt = NULL, reviewedBy = NULL
         WHERE userId = ?`, [user.id]
      );
      await conn.execute(
        `UPDATE identity_verifications
            SET verifyStatus='PENDING', reviewReason=NULL, reviewedAt=NULL, reviewedBy=NULL, updatedAt=?
          WHERE userId=?`, [nowIso(), user.id]
      );
    });
    ok(res, { deleted: true, fileID: file.fileID, verifyStatus: 'PENDING' });
  });

  /**
   * GET /api/files/:id/url
   * 权限通过后返回云存储 fileID，供小程序端直接下载/预览。
   */
  router.get('/api/files/:id/url', async (req, res, params) => {
    const user = await requireUser(req);
    const file = await queryOne(
      `SELECT f.*, oa.purpose
         FROM uploaded_files f
         LEFT JOIN order_attachments oa ON oa.fileId = f.id
        WHERE f.id = ?`,
      [params.id]
    );
    if (!file) throw err.notFound('文件不存在');
    if (!(await canReadFile(user, file))) throw err.forbidden('无权下载该文件');

    ok(res, {
      fileID: file.fileID,
      name: file.name,
      mime: file.mime || '',
      sizeBytes: Number(file.sizeBytes),
    });
  });

  /**
   * GET /api/orders/:id/files
   * 订单文件列表（按可读权限过滤）
   */
  router.get('/api/orders/:id/files', async (req, res, params) => {
    const user = await requireUser(req);
    const order = await queryOne(
      `SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [params.id]);
    if (!order) throw err.notFound('订单不存在');
    const access = await orderFileAccess(user, order);
    if (!access) throw err.forbidden('无权查看该订单文件');
    const purposeFilter = access === 'REQUIREMENT' ? ` AND oa.purpose = 'REQUIREMENT'` : '';
    const rows = await query(
      `SELECT f.*, oa.purpose
         FROM order_attachments oa
         JOIN uploaded_files f ON f.id = oa.fileId
        WHERE oa.orderId = ?
          AND oa.purpose IN ('REQUIREMENT', 'RESULT')${purposeFilter}
        ORDER BY oa.createdAt`,
      [params.id]
    );
    ok(res, rows.map((f) => ({
      id: f.id,
      fileID: f.fileID,
      fileId: f.id,
      purpose: f.purpose,
      kind: f.kind,
      name: f.name,
      mime: f.mime || '',
      sizeBytes: Number(f.sizeBytes),
      createdAt: f.createdAt,
    })));
  });

  /**
   * DELETE /api/files/:id
   * 删除未绑定文件记录（仅上传者）。生产环境由小程序端清理云对象，
   * 避免云托管后端访问存储凭据服务超时。
   */
  router.del('/api/files/:id', async (req, res, params) => {
    const user = await requireUser(req);
    const file = await queryOne(`SELECT * FROM uploaded_files WHERE id = ?`, [params.id]);
    if (!file) throw err.notFound('文件不存在');
    if (file.uploaderId !== user.id) throw err.forbidden('仅上传者可删除');
    if (file.orderId) throw err.conflict('订单附件不能直接删除');
    const verification = await queryOne(
      `SELECT fileId FROM identity_verification_files WHERE fileId = ?
       UNION SELECT fileId FROM engineer_verification_files WHERE fileId = ? LIMIT 1`,
      [file.id, file.id]
    );
    if (verification) throw err.conflict('身份认证材料请在“身份认证”页面删除');
    const invoiceFile = await queryOne(
      `SELECT fileId FROM invoice_request_files WHERE fileId = ?`,
      [file.id]
    );
    if (invoiceFile) throw err.conflict('已提交的发票文件不能直接删除');
    await query(`DELETE FROM uploaded_files WHERE id = ?`, [params.id]);
    if (config.env !== 'production') {
      try { await getStorage().deleteFile({ fileList: [file.fileID] }); } catch (e) {
        console.error('[files] cloud delete failed', e.message);
      }
    }
    ok(res, { deleted: true, fileID: file.fileID });
  });
}

module.exports = { register, canReadFile };
