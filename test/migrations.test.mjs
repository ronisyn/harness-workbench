// test/migrations.test.mjs - 迁移链夹具（2026-09-15）
// 依据《RW-Agent 架构 v1.1》§11.1「存储格式带版本与迁移链」。
// 参考 DSH 的会话格式迁移链：**只允许相邻步、链必须唯一完整无缺口，缺一步显式报错**（不跳过）。
// 本夹具的价值在负例：跳号 / 重复 / 乱序必须在**应用任何一条之前**就被拦下。
import { test } from 'node:test';
import assert from 'node:assert';
import { validateChain, pendingMigrations, MIGRATION_ID_RE, VERSIONS, runMigrations } from '../server/migrations.js';

const V = (id, statements = ['SELECT 1']) => ({ id, statements });

test('正例：真实迁移链本身是合法的（在跑它之前先证明它没坏）', () => {
  assert.equal(validateChain(VERSIONS), true);
  assert.ok(VERSIONS.length >= 1);
  assert.equal(VERSIONS[0].id, '0001_baseline', '第一条必须是 baseline（改造前既有结构）');
});

test('负例：跳号必须报错（DSH 的"完整相邻链"——缺一步就停，不许跳过去）', () => {
  assert.throws(() => validateChain([V('0001_a'), V('0003_c')]), /缺口或乱序/);
});

test('负例：从 0 开头或序号不连续起步也必须报错', () => {
  assert.throws(() => validateChain([V('0000_a')]), /缺口或乱序/);
  assert.throws(() => validateChain([V('0002_b')]), /缺口或乱序/);
});

test('负例：id 重复必须报错（同一版本应用两次的原因往往就是它）', () => {
  assert.throws(() => validateChain([V('0001_a'), V('0001_a')]), /重复/);
});

test('负例：id 格式非法必须报错（不能是 1_a / abc / 0001-A）', () => {
  for (const bad of ['1_a', 'abc', '0001-A', '0001 a', '0001a_b']) {
    assert.ok(!MIGRATION_ID_RE.test(bad), bad + ' 不该通过格式校验');
  }
  assert.throws(() => validateChain([V('1_a')]), /id 非法/);
});

test('负例：没有语句的迁移必须报错（空迁移 = 假装改了）', () => {
  assert.throws(() => validateChain([{ id: '0001_a', statements: [] }]), /没有语句/);
});

test('pending 计算：已应用的跳过、未应用的按链序返回', () => {
  const all = [V('0001_a'), V('0002_b'), V('0003_c')];
  assert.deepEqual(pendingMigrations(all, ['0001_a']).map((v) => v.id), ['0002_b', '0003_c']);
  assert.deepEqual(pendingMigrations(all, []).map((v) => v.id), ['0001_a', '0002_b', '0003_c']);
  assert.deepEqual(pendingMigrations(all, ['0001_a', '0002_b', '0003_c']), [], '全应用过 ⇒ 一个都不跑');
});

test('pending 计算：库里有多余记录（比如回滚过）不影响结果', () => {
  const all = [V('0001_a')];
  assert.deepEqual(pendingMigrations(all, ['0001_a', '0009_ghost']), []);
});

// ── 运行器语义（用假连接池，不需要真库）────────────────────────────────────────────────
// 为什么值得测：这三条语义是"版本化迁移"的全部价值所在——已应用的跳过、只容忍声明的错误、其余判失败。
function fakePool(behavior = {}) {
  const log = [];
  let applied = new Set(behavior.applied || []);
  // 默认当作**存量库**（核心表已在）；behavior.fresh=true 模拟全新库（什么表都还没有）
  const tables = behavior.fresh ? [] : ['tool_calls'];
  return {
    log,
    appliedRows: () => [...applied],
    async query(sql, params) {
      log.push(sql);
      if (/^SHOW TABLES LIKE/.test(sql)) return [tables.includes(params && params[0]) ? [{ Tables: params[0] }] : [], []];
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return [[], []];
      if (/^SELECT id FROM schema_migrations/.test(sql)) return [[...applied].map((id) => ({ id })), []];
      if (/^INSERT (IGNORE )?INTO schema_migrations/.test(sql)) { applied.add(params[0]); return [{}, []]; }
      const boom = (behavior.failOn || []).find((f) => sql.includes(f.match));
      if (boom) throw new Error(boom.error);
      return [{}, []];
    },
  };
}

test('运行器：已应用的迁移不重复执行（第二次启动零 DDL）', async () => {
  const p = fakePool({ applied: ['0001_a'] });
  const r = await runMigrations(p, { versions: [V('0001_a')], log: { error() {} } });
  assert.deepEqual(r.applied, []);
  assert.equal(r.skipped, 1);
  assert.equal(p.log.filter((s) => /^ALTER|^DROP/.test(s)).length, 0, '不该有任何结构语句被执行');
});

