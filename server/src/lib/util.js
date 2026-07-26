'use strict';
/** JWT(HS256)、ID 生成、入参校验。零依赖实现。 */
const crypto = require('node:crypto');
const { err } = require('./http');

// ---------- JWT ----------
function jwtSign(payload, secret, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const p1 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p2 = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec }))
    .toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${p1}.${p2}`).digest('base64url');
  return `${p1}.${p2}.${sig}`;
}

function jwtVerify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [p1, p2, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update(`${p1}.${p2}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(p2, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

// ---------- ID ----------
const newId = () => 'c' + crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();

// 短时效签名（文件下载链接用）
function signParams(str, secret) {
  return crypto.createHmac('sha256', secret).update(str).digest('base64url').slice(0, 24);
}

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
    const n = typeof x === 'number' ? x : parseInt(x, 10);
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

module.exports = { jwtSign, jwtVerify, newId, newToken, nowIso, signParams, v };
