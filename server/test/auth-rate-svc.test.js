'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const records = new Map();
const rowKey = (action, hash) => `${action}:${hash}`;

const fakeConn = {
  async execute(sql, params) {
    if (sql.includes('INSERT IGNORE INTO auth_rate_limits')) {
      const [action, hash, startedAt, updatedAt] = params;
      const key = rowKey(action, hash);
      if (!records.has(key)) records.set(key, { windowStartedAt: startedAt, attemptCount: 0, updatedAt });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FOR UPDATE')) {
      const [action, hash] = params;
      return [[records.get(rowKey(action, hash))]];
    }
    if (sql.includes('UPDATE auth_rate_limits')) {
      const [windowStartedAt, attemptCount, updatedAt, action, hash] = params;
      records.set(rowKey(action, hash), { windowStartedAt, attemptCount, updatedAt });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  },
};

const dbPath = require.resolve('../src/db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    tx: async (fn) => fn(fakeConn),
    queryOne: async (_sql, [action, hash]) => records.get(rowKey(action, hash)) || null,
    query: async (_sql, [action, hash]) => {
      records.delete(rowKey(action, hash));
      return { affectedRows: 1 };
    },
  },
};

const {
  assertWindowAvailable,
  consumeWindow,
  clearWindow,
  retryMessage,
} = require('../src/services/auth-rate-svc');

test('fixed window permits the configured count and rejects the next request', async () => {
  records.clear();
  assert.deepEqual(await consumeWindow('LOGIN_ACCOUNT', '100001', 2, 900), {
    allowed: true, count: 1, retryAfter: 900,
  });
  const second = await consumeWindow('LOGIN_ACCOUNT', '100001', 2, 900);
  assert.equal(second.allowed, true);
  assert.equal(second.count, 2);
  const third = await consumeWindow('LOGIN_ACCOUNT', '100001', 2, 900);
  assert.equal(third.allowed, false);
  assert.equal(third.count, 2);
});

test('clearing an account window restores access', async () => {
  await clearWindow('LOGIN_ACCOUNT', '100001');
  const state = await assertWindowAvailable('LOGIN_ACCOUNT', '100001', 2, 900);
  assert.equal(state.allowed, true);
  assert.equal(state.count, 0);
});

test('retry message rounds remaining seconds up to minutes', () => {
  assert.equal(retryMessage('请求过多', 61), '请求过多，请2分钟后再试');
});
