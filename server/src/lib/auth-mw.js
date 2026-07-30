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
  // 云托管正式注入的头
  let openid = req.headers['x-wx-openid'] || '';
  // 本地开发辅助：允许显式设 openid（仅 development 环境）
  if (!openid && config.env === 'development') {
    openid = req.headers['x-dev-openid'] || process.env.DEV_OPENID || '';
  }
  return openid || null;
}

/**
 * 获取（或按需创建）用户。
 * openid 由微信侧保证唯一性，第一次登录时自动建账号。
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
  }
  return user;
}

/** 必须登录（从头里拿 openid，自动 upsert 用户） */
async function requireUser(req, roleHint) {
  const openid = getOpenid(req);
  if (!openid) throw err.unauth('未获取到用户身份（请通过小程序 wx.cloud.callContainer 调用）');
  const user = await getOrCreateUser(openid, roleHint || req.headers['x-wx-role-hint']);
  if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');
  return user;
}

/** 必须是已认证工程师 */
async function requireEngineer(req) {
  const user = await requireUser(req);
  if (user.role !== 'ENGINEER') throw err.forbidden('仅工程师可操作');
  const p = await queryOne(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, [user.id]);
  if (!p || p.verifyStatus !== 'APPROVED') throw err.forbidden('工程师资质未通过审核');
  return user;
}

module.exports = { getOpenid, getOrCreateUser, requireUser, requireEngineer };
