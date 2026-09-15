// test/schema-sync.test.mjs - 两条建库路径必须等价：`db.js` 的建表语句 vs `migrations.js` 的迁移链
//
// 为什么必须有这条（2026-09-16，Windows 端到端实测撞出来的**装机阻断**）：
// 平台有两条建库路径 —— 全新库走 `db.js` 的 `CREATE TABLE`（"按最终形状建表"），存量库走 `migrations.js` 的 ALTER 链。
// 两条路径的形状本该一样，但**全靠人肉同步**（migrations.js 头部那句"两处都改才算完整"）。实测它们已经漂移 14 列：
// 全新库建出来的 `conversations` 连 `provider` 都没有 ⇒ 客户机（或任何新机器）装完第一次建会话就
// `Unknown column 'provider' in 'field list'`，而且因为 Express 4 不接 async 拒绝，请求**永久挂住**。
// 这不是 Windows 特有：纯数据库路径，Linux 全新装机同款。
//
// 判据（只判可判的那一半，不用连库、不用解析 SQL 语法树）：
//   迁移链里每一条 `ALTER TABLE t ADD COLUMN c` / `CREATE TABLE t`，都必须在 `db.js` 的建表语句里能找到
//   对应的列/表 —— 否则"全新库"就少了它。
//   **列的反方向判不了**（SCHEMA 里有、链里没有的列，无从知道它是不是"改造前基线"就有的）——所以运行时那条
//   "关键列缺失"自检仍然保留，且现在直接从链里推导（见 server/db.js），两条合起来才盖住两个方向。
//
// ── 2026-09-16 扩到索引（登记 C-48：「迁移链只加列、不补索引 ⇒ 升级来的库一直在悄悄丢索引」）──────
// 索引**不能**照搬列那条"只判一个方向"的口径：列缺失是**正确性**问题（查询当场 Unknown column），
// 而索引缺失是**性能**问题——链里没有的索引，升级来的库上就是**永远没有**，且不报任何错。
// 口径（**判据的定义域是推导出来的，不是手抄清单**）：
//   · 判什么：表级索引声明（`KEY/INDEX n (…)` / `UNIQUE KEY` / `FULLTEXT KEY … WITH PARSER ngram` /
//     `SPATIAL KEY` / 表级与列级的 `PRIMARY KEY`）。索引身份＝(表, 索引名)，值＝类型 + **列顺序**。
//   · 列级内联的唯一约束（`shells.skey VARCHAR(32) UNIQUE NOT NULL`）不进判据：它在两条路径上是**同一句
//     建表语句**，没有第二条路径可言（真库只读探针：`accounts.username` / `providers.provider_key` /
//     `shells.skey` 三条都实际存在）。
//   · **PRIMARY KEY 不进判据**：它随 `CREATE TABLE` 一起产生，`CREATE INDEX` 建不出主键；表在则主键必在。
//   · 参与比对的条件＝**"链已经在为这张表产生索引"**（`ChainOwnedTables`：链里至少有一条针对它的建索引语句，
//     或链 `CREATE TABLE` 时就内联声明了索引）。这就是判据的定义域：链既然管了这张表的索引，就必须**管全**
//     ——SCHEMA 声明的索引集合与链累计产生的集合**逐条相等**（含列顺序与类型），多一条少一条都判红。
//   · 不在定义域里的表＝**索引全部来自链之前的建表语句**（改造前基线），链从来不管它们的索引。逐表核过一遍
//     （下面第 2 条夹具把它钉死，防"定义域缩水"）分成两类，都不该、也不能由链再建一遍：
//       ① 链从头到尾没碰过的 12 张（`messages`/`reviews`/`models`/`market_snapshot`/… ）——只读探针复核真库
//          声明的索引一条没缺；
//       ② 链只 `ALTER` 过、自己没建过的 1 张：`contract_events`（0006 建的是列与唯一键）。它的
//          `idx_ce_contract` 随那张表**诞生时的建表语句**落库（真库探针：在），与 ① 同类；
//          且 `test/contract-events-source.test.mjs` 刻意锁着"涉及 contract_events 的迁移只有一条"
//          （再加一条就得有人问为什么）——**这条边界是有意的，不是漏了**。
// 这套判据抓到的真实缺口（本批修复，见 migrations.js 的 `0008_indexes_of_baseline_tables`）：
//   `audit_log` / `audit_log_archive` / `usage_stats` 三张存量表共 6 条索引，外加 `knowledge` 的
//   `idx_kb_scope` 与 `idx_kb_shell`（同因）。只读探针实测真库 `rw_test` 缺其中 5 条：
//   `idx_audit_time` / `idx_audit_conv` / `idx_usage_time` / `idx_usage_conv` / `idx_kb_shell`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS } from '../server/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

