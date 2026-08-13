'use strict';
/**
 * 鉴权中间件：从 X-WX-OPENID 头获取用户身份（云托管自动注入）。
 * 彻底替代原来的 JWT Bearer token 方案。
 *
 * 原理：小程序通过 wx.cloud.callContainer 发起请求时，
 * 微信客户端 → 微信网关注入 X-WX-OPENID/X-WX-APPID/X-WX-UNIONID，
 * 这些头由微信侧验签，后端可直接信任，不需要自己做签名校验。
 *
 * 本地开发（curl / Postman）：在 .env 设置 DEV_OPENID=test_openid，
 * 或在请求头里带 X-WX-OPENID: test_openid（仅 NODE_ENV=development 有效）。
 */
const { err } = require('./http');
const { config } = require('../config');
const { queryOne, query } = require('../db');

/**
 * 从请求中提取 openid。
 * 云托管：X-WX-OPENID
 * 本地开发：X-WX-OPENID（由调用者手动填）
 */
function getOpenid(req) {
  let openid = req.headers['x-wx-openid'] || '';
  if (!openid && config.env === 'development') {
    openid = req.headers['x-dev-openid'] || process.env.DEV_OPENID || '';
  }
  return openid || null;
}

/**
 * 从请求中提取 session token（非微信登录用户用）。
 */
function getSessionToken(req) {
  return req.headers['x-session-token'] || null;
}

function validateCloudIdentityHeaders(req) {
  // CloudBase injects X-WX-APPID on callContainer requests.  In production,
  // require it when the application has configured an expected AppID; local
  // development keeps the explicit X-Dev-Openid fallback.
  if (config.env !== 'production' || !config.wxAppid) return;
  const appid = req.headers['x-wx-appid'] || '';
  if (appid !== config.wxAppid) throw err.unauth('微信身份来源校验失败');
}

/**
 * 获取（或按需创建）用户 —— 微信登录用（通过 openid）。
 *
 * 语义（重要）：
 *   1. openid 不存在 → 按 roleHint 创建新用户（首登建档）。
 *   2. openid 已存在 → 直接返回现有用户，**忽略 roleHint**，不改动角色。
 *
 * 角色切换是明确的业务动作（客户 <-> 工程师），必须由调用方在业务
 * handler（例如 /api/auth/wx-login）里显式调用 `switchUserRole`，
 * 中间件 `requireUser` 不应产生角色副作用。
 */
async function getOrCreateUser(openid, roleHint = 'CUSTOMER') {
  roleHint = String(roleHint || 'CUSTOMER').toUpperCase();
  const existing = await queryOne(`SELECT * FROM users WHERE openid = ? AND deletedAt IS NULL`, [openid]);
  if (existing) return existing;

  const { newId, nowIso } = require('../lib/util');
  const id = newId();
  const now = nowIso();
  const role = roleHint === 'ENGINEER' ? 'ENGINEER' : 'CUSTOMER';
  await query(
    `INSERT INTO users(id, role, openid, nickname, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)`,
    [id, role, openid, role === 'ENGINEER' ? '仿真工程师' : '仿真客户', now, now]
  );
  if (role === 'ENGINEER') {
    await query(
      `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
       VALUES(?, ?, ?, ?)`,
      [id, JSON.stringify([]), JSON.stringify([]),
       config.env === 'development' ? 'APPROVED' : 'APPROVED']
    );
  }
  return queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
}

/**
 * 显式切换用户角色（客户 <-> 工程师）——仅供 handler 使用。
 * 调用方需自行做好权限与业务校验（例如仅演示环境或经登录确认）。
 */
async function switchUserRole(user, targetRole) {
  const role = String(targetRole || '').toUpperCase() === 'ENGINEER' ? 'ENGINEER' : 'CUSTOMER';
  if (user.role === role) return user;
  const { nowIso } = require('../lib/util');
  const now = nowIso();
  await query(`UPDATE users SET role = ?, updatedAt = ? WHERE id = ?`, [role, now, user.id]);
  if (role === 'ENGINEER') {
    const hasProfile = await queryOne(`SELECT userId FROM engineer_profiles WHERE userId = ?`, [user.id]);
    if (!hasProfile) {
      await query(
        `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
         VALUES(?, ?, ?, ?)`,
        [user.id, JSON.stringify([]), JSON.stringify([]),
         config.env === 'development' ? 'APPROVED' : 'PENDING']
      );
    }
    // 已有 profile 时不再强制改 verifyStatus——保留原有审核结果。
  }
  return queryOne(`SELECT * FROM users WHERE id = ?`, [user.id]);
}

