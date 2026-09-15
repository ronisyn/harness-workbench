#!/usr/bin/env node
// scripts/migration-rehearsal.mjs —— 升级演练：在**一次性库**上造出"旧形状"，跑**真实的迁移链**（VERSIONS），
// 逐项核对"升级不丢数据"，然后删库。它是 v0.3 §0.2 **G4 出口**（"模拟一次版本升级不丢数据"）+ §7.1 ⑪ 的证据脚本。
//
// 为什么重写（上一版的问题）：上一版只跑**一条硬编码 ALTER**（`ALTER TABLE tool_calls ADD COLUMN result_bytes`），
// 根本没调用 `runMigrations()` 走 VERSIONS 链 ⇒ 它对"这条链能不能把旧库升到 HEAD"**零证据**，而 G4 要的正是这个
// （见 proposals/v0.3-符合性核对-20260916.md §1.3 ⑪ 行）。现在：真链、真 DDL、真前置/后置核对。
//
// 旧形状怎么造（选哪种、为什么）——**从迁移链自己倒推**，不手抄一份"历史 DDL"：
//   · 先 `CREATE TABLE <t> LIKE <源库>.<t>`（**只读表结构**，不读也不写源库的任何一行）拿到"最终形状"；
//   · 再把**链里每一条 `ADD COLUMN` 倒成 `DROP COLUMN`、每一条 `CREATE TABLE` 倒成 `DROP TABLE`**（只在目标存在时才动），
//     外加唯一一条无法从语句倒推的手工项 `EXTRA_UNDO_COLS`（0001 的 `MODIFY shell_tools.mode`，旧类型不在语句里）；
//   · **不建 `schema_migrations` 表** ⇒ `runMigrations` 走**存量库**路径（不是"全新库整条标记已应用"的特例，
//     否则演什么都不会发生——db.js 2026-09-16 正好踩过这个坑）。
//   为什么不"手抄旧形状"：链每加一条迁移，手抄的那份就**悄悄过期**，演练会在没人察觉的情况下变成
//   "升了一个不用升的库"（假绿）。倒推是算出来的 ⇒ 链变它跟着变；哪条语句倒推不了，前置断言就会**报红**而不是放过。
//   为什么不"只倒推 0002–0005"：那样 0001_baseline 的 40 条 ALTER 全走 tolerate 分支，"旧库升级"里最大的一段没被真跑过。
//   倒推后的形状**就是一个改造前（0001 之前）的客户机**：表在、旧列在、没有迁移表。
//
// 连接目标（显式、三步一致，2026-09-16 修）：
//   · `admin` —— **不指定默认库**，只干三件事：建一次性库、删一次性库、用 `information_schema` 复核它真的没了；
//   · `work`  —— `database=一次性库`，库里的一切（DDL/DML/核对查询、迁移链）全在它上面，不用 `USE` 切来切去。
//   一次性库名带 **pid+随机后缀**：固定名会让**两个并发演练互相删库**（实测撞过：一边 `DROP DATABASE`，
//   另一边正 `CREATE TABLE ... LIKE` → `Unknown database`；更隐蔽的一种是并发 DDL 改到了对方的表结构，
//   导致批量插入的列数与占位符对不上 → 报 SQL 语法错）。演练任何时刻都不连 `rw_test`/`rw_prod` 的**数据**。
//
// 核对项（任何一项不过 ⇒ 非零退出）：链应用顺序齐 / 无失败 / 不得走"全新库"特例 / schemaVersion=HEAD /
//   schema_migrations 条数=链长 / **每张表行数不变** / 链里每个 ADD COLUMN 都在且类型对 / CREATE 的表在且为空 /
//   DROP 的表确实不在 / 声明了字面量 DEFAULT 的列存量行都拿到了默认值 / 新增列不回溯猜测 /
//   **抽样内容与演练前逐字一致（只比旧列——新列是 NULL 或默认值，不算"改过"）** / 库确实已删。
//
// 用法：
//   node scripts/migration-rehearsal.mjs                # 默认每表 300 行
//   node scripts/migration-rehearsal.mjs --rows=30000   # 按真实体量跑，看 DDL 耗时（《数据库迁移规范》§五）
// **别把输出接 `head` / `Select-Object -First N`**：管道提前关闭会杀掉本进程、跳过 finally 里的删库，留下一座一次性库
// （脚本下次启动只会把它列出来提醒，不会自动清扫——自动清扫会把"并发演练互删"的坑挖回来）。
import mysql from 'mysql2/promise';
import { config } from '../server/config.js';
import { runMigrations, schemaVersion, VERSIONS } from '../server/migrations.js';

