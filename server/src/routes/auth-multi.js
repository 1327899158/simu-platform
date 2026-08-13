'use strict';
/**
 * 多种登录方式路由（云开发版）：
 * 1. 微信一键登录（已有）
 * 2. 账号密码登录 + 注册
 * 3. 手机验证码登录
 * 4. 忘记密码重置
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, maskPhone, v, hashPassword, verifyPassword, genSessionToken, sessionExpiry } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { getOrCreateUser, findUserByUsername, findUserByPhone, getOrCreateUserByPhone, requireUser } = require('../lib/auth-mw');
const { sendSmsCode, verifySmsCode } = require('../services/sms-svc');
const {
  getClientIp,
  assertWindowAvailable,
  consumeWindow,
  clearWindow,
  retryMessage,
} = require('../services/auth-rate-svc');
const { config } = require('../config');
const { loadUserView } = require('./auth');

const DUMMY_PASSWORD_HASH = '$2b$10$04.uge5pyHgq/APdnsGieuNmAFJVLeNxGIFif6.FEkTyWUiDPw/Tu';

function ensureAllowed(state, message) {
  if (!state.allowed) throw err.tooMany(retryMessage(message, state.retryAfter));
}

/**
 * 为用户生成并存储 session token。
 * 返回 { token, user } —— user 结构与 /api/me 完全一致，
 * 避免账号密码 / 短信登录返回缺失 engineer 详情。
 */
async function issueSession(user) {
  const token = genSessionToken();
  const expires = sessionExpiry();
  await query(
    `UPDATE users SET sessionToken = ?, sessionExpiresAt = ?, updatedAt = ? WHERE id = ?`,
    [token, expires, nowIso(), user.id]
  );
  return { token, user: await loadUserView(user.id) };
}

