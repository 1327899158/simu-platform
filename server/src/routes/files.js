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
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

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
    `SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, [user.id]);
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
  // 无订单关联的 IMAGE（头像等）所有登录用户均可读
  if (!file.orderId && file.kind === 'IMAGE') return true;
  if (!file.orderId) return false;
  const order = await queryOne(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [file.orderId]);
  if (!order) return false;
  const access = await orderFileAccess(user, order);
  if (!access) return false;
  return access === 'ALL' || (file.purpose || (file.kind === 'RESULT' ? 'RESULT' : 'REQUIREMENT')) === 'REQUIREMENT';
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
      throw err.bad('文件大小参数不合法');
    }

    ok(res, await saveFileRecord(user, { fileID, name, kind, orderId, sizeBytes, mime }));
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
