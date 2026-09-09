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

// 政策版本（WS2：settings 每次被写时自增；运行时快照显示，模型看到版本变化即丢弃旧规则理解）
export async function bumpPolicyRev() {
  try {
    const r = await pool.query('SELECT svalue FROM settings WHERE skey=?', ['__policy_rev']);
    const cur = r[0][0] ? (Number(JSON.parse(r[0][0].svalue)) || 0) : 0;
    await pool.query('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()',
      ['__policy_rev', JSON.stringify(cur + 1)]);
  } catch { /* 版本自增失败不影响主流程 */ }
}

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
    preset VARCHAR(8) DEFAULT 'all',
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
    cache_miss_tokens INT DEFAULT 0,
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
  // ---- 定时务务（F14） ----
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
  // ---- 后台长务务注册表持久化（D2/D5：jobs Map 仅内存态，重启/超 TTL 后 pid↔日志映射丢失 → DB 持久索引，job_list/job_output/kill_process 重启后仍可查；启动时清理陈旧 running） ----
  `CREATE TABLE IF NOT EXISTS long_jobs (
    job_id VARCHAR(40) PRIMARY KEY,
    cmd TEXT,
    log_file VARCHAR(255),
    started_at DATETIME DEFAULT NOW(),
    status VARCHAR(16) DEFAULT 'running',
    code INT,
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
  // ---- 知识库（F19/④：scope=global 全部会话可见 / scope=shell 仅所属壳会话可见（§4 壳私有+全局共享）/ scope=conv 仅本会话；标题索引入提示，正文按需 kb_search） ----
  `CREATE TABLE IF NOT EXISTS knowledge (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    scope VARCHAR(8) DEFAULT 'conv',
    conversation_id INT,
    shell_id INT,
    title VARCHAR(200) NOT NULL,
    body TEXT,
    created_at DATETIME DEFAULT NOW(),
    KEY idx_kb_scope (account_id, scope),
    KEY idx_kb_shell (shell_id)
  )`,
  // ---- 长务务现场（断点恢复：每会话一条；running→completed|interrupted|paused） ----
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
  // ---- 务务契约（外部驱动器：白天立项 → 夜间/立即无人值守执行 → 验收 → 用户复测确认） ----
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
  // ---- B1 壳定义层（v2.6 基线 §3）：shells 壳行 / shell_tools 三态 / shell_settings 壳级覆盖 ----
  `CREATE TABLE IF NOT EXISTS shells (
    id INT AUTO_INCREMENT PRIMARY KEY,
    skey VARCHAR(32) UNIQUE NOT NULL,
    name VARCHAR(64) NOT NULL,
    description VARCHAR(255),
    persona JSON,
    domain_text TEXT,
    model_policy JSON,
    tools_preset VARCHAR(8) DEFAULT 'standard',
    tools_force_on JSON,
    tools_force_off JSON,
    knowledge_scopes JSON,
    skills_allow JSON,
    guardrails JSON,
    channels JSON,
    ui_brand JSON,
    pack_extra JSON,
    eval_ref VARCHAR(255),
    status VARCHAR(10) DEFAULT 'enabled',
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS shell_tools (
    shell_id INT NOT NULL,
    tool_name VARCHAR(64) NOT NULL,
    mode VARCHAR(12) NOT NULL,
    PRIMARY KEY (shell_id, tool_name)
  )`,
  `CREATE TABLE IF NOT EXISTS shell_settings (
    shell_id INT NOT NULL,
    skey VARCHAR(64) NOT NULL,
    svalue JSON,
    updated_at DATETIME DEFAULT NOW(),
    PRIMARY KEY (shell_id, skey)
  )`,
  // ---- ⑤ 模型观测数据面（v2.10 §8）：model_telemetry 执行事实表 + reviews 复测记录 ----
  `CREATE TABLE IF NOT EXISTS model_telemetry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT,
    account_id INT,
    shell_id INT,
    provider VARCHAR(32),
    model VARCHAR(128),
    profile_key VARCHAR(64),
    difficulty VARCHAR(8),
    tokens_in INT DEFAULT 0,
    tokens_out INT DEFAULT 0,
    cache_hit INT DEFAULT 0,
    cache_miss INT DEFAULT 0,
    cost DECIMAL(10,4) DEFAULT 0,
    duration_ms INT DEFAULT 0,
    created_at DATETIME DEFAULT NOW(),
    KEY idx_telemetry_time (created_at),
    KEY idx_telemetry_shell_model (shell_id, provider, model)
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT,
    account_id INT,
    result VARCHAR(8) NOT NULL,
    bug_reason TEXT,
    created_at DATETIME DEFAULT NOW(),
    KEY idx_reviews_conv (conversation_id)
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
    "ALTER TABLE conversations ADD COLUMN preset VARCHAR(8) DEFAULT 'all'",
    "ALTER TABLE usage_stats ADD COLUMN kind VARCHAR(16) DEFAULT 'request'",
    'ALTER TABLE usage_stats ADD COLUMN agent_run_id INT NULL',
    'ALTER TABLE usage_stats ADD COLUMN cache_miss_tokens INT DEFAULT 0',
    // 2026-09 对话内模型：conversations 记录每会话选中的 provider/model（前端打开会话时恢复、切换即保存）
    "ALTER TABLE conversations ADD COLUMN provider VARCHAR(32)",
    "ALTER TABLE conversations ADD COLUMN model VARCHAR(128)",
    // B1 壳维度：会话归属壳（NULL=默认壳语义，保持存量行为不变）
    'ALTER TABLE conversations ADD COLUMN shell_id INT NULL',
    // B1 修正：三态 mode 列长不足（force_off 被截断）→ 扩到 12
    'ALTER TABLE shell_tools MODIFY COLUMN mode VARCHAR(12) NOT NULL',
    // B1-④ 埋点：执行/审计/工具调用带 shell 维度（§8）
    'ALTER TABLE usage_stats ADD COLUMN shell_id INT NULL',
    'ALTER TABLE tool_calls ADD COLUMN shell_id INT NULL',
    'ALTER TABLE audit_log ADD COLUMN shell_id INT NULL',
    // B2：壳级意图词表（intentRules，v1.1 可选字段）
    'ALTER TABLE shells ADD COLUMN intent_rules JSON',
    // B3：壳级任务档案（taskProfiles，v1.2 可选字段）
    'ALTER TABLE shells ADD COLUMN task_profiles JSON',
    // ④：知识库壳私有维度（scope=shell 条目挂所属壳；存量行 shell_id=NULL 不受影响）
    'ALTER TABLE knowledge ADD COLUMN shell_id INT NULL',
    // F2 往返保真：DB 无列承载的 pack 扩展字段（tone/terms/mcps/defaultsAutoLoad/approvalMode/bindings/importRefs/credentials 等）
    // 存 pack_extra（import 写入 / export/clone 合并还原），避免 clone/export→import→export 丢字段
    'ALTER TABLE shells ADD COLUMN pack_extra JSON',
    // 2026-09-09 知识库文档型升级：kind 分类（fact=运行事实[默认]/progress=进化进度/guide=平台规范/skill=技能/lesson=错题本）
    // 仅增加表达维度，不改旧行语义（存量默认 fact）；scope 三档(global/shell/conv)不变，不新增隔离面
    "ALTER TABLE knowledge ADD COLUMN kind VARCHAR(12) DEFAULT 'fact'",
  ];
  for (const sql of MIGRATIONS) {
    try { await pool.query(sql); }
    catch (e) {
      // 仅"列已存在"可静默（幂等）；其余失败（权限/锁/断连）记日志便于定位——否则列漂移后主链路 500 难查
      const msg = String((e && e.message) || e);
      if (!/Duplicate column|already exists|Duplicate entry/i.test(msg)) console.error('[db] migration error:', msg);
    }
  }
  // 初始键种子（幂等：INSERT IGNORE，已存在不覆盖）：政策版本从 1 起；单段成本提醒默认关（0）；
  // 任务总账默认 100（会话 24h 真上限，与 agent.js 回退值/蓝图一致）；存量旧值 20/30 由部署迁移校正
  const SEEDS = [
    ['__policy_rev', '1'],
    ['task_budget_yuan', '0'],
    ['task_budget_total', '100'],
  ];
  for (const [k, v] of SEEDS) {
    try {
      await pool.query('INSERT IGNORE INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW())', [k, v]);
    } catch { /* 表不可用则跳过 */ }
  }
  // B1 种子：default 中性壳（persona=NULL=保持现状行为；幂等）
  try {
    await pool.query(
      `INSERT IGNORE INTO shells (skey, name, description, persona, tools_preset, status, created_at, updated_at)
       VALUES ('default','默认壳','系统保留中性壳（无 persona，行为=现状）',NULL,'standard','enabled',NOW(),NOW())`,
      []
    );
  } catch { /* 表不可用则跳过 */ }
  // ⑤ 观测视图（幂等）：按 壳×厂商×模型×日 的执行事实聚合
  const VIEWS = [
    `CREATE OR REPLACE VIEW v_model_telemetry_daily AS
       SELECT shell_id, provider, model, DATE(created_at) AS d, COUNT(*) AS execs,
              COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(duration_ms),0) AS duration_ms
       FROM model_telemetry GROUP BY shell_id, provider, model, DATE(created_at)`,
  ];
  for (const sql of VIEWS) {
    try { await pool.query(sql); }
    catch (e) { console.error('[db] view error:', (e && e.message) || e); }
  }
  // 启动自检：关键新列缺失即醒目告警（正常 initSchema 应全过；缺失=迁移被跳过/手工建库，主链路将 500）
  try {
    const missing = [];
    const checks = [
      ['messages', 'reasoning'], ['conversations', 'provider'], ['conversations', 'shell_id'],
      ['usage_stats', 'shell_id'], ['tool_calls', 'shell_id'], ['shells', 'intent_rules'], ['shells', 'task_profiles'], ['shells', 'pack_extra'], ['knowledge', 'shell_id'], ['knowledge', 'kind'],
    ];
    for (const [tbl, col] of checks) {
      const r = await pool.query('SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [tbl, col]);
      if (!(r[0] && r[0][0] && Number(r[0][0].c) > 0)) missing.push(tbl + '.' + col);
    }
    if (missing.length) console.error('[db] 启动自检：关键列缺失（迁移可能被跳过）→ ' + missing.join(', '));
  } catch { /* 自检失败不阻断 */ }
}
