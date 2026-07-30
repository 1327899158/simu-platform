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

/**
 * 获取（或按需创建）用户 —— 微信登录用（通过 openid）。
 */
async function getOrCreateUser(openid, roleHint = 'CUSTOMER') {
  let user = await queryOne(`SELECT * FROM users WHERE openid = ? AND deletedAt IS NULL`, [openid]);
  if (!user) {
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
         config.env === 'development' ? 'APPROVED' : 'PENDING']
      );
    }
    user = await queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
  } else if (roleHint === 'ENGINEER' && user.role !== 'ENGINEER') {
    // 已有用户切换为工程师
    const { nowIso } = require('../lib/util');
    const now = nowIso();
    await query(`UPDATE users SET role = 'ENGINEER', updatedAt = ? WHERE id = ?`, [now, user.id]);
    // 创建工程师档案（如果不存在）
    const hasProfile = await queryOne(`SELECT userId FROM engineer_profiles WHERE userId = ?`, [user.id]);
    if (!hasProfile) {
      await query(
        `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
         VALUES(?, ?, ?, ?)`,
        [user.id, JSON.stringify([]), JSON.stringify([]),
         config.env === 'development' ? 'APPROVED' : 'PENDING']
      );
    } else {
      await query(`UPDATE engineer_profiles SET verifyStatus = ? WHERE userId = ?`,
        [config.env === 'development' ? 'APPROVED' : 'PENDING', user.id]);
    }
    user = await queryOne(`SELECT * FROM users WHERE id = ?`, [user.id]);
  } else if (roleHint === 'CUSTOMER' && user.role === 'ENGINEER') {
    // 工程师切换回客户
    const { nowIso } = require('../lib/util');
    await query(`UPDATE users SET role = 'CUSTOMER', updatedAt = ? WHERE id = ?`, [nowIso(), user.id]);
    user = await queryOne(`SELECT * FROM users WHERE id = ?`, [user.id]);
  }
  return user;
}

/** 必须登录（优先 openid，其次 session token）——只查不改角色 */
async function requireUser(req, roleHint) {
  // 1. 尝试微信 openid
  const openid = getOpenid(req);
  if (openid) {
    // 有 roleHint 时才创建/切换角色（仅 wx-login 路由会传）
    if (roleHint) {
      const user = await getOrCreateUser(openid, roleHint);
      if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
      return user;
    }
    // 无 roleHint 时只查不改（/api/me、/api/orders 等普通请求）
    const user = await queryOne(`SELECT * FROM users WHERE openid = ? AND deletedAt IS NULL`, [openid]);
    if (!user) throw err.unauth('用户不存在，请重新登录');
    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
    return user;
  }
  // 2. 尝试 session token（账号密码 / 手机号登录用户）
  const token = getSessionToken(req);
  if (token) {
    const user = await queryOne(
      `SELECT * FROM users WHERE sessionToken = ? AND deletedAt IS NULL`,
      [token]
    );
    if (!user) throw err.unauth('会话已过期，请重新登录');
    if (user.sessionExpiresAt) {
      const exp = new Date(user.sessionExpiresAt);
      if (exp < new Date()) throw err.unauth('会话已过期，请重新登录');
    }
    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
    return user;
  }
  throw err.unauth('未获取到用户身份（请通过小程序调用或重新登录）');
}

/** 必须是已认证工程师 */
async function requireEngineer(req) {
  const user = await requireUser(req);
  if (user.role !== 'ENGINEER') throw err.forbidden('仅工程师可操作');
  const p = await queryOne(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, [user.id]);
  if (!p || p.verifyStatus !== 'APPROVED') throw err.forbidden('工程师资质未通过审核');
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
  getOpenid, getOrCreateUser, requireUser, requireEngineer,
  findUserByUsername, findUserByPhone, getOrCreateUserByPhone
};