const SRC = String(config.db.name || '');
// 一次性库：前缀固定（人一眼认得出、便于事后排查），后缀每跑一次都不同（并发演练互不干扰）
const TMP = 'rw_mig_rehearsal_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const rowsArg = (process.argv.find((a) => a.startsWith('--rows=')) || '').split('=')[1];
// 不写或写空 ⇒ 默认 300；`--rows=0` 是**合法输入**（只塞指纹行，不塞体量行：`Number('0') || 300` 会把 0 吃掉，别写成那样）
const ROWS = rowsArg === undefined || rowsArg === '' ? 300 : Math.max(0, Number(rowsArg) || 0);
const HEAD = VERSIONS[VERSIONS.length - 1].id;

const say = (s) => console.log(s);
const bytes = (o) => JSON.stringify(o);

// 安全闸：库名必须是本脚本的一次性前缀，且绝不等于源库（绝不在应用库上演练）
if (!SRC || !/^rw_mig_rehearsal_[0-9]+_[a-z0-9]+$/.test(TMP) || TMP === SRC) {
  console.error('[中止] 一次性库名不合法或与源库相同（' + TMP + ' vs ' + SRC + '）：绝不在应用库上演练。');
  process.exit(2);
}

// 无法从迁移语句倒推的手工倒推项：旧类型不在 ALTER 文本里，只能写死一处（**新增 MODIFY 类迁移时必须来这里补**）
const EXTRA_UNDO_COLS = [['shell_tools', 'mode', 'varchar(8)']];

// ── 从迁移链**倒推**旧形状（纯函数，**在连库之前**，可用 `--plan-undo` 单独跑）────────────────────────
// 为什么倒推而不是手抄"历史形状"：见文件头。这里的纪律是**每一条链语句都必须有归宿**——要么能倒推，
// 要么被显式列为"不需要倒推"（如 DROP TABLE），要么进 unresolved 让前置断言**报红**；**不许静默跳过**。
// 2026-09-16 补索引（C-57 / 0007 真机翻车）：倒推此前只认"加列/建表"，而 `CREATE TABLE … LIKE 源库表`
// **会把索引一起复制过来** ⇒ 链里的 `CREATE FULLTEXT INDEX ft_kb_text`（0007）在旧形状里已经存在，
// 迁移报 `Duplicate key name` 并停在该步。现在 `ADD … KEY/INDEX` 与 `CREATE … INDEX … ON …` 都倒推成 `DROP INDEX`。
/** 把一个语句分类（纯函数）。返回 {kind,table,name} 或 {kind:'unresolved',reason}——reason 要说清"手工项该加什么" */
function classifyStatement(sql) {
  const s = String(sql).trim();
  let m;
  // ① 加列
  if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD COLUMN\s+`?(\w+)`?/i.exec(s))) return { kind: 'column', table: m[1], name: m[2] };
  // ② 加索引（ALTER 形式：ADD [UNIQUE|FULLTEXT|SPATIAL] KEY|INDEX <名字>）
  if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?/i.exec(s))) return { kind: 'index', table: m[1], name: m[2] };
  // ③ 加索引（CREATE 形式：CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX <名字> ON <表>）——0007 就是这一种
  if ((m = /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(s))) return { kind: 'index', table: m[2], name: m[1] };
  // ④ 建表
  if ((m = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?/i.exec(s))) return { kind: 'table', table: m[1] };
  // ⑤ 删表：**不需要倒推**（旧形状里本就可能没有；后置核对会断言它确实不在），但要显式识别，不当"没归宿"
  if ((m = /^DROP TABLE(?:\s+IF EXISTS)?\s+`?(\w+)`?/i.exec(s))) return { kind: 'table-drop', table: m[1] };
  // ⑥ 改列：旧类型不在语句里 ⇒ 只能靠 EXTRA_UNDO_COLS 手工项兜底（找不到就必须 unresolved）
  if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+MODIFY COLUMN\s+`?(\w+)`?/i.exec(s))) return { kind: 'modify-column', table: m[1], name: m[2] };
  return {
    kind: 'unresolved',
    reason: '推导不出倒推动作，也没被显式豁免：' + s.replace(/\s+/g, ' ').slice(0, 90)
      + '（要么给倒推逻辑加一条分类，要么进 EXTRA_UNDO_COLS 手工项——**不许静默放过**）',
  };
}

