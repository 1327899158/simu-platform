'use strict';
/**
 * 腾讯云短信服务（验证码、忘记密码等）。
 * 本地测试模式：直接返回成功，不真实调用 API。
 */
const { config } = require('../config');
const { query, queryOne } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { err } = require('../lib/http');

/**
 * 生成随机验证码（6 位数字）
 */
function genCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

/**
 * 发送短信验证码
 * @param {string} phone - 手机号
 * @param {string} type - 验证码类型：REGISTER | LOGIN | RESET_PWD
 * @returns {Promise<{sent: boolean, nextRetry: number}>}
 */
async function sendSmsCode(phone, type = 'LOGIN') {
  if (!phone) throw err.bad('手机号不能为空');
  if (!/^\d{11}$/.test(phone)) throw err.bad('手机号格式不正确');

  // 检查冷却期（60 秒内不能重复发送）
  const recent = await queryOne(
    `SELECT createdAt FROM sms_codes WHERE phone = ? AND type = ?
     AND createdAt > DATE_SUB(NOW(), INTERVAL ${config.sms.sendCooldown} SECOND)
     ORDER BY createdAt DESC LIMIT 1`,
    [phone, type]
  );
  if (recent) {
    const nextRetry = Math.ceil((config.sms.sendCooldown * 1000) / 1000);
    return { sent: false, nextRetry, message: '请稍后再试' };
  }

  const code = genCode();
  const id = newId();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + config.sms.codeExpires * 1000);
  const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

  try {
    // TODO: 如果配置了真实腾讯云密钥，可在此调用 SDK
    // const result = await callTencentSMS(phone, code);
    // if (result.error) throw new Error(result.error);

    // 本地测试模式：直接存库（不调用 API）
    if (!config.sms.secretId || !config.sms.secretKey) {
      console.warn(`[SMS TEST] Sending code ${code} to ${phone} (type: ${type})`);
    }

    // 存储验证码
    await query(
      `INSERT INTO sms_codes(id, phone, code, type, expiresAt, createdAt)
       VALUES(?,?,?,?,?,?)`,
      [id, phone, code, type, expiresAtStr, now]
    );

    console.log(`[SMS] Code sent to ${phone} (expires in ${config.sms.codeExpires}s)`);
    return { sent: true, nextRetry: config.sms.sendCooldown };
  } catch (e) {
    console.error('[SMS] Failed:', e.message);
    throw err.internal('发送短信失败');
  }
}

/**
 * 验证短信码（校验一次后标记为已用）
 * @param {string} phone - 手机号
 * @param {string} code - 输入的 6 位码
 * @param {string} type - 验证码类型
 * @returns {Promise<{valid: true}>}
 */
async function verifySmsCode(phone, code, type = 'LOGIN') {
  if (!phone || !code) throw err.bad('手机号和验证码不能为空');
  if (!/^\d{6}$/.test(code)) throw err.bad('验证码格式不正确');

  const record = await queryOne(
    `SELECT id, expiresAt, usedAt FROM sms_codes
     WHERE phone = ? AND code = ? AND type = ?
     ORDER BY createdAt DESC LIMIT 1`,
    [phone, code, type]
  );

  if (!record) throw err.conflict('验证码不存在或已过期');
  if (record.usedAt) throw err.conflict('验证码已被使用');

  // 检查过期时间
  const now = new Date();
  const expiresAt = new Date(record.expiresAt);
  if (now > expiresAt) {
    throw err.conflict('验证码已过期');
  }

  // 标记为已用
  await query(
    `UPDATE sms_codes SET usedAt = ? WHERE id = ?`,
    [nowIso(), record.id]
  );

  return { valid: true };
}

/**
 * 测试环境：获取最后一条未过期的验证码（仅用于开发）
 */
async function getLastCodeForTest(phone) {
  const record = await queryOne(
    `SELECT code, expiresAt FROM sms_codes
     WHERE phone = ? AND usedAt IS NULL
     ORDER BY createdAt DESC LIMIT 1`,
    [phone]
  );
  if (!record) return null;
  const now = new Date();
  const expiresAt = new Date(record.expiresAt);
  if (now > expiresAt) return null;
  return record.code;
}

module.exports = { sendSmsCode, verifySmsCode, getLastCodeForTest };
