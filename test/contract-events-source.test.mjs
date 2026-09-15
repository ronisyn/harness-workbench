// test/contract-events-source.test.mjs - `contract_events` 与 `events` **同源**
// （v0.3 §0.5「旧账要么并入新架构，要么删掉，不留两套」的逐项过账判定：登记 C-39 第 ② 条）
//
// 裁决原文（`proposals/架构文档冲突登记-20260915.md` 的 C-39 行）：事件四处里内存环＝跟播缓存、
// `events`＝唯一账本、`audit_log`＝审计动作账，而 **`contract_events`＝改造/迁移：与 `events` 同源**，
// 否则"同一事实两种投影"永远对不上账。
// 改造后的口径：**一个事实、一个写入者** —— 契约事实由 `server/eventlog.js` 的 `persistContractEvent`
// **一次调用**落两行（`events` 账本行 + `contract_events` 投影行），投影行带 `event_id` 指回账本行。
//
// 本夹具锁五条，都不需要真库（假库照 `test/eventlog-archive.test.mjs` 的写法，按 SQL 片段分派）：
//   ① 单一写入路径：全仓**代码面**只有 `server/eventlog.js` 出现那句 INSERT（driver.js 与 e2e 脚本都不许再自己写）；
//   ② 读形状逐字节不变：`index.js` 的查询字段/排序、删会话的清理语句都原样，且表**仍是实表**
//      （改成视图就删不掉，那条 DELETE 会被空 catch 吞掉 → 孤儿；这正是改造前踩过的坑）；
//   ③ 可追溯：投影行按 `event_id` 指回账本行，且 (contract_id, kind) 两边一致 —— 逐行 join 是**机检**，不是注释约定；
//   ④ 幂等/重放：同一条账本行被投影两次仍只有一行（去重键＝账本行 id，照抄 `projection.js` 的口径，没发明新规则）；
//   ⑤ 迁移只增不删：涉及 `contract_events` 的语句只有 ADD/CREATE，两条建库路径都带上新列与唯一键。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistContractEvent } from '../server/eventlog.js';
import { VERSIONS } from '../server/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 被扫描的**代码面**：会跑的文件（server/test/scripts/src + 仓库根的 .js/.mjs/.cjs）。
// 为什么不扫 `proposals/` 与 `docs/`：那两处是叙述、不是写入者 —— 文档里引用旧 SQL 不构成"第二个写入点"，
// 把它们纳进来只会让判据被一句引文判红（判据要判的是**谁在写**）。隐藏目录（含夹具自己留下的 *.tmpdir）跳过。
const CODE_DIRS = ['server', 'test', 'scripts', 'src'];
const SKIP_DIR = /^(node_modules|\.git|\.github)$/;
function codeFiles() {
  const out = [];
  const walk = (rel) => {
    let items;
    try { items = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (SKIP_DIR.test(it.name) || it.name.startsWith('.')) continue;
      const r = rel + '/' + it.name;
      if (it.isDirectory()) walk(r);
      else if (/\.(mjs|cjs|js|jsx)$/.test(it.name)) out.push(r);
    }
  };
  for (const d of CODE_DIRS) walk(d);
  for (const it of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (it.isFile() && /\.(mjs|cjs|js)$/.test(it.name)) out.push(it.name);
  }
  return out.sort();
}

// 判据正则**拼接构造**：本文件自己也在扫描面里，写死字面量会让夹具命中自己（那不是放宽判据，
// 只是不把"夹具自己"算成写入者）。
const T = 'contract_events';
const INSERT_RE = new RegExp('INSERT\\s+INTO\\s+' + T, 'i');
const files = codeFiles();

