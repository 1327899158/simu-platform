'use strict';
/**
 * 云函数：auto-complete-orders
 * 触发方式：定时触发器，每天凌晨 2:00 执行
 * （cron: 0 0 2 * * * *）
 *
 * 功能：DELIVERED 超过 7 天未客户确认 → 自动转 COMPLETED。
 */
const mysql = require('mysql2/promise');

exports.main = async (event, context) => {
  const mysqlAddr = process.env.MYSQL_ADDRESS || '127.0.0.1:3306';
  const [host, portStr] = mysqlAddr.split(':');
  const pool = mysql.createPool({
    host, port: parseInt(portStr || '3306', 10),
    user: process.env.MYSQL_USERNAME || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'simu',
    charset: 'utf8mb4', connectionLimit: 3,
  });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
    .toISOString().slice(0, 23).replace('T', ' ');
  const nowStr = now.toISOString();

  try {
    const [rows] = await pool.execute(
      `SELECT id FROM orders WHERE status = 'DELIVERED' AND deliveredAt < ?`, [sevenDaysAgo]);
    let count = 0;
    for (const r of rows) {
      const [upd] = await pool.execute(
        `UPDATE orders SET status='COMPLETED', completedAt=?, updatedAt=?
         WHERE id=? AND status='DELIVERED'`,
        [nowStr, nowStr, r.id]);
      if (upd.affectedRows) {
        // 发系统消息（简化：直接写 MySQL）
        const [conv] = await pool.execute(`SELECT id FROM conversations WHERE orderId=?`, [r.id]);
        if (conv[0]) {
          await pool.execute(
            `INSERT INTO messages(convId, senderId, type, content, createdAt)
             VALUES(?,?,?,?,?)`,
            [conv[0].id, 'SYSTEM', 'SYSTEM',
             '系统已于交付 7 天后自动确认验收，订单完成。', nowStr]);
          await pool.execute(`UPDATE conversations SET lastMsgAt=? WHERE id=?`, [nowStr, conv[0].id]);
        }
        count++;
      }
    }
    console.log(`[auto-complete-orders] completed ${count} orders`);
    return { success: true, completed: count };
  } finally {
    await pool.end();
  }
};
