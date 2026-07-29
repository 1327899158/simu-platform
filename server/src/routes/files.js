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
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { getStorage } = require('../tcb');

const KINDS = ['MODEL', 'DOC', 'IMAGE', 'RESULT'];

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

    // fileID 前缀校验：必须属于同一云开发环境
    // cloud://env-id.bucket/... 或以 cloud:// 开头
    if (!fileID.startsWith('cloud://')) throw err.bad('fileID 格式不合法，请使用 wx.cloud.uploadFile 上传');

    if (orderId) {
      const order = await queryOne(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, [orderId]);
      if (!order) throw err.notFound('订单不存在');
      const isCustomer = order.customerId === user.id;
      const sel = order.selectedQuoteId
        ? await queryOne(`SELECT engineerId FROM quotes WHERE id = ?`, [order.selectedQuoteId])
        : null;
      const isSelected = sel && sel.engineerId === user.id;
      if (!isCustomer && !isSelected) throw err.forbidden('无权向该订单上传文件');
    }

    const id = newId();
    await query(
      `INSERT INTO uploaded_files(id, orderId, uploaderId, kind, name, fileID, sizeBytes, createdAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, orderId, user.id, kind, name, fileID, sizeBytes, nowIso()]
    );
    ok(res, { id, fileID, name, kind, sizeBytes });
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
    if (!item || item.status !== 0) throw err.bad('获取下载链接失败');

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
    ok(res, { deleted: true });
  });
}

module.exports = { register, canReadFile };