// ── ① 单一写入路径 ──────────────────────────────────────────────────────────────────────────
test('单一写入路径：全仓代码面只有 server/eventlog.js 写 contract_events', () => {
  // 扫描面自检：走歪了（目录名写错/被跳过）会让下面的断言变成空转，先把必须在场的文件钉住
  for (const f of ['server/eventlog.js', 'server/driver.js', 'server/index.js', 'e2e-final.mjs']) {
    assert.ok(files.includes(f), '扫描面必须包含 ' + f + '（实际扫到 ' + files.length + ' 个文件）');
  }
  const writers = files.filter((f) => INSERT_RE.test(read(f)));
  assert.deepEqual(writers, ['server/eventlog.js'], 'contract_events 只许有一个写入者（eventlog.js），实际：' + writers.join(', '));
  // 反向锚点：改造前 driver.js 正是那个直接 INSERT 的地方 —— 它必须真的不再自己写
  assert.equal(INSERT_RE.test(read('server/driver.js')), false, 'driver.js 不得再自己 INSERT contract_events');
  assert.match(read('server/driver.js'), /persistContractEvent\(/, 'driver.js 必须走 eventlog 的同一次写入调用');
  // 语句本身也要能机检：关联字段（回指账本行的 event_id）与去重子句都得在，不能只写在注释里
  const log = read('server/eventlog.js');
  assert.ok(log.includes('INSERT INTO ' + T + ' (contract_id, kind, detail, event_id) VALUES (?,?,?,?)'),
    '投影 INSERT 的列与占位符必须写 event_id（回指账本行；顺序即参数顺序）');
  assert.match(log, /ON DUPLICATE KEY UPDATE/, '重放同一条账本行不得产生第二行（唯一键 + upsert）');
});

// ── ② 读形状与清理路径逐字节不变 ─────────────────────────────────────────────────────────────
test('读形状逐字节不变：index.js 的查询/排序与删会话清理原样，且 contract_events 仍是实表', () => {
  const idx = read('server/index.js');
  assert.ok(idx.includes('SELECT kind,detail,created_at FROM ' + T + ' WHERE contract_id=? ORDER BY id DESC LIMIT 50'),
    '契约事件读接口的字段与排序语义不得变（变了就是改接口，前端/调用方跟着受影响）');
  assert.ok(idx.includes('DELETE FROM ' + T + ' WHERE contract_id IN (SELECT id FROM task_contracts WHERE conv_id=?)'),
    '删会话的清理语句语义不得变（表还在、contract_id 关联还在）');
  // 表必须仍是**实表**：MySQL 对视图的 DELETE 直接报错，那条清理又被空 catch 兜着 ⇒ 行留下变孤儿。
  const schema = read('server/db.js');
  const body = /CREATE TABLE IF NOT EXISTS contract_events\s*\(([\s\S]*?)\n\s*\)`/.exec(schema);
  assert.ok(body, '要能从 db.js 抠出 contract_events 的建表语句（抠不出来说明这段正则失效了，别让夹具变摆设）');
  for (const col of ['id', 'contract_id', 'kind', 'detail', 'created_at', 'event_id']) {
    assert.match(body[1], new RegExp('\\b' + col + '\\b'), '建表语句缺列 ' + col);
  }
  assert.match(body[1], /id INT AUTO_INCREMENT PRIMARY KEY/, 'id 仍是自增主键：读接口按 id DESC 排序的语义靠它');
  assert.equal(/CREATE\s+(OR\s+REPLACE\s+)?VIEW/i.test(body[0]), false, 'contract_events 不许改成视图（视图删不掉 ⇒ 清理路径失效）');
});

// ── 假库：只实现写入路径用到的两样（`events.append` + 那句投影 INSERT）────────────────────────
// 唯一键 `uk_ce_event(event_id)` 的语义照 db.js 声明的那把键实现：同一条账本行投影两次仍只有一行。
// `replay=true` 时 append 回**同一个**账本行 id —— 模拟的正是"重放同一条账本事实"（重放源是账本，
// 同一条账本行会被投影多次），这是"既有去重口径（按账本行 id）"能表达的唯一一种重复。
function fakeStore(opts = {}) {
  const ledger = [];
  const projection = [];
  const calls = [];
  let nextEventId = 1;
  return {
    ledger, projection, calls,
    events: {
      async append(f) {
        const id = opts.replay ? 1 : nextEventId++;
        calls.push({ sql: 'events.append', params: [f] });
        ledger.push({ id, ...f });
        return { id };
      },
    },
    async run(sql, params) {
      calls.push({ sql, params });
      const [contract_id, kind, detail, event_id] = params;
      const hit = event_id == null ? undefined : projection.find((r) => r.event_id === event_id);
      if (hit) Object.assign(hit, { contract_id, kind, detail });
      else projection.push({ id: projection.length + 1, contract_id, kind, detail, event_id });
      return { affectedRows: 1 };
    },
  };
}

// ── ③ 可追溯（机检的 join）──────────────────────────────────────────────────────────────────
test('可追溯：投影行按 event_id 指回账本行，(contract_id, kind) 两边一致，且先账本后投影', async () => {
  const dbc = fakeStore();
  const id = await persistContractEvent(7, 'candidate_done', '等待用户复测确认', { conversationId: 42, dbc });
  assert.equal(dbc.ledger.length, 1, '账本必须有且只有一行事实');
  assert.equal(dbc.projection.length, 1, '投影必须有且只有一行');
  const fact = dbc.ledger[0], proj = dbc.projection[0];
  assert.equal(id, fact.id, '返回值就是账本行 id');
  assert.equal(proj.event_id, fact.id, '投影行的 event_id 必须回指账本行（这就是"关联字段"）');
  assert.equal(fact.conversationId, 42, '账本行按会话归属（events 表就是这么读的）');
  assert.equal(fact.type, proj.kind, '同一个 kind：账本的 type 与投影的 kind 同值');
  assert.equal(fact.payload.contractId, proj.contract_id, '同一个 contract_id：账本把它带在 payload 里');
  assert.equal(proj.detail, '等待用户复测确认');
  assert.equal(fact.payload.detail, proj.detail, '人读细节两边一致');
  // 逐行核：每一行投影都能在账本里找到 (contract_id, kind) 相符的那一行
  for (const p of dbc.projection) {
    const hit = dbc.ledger.find((e) => e.id === p.event_id && e.type === p.kind && (e.payload || {}).contractId === p.contract_id);
    assert.ok(hit, '投影行 #' + p.id + ' 找不到对应的账本事实（' + p.contract_id + '/' + p.kind + '）');
  }
  // 顺序：先账本、后投影。投影可重算、账本不可 —— 反过来写会留下"投影里有、账本里没有"的不可追溯行
  assert.equal(dbc.calls[0].sql, 'events.append', '账本行必须先写（第一条调用就是它）');
  assert.ok(dbc.calls[1] && /INSERT\s+INTO\s+contract_events/i.test(dbc.calls[1].sql), '投影紧随其后（同一次调用里）');
});

test('缺契约 id / kind / 归属会话时明确不写（返回 false，不是假装写了）', async () => {
  const dbc = fakeStore();
  assert.equal(await persistContractEvent(7, 'start', 'x', { conversationId: 0, dbc }), false, '没有归属会话不写（与 persistEvent 同一条口径）');
  assert.equal(await persistContractEvent(0, 'start', 'x', { conversationId: 42, dbc }), false, '没有契约 id 不写');
  assert.equal(await persistContractEvent(7, '', 'x', { conversationId: 42, dbc }), false, '没有 kind 不写');
  assert.equal(dbc.ledger.length + dbc.projection.length, 0, '明确不写 ⇒ 账本与投影两边都不许留行');
});

// ── ④ 幂等 / 重放 ───────────────────────────────────────────────────────────────────────────
test('幂等/重放：同一条账本行被投影两次仍只有一行（去重键＝账本行 id，不发明新规则）', async () => {
  const dbc = fakeStore({ replay: true });
  const a = await persistContractEvent(7, 'candidate_done', '等待用户复测确认', { conversationId: 42, dbc });
  const b = await persistContractEvent(7, 'candidate_done', '等待用户复测确认', { conversationId: 42, dbc });
  assert.equal(a, b, '重放拿到的是同一条账本行 id');
  assert.equal(dbc.projection.length, 1, '投影不得出现第二行');
  assert.equal(dbc.projection[0].event_id, a, '留下的那一行仍指回账本行');
  // 唯一键必须真的声明在库里（假库只是模拟它；判据落在两条建库路径上）
  assert.match(read('server/db.js'), /UNIQUE KEY uk_ce_event \(event_id\)/, '新库路径要给 event_id 加唯一键');
  const link = VERSIONS.filter((v) => (v.statements || []).some((s) => /contract_events/i.test(s)));
  assert.equal(link.length >= 1, true, '迁移链必须有那条把 contract_events 接到账本上的迁移');
  for (const v of link) {
    assert.ok(v.statements.some((s) => /ADD UNIQUE KEY uk_ce_event \(event_id\)/i.test(s)), v.id + ' 也要给 event_id 加唯一键（存量库路径）');
  }
});

// ── ⑤ 迁移只增不删 + 两条路径一起改 ───────────────────────────────────────────────────────────
test('迁移只增不删：涉及 contract_events 的语句只有 ADD/CREATE，两条建库路径都带新列', () => {
  const touched = VERSIONS.filter((v) => (v.statements || []).some((s) => /contract_events/i.test(s)));
  assert.equal(touched.length, 1, '涉及 contract_events 的迁移应当只有一条（加了第二条就该有人问为什么），实际：' + touched.map((v) => v.id).join(', '));
  for (const v of touched) {
    for (const s of v.statements) {
      if (!/contract_events/i.test(s)) continue;
      assert.match(s, /^(ALTER TABLE\s+contract_events\s+ADD\s+|CREATE TABLE IF NOT EXISTS contract_events)/i,
        '只增不删：' + v.id + ' 的语句越界了 → ' + s);
      assert.equal(/DROP|RENAME|MODIFY|CHANGE|DELETE|TRUNCATE|UPDATE/i.test(s), false, '只增不删：' + v.id + ' → ' + s);
    }
    assert.ok(v.statements.some((s) => /ALTER TABLE contract_events ADD COLUMN event_id/i.test(s)),
      v.id + ' 必须真的加上 event_id（否则存量库永远没有这个关联字段）');
  }
  // schema-sync 夹具核对"链里加过的列必须在建表语句里"；这里补上另一半：新库路径也要有 event_id
  assert.match(read('server/db.js'), /event_id BIGINT NULL/, '新库路径的建表语句要带 event_id');
});