/** 倒推动作的 DDL 文本（人读 + 夹具断言用；实际执行走下面那段"只在目标存在时才动"的代码） */
function undoDdl(op) {
  if (op.kind === 'column') return 'ALTER TABLE ' + op.table + ' DROP COLUMN ' + op.name;
  if (op.kind === 'index') return 'DROP INDEX ' + op.name + ' ON ' + op.table;
  if (op.kind === 'modify-column') return null; // 旧类型不在语句里（靠 EXTRA_UNDO_COLS 手工项，见 resolveStatement）
  return 'DROP TABLE IF EXISTS ' + op.table;
}

/**
 * 一条语句在"倒推"这件事上的**归宿**（纯函数；`chainUndo` 与 `--classify` 共用同一份判断，不许两处判得不一样）：
 *   {kind:'op', op}            → 能倒推，op 里带 undo DDL
 *   {kind:'exempt', reason}    → 显式识别、确实不需要倒推（如 DROP TABLE）
 *   {kind:'unresolved', reason}→ **没归宿**：调用方必须报红，reason 说清"手工项该加什么"
 */
function resolveStatement(sql) {
  const c = classifyStatement(sql);
  if (c.kind === 'table-drop') return { kind: 'exempt', classify: c, reason: '删表：不需要倒推（旧形状里本就可能没有；后置核对断言它确实不在）' };
  if (c.kind === 'unresolved') return { kind: 'unresolved', classify: c, reason: c.reason };
  if (c.kind === 'modify-column') {
    // 旧类型不在 ALTER 文本里 ⇒ 只能靠手工项；**找不到就必须 unresolved**（这是"不许静默放过"的关键一条）
    const hit = EXTRA_UNDO_COLS.find(([t, col]) => t === c.table && col === c.name);
    if (!hit) return { kind: 'unresolved', classify: c, reason: '改列（MODIFY COLUMN ' + c.table + '.' + c.name + '）：旧类型不在语句里 ⇒ EXTRA_UNDO_COLS 里补 [\'' + c.table + '\',\'' + c.name + '\',\'<旧类型>\']' };
    return { kind: 'exempt', classify: c, reason: '改列：由 EXTRA_UNDO_COLS 手工项还原为 ' + hit[2] };
  }
  return { kind: 'op', classify: c, op: { ...c, undo: undoDdl(c) } };
}

/**
 * 从迁移链**倒推**旧形状（纯函数，默认倒推真实的 VERSIONS）。
 * 返回 {ops, exempt, unresolved}：ops 已按**倒推顺序**（链的反序）排好；exempt 是"显式识别但不需要倒推"的；
 * unresolved 非空 ⇒ 调用方**必须报红**（前置断言），不许放过。
 */
function chainUndo(versions = VERSIONS) {
  const ops = [];
  const exempt = [];
  const unresolved = [];
  for (const v of [...versions].reverse()) for (const sql of [...(v.statements || [])].reverse()) {
    const r = resolveStatement(sql);
    if (r.kind === 'op') ops.push(r.op);
    else if (r.kind === 'exempt') exempt.push({ sql, reason: r.reason });
    else unresolved.push({ sql, reason: r.reason });
  }
  return { ops, exempt, unresolved };
}

/** 从迁移链**推导**它改过结构的表（唯一事实源=链本身；手抄一份必然随链漂移）。只被 DROP 的表不算。 */
function chainTables() {
  const out = new Set();
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const c = classifyStatement(sql);
    if (c.kind === 'column' || c.kind === 'index' || c.kind === 'table' || c.kind === 'modify-column') out.add(c.table);
  }
  return [...out];
}

// `--plan-undo` / `--classify`：**不连库**的 dry-run（夹具与排障用；也是"倒推对索引不再瞎"的可核验出口）
//   node scripts/migration-rehearsal.mjs --plan-undo            # 打印整条链的倒推计划（有 unresolved 即 exit 1）
//   node scripts/migration-rehearsal.mjs --classify "<一条 SQL>"  # 单条语句怎么倒推（同上）
if (process.argv.includes('--plan-undo') || process.argv.includes('--classify')) {
  const at = process.argv.indexOf('--classify');
  const out = at >= 0
    ? (() => {
        const sql = process.argv[at + 1] || '';
        const r = resolveStatement(sql);
        return { sql, verdict: r.kind, classify: r.classify, undo: r.op ? r.op.undo : null, reason: r.reason || '', unresolved: r.kind === 'unresolved' ? [r.reason] : [] };
      })()
    : (() => {
        const { ops, exempt, unresolved } = chainUndo();
        return { head: HEAD, ops, exempt, unresolved };
      })();
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.unresolved.length ? 1 : 0);
}

