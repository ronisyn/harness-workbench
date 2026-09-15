// server/migrations.js - 结构变更的**唯一去处**：带版本号的迁移链（架构 §11.1「存储格式带版本与迁移链」）
//
// 为什么要它（此前是"一串幂等 ALTER + 报错就吞掉"）：
//   · 没有任何地方记录"这个库现在是什么版本" ⇒ 客户机离线升级、回滚、排障都无从谈起；
//   · 每次启动把全部 ALTER 重跑一遍，真实失败与"列已存在"在日志里长得一样；
//   · 加新变更没有固定位置，散在 initSchema 里。
//
// 参考 DSH 的做法（`dsh-session-format` + `dsh-session-format-v0-to-v1/v1-to-v2/v2-to-v3`）：
//   它的迁移是 `{name, fromVersion, toVersion, migrateHeader, migrateEvent}`，组合器在**注册时**强制
//   `toVersion === fromVersion + 1`（只允许相邻步），把整条链编译成"唯一、完整、无缺口"，缺一步就
//   **显式报错**（SessionFormatUnsupportedMigrationError）而不是跳过。
//   我们照搬其中两条（不照搬文件格式那套，因为我们的对象是数据库结构）：
//     ① **序号连续、无重复、按序**——启动时校验，链坏了立刻停（不要带着半条链跑）；
//     ② **只向前**，不写降级脚本（《数据库迁移规范》：只增不删；破坏性变更分两步走）。
//
// 用法：新增结构变更 = 在 VERSIONS 末尾加一条 `{ id: '<下一个序号>_短名', statements: [...] }`，
//       **同时**把新库路径（server/db.js 的 SCHEMA 建表语句）改成最终形状。
//       ⚠️ 2026-09-16（v0.3 §0.5「不留两套」的过账判定，登记 C-39 第 ④ 条）：这条约定**不再靠自觉**——
//       `test/schema-sync.test.mjs` 会机器核对"链里加过的每一列/每张表都必须在建表语句里"（实测曾漂移 11 列，
//       见 C-34 的装机阻断），启动自检的列清单也**改为从 VERSIONS 推导**。改一处漏一处会当场报红。

export const MIGRATION_ID_RE = /^(\d{4})_[a-z0-9_]+$/;

/**
 * 校验迁移链：id 格式合法、序号连续（从 1 起、无跳号）、无重复。
 * 纯函数，坏了就抛错——**在应用任何一条之前**先校验，避免带着半条链跑。
 */
export function validateChain(versions) {
  if (!Array.isArray(versions)) throw new Error('迁移链必须是数组');
  const seen = new Set();
  versions.forEach((v, i) => {
    const m = MIGRATION_ID_RE.exec(String(v && v.id || ''));
    if (!m) throw new Error('迁移 id 非法（应形如 0002_add_xxx）：' + (v && v.id));
    if (seen.has(v.id)) throw new Error('迁移 id 重复：' + v.id);
    seen.add(v.id);
    const seq = Number(m[1]);
    if (seq !== i + 1) throw new Error('迁移链有缺口或乱序：第 ' + (i + 1) + ' 条应为 ' + String(i + 1).padStart(4, '0') + '，实际 ' + v.id);
    if (!Array.isArray(v.statements) || !v.statements.length) throw new Error('迁移 ' + v.id + ' 没有语句');
  });
  return true;
}

/** 待应用的迁移（按链序）。纯函数，便于夹具。 */
export function pendingMigrations(versions, appliedIds) {
  const done = new Set(appliedIds || []);
  return versions.filter((v) => !done.has(v.id));
}

/**
 * 版本化迁移的**改造前既有结构变更**（原 db.js 里那串幂等 ALTER，逐条搬运，未改内容）。
 * 它是普通的一条迁移：首次运行真的执行一遍（在已有库上是无操作的幂等语句），执行过就不再重复。
 */
