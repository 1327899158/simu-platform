'use strict';
/**
 * dispute-svc 单元测试（不依赖真实 MySQL）。
 * 通过 require.cache 注入内存 mock 的 db 模块和 chat-svc 模块，
 * 验证纠纷状态机：开单校验、冻结、取消恢复、仲裁结案、退款登记。
 * 运行：node test/dispute-svc.test.js
 */
const path = require('node:path');

// ---------- 极简内存数据库 ----------
const tables = { orders: [], quotes: [], disputes: [], dispute_evidence: [], dispute_messages: [], uploaded_files: [] };
const seq = { orders: 1, disputes: 1, dispute_messages: 1 };

function nextId(t) { return `t${t}_${seq[t]++}`; }

// 预置数据
tables.orders.push({
  id: 'order1', status: 'IN_PROGRESS', customerId: 'cust1', selectedQuoteId: 'quote1', deletedAt: null,
});
tables.orders.push({
  id: 'order_quoting', status: 'QUOTING', customerId: 'cust1', selectedQuoteId: null, deletedAt: null,
});
tables.orders.push({
  id: 'order_completed', status: 'COMPLETED', customerId: 'cust1', selectedQuoteId: 'quote3', deletedAt: null,
});
tables.quotes.push({ id: 'quote1', orderId: 'order1', engineerId: 'eng1' });
tables.quotes.push({ id: 'quote3', orderId: 'order_completed', engineerId: 'eng1' });
tables.uploaded_files.push({ id: 'file1', uploaderId: 'cust1', orderId: null });

// SQL 解析：仅处理本服务用到的子集
function parseWhere(sql, params, prefix) {
  // 提取 WHERE 之后的 AND 条件，支持 = ? / = 'literal' / = number
  const wherePart = (sql.split(' WHERE ')[1] || '').split(' ORDER BY ')[0];
  const conds = [];
  let i = 0;
  const re = /([A-Za-z_]+)\s*=\s*\?/g;
  let m;
  while ((m = re.exec(wherePart)) !== null) {
    conds.push({ key: m[1], op: '=', val: params[i++] });
  }
  // 字面量条件：col = 'VALUE' / col = VALUE / col = 'OPEN'
  const litRe = /([A-Za-z_]+)\s*=\s*'([^']*)'/g;
  let lm;
  while ((lm = litRe.exec(wherePart)) !== null) {
    conds.push({ key: lm[1], op: '=', val: lm[2] });
  }
  const numRe = /([A-Za-z_]+)\s*=\s*(\d+)/g;
  let nm;
  while ((nm = numRe.exec(wherePart)) !== null) {
    // 避免与上面参数式重复：若该列已有 cond 则跳过
    if (!conds.some((c) => c.key === nm[1])) conds.push({ key: nm[1], op: '=', val: Number(nm[2]) });
  }
  return conds;
}

function matchRow(row, conds) {
  return conds.every((c) => String(row[c.key]) === String(c.val));
}

function runSelect(sql, params) {
  const fromTable = Object.keys(tables).find((t) => sql.includes(` FROM ${t}`) || sql.includes(`FROM ${t}`));
  let rows = tables[fromTable] ? [...tables[fromTable]] : [];
  // 简单支持 IN (...) 过滤
  if (sql.includes(' IN (')) {
    const inCol = sql.match(/WHERE id IN/);
    if (inCol) {
      const ids = params; // IN 占位即全部参数
      rows = rows.filter((r) => ids.includes(r.id));
      return rows;
    }
  }
  const conds = parseWhere(sql, params);
  if (conds.length) rows = rows.filter((r) => matchRow(r, conds));
  // 深拷贝，避免调用方修改影响内存表（模拟 mysql2 反序列化行为）
  return rows.map((r) => ({ ...r }));
}

function runUpdate(sql, params, conn) {
  const fromTable = Object.keys(tables).find((t) => sql.includes(`UPDATE ${t}`));
  const rows = tables[fromTable];
  const setPart = sql.split(' SET ')[1].split(' WHERE ')[0];
  const setAssigns = setPart.split(',').map((s) => s.trim());
  // 参数：SET 里的 ? 先于 WHERE 里的 ?
  const setCount = setAssigns.filter((s) => s.includes('?')).length;
  const setParams = params.slice(0, setCount);
  const whereParams = params.slice(setCount);
  const conds = parseWhere(sql, whereParams);
  let affected = 0;
  for (const row of rows) {
    if (!matchRow(row, conds)) continue;
    let pi = 0;
    for (const assign of setAssigns) {
      // 处理 字面量赋值：col = 'LITERAL' 或 col = 123
      const litM = /^([A-Za-z_]+)\s*=\s*'([^']*)'$/.exec(assign);
      const litNum = /^([A-Za-z_]+)\s*=\s*(\d+)$/.exec(assign);
      if (litM) { row[litM[1]] = litM[2]; continue; }
      if (litNum) { row[litNum[1]] = Number(litNum[2]); continue; }
      if (assign.includes('?')) {
        const [k, rest] = assign.split('=');
        const key = k.trim();
        if (rest.includes('COALESCE')) {
          // COALESCE(?, col)：第一个参数非空才赋值
          const param = setParams[pi++];
          if (param !== undefined && param !== null) row[key] = param;
        } else {
          row[key] = setParams[pi++];
        }
      }
    }
    affected++;
  }
  return { affectedRows: affected };
}

