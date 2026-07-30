'use strict';
/**
 * 数据库访问层：MySQL（通过 mysql2/promise，连接云托管注入的 MySQL）。
 * 迁移自 SQLite；表结构与 prisma/schema.prisma 一一对应。
 *
 * 导出：
 *   query(sql, params) → 单次查询
 *   queryOne(sql, params) → 第一行或 null
 *   tx(fn) → 事务包装
 *   nextOrderNo() → 订单编号
 *   parseJson(s, dft) → 安全解析 JSON
 *   init() → 建表/迁移（启动时调用一次）
 */
const mysql = require('mysql2/promise');
const { config } = require('./config');

let _pool = null;

function getPool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      charset: 'utf8mb4',
      timezone: '+00:00',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return _pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return (rows && rows.length) ? rows[0] : null;
}

/**
 * 事务包装：fn(conn) 内部通过 conn.execute() 操作，抛错自动 ROLLBACK。
 * 使用方式：
 *   const result = await tx(async (c) => {
 *     await c.execute('UPDATE ...', [...]);
 *     return await c.execute('SELECT ...', [...]);
 *   });
 */
async function tx(fn) {
  const conn = await getPool().getConnection();
  await conn.beginTransaction();
  try {
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 幂等建表 / 迁移（启动时跑一次） */
async function init() {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS users (
      id              VARCHAR(32) PRIMARY KEY,
      role            VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
      openid          VARCHAR(64) UNIQUE,
      unionid         VARCHAR(64),
      username        VARCHAR(20) UNIQUE,
      phone           VARCHAR(20) UNIQUE,
      passwordHash    VARCHAR(255),
      nickname        VARCHAR(60),
      avatarUrl       VARCHAR(512),
      status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      createdAt       DATETIME(3) NOT NULL,
      updatedAt       DATETIME(3) NOT NULL,
      deletedAt       DATETIME(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS engineer_profiles (
      userId        VARCHAR(32) PRIMARY KEY,
      realName      VARCHAR(60),
      specialties   JSON NOT NULL,
      softwares     JSON NOT NULL,
      intro         TEXT,
      verifyStatus  VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      FOREIGN KEY(userId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS orders (
      id              VARCHAR(32) PRIMARY KEY,
      orderNo         VARCHAR(24) NOT NULL UNIQUE,
      customerId      VARCHAR(32) NOT NULL,
      projectName     VARCHAR(120) NOT NULL,
      description     TEXT NOT NULL,
      softwareTags    JSON NOT NULL,
      directionTags   JSON NOT NULL,
      budgetFen       BIGINT,
      budgetFlexible  TINYINT(1) NOT NULL DEFAULT 1,
      deliveryDays    INT NOT NULL,
      specialNote     TEXT,
      status          VARCHAR(24) NOT NULL DEFAULT 'QUOTING',
      selectedQuoteId VARCHAR(32) UNIQUE,
      finalAmountFen  BIGINT,
      selectedAt      DATETIME(3),
      paidAt          DATETIME(3),
      deliveredAt     DATETIME(3),
      completedAt     DATETIME(3),
      createdAt       DATETIME(3) NOT NULL,
      updatedAt       DATETIME(3) NOT NULL,
      deletedAt       DATETIME(3),
      FOREIGN KEY(customerId) REFERENCES users(id),
      INDEX idx_orders_status(status, createdAt),
      INDEX idx_orders_customer(customerId, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS quotes (
      id          VARCHAR(32) PRIMARY KEY,
      orderId     VARCHAR(32) NOT NULL,
      engineerId  VARCHAR(32) NOT NULL,
      amountFen   BIGINT NOT NULL,
      days        INT NOT NULL,
      solution    TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      createdAt   DATETIME(3) NOT NULL,
      updatedAt   DATETIME(3) NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(engineerId) REFERENCES users(id),
      UNIQUE KEY uq_order_engineer(orderId, engineerId),
      INDEX idx_quotes_engineer(engineerId, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS uploaded_files (
      id          VARCHAR(32) PRIMARY KEY,
      orderId     VARCHAR(32),
      uploaderId  VARCHAR(32) NOT NULL,
      kind        VARCHAR(16) NOT NULL DEFAULT 'DOC',
      name        VARCHAR(256) NOT NULL,
      fileID      VARCHAR(512) NOT NULL UNIQUE,
      sizeBytes   BIGINT NOT NULL,
      mime        VARCHAR(128),
      createdAt   DATETIME(3) NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id),
      INDEX idx_files_order(orderId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS conversations (
      id          VARCHAR(32) PRIMARY KEY,
      orderId     VARCHAR(32) NOT NULL UNIQUE,
      customerId  VARCHAR(32) NOT NULL,
      engineerId  VARCHAR(32) NOT NULL,
      lastMsgAt   DATETIME(3) NOT NULL,
      createdAt   DATETIME(3) NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS messages (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      convId      VARCHAR(32) NOT NULL,
      senderId    VARCHAR(64) NOT NULL,
      type        VARCHAR(16) NOT NULL DEFAULT 'TEXT',
      content     TEXT,
      fileId      VARCHAR(32),
      readAt      DATETIME(3),
      createdAt   DATETIME(3) NOT NULL,
      FOREIGN KEY(convId) REFERENCES conversations(id),
      INDEX idx_messages_conv(convId, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS payments (
      id            VARCHAR(32) PRIMARY KEY,
      orderId       VARCHAR(32) NOT NULL,
      outTradeNo    VARCHAR(64) NOT NULL UNIQUE,
      transactionId VARCHAR(64) UNIQUE,
      amountFen     BIGINT NOT NULL,
      status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      paidAt        DATETIME(3),
      raw           JSON,
      createdAt     DATETIME(3) NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id),
      INDEX idx_payments_order(orderId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS sms_codes (
      id        VARCHAR(32) PRIMARY KEY,
      phone     VARCHAR(20) NOT NULL,
      code      VARCHAR(6) NOT NULL,
      type      VARCHAR(16) NOT NULL DEFAULT 'LOGIN',
      expiresAt DATETIME(3) NOT NULL,
      usedAt    DATETIME(3),
      createdAt DATETIME(3) NOT NULL,
      INDEX idx_sms_phone_type(phone, type, usedAt),
      INDEX idx_sms_expires(expiresAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of sqls) {
    await query(sql);
  }
  console.log(JSON.stringify({ t: new Date().toISOString(), evt: 'db-init-ok' }));
}

/** 订单编号：SIM + yyyymmdd + 4位序号 */
async function nextOrderNo() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const prefix = `SIM${ymd}`;
  const row = await queryOne(`SELECT COUNT(*) AS c FROM orders WHERE orderNo LIKE ?`, [`${prefix}%`]);
  return `${prefix}${String(((row?.c) || 0) + 1).padStart(4, '0')}`;
}

const parseJson = (s, dft = []) => {
  if (!s) return dft;
  if (typeof s !== 'string') return s; // mysql2 有时已自动解析 JSON 字段
  try { return JSON.parse(s); } catch { return dft; }
};

module.exports = { query, queryOne, tx, init, nextOrderNo, parseJson };
