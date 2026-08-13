'use strict';

const { err } = require('./http');
const { requireUser } = require('./auth-mw');
const { query, queryOne } = require('../db');
const { config } = require('../config');
const { newId, nowIso } = require('./util');

const ROLE_PERMISSIONS = Object.freeze({
  SUPER_ADMIN: ['*'],
  OPERATOR: [
    'DASHBOARD_READ', 'USER_READ', 'USER_STATUS_UPDATE', 'ENGINEER_READ',
    'IDENTITY_APPROVE', 'ORDER_READ', 'ORDER_FORCE_CLOSE', 'AUDIT_READ',
    'DISPUTE_READ', 'DISPUTE_RESOLVE', 'INVOICE_READ',
  ],
  AUDITOR: ['DASHBOARD_READ', 'USER_READ', 'ENGINEER_READ', 'ORDER_READ', 'AUDIT_READ', 'DISPUTE_READ', 'INVOICE_READ'],
  ENGINEER_REVIEWER: ['DASHBOARD_READ', 'USER_READ', 'ENGINEER_READ', 'ENGINEER_APPROVE', 'IDENTITY_APPROVE', 'ORDER_READ'],
});

function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

function hasPermission(admin, permission) {
  if (!permission) return true;
  const list = permissionsFor(admin.adminRole);
  return list.includes('*') || list.includes(permission);
}

async function ensureBootstrapAdmin(user) {
  const byUser = config.adminBootstrapUserIds.includes(user.id);
  const byOpenid = !!user.openid && config.adminBootstrapOpenids.includes(user.openid);
  if (!byUser && !byOpenid) return;
  const now = nowIso();
  await query(
    `INSERT INTO admin_accounts(
       id, userId, openid, adminRole, status, displayName, createdAt, updatedAt
     ) VALUES(?, ?, ?, 'SUPER_ADMIN', 'ACTIVE', ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       openid = COALESCE(openid, VALUES(openid)),
       adminRole = 'SUPER_ADMIN', status = 'ACTIVE', updatedAt = VALUES(updatedAt)`,
    [newId(), user.id, user.openid || null, user.nickname || '超级管理员', now, now]
  );
}

async function requireAdmin(req, permission) {
  // 不传 roleHint：管理员入口不会把未知 OpenID 自动注册为普通用户。
  const user = await requireUser(req);
  await ensureBootstrapAdmin(user);
  const admin = await queryOne(
    `SELECT * FROM admin_accounts WHERE userId = ? AND status = 'ACTIVE'`,
    [user.id]
  );
  if (!admin) throw err.forbidden('当前账号没有管理员权限');
  if (!hasPermission(admin, permission)) throw err.forbidden('没有执行此操作的权限');
  return {
    user,
    admin: { ...admin, permissions: permissionsFor(admin.adminRole) },
  };
}

async function writeAdminAudit(req, admin, action, targetType, targetId, detail = null, conn = null) {
  const requestId = String(req.headers['x-request-id'] || req.headers['x-wx-request-id'] || '').slice(0, 128) || null;
  const sql =
    `INSERT INTO admin_audit_logs(
       adminId, action, targetType, targetId, detail, requestId, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?)`;
  const params = [admin.id, action, targetType, targetId || null,
    detail == null ? null : JSON.stringify(detail), requestId, nowIso()];
  if (conn) await conn.execute(sql, params);
  else await query(sql, params);
}

module.exports = {
  ROLE_PERMISSIONS, permissionsFor, hasPermission, requireAdmin, writeAdminAudit,
};
