'use strict';

// 数据库持久化的固定窗口限流。subject 只用于计算 SHA-256，
// 数据库不会保存原始用户名、手机号或 IP 地址。
const crypto = require('node:crypto');
const { query, queryOne, tx } = require('../db');
const { parseDbDate } = require('../lib/util');

function subjectHash(action, subject) {
  return crypto
    .createHash('sha256')
    .update(`${action}\0${String(subject || '')}`)
    .digest('hex');
}

function toDbDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function getClientIp(req) {
  // 云托管网关通常提供真实来源地址；缺失时退回 TCP 对端地址。
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const real = String(req.headers['x-real-ip'] || '').trim();
  return forwarded || real || req.socket?.remoteAddress || 'unknown';
}

function stateFromRecord(record, windowSeconds, now = new Date()) {
  if (!record) return { count: 0, retryAfter: 0 };
  const startedAt = parseDbDate(record.windowStartedAt);
  const endsAt = new Date(startedAt.getTime() + windowSeconds * 1000);
  if (!Number.isFinite(endsAt.getTime()) || endsAt <= now) return { count: 0, retryAfter: 0 };
  return {
    count: Number(record.attemptCount || 0),
    retryAfter: Math.max(1, Math.ceil((endsAt.getTime() - now.getTime()) / 1000)),
  };
}

async function getWindowState(action, subject, windowSeconds) {
  const record = await queryOne(
    `SELECT windowStartedAt, attemptCount
       FROM auth_rate_limits WHERE action = ? AND subjectHash = ?`,
    [action, subjectHash(action, subject)]
  );
  return stateFromRecord(record, windowSeconds);
}

async function assertWindowAvailable(action, subject, limit, windowSeconds) {
  const state = await getWindowState(action, subject, windowSeconds);
  return { ...state, allowed: state.count < limit };
}

/**
 * 原子占用一次窗口额度。最多允许 limit 次，第 limit + 1 次被拒绝。
 */
async function consumeWindow(action, subject, limit, windowSeconds) {
  const hash = subjectHash(action, subject);
  return tx(async (conn) => {
    const now = new Date();
    const nowValue = toDbDate(now);
    await conn.execute(
      `INSERT IGNORE INTO auth_rate_limits
         (action, subjectHash, windowStartedAt, attemptCount, updatedAt)
       VALUES(?, ?, ?, 0, ?)`,
      [action, hash, nowValue, nowValue]
    );
    const [rows] = await conn.execute(
      `SELECT windowStartedAt, attemptCount
         FROM auth_rate_limits
        WHERE action = ? AND subjectHash = ? FOR UPDATE`,
      [action, hash]
    );
    const record = rows[0];
    let state = stateFromRecord(record, windowSeconds, now);
    let startedAt = record.windowStartedAt;
    if (state.count === 0 && state.retryAfter === 0) {
      startedAt = nowValue;
      state = { count: 0, retryAfter: windowSeconds };
    }
    if (state.count >= limit) {
      return { allowed: false, count: state.count, retryAfter: state.retryAfter };
    }
    const count = state.count + 1;
    await conn.execute(
      `UPDATE auth_rate_limits
          SET windowStartedAt = ?, attemptCount = ?, updatedAt = ?
        WHERE action = ? AND subjectHash = ?`,
      [startedAt, count, nowValue, action, hash]
    );
    return { allowed: true, count, retryAfter: state.retryAfter || windowSeconds };
  });
}

async function clearWindow(action, subject) {
  await query(
    `DELETE FROM auth_rate_limits WHERE action = ? AND subjectHash = ?`,
    [action, subjectHash(action, subject)]
  );
}

function retryMessage(prefix, retryAfter) {
  const minutes = Math.max(1, Math.ceil(Number(retryAfter || 60) / 60));
  return `${prefix}，请${minutes}分钟后再试`;
}

module.exports = {
  getClientIp,
  assertWindowAvailable,
  consumeWindow,
  clearWindow,
  retryMessage,
};
