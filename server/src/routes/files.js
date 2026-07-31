'use strict';
/**
 * 文件模块（云开发版：云存储 fileID 体系）。
 *
 * 上传：由小程序端直接调用 wx.cloud.uploadFile 上传到云存储，返回 fileID。
 *       上传完成后前端调用 POST /api/files/commit 把 fileID 记录到 MySQL。
 *
 * 下载：GET /api/files/:id/url → 服务端调用 getTempFileURL，返回 2h 有效的 HTTPS 链接。
 *
 * 权限：上传者本人 / 订单客户 / 报价期已认证工程师 / 被选中工程师。
 */
const { readJson, readBody, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { getStorage } = require('../tcb');
const { config } = require('../config');
const { getBoundary, parseMultipart } = require('../lib/multipart');
const path = require('node:path');

const KINDS = ['MODEL', 'DOC', 'IMAGE', 'RESULT'];
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// @cloudbase/node-sdk 返回的成功项使用 code=SUCCESS；部分兼容实现使用 status=0。
// 统一判断，避免把正常上传结果误判为“文件不存在”。
function isTempFileAvailable(item) {
  if (!item || !item.tempFileURL) return false;
  if (item.code !== undefined) return item.code === 'SUCCESS';
  if (item.status !== undefined) return item.status === 0 || item.status === 'SUCCESS';
  return true;
}

function assertCloudFileId(fileID) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')) {
    throw err.bad('fileID 格式不合法，请使用云存储上传');
  }
  if (config.cloudbaseEnv && !fileID.startsWith(`cloud://${config.cloudbaseEnv}`)) {
    throw err.bad('fileID 不属于当前云开发环境');
  }
}

async function assertCloudFileExists(fileID) {
  // In production, verify that the object exists in the configured CloudBase
  // environment before creating a database record. Local development may not
  // have CloudBase credentials, so the prefix check remains the local guard.
  if (config.env !== 'production') return;
  try {
    const result = await getStorage().getTempFileURL({ fileList: [fileID] });
    const item = result.fileList && result.fileList[0];
    if (!isTempFileAvailable(item)) throw new Error('not found');
  } catch (e) {
    throw err.bad('云文件不存在或不属于当前环境');
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

async function saveFileRecord(user, { fileID, name, kind, orderId, sizeBytes }) {
  assertCloudFileId(fileID);
  await assertCloudFileExists(fileID);
  await assertOrderUploadAccess(user, orderId);
  const id = newId();
  await query(
    `INSERT INTO uploaded_files(id, orderId, uploaderId, kind, name, fileID, sizeBytes, createdAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, orderId || null, user.id, kind, name, fileID, sizeBytes || 0, nowIso()]
  );
  return { id, fileID, fileId: id, name, kind, sizeBytes: sizeBytes || 0 };
}

async function canReadFile(user, file) {
  if (!user) return false;
  if (file.uploaderId === user.id) return true;
  // 无订单关联的 IMAGE（头像等）所有登录用户均可读
  if (!file.orderId && file.kind === 'IMAGE') return true;
  if (!file.orderId) return false;
  const order = await queryOne(`SELECT * FROM orders WHERE id = ?`, [file.orderId]);
  if (!order) return false;
  if (order.customerId === user.id) return true;
  if (user.role === 'ENGINEER') {
    const p = await queryOne(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, [user.id]);
    const approved = p && p.verifyStatus === 'APPROVED';
    if (!approved) return false;
    if (order.status === 'QUOTING') return true; // 报价期可查看需求文件
    const sel = order.selectedQuoteId
      ? await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [order.selectedQuoteId])
      : null;
    return !!sel && sel.engineerId === user.id;
  }
  return false;
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
        fileID: uploaded.fileID, name, kind, orderId, sizeBytes: file.data.length,
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
    const sizeBytes = b.sizeBytes ? Number(b.sizeBytes) : 0;
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_UPLOAD_BYTES) {
      throw err.bad('文件大小参数不合法');
    }

    ok(res, await saveFileRecord(user, { fileID, name, kind, orderId, sizeBytes }));
  });

  /**
   * GET /api/files/:id/url
   * 返回云存储 2h 有效临时链接（HTTPS）供前端下载/预览。
   */
  router.get('/api/files/:id/url', async (req, res, params) => {
    const user = await requireUser(req);
    const file = await queryOne(`SELECT * FROM uploaded_files WHERE id = ?`, [params.id]);
    if (!file) throw err.notFound('文件不存在');
    if (!(await canReadFile(user, file))) throw err.forbidden('无权下载该文件');

    const result = await getStorage().getTempFileURL({
      fileList: [file.fileID],
    });
    const item = result.fileList && result.fileList[0];
    if (!isTempFileAvailable(item)) throw err.bad('获取下载链接失败');

    ok(res, {
      url: item.tempFileURL,
      name: file.name,
      sizeBytes: Number(file.sizeBytes),
    });
  });

  /**
   * GET /api/orders/:id/files
   * 订单文件列表（按可读权限过滤）
   */
  router.get('/api/orders/:id/files', async (req, res, params) => {
    const user = await requireUser(req);
    const rows = await query(
      `SELECT * FROM uploaded_files WHERE orderId = ? ORDER BY createdAt`, [params.id]);
    const visible = [];
    for (const f of rows) {
      if (await canReadFile(user, f)) {
        visible.push({
          id: f.id,
          fileID: f.fileID,
          fileId: f.id,
          kind: f.kind,
          name: f.name,
          sizeBytes: Number(f.sizeBytes),
          createdAt: f.createdAt,
        });
      }
    }
    if (rows.length && !visible.length) throw err.forbidden('无权查看该订单文件');
    ok(res, visible);
  });

  /**
   * DELETE /api/files/:id
   * 软删除（仅上传者）
   */
  router.del('/api/files/:id', async (req, res, params) => {
    const user = await requireUser(req);
    const file = await queryOne(`SELECT * FROM uploaded_files WHERE id = ?`, [params.id]);
    if (!file) throw err.notFound('文件不存在');
    if (file.uploaderId !== user.id) throw err.forbidden('仅上传者可删除');
    await query(`DELETE FROM uploaded_files WHERE id = ?`, [params.id]);
    try { await getStorage().deleteFile({ fileList: [file.fileID] }); } catch (e) {
      console.error('[files] cloud delete failed', e.message);
    }
    ok(res, { deleted: true });
  });
}

module.exports = { register, canReadFile };
