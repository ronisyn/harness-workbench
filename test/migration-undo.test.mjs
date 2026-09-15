// test/migration-undo.test.mjs —— 升级演练的**倒推**夹具（依据 v0.3 §7.1 ⑪ / §0.2 G4，2026-09-16）
//
// 为什么要它（C-57 真机翻车）：`scripts/migration-rehearsal.mjs` 造"旧形状"用的是 `CREATE TABLE … LIKE 源库表`
// ——**索引会被一起复制过去**；而倒推此前只认"加列/建表"，对索引是**瞎的**。于是 0007 的
// `CREATE FULLTEXT INDEX ft_kb_text` 在旧形状里已经存在 ⇒ 迁移报 `Duplicate key name 'ft_kb_text'` 并停在该步。
// 夹具锁四件事：
//   ① 链里**加索引**的两种写法（`ALTER TABLE … ADD [UNIQUE|FULLTEXT] KEY/INDEX` 与 `CREATE … INDEX … ON …`）
//      都要倒推成 `DROP INDEX`，且两种写法得到**同一个**倒推动作；
//   ② 真实链的倒推计划里**每条语句都有归宿**（ops + exempt = 链语句总数）——不许静默放过；且链里
//      **每一条**加索引语句都要倒推成对应索引的 `DROP INDEX <名> ON <表>`（数量从链算出，不写死——写死数量的
//      判据会在"链加了索引迁移"时红，而红的原因并不是倒推坏了）；
//   ③ 推导不出来的语句（`ADD PRIMARY KEY`、没有手工项的 `MODIFY COLUMN`）必须**非零退出 + 说明该补什么**；
//   ④ 倒推顺序对：同一迁移里**先摘索引、再删列**（否则删列会把索引悄悄带走一半）。
// 本夹具**不需要数据库**：`--plan-undo` / `--classify` 是脚本里"连库之前"的 dry-run 分支，
// 所以它把 DB_HOST/DB_PORT 指向一个不存在的端口也必须照样通过（第 8 条夹具就是在证这一点）。
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS } from '../server/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration-rehearsal.mjs');

/** 跑脚本的 dry-run 分支（不连库）。**故意把库指向不存在的端口**：连了就会失败，从而证明它真的没连。 */
function run(args) {
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: '1' };
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 30000 });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, json: e.stdout ? JSON.parse(e.stdout) : null, stderr: String(e.stderr || '') };
  }
}
const classify = (sql) => run(['--classify', sql]);
const chainStatements = VERSIONS.reduce((n, v) => n + (v.statements || []).length, 0);

test('真实链的倒推计划：每条语句都有归宿（ops + exempt = 链语句总数），没有 unresolved', () => {
  const { code, json } = run(['--plan-undo']);
  assert.equal(code, 0, '--plan-undo 必须 exit 0：' + JSON.stringify(json && json.unresolved));
  assert.deepEqual(json.unresolved, [], '真实链不许有"推导不出来"的语句');
  assert.equal(json.ops.length + json.exempt.length, chainStatements,
    '链里 ' + chainStatements + ' 条语句必须条条有归宿（ops ' + json.ops.length + ' + exempt ' + json.exempt.length + '）');
  assert.equal(json.head, VERSIONS[VERSIONS.length - 1].id);
  // 每一个 op 都要带可读的 undo DDL（人核对时不用回读代码）
  for (const op of json.ops) assert.ok(op.undo, 'op 缺 undo DDL：' + JSON.stringify(op));
});

