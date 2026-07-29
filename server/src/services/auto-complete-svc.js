'use strict';
/**
 * 自动完成订单：DELIVERED 状态超过 7 天无客户确认 → 自动转 COMPLETED。
 * 由 main.js 在启动时调用 startAutoComplete()，每天凌晨 2 点执行一次。
 */
const { nowIso } = require('../lib/util');
const { q } = require('../db');
const { systemMessageForOrder } = require('./chat-svc');

let _timer = null;

function run() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = q.all(
      `SELECT id FROM orders
       WHERE status = 'DELIVERED' AND deliveredAt < ? AND completedAt IS NULL`,
      sevenDaysAgo
    );
    let count = 0;
    for (const r of rows) {
      q.run(
        `UPDATE orders SET status = 'COMPLETED', completedAt = ?, updatedAt = ? WHERE id = ?`,
        nowIso(), nowIso(), r.id
      );
      systemMessageForOrder(r.id, '系统已于交付 7 天后自动确认验收，订单完成。');
      count++;
    }
    if (count > 0) console.log(`[auto-complete] ${count} 个订单自动完成`);
  } catch (e) {
    console.error('[auto-complete] 错误:', e.message);
  }
}

function startAutoComplete() {
  // 计算距离下次凌晨 2 点的延迟（毫秒）
  const now = new Date();
  let next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // 如果已过凌晨 2 点，改为明天凌晨 2 点
  const msUntilNext = next.getTime() - now.getTime();

  // 第一次延迟执行
  setTimeout(() => {
    run(); // 立刻执行一次
    // 后续每 24 小时执行一次
    _timer = setInterval(run, 24 * 60 * 60 * 1000);
    console.log('[auto-complete] 已启动，下次执行时间:', next.toISOString());
  }, msUntilNext);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { run, startAutoComplete, stop };

