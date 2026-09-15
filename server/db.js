// server/db.js - MySQL 连接池 + 建表
import mysql from 'mysql2/promise';
import { config } from './config.js';
import { runMigrations, schemaVersion, VERSIONS } from './migrations.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.pass,
  database: config.db.name,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  // 死连接检测（架构项：工具级"不得永久挂住"的连接层那一半）。
  // 问题不是"查询太慢"，而是**对端已经没了而我们还以为它在跑**：MySQL 走 SSH 隧道/网络抖动时，
  // 本地 socket 仍可写，write() 成功返回，驱动就一直等一个永远不会来的响应——连"空闲"都算不上。
  // mysql2 的 connectTimeout 默认 10s、enableKeepAlive 默认已开，但 keepAliveInitialDelay 不设
  // 就是交给 OS 默认（Linux tcp_keepalive_time=7200s），等于发现不了。
  // 120000 不是新造的阈值：它就是本项目对"外部连接多久没动静即判异常"的既有口径
  // （LLM 流的 idleMs = 120000，网关层同一句话），这里只是把同一口径用在连接层。
  keepAliveInitialDelay: 120000,
});

function abortError() {
  const e = new Error('数据库操作已被中止（用户停止/会话结束）');
  e.aborted = true;
  return e;
}

/**
 * 带"可中断"的取连接：signal 中止时**销毁**该连接而不是放回池子。
 * 反复强调的口径（见 tools/deadline.js）：中止不等于抛弃——连接是我们持有的真实资源，
 * 中止后仍要把它的归属处理干净（销毁），否则池子会被尸体连接占满。
 * 局限（如实记下）：中止**不能**取消"排队等连接"本身（mysql2 的 getConnection 不可取消）；
 * 排队中的那次会在拿到连接后立刻销毁并抛中止错。所以挂死时"停止"能结束这一轮，
 * 但不是瞬时——它靠销毁连接释放槽位来推进。
 */
async function gotConn(signal) {
  const conn = await pool.getConnection();
  if (signal && signal.aborted) { try { conn.destroy(); } catch { /* ignore */ } throw abortError(); }
  return conn;
}

