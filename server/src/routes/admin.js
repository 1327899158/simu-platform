'use strict';

const { readJson, ok, err } = require('../lib/http');
const { v, nowIso, maskPhone } = require('../lib/util');
const { query, queryOne, tx, parseJson } = require('../db');
const { requireAdmin, writeAdminAudit } = require('../lib/admin-mw');
const { DICTS } = require('./dicts');
const { requireUser } = require('../lib/auth-mw');

const ROLE_TEXT = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营管理员',
  AUDITOR: '审计员',
  ENGINEER_REVIEWER: '工程师审核员',
};

const VERIFY_TEXT = {
  PENDING: '待审核', APPROVED: '已通过', REJECTED: '已驳回',
};

function pageArgs(q) {
  return {
    limit: q.get('limit') ? v.int(q.get('limit'), 'limit', { min: 1, max: 100 }) : 30,
    offset: q.get('offset') ? v.int(q.get('offset'), 'offset', { min: 0, max: 1000000 }) : 0,
  };
}

function adminView(user, admin) {
  return {
    isAdmin: true,
    id: admin.id,
    userId: user.id,
    displayName: admin.displayName || user.nickname || '管理员',
    avatarUrl: user.avatarUrl || '',
    adminRole: admin.adminRole,
    adminRoleText: ROLE_TEXT[admin.adminRole] || admin.adminRole,
    permissions: admin.permissions,
  };
}