function runInsert(sql, params) {
  const table = Object.keys(tables).find((t) => sql.includes(`INTO ${t}`));
  const colsPart = sql.split('(')[1].split(')')[0];
  const cols = colsPart.split(',').map((c) => c.trim().replace(/`/g, ''));
  const valsPart = sql.split(' VALUES(')[1].split(')')[0];
  // 解析 VALUES 中的 ? 与字面量（'OPEN'、数字）
  const tokens = valsPart.split(',').map((s) => s.trim());
  const row = {};
  let pi = 0;
  for (let i = 0; i < cols.length; i++) {
    const token = tokens[i] || '';
    if (token === '?') {
      row[cols[i]] = params[pi++];
    } else if (/^'[^']*'$/.test(token)) {
      row[cols[i]] = token.slice(1, -1);
    } else if (/^\d+$/.test(token)) {
      row[cols[i]] = Number(token);
    } else if (/^UTC_TIMESTAMP/.test(token)) {
      row[cols[i]] = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } else {
      row[cols[i]] = params[pi++] !== undefined ? params[pi - 1] : undefined;
    }
  }
  tables[table].push(row);
  return { insertId: tables[table].length };
}

const dbMock = {
  async query(sql, params = []) {
    if (/^SELECT/.test(sql.trim())) return runSelect(sql, params);
    if (/^UPDATE/.test(sql.trim())) return runUpdate(sql, params);
    if (/^INSERT/.test(sql.trim())) return runInsert(sql, params);
    if (/^DELETE/.test(sql.trim())) return { affectedRows: 0 };
    return [];
  },
  async queryOne(sql, params = []) {
    const rows = await dbMock.query(sql, params);
    return (rows && rows.length) ? rows[0] : null;
  },
  async tx(fn) {
    // 简化：直接用一个代理连接执行
    const conn = {
      execute: async (sql, params = []) => {
        if (/^SELECT/.test(sql)) return runSelect(sql, params);
        if (/^UPDATE/.test(sql)) return [runUpdate(sql, params)];
        if (/^INSERT/.test(sql)) return [runInsert(sql, params)];
        return [{}];
      },
    };
    return fn(conn);
  },
};

// 注入 mock 模块
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// mock chat-svc 的 systemMessageForOrder
const chatPath = require.resolve('../src/services/chat-svc');
const chatMock = { systemMessageForOrder: async () => {} };
require.cache[chatPath] = { id: chatPath, filename: chatPath, loaded: true, exports: chatMock };

const svc = require('../src/services/dispute-svc');
const { err } = require('../src/lib/http');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name} ${detail}`); }
}
async function expectThrow(name, fn, code) {
  try { await fn(); failed++; console.log(`❌ ${name} —— 未抛错`); }
  catch (e) {
    const ok = e instanceof Error && (!code || e.code === code || e.status === code);
    if (ok) { passed++; console.log(`✅ ${name}`); }
    else { failed++; console.log(`❌ ${name} —— 错误不匹配: ${e.message}`); }
  }
}