test('② 链里**每一条**加索引语句都被倒推成对应索引的 DROP INDEX（数量从链算出，不写死）', () => {
  // 2026-09-16 改（C-48/0008/0009 加了一批索引后）：此前这里写死"链里有两处加索引"（0006 的 uk_ce_event、
  // 0007 的 ft_kb_text）。写死数量的判据有两个毛病：① 链每加一步索引迁移就红一次，而**红的原因不是倒推坏了**；
  // ② 它只锁住了那两个名字，链里新加的索引有没有被倒推**它并不看**（数量对上就算过）。
  // 现在改成从链推导：链里每一条 `ALTER … ADD … KEY/INDEX <名>` / `CREATE … INDEX <名> ON <表>`，
  // 都必须在 ops 里找到 `kind:'index'` 且 `undo === 'DROP INDEX <名> ON <表>'` —— 一条不漏、一条不多。
  // 这不是放宽：判据从"两个样本"扩到了"链的全部"，并保留一条正向锚（链里一处索引都没有 ⇒ 空跑假绿，判红）。
  const { code, json } = run(['--plan-undo']);
  assert.equal(code, 0, '--plan-undo 必须 exit 0：' + JSON.stringify(json && json.unresolved));
  const expected = [];
  for (const v of VERSIONS) for (const sql of v.statements || []) {
    const s = String(sql);
    let m;
    if ((m = /^\s*ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:CONSTRAINT\s+`?\w+`?\s+)?(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?/i.exec(s))) expected.push({ table: m[1], name: m[2] });
    else if ((m = /^\s*CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(s))) expected.push({ table: m[2], name: m[1] });
  }
  assert.ok(expected.length >= 3, '链里应当有多处加索引（0006 的 uk_ce_event、0007 的 ft_kb_text、0008/0009 补的存量表索引）；'
    + '若为 0 ⇒ 下面这圈是空跑，判据失效，实际 ' + expected.length);
  const idx = json.ops.filter((o) => o.kind === 'index');
  assert.deepEqual(idx.map((o) => o.name).sort(), expected.map((e) => e.name).sort(),
    '链里加索引的名字必须与倒推出来的索引 op 一一对应');
  for (const e of expected) {
    const got = idx.find((o) => o.name === e.name && o.table === e.table);
    assert.ok(got, '链里的加索引语句没被倒推：' + e.name + '（表 ' + e.table + '）');
    assert.equal(got.undo, 'DROP INDEX ' + e.name + ' ON ' + e.table,
      e.name + ' 的倒推动作不对（要能原样摘掉旧形状里那条索引，否则 0007 的 Duplicate key name 会重演）');
  }
  // 两个历史样本仍在（它们各自代表一种写法：CREATE TABLE 之外的 UNIQUE KEY / 带解析器的 FULLTEXT）
  assert.deepEqual(idx.find((o) => o.name === 'ft_kb_text'), { kind: 'index', table: 'knowledge', name: 'ft_kb_text', undo: 'DROP INDEX ft_kb_text ON knowledge' });
  assert.deepEqual(idx.find((o) => o.name === 'uk_ce_event'), { kind: 'index', table: 'contract_events', name: 'uk_ce_event', undo: 'DROP INDEX uk_ce_event ON contract_events' });
});

test('倒推顺序：同一迁移里先摘索引、再删列（否则删列会把单列索引悄悄带走一半）', () => {
  const { json } = run(['--plan-undo']);
  const at = (kind, name) => json.ops.findIndex((o) => o.kind === kind && o.name === name);
  assert.ok(at('index', 'uk_ce_event') >= 0 && at('column', 'event_id') >= 0, '两个 op 都该在（0006 加的）');
  assert.ok(at('index', 'uk_ce_event') < at('column', 'event_id'), 'uk_ce_event 必须排在 event_id 之前');
});