const BASELINE = [
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
  // A6 知识治理（§7.3 条目结构化字段）：状态 active|superseded|obsolete + 关联组件/版本（superseded/obsolete 注入降权或仅历史）
  "ALTER TABLE knowledge ADD COLUMN status VARCHAR(12) DEFAULT 'active'",
  "ALTER TABLE knowledge ADD COLUMN related_component VARCHAR(120)",
  // A7 难度人工勾选（§7.2：复测记录带难度 小|中|大，联动一次通过率）
  "ALTER TABLE reviews ADD COLUMN difficulty VARCHAR(8)",
  // A9 审计回溯（按会话）+ 90 天归档查询索引（§8.10）
  'ALTER TABLE audit_log ADD COLUMN conversation_id INT NULL',
  'ALTER TABLE audit_log_archive ADD COLUMN conversation_id INT NULL',
  'ALTER TABLE audit_log_archive ADD COLUMN shell_id INT NULL',
  // 2026-09-15 RA-05b：工具结果原始体积遥测（字节）——spill 阈值标定的依据。
  'ALTER TABLE tool_calls ADD COLUMN result_bytes INT DEFAULT 0',
  // 2026-09-15 M1a：每轮前缀面指纹（system 提示 + 工具面）；存量行留 NULL
  'ALTER TABLE usage_stats ADD COLUMN prefix_sys_hash VARCHAR(12) NULL',
  'ALTER TABLE usage_stats ADD COLUMN prefix_tools_hash VARCHAR(12) NULL',
  // 2026-09-15 工具面会话内冻结（v0.3 §4.4.1 规则3）：单向粘滞，一旦用过全量面就置 1
  'ALTER TABLE conversations ADD COLUMN face_full TINYINT DEFAULT 0',
  // 2026-09-09 清理：capabilities 账号表（从未接线到运行时，随代码移除一起清理）
  'DROP TABLE IF EXISTS capabilities',
];

