'use strict';
/**
 * 认证路由（云开发版）。
 *
 * 主登录方式：wx.cloud.callContainer 自动注入 X-WX-OPENID，不需要 wx.login code，
 * 服务端直接用 openid 建账号/查账号。
 *
 * POST /api/auth/wx-login  { roleHint?: 'customer'|'engineer', nickname?, avatarUrl? }
 *   → 自动注册/登录，返回用户信息（无 token）
 *
 * GET  /api/me              → 返回当前用户信息
 * PATCH /api/me             → 更新昵称、头像 fileID、工程师资料
 */
const { readJson, ok, err } = require('../lib/http');
const { newId, nowIso, v } = require('../lib/util');
const { query, queryOne } = require('../db');
const { requireUser } = require('../lib/auth-mw');
const { parseJson } = require('../db');

function userView(u, profile) {
  return {
    id: u.id,
    role: u.role,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl || null,
    openid: u.openid,
    engineer: profile
      ? {
          ...profile,
          specialties: parseJson(profile.specialties),
          softwares: parseJson(profile.softwares),
        }
      : null,
  };
}

async function loadUserView(id) {
  const u = await queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
  if (!u) return null;
  const profile = u.role === 'ENGINEER'
    ? await queryOne(`SELECT * FROM engineer_profiles WHERE userId = ?`, [u.id])
    : null;
  return userView(u, profile);
}

function register(router) {
  // POST /api/auth/wx-login { roleHint?, nickname?, avatarUrl? }
  // 云开发版：openid 从 X-WX-OPENID 头取，无需 jscode2session
  router.post('/api/auth/wx-login', async (req, res) => {
    const body = await readJson(req);
    const roleHint = body.roleHint === 'engineer' ? 'ENGINEER' : 'CUSTOMER';
    const user = await requireUser(req, roleHint);

    // 更新昵称 / 头像（首次登录时一并写入）
    const nickname = body.nickname ? v.str(body.nickname, '昵称', { max: 60, optional: true }) : null;
    const avatarUrl = body.avatarUrl ? v.str(body.avatarUrl, '头像URL', { max: 512, optional: true }) : null;
    if (nickname || avatarUrl) {
      await query(
        `UPDATE users SET
           nickname = COALESCE(?, nickname),
           avatarUrl = COALESCE(?, avatarUrl),
           updatedAt = ?
         WHERE id = ?`,
        [nickname, avatarUrl, now, user.id]
      );
    }

    const view = await loadUserView(user.id);
    ok(res, { isNew: !user.nickname, user: view });
  });

  // GET /api/me
  router.get('/api/me', async (req, res) => {
    const user = await requireUser(req);
    ok(res, await loadUserView(user.id));
  });

  // PATCH /api/me { nickname?, avatarUrl?, engineer?: { specialties?, softwares?, intro?, realName? } }
  router.patch('/api/me', async (req, res) => {
    const user = await requireUser(req);
    const body = await readJson(req);
    const now = nowIso();

    const nickname = v.str(body.nickname, '昵称', { min: 1, max: 60, optional: true });
    // 云开发版：avatarUrl 直接是云存储临时链接或 fileID（由前端传入）
    const avatarUrl = v.str(body.avatarUrl, '头像', { max: 512, optional: true });

    if (nickname !== undefined || avatarUrl !== undefined) {
      await query(
        `UPDATE users SET
           nickname = COALESCE(?, nickname),
           avatarUrl = COALESCE(?, avatarUrl),
           updatedAt = ?
         WHERE id = ?`,
        [nickname ?? null, avatarUrl ?? null, now, user.id]
      );
    }

    if (body.engineer && user.role === 'ENGINEER') {
      const e = body.engineer;
      await query(
        `UPDATE engineer_profiles SET
           realName    = COALESCE(?, realName),
           intro       = COALESCE(?, intro),
           specialties = COALESCE(?, specialties),
           softwares   = COALESCE(?, softwares)
         WHERE userId = ?`,
        [
          v.str(e.realName, '姓名', { max: 30, optional: true }) ?? null,
          v.str(e.intro, '简介', { max: 500, optional: true }) ?? null,
          e.specialties ? JSON.stringify(v.arr(e.specialties, '专业方向')) : null,
          e.softwares ? JSON.stringify(v.arr(e.softwares, '擅长软件')) : null,
          user.id,
        ]
      );
    }

    ok(res, await loadUserView(user.id));
  });

  // POST /api/dev/promote-engineer —— 仅开发环境，快速将当前用户升为已审核工程师
  router.post('/api/dev/promote-engineer', async (req, res) => {
    if (process.env.NODE_ENV === 'production') throw err.notFound('接口不存在');
    const user = await requireUser(req);
    const now = nowIso();
    await query(`UPDATE users SET role = 'ENGINEER', updatedAt = ? WHERE id = ?`, [now, user.id]);
    const has = await queryOne(`SELECT userId FROM engineer_profiles WHERE userId = ?`, [user.id]);
    if (!has) {
      await query(
        `INSERT INTO engineer_profiles(userId, specialties, softwares, verifyStatus)
         VALUES(?, ?, ?, 'APPROVED')`,
        [user.id, JSON.stringify(['结构分析']), JSON.stringify(['ANSYS全系列'])]
      );
    } else {
      await query(`UPDATE engineer_profiles SET verifyStatus = 'APPROVED' WHERE userId = ?`, [user.id]);
    }
    ok(res, await loadUserView(user.id));
  });
}

module.exports = { register, loadUserView };
