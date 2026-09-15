// test/migration-undo.test.mjs —— 升级演练的**倒推**夹具（依据 v0.3 §7.1 ⑪ / §0.2 G4，2026-09-16）
//
// 为什么要它（C-57 真机翻车）：`scripts/migration-rehearsal.mjs` 造"旧形状"用的是 `CREATE TABLE … LIKE 源库表`
// ——**索引会被一起复制过去**；而倒推此前只认"加列/建表"，对索引是**瞎的**。于是 0007 的
// `CREATE FULLTEXT INDEX ft_kb_text` 在旧形状里已经存在 ⇒ 迁移报 `Duplicate key name 'ft_kb_text'` 并停在该步。
// 夹具锁四件事：
//   ① 链里**加索引**的两种写法（`ALTER TABLE … ADD [UNIQUE|FULLTEXT] KEY/INDEX` 与 `CREATE … INDEX … ON …`）
//      都要倒推成 `DROP INDEX`，且两种写法得到**同一个**倒推动作；
//   ② 真实链的倒推计划里**每条语句都有归宿**（ops + exempt = 链语句总数）——不许静默放过；
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

test('② CREATE INDEX 形式：0007 的 FULLTEXT 索引与 0006 的 UNIQUE KEY 都倒推成 DROP INDEX', () => {
  const { json } = run(['--plan-undo']);
  const idx = json.ops.filter((o) => o.kind === 'index');
  assert.equal(idx.length, 2, '链里目前有两处加索引（0006 的 uk_ce_event、0007 的 ft_kb_text），实际 ' + JSON.stringify(idx));
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
