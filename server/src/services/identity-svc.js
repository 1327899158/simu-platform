'use strict';
const crypto = require('node:crypto');
const { config } = require('../config');
const { query, queryOne } = require('../db');
const { nowIso } = require('../lib/util');
const { err } = require('../lib/http');

const KEY = crypto.createHash('sha256').update(String(config.identityDataKey)).digest();

function encryptIdCard(value) {
  const plain = String(value || '').trim().toUpperCase();
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptIdCard(value) {
  if (!value) return '';
  try {
    const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[identity] id-card decrypt failed', e.message);
    return '';
  }
}

function idCardHash(value) {
  return crypto.createHmac('sha256', KEY).update(String(value || '').trim().toUpperCase()).digest('hex');
}

function isValidIdCard(value) {
  const id = String(value || '').trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const sum = id.slice(0, 17).split('').reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return checks[sum % 11] === id[17];
}

function validateIdentityFields(realName, phone, idCardNumber) {
  const name = String(realName || '').trim();
  const mobile = String(phone || '').trim();
  const card = String(idCardNumber || '').trim().toUpperCase();
  if (!/^[\u4e00-\u9fa5·]{2,30}$/.test(name)) throw err.bad('真实姓名需填写 2-30 个中文字符');
  if (!/^1[3-9]\d{9}$/.test(mobile)) throw err.bad('请输入正确的 11 位手机号');
  if (!isValidIdCard(card)) throw err.bad('请输入正确的中华人民共和国居民身份证号码');
  return { realName: name, phone: mobile, idCardNumber: card };
}

async function ensureIdentityRecord(user) {
  let identity = await queryOne(`SELECT * FROM identity_verifications WHERE userId=?`, [user.id]);
  if (identity) return identity;
  const now = nowIso();
  await query(
    `INSERT IGNORE INTO identity_verifications(userId, phone, verifyStatus, updatedAt)
     VALUES(?, ?, 'PENDING', ?)`, [user.id, user.phone || null, now]);
  identity = await queryOne(`SELECT * FROM identity_verifications WHERE userId=?`, [user.id]);
  return identity;
}

async function identityStatus(user) {
  const identity = await ensureIdentityRecord(user);
  return identity?.verifyStatus || 'PENDING';
}

async function requireApprovedIdentity(user) {
  if (await identityStatus(user) !== 'APPROVED') {
    throw err.forbidden('请先完成身份认证并等待审核通过');
  }
  return user;
}

module.exports = {
  encryptIdCard, decryptIdCard, idCardHash, isValidIdCard, validateIdentityFields,
  ensureIdentityRecord, identityStatus, requireApprovedIdentity,
};
