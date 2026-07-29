'use strict';
/** ID 生成、入参校验工具（云开发版，已移除 JWT/签名/密码相关） */
const crypto = require('node:crypto');
const { err } = require('./http');

// ---------- ID ----------
const newId = () => 'c' + crypto.randomBytes(12).toString('hex');
const nowIso = () => new Date().toISOString();

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

module.exports = { newId, nowIso, v };