function register(router) {
  router.get('/api/admin/me', async (req, res) => {
    // 管理员可能首次直接扫码进入；这里只建立普通 users 身份，不切换已有用户角色。
    await requireUser(req, 'CUSTOMER');
    const { user, admin } = await requireAdmin(req);
    const now = nowIso();
    await query(`UPDATE admin_accounts SET lastLoginAt = ?, updatedAt = ? WHERE id = ?`, [now, now, admin.id]);
    return ok(res, adminView(user, admin));
  });

  router.get('/api/admin/dashboard', async (req, res) => {
    await requireAdmin(req, 'DASHBOARD_READ');
    const [users, engineers, orders, quotes, recentUsers, recentOrders] = await Promise.all([
      queryOne(`SELECT COUNT(*) AS total,
        SUM(status = 'ACTIVE') AS activeCount,
        SUM(role = 'CUSTOMER') AS customerCount,
        SUM(role = 'ENGINEER') AS engineerCount
        FROM users WHERE deletedAt IS NULL`),
      queryOne(`SELECT COUNT(*) AS total,
        SUM(verifyStatus = 'PENDING') AS pendingCount,
        SUM(verifyStatus = 'APPROVED') AS approvedCount,
        SUM(verifyStatus = 'REJECTED') AS rejectedCount
        FROM engineer_profiles`),
      query(`SELECT status, COUNT(*) AS count FROM orders WHERE deletedAt IS NULL GROUP BY status`),
      queryOne(`SELECT COUNT(*) AS total FROM quotes WHERE status <> 'WITHDRAWN'`),
      queryOne(`SELECT COUNT(*) AS count FROM users
        WHERE deletedAt IS NULL AND createdAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)`),
      queryOne(`SELECT COUNT(*) AS count FROM orders
        WHERE deletedAt IS NULL AND createdAt >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)`),
    ]);
    const orderCounts = {};
    for (const row of orders) orderCounts[row.status] = Number(row.count || 0);
    return ok(res, {
      users: {
        total: Number(users.total || 0), active: Number(users.activeCount || 0),
        customers: Number(users.customerCount || 0), engineers: Number(users.engineerCount || 0),
        recent7d: Number(recentUsers.count || 0),
      },
      engineerReviews: {
        total: Number(engineers.total || 0), pending: Number(engineers.pendingCount || 0),
        approved: Number(engineers.approvedCount || 0), rejected: Number(engineers.rejectedCount || 0),
      },
      orders: { ...orderCounts, recent7d: Number(recentOrders.count || 0) },
      quotes: { total: Number(quotes.total || 0) },
    });
  });

  router.get('/api/admin/users', async (req, res, _params, q) => {
    await requireAdmin(req, 'USER_READ');
    const { limit, offset } = pageArgs(q);
    const cond = ['u.deletedAt IS NULL'];
    const args = [];
    const search = String(q.get('search') || '').trim().slice(0, 60);
    const role = String(q.get('role') || '').toUpperCase();
    const status = String(q.get('status') || '').toUpperCase();
    if (search) {
      cond.push('(u.nickname LIKE ? OR u.username LIKE ? OR u.phone LIKE ? OR u.id = ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`, search);
    }
    if (role) { v.oneOf(role, '用户角色', ['CUSTOMER', 'ENGINEER']); cond.push('u.role = ?'); args.push(role); }
    if (status) { v.oneOf(status, '账号状态', ['ACTIVE', 'DISABLED']); cond.push('u.status = ?'); args.push(status); }
    const where = cond.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM users u WHERE ${where}`, args);
    const rows = await query(
      `SELECT u.id, u.role, u.username, u.phone, u.nickname, u.avatarUrl, u.status,
              u.createdAt, ep.verifyStatus, aa.adminRole, aa.status AS adminStatus
       FROM users u
       LEFT JOIN engineer_profiles ep ON ep.userId = u.id
       LEFT JOIN admin_accounts aa ON aa.userId = u.id
       WHERE ${where}
       ORDER BY u.createdAt DESC LIMIT ${limit} OFFSET ${offset}`,
      args
    );
    return ok(res, {
      items: rows.map((row) => ({
        ...row, phone: maskPhone(row.phone), isAdmin: row.adminStatus === 'ACTIVE',
      })),
      total: Number(totalRow.count || 0), limit, offset,
    });
  });

  router.patch('/api/admin/users/:id/status', async (req, res, params) => {
    const { user, admin } = await requireAdmin(req, 'USER_STATUS_UPDATE');
    const body = await readJson(req);
    const status = v.oneOf(String(body.status || '').toUpperCase(), '账号状态', ['ACTIVE', 'DISABLED']);
    const target = await queryOne(
      `SELECT u.id, u.status, aa.adminRole, aa.status AS adminStatus
       FROM users u LEFT JOIN admin_accounts aa ON aa.userId = u.id
       WHERE u.id = ? AND u.deletedAt IS NULL`, [params.id]
    );
    if (!target) throw err.notFound('用户不存在');
    if (target.id === user.id && status === 'DISABLED') throw err.bad('不能停用当前登录账号');
    if (target.adminStatus === 'ACTIVE' && admin.adminRole !== 'SUPER_ADMIN') {
      throw err.forbidden('只有超级管理员可以修改管理员账号状态');
    }
    await tx(async (conn) => {
      await conn.execute(`UPDATE users SET status = ?, updatedAt = ? WHERE id = ?`, [status, nowIso(), target.id]);
      await writeAdminAudit(req, admin, 'USER_STATUS_UPDATE', 'USER', target.id, {
        from: target.status, to: status,
      }, conn);
    });
    return ok(res, { id: target.id, status });
  });

  router.get('/api/admin/engineers', async (req, res, _params, q) => {
    await requireAdmin(req, 'ENGINEER_READ');
    const { limit, offset } = pageArgs(q);
    const cond = ['u.deletedAt IS NULL'];
    const args = [];
    const verifyStatus = String(q.get('status') || '').toUpperCase();
    const search = String(q.get('search') || '').trim().slice(0, 60);
    if (verifyStatus) {
      v.oneOf(verifyStatus, '审核状态', ['PENDING', 'APPROVED', 'REJECTED']);
      cond.push('ep.verifyStatus = ?'); args.push(verifyStatus);
    }
    if (search) {
      cond.push('(u.nickname LIKE ? OR ep.realName LIKE ? OR u.id = ?)');
      args.push(`%${search}%`, `%${search}%`, search);
    }
    const where = cond.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS count FROM engineer_profiles ep JOIN users u ON u.id = ep.userId WHERE ${where}`, args
    );
    const rows = await query(
      `SELECT u.id, u.nickname, u.avatarUrl, u.status AS userStatus, u.createdAt,
              ep.realName, ep.specialties, ep.softwares, ep.intro, ep.verifyStatus,
              ep.reviewReason, ep.reviewedAt
       FROM engineer_profiles ep JOIN users u ON u.id = ep.userId
       WHERE ${where}
       ORDER BY FIELD(ep.verifyStatus, 'PENDING', 'REJECTED', 'APPROVED'), u.createdAt DESC
       LIMIT ${limit} OFFSET ${offset}`,
      args
    );
    return ok(res, {
      items: rows.map((row) => ({
        ...row,
        specialties: parseJson(row.specialties), softwares: parseJson(row.softwares),
        verifyStatusText: VERIFY_TEXT[row.verifyStatus] || row.verifyStatus,
      })),
      total: Number(totalRow.count || 0), limit, offset,
    });
  });

  router.get('/api/admin/engineers/:id', async (req, res, params) => {
    await requireAdmin(req, 'ENGINEER_READ');
    const engineer = await queryOne(
      `SELECT u.id, u.nickname, u.avatarUrl, u.username, u.phone, u.status AS userStatus, u.createdAt,
              ep.realName, ep.specialties, ep.softwares, ep.intro, ep.verifyStatus,
              ep.reviewReason, ep.reviewedAt
       FROM engineer_profiles ep JOIN users u ON u.id = ep.userId
       WHERE ep.userId = ? AND u.deletedAt IS NULL`, [params.id]
    );
    if (!engineer) throw err.notFound('工程师资料不存在');
    const files = await query(
      `SELECT f.id, f.name, f.kind, f.mime, f.sizeBytes, evf.createdAt
       FROM engineer_verification_files evf
       JOIN uploaded_files f ON f.id = evf.fileId
       WHERE evf.engineerId = ? ORDER BY evf.createdAt DESC`, [params.id]
    );
    return ok(res, {
      ...engineer,
      phone: maskPhone(engineer.phone),
      specialties: parseJson(engineer.specialties),
      softwares: parseJson(engineer.softwares),
      verifyStatusText: VERIFY_TEXT[engineer.verifyStatus] || engineer.verifyStatus,
      files: files.map((file) => ({ ...file, fileId: file.id, sizeBytes: Number(file.sizeBytes || 0) })),
    });
  });

  // 资格资料是私密文件。管理员只能在通过 ENGINEER_READ 鉴权后取得 fileID，
  // 由小程序直接下载/预览，避免开放通用文件读取权限。
  router.get('/api/admin/files/:id/url', async (req, res, params) => {
    await requireAdmin(req, 'ENGINEER_READ');
    const file = await queryOne(
      `SELECT f.id, f.fileID, f.name, f.mime, f.sizeBytes
       FROM engineer_verification_files evf
       JOIN uploaded_files f ON f.id = evf.fileId
       WHERE f.id = ?`, [params.id]
    );
    if (!file) throw err.notFound('资格资料不存在');
    return ok(res, { ...file, sizeBytes: Number(file.sizeBytes || 0) });
  });

  router.post('/api/admin/engineers/:id/review', async (req, res, params) => {
    const { admin } = await requireAdmin(req, 'ENGINEER_APPROVE');
    const body = await readJson(req);
    const status = v.oneOf(String(body.status || '').toUpperCase(), '审核结果', ['APPROVED', 'REJECTED']);
    const reason = v.str(body.reason, '审核说明', {
      min: status === 'REJECTED' ? 2 : 0, max: 500, optional: status === 'APPROVED',
    });
    const profile = await queryOne(`SELECT userId, verifyStatus FROM engineer_profiles WHERE userId = ?`, [params.id]);
    if (!profile) throw err.notFound('工程师资料不存在');
    await tx(async (conn) => {
      await conn.execute(
        `UPDATE engineer_profiles
         SET verifyStatus = ?, reviewReason = ?, reviewedAt = ?, reviewedBy = ?
         WHERE userId = ?`,
        [status, reason || null, nowIso(), admin.id, params.id]
      );
      await writeAdminAudit(req, admin, 'ENGINEER_REVIEW', 'ENGINEER', params.id, {
        from: profile.verifyStatus, to: status, reason: reason || null,
      }, conn);
    });
    return ok(res, { userId: params.id, verifyStatus: status, verifyStatusText: VERIFY_TEXT[status] });
  });

  router.get('/api/admin/orders', async (req, res, _params, q) => {
    await requireAdmin(req, 'ORDER_READ');
    const { limit, offset } = pageArgs(q);
    const cond = ['o.deletedAt IS NULL'];
    const args = [];
    const status = String(q.get('status') || '').toUpperCase();
    const search = String(q.get('search') || '').trim().slice(0, 120);
    if (status) {
      v.oneOf(status, '订单状态', Object.keys(DICTS.orderStatus));
      cond.push('o.status = ?'); args.push(status);
    }
    if (search) {
      cond.push('(o.projectName LIKE ? OR o.orderNo LIKE ? OR o.id = ?)');
      args.push(`%${search}%`, `%${search}%`, search);
    }
    const where = cond.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM orders o WHERE ${where}`, args);
    const rows = await query(
      `SELECT o.id, o.orderNo, o.projectName, o.status, o.budgetFen, o.finalAmountFen,
              o.deliveryDays, o.viewCount, o.createdAt, u.nickname AS customerName,
              COUNT(q.id) AS quoteCount
       FROM orders o JOIN users u ON u.id = o.customerId
       LEFT JOIN quotes q ON q.orderId = o.id AND q.status <> 'WITHDRAWN'
       WHERE ${where}
       GROUP BY o.id
       ORDER BY o.createdAt DESC LIMIT ${limit} OFFSET ${offset}`,
      args
    );
    return ok(res, {
      items: rows.map((row) => ({
        ...row,
        budgetFen: row.budgetFen == null ? null : Number(row.budgetFen),
        finalAmountFen: row.finalAmountFen == null ? null : Number(row.finalAmountFen),
        viewCount: Number(row.viewCount || 0), quoteCount: Number(row.quoteCount || 0),
        statusText: DICTS.orderStatus[row.status] || row.status,
      })),
      total: Number(totalRow.count || 0), limit, offset,
    });
  });

  router.get('/api/admin/orders/:id', async (req, res, params) => {
    await requireAdmin(req, 'ORDER_READ');
    const order = await queryOne(
      `SELECT o.*, c.nickname AS customerName, c.phone AS customerPhone,
              e.nickname AS engineerName, q.amountFen AS selectedAmountFen, q.days AS selectedDays
       FROM orders o JOIN users c ON c.id = o.customerId
       LEFT JOIN quotes q ON q.id = o.selectedQuoteId
       LEFT JOIN users e ON e.id = q.engineerId
       WHERE o.id = ? AND o.deletedAt IS NULL`, [params.id]
    );
    if (!order) throw err.notFound('订单不存在');
    const files = await query(
      `SELECT f.id, f.name, f.kind, f.sizeBytes, oa.purpose, f.createdAt
       FROM order_attachments oa JOIN uploaded_files f ON f.id = oa.fileId
       WHERE oa.orderId = ? ORDER BY f.createdAt ASC`, [order.id]
    );
    return ok(res, {
      ...order,
      customerPhone: maskPhone(order.customerPhone),
      softwareTags: parseJson(order.softwareTags), directionTags: parseJson(order.directionTags),
      budgetFen: order.budgetFen == null ? null : Number(order.budgetFen),
      finalAmountFen: order.finalAmountFen == null ? null : Number(order.finalAmountFen),
      selectedAmountFen: order.selectedAmountFen == null ? null : Number(order.selectedAmountFen),
      viewCount: Number(order.viewCount || 0),
      statusText: DICTS.orderStatus[order.status] || order.status,
      files: files.map((file) => ({ ...file, sizeBytes: Number(file.sizeBytes || 0) })),
    });
  });

  router.post('/api/admin/orders/:id/close', async (req, res, params) => {
    const { admin } = await requireAdmin(req, 'ORDER_FORCE_CLOSE');
    const body = await readJson(req);
    const reason = v.str(body.reason, '关闭原因', { min: 2, max: 500 });
    const before = await queryOne(`SELECT id, status FROM orders WHERE id = ? AND deletedAt IS NULL`, [params.id]);
    if (!before) throw err.notFound('订单不存在');
    // 支付中、执行中和已完成订单涉及资金或履约，不允许通过普通管理操作强制关闭。
    if (before.status !== 'QUOTING') throw err.conflict('仅待报价订单可由管理员关闭');
    await tx(async (conn) => {
      const now = nowIso();
      const [changed] = await conn.execute(
        `UPDATE orders SET status = 'CLOSED', closedAt = ?, closedByAdminId = ?,
                           adminCloseReason = ?, updatedAt = ?
         WHERE id = ? AND status = 'QUOTING' AND deletedAt IS NULL`,
        [now, admin.id, reason, now, params.id]
      );
      if (changed.affectedRows !== 1) throw err.conflict('订单状态已变化，请刷新后重试');
      await conn.execute(
        `UPDATE quotes SET status = 'REJECTED', updatedAt = ?
         WHERE orderId = ? AND status = 'PENDING'`, [nowIso(), params.id]
      );
      await writeAdminAudit(req, admin, 'ORDER_FORCE_CLOSE', 'ORDER', params.id, { reason }, conn);
    });
    return ok(res, { id: params.id, status: 'CLOSED', statusText: DICTS.orderStatus.CLOSED });
  });

  router.get('/api/admin/audit-logs', async (req, res, _params, q) => {
    await requireAdmin(req, 'AUDIT_READ');
    const { limit, offset } = pageArgs(q);
    const totalRow = await queryOne(`SELECT COUNT(*) AS count FROM admin_audit_logs`);
    const rows = await query(
      `SELECT l.id, l.action, l.targetType, l.targetId, l.detail, l.requestId, l.createdAt,
              a.adminRole, COALESCE(a.displayName, u.nickname, '管理员') AS adminName
       FROM admin_audit_logs l
       JOIN admin_accounts a ON a.id = l.adminId
       JOIN users u ON u.id = a.userId
       ORDER BY l.id DESC LIMIT ${limit} OFFSET ${offset}`
    );
    return ok(res, {
      items: rows.map((row) => ({ ...row, detail: parseJson(row.detail, {}) })),
      total: Number(totalRow.count || 0), limit, offset,
    });
  });
}

module.exports = { register };