(async () => {
  // ---------- 1. 开单校验 ----------
  await expectThrow('非当事人不能发起纠纷', () => svc.createDispute({ id: 'hacker' }, {
    orderId: 'order1', reasonType: 'QUALITY', description: '这是一段足够长的纠纷说明文字', fileIds: [],
  }), 403);

  await expectThrow('QUOTING 状态不能发起纠纷', () => svc.createDispute({ id: 'cust1' }, {
    orderId: 'order_quoting', reasonType: 'QUALITY', description: '这是一段足够长的纠纷说明文字', fileIds: [],
  }), 409);

  // ---------- 2. 成功开单 + 冻结 ----------
  const d1 = await svc.createDispute({ id: 'cust1' }, {
    orderId: 'order1', reasonType: 'QUALITY', description: '这是一段足够长的纠纷说明文字', fileIds: ['file1'],
  });
  check('创建纠纷成功', d1 && d1.id && d1.status === 'OPEN');
  check('开单时快照订单状态', d1.orderStatusAtOpen === 'IN_PROGRESS');
  check('订单被冻结为 DISPUTING', tables.orders.find((o) => o.id === 'order1').status === 'DISPUTING');
  check('证据已关联', tables.dispute_evidence.some((e) => e.disputeId === d1.id && e.fileId === 'file1'));

  // ---------- 3. 重复开单被拒 ----------
  await expectThrow('同一订单已有 OPEN 纠纷时不能重复开单', () => svc.createDispute({ id: 'eng1' }, {
    orderId: 'order1', reasonType: 'DELAY', description: '这是一段足够长的纠纷说明文字', fileIds: [],
  }), 409);

  // ---------- 4. 工程师作为当事人可发起 ----------
  const d2 = await svc.createDispute({ id: 'eng1' }, {
    orderId: 'order_completed', reasonType: 'PAYMENT', description: '这是工程师发起的纠纷说明文字', fileIds: [],
  });
  check('工程师可发起（COMPLETED 阶段）', d2 && d2.status === 'OPEN');
  check('COMPLETED 订单冻结', tables.orders.find((o) => o.id === 'order_completed').status === 'DISPUTING');

  // ---------- 5. 发起人取消 -> 恢复 ----------
  await expectThrow('非发起人不能取消', () => svc.cancelDispute({ id: 'cust1' }, d2.id), 403);
  await svc.cancelDispute({ id: 'eng1' }, d2.id);
  check('取消后订单恢复 COMPLETED', tables.orders.find((o) => o.id === 'order_completed').status === 'COMPLETED');
  check('纠纷状态变为 CANCELLED', tables.disputes.find((d) => d.id === d2.id).status === 'CANCELLED');

  // ---------- 6. 消息 ----------
  const msg = await svc.sendDisputeMessage('cust1', d1.id, { type: 'TEXT', content: '请提供成果文件' });
  check('当事人可发消息', msg && msg.msgId > 0);
  await expectThrow('已结束纠纷不能发言', () => svc.sendDisputeMessage('cust1', d2.id, { type: 'TEXT', content: 'hi' }), 409);

  // ---------- 7. 仲裁结案：FORCE_COMPLETE + 退款登记 ----------
  await svc.resolveDispute({ id: 'admin1' }, d1.id, {
    verdict: 'CUSTOMER_FAVOR', orderAction: 'FORCE_COMPLETE', note: '工程师未按期交付', refundAmountFen: 5000,
  });
  const resolved = tables.disputes.find((d) => d.id === d1.id);
  check('仲裁后纠纷 RESOLVED', resolved.status === 'RESOLVED');
  check('仲裁结论记录', resolved.verdict === 'CUSTOMER_FAVOR' && resolved.orderAction === 'FORCE_COMPLETE');
  check('退款诉求登记 PENDING', resolved.refundStatus === 'PENDING' && resolved.refundAmountFen === 5000);
  check('订单被强制完成', tables.orders.find((o) => o.id === 'order1').status === 'COMPLETED');

  await expectThrow('已结案纠纷不能再仲裁', () => svc.resolveDispute({ id: 'admin1' }, d1.id, {
    verdict: 'NONE', orderAction: 'KEEP',
  }), 409);

  // ---------- 8. 其他仲裁动作：REOPEN / CLOSE / KEEP ----------
  const d3 = await svc.createDispute({ id: 'cust1' }, {
    orderId: 'order1', reasonType: 'OTHER', description: '这是第三次纠纷的说明文字内容', fileIds: [],
  });
  await svc.resolveDispute({ id: 'admin1' }, d3.id, { verdict: 'ENGINEER_FAVOR', orderAction: 'REOPEN' });
  check('REOPEN 后订单回到 IN_PROGRESS', tables.orders.find((o) => o.id === 'order1').status === 'IN_PROGRESS');

  const d4 = await svc.createDispute({ id: 'cust1' }, {
    orderId: 'order1', reasonType: 'OTHER', description: '这是第四次纠纷的说明文字内容', fileIds: [],
  });
  await svc.resolveDispute({ id: 'admin1' }, d4.id, { verdict: 'PARTIAL', orderAction: 'CLOSE' });
  check('CLOSE 后订单关闭', tables.orders.find((o) => o.id === 'order1').status === 'CLOSED');

  const d5 = await svc.createDispute({ id: 'cust1' }, {
    orderId: 'order_completed', reasonType: 'OTHER', description: '这是第五次纠纷的说明文字内容', fileIds: [],
  });
  await svc.resolveDispute({ id: 'admin1' }, d5.id, { verdict: 'NONE', orderAction: 'KEEP' });
  check('KEEP 后订单恢复快照 COMPLETED', tables.orders.find((o) => o.id === 'order_completed').status === 'COMPLETED');

  // ---------- 9. 退款更新 ----------
  const upd = await svc.updateRefund({ id: 'admin1' }, d1.id, { refundStatus: 'PROCESSED', refundTransactionId: 'TXN123' });
  check('退款状态更新', upd.refundStatus === 'PROCESSED' && tables.disputes.find((d) => d.id === d1.id).refundTransactionId === 'TXN123');

  console.log(`\n========== 结果：${passed} 通过，${failed} 失败 ==========`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
