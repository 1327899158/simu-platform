'use strict';
/** 鉴权中间件：Bearer token → req.user；角色/工程师认证检查。 */
const { err } = require('./http');
const { jwtVerify } = require('./util');
const { config } = require('../config');
const { q } = require('../db');

function getUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const payload = jwtVerify(token, config.jwtSecret);
  if (!payload) return null;
  const user = q.one(
    `SELECT id, role, nickname, avatarUrl, status FROM users WHERE id = ? AND deletedAt IS NULL`,
    payload.sub
  );
  if (!user || user.status !== 'ACTIVE') return null;
  return user;
}

/** 必须登录 */
function requireUser(req) {
  const u = getUser(req);
  if (!u) throw err.unauth();
  return u;
}

/** 必须是已认证工程师 */
function requireEngineer(req) {
  const u = requireUser(req);
  if (u.role !== 'ENGINEER') throw err.forbidden('仅工程师可操作');
  const p = q.one(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, u.id);
  if (!p || p.verifyStatus !== 'APPROVED') throw err.forbidden('工程师资质未通过审核');
  return u;
}

module.exports = { getUser, requireUser, requireEngineer };