/** 迁移链。**新增结构变更只加在这里**（序号必须接上），同时改 db.js 的建表语句。 */
export const VERSIONS = [
  {
    id: '0001_baseline', note: '改造前既有结构变更（只容忍"已存在"类错误）', statements: BASELINE,
    // 这一条是**历史搬运**，语义与改造前完全一致：改造前的代码就是"执行这串 ALTER，把 Duplicate column/
    // already exists 吞掉"。所以这里显式声明"只容忍已存在类错误"——**其余错误一律判失败**（这正是改进点：
    // 过去所有错误都被吞，真实失败与"列已存在"在日志里长得一样）。
    // 后续新增的迁移**不写 tolerate**（默认不容忍）：新变更必须是干净的。
    tolerate: /Duplicate column|Duplicate key name|already exists|Duplicate entry/i,
  },
  {
    id: '0002_tool_error_code', note: '工具失败码（统一失败分类）',
    // 2026-09-15：失败从"一句自由中文"改成"带码"，码表见 server/failures.js。
    // 有这一列才回答得了"最常见的是哪种失败"，也才分得清"被拦截"与"执行后失败"。
    // 存量行留 NULL（不回溯猜测），新增行由 execTool 落码。
    statements: ['ALTER TABLE tool_calls ADD COLUMN error_code VARCHAR(32) NULL'],
  },
  {
    id: '0003_event_log', note: '事件账本（append-only，可回放）',
    // 2026-09-15：事件此前只活在内存环里（重启即忘），"确定性投影"没有可投影的源。
    // 这张表是只追加的账本：写入点唯一（server/eventlog.js），投影/重放都读它。
    // 新库路径由 db.js 的 SCHEMA 建到最终形状（含本表），故这里只对存量库生效。
    statements: [`CREATE TABLE IF NOT EXISTS events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT NULL,
      seq INT NOT NULL DEFAULT 0,
      type VARCHAR(32) NOT NULL,
      payload JSON,
      created_at DATETIME DEFAULT NOW(),
      INDEX idx_events_conv (conversation_id, id)
    )`],
  },
  {
    id: '0004_events_archive', note: '事件账本归档表（保留口径=审计账本 90 天）',
    // 2026-09-15（RA-47 未闭环项）：账本只追加不删除 ⇒ 主表无界增长。保留口径**照抄审计账本那一条**
    // （`audit_log` 的 90 天归档，见 baseline 里 A9 的注释），归档动作在 server/eventlog.js 的 archiveOldEvents，
    // 定时接线照 tools/spill.js 的 cleanupSpill 那套（启动一次 + 周期）。**不自己发明天数**。
    // 与 events 同列（保留原 id/seq 便于回放时回到原表）+ archived_at；新库路径同样由 db.js 的 SCHEMA 建到最终形状。
    statements: [`CREATE TABLE IF NOT EXISTS events_archive (
      id BIGINT NOT NULL PRIMARY KEY,
      conversation_id INT NULL,
      seq INT NOT NULL DEFAULT 0,
      type VARCHAR(32) NOT NULL,
      payload JSON,
      created_at DATETIME DEFAULT NOW(),
      archived_at DATETIME DEFAULT NOW(),
      INDEX idx_events_arch_time (created_at)
    )`],
  },
  {
    id: '0005_deliveries', note: '外部投递记录（幂等键 + 死信落点，D4/RA-42）',
    // 2026-09-16（D4 拍板 D5/D6）：外部调用一次一行。为什么**不**复用 events：那是只追加的事实账本，
    // 它值钱的地方正是"唯一写入点 / 只追加 / 投影源"三条口径（server/eventlog.js），塞进状态机会污染它；
    // 它也没有"谁调用的、试了几次、怎么重放"这三样。也**不**复用 task_contracts：那是任务契约语义，
    // 与"一次外部调用"的寿命和归属都不同。
    // `idem_key` 可空（不带幂等键的调用照记），唯一键只在"账号 + 幂等键"上——MySQL 允许多行 NULL。
    // **不设自动死信阈值**（D6）：state 只有 pending|running|succeeded|failed，failed 就是死信落点，
    // 重放＝同一个幂等键重发 POST /api/chat（不另造重放 API）。
    statements: [`CREATE TABLE IF NOT EXISTS deliveries (
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
    )`],
  },
  {
    id: '0006_contract_events_event_link', note: '契约事件并入 events 账本：投影行回指账本行（C-39 第 ② 条）',
    // 2026-09-16（v0.3 §0.5「不留两套」的过账判定，登记 C-39）：事件四处里 `contract_events` 的裁决是
    // **改造/迁移：与 `events` 同源** —— 契约状态事实此后只由 `server/eventlog.js` 的 persistContractEvent
    // 落一次账（`events` 是唯一账本），`contract_events` 是它的投影，靠 `event_id` 指回账本行。
    // **只增不删**：老行的 `event_id` 为 NULL —— 它们当年根本没进过账本，**无从回填**（不伪造来源），
    // 所以这一列可空；唯一索引允许多行 NULL，存量库因此能直接加上，不需要任何数据搬迁。
    // 新库路径由 db.js 的 SCHEMA 建到最终形状（含本列与唯一键），两条路径一起改。
    statements: [
      'ALTER TABLE contract_events ADD COLUMN event_id BIGINT NULL',
      'ALTER TABLE contract_events ADD UNIQUE KEY uk_ce_event (event_id)',
    ],
  },
  {
    id: '0007_kb_fulltext_ngram', note: '知识全文检索打底：knowledge(title, body) 建 MySQL FULLTEXT（ngram 分词）',
    // 2026-09-16（v0.3 §4.3「记忆」行「**全文检索（FTS5）打底** + 分层召回 + 受限自动沉淀；向量留接口位置后补」）：
    // 改造前的检索是 `title LIKE ? OR body LIKE ?`（`server/tools/index.js` 的 kb_search）——没有索引、
    // 没有相关度、也没有"检索后端"这一层。这一条把**介质**那一半补上：MySQL 8 的 FULLTEXT + `WITH PARSER ngram`。
    // 为什么必须是 ngram：默认全文解析器按空白/标点切词，中文整段会变成一个 token ⇒ 中文关键词搜不到
    // （本机实测 MySQL 8.0.46、ngram 插件 ACTIVE、ngram_token_size=2；`WITH PARSER ngram` 建表成功）。
    // 索引名 `ft_kb_text` 与 `server/kbsearch/fts.js` 的 INDEX_NAME、以及 db.js 建表语句**必须是同一个**
    // （改名＝三处一起改；本条与 db.js 的一致性由 test/schema-sync.test.mjs 的建表语句抠取覆盖）。
    // 只增不删：存量库加索引、不动任何数据（建索引期间 MySQL 会对该表加锁，条目量大时有秒级阻塞——
    // 这是本迁移唯一的运维代价，如实记在这里）。
    // 新库路径由 db.js 的 SCHEMA 建到最终形状（含本索引），两条路径一起改。
    statements: [`CREATE FULLTEXT INDEX ft_kb_text ON knowledge (title, body) WITH PARSER ngram`],
  },
];