function register(router) {
  // ========== 微信一键登录由 routes/auth.js 处理（不重复注册） ==========

  // ========== 短信验证码相关 ==========

  // POST /api/auth/reset-password-target
  // { username } -> 仅返回绑定手机号的脱敏值，不向客户端暴露完整号码。
  router.post('/api/auth/reset-password-target', async (req, res) => {
    const b = await readJson(req);
    const username = v.str(b.username, '用户名', { min: 6, max: 12 });
    if (!/^\d+$/.test(username)) throw err.bad('用户名只能是数字');

    ensureAllowed(
      await consumeWindow('RESET_LOOKUP_IP', getClientIp(req), 30, 15 * 60),
      '查询次数过多'
    );

    const user = await findUserByUsername(username);
    if (!user || !user.phone) throw err.notFound('账号不存在或未绑定手机号');
    ok(res, { username, phoneMasked: maskPhone(user.phone) });
  });

  // POST /api/auth/request-sms
  // REGISTER/LOGIN: { phone, type }
  // RESET_PWD: { username, type }，手机号必须由服务端按账号获取。
  router.post('/api/auth/request-sms', async (req, res) => {
    const b = await readJson(req);
    const type = v.oneOf(b.type, 'type', ['REGISTER', 'LOGIN', 'RESET_PWD']);
    let phone;

    if (type === 'RESET_PWD') {
      const username = v.str(b.username, '用户名', { min: 6, max: 12 });
      if (!/^\d+$/.test(username)) throw err.bad('用户名只能是数字');
      const user = await findUserByUsername(username);
      if (!user || !user.phone) throw err.notFound('账号不存在或未绑定手机号');

      const accountRate = await consumeWindow(
        'RESET_SMS_ACCOUNT', username,
        config.authRate.resetSmsAccountLimit,
        config.authRate.resetSmsWindowSec
      );
      ensureAllowed(accountRate, '该账号验证码发送次数过多');
      const ipRate = await consumeWindow(
        'RESET_SMS_IP', getClientIp(req),
        config.authRate.resetSmsIpLimit,
        config.authRate.resetSmsWindowSec
      );
      ensureAllowed(ipRate, '当前网络验证码发送次数过多');
      phone = user.phone;
    } else {
      phone = v.str(b.phone, '手机号', { min: 11, max: 11 });
    }

    // REGISTER 类型：检查手机号是否已注册
    if (type === 'REGISTER') {
      const existing = await findUserByPhone(phone);
      if (existing) throw err.conflict('该手机号已注册');
    }

    // LOGIN 不检查账号是否已存在：验证码校验成功后，phone-login 会为新手机号
    // 创建仅含手机号的账号。这样不会因为“是否已注册”的差异泄露账号状态。

    const rateKey = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
    const result = await sendSmsCode(phone, type, rateKey);
    ok(res, type === 'RESET_PWD' ? { ...result, phoneMasked: maskPhone(phone) } : result);
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

    const clientIp = getClientIp(req);
    ensureAllowed(
      await assertWindowAvailable(
        'LOGIN_ACCOUNT', username,
        config.authRate.loginAccountLimit,
        config.authRate.loginWindowSec
      ),
      '登录失败次数过多'
    );
    ensureAllowed(
      await assertWindowAvailable(
        'LOGIN_IP', clientIp,
        config.authRate.loginIpLimit,
        config.authRate.loginWindowSec
      ),
      '当前网络登录失败次数过多'
    );

    const user = await findUserByUsername(username);
    // 不存在的账号也执行一次 bcrypt，缩小通过响应时间枚举账号的空间。
    const valid = await verifyPassword(user?.passwordHash || DUMMY_PASSWORD_HASH, password);
    if (!user || !valid) {
      const accountRate = await consumeWindow(
        'LOGIN_ACCOUNT', username,
        config.authRate.loginAccountLimit,
        config.authRate.loginWindowSec
      );
      const ipRate = await consumeWindow(
        'LOGIN_IP', clientIp,
        config.authRate.loginIpLimit,
        config.authRate.loginWindowSec
      );
      if (accountRate.count >= config.authRate.loginAccountLimit) {
        throw err.tooMany(retryMessage('登录失败次数过多', accountRate.retryAfter));
      }
      if (ipRate.count >= config.authRate.loginIpLimit) {
        throw err.tooMany(retryMessage('当前网络登录失败次数过多', ipRate.retryAfter));
      }
      throw err.unauth('用户名或密码错误');
    }

    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');

    // 成功登录后清除该账号的失败记录；IP 记录保留到窗口自然结束，防止撞库者
    // 用偶然成功的账号清空整个来源地址的限制。
    await clearWindow('LOGIN_ACCOUNT', username);

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

    // 获取或创建用户。新用户暂不设置 username/passwordHash，后续由本人
    // 在“我的 - 账户与密码”中一次性设置账号密码。
    const user = await getOrCreateUserByPhone(phone, roleHint);

    if (user.status !== 'ACTIVE') throw err.forbidden('账号不可用');

    const session = await issueSession(user);
    ok(res, session);
  });

  // POST /api/auth/set-account-password
  // 手机验证码登录后首次设置账号和密码；账号只能设置一次，已有密码请走忘记密码流程。
  router.post('/api/auth/set-account-password', async (req, res) => {
    const user = await requireUser(req);
    const b = await readJson(req);
    const username = v.str(b.username, '账号', { min: 6, max: 12 });
    const password = v.str(b.password, '密码', { min: 6, max: 50 });
    if (!/^\d+$/.test(username)) throw err.bad('账号只能为6-12位数字');

    await tx(async (conn) => {
      const [[current]] = await conn.execute(
        `SELECT id, username, passwordHash FROM users WHERE id = ? FOR UPDATE`, [user.id]
      );
      if (!current) throw err.unauth('登录状态已失效');
      if (current.username || current.passwordHash) {
        throw err.conflict('账号和密码已设置，请通过忘记密码重置密码');
      }
      const [[occupied]] = await conn.execute(
        `SELECT id FROM users WHERE username = ? LIMIT 1 FOR UPDATE`, [username]
      );
      if (occupied) throw err.conflict('该账号已被使用');
      const passwordHash = await hashPassword(password);
      await conn.execute(
        `UPDATE users SET username = ?, passwordHash = ?, updatedAt = ?
          WHERE id = ? AND username IS NULL AND passwordHash IS NULL`,
        [username, passwordHash, nowIso(), user.id]
      );
    });
    ok(res, { user: await loadUserView(user.id), message: '账号和密码已设置' });
  });

  // ========== 忘记密码 ==========

  // POST /api/auth/reset-password
  // { username, newPassword, smsCode }
  router.post('/api/auth/reset-password', async (req, res) => {
    const b = await readJson(req);
    const username = v.str(b.username, '用户名', { min: 6, max: 12 });
    const newPassword = v.str(b.newPassword, '新密码', { min: 6, max: 50 });
    const smsCode = v.str(b.smsCode, '验证码', { min: 6, max: 6 });
    if (!/^\d+$/.test(username)) throw err.bad('用户名只能是数字');

    // 必须先按用户名取得该账号绑定的手机号。客户端不能指定验证码接收号码，
    // 防止使用其他已注册号码的验证码重置当前账号。
    const user = await findUserByUsername(username);
    if (!user || !user.phone) throw err.notFound('账号不存在或未绑定手机号');

    const clientIp = getClientIp(req);
    ensureAllowed(
      await assertWindowAvailable(
        'RESET_VERIFY_ACCOUNT', username,
        config.authRate.resetVerifyAccountLimit,
        config.authRate.resetVerifyWindowSec
      ),
      '验证码校验失败次数过多'
    );
    ensureAllowed(
      await assertWindowAvailable(
        'RESET_VERIFY_IP', clientIp,
        config.authRate.resetVerifyIpLimit,
        config.authRate.resetVerifyWindowSec
      ),
      '当前网络验证码校验失败次数过多'
    );
    ensureAllowed(
      await assertWindowAvailable(
        'RESET_SUCCESS_ACCOUNT', username,
        config.authRate.resetSuccessAccountLimit,
        config.authRate.resetSuccessWindowSec
      ),
      '该账号密码重置次数过多'
    );

    // 先验证但暂不核销：若新密码与旧密码相同，用户仍可在验证码有效期内
    // 修改新密码后再次提交。最终写入前会再次验证并原子核销。
    try {
      await verifySmsCode(user.phone, smsCode, 'RESET_PWD', { consume: false });
    } catch (e) {
      const accountRate = await consumeWindow(
        'RESET_VERIFY_ACCOUNT', username,
        config.authRate.resetVerifyAccountLimit,
        config.authRate.resetVerifyWindowSec
      );
      const ipRate = await consumeWindow(
        'RESET_VERIFY_IP', clientIp,
        config.authRate.resetVerifyIpLimit,
        config.authRate.resetVerifyWindowSec
      );
      if (accountRate.count >= config.authRate.resetVerifyAccountLimit) {
        throw err.tooMany(retryMessage('验证码校验失败次数过多', accountRate.retryAfter));
      }
      if (ipRate.count >= config.authRate.resetVerifyIpLimit) {
        throw err.tooMany(retryMessage('当前网络验证码校验失败次数过多', ipRate.retryAfter));
      }
      throw e;
    }

    // 必须在验证码通过后才能比较旧密码，否则接口会成为“猜测当前密码是否正确”的
    // 密码判定器。bcrypt 只在服务端比较，密码和哈希均不会出现在响应或日志中。
    if (user.passwordHash && await verifyPassword(user.passwordHash, newPassword)) {
      throw err.conflict('新密码不能与当前密码相同，请重新设置');
    }

    ensureAllowed(
      await consumeWindow(
        'RESET_SUCCESS_ACCOUNT', username,
        config.authRate.resetSuccessAccountLimit,
        config.authRate.resetSuccessWindowSec
      ),
      '该账号密码重置次数过多'
    );

    // 更新密码
    const passwordHash = await hashPassword(newPassword);
    // 最终安全门：验证码必须仍未使用且未过期，并在这里原子核销。
    await verifySmsCode(user.phone, smsCode, 'RESET_PWD');
    await query(
      `UPDATE users SET passwordHash = ?, sessionToken = NULL, sessionExpiresAt = NULL, updatedAt = ? WHERE id = ?`,
      [passwordHash, nowIso(), user.id]
    );

    try {
      await clearWindow('LOGIN_ACCOUNT', username);
      await clearWindow('RESET_VERIFY_ACCOUNT', username);
    } catch (e) {
      // 密码已经更新，限流清理失败不应把成功响应变成“重置失败”。
      console.warn('[auth-rate] reset cleanup failed:', e.message);
    }

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