/**
 * 必须登录（session token 优先，其次 openid）。
 *
 * 语义：只查询/首登建档，**不做角色变更**。
 * roleHint 只在"首次通过 openid 登录时用于建档"，对已存在用户无副作用。
 */
async function requireUser(req, roleHint) {
  validateCloudIdentityHeaders(req);
  // 1. 有 session token 时优先使用（账号密码 / 手机号登录用户）
  //    微信云托管 callContainer 每次都会注入 X-WX-OPENID，
  //    所以必须先查 session token，否则非微信登录用户永远被识别为微信用户
  const token = getSessionToken(req);
  if (token) {
    const user = await queryOne(
      `SELECT * FROM users WHERE sessionToken = ? AND deletedAt IS NULL`,
      [token]
    );
    if (user) {
      if (user.sessionExpiresAt) {
        const exp = require('../lib/util').parseDbDate(user.sessionExpiresAt);
        if (exp < new Date()) throw err.unauth('会话已过期，请重新登录');
      }
      if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
      return user;
    }
    // An explicitly supplied session token must not silently fall back to a
    // different CloudBase openid identity on the same request.
    throw err.unauth('会话无效，请重新登录');
  }
  // 2. 尝试微信 openid：仅"首次登录"时按 roleHint 建档；已存在用户忽略 roleHint。
  const openid = getOpenid(req);
  if (openid) {
    const user = roleHint
      ? await getOrCreateUser(openid, roleHint)
      : await queryOne(`SELECT * FROM users WHERE openid = ? AND deletedAt IS NULL`, [openid]);
    if (!user) throw err.unauth('用户不存在，请重新登录');
    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
    return user;
  }
  throw err.unauth('未获取到用户身份（请通过小程序调用或重新登录）');
}

/** 必须是已认证工程师 */
async function requireEngineer(req) {
  const user = await requireUser(req);
  if (user.role !== 'ENGINEER') throw err.forbidden('仅工程师可操作');
  await require('../services/identity-svc').requireApprovedIdentity(user);
  return user;
}

/** 必须是客户。角色不仅用于界面分流，也必须在服务端强制校验。 */
async function requireCustomer(req) {
  const user = await requireUser(req);
  if (user.role !== 'CUSTOMER') throw err.forbidden('仅客户可操作');
  return user;
}

/** 必须是已通过身份认证的客户，仅用于发布需求等新增业务动作。 */
async function requireVerifiedCustomer(req) {
  const user = await requireCustomer(req);
  await require('../services/identity-svc').requireApprovedIdentity(user);
  return user;
}

// -------- 账号密码 & 短信登录方式 --------

/**
 * 通过用户名查找用户
 */
async function findUserByUsername(username) {
  return queryOne(`SELECT * FROM users WHERE username = ? AND deletedAt IS NULL`, [username]);
}

/**
 * 通过手机号查找用户
 */
async function findUserByPhone(phone) {
  return queryOne(`SELECT * FROM users WHERE phone = ? AND deletedAt IS NULL`, [phone]);
}

/**
 * 账号密码登录 / 注册后的用户获取或创建
 */
async function getOrCreateUserByPhone(phone, roleHint = 'CUSTOMER') {
  roleHint = String(roleHint || 'CUSTOMER').toUpperCase();
  let user = await findUserByPhone(phone);
  if (!user) {
    const { newId, nowIso } = require('../lib/util');
    const id = newId();
    const now = nowIso();
    const role = roleHint === 'ENGINEER' ? 'ENGINEER' : 'CUSTOMER';
    await query(
      `INSERT INTO users(id, role, phone, nickname, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?)`,
      [id, role, phone, role === 'ENGINEER' ? '仿真工程师' : '仿真客户', now, now]
    );
    if (role === 'ENGINEER') {
      await query(
        `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
         VALUES(?, ?, ?, ?)`,
        [id, JSON.stringify([]), JSON.stringify([]),
         config.env === 'development' ? 'APPROVED' : 'PENDING']
      );
    }
    user = await queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
  }
  return user;
}

module.exports = {
  getOpenid, getOrCreateUser, switchUserRole, requireUser, requireCustomer, requireVerifiedCustomer, requireEngineer,
  findUserByUsername, findUserByPhone, getOrCreateUserByPhone
};
