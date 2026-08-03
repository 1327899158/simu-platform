'use strict';
/**
 * 腾讯云短信服务（验证码、忘记密码等）。
 * 本地测试模式：直接返回成功，不真实调用 API。
 */
const { config } = require('../config');
const { query, queryOne } = require('../db');
const { newId, nowIso, parseDbDate } = require('../lib/util');
const { err } = require('../lib/http');

/**
 * 生成随机验证码（6 位数字）
 */
function genCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

const ipRate = new Map();
const IP_WINDOW_MS = 10 * 60 * 1000;
const IP_MAX_SENDS = 20;

function checkIpRate(rateKey) {
  if (!rateKey) return;
  const now = Date.now();
  const recent = (ipRate.get(rateKey) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (recent.length >= IP_MAX_SENDS) throw err.tooMany('请求过于频繁，请稍后再试');
  recent.push(now);
  ipRate.set(rateKey, recent);
  if (ipRate.size > 10000) {
    for (const [key, values] of ipRate) if (!values.some((t) => now - t < IP_WINDOW_MS)) ipRate.delete(key);
  }
}

/**
 * 发送短信验证码
 * @param {string} phone - 手机号
 * @param {string} type - 验证码类型：REGISTER | LOGIN | RESET_PWD
 * @returns {Promise<{sent: boolean, nextRetry: number}>}
 */
async function sendSmsCode(phone, type = 'LOGIN', rateKey = '') {
  if (!phone) throw err.bad('手机号不能为空');
  if (!/^\d{11}$/.test(phone)) throw err.bad('手机号格式不正确');
  checkIpRate(rateKey);

  // 检查冷却期（60 秒内不能重复发送）
  const recent = await queryOne(
    `SELECT createdAt FROM sms_codes WHERE phone = ? AND type = ?
     AND createdAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${config.sms.sendCooldown} SECOND)
     ORDER BY createdAt DESC LIMIT 1`,
    [phone, type]
  );
  if (recent) {
    const nextRetry = Math.ceil((config.sms.sendCooldown * 1000) / 1000);
    return { sent: false, nextRetry, message: '请稍后再试' };
  }

  try {
    const code = genCode();
    const id = newId();
    const now = nowIso();
    const expiresAt = new Date(Date.now() + config.sms.codeExpires * 1000);
    const expiresAtStr = expiresAt.toISOString().slice(0, 19).replace('T', ' ');

    // 检查是否配置了真实腾讯云密钥
    if (config.sms.secretId && config.sms.secretKey && config.sms.templateId) {
      // 真实发送：调用腾讯云 SMS API
      const tencentcloud = require('tencentcloud-sdk-nodejs');
      const SmsClient = tencentcloud.sms.v20210111.Client;
      const client = new SmsClient({
        credential: { secretId: config.sms.secretId, secretKey: config.sms.secretKey },
        region: config.sms.region,
        profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
      });
      const sendResult = await client.SendSms({
        SmsSdkAppId: config.sms.sdkAppId || '',
        SignName: config.sms.signName,
        PhoneNumberSet: ['+86' + phone],
        TemplateId: config.sms.templateId,
        TemplateParamSet: [code, String(config.sms.codeExpires / 60)],
      });
      if (sendResult.SendStatusSet && sendResult.SendStatusSet[0]) {
        const status = sendResult.SendStatusSet[0];
        if (status.Code !== 'Ok') {
          console.error('[SMS] Send failed:', status.Message);
          throw err.bad('短信发送失败');
        }
      }
      console.log(`[SMS] Code sent to ${phone} via Tencent Cloud`);
    } else {
      // 测试模式：验证码只写日志
      console.warn(`[SMS TEST] Sending code ${code} to ${phone} (type: ${type})`);
    }

    // 存储验证码
    await query(
      `INSERT INTO sms_codes(id, phone, code, type, expiresAt, createdAt)
       VALUES(?,?,?,?,?,?)`,
      [id, phone, code, type, expiresAtStr, now]
    );

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
async function verifySmsCode(phone, code, type = 'LOGIN', options = {}) {
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
  const expiresAt = parseDbDate(record.expiresAt);
  if (now > expiresAt) {
    throw err.conflict('验证码已过期');
  }

  // 密码重置需要先确认验证码有效，再检查“新旧密码相同”。此阶段不核销，
  // 最终提交仍会再次调用本函数并以原子 UPDATE 完成一次性核销。
  if (options.consume === false) return { valid: true };

  // Atomically consume the code. Two concurrent requests must not both pass
  // the read-before-write window.
  const consumed = await query(
    `UPDATE sms_codes SET usedAt = ?
     WHERE id = ? AND usedAt IS NULL AND expiresAt > UTC_TIMESTAMP(3)`,
    [nowIso(), record.id]
  );
  if (!consumed || !consumed.affectedRows) throw err.conflict('验证码已被使用或已过期');

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
  const expiresAt = parseDbDate(record.expiresAt);
  if (now > expiresAt) return null;
  return record.code;
}

module.exports = { sendSmsCode, verifySmsCode, getLastCodeForTest };
