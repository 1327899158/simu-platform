'use strict';
/**
 * 多种登录方式路由（云开发版）：
 * 1. 微信一键登录（已有）
 * 2. 账号密码登录 + 注册
 * 3. 手机验证码登录
 * 4. 忘记密码重置
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v, hashPassword, verifyPassword, genSessionToken, sessionExpiry } = require('../lib/util');
const { query, queryOne } = require('../db');
const { getOrCreateUser, findUserByUsername, findUserByPhone, getOrCreateUserByPhone, requireUser } = require('../lib/auth-mw');
const { sendSmsCode, verifySmsCode } = require('../services/sms-svc');

async function userView(u) {
  const profile = u.role === 'ENGINEER'
    ? await queryOne(`SELECT verifyStatus FROM engineer_profiles WHERE userId = ?`, [u.id])
    : null;
  return {
    id: u.id,
    role: u.role,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    openid: u.openid,
    username: u.username,
    phone: u.phone,
    verifyStatus: profile ? profile.verifyStatus : null,
  };
}

/** 为用户生成并存储 session token，返回 token 和 userView */
async function issueSession(user) {
  const token = genSessionToken();
  const expires = sessionExpiry();
  await query(
    `UPDATE users SET sessionToken = ?, sessionExpiresAt = ?, updatedAt = ? WHERE id = ?`,
    [token, expires, nowIso(), user.id]
  );
  return { token, user: await userView(user) };
}

function register(router) {
  // ========== 微信一键登录由 routes/auth.js 处理（不重复注册） ==========

  // ========== 短信验证码相关 ==========

  // POST /api/auth/request-sms
  // { phone, type: 'REGISTER' | 'LOGIN' | 'RESET_PWD' }
  router.post('/api/auth/request-sms', async (req, res) => {
    const b = await readJson(req);
    const phone = v.str(b.phone, '手机号', { min: 11, max: 11 });
    const type = v.oneOf(b.type, 'type', ['REGISTER', 'LOGIN', 'RESET_PWD']);

    // REGISTER 类型：检查手机号是否已注册
    if (type === 'REGISTER') {
      const existing = await findUserByPhone(phone);
      if (existing) throw err.conflict('该手机号已注册');
    }

    // LOGIN 类型：检查手机号是否已存在
    if (type === 'LOGIN') {
      const existing = await findUserByPhone(phone);
      if (!existing) throw err.notFound('该手机号未注册，请先注册');
    }

    // RESET_PWD 类型：检查手机号是否存在
    if (type === 'RESET_PWD') {
      const existing = await findUserByPhone(phone);
      if (!existing) throw err.notFound('该手机号未注册');
    }

    const rateKey = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
    const result = await sendSmsCode(phone, type, rateKey);
    ok(res, result);
  });

  // ========== 账号密码登录 ==========

  // POST /api/auth/register
  // { username(纯数字6-12位), phone, password, smsCode, roleHint? }
  router.post('/api/auth/register', async (req, res) => {
    const b = await readJson(req);
    const username = v.str(b.username, '用户名', { min: 6, max: 12 });
    const phone = v.str(b.phone, '手机号', { min: 11, max: 11 });
    const password = v.str(b.password, '密码', { min: 6, max: 50 });
    const smsCode = v.str(b.smsCode, '验证码', { min: 6, max: 6 });

    // 检查用户名格式（纯数字）
    if (!/^\d+$/.test(username)) throw err.bad('用户名只能是数字');

    // 检查用户名唯一性
    const usernameExists = await findUserByUsername(username);
    if (usernameExists) throw err.conflict('用户名已被注册');

    // 验证短信码
    await verifySmsCode(phone, smsCode, 'REGISTER');

    // 创建用户
    const id = newId();
    const now = nowIso();
    const passwordHash = await hashPassword(password);
    const roleHint = String(b.roleHint || 'CUSTOMER').toUpperCase();
    const role = roleHint === 'ENGINEER' ? 'ENGINEER' : 'CUSTOMER';

    await query(
      `INSERT INTO users(id, role, username, phone, passwordHash, nickname, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, role, username, phone, passwordHash, role === 'ENGINEER' ? '仿真工程师' : '仿真客户', now, now]
    );

    if (role === 'ENGINEER') {
      await query(
        `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
         VALUES(?, ?, ?, ?)`,
        [id, JSON.stringify([]), JSON.stringify([]),
         process.env.NODE_ENV === 'development' ? 'APPROVED' : 'PENDING']
      );
    }

    const user = await queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
    const session = await issueSession(user);
    ok(res, { ...session, message: '注册成功' });
  });

  // POST /api/auth/login
  // { username, password }
  router.post('/api/auth/login', async (req, res) => {
    const b = await readJson(req);
    const username = v.str(b.username, '用户名', { min: 1 });
    const password = v.str(b.password, '密码', { min: 1 });

    const user = await findUserByUsername(username);
    if (!user) throw err.unauth('用户名或密码错误');

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) throw err.unauth('用户名或密码错误');

    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');

    const session = await issueSession(user);
    ok(res, session);
  });

  // ========== 手机验证码登录 ==========

  // POST /api/auth/phone-login
  // { phone, smsCode }
  router.post('/api/auth/phone-login', async (req, res) => {
    const b = await readJson(req);
    const phone = v.str(b.phone, '手机号', { min: 11, max: 11 });
    const smsCode = v.str(b.smsCode, '验证码', { min: 6, max: 6 });
    const roleHint = String(b.roleHint || 'CUSTOMER').toUpperCase();

    // 验证短信码
    await verifySmsCode(phone, smsCode, 'LOGIN');

    // 获取或创建用户
    const user = await getOrCreateUserByPhone(phone, roleHint);

    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');

    const session = await issueSession(user);
    ok(res, session);
  });

  // ========== 忘记密码 ==========

  // POST /api/auth/reset-password
  // { phone, newPassword, smsCode }
  router.post('/api/auth/reset-password', async (req, res) => {
    const b = await readJson(req);
    const phone = v.str(b.phone, '手机号', { min: 11, max: 11 });
    const newPassword = v.str(b.newPassword, '新密码', { min: 6, max: 50 });
    const smsCode = v.str(b.smsCode, '验证码', { min: 6, max: 6 });

    // 验证短信码
    await verifySmsCode(phone, smsCode, 'RESET_PWD');

    // 查找用户
    const user = await findUserByPhone(phone);
    if (!user) throw err.notFound('用户不存在');

    // 更新密码
    const passwordHash = await hashPassword(newPassword);
    await query(
      `UPDATE users SET passwordHash = ?, sessionToken = NULL, sessionExpiresAt = NULL, updatedAt = ? WHERE id = ?`,
      [passwordHash, nowIso(), user.id]
    );

    ok(res, { message: '密码重置成功' });
  });

  // POST /api/auth/logout
  // Revoke the server-side session as well as clearing the client cache.
  router.post('/api/auth/logout', async (req, res) => {
    const user = await requireUser(req);
    await query(
      `UPDATE users SET sessionToken = NULL, sessionExpiresAt = NULL, updatedAt = ? WHERE id = ?`,
      [nowIso(), user.id]
    );
    ok(res, { loggedOut: true });
  });
}

module.exports = { register };