export const db = {
  /**
   * @param {string} sql
   * @param {any[]} [params]
   * @param {{signal?: AbortSignal}} [opts] 传 signal 时走可中断路径（销毁连接结束在飞查询）；不传＝原快路径
   */
  async query(sql, params, opts) {
    const signal = opts && opts.signal;
    if (!signal) {
      const [rows] = await pool.query(sql, params);
      return rows;
    }
    if (signal.aborted) throw abortError();
    const conn = await gotConn(signal);
    let destroyed = false;
    const onAbort = () => { destroyed = true; try { conn.destroy(); } catch { /* ignore */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const [rows] = await conn.query(sql, params);
      // 中止后拿到的那份结果**不可信**（实测：销毁连接时 mysql2 会以 `[{s:0}]` 之类**成功**返回，
      // 而不是抛错——SLEEP(30) 被连接断开打断，却报成查询成功）。所以以 signal 为准：我们中止了，
      // 这份结果就一律作废并如实抛中止错——宁可报"中止"，也不能把半截数据当查询结果交出去。
      if (destroyed || signal.aborted) throw abortError();
      return rows;
    } finally {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      if (!destroyed) { try { conn.release(); } catch { /* ignore */ } }
    }
  },
  async run(sql, params, opts) {
    const signal = opts && opts.signal;
    if (!signal) {
      const [r] = await pool.execute(sql, params);
      return r;
    }
    if (signal.aborted) throw abortError();
    const conn = await gotConn(signal);
    let destroyed = false;
    const onAbort = () => { destroyed = true; try { conn.destroy(); } catch { /* ignore */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const [r] = await conn.execute(sql, params);
      // 写语句被中止时结果未知（可能已提交、可能没有）——绝不把"不知道"报成"成功"，如实抛中止错
      if (destroyed || signal.aborted) throw abortError();
      return r;
    } finally {
      try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
      if (!destroyed) { try { conn.release(); } catch { /* ignore */ } }
    }
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
    -- 下面这几列是"只在迁移链里加过、忘了同步到这里"的（2026-09-16 由 test/schema-sync.test.mjs 抓出来）：
    -- 全新库走的是这张建表语句、且迁移链会被整条标记为已应用 ⇒ 少一列，客户机装完第一次建会话就
    -- Unknown column（且 Express 4 不接 async 拒绝，请求会永久挂住）。类型与 0001_baseline 的 ALTER 逐字一致。
    provider VARCHAR(32),
    model VARCHAR(128),
    shell_id INT NULL,
    face_full TINYINT DEFAULT 0,
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
    conversation_id INT NULL,
    shell_id INT NULL,
    created_at DATETIME DEFAULT NOW(),
    KEY idx_audit_time (created_at),
    KEY idx_audit_conv (conversation_id)
  )`,
  // ---- A9 审计 90 天归档（§8.10：主表不膨胀、归档仍可查；与 audit_log 同构 + archived_at） ----
  `CREATE TABLE IF NOT EXISTS audit_log_archive (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT,
    action VARCHAR(64),
    detail TEXT,
    conversation_id INT NULL,
    shell_id INT NULL,
    created_at DATETIME DEFAULT NOW(),
    archived_at DATETIME DEFAULT NOW(),
    KEY idx_arch_time (created_at),
    KEY idx_arch_conv (conversation_id)
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
    prefix_sys_hash VARCHAR(12) NULL,
    prefix_tools_hash VARCHAR(12) NULL,
    shell_id INT NULL,
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
    result_bytes INT DEFAULT 0,
    duration_ms INT DEFAULT 0,
    status VARCHAR(16),
    error_code VARCHAR(32) NULL,
    shell_id INT NULL,
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    conversation_id INT NULL,
    seq INT NOT NULL DEFAULT 0,
    type VARCHAR(32) NOT NULL,
    payload JSON,
    created_at DATETIME DEFAULT NOW(),
    INDEX idx_events_conv (conversation_id, id)
  )`,
  // ---- 2026-09-15 RA-47：事件账本归档（保留口径=审计账本 90 天；与 events 同列 + archived_at） ----
  `CREATE TABLE IF NOT EXISTS events_archive (
    id BIGINT NOT NULL PRIMARY KEY,
    conversation_id INT NULL,
    seq INT NOT NULL DEFAULT 0,
    type VARCHAR(32) NOT NULL,
    payload JSON,
    created_at DATETIME DEFAULT NOW(),
    archived_at DATETIME DEFAULT NOW(),
    INDEX idx_events_arch_time (created_at)
  )`,
  // ---- 2026-09-16 D4/RA-42：外部投递记录（幂等键 + 死信落点）。与 migrations.js 的 0005 同一形状 ----
  `CREATE TABLE IF NOT EXISTS deliveries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NULL,
    conversation_id INT NULL,
    idem_key VARCHAR(200) NULL,
    request_hash VARCHAR(64) NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'running',
    attempts INT NOT NULL DEFAULT 1,
    message_id BIGINT NULL,
    run_id BIGINT NULL,
    response_json JSON NULL,
    last_error VARCHAR(500) NULL,
    last_error_code VARCHAR(32) NULL,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW(),
    UNIQUE KEY uk_deliveries_idem (account_id, idem_key),
    INDEX idx_deliveries_state (state, id)
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
    kind VARCHAR(12) DEFAULT 'fact',
    status VARCHAR(12) DEFAULT 'active',
    related_component VARCHAR(120),
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
    intent_rules JSON,
    task_profiles JSON,
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
  // ---- ⑤ 模型观测数据面（口径见总方案 §7.4/§9；编号 v2.10 曾与内核蓝图版本混用，2026-09-10 治理改指）：model_telemetry 执行事实表 + reviews 复测记录 ----
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
    difficulty VARCHAR(8),
    created_at DATETIME DEFAULT NOW(),
    KEY idx_reviews_conv (conversation_id)
  )`,
  // ---- A7 进化集产品载体（总方案 §8.7/§9.3"产品批状态载体随批定义"）：进化目标（人控事项）+ 目标×定时任务绑定 + 备忘录区 ----
  `CREATE TABLE IF NOT EXISTS evo_goals (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    name VARCHAR(200) NOT NULL,
    descr VARCHAR(1000),
    status VARCHAR(12) DEFAULT 'active',   -- active|paused
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS evo_goal_tasks (
    goal_id INT NOT NULL,
    task_id INT NOT NULL,
    created_at DATETIME DEFAULT NOW(),
    PRIMARY KEY (goal_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS evo_memos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    content TEXT NOT NULL,
    done TINYINT DEFAULT 0,
    created_at DATETIME DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS task_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    task_id INT NOT NULL,
    started_at DATETIME DEFAULT NOW(),
    finished_at DATETIME,
    ok TINYINT DEFAULT 0,
    note TEXT,
    cost DECIMAL(10,4) DEFAULT 0
  )`,
  // ---- 2026-09-11 A0 扩展中心数据载体（总方案 §9.3 载体①②④⑧；随扩展中心批使用）----
  // extensions：可装载业务资产注册表（插件/MCP/应用统一；manifest 详情随批落 manifest_ref）
  `CREATE TABLE IF NOT EXISTS extensions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    asset_type VARCHAR(12) NOT NULL,   -- plugin|mcp|app
    akey VARCHAR(64) NOT NULL,         -- 资产 key
    name VARCHAR(128),
    version VARCHAR(32),
    status VARCHAR(12) DEFAULT 'dev',  -- dev|test|published|retired（对应 研发|测试|已上架|退役）
    scope VARCHAR(12) DEFAULT 'global',-- global|shell
    capability JSON,
    manifest_ref VARCHAR(255),
    meta JSON,
    created_at DATETIME DEFAULT NOW(),
    updated_at DATETIME DEFAULT NOW(),
    UNIQUE KEY uk_ext (asset_type, akey)
  )`,
  // shell_extensions：壳×资产装载关系（装配向导 step6 产物 / 按壳过滤 / 装载壳数）
  `CREATE TABLE IF NOT EXISTS shell_extensions (
    shell_id INT NOT NULL,
    asset_type VARCHAR(12) NOT NULL,
    asset_key VARCHAR(64) NOT NULL,
    enabled_at DATETIME DEFAULT NOW(),
    PRIMARY KEY (shell_id, asset_type, asset_key)
  )`,
  // extension_demands：需求/升级反馈（硬信号|软信号|主动 → 待审|采纳|驳回|升级；月度扩展巡检计数）
  `CREATE TABLE IF NOT EXISTS extension_demands (
    id INT AUTO_INCREMENT PRIMARY KEY,
    asset_key VARCHAR(64),
    kind VARCHAR(12) NOT NULL,   -- hard|soft|manual（硬信号|软信号|主动）
    source VARCHAR(24),
    content TEXT NOT NULL,
    status VARCHAR(10) DEFAULT '待审',  -- 待审|采纳|驳回|升级
    created_at DATETIME DEFAULT NOW(),
    KEY idx_demands (status, created_at)
  )`,
  // credentials_ref：凭证引用（仅存引用，不落明文——§9 凭证存放规则；随 D10 连接器批使用）
  `CREATE TABLE IF NOT EXISTS credentials_ref (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shell_id INT,
    provider VARCHAR(64) NOT NULL,
    ref VARCHAR(255) NOT NULL,
    created_at DATETIME DEFAULT NOW(),
    UNIQUE KEY uk_cred (shell_id, provider)
  )`,
];

export async function initSchema() {
  // 2026-09-16 修（子代理在造探针库时实测发现，我上一版的"全新库"探测是**假的**）：
  // 探测必须发生在**建表之前**。原来我把探测放在 runMigrations 里，而 runMigrations 是在上面这圈
  // SCHEMA 建表**之后**才调用的 —— 那时 `tool_calls` 已被按最终形状建好，探测恒为"不是全新库"，
  // 于是全新库照样去跑 0001/0002：0002 的 `ADD COLUMN error_code` 撞上建表时的同名列 → 不 tolerate →
  // **判失败并 break**，链停在 0002（后续迁移永远不会应用），而且每次启动刷一条迁移失败日志。
  // 客户装机走的正是这条路径。夹具当时用一个"现实中不会出现的时序"骗过了我，所以这里连夹具一起改。
  let fresh = false;
  try {
    const r = await pool.query('SHOW TABLES LIKE ?', ['tool_calls']);
    fresh = !(r[0] && r[0].length);
  } catch { fresh = false; }
  for (const sql of SCHEMA) {
    try { await pool.query(sql); } catch (e) { console.error('[db] schema error:', e.message); }
  }
  // 存量库迁移：**已迁到 server/migrations.js 的带版本迁移链**（2026-09-15）。
  // 此前是"一串幂等 ALTER + 报错就吞掉"：没有版本记录、每次启动全量重跑、真实失败与"列已存在"在日志里一个样。
  // 现在：按序号应用、应用过就跳过、链有缺口直接报错（照 DSH 会话格式迁移链的两条：相邻无缺口、只向前）。
  // **新增结构变更只加到 migrations.js 的 VERSIONS**，同时改上面的 SCHEMA 建表语句（新库走 CREATE，存量库走迁移）。
  try {
    const r = await runMigrations(pool, { fresh });
    if (r.applied.length) console.log('[db] 迁移已应用 ' + r.applied.join(', ') + '（此前已应用 ' + r.skipped + ' 条）');
    if (r.failed) console.error('[db] 迁移失败于 ' + r.failed.id + '：' + r.failed.error);
  } catch (e) {
    // 链本身坏了（跳号/重复/格式错）→ 显式抛出：带着半条链跑比启动失败更糟
    console.error('[db] 迁移链校验失败：' + ((e && e.message) || e));
    throw e;
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
  // ⑤ 观测视图（幂等）：按 壳×厂商×模型×日 的执行事实聚合（2026-09-11 A1：补 cache_hit/miss 聚合列——命中率按日数据出口，总方案 §7.4 登记①）
  const VIEWS = [
    `CREATE OR REPLACE VIEW v_model_telemetry_daily AS
       SELECT shell_id, provider, model, DATE(created_at) AS d, COUNT(*) AS execs,
              COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
              COALESCE(SUM(cost),0) AS cost, COALESCE(SUM(duration_ms),0) AS duration_ms,
              COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(cache_miss),0) AS cache_miss
       FROM model_telemetry GROUP BY shell_id, provider, model, DATE(created_at)`,
  ];
  for (const sql of VIEWS) {
    try { await pool.query(sql); }
    catch (e) { console.error('[db] view error:', (e && e.message) || e); }
  }
  // 启动自检：关键列缺失即醒目告警（正常 initSchema 应全过；缺失=迁移被跳过/手工建库，主链路将 500）
  // 2026-09-16（D2′ 装机阻断的教训）：这份清单以前是**手写的一小段**，于是"哪些列该在"有两个出处，
  // 实测漏了 5 列（conversations.model / audit_log.shell_id / knowledge.status / knowledge.related_component /
  // shells.pack_extra）。现在**直接从迁移链推导**：链里加过的每一列都该在库里——链是升级路径的唯一事实源。
  // 同时补上"两条建库路径对齐"的静态检查（test/schema-sync.test.mjs）——那里管"新库该有什么"，
  // 这里管"这台机器的库现在到底有没有"，两个方向合起来才盖全。
  try {
    const missing = [];
    const checks = [['messages', 'reasoning']];
    for (const v of VERSIONS) {
      for (const stmt of v.statements || []) {
        const m = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(String(stmt));
        if (m) checks.push([m[1], m[2]]);
      }
    }
    for (const [tbl, col] of checks) {
      const r = await pool.query('SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [tbl, col]);
      if (!(r[0] && r[0][0] && Number(r[0][0].c) > 0)) missing.push(tbl + '.' + col);
    }
    if (missing.length) console.error('[db] 启动自检：关键列缺失（迁移可能被跳过）→ ' + missing.join(', ') + '（共 ' + checks.length + ' 列参与核对）');
  } catch { /* 自检失败不阻断 */ }
  // schema 版本（架构 §11.1：存储格式带版本号）——升级/排障时第一眼要看的东西
  try { console.log('[db] schema 版本 = ' + (await schemaVersion(pool) || '（无记录）')); } catch { /* 忽略 */ }
}
