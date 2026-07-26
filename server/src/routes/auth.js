'use strict';
/**
 * 认证：微信登录（Mock 可切换）、token 刷新、个人信息。
 * WX_MOCK=1：openid = 'mock_' + code（小程序端在 Mock 模式下传入本机持久化的
 * mockId，保证同一设备同一角色登录得到同一账号）。
 * 真实模式：调用微信 jscode2session（code 一次性有效，失败需前端重新 wx.login）。
 */
const { readJson, ok, err } = require('../lib/http');
const { jwtSign, newId, newToken, nowIso, v } = require('../lib/util');
const { config } = require('../config');
const { q, tx, parseJson } = require('../db');
const { requireUser } = require('../lib/auth-mw');

async function code2Session(code) {
  if (config.wxMock) return { openid: 'mock_' + code };
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(config.wxAppid)}&secret=${encodeURIComponent(config.wxSecret)}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.openid) {
    // 常见 errcode：40163 code 已被使用；40029 code 无效
    throw err.bad(`微信登录失败(${data.errcode || '?'}): ${data.errmsg || '未知错误'}`);
  }
  return data;
}

function issueTokens(userId, role) {
  const access = jwtSign({ sub: userId, role }, config.jwtSecret, config.accessTtlSec);
  const refresh = newToken();
  q.run(
    `INSERT INTO refresh_tokens(token, userId, expiresAt, createdAt) VALUES(?,?,?,?)`,
    refresh, userId, new Date(Date.now() + config.refreshTtlSec * 1000).toISOString(), nowIso()
  );
  return { accessToken: access, refreshToken: refresh };
}

function userView(u) {
  const profile = u.role === 'ENGINEER'
    ? q.one(`SELECT realName, specialties, softwares, intro, verifyStatus FROM engineer_profiles WHERE userId = ?`, u.id)
    : null;
  return {
    id: u.id,
    role: u.role,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl,
    engineer: profile
      ? { ...profile, specialties: parseJson(profile.specialties), softwares: parseJson(profile.softwares) }
      : null,
  };
}

function register(router) {
  // POST /api/auth/wx-login  { code, roleHint?: 'customer'|'engineer', nickname?, avatarUrl? }
  router.post('/api/auth/wx-login', async (req, res) => {
    const body = await readJson(req);
    const code = v.str(body.code, 'code', { min: 1, max: 128 });
    const roleHint = body.roleHint === 'engineer' ? 'ENGINEER' : 'CUSTOMER';
    const session = await code2Session(code);

    const result = tx(() => {
      let u = q.one(`SELECT * FROM users WHERE openid = ?`, session.openid);
      let isNew = false;
      if (!u) {
        isNew = true;
        const id = newId();
        q.run(
          `INSERT INTO users(id, role, openid, nickname, avatarUrl, createdAt, updatedAt)
           VALUES(?,?,?,?,?,?,?)`,
          id, roleHint, session.openid,
          body.nickname || (roleHint === 'ENGINEER' ? '演示工程师' : '演示客户'),
          body.avatarUrl || '', nowIso(), nowIso()
        );
        if (roleHint === 'ENGINEER') {
          // Mock 模式直接置为已认证，方便演示；真实模式为 PENDING，需后台审核
          q.run(
            `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
             VALUES(?,?,?,?)`,
            id, JSON.stringify(['结构分析']), JSON.stringify(['ANSYS全系列']),
            config.wxMock ? 'APPROVED' : 'PENDING'
          );
        }
        u = q.one(`SELECT * FROM users WHERE id = ?`, id);
      }
      if (u.status !== 'ACTIVE') throw err.forbidden('账号不可用');
      return { u, isNew };
    });

    const tokens = issueTokens(result.u.id, result.u.role);
    ok(res, { ...tokens, isNew: result.isNew, user: userView(result.u) });
  });

  // POST /api/auth/refresh  { refreshToken }  —— 旋转刷新
  router.post('/api/auth/refresh', async (req, res) => {
    const body = await readJson(req);
    const token = v.str(body.refreshToken, 'refreshToken', { min: 10 });
    const row = q.one(`SELECT * FROM refresh_tokens WHERE token = ?`, token);
    if (!row || row.expiresAt < nowIso()) throw err.unauth('登录已过期，请重新登录');
    const u = q.one(`SELECT * FROM users WHERE id = ? AND status = 'ACTIVE'`, row.userId);
    if (!u) throw err.unauth();
    q.run(`DELETE FROM refresh_tokens WHERE token = ?`, token); // 一次性旋转
    ok(res, issueTokens(u.id, u.role));
  });

  // GET /api/me
  router.get('/api/me', async (req, res) => {
    const u = requireUser(req);
    ok(res, userView(q.one(`SELECT * FROM users WHERE id = ?`, u.id)));
  });

  // PATCH /api/me  { nickname?, avatarUrl?, engineer?: {realName?, intro?, specialties?, softwares?} }
  router.patch('/api/me', async (req, res) => {
    const u = requireUser(req);
    const body = await readJson(req);
    const nickname = v.str(body.nickname, '昵称', { min: 1, max: 30, optional: true });
    const avatarUrl = v.str(body.avatarUrl, '头像', { max: 500, optional: true });
    if (nickname !== undefined || avatarUrl !== undefined) {
      q.run(
        `UPDATE users SET nickname = COALESCE(?, nickname),
         avatarUrl = COALESCE(?, avatarUrl), updatedAt = ? WHERE id = ?`,
        nickname ?? null, avatarUrl ?? null, nowIso(), u.id
      );
    }
    if (body.engineer && u.role === 'ENGINEER') {
      const e = body.engineer;
      q.run(
        `UPDATE engineer_profiles SET
           realName = COALESCE(?, realName), intro = COALESCE(?, intro),
           specialties = COALESCE(?, specialties), softwares = COALESCE(?, softwares)
         WHERE userId = ?`,
        v.str(e.realName, '姓名', { max: 30, optional: true }) ?? null,
        v.str(e.intro, '简介', { max: 500, optional: true }) ?? null,
        e.specialties ? JSON.stringify(v.arr(e.specialties, '专业方向')) : null,
        e.softwares ? JSON.stringify(v.arr(e.softwares, '擅长软件')) : null,
        u.id
      );
    }
    ok(res, userView(q.one(`SELECT * FROM users WHERE id = ?`, u.id)));
  });
}

module.exports = { register };
