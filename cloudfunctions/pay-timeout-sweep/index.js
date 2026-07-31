'use strict';
/**
 * 云函数：pay-timeout-sweep
 * 触发方式：定时触发器，每 2 分钟执行一次
 * （在云开发控制台 → 云函数 → pay-timeout-sweep → 触发器，按“每 2 分钟”配置）
 *
 * 功能：扫描超时未支付（AWAITING_PAYMENT 且 selectedAt 超过 30 分钟）的订单，
 *       回退状态为 QUOTING，释放选标，报价恢复 PENDING。
 *
 * 也可以调用云托管服务（HTTP 请求），或直接连同一 MySQL 实例。
 * 这里直接连 MySQL（云函数与云托管同 VPC，可用相同环境变量）。
 */
const mysql = require('mysql2/promise');

const PAY_TIMEOUT_SEC = parseInt(process.env.PAY_TIMEOUT_SEC || '1800', 10);

exports.main = async (event, context) => {
  const mysqlAddr = process.env.MYSQL_ADDRESS || '127.0.0.1:3306';
  const [host, portStr] = mysqlAddr.split(':');
  const pool = mysql.createPool({
    host: host || '127.0.0.1',
    port: parseInt(portStr || '3306', 10),
    user: process.env.MYSQL_USERNAME || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'simu',
    charset: 'utf8mb4',
    connectionLimit: 3,
  });

  const now = new Date();
  const deadline = new Date(now.getTime() - PAY_TIMEOUT_SEC * 1000)
    .toISOString().slice(0, 23).replace('T', ' ');

  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    try {
      const [rows] = await conn.execute(
        `SELECT id, selectedQuoteId FROM orders
         WHERE status = 'AWAITING_PAYMENT' AND selectedAt < ?`,
        [deadline]
      );

      let count = 0;
      for (const o of rows) {
        const [r] = await conn.execute(
          `UPDATE orders SET status='QUOTING', selectedQuoteId=NULL,
             finalAmountFen=NULL, selectedAt=NULL, updatedAt=?
           WHERE id=? AND status='AWAITING_PAYMENT'`,
          [now.toISOString(), o.id]
        );
        if (!r.affectedRows) continue;
        await conn.execute(
          `UPDATE quotes SET status='PENDING', updatedAt=?
           WHERE orderId=? AND status IN ('SELECTED','REJECTED')`,
          [now.toISOString(), o.id]
        );
        await conn.execute(
          `UPDATE payments SET status='FAILED' WHERE orderId=? AND status='PENDING'`,
          [o.id]
        );
        count++;
      }
      await conn.commit();
      conn.release();
      console.log(`[pay-timeout-sweep] reverted ${count} orders`);
      return { success: true, reverted: count };
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } finally {
    await pool.end();
  }
};
