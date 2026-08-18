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
const crypto = require('node:crypto');
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

    `CREATE TABLE IF NOT EXISTS identity_verifications (
      userId          VARCHAR(32) PRIMARY KEY,
      realName        VARCHAR(60),
      phone           VARCHAR(20),
      idCardCipher    TEXT,
      idCardHash      CHAR(64) UNIQUE,
      verifyStatus    VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      reviewReason    VARCHAR(500),
      submittedAt     DATETIME(3),
      reviewedAt      DATETIME(3),
      reviewedBy      VARCHAR(32),
      updatedAt       DATETIME(3) NOT NULL,
      INDEX idx_identity_verify_status(verifyStatus, updatedAt),
      FOREIGN KEY(userId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id          VARCHAR(100) PRIMARY KEY,
      appliedAt   DATETIME(3) NOT NULL
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
      closedAt        DATETIME(3),
      closedByAdminId VARCHAR(32),
      adminCloseReason VARCHAR(500),
      viewCount       INT UNSIGNED NOT NULL DEFAULT 0,
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

    `CREATE TABLE IF NOT EXISTS order_views (
      orderId       VARCHAR(32) NOT NULL,
      userId        VARCHAR(32) NOT NULL,
      createdAt     DATETIME(3) NOT NULL,
      PRIMARY KEY(orderId, userId),
      INDEX idx_order_views_user(userId, createdAt),
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(userId) REFERENCES users(id)
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

    `CREATE TABLE IF NOT EXISTS order_attachments (
      orderId      VARCHAR(32) NOT NULL,
      fileId       VARCHAR(32) NOT NULL,
      uploaderId   VARCHAR(32) NOT NULL,
      purpose      VARCHAR(16) NOT NULL DEFAULT 'REQUIREMENT',
      createdAt    DATETIME(3) NOT NULL,
      PRIMARY KEY(orderId, fileId),
      UNIQUE KEY uq_order_attachment_file(fileId),
      INDEX idx_order_attachments_order_purpose(orderId, purpose, createdAt),
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id),
      FOREIGN KEY(uploaderId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS engineer_verification_files (
      engineerId  VARCHAR(32) NOT NULL,
      fileId      VARCHAR(32) NOT NULL,
      createdAt   DATETIME(3) NOT NULL,
      PRIMARY KEY(engineerId, fileId),
      UNIQUE KEY uq_engineer_verification_file(fileId),
      INDEX idx_engineer_verification_engineer(engineerId, createdAt),
      FOREIGN KEY(engineerId) REFERENCES users(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 客户查看“我的订单”的阅读位置。首页据此提示工程师报价、交付等新的订单变更；
    // 只记录最后阅读时间，不保存敏感通知内容。
    `CREATE TABLE IF NOT EXISTS customer_order_reads (
      customerId  VARCHAR(32) PRIMARY KEY,
      lastReadAt  DATETIME(3) NOT NULL,
      FOREIGN KEY(customerId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS identity_verification_files (
      userId      VARCHAR(32) NOT NULL,
      fileId      VARCHAR(32) NOT NULL,
      purpose     VARCHAR(16) NOT NULL DEFAULT 'SUPPORTING',
      createdAt   DATETIME(3) NOT NULL,
      PRIMARY KEY(userId, fileId),
      UNIQUE KEY uq_identity_verification_file(fileId),
      INDEX idx_identity_files_user_purpose(userId, purpose, createdAt),
      FOREIGN KEY(userId) REFERENCES users(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS engineer_reviews (
      id              VARCHAR(32) PRIMARY KEY,
      orderId         VARCHAR(32) NOT NULL,
      customerId      VARCHAR(32) NOT NULL,
      engineerId      VARCHAR(32) NOT NULL,
      qualityScore    TINYINT UNSIGNED NOT NULL,
      attitudeScore   TINYINT UNSIGNED NOT NULL,
      speedScore      TINYINT UNSIGNED NOT NULL,
      professionalScore TINYINT UNSIGNED,
      communicationScore TINYINT UNSIGNED,
      content         VARCHAR(100),
      revisionCount   TINYINT UNSIGNED NOT NULL DEFAULT 0,
      createdAt       DATETIME(3) NOT NULL,
      updatedAt       DATETIME(3) NOT NULL,
      revisedAt       DATETIME(3),
      UNIQUE KEY uq_engineer_review_order(orderId),
      INDEX idx_engineer_reviews_engineer(engineerId, createdAt),
      INDEX idx_engineer_reviews_customer(customerId, createdAt),
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(customerId) REFERENCES users(id),
      FOREIGN KEY(engineerId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS conversations (
      id          VARCHAR(32) PRIMARY KEY,
      orderId     VARCHAR(32) NOT NULL,
      customerId  VARCHAR(32) NOT NULL,
      engineerId  VARCHAR(32) NOT NULL,
      lastMsgAt   DATETIME(3) NOT NULL,
      createdAt   DATETIME(3) NOT NULL,
      UNIQUE KEY uq_conversations_order_engineer(orderId, engineerId),
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

    // 发票记录申请、处理状态及电子发票文件关系；不保存第三方开票/支付凭据。
    `CREATE TABLE IF NOT EXISTS invoice_requests (
      id                VARCHAR(32) PRIMARY KEY,
      orderId           VARCHAR(32) NOT NULL,
      customerId        VARCHAR(32) NOT NULL,
      engineerId        VARCHAR(32) NOT NULL,
      invoiceTitle      VARCHAR(120) NOT NULL,
      taxNumber         VARCHAR(50),
      email             VARCHAR(120),
      customerNote      VARCHAR(500),
      engineerNote      VARCHAR(500),
      status            VARCHAR(24) NOT NULL DEFAULT 'REQUESTED',
      handlingMode      VARCHAR(24),
      platformFeeFen    BIGINT,
      requestedAt       DATETIME(3) NOT NULL,
      handledAt         DATETIME(3),
      createdAt         DATETIME(3) NOT NULL,
      updatedAt         DATETIME(3) NOT NULL,
      UNIQUE KEY uq_invoice_request_order(orderId),
      INDEX idx_invoice_engineer_status(engineerId, status, updatedAt),
      INDEX idx_invoice_customer_status(customerId, status, updatedAt),
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(customerId) REFERENCES users(id),
      FOREIGN KEY(engineerId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS invoice_request_files (
      invoiceRequestId VARCHAR(32) NOT NULL,
      fileId           VARCHAR(32) NOT NULL,
      uploaderId       VARCHAR(32) NOT NULL,
      createdAt        DATETIME(3) NOT NULL,
      PRIMARY KEY(invoiceRequestId, fileId),
      UNIQUE KEY uq_invoice_request_files_file(fileId),
      INDEX idx_invoice_request_files_request(invoiceRequestId, createdAt),
      FOREIGN KEY(invoiceRequestId) REFERENCES invoice_requests(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id),
      FOREIGN KEY(uploaderId) REFERENCES users(id)
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

    `CREATE TABLE IF NOT EXISTS auth_rate_limits (
      action          VARCHAR(40) NOT NULL,
      subjectHash     CHAR(64) NOT NULL,
      windowStartedAt DATETIME(3) NOT NULL,
      attemptCount    INT UNSIGNED NOT NULL DEFAULT 0,
      updatedAt       DATETIME(3) NOT NULL,
      PRIMARY KEY(action, subjectHash),
      INDEX idx_auth_rate_updated(updatedAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS admin_accounts (
      id            VARCHAR(32) PRIMARY KEY,
      userId        VARCHAR(32) NOT NULL,
      openid        VARCHAR(64),
      adminRole     VARCHAR(32) NOT NULL,
      status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      displayName   VARCHAR(100),
      createdAt     DATETIME(3) NOT NULL,
      updatedAt     DATETIME(3) NOT NULL,
      lastLoginAt   DATETIME(3),
      UNIQUE KEY uq_admin_user(userId),
      UNIQUE KEY uq_admin_openid(openid),
      INDEX idx_admin_status_role(status, adminRole),
      FOREIGN KEY(userId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      adminId       VARCHAR(32) NOT NULL,
      action        VARCHAR(64) NOT NULL,
      targetType    VARCHAR(32) NOT NULL,
      targetId      VARCHAR(64),
      detail        JSON,
      requestId     VARCHAR(128),
      createdAt     DATETIME(3) NOT NULL,
      INDEX idx_admin_audit_time(createdAt),
      INDEX idx_admin_audit_actor(adminId, createdAt),
      INDEX idx_admin_audit_target(targetType, targetId, createdAt),
      FOREIGN KEY(adminId) REFERENCES admin_accounts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS disputes (
      id                  VARCHAR(32) PRIMARY KEY,
      orderId             VARCHAR(32) NOT NULL,
      initiatorId         VARCHAR(32) NOT NULL,
      reasonType          VARCHAR(20) NOT NULL,
      description         TEXT NOT NULL,
      status              VARCHAR(16) NOT NULL DEFAULT 'OPEN',
      orderStatusAtOpen   VARCHAR(24) NOT NULL,
      evidenceDeadlineAt  DATETIME(3),
      refundAmountFen     BIGINT,
      refundStatus        VARCHAR(16) NOT NULL DEFAULT 'NONE',
      refundTransactionId VARCHAR(64),
      verdict             VARCHAR(20) NOT NULL DEFAULT 'NONE',
      orderAction         VARCHAR(20) NOT NULL DEFAULT 'KEEP',
      resolutionNote      TEXT,
      resolvedBy          VARCHAR(32),
      resolvedAt          DATETIME(3),
      createdAt           DATETIME(3) NOT NULL,
      updatedAt           DATETIME(3) NOT NULL,
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(initiatorId) REFERENCES users(id),
      INDEX idx_disputes_order_status(orderId, status),
      INDEX idx_disputes_initiator(initiatorId, status),
      INDEX idx_disputes_status(status, createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 客户退款申请：同意后订单仅标记取消，真实资金退款留待支付通道接入。
    `CREATE TABLE IF NOT EXISTS refund_requests (
      id          VARCHAR(32) PRIMARY KEY,
      orderId     VARCHAR(32) NOT NULL,
      customerId  VARCHAR(32) NOT NULL,
      engineerId  VARCHAR(32) NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      orderStatusAtRequest VARCHAR(24) NOT NULL,
      reason      TEXT NOT NULL,
      disputeId   VARCHAR(32),
      createdAt   DATETIME(3) NOT NULL,
      respondedAt DATETIME(3),
      updatedAt   DATETIME(3) NOT NULL,
      INDEX idx_refund_requests_engineer_status(engineerId, status, createdAt),
      INDEX idx_refund_requests_order_status(orderId, status, createdAt),
      FOREIGN KEY(orderId) REFERENCES orders(id),
      FOREIGN KEY(customerId) REFERENCES users(id),
      FOREIGN KEY(engineerId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS refund_request_files (
      refundRequestId VARCHAR(32) NOT NULL,
      fileId          VARCHAR(32) NOT NULL,
      uploaderId      VARCHAR(32) NOT NULL,
      createdAt       DATETIME(3) NOT NULL,
      PRIMARY KEY(refundRequestId, fileId),
      UNIQUE KEY uq_refund_request_files_file(fileId),
      INDEX idx_refund_request_files_request(refundRequestId, createdAt),
      FOREIGN KEY(refundRequestId) REFERENCES refund_requests(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id),
      FOREIGN KEY(uploaderId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS dispute_evidence (
      disputeId   VARCHAR(32) NOT NULL,
      fileId      VARCHAR(32) NOT NULL,
      uploaderId  VARCHAR(32) NOT NULL,
      createdAt   DATETIME(3) NOT NULL,
      PRIMARY KEY(disputeId, fileId),
      INDEX idx_dispute_evidence_dispute(disputeId, createdAt),
      FOREIGN KEY(disputeId) REFERENCES disputes(id),
      FOREIGN KEY(fileId) REFERENCES uploaded_files(id),
      FOREIGN KEY(uploaderId) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS dispute_messages (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      disputeId   VARCHAR(32) NOT NULL,
      senderId    VARCHAR(64) NOT NULL,
      type        VARCHAR(16) NOT NULL DEFAULT 'TEXT',
      content     TEXT,
      fileId      VARCHAR(32),
      createdAt   DATETIME(3) NOT NULL,
      FOREIGN KEY(disputeId) REFERENCES disputes(id),
      INDEX idx_dispute_messages(disputeId, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of sqls) {
    await query(sql);
  }

  // 限流键是哈希值且无需永久保留，定期清理过期窗口，避免表无限增长。
  await query(
    `DELETE FROM auth_rate_limits
      WHERE updatedAt < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)`
  );

  // 增量迁移：为旧表补充新字段（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
  const migrations = [
    // users 表补充字段
    { table: 'users', sql: `ALTER TABLE users ADD COLUMN username VARCHAR(20) UNIQUE`, check: "username" },
    { table: 'users', sql: `ALTER TABLE users ADD COLUMN passwordHash VARCHAR(255)`, check: "passwordHash" },
    { table: 'users', sql: `ALTER TABLE users ADD COLUMN sessionToken VARCHAR(64)`, check: "sessionToken" },
    { table: 'users', sql: `ALTER TABLE users ADD COLUMN sessionExpiresAt DATETIME(3)`, check: "sessionExpiresAt" },
    { table: 'orders', sql: `ALTER TABLE orders ADD COLUMN viewCount INT UNSIGNED NOT NULL DEFAULT 0`, check: "viewCount" },
    { table: 'orders', sql: `ALTER TABLE orders ADD COLUMN closedAt DATETIME(3)`, check: "closedAt" },
    { table: 'orders', sql: `ALTER TABLE orders ADD COLUMN closedByAdminId VARCHAR(32)`, check: "closedByAdminId" },
    { table: 'orders', sql: `ALTER TABLE orders ADD COLUMN adminCloseReason VARCHAR(500)`, check: "adminCloseReason" },
    { table: 'engineer_profiles', sql: `ALTER TABLE engineer_profiles ADD COLUMN reviewReason VARCHAR(500)`, check: "reviewReason" },
    { table: 'engineer_profiles', sql: `ALTER TABLE engineer_profiles ADD COLUMN reviewedAt DATETIME(3)`, check: "reviewedAt" },
    { table: 'engineer_profiles', sql: `ALTER TABLE engineer_profiles ADD COLUMN reviewedBy VARCHAR(32)`, check: "reviewedBy" },
    { table: 'refund_requests', sql: `ALTER TABLE refund_requests ADD COLUMN orderStatusAtRequest VARCHAR(24)`, check: "orderStatusAtRequest" },
    { table: 'refund_requests', sql: `ALTER TABLE refund_requests ADD COLUMN reason TEXT`, check: "reason" },
    { table: 'disputes', sql: `ALTER TABLE disputes ADD COLUMN evidenceDeadlineAt DATETIME(3)`, check: "evidenceDeadlineAt" },
    // 评价从三项扩展至五项。旧评价保留为空，读取时以旧三项均分回填，避免历史评分被不公平拉低。
    { table: 'engineer_reviews', sql: `ALTER TABLE engineer_reviews ADD COLUMN professionalScore TINYINT UNSIGNED`, check: "professionalScore" },
    { table: 'engineer_reviews', sql: `ALTER TABLE engineer_reviews ADD COLUMN communicationScore TINYINT UNSIGNED`, check: "communicationScore" },
  ];

  for (const m of migrations) {
    try {
      // 检查列是否已存在
      const cols = await query(`SHOW COLUMNS FROM ${m.table} LIKE '${m.check}'`);
      if (!cols || cols.length === 0) {
        await query(m.sql);
        console.log(`[migrate] Added column ${m.check} to ${m.table}`);
      }
    } catch (e) {
      // Concurrent replicas may race on the same ALTER. Ignore only the
      // duplicate-column condition; all other migration failures must stop
      // startup so a partially upgraded schema is never served silently.
      if (e.code !== 'ER_DUP_FIELDNAME' && e.code !== 'ER_DUP_KEYNAME') throw e;
    }
  }

  // 报价阶段允许客户分别与多位报价工程师沟通。旧结构将 orderId 设为唯一，
  // 这里保留已有会话数据，仅把唯一约束升级为 (orderId, engineerId)。
  // 使用 MySQL 命名锁避免多个云托管实例同时执行索引 DDL。
  const conversationLockName = 'simu_conversation_pair_v1';
  const migrationConn = await getPool().getConnection();
  let conversationLockAcquired = false;
  try {
    const [[conversationLock]] = await migrationConn.execute(
      `SELECT GET_LOCK(?, 30) AS acquired`, [conversationLockName]
    );
    if (Number(conversationLock?.acquired) !== 1) {
      throw new Error('获取会话结构迁移锁失败');
    }
    conversationLockAcquired = true;
    const migrationId = '20260819_conversation_order_engineer_v1';
    const [[applied]] = await migrationConn.execute(
      `SELECT id FROM schema_migrations WHERE id=?`, [migrationId]
    );
    if (!applied) {
      const [indexRows] = await migrationConn.execute(`SHOW INDEX FROM conversations`);
      const indexes = new Map();
      for (const row of indexRows) {
        if (!indexes.has(row.Key_name)) indexes.set(row.Key_name, []);
        indexes.get(row.Key_name).push(row);
      }
      const hasPairUnique = [...indexes.values()].some((rows) => {
        const ordered = rows.slice().sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
        return Number(ordered[0]?.Non_unique) === 0
          && ordered.map((row) => row.Column_name).join(',') === 'orderId,engineerId';
      });
      if (!hasPairUnique) {
        const legacyUnique = [...indexes.entries()].find(([, rows]) => {
          const ordered = rows.slice().sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
          return Number(ordered[0]?.Non_unique) === 0
            && ordered.map((row) => row.Column_name).join(',') === 'orderId';
        });
        const dropLegacy = legacyUnique
          ? `DROP INDEX \`${String(legacyUnique[0]).replace(/`/g, '``')}\`, `
          : '';
        await migrationConn.execute(
          `ALTER TABLE conversations ${dropLegacy}`
          + `ADD UNIQUE KEY uq_conversations_order_engineer(orderId, engineerId)`
        );
      }
      await migrationConn.execute(
        `INSERT IGNORE INTO schema_migrations(id, appliedAt) VALUES(?, UTC_TIMESTAMP(3))`,
        [migrationId]
      );
    }
  } finally {
    try {
      if (conversationLockAcquired) {
        await migrationConn.execute(`SELECT RELEASE_LOCK(?)`, [conversationLockName]);
      }
    } finally {
      migrationConn.release();
    }
  }

  // 一次性迁移：升级前已有客户默认通过；工程师严格保留原审核状态。
  // 新注册用户不会命中该迁移，首次认证记录默认为 PENDING。
  const identityMigration = await queryOne(
    `SELECT id FROM schema_migrations WHERE id='20260813_identity_verification_v1'`);
  if (!identityMigration) {
    await tx(async (conn) => {
      await conn.execute(
        `INSERT IGNORE INTO identity_verifications
          (userId, realName, phone, verifyStatus, reviewReason, reviewedAt, reviewedBy, updatedAt)
         SELECT u.id, ep.realName, u.phone,
                CASE WHEN u.role='ENGINEER' THEN COALESCE(ep.verifyStatus, 'PENDING') ELSE 'APPROVED' END,
                ep.reviewReason, ep.reviewedAt, ep.reviewedBy, UTC_TIMESTAMP(3)
           FROM users u LEFT JOIN engineer_profiles ep ON ep.userId=u.id
          WHERE u.deletedAt IS NULL`
      );
      await conn.execute(
        `INSERT IGNORE INTO identity_verification_files(userId, fileId, purpose, createdAt)
         SELECT engineerId, fileId, 'SUPPORTING', createdAt FROM engineer_verification_files`
      );
      await conn.execute(
        `INSERT IGNORE INTO schema_migrations(id, appliedAt)
         VALUES('20260813_identity_verification_v1', UTC_TIMESTAMP(3))`
      );
    });
  }

  // 兼容上一版本已经提交但尚未处理的退款申请：记录原状态并冻结订单。
  await query(
    `UPDATE refund_requests rr
       JOIN orders o ON o.id = rr.orderId
        SET rr.orderStatusAtRequest = COALESCE(rr.orderStatusAtRequest, o.status),
            o.status = 'REFUND_PENDING',
            o.updatedAt = UTC_TIMESTAMP(3)
      WHERE rr.status = 'PENDING'
        AND o.status IN ('IN_PROGRESS', 'DELIVERED', 'COMPLETED')`
  );

  // 升级前的退款申请没有理由字段，补齐可读的历史占位，之后的新申请由接口强制填写。
  await query(
    `UPDATE refund_requests
        SET reason = '历史退款申请未填写理由'
      WHERE reason IS NULL OR TRIM(reason) = ''`
  );

  // 老纠纷按发起时间补齐 48 小时举证截止时间。
  await query(
    `UPDATE disputes
        SET evidenceDeadlineAt = DATE_ADD(createdAt, INTERVAL 48 HOUR)
      WHERE evidenceDeadlineAt IS NULL`
  );

  // 为升级前已经通过 uploaded_files.orderId 关联的文件补齐关系表。
  // INSERT IGNORE 使多实例并发启动和重复启动都保持幂等。
  await query(
    `INSERT IGNORE INTO order_attachments(orderId, fileId, uploaderId, purpose, createdAt)
     SELECT orderId, id, uploaderId,
            CASE
              WHEN EXISTS(SELECT 1 FROM messages m WHERE m.fileId = uploaded_files.id) THEN 'CHAT'
              WHEN kind = 'RESULT' THEN 'RESULT'
              ELSE 'REQUIREMENT'
            END,
            createdAt
       FROM uploaded_files
      WHERE orderId IS NOT NULL`
  );

  console.log(JSON.stringify({ t: new Date().toISOString(), evt: 'db-init-ok' }));
}

/** 订单编号：SIM + yyyymmdd + 4位序号 */
async function nextOrderNo() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const prefix = `SIM${ymd}`;
  // COUNT+1 is racy under concurrent order creation. A random suffix keeps
  // the human-readable date prefix while the UNIQUE index remains the final
  // collision guard.
  for (let i = 0; i < 5; i += 1) {
    const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
    const candidate = `${prefix}${suffix}`;
    const exists = await queryOne(`SELECT id FROM orders WHERE orderNo = ?`, [candidate]);
    if (!exists) return candidate;
  }
  throw new Error('无法生成唯一订单号');
}

const parseJson = (s, dft = []) => {
  if (!s) return dft;
  if (typeof s !== 'string') return s; // mysql2 有时已自动解析 JSON 字段
  try { return JSON.parse(s); } catch { return dft; }
};

module.exports = { query, queryOne, tx, init, nextOrderNo, parseJson };
