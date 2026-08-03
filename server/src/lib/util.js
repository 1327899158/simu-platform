'use strict';
/** ID 生成、入参校验工具（云开发版，已移除 JWT/签名/密码相关） */
const crypto = require('node:crypto');
const { err } = require('./http');

// ---------- ID ----------
const newId = () => 'c' + crypto.randomBytes(12).toString('hex');

// ---------- Session Token ----------
const genSessionToken = () => crypto.randomBytes(32).toString('hex');
const SESSION_TTL_HOURS = 72; // session 有效期 72 小时

// 生成 session 过期时间（MySQL DATETIME 格式）
const sessionExpiry = () => {
  const d = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
// MySQL DATETIME 格式：YYYY-MM-DD HH:MM:SS
const nowIso = () => {
  const now = new Date();
  return now.toISOString().slice(0, 19).replace('T', ' ');
  // 例：'2026-07-30 03:39:08'
};

// MySQL DATETIME values are stored as UTC by this service.  Node parses a
// timezone-less date as local time, so always make the UTC contract explicit.
const parseDbDate = (value) => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return new Date(value);
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
};

// 对外展示手机号时只保留前三位和后四位，服务端内部仍使用完整号码。
const maskPhone = (phone) => {
  const value = String(phone || '');
  if (!value) return null;
  if (value.length < 7) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
};

// ---------- 校验 ----------
const v = {
  str(x, name, { min = 0, max = 100000, optional = false } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return undefined;
      throw err.bad(`${name} 不能为空`);
    }
    if (typeof x !== 'string') throw err.bad(`${name} 必须是字符串`);
    const s = x.trim();
    if (s.length < min) throw err.bad(`${name} 至少 ${min} 个字符`);
    if (s.length > max) throw err.bad(`${name} 最多 ${max} 个字符`);
    return s;
  },
  int(x, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
    if (x === undefined || x === null || x === '') {
      if (optional) return undefined;
      throw err.bad(`${name} 不能为空`);
    }
    const n = typeof x === 'number' ? x : Number(x);
    if (!Number.isInteger(n)) throw err.bad(`${name} 必须是整数`);
    if (n < min || n > max) throw err.bad(`${name} 需在 ${min}~${max} 之间`);
    return n;
  },
  arr(x, name, { minLen = 0, maxLen = 50, optional = false } = {}) {
    if (x === undefined || x === null) {
      if (optional) return undefined;
      throw err.bad(`${name} 不能为空`);
    }
    if (!Array.isArray(x)) throw err.bad(`${name} 必须是数组`);
    if (x.length < minLen) throw err.bad(`${name} 至少选择 ${minLen} 项`);
    if (x.length > maxLen) throw err.bad(`${name} 最多 ${maxLen} 项`);
    return x;
  },
  bool(x, dft) {
    if (x === undefined || x === null) return dft;
    return !!x;
  },
  oneOf(x, name, list) {
    if (!list.includes(x)) throw err.bad(`${name} 取值不合法`);
    return x;
  },
};

// ---------- 密码相关（用于账号密码登录） ----------
// 使用 bcrypt 进行密码加密
let bcrypt;
try {
  bcrypt = require('bcrypt');
} catch (e) {
  console.warn('bcrypt 未安装，密码功能不可用');
}

const hashPassword = async (password) => {
  if (!bcrypt) throw new Error('bcrypt 未安装');
  if (!password || password.length < 6) throw err.bad('密码至少 6 个字符');
  return bcrypt.hash(password, 10);
};

const verifyPassword = async (passwordHash, inputPassword) => {
  if (!bcrypt) throw new Error('bcrypt 未安装');
  if (!passwordHash || !inputPassword) return false;
  return bcrypt.compare(inputPassword, passwordHash);
};

module.exports = { newId, nowIso, parseDbDate, maskPhone, v, hashPassword, verifyPassword, genSessionToken, sessionExpiry };