// CREATE TABLE 的抠取口径：db.js 的建表语句写在模板字符串里、缩进规整，按行取行首标识符。
const CREATE_TABLE_RE = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)`/g;
const KEY_FIRST = /^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL)$/i;

// 从 db.js 源码里抠出每个 CREATE TABLE 的列名（**列判据**用）
function schemaTables(src) {
  const out = new Map();
  for (const m of src.matchAll(CREATE_TABLE_RE)) {
    const cols = new Set();
    for (const raw of m[2].split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const first = line.split(/[\s(]+/)[0].replace(/,$/, '');
      if (KEY_FIRST.test(first)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) cols.add(first);
    }
    out.set(m[1], cols);
  }
  return out;
}

/**
 * 建表语句里的**表级索引声明**（纯函数；schemaIndexes 与 chainIndexes **共用同一份判断**——抠取口径
 * 只要有两份，比出来的就是抠取方式的差异，不是 schema 的差异）。
 * 认这几种：`KEY n (…, …)` / `INDEX n (…)` / `UNIQUE KEY n (…)` / `FULLTEXT KEY n (…) WITH PARSER ngram` /
 * `SPATIAL KEY n (…)` / 表级 `PRIMARY KEY (…)` / 列级内联 `id INT … PRIMARY KEY`。返回 {name, type, cols} 或 null。
 */
function parseIndexLine(line) {
  let m;
  if ((m = /^(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(line))) {
    const type = m[1] ? m[1].trim().toUpperCase() : 'INDEX';
    return { name: m[2], type, cols: m[3].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) };
  }
  if ((m = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line))) {
    return { name: 'PRIMARY', type: 'PRIMARY', cols: m[1].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) };
  }
  if ((m = /^`?(\w+)`?\s+[\s\S]*\bPRIMARY\s+KEY\b/i.exec(line))) {
    return { name: 'PRIMARY', type: 'PRIMARY', cols: [m[1]] };
  }
  return null;
}

/** 一段建表主体（括号内）里声明的索引：Map<索引名, {name, type, cols}> */
function indexesInBody(body) {
  const map = new Map();
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue;
    const idx = parseIndexLine(line);
    if (idx) map.set(idx.name, idx);
  }
  return map;
}

/** db.js 的 SCHEMA 声明的索引集合：Map<表, Map<索引名, {type, cols}>> */
function schemaIndexes(src) {
  const out = new Map();
  for (const m of src.matchAll(CREATE_TABLE_RE)) out.set(m[1], indexesInBody(m[2]));
  return out;
}

/**
 * 迁移链**累计产生**的索引集合。三类来源，缺一不可：
 *   ① 链里 `CREATE TABLE` 内联声明的索引（建表即建索引）；
 *   ② `ALTER TABLE … ADD [UNIQUE|FULLTEXT|SPATIAL] KEY|INDEX <名> (列…)`（0006 的 uk_ce_event）；
 *   ③ `CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX <名> ON <表> (列…)`（0007 起补索引用的都是这一种）。
 * `DROP INDEX … ON …` 从累计集合里减掉（链里目前没有，口径要完整——将来有了不能假绿）。
 */
function chainIndexes(versions) {
  const out = new Map();
  const put = (t, idx) => {
    if (!out.has(t)) out.set(t, new Map());
    out.get(t).set(idx.name, idx);
  };
  for (const v of versions) {
    for (const stmt of v.statements || []) {
      const s = String(stmt).trim();
      let m;
      if ((m = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*)\)$/i.exec(s))) {
        for (const idx of indexesInBody(m[2]).values()) put(m[1], idx);
        continue;
      }
      if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:CONSTRAINT\s+`?\w+`?\s+)?(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(s))) {
        put(m[1], { name: m[3], type: m[2] ? m[2].trim().toUpperCase() : 'INDEX', cols: m[4].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        continue;
      }
      if ((m = /^CREATE\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(s))) {
        put(m[3], { name: m[2], type: m[1] ? m[1].trim().toUpperCase() : 'INDEX', cols: m[4].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        continue;
      }
      if ((m = /^DROP\s+INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(s))) {
        if (out.has(m[2])) out.get(m[2]).delete(m[1]);
      }
    }
  }
  return out;
}

const SCHEMA = schemaTables(DB_SRC);
const SCHEMA_IDX = schemaIndexes(DB_SRC);
const CHAIN_IDX = chainIndexes(VERSIONS);
/** 链自己 `CREATE TABLE` 建的表（这些表的索引由链负责；其余表的索引来自链之前的建表语句） */
function chainCreatedTables(versions) {
  const out = new Set();
  for (const v of versions) {
    for (const stmt of v.statements || []) {
      const m = /^\s*CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?/i.exec(String(stmt));
      if (m) out.add(m[1]);
    }
  }
  return out;
}
const CHAIN_CREATED = chainCreatedTables(VERSIONS);
const nonPrimary = (map) => [...(map || new Map()).values()].filter((v) => v.name.toUpperCase() !== 'PRIMARY');
const sig = (v) => v.type + '(' + v.cols.join(',') + ')';
const listing = (idx) => idx.map((v) => v.name + ' ' + sig(v)).sort();
// ── 判据的两侧集合（**推导**，不手抄；手抄的只有下面 BASE 那份"链之前就有的表"盘点，见注释）────────
// 判据的定义域（Case A）＝**链在管索引的表**，必须按 SCHEMA 管全：
//   ① 链自己 `CREATE TABLE` 建的表：events / events_archive / deliveries / contract_events（索引随建表产生）；
//   ② 链**后来为它补建过索引**的表（CREATE INDEX / ADD KEY）：audit_log / audit_log_archive / usage_stats /
//      knowledge —— 链一旦管了这张表的索引（补了其中几条），剩下的就必须全管，否则还是漂。
const CHAIN_MANAGED = [...new Set(VERSIONS.flatMap((v) => (v.statements || []).flatMap((s) => {
  const sql = String(s).trim();
  let m;
  if ((m = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*)\)$/i.exec(sql))) return indexesInBody(m[2]).size ? [m[1]] : [];
  if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:CONSTRAINT\s+`?\w+`?\s+)?(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?/i.exec(sql))) return [m[1]];
  if ((m = /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(sql))) return [m[2]];
  return [];
})))].filter((t) => nonPrimary(SCHEMA_IDX.get(t)).length > 0).sort();
// Case B 的名单＝**链之前的建表语句带来的索引**（链从没为这些表产生过索引）。为什么这份要手写：
// 数据库里没有"这条索引是哪一版 db.js 加的"这种记录，代码面也无从推导 ⇒ 只能盘点一次、点名锁住。
// 盘点口径＝"SCHEMA 声明了非主键索引、而链的任何语句都没为它建过索引"（机器算出来的**名单**；
// 写在这里的每条都由**只读探针**在真库 `rw_test` 上逐一核过：声明的索引一条不缺，故不存在待补的漂移）。
// 新表/新索引**不会**悄悄溜进来：下面第 2 条夹具要求"SCHEMA 有索引的表必须落在 Case A 或 Case B 里"，
// 任何新增的表只要没被归位就当场红；已有表上新增的索引则落在"链有 SCHEMA 无"（同样判红）。
const BASE = [
  // 集成前平台就有的表（链从头到尾没碰过；其索引随建表语句落库）
  'agent_runs', 'conv_skills', 'credentials_ref', 'extension_demands', 'extensions', 'market_snapshot',
  'messages', 'model_telemetry', 'models', 'reviews', 'sessions', 'task_contracts',
].sort();
// **一条有意留着的遗留缺口**（在 Case A 的表上，因为链已经为它建了别的索引；但这条链从没建过）：
//   `contract_events` 是**链之前就存在**的表（0006 只 `ALTER` 它加列与唯一键），它 SCHEMA 里的
//   `idx_ce_contract` 随那张表诞生时的建表语句落库（真库探针：在）。为什么不由链补：0008 试过，
//   `test/contract-events-source.test.mjs` 的"涉及 contract_events 的迁移只有一条"当场判红——
//   那条不变量是 ⑫ 那批刻意立的（再加一条就得有人问为什么），**不许为了让本夹具变绿去改它**。
//   所以这里如实登记成"已知缺口"：它的补救办法是改那条不变量（需 ⑫ 的 owner 决定），不是偷偷补一条 CREATE INDEX。
const KNOWN_GAPS = ['contract_events.idx_ce_contract'];
// "链建过表、但 SCHEMA 里没有非主键索引可比"的表（不该有；有就是抠取口径出洞）
const NO_INDEX_TO_COMPARE = [...CHAIN_CREATED].filter((t) => !nonPrimary(SCHEMA_IDX.get(t)).length).sort();

test('db.js 能抠出建表语句（抠不出来说明这段正则失效了，别让夹具变成摆设）', () => {
  assert.ok(SCHEMA.size >= 20, '应抠出 20 张以上的表，实际 ' + SCHEMA.size);
  assert.ok(SCHEMA.has('conversations') && SCHEMA.get('conversations').size >= 5, 'conversations 表要能抠到列');
});

test('索引判据本身不能空转：两侧都抠得出索引、定义域非空且自洽（否则"两边相等"是废话）', () => {
  const declared = [...SCHEMA_IDX.values()].reduce((n, m) => n + m.size, 0);
  const produced = [...CHAIN_IDX.values()].reduce((n, m) => n + m.size, 0);
  assert.ok(declared >= 40, 'SCHEMA 应抠出 40 条以上的索引声明，实际 ' + declared);
  assert.ok(produced >= 10, '链应抠出 10 条以上的索引（建表内联 6 条 + 0006 的 uk_ce_event + 0007/0008 补的），实际 ' + produced);
  assert.ok(CHAIN_MANAGED.length >= 8, '链在管索引的表应有 8 张以上（建表 4 张 + 0007/0008 补过的 4 张），实际 ' + CHAIN_MANAGED.length + '：' + CHAIN_MANAGED.join(', '));
  // 定义域必须真的在 SCHEMA 里（抠取口径不一致会当场露馅）
  for (const t of CHAIN_MANAGED) assert.ok(SCHEMA.has(t), t + ' 在定义域里，却不在 db.js 的建表语句里');
  // 每个在定义域里的表，两侧都要有非主键索引可比（否则那条"相等"是 0==0）
  for (const t of CHAIN_MANAGED) assert.ok(nonPrimary(SCHEMA_IDX.get(t)).length > 0, t + ' 在定义域里，SCHEMA 侧却没有非主键索引可比');
  assert.deepEqual(NO_INDEX_TO_COMPARE, [], '链建过这些表，但 SCHEMA 里抠不出它们的非主键索引（抠取口径出洞了）');
  // 定义域外（Case B）＝链之前的建表语句带来的索引：**必须逐条点名**（BASE），不许有第三种表。
  // 这一条同时守住"定义域悄悄缩水"：把一张该管的表挪到域外，它会因为不在 BASE 里而当场红。
  const withIdx = [...SCHEMA_IDX.keys()].filter((t) => nonPrimary(SCHEMA_IDX.get(t)).length > 0).sort();
  const outside = withIdx.filter((t) => !CHAIN_MANAGED.includes(t));
  assert.ok(outside.length >= 10, '定义域外应有 10 张以上的基线表（索引来自链之前的建表语句），实际 ' + outside.length);
  assert.deepEqual(outside, BASE,
    '出现未归位的表：SCHEMA 声明了索引、链又没管它，而它不在 BASE 名单里。'
    + '要么补进链（0008 的做法），要么在 BASE 里点名并写清它的索引由哪条建表语句带来');
  assert.ok(BASE.length >= 10, 'BASE 应有 10 张以上的表，实际 ' + BASE.length);
  assert.deepEqual(CHAIN_MANAGED.filter((t) => BASE.includes(t)), [], 'CHAIN_MANAGED 与 BASE 必须互斥');
  assert.deepEqual(CHAIN_MANAGED, ['audit_log', 'audit_log_archive', 'contract_events', 'deliveries', 'events', 'events_archive', 'knowledge', 'usage_stats'],
    '定义域变了：要么链新增了建表/补索引（好事，请连同这里一起改并写明），要么判据被改窄了（不许）');
});

test('迁移链里加过的每一列，全新库路径（db.js 建表）都要有 —— 否则新装机缺列', () => {
  const missing = [];
  for (const v of VERSIONS) {
    for (const stmt of v.statements || []) {
      const s = String(stmt);
      const add = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(s);
      if (add) {
        const [, table, col] = add;
        if (!SCHEMA.has(table)) { missing.push(v.id + ': 表 ' + table + ' 不在 db.js 建表语句里'); continue; }
        if (!SCHEMA.get(table).has(col)) missing.push(v.id + ': ' + table + '.' + col + ' 只在迁移链里，db.js 的建表语句缺它');
        continue;
      }
      const ct = /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(s);
      if (ct && !SCHEMA.has(ct[1])) missing.push(v.id + ': 表 ' + ct[1] + ' 只在迁移链里，db.js 缺整张表');
    }
  }
  assert.deepEqual(missing, [], '两条建库路径已经漂移（全新库会缺这些列/表）：\n  ' + missing.join('\n  '));
});

// ── C-48：索引也必须两条路径一致（SCHEMA 声明的 == 链累计产生的，含列顺序与类型）──────────────
test('C-48 索引：链管索引的每张表，SCHEMA 声明的索引集合 == 链累计产生的索引集合（含列顺序与类型）', () => {
  const missing = [];
  const extra = [];
  for (const t of CHAIN_MANAGED) {
    const declared = listing(nonPrimary(SCHEMA_IDX.get(t))).map((x) => t + '.' + x);
    const produced = listing(nonPrimary(CHAIN_IDX.get(t))).map((x) => t + '.' + x);
    for (const d of declared) if (!produced.includes(d) && !KNOWN_GAPS.some((k) => d === k || d.startsWith(k + ' '))) missing.push(d);
    for (const p of produced) if (!declared.includes(p)) extra.push(p);
  }
  assert.deepEqual(missing, [],
    '升级来的库会缺这些索引（无索引不改结果，但两条路径的查询代价不同；补法＝在迁移链里加一条 CREATE INDEX，'
    + 'SCHEMA 是唯一出处）：\n  ' + missing.join('\n  '));
  assert.deepEqual(extra, [],
    '链里建了 SCHEMA 没声明的索引（要么名字/列写错了，要么忘了同步 db.js 的建表语句）：\n  ' + extra.join('\n  '));
  // 逐表整体相等（上面两条只是把差异说清楚；顺序也要一致，故直接比数组）——已知缺口那张表除外
  for (const t of CHAIN_MANAGED) {
    if (KNOWN_GAPS.some((k) => k.startsWith(t + '.'))) continue;
    assert.deepEqual(listing(nonPrimary(CHAIN_IDX.get(t))), listing(nonPrimary(SCHEMA_IDX.get(t))),
      t + ' 的索引集合与 SCHEMA 不一致');
  }
  // 已知缺口必须**真的是缺口**（链里没有、SCHEMA 里有）：补上了就该把它从名单里删掉，不许挂着过期条目
  for (const k of KNOWN_GAPS) {
    const [t, n] = k.split('.');
    assert.ok(SCHEMA_IDX.get(t) && SCHEMA_IDX.get(t).get(n), k + ' 不在 SCHEMA 里了（名单过期）');
    assert.ok(!(CHAIN_IDX.get(t) && CHAIN_IDX.get(t).get(n)), k + ' 已经被链建过了：请从 KNOWN_GAPS 里删掉它');
  }
  // Case B（BASE 名单里的表：索引由链之前的建表语句带来）：链虽然不管它们，但**不能反过来少声明**
  const baseExtras = BASE.flatMap((t) => listing(nonPrimary(CHAIN_IDX.get(t))).filter((x) => !listing(nonPrimary(SCHEMA_IDX.get(t))).includes(x)).map((x) => t + '.' + x));
  assert.deepEqual(baseExtras, [], 'BASE 名单里的表出现了 SCHEMA 没声明的链上索引：\n  ' + baseExtras.join('\n  '));
});

// 防"把索引判据悄悄删空"：C-48 实测漂移的那批索引必须真的在链里（形状逐条与 SCHEMA 比）
test('C-48 回归锚：实测漂移的那批索引必须在链里，且形状与 SCHEMA 一致', () => {
  const drift = [
    'audit_log.idx_audit_time', 'audit_log.idx_audit_conv', 'audit_log_archive.idx_arch_time',
    'audit_log_archive.idx_arch_conv', 'usage_stats.idx_usage_time', 'usage_stats.idx_usage_conv',
    'knowledge.idx_kb_scope', 'knowledge.idx_kb_shell',
  ];
  for (const key of drift) {
    const [t, n] = key.split('.');
    const declared = SCHEMA_IDX.get(t) && SCHEMA_IDX.get(t).get(n);
    assert.ok(declared, key + ' 应当由 db.js 的 SCHEMA 声明（它是唯一出处）');
    const produced = CHAIN_IDX.get(t) && CHAIN_IDX.get(t).get(n);
    assert.ok(produced, key + ' 不在迁移链里 ⇒ 升级来的库永远没有它（C-48 就是这个形态）');
    assert.equal(sig(produced), sig(declared), key + ' 的链上形状与 SCHEMA 不一致');
  }
  // 存量表里"链只 ALTER、链自己没建"的那三张：索引必须被链补全（它们由 0008 补进 CHAIN_MANAGED）
  for (const t of ['audit_log', 'audit_log_archive', 'usage_stats', 'knowledge']) {
    assert.ok(CHAIN_MANAGED.includes(t), t + ' 应当在定义域里（它是一个已被链补过索引的表）');
    assert.deepEqual(listing(nonPrimary(CHAIN_IDX.get(t))), listing(nonPrimary(SCHEMA_IDX.get(t))), t + ' 的索引没有被链补全');
  }
  // 每条索引在链里**有且只有一条语句建它**：重复建 = 真升级库上 ER_DUP_KEYNAME 卡链（C-57 的形态）
  const built = new Map();
  for (const v of VERSIONS) {
    for (const stmt of v.statements || []) {
      const s = String(stmt).trim();
      let m;
      let t = null;
      let names = [];
      if ((m = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*)\)$/i.exec(s))) { t = m[1]; names = [...indexesInBody(m[2]).keys()]; }
      else if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:CONSTRAINT\s+`?\w+`?\s+)?(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?/i.exec(s))) { t = m[1]; names = [m[2]]; }
      else if ((m = /^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(s))) { t = m[2]; names = [m[1]]; }
      if (!t) continue;
      for (const n of names) {
        const k = t + '.' + n;
        if (!built.has(k)) built.set(k, []);
        built.get(k).push(v.id);
      }
    }
  }
  const dup = [...built].filter(([, v]) => v.length > 1).map(([k, v]) => k + ' ← ' + v.join(', '));
  assert.deepEqual(dup, [], '同一条索引被链里多条语句重复建（真升级库会 Duplicate key name 卡住链）：\n  ' + dup.join('\n  '));
});
