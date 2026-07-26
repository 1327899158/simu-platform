'use strict';
/**
 * SQLite（node:sqlite 内置模块）数据访问层。
 * 表结构与 prisma/schema.prisma（生产版 MySQL 蓝图）字段一一对应；
 * 迁移到 NestJS+Prisma 时只需替换本文件的查询实现。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  role      TEXT NOT NULL DEFAULT 'CUSTOMER',      -- CUSTOMER | ENGINEER | ADMIN
  openid    TEXT UNIQUE,
  nickname  TEXT,
  avatarUrl TEXT,
  phone     TEXT UNIQUE,
  status    TEXT NOT NULL DEFAULT 'ACTIVE',        -- ACTIVE | BANNED | DELETED
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  deletedAt TEXT
);
CREATE TABLE IF NOT EXISTS engineer_profiles (
  userId       TEXT PRIMARY KEY REFERENCES users(id),
  realName     TEXT,
  specialties  TEXT NOT NULL DEFAULT '[]',         -- JSON 数组
  softwares    TEXT NOT NULL DEFAULT '[]',         -- JSON 数组
  intro        TEXT,
  verifyStatus TEXT NOT NULL DEFAULT 'PENDING'     -- PENDING | APPROVED | REJECTED
);
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  orderNo        TEXT NOT NULL UNIQUE,
  customerId     TEXT NOT NULL REFERENCES users(id),
  projectName    TEXT NOT NULL,
  description    TEXT NOT NULL,
  softwareTags   TEXT NOT NULL DEFAULT '[]',
  directionTags  TEXT NOT NULL DEFAULT '[]',
  budgetFen      INTEGER,
  budgetFlexible INTEGER NOT NULL DEFAULT 1,
  deliveryDays   INTEGER NOT NULL,
  specialNote    TEXT,
  status         TEXT NOT NULL DEFAULT 'QUOTING',
  -- QUOTING | AWAITING_PAYMENT | IN_PROGRESS | DELIVERED | COMPLETED | CLOSED
  selectedQuoteId TEXT UNIQUE,
  finalAmountFen  INTEGER,
  selectedAt     TEXT,
  paidAt         TEXT,
  deliveredAt    TEXT,
  completedAt    TEXT,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  deletedAt      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, createdAt);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customerId, status);
CREATE TABLE IF NOT EXISTS quotes (
  id         TEXT PRIMARY KEY,
  orderId    TEXT NOT NULL REFERENCES orders(id),
  engineerId TEXT NOT NULL REFERENCES users(id),
  amountFen  INTEGER NOT NULL,
  days       INTEGER NOT NULL,
  solution   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | SELECTED | REJECTED | WITHDRAWN
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  UNIQUE(orderId, engineerId)
);
CREATE INDEX IF NOT EXISTS idx_quotes_engineer ON quotes(engineerId, status);
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  orderId    TEXT,
  uploaderId TEXT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL DEFAULT 'DOC',          -- MODEL | DOC | IMAGE | RESULT
  name       TEXT NOT NULL,
  storePath  TEXT NOT NULL,
  sizeBytes  INTEGER NOT NULL,
  mime       TEXT,
  createdAt  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_order ON files(orderId);
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  orderId    TEXT NOT NULL UNIQUE REFERENCES orders(id),
  customerId TEXT NOT NULL,
  engineerId TEXT NOT NULL,
  lastMsgAt  TEXT NOT NULL,
  createdAt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,     -- 数字自增，天然支持 after 游标
  convId    TEXT NOT NULL REFERENCES conversations(id),
  senderId  TEXT NOT NULL,                          -- SYSTEM 消息为 'SYSTEM'
  type      TEXT NOT NULL DEFAULT 'TEXT',           -- TEXT | IMAGE | FILE | SYSTEM
  content   TEXT,
  fileId    TEXT,
  readAt    TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(convId, id);
CREATE TABLE IF NOT EXISTS payments (
  id            TEXT PRIMARY KEY,
  orderId       TEXT NOT NULL REFERENCES orders(id),
  outTradeNo    TEXT NOT NULL UNIQUE,
  transactionId TEXT UNIQUE,
  amountFen     INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | SUCCESS | FAILED | REFUNDED
  paidAt        TEXT,
  raw           TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(orderId);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token     TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES users(id),
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
`);

/** 事务包装：fn 内抛错即回滚。node:sqlite 为同步 API。 */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = {
  one: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

/** 订单编号：SIM + yyyymmdd + 4位当日序号 */
function nextOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = q.one(`SELECT COUNT(*) AS c FROM orders WHERE orderNo LIKE ?`, `SIM${ymd}%`);
  return `SIM${ymd}${String((row?.c || 0) + 1).padStart(4, '0')}`;
}

const parseJson = (s, dft = []) => {
  try { return s ? JSON.parse(s) : dft; } catch { return dft; }
};

module.exports = { db, q, tx, nextOrderNo, parseJson };
