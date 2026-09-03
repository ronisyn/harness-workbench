// server/db.js - MySQL 连接池 + 建表
import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.pass,
  database: config.db.name,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

export const db = {
  async query(sql, params) {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  async run(sql, params) {
    const [r] = await pool.execute(sql, params);
    return r;
  },
};

// 建表（幂等）
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    pass_hash VARCHAR(128) NOT NULL,
    role VARCHAR(16) DEFAULT 'user',
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY,
    account_id INT NOT NULL,
    created_at DATETIME DEFAULT NOW(),
    expires_at DATETIME NOT NULL,
    INDEX idx_sess_account (account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    code VARCHAR(32) PRIMARY KEY,
    created_by INT,
    used_by INT,
    used_at DATETIME,
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    channel VARCHAR(16) DEFAULT 'web',
    external_id VARCHAR(128),
    permission VARCHAR(8) DEFAULT 'write',
    mode VARCHAR(16) DEFAULT 'chat',
    project VARCHAR(64) DEFAULT 'default',
    title VARCHAR(255) DEFAULT '新对话',
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    role VARCHAR(16) NOT NULL,
    content MEDIUMTEXT,
    reasoning MEDIUMTEXT,
    model VARCHAR(128),
    provider VARCHAR(32),
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_msg_conv (conversation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT,
    action VARCHAR(64),
    detail TEXT,
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS capabilities (
    account_id INT,
    cap_key VARCHAR(64) NOT NULL,
    enabled TINYINT DEFAULT 0,
    PRIMARY KEY (account_id, cap_key)
  )`,
  // ---- v1.7 数据模型：模型与市场 ----
  `CREATE TABLE IF NOT EXISTS providers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_key VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(64) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    api_key_env VARCHAR(64),
    enabled TINYINT DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_id INT NOT NULL,
    model_id VARCHAR(128) NOT NULL,
    name VARCHAR(255),
    capabilities JSON,
    enabled TINYINT DEFAULT 1,
    added_at DATETIME DEFAULT NOW(),
    last_seen_at DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_provider_model (provider_id, model_id)
  )`,
  `CREATE TABLE IF NOT EXISTS market_snapshot (
    id INT AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(32) NOT NULL,
    model_id VARCHAR(128) NOT NULL,
    name VARCHAR(255),
    provider_name VARCHAR(128),
    domain VARCHAR(64),
    snapshot_date DATE,
    UNIQUE KEY uq_src_model (source, model_id)
  )`,
  // ---- v1.7 数据模型：用量与统计 ----
  `CREATE TABLE IF NOT EXISTS usage_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT,
    conversation_id INT,
    agent_run_id INT,
    message_id INT,
    provider_id VARCHAR(32),
    model_id VARCHAR(128),
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    cost DECIMAL(10,4) DEFAULT 0,
    duration_ms INT DEFAULT 0,
    first_token_ms INT DEFAULT 0,
    cache_hit_tokens INT DEFAULT 0,
    kind VARCHAR(16) DEFAULT 'request',
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_usage_time (created_at),
    INDEX idx_usage_conv (conversation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT,
    message_id INT,
    tool_name VARCHAR(64),
    args JSON,
    result_summary TEXT,
    duration_ms INT DEFAULT 0,
    status VARCHAR(16),
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS price_table (
    id INT AUTO_INCREMENT PRIMARY KEY,
    provider_id INT,
    model_pattern VARCHAR(128),
    price_in_per_million DECIMAL(10,4) DEFAULT 0,
    price_out_per_million DECIMAL(10,4) DEFAULT 0,
    currency VARCHAR(8) DEFAULT 'CNY',
    updated_at DATETIME DEFAULT NOW()
  )`,
  // ---- v1.7 数据模型：全局配置 ----
  `CREATE TABLE IF NOT EXISTS settings (
    skey VARCHAR(64) PRIMARY KEY,
    svalue JSON,
    updated_at DATETIME DEFAULT NOW()
  )`,
  // ---- 长对话摘要（上下文压缩） ----
  `CREATE TABLE IF NOT EXISTS conv_summaries (
    conversation_id INT PRIMARY KEY,
    summary MEDIUMTEXT,
    updated_at DATETIME DEFAULT NOW()
  )`,
  // ---- 定时任务（F14） ----
  `CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT,
    name VARCHAR(128) NOT NULL,
    cron VARCHAR(64) NOT NULL COMMENT 'cron 表达式: 分 时 日 月 周',
    prompt MEDIUMTEXT NOT NULL,
    provider VARCHAR(32) DEFAULT 'deepseek',
    model VARCHAR(128) DEFAULT 'deepseek-v4-flash',
    permission VARCHAR(8) DEFAULT 'full',
    enabled TINYINT DEFAULT 1,
    last_run DATETIME,
    next_run DATETIME,
    last_result TEXT,
    created_at DATETIME DEFAULT NOW()
  )`,
  // ---- 目标系统（F10） ----
  `CREATE TABLE IF NOT EXISTS goals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    account_id INT,
    objective TEXT NOT NULL,
    progress TEXT,
    status VARCHAR(16) DEFAULT 'active',
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW()
  )`,
  // ---- 会话已载入技能（F15：技能名持久化，文件内容每次请求实时读取） ----
  `CREATE TABLE IF NOT EXISTS conv_skills (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    skill_name VARCHAR(64) NOT NULL,
    created_at DATETIME DEFAULT NOW(),
    UNIQUE KEY uq_conv_skill (conversation_id, skill_name)
  )`,
  // ---- 知识库（F19：scope=global 全部会话可见；scope=conv 仅本会话；标题索引入提示，正文按需 kb_search） ----
  `CREATE TABLE IF NOT EXISTS knowledge (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    scope VARCHAR(8) DEFAULT 'conv',
    conversation_id INT,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    created_at DATETIME DEFAULT NOW(),
    KEY idx_kb_scope (account_id, scope)
  )`,
  // ---- 长任务现场（断点恢复：每会话一条；running→completed|interrupted|paused） ----
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NOT NULL,
    account_id INT,
    goal VARCHAR(2000),
    status VARCHAR(20) DEFAULT 'running',
    reason VARCHAR(300),
    rounds INT DEFAULT 0,
    last_step VARCHAR(500),
    tool_counts TEXT,
    started_at DATETIME DEFAULT NOW(),
    heartbeat_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW(),
    INDEX idx_run_conv (conversation_id)
  )`,
  // ---- 任务契约（外部驱动器：白天立项 → 夜间/立即无人值守执行 → 验收 → 用户复测确认） ----
  `CREATE TABLE IF NOT EXISTS task_contracts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT,
    title VARCHAR(200),
    goal TEXT,
    acceptance TEXT,
    boundaries TEXT,
    run_at DATETIME,
    status VARCHAR(20) DEFAULT 'queued',
    conv_id INT,
    model VARCHAR(64),
    attempts INT DEFAULT 0,
    last_ask TEXT,
    last_result TEXT,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW(),
    INDEX idx_contract_status (status)
  )`,
  `CREATE TABLE IF NOT EXISTS contract_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    contract_id INT NOT NULL,
    kind VARCHAR(24),
    detail TEXT,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_ce_contract (contract_id)
  )`,
];

export async function initSchema() {
  for (const sql of SCHEMA) {
    try { await pool.query(sql); } catch (e) { console.error('[db] schema error:', e.message); }
  }
  // 存量库迁移（幂等：列已存在时报错被吞掉）
  const MIGRATIONS = [
    'ALTER TABLE messages ADD COLUMN reasoning MEDIUMTEXT',
    "ALTER TABLE conversations ADD COLUMN mode VARCHAR(16) DEFAULT 'chat'",
    "ALTER TABLE usage_stats ADD COLUMN kind VARCHAR(16) DEFAULT 'request'",
    'ALTER TABLE usage_stats ADD COLUMN agent_run_id INT NULL',
  ];
  for (const sql of MIGRATIONS) {
    try { await pool.query(sql); } catch { /* 已存在或不可用则跳过 */ }
  }
}
