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
const { newId, nowIso, maskPhone, v } = require('../lib/util');
const { query, queryOne, tx } = require('../db');
const { requireUser, getOrCreateUser, switchUserRole, getOpenid } = require('../lib/auth-mw');
const { parseJson } = require('../db');
const { config } = require('../config');
const { ensureIdentityRecord } = require('../services/identity-svc');

function userView(u, profile, identity) {
  return {
    id: u.id,
    role: u.role,
    nickname: u.nickname,
    avatarUrl: u.avatarUrl || null,
    openid: u.openid,
    username: u.username,
    hasPassword: Boolean(u.passwordHash),
    // 完整手机号仅保留在服务端，任何用户视图都只返回脱敏值。
    hasPhone: Boolean(u.phone),
    phoneMasked: maskPhone(u.phone),
    // 与账号/手机号登录返回结构保持一致，前端可直接读取认证状态
    verifyStatus: identity?.verifyStatus || 'PENDING',
    identity: identity ? {
      verifyStatus: identity.verifyStatus || 'PENDING',
      reviewReason: identity.reviewReason || '',
      submittedAt: identity.submittedAt || null,
      hasSubmitted: Boolean(identity.submittedAt),
      fileCount: Number(identity.fileCount || 0),
    } : { verifyStatus: 'PENDING', reviewReason: '', submittedAt: null, hasSubmitted: false },
    engineer: profile
      ? {
          ...profile,
          verifyStatus: identity?.verifyStatus || profile.verifyStatus || 'PENDING',
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
  const identity = await ensureIdentityRecord(u);
  const count = await queryOne(
    `SELECT COUNT(*) AS count FROM identity_verification_files WHERE userId = ?`, [u.id]
  );
  identity.fileCount = Number(count.count || 0);
  if (profile) {
    profile.qualificationFileCount = Number(count.count || 0);
  }
  return userView(u, profile, identity);
}

function register(router) {
  // POST /api/auth/wx-login { roleHint?, nickname?, avatarUrl? }
  // 云开发版：openid 从 X-WX-OPENID 头取，无需 jscode2session
  //
  // 语义：
  //   - 未登录 openid → 按 roleHint 首登建档
  //   - 已存在用户  → 显式按 roleHint 切换角色（客户 <-> 工程师）
  //   - session token（账号/手机号登录）→ 走 switchUserRole 直接改角色
  router.post('/api/auth/wx-login', async (req, res) => {
    const body = await readJson(req);
    const roleHint = body.roleHint === 'engineer' ? 'ENGINEER' : 'CUSTOMER';

    // 1. 先按"只读"语义拿到当前用户（openid 首登在这里自动建档，
    //    但对已存在用户不会改角色）
    let user = await requireUser(req, roleHint);

    // 2. 如需切换角色，由此 handler 显式完成
    if (user.role !== roleHint) {
      user = await switchUserRole(user, roleHint);
    }

    // 更新昵称 / 头像（首次登录时一并写入）
    const nickname = body.nickname ? v.str(body.nickname, '昵称', { max: 60, optional: true }) : null;
    const avatarUrl = body.avatarUrl ? v.str(body.avatarUrl, '头像URL', { max: 512, optional: true }) : null;
    if (nickname || avatarUrl) {
      const now = nowIso();
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
          e.specialties ? JSON.stringify(v.arr(e.specialties, '专业方向', { maxLen: 20 })
            .map((item) => v.str(item, '专业方向', { min: 1, max: 60 }))) : null,
          e.softwares ? JSON.stringify(v.arr(e.softwares, '擅长软件', { maxLen: 20 })
            .map((item) => v.str(item, '擅长软件', { min: 1, max: 60 }))) : null,
          user.id,
        ]
      );
    }

    ok(res, await loadUserView(user.id));
  });

  // POST /api/dev/promote-engineer —— 演示阶段自主认证，正式环境可通过配置关闭
  router.post('/api/dev/promote-engineer', async (req, res) => {
    if (!config.allowEngineerSelfVerify) {
      throw err.forbidden('工程师自主认证未开启，请设置 ALLOW_ENGINEER_SELF_VERIFY=true');
    }
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
    await query(
      `INSERT INTO identity_verifications(userId, phone, verifyStatus, reviewedAt, updatedAt)
       VALUES(?, ?, 'APPROVED', ?, ?)
       ON DUPLICATE KEY UPDATE verifyStatus='APPROVED', reviewReason=NULL,
         reviewedAt=VALUES(reviewedAt), updatedAt=VALUES(updatedAt)`,
      [user.id, user.phone || null, now, now]);
    ok(res, await loadUserView(user.id));
  });

  // POST /api/auth/bind-phone { code }
  // 微信授权获取手机号：前端 button open-type="getPhoneNumber" → e.detail.code → 这里换号
  router.post('/api/auth/bind-phone', async (req, res) => {
    const user = await requireUser(req);
    const body = await readJson(req);
    const code = v.str(body.code, '手机号授权code', { min: 1 });
    let phoneNumber = null;
    try {
      // 云托管内部调用微信 API（云 sidecar 自动注入 access_token）
      const http = require('node:http');
      const postData = JSON.stringify({ code });
      const resp = await new Promise((resolve, reject) => {
        const r = http.request({
          hostname: 'api.weixin.qq.com',
          path: '/wxa/business/getuserphonenumber',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, (res) => {
          let data = '';
          res.on('data', (c) => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        r.on('error', reject);
        r.write(postData);
        r.end();
      });
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(`微信API错误: ${resp.errmsg || resp.errcode}`);
      }
      phoneNumber = resp.phone_info?.phoneNumber || resp.phone_info?.purePhoneNumber;
    } catch (e) {
      // 本地开发降级：直接用传入的手机号（仅 dev）
      if (process.env.NODE_ENV === 'development' && body.phone) {
        phoneNumber = body.phone;
      } else {
        throw err.bad('获取手机号失败: ' + e.message);
      }
    }
    if (!phoneNumber) throw err.bad('未获取到手机号');

    // 检查手机号是否被其他用户占用
    const existing = await queryOne(`SELECT id FROM users WHERE phone = ? AND id != ? AND deletedAt IS NULL`, [phoneNumber, user.id]);
    if (existing) throw err.conflict('该手机号已被其他账号绑定');

    const boundAt = nowIso();
    await tx(async (conn) => {
      await conn.execute(`UPDATE users SET phone = ?, updatedAt = ? WHERE id = ?`, [phoneNumber, boundAt, user.id]);
      await conn.execute(
        `UPDATE identity_verifications
            SET phone = CASE WHEN phone IS NULL OR phone = '' THEN ? ELSE phone END, updatedAt = ?
          WHERE userId = ?`,
        [phoneNumber, boundAt, user.id]
      );
    });
    ok(res, { phoneMasked: maskPhone(phoneNumber), user: await loadUserView(user.id) });
  });
}

module.exports = { register, loadUserView };