test('运行器：只容忍**声明过**的错误（baseline 的"列已存在"放过，其余判失败）', async () => {
  const p = fakePool({ failOn: [{ match: 'ALTER TABLE t ADD COLUMN a', error: 'Duplicate column name \'a\'' }] });
  const r = await runMigrations(p, { versions: [{ id: '0001_a', statements: ['ALTER TABLE t ADD COLUMN a', 'SELECT 2'], tolerate: /Duplicate column/ }], log: { error() {} } });
  assert.deepEqual(r.applied, ['0001_a'], '容忍类错误不应让整条迁移失败');
  assert.equal(r.tolerated, 1);
  assert.equal(r.failed, null);
});

test('运行器：**没声明容忍**的错误必须判失败，且记录不落、后续不再应用', async () => {
  const p = fakePool({ failOn: [{ match: 'ALTER TABLE t ADD COLUMN b', error: "Unknown column 'b'" }] });
  const errs = [];
  const r = await runMigrations(p, {
    versions: [V('0001_a', ['SELECT 1']), { id: '0002_b', statements: ['ALTER TABLE t ADD COLUMN b'] }, V('0003_c')],
    log: { error: (m) => errs.push(m) },
  });
  assert.deepEqual(r.applied, ['0001_a']);
  assert.equal(r.failed.id, '0002_b');
  assert.equal(errs.length, 1, '失败必须出声（过去是所有错误都被静默吞掉）');
  assert.equal(p.appliedRows().includes('0002_b'), false, '失败的迁移不得记为已应用');
  assert.equal(p.log.some((s) => s.includes('0003_c')), false, '失败之后不得再应用后续迁移');
});

test('运行器：链有缺口时**在执行任何语句之前**就抛错（不带半条链跑）', async () => {
  const p = fakePool();
  await assert.rejects(() => runMigrations(p, { versions: [V('0001_a'), V('0003_c')], log: { error() {} } }), /缺口或乱序/);
  assert.equal(p.log.filter((s) => /^ALTER|^SELECT 1/.test(s)).length, 0, '校验失败 ⇒ 一条都不该执行');
});

// 2026-09-15（加 0002 时发现的真问题）：initSchema 先按**最终形状**建表，新迁移刻意不写 tolerate，
// 于是全新库上 0002 的 ADD COLUMN 会报重复列 → 判失败并 break → **后续迁移永远不应用**，且每次启动刷错误日志。
// 客户装机正是这条路径。修法与 DSH 会话格式同思路：新库直接就是最新版本，不存在"迁移"。
test('运行器：全新库（核心表还不存在）→ 整条链标记为已应用，不执行任何结构语句、不报失败', async () => {
  const p = fakePool({ fresh: true });
  const said = [];
  const r = await runMigrations(p, { versions: [V('0001_a', ['ALTER TABLE t ADD COLUMN a']), { id: '0002_b', statements: ['ALTER TABLE t ADD COLUMN b'] }], log: { error() {}, log: (m) => said.push(m) } });
  assert.equal(r.fresh, true);
  assert.equal(r.failed, null, '全新库不得报迁移失败');
  assert.deepEqual(r.applied, [], '一条都不执行');
  assert.equal(p.log.filter((s) => /^ALTER|^DROP/.test(s)).length, 0, '全新库不得跑任何结构语句（表已是最终形状）');
  assert.deepEqual(p.appliedRows().sort(), ['0001_a', '0002_b'], '整条链都要记为已应用（否则下次启动又从头跑）');
  assert.ok(said.some((m) => /全新库/.test(m)), '必须出声说明为什么一条都没执行');
});

test('运行器：存量库（有表、没有迁移表）必须照常走链 —— 与"全新库"判然两分', async () => {
  const p = fakePool(); // 有 tool_calls、无 schema_migrations
  const r = await runMigrations(p, { versions: [V('0001_a', ['ALTER TABLE t ADD COLUMN a']), { id: '0002_b', statements: ['ALTER TABLE t ADD COLUMN b'] }], log: { error() {} } });
  assert.equal(r.fresh, undefined, '存量库不走走全新库分支');
  assert.deepEqual(r.applied, ['0001_a', '0002_b'], '存量库必须真的把新迁移执行掉');
  assert.ok(p.log.some((s) => s === 'ALTER TABLE t ADD COLUMN b'), '0002 的语句必须真的执行（新库不会执行它）');
});