const admin = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, connectTimeout: 8000 });
let work = null; // 建库之后才有（显式绑定一次性库）
const mq = async (sql, params) => (await admin.query(sql, params))[0]; // admin：元数据 / 库生命周期
const q = async (sql, params) => (await work.query(sql, params))[0];   // work：一次性库里的一切
const dbExists = async (name) => (await mq('SELECT COUNT(*) c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [name]))[0].c > 0;
const tableExists = async (db, t) => (await mq('SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [db, t]))[0].c > 0;
const colOf = async (t, c) => (await mq('SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?', [TMP, t, c]))[0];
const colsOf = async (t) => mq('SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [TMP, t]);
const countOf = async (t) => Number((await q('SELECT COUNT(*) c FROM `' + t + '`'))[0].c);
const pkOf = async (t) => (await mq("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_KEY='PRI' ORDER BY ORDINAL_POSITION", [TMP, t])).map((r) => r.COLUMN_NAME);
/** 一次性库里某个索引在不在（倒推索引与前置断言共用） */
const indexOf = async (t, name) => Number((await mq('SELECT COUNT(*) c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=?', [TMP, t, name]))[0].c) > 0;

let verdict = { ok: false, checks: [], note: '未跑完' };
let dropped = false;
try {
  say('== 0. 安全闸与连接 ==');
  say(`   源库（**只读表结构**，不碰任何一行）：${SRC} @ ${config.db.host}:${config.db.port}`);
  say(`   一次性库：${TMP} · 每表 ${ROWS} 行体量 · admin 连接=无默认库（只管建/删/复核）· work 连接=一次性库`);
  // 遗留的演练库**只报告、不清扫**（可能是另一个实例正在跑，自动 DROP 就等于把并发互删的坑又挖回来）。
  // 常见的成因：上次演练被强杀/管道提前关闭（`node … | head`、`| Select-Object -First N`），finally 没跑到。
  const leftovers = (await mq("SELECT SCHEMA_NAME n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'rw_mig_rehearsal%' AND SCHEMA_NAME <> ?", [TMP])).map((r) => r.n);
  if (leftovers.length) say('   ⚠️ 有遗留的一次性演练库（上个演练没跑完 finally）：' + leftovers.join(', ') + ' —— 确认没有演练在跑后手工 DROP DATABASE 即可');

  say('== 1. 建一次性库（admin 连接）==');
  await mq(`DROP DATABASE IF EXISTS \`${TMP}\``);
  await mq(`CREATE DATABASE \`${TMP}\` CHARACTER SET utf8mb4`);
  work = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, database: TMP, connectTimeout: 8000 });
  say(`   已建 + work 连接已绑定（SELECT DATABASE() = ${(await q('SELECT DATABASE() d'))[0].d}）`);

  say('== 2. 造"旧形状"：照源库复制表结构 → 按链倒推（元数据读，不碰源库任何一行）==');
  const tables = chainTables();
  const copied = [];
  for (const t of tables) {
    const inSrc = await tableExists(SRC, t);
    const inChain = (VERSIONS.flatMap((v) => v.statements || []).some((s) => new RegExp('^\\s*CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+' + t + '\\b', 'i').test(s)));
    if (!inSrc) {
      // 链里每张被 ALTER 的表都必须先在源库里存在；只有"链自己建的表"（events/deliveries…）允许不在
      if (!inChain) throw new Error('源库 ' + SRC + ' 里没有表 ' + t + '：演练无从谈起（先确认 DB_NAME 指向应用库）');
      continue;
    }
    await mq(`CREATE TABLE \`${TMP}\`.\`${t}\` LIKE \`${SRC}\`.\`${t}\``);
    copied.push(t);
  }
  const { ops, exempt, unresolved } = chainUndo();
  let undone = 0;
  for (const op of ops) {
    // 口径一致："只在目标存在时才动"（源库可能已经是旧形状，或这条根本还没应用过）
    if (op.kind === 'table') { await q(`DROP TABLE IF EXISTS \`${op.table}\``); undone++; }
    else if (op.kind === 'index' && await indexOf(op.table, op.name)) { await q(`DROP INDEX \`${op.name}\` ON \`${op.table}\``); undone++; }
    else if (op.kind === 'column' && await colOf(op.table, op.name)) { await q(`ALTER TABLE \`${op.table}\` DROP COLUMN \`${op.name}\``); undone++; }
  }
  for (const [t, c, oldType] of EXTRA_UNDO_COLS) {
    if (await colOf(t, c)) { await q(`ALTER TABLE \`${t}\` MODIFY COLUMN \`${c}\` ${oldType} NOT NULL`); undone++; }
  }
  say(`   复制 ${copied.length} 张表结构，倒推 ${undone} 处（链里已算过 ${ops.length} 处——列/索引/表，手工项 ${EXTRA_UNDO_COLS.length} 处）`);
  if (exempt.length) say('   （链里显式识别、不需要倒推的语句 ' + exempt.length + ' 条：' + exempt.map((e) => e.reason.split('：')[0]).join(' / ') + '）');

  say('== 3. 前置断言：旧形状**确实**是旧的（否则演练会变成假绿）==');
  const pre = [];
  const preCheck = (name, ok, detail) => { pre.push({ name, ok: !!ok, detail }); say(`   ${ok ? '✅' : '❌'} ${name}${detail ? '：' + detail : ''}`); };
  // 倒推不出来的语句 ⇒ **在这里报红**（不许静默放过）：链新增了一种 DDL，倒推逻辑就必须同步长出来
  preCheck('链里每条语句都能倒推或被显式豁免（' + (ops.length + exempt.length) + '/' + (ops.length + exempt.length + unresolved.length) + '）',
    unresolved.length === 0, unresolved.map((u) => u.reason).join('；'));
  for (const op of ops) {
    if (op.kind === 'table') preCheck('旧形状没有 ' + op.table + ' 表', !(await tableExists(TMP, op.table)));
    else if (op.kind === 'index') preCheck('旧形状没有索引 ' + op.name + '（表 ' + op.table + '）', !(await indexOf(op.table, op.name)));
    else preCheck('旧形状没有 ' + op.table + '.' + op.name, !(await colOf(op.table, op.name)));
  }
  for (const [t, c, oldType] of EXTRA_UNDO_COLS) {
    const col = await colOf(t, c);
    preCheck(t + '.' + c + ' 是旧类型 ' + oldType, col && col.COLUMN_TYPE === oldType, col && col.COLUMN_TYPE);
  }
  preCheck('没有 schema_migrations 表（走存量库路径，不是"全新库"特例）', !(await tableExists(TMP, 'schema_migrations')));
  if (pre.some((c) => !c.ok)) throw new Error('旧形状没造出来：见上面 ❌（链变了就必须同步倒推逻辑，不许放过）');

  say('== 4. 塞可核对的样例行（指纹行：小 id + 真值；体量行：生成值）==');
  // 指纹行：这几列的值演练前后必须**逐字一致**（给到的列若不在旧形状里会被自动忽略，见 rowParams）。
  const FINGERPRINTS = [
    ['conversations', { id: 1, account_id: 1, channel: 'web', title: '演练会话', mode: 'chat', preset: 'all', provider: 'deepseek', model: 'm-1', project: 'default', permission: 'write' }],
    ['messages', { id: 1, conversation_id: 1, role: 'assistant', content: '演练正文', model: 'deepseek-v4', provider: 'deepseek', tokens_in: 11, tokens_out: 22 }],
    ['tool_calls', { id: 1, conversation_id: 1, message_id: 1, tool_name: 'read_file', args: { path: 'a.md' }, result_summary: '{"ok":true}', result_bytes: 123, duration_ms: 45, status: 'ok' }],
    ['usage_stats', { id: 1, account_id: 1, conversation_id: 1, message_id: 1, provider_id: 'deepseek', model_id: 'm-1', tokens_in: 11, tokens_out: 22, cost: 0.0012, cache_hit_tokens: 3, cache_miss_tokens: 42 }],
    ['audit_log', { id: 1, account_id: 1, action: 'chat', detail: '演练审计' }],
    ['audit_log_archive', { id: 1, account_id: 1, action: 'chat', detail: '演练归档' }],
    ['knowledge', { id: 1, account_id: 1, scope: 'global', title: '演练知识', body: '正文' }],
    ['reviews', { id: 1 }],
    ['shells', { id: 1, skey: 'rehearsal', name: '演练壳', tools_preset: 'standard', status: 'enabled' }],
    ['shell_tools', { shell_id: 1, tool_name: 'read_file', mode: 'force_on' }],
  ];
  let seq = 0; // 生成值用全局序号：字符串列天然不重复（避开 UNIQUE 键）
  const isInt = (t) => ['int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'float', 'double'].includes(t);
  /** 按**当前（旧）形状**的列结构生成一行参数：given 里的列用真值，其余列按类型填（NOT NULL 列不能不填）。
   *  列结构由调用方**取一次传进来**（每行查一次 information_schema 在 SSH 隧道上等于把自己拖死）。 */
  function rowParams(cols, given) {
    const names = [];
    const params = [];
    for (const c of cols) {
      const isAuto = String(c.EXTRA || '').includes('auto_increment');
      if (isAuto && given[c.COLUMN_NAME] === undefined) continue; // 自增且没指定 → 交给库分配
      names.push(c.COLUMN_NAME);
      if (given[c.COLUMN_NAME] !== undefined) {
        const g = given[c.COLUMN_NAME];
        // JSON 列必须先序列化：直接把对象绑上去会被驱动当成 `key = value` 片段（同 session-export 的 bind 口径）
        params.push(c.DATA_TYPE === 'json' && typeof g !== 'string' ? bytes(g) : g);
        continue;
      }
      seq++;
      if (c.DATA_TYPE === 'json') params.push(bytes({ k: seq }));
      else if (isInt(c.DATA_TYPE)) params.push(seq);
      else if (['datetime', 'timestamp', 'date'].includes(c.DATA_TYPE)) params.push(new Date('2026-09-01T00:00:00Z'));
      else params.push('x' + seq);
    }
    return { names, params };
  }
  const seeded = [];
  for (const [table, given] of FINGERPRINTS) {
    if (!(await tableExists(TMP, table))) throw new Error('指纹行落在不存在的表上：' + table);
    const cols = await colsOf(table); // 每表只取一次列结构
    const { names, params } = rowParams(cols, given);
    await q('INSERT INTO `' + table + '` (' + names.map((n) => '`' + n + '`').join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')', params);
    seeded.push(table);
    if (!ROWS) continue;
    // 体量行：批量插（每条语句约 500 个占位符），只为"行数不变"与 DDL 耗时有个像样的体量
    const bulk = rowParams(cols, {});
    const chunk = Math.max(1, Math.floor(500 / bulk.names.length));
    const one = '(' + bulk.names.map(() => '?').join(',') + ')';
    for (let i = 0; i < ROWS; i += chunk) {
      const n = Math.min(chunk, ROWS - i);
      const flat = [];
      for (let k = 0; k < n; k++) flat.push(...rowParams(cols, {}).params);
      // 自检：列数与参数数必须严格对上（对不上会让占位符留在 SQL 里，报出来的是莫名其妙的"语法错"）
      if (flat.length !== n * bulk.names.length) throw new Error('批量插入自检失败：' + table + ' 列 ' + bulk.names.length + ' × 行 ' + n + ' ≠ 参数 ' + flat.length);
      await q('INSERT INTO `' + table + '` (' + bulk.names.map((c) => '`' + c + '`').join(',') + ') VALUES ' + Array.from({ length: n }, () => one).join(','), flat);
    }
  }
  say(`   指纹行 ${FINGERPRINTS.length} 张表各 1 行；体量行 ${ROWS} 行/表（涉及 ${seeded.length} 张表）`);

  const sampleOf = async (t, cols) => {
    const list = cols || (await colsOf(t)).map((c) => c.COLUMN_NAME);
    const pk = await pkOf(t);
    return { cols: list, rows: await q('SELECT ' + list.map((c) => '`' + c + '`').join(',') + ' FROM `' + t + '` ORDER BY ' + pk.map((c) => '`' + c + '`').join(',') + ' LIMIT 200') };
  };
  const sampleTables = FINGERPRINTS.map(([t]) => t);
  const beforeCounts = {};
  for (const t of await q('SHOW TABLES')) { const name = Object.values(t)[0]; beforeCounts[name] = await countOf(name); }
  const beforeSamples = {};
  for (const t of sampleTables) beforeSamples[t] = await sampleOf(t);
  say('   演练前：' + bytes(beforeCounts));

  say('== 5. 跑**真实迁移链** runMigrations()（存量库路径）==');
  const logLines = [];
  const t0 = Date.now();
  // fresh 显式传 false：真实启动路径由 initSchema 在**建表之前**探测后传入；这里表已经在（旧形状）⇒ 等价于 false。
  // 不传的话会走"就地探测"，万一探测出 true，整条链会被标记为"已应用"而**一条都不跑**——演练就白跑了。
  const run = await runMigrations(work, { fresh: false, log: { log: (m) => logLines.push(m), error: (m) => logLines.push(m) } });
  const ms = Date.now() - t0;
  say(`   applied=[${run.applied.join(', ')}] skipped=${run.skipped} tolerated=${run.tolerated} failed=${run.failed ? run.failed.id : 'null'} · 耗时 ${ms}ms`);
  for (const l of logLines) say('   [迁移日志] ' + l);

  say('== 6. 逐项核对 ==');
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); say(`   ${ok ? '✅' : '❌'} ${name}${detail !== undefined && detail !== '' ? '：' + detail : ''}`); };

  check('链的应用顺序 = VERSIONS 顺序（一条不漏、一条不多）', bytes(run.applied) === bytes(VERSIONS.map((v) => v.id)), '[' + run.applied.join(', ') + ']');
  check('迁移无失败', run.failed === null, run.failed ? run.failed.id + ' -> ' + run.failed.error : '无');
  check('不得走"全新库"特例（那样一条 DDL 都不会跑）', run.fresh === undefined, 'fresh=' + run.fresh);
  const sv = await schemaVersion(work);
  check('schemaVersion 到 HEAD', sv === HEAD, sv + '（HEAD=' + HEAD + '）');
  const migCount = Number((await q('SELECT COUNT(*) c FROM schema_migrations'))[0].c);
  check('schema_migrations 条数 = 链长', migCount === VERSIONS.length, migCount + '/' + VERSIONS.length);

  for (const [t, n] of Object.entries(beforeCounts)) {
    const now = (await tableExists(TMP, t)) ? await countOf(t) : -1;
    check('行数不变：' + t, now === n, now + '（演练前 ' + n + '）');
  }
  // 链里每个 ADD COLUMN 都必须在（口径同 db.js 启动自检：列清单**从链推导**）
  let added = 0;
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const m = /^\s*ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+([A-Za-z]+(?:\([\d,]+\))?)/i.exec(sql);
    if (!m) continue;
    added++;
    const col = await colOf(m[1], m[2]);
    // 类型也核（列在但类型错 = 迁移写错了，照样算不过）：MySQL 8 的 INT 不带宽，逐字比；带宽度差异时比基类型
    const same = col && (col.COLUMN_TYPE.toLowerCase() === m[3].toLowerCase() || col.COLUMN_TYPE.toLowerCase().split('(')[0] === m[3].toLowerCase().split('(')[0]);
    check('链加的列在且类型对：' + m[1] + '.' + m[2], same, col ? col.COLUMN_TYPE : '缺列');
  }
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const cr = /^\s*CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/i.exec(sql);
    if (cr) check('链建的表在且为空：' + cr[1], (await tableExists(TMP, cr[1])) && (await countOf(cr[1])) === 0);
    const dr = /^\s*DROP TABLE(?:\s+IF EXISTS)?\s+(\w+)/i.exec(sql);
    if (dr) check('链删的表确实不在：' + dr[1], !(await tableExists(TMP, dr[1])));
  }
  check('链加的列数 > 0（否则上面那圈核对是空的）', added > 0, added + ' 列');
  // 链里加的**索引**也必须在（与列同口径：清单从链推导）。2026-09-16 补（C-57）：此前只有列被核对，
  // 索引两头没人管——旧形状没被摘掉（本步迁移直接报 Duplicate key name）、升级后有没有建起来也没人看。
  let idxAdded = 0;
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const c = classifyStatement(sql);
    if (c.kind !== 'index') continue;
    idxAdded++;
    check('链加的索引在：' + c.name + '（表 ' + c.table + '）', await indexOf(c.table, c.name));
  }
  check('链加的索引数 > 0（同上，防空跑）', idxAdded > 0, idxAdded + ' 个');
  // 关键列**有值**：链里声明了字面量 DEFAULT 的列，存量行必须拿到那个默认值（不是 NULL、也不是别的）
  let defChecked = 0;
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const m = /^\s*ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+[A-Za-z]+(?:\([\d,]+\))?[^,]*?DEFAULT\s+(\d+|'[^']*')/i.exec(sql);
    if (!m) continue;
    const lit = /^\d+$/.test(m[3]) ? Number(m[3]) : m[3].slice(1, -1);
    defChecked++;
    const bad = Number((await q('SELECT COUNT(*) c FROM `' + m[1] + '` WHERE `' + m[2] + '` IS NULL OR `' + m[2] + '` <> ?', [lit]))[0].c);
    check('存量行的默认值到位：' + m[1] + '.' + m[2] + ' = ' + bytes(lit), bad === 0, bad + ' 行不符');
  }
  check('默认值核对项 > 0（同上，防空跑）', defChecked > 0, defChecked + ' 列');
  // 新增列**不回溯猜测**：存量行留 NULL（0002 的 error_code 是唯一有语义的新列）
  if (await colOf('tool_calls', 'error_code')) {
    const n = Number((await q('SELECT COUNT(*) c FROM tool_calls WHERE error_code IS NOT NULL'))[0].c);
    check('存量行 error_code 未被回溯编造（全 NULL）', n === 0, n + ' 行非空');
  }
  // 抽样逐字一致（只比**旧列**：新列是 NULL/默认，不算"改过"）
  for (const t of sampleTables) {
    const before = beforeSamples[t];
    const after = await sampleOf(t, before.cols);
    const same = before.rows.length > 0 && bytes(before.rows) === bytes(after.rows);
    check('抽样逐字一致：' + t + '（' + before.cols.length + ' 列 × ' + before.rows.length + ' 行）',
      same, before.rows.length ? (same ? '一致' : '内容变了') : '抽样为空（这条核对没有意义）');
  }
  // 观察项（不影响判定）：升级库与**源库**之间的**索引**漂移。链只加列、不会补索引，所以"照 SCHEMA 建的新库有
  // 索引、升级来的库没有"这种漂移只能靠眼看。注意口径：这是**相对源库**的比对，源库自己若也是升级来的，
  // 它已经缺的索引这里看不见（rw_test 的 audit_log 就缺 idx_audit_time/idx_audit_conv，正是这么缺的）。
  const drift = [];
  for (const t of copied) {
    const idx = async (db) => (await mq('SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [db, t])).map((r) => r.INDEX_NAME + '(' + r.COLUMN_NAME + ')').sort().join(' ');
    const a = await idx(SRC);
    const b = await idx(TMP);
    if (a !== b) drift.push(t + '：源库[' + a + '] vs 升级后[' + b + ']');
  }
  if (drift.length) say('   ⚠️ 观察项（不影响本次判定）：升级库与源库的索引不一致 → ' + drift.join(' | '));

  verdict = { ok: checks.every((c) => c.ok) && pre.every((c) => c.ok), checks, pre, drift, applied: run.applied, ms, rows: ROWS, head: HEAD, db: TMP };
  say('== 7. 结构化结论 ==');
  say(bytes({ ok: verdict.ok, head: HEAD, applied: run.applied, skipped: run.skipped, tolerated: run.tolerated, failed: run.failed, rowsPerTable: ROWS, ddlMs: ms, tables: Object.keys(beforeCounts).length, checksFailed: checks.filter((c) => !c.ok).map((c) => c.name), observationIndexDrift: drift }));
} catch (e) {
  verdict = { ...verdict, ok: false, note: '演练中断：' + ((e && e.message) || e) };
  console.error('[失败] ' + ((e && e.stack) || e));
} finally {
  // 收尾三步都在 **admin 连接**上（用 work 连接去删自己所在的库是自找麻烦）：
  // ① 断开 work（库要被删了，先松手）→ ② admin 上 DROP → ③ admin 上**复核它真的没了**（这一步才是"删干净了"的证据）
  try { if (work) await work.end(); } catch { /* 已断就不用管 */ }
  try {
    await mq(`DROP DATABASE IF EXISTS \`${TMP}\``);
    dropped = !(await dbExists(TMP));
    say(`== 8. 一次性库已删除并复核：${TMP} ${dropped ? '（admin 连接查 information_schema：不存在 ✅）' : '（❌ 仍然存在，需手工 DROP）'}==`);
  } catch (e) {
    console.error('[清理失败] ' + ((e && e.message) || e) + '：请手工 DROP DATABASE ' + TMP);
  }
  try { await admin.end(); } catch { /* 同上 */ }
}
// 判定只看两件事实：核对项全过 + 一次性库确实删掉了（库留着 = 这次演练没收干净，同样算未通过）
if (!dropped) verdict = { ...verdict, ok: false, note: (verdict.note && verdict.note !== '未跑完' ? verdict.note + '；' : '') + '一次性库没删干净' };
say(`\n演练判定：${verdict.ok ? '**通过**（真实迁移链把旧形状升到 ' + HEAD + '，行数/抽样内容逐项一致，无丢数据，一次性库已删）' : '**未通过**' + (verdict.note ? '（' + verdict.note + '）' : '')}`);
process.exit(verdict.ok ? 0 : 1);
