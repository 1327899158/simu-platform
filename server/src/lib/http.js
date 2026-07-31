'use strict';
/** 极简 HTTP 工具：路由（带路径参数）、请求体读取、统一响应格式。 */

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const err = {
  bad: (m = '参数错误') => new ApiError(400, 40000, m),
  unauth: (m = '未登录或登录已过期') => new ApiError(401, 40100, m),
  forbidden: (m = '无权访问') => new ApiError(403, 40300, m),
  notFound: (m = '资源不存在') => new ApiError(404, 40400, m),
  conflict: (m = '状态已变化，请刷新后重试') => new ApiError(409, 40900, m),
  tooMany: (m = '请求过于频繁，请稍后再试') => new ApiError(429, 42900, m),
};

function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:[^/]+/g, (s) => { keys.push(s.slice(1)); return '([^/]+)'; }) + '$'
    );
    routes.push({ method, regex, keys, handler });
  };
  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    del: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.regex.exec(pathname);
        if (m) {
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          return { handler: r.handler, params };
        }
      }
      return null;
    },
  };
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new ApiError(413, 41300, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limitBytes = 1024 * 1024) {
  const buf = await readBody(req, limitBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw err.bad('JSON 解析失败');
  }
}

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}
const ok = (res, data = null) => sendJson(res, 200, { code: 0, data });

module.exports = { ApiError, err, createRouter, readBody, readJson, sendJson, ok };