const TBL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(64) PRIMARY KEY,
  note VARCHAR(200),
  applied_at DATETIME DEFAULT NOW()
)`;

/**
 * 应用待执行的迁移。
 * @returns {{applied:string[], skipped:number, tolerated:number, fresh?:boolean, failed:?{id:string, error:string}}}
 * 失败处理：**记录不落、后续不再应用、日志醒目**，但不阻断启动（与既有 fail-soft 一致；
 * 真正"关键列缺失"由 initSchema 末尾的启动自检兜底告警）。
 *
 * **全新库特例（2026-09-15）**：initSchema 先用 SCHEMA 按**最终形状**建表，迁移描述的是"老形状 → 新形状"
 * 的变化，对最终形状没有意义。所以迁移表此前不存在**且核心表也不存在**时，直接把整条链标记为已应用。
 * 不这么做会怎样（实测推演，加 0002 时发现）：新库已含 error_code，0002 的 ADD COLUMN 报重复列，
 * 而"新迁移不写 tolerate"的纪律使它**判失败并 break** —— 于是链停在 0002、**后续迁移永远不会应用**，
 * 而且每次启动都刷一条迁移失败日志。客户装机正是这条路径。
 * 与 DSH 会话格式同一思路：新文件直接写在最新版本上，不存在"迁移"这回事。
 * 判定依据是"核心表此前不存在"，不是"猜测列结构"——存量库（有表、没迁移表）必须照常走链。
 */
export async function runMigrations(pool, { versions = VERSIONS, log = console, fresh: freshOpt } = {}) {
  validateChain(versions);
  // `fresh` 由调用方在**建表之前**探测后传进来（见 db.js 的 initSchema）——那才是唯一正确的探测时机：
  // 真实启动路径上，这圈 SCHEMA 建表已经把表建好了，此时再探测恒为"不是全新库"。
  // 没传时退回"就地探测"，只适用于测试与一次性脚本。
  const fresh = freshOpt === undefined ? !(await tableExists(pool, 'tool_calls')) : !!freshOpt;
  await pool.query(TBL);
  if (fresh) {
    for (const v of versions) await pool.query('INSERT IGNORE INTO schema_migrations (id, note) VALUES (?,?)', [v.id, String(v.note || '').slice(0, 200)]);
    // log 是注入的（默认 console）：夹具可能只给 error —— 不因为少一个方法就把迁移搞崩
    if (typeof log.log === 'function') log.log('[db] 全新库：表按最终形状建立，迁移链 ' + versions.length + ' 条标记为已应用（无需逐条执行）');
    return { applied: [], skipped: versions.length, tolerated: 0, fresh: true, failed: null };
  }
  const rows = await pool.query('SELECT id FROM schema_migrations');
  const appliedIds = (rows[0] || []).map((r) => String(r.id));
  const todo = pendingMigrations(versions, appliedIds);
  const out = { applied: [], skipped: appliedIds.length, tolerated: 0, failed: null };
  for (const v of todo) {
    try {
      for (const sql of v.statements) {
        try {
          await pool.query(sql);
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (v.tolerate && v.tolerate.test(msg)) { out.tolerated++; continue; }
          throw e;
        }
      }
      await pool.query('INSERT INTO schema_migrations (id, note) VALUES (?,?)', [v.id, String(v.note || '').slice(0, 200)]);
      out.applied.push(v.id);
    } catch (e) {
      out.failed = { id: v.id, error: String((e && e.message) || e) };
      log.error('[db] 迁移 ' + v.id + ' 失败，后续迁移不再应用：' + out.failed.error);
      break;
    }
  }
  return out;
}

/** 当前 schema 版本 = 已应用的最大序号（没有记录则返回 null）。 */
export async function schemaVersion(pool) {
  try {
    const r = await pool.query('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1');
    return r[0] && r[0][0] ? String(r[0][0].id) : null;
  } catch { return null; }
}

/** 表是否存在（`SHOW TABLES LIKE`，不依赖 information_schema 的权限细节） */
async function tableExists(pool, name) {
  try {
    const r = await pool.query('SHOW TABLES LIKE ?', [name]);
    return !!(r[0] && r[0].length);
  } catch { return false; }
}