test('① 加索引的两种写法得到同一个倒推动作（ALTER … ADD [UNIQUE|FULLTEXT] KEY/INDEX 与 CREATE … INDEX … ON）', () => {
  const forms = [
    'ALTER TABLE knowledge ADD FULLTEXT KEY ft_kb_text (title, body) WITH PARSER ngram',
    'ALTER TABLE knowledge ADD FULLTEXT INDEX ft_kb_text (title, body) WITH PARSER ngram',
    'ALTER TABLE knowledge ADD UNIQUE KEY ft_kb_text (title, body)',
    'ALTER TABLE knowledge ADD KEY ft_kb_text (title, body)',
    'ALTER TABLE knowledge ADD INDEX `ft_kb_text` (title, body)',
    'CREATE INDEX ft_kb_text ON knowledge (title, body)',
    'CREATE UNIQUE INDEX ft_kb_text ON knowledge (title, body)',
    'CREATE FULLTEXT INDEX ft_kb_text ON knowledge (title, body) WITH PARSER ngram', // ← 0007 的真实写法
    'CREATE FULLTEXT INDEX `ft_kb_text` ON `knowledge` (title, body) WITH PARSER ngram',
  ];
  for (const sql of forms) {
    const { code, json } = classify(sql);
    assert.equal(code, 0, sql + ' 应当能倒推，实际 ' + JSON.stringify(json && json.reason));
    assert.deepEqual(json.classify, { kind: 'index', table: 'knowledge', name: 'ft_kb_text' }, sql);
    assert.equal(json.undo, 'DROP INDEX ft_kb_text ON knowledge', sql);
  }
});

test('③ 推导不出来的语句必须报红（非零退出 + 说清该补什么），不许静默放过', () => {
  for (const sql of ['ALTER TABLE t ADD PRIMARY KEY (id)', 'ALTER TABLE t ENGINE=InnoDB', 'OPTIMIZE TABLE t']) {
    const { code, json } = classify(sql);
    assert.equal(code, 1, sql + ' 必须 exit 1');
    assert.equal(json.verdict, 'unresolved', sql);
    assert.equal(json.undo, null);
    assert.ok(json.unresolved.length === 1 && /不许静默放过/.test(json.unresolved[0]), sql + ' 的 reason 要说清"没归宿"：' + JSON.stringify(json.reason));
  }
});

test('③ MODIFY COLUMN：有手工项 ⇒ exempt；没有 ⇒ 报红并指名要补哪一条', () => {
  const miss = classify('ALTER TABLE t MODIFY COLUMN c INT NOT NULL');
  assert.equal(miss.code, 1, '没有手工项的 MODIFY 必须 exit 1');
  assert.equal(miss.json.verdict, 'unresolved');
  assert.match(miss.json.reason, /EXTRA_UNDO_COLS 里补 \['t','c','<旧类型>'\]/);
  // 真实链里那条（shell_tools.mode 8→12）有手工项 ⇒ 显式豁免、不算"没归宿"
  const hit = classify('ALTER TABLE shell_tools MODIFY COLUMN mode VARCHAR(12) NOT NULL');
  assert.equal(hit.code, 0);
  assert.equal(hit.json.verdict, 'exempt');
  assert.match(hit.json.reason, /EXTRA_UNDO_COLS 手工项还原为 varchar\(8\)/);
});

test('删表语句显式豁免（不需要倒推），但仍是"有归宿"的一类', () => {
  const { code, json } = classify('DROP TABLE IF EXISTS capabilities');
  assert.equal(code, 0);
  assert.equal(json.verdict, 'exempt');
  assert.match(json.reason, /删表：不需要倒推/);
  // 真实链里 capabilities 正是这一类（前 5 条夹具已证 exempt 计入"有归宿"）
  const plan = run(['--plan-undo']).json;
  assert.ok(plan.exempt.some((e) => /capabilities/.test(e.sql)), 'capabilities 应在 exempt 名单里');
});

test('dry-run 不连库：库指向不存在的端口也照样通过（CI 可跑）', () => {
  // run() 已经把 DB_HOST/DB_PORT 指到 127.0.0.1:1；若脚本在 dry-run 分支连了库，这里会超时/失败
  const { code, json } = run(['--plan-undo']);
  assert.equal(code, 0);
  assert.equal(json.unresolved.length, 0);
  const one = classify('CREATE INDEX x ON t (c)');
  assert.equal(one.code, 0);
  assert.equal(one.json.undo, 'DROP INDEX x ON t');
});
