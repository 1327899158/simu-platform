'use strict';
/**
 * 文件模块（本地磁盘驱动）。
 * 生产环境替换为 COS 直传（STS 临时密钥 + cos-wx-sdk-v5 分片上传），
 * 本模块的权限模型（谁能下载）在两种驱动下保持一致：
 *   上传者本人 / 订单客户 / 报价期的已认证工程师 / 被选中工程师。
 * 下载一律走短时效签名 URL，杜绝可猜测的公开地址（模型文件保密红线）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { readBody, ok, err } = require('../lib/http');
const { getBoundary, parseMultipart } = require('../lib/multipart');
const { newId, nowIso, signParams, v } = require('../lib/util');
const { config } = require('../config');
const { q } = require('../db');
const { requireUser, getUser } = require('../lib/auth-mw');

const KINDS = ['MODEL', 'DOC', 'IMAGE', 'RESULT'];
const safeExt = (name) => {
  const e = path.extname(name || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(e) ? e : '';
};

function canReadFile(user, file) {
  if (!user) return false;
  if (file.uploaderId === user.id) return true;
  if (!file.orderId) return false;
  const order = q.one(`SELECT * FROM orders WHERE id = ?`, file.orderId);
  if (!order) return false;
  if (order.customerId === user.id) return true;
  if (user.role === 'ENGINEER') {
    const p = q.one(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, user.id);
    const approved = p && p.verifyStatus === 'APPROVED';
    if (!approved) return false;
    if (order.status === 'QUOTING') return true; // 报价期可查看需求文件
    const sel = order.selectedQuoteId
      ? q.one(`SELECT engineerId FROM quotes WHERE id = ?`, order.selectedQuoteId)
      : null;
    return !!sel && sel.engineerId === user.id;
  }
  return false;
}

function register(router) {
  // POST /api/files/upload  multipart: file + kind + orderId?（wx.uploadFile）
  router.post('/api/files/upload', async (req, res) => {
    const user = requireUser(req);
    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) throw err.bad('需要 multipart/form-data');
    const buf = await readBody(req, config.maxUploadBytes);
    const { fields, files } = parseMultipart(buf, boundary);
    const f = files.find((x) => x.field === 'file') || files[0];
    if (!f || !f.data.length) throw err.bad('未收到文件');
    const kind = KINDS.includes(fields.kind) ? fields.kind : 'DOC';
    const orderId = fields.orderId || null;
    if (orderId) {
      const order = q.one(`SELECT * FROM orders WHERE id = ? AND deletedAt IS NULL`, orderId);
      if (!order) throw err.notFound('订单不存在');
      const isCustomer = order.customerId === user.id;
      const isSelectedEngineer = order.selectedQuoteId
        ? q.one(`SELECT engineerId FROM quotes WHERE id = ?`, order.selectedQuoteId)?.engineerId === user.id
        : false;
      if (!isCustomer && !isSelectedEngineer) throw err.forbidden('无权向该订单上传文件');
    }
    const id = newId();
    const store = `${id}${safeExt(f.filename)}`;
    fs.writeFileSync(path.join(config.uploadDir, store), f.data);
    q.run(
      `INSERT INTO files(id, orderId, uploaderId, kind, name, storePath, sizeBytes, mime, createdAt)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      id, orderId, user.id, kind, f.filename || 'file', store, f.data.length, f.contentType, nowIso()
    );
    ok(res, { fileId: id, name: f.filename, sizeBytes: f.data.length, kind });
  });

  // GET /api/files/:id/url  → 10 分钟有效的签名下载地址
  router.get('/api/files/:id/url', async (req, res, params) => {
    const user = requireUser(req);
    const file = q.one(`SELECT * FROM files WHERE id = ?`, params.id);
    if (!file) throw err.notFound('文件不存在');
    if (!canReadFile(user, file)) throw err.forbidden('无权下载该文件');
    const exp = Date.now() + 10 * 60 * 1000;
    const tk = signParams(`${file.id}.${exp}`, config.jwtSecret);
    ok(res, {
      url: `/api/files/raw/${file.id}?exp=${exp}&tk=${tk}`,
      name: file.name,
      sizeBytes: file.sizeBytes,
    });
  });

  // GET /api/files/raw/:id?exp&tk  —— 签名校验后流式下载（无需登录头，便于 wx.downloadFile）
  router.get('/api/files/raw/:id', async (req, res, params, query) => {
    const exp = parseInt(query.get('exp') || '0', 10);
    const tk = query.get('tk') || '';
    if (!exp || exp < Date.now()) throw err.forbidden('下载链接已过期');
    if (signParams(`${params.id}.${exp}`, config.jwtSecret) !== tk) throw err.forbidden('签名无效');
    const file = q.one(`SELECT * FROM files WHERE id = ?`, params.id);
    if (!file) throw err.notFound('文件不存在');
    const full = path.join(config.uploadDir, file.storePath);
    if (!fs.existsSync(full)) throw err.notFound('文件已丢失');
    res.writeHead(200, {
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Length': file.sizeBytes,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
    fs.createReadStream(full).pipe(res);
  });

  // GET /api/orders/:id/files —— 订单文件列表（按可读权限）
  router.get('/api/orders/:id/files', async (req, res, params) => {
    const user = requireUser(req);
    const rows = q.all(`SELECT * FROM files WHERE orderId = ? ORDER BY createdAt`, params.id);
    const visible = rows.filter((f) => canReadFile(user, f));
    if (rows.length && !visible.length) throw err.forbidden('无权查看该订单文件');
    ok(res, visible.map((f) => ({
      fileId: f.id, kind: f.kind, name: f.name, sizeBytes: f.sizeBytes, createdAt: f.createdAt,
    })));
  });
}

module.exports = { register, canReadFile };
