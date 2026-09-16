// test/eventlog-archive.test.mjs - 事件账本归档（RA-47 未闭环项，2026-09-15 补齐）
//
// 保留口径不自己发明：沿用审计账本那一条（`audit_log` 的 90 天归档口径，见 migrations 里 A9 的注释）。
// 本夹具的价值全在**顺序**上——归档是"先插入归档表、插入成功才删原表"：
//   ① 只有早于阈值的行被搬走（阈值内的行一行不动）；
//   ② 插入失败时**一行都不许删**（宁可少归档，不许丢数据）；
//   ③ 幂等（重复跑不重复归档）。
// 前三条用可注入的假库（db 参数仅供夹具用），第四条用真库 + **自己造的 100 天前行**验证 SQL 真的走通。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveOldEvents, EVENT_ARCHIVE_DAYS } from '../server/eventlog.js';
import { createMysqlStorage } from '../server/storage/mysql.js';
import { VERSIONS } from '../server/migrations.js';
import { pool } from '../server/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 假库：只实现归档用到的两类语句（与 migrations 夹具同风格：按 SQL 片段分派）──────────────
// 记录 calls 是为了回答"插入失败时到底有没有发出 DELETE"——那是本任务最要紧的一条。
// **2026-09-16（裁定 C）**：搬表机制从 `eventlog.js` 搬进了介质（`server/storage/mysql.js`），
// 所以这里不再把假库直接喂给领域函数 —— 而是**喂给真的 mysql 存储实现**（`createMysqlStorage({db})`）。
// 这样测的仍是"真的那套语句与顺序"（假库只认这三种形状，形状一改就红），而不是替身自己的语义。
function fakeEventsDb(rows, opts = {}) {
  const events = [...rows];
  const archive = [...(opts.archive || [])];
  const calls = [];
  const now = Date.now();
  return {
    events, archive, calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO events_archive/.test(sql)) {
        if (opts.failInsert) throw new Error(opts.failInsert);
        // 真实的 INSERT ... SELECT 由库自己挑选：假库按 id 从 events 里捞
        const ids = new Set(params);
        archive.push(...events.filter((e) => ids.has(e.id)).map((e) => ({ ...e, archived_at: new Date() })));
        return [];
      }
      const m = /FROM events WHERE created_at < NOW\(\) - INTERVAL \? DAY/.exec(sql);
      if (m) return events.filter((e) => e.created_at < now - Number(params[0]) * 86400000).slice(0, Number(params[1])).map((e) => ({ id: e.id }));
      return [];
    },
    async run(sql, params) {
      calls.push({ sql, params });
      if (/DELETE FROM events/.test(sql)) {
        const ids = new Set(params);
        const before = events.length;
        for (let i = events.length - 1; i >= 0; i--) if (ids.has(events[i].id)) events.splice(i, 1);
        return { affectedRows: before - events.length };
      }
      return { affectedRows: 0 };
    },
  };
}
// 归档用的存储面：假库 → 真实现（`capabilities()` 因此报的是 mysql 的真实能力：archive:true）
const mysqlOf = (fake) => createMysqlStorage({ db: fake });
const row = (id, daysAgo) => ({ id, conversation_id: 1, seq: id, type: 'tool_done', payload: { i: id }, created_at: Date.now() - daysAgo * 86400000 });

test('只归档早于阈值的行：阈值内的行一行不动', async () => {
  const fake = fakeEventsDb([row(1, 100), row(2, 91), row(3, 89), row(4, 1)]);
  const r = await archiveOldEvents({ dbc: mysqlOf(fake) });
  assert.deepEqual(r, { archived: 2, deleted: 2 });
  assert.deepEqual(fake.archive.map((e) => e.id), [1, 2], '只有 >90 天的两行进归档表');
  assert.deepEqual(fake.events.map((e) => e.id), [3, 4], '阈值内的两行必须原样留在 events');
  assert.equal(EVENT_ARCHIVE_DAYS, 90, '保留天数就是审计账本那一条（90 天），不许另发明');
});

test('插入失败时一行都不许删：宁可少归档，不许丢数据', async () => {
  const fake = fakeEventsDb([row(1, 100), row(2, 100)], { failInsert: '归档表写入失败（模拟）' });
  await assert.rejects(() => archiveOldEvents({ dbc: mysqlOf(fake) }), /归档表写入失败/, '失败必须抛出去（不能静默报成"归档了 0 行"）');
  assert.equal(fake.calls.some((c) => /DELETE FROM events/.test(c.sql)), false, '插入没成功 ⇒ 一个字都不许删');
  assert.deepEqual(fake.events.map((e) => e.id), [1, 2], '原表必须原封不动');
});

test('幂等：重复跑不重复归档（第二次没得搬）', async () => {
  const fake = fakeEventsDb([row(1, 100), row(2, 100), row(3, 5)]);
  const dbc = mysqlOf(fake);
  assert.deepEqual(await archiveOldEvents({ dbc }), { archived: 2, deleted: 2 });
  assert.deepEqual(await archiveOldEvents({ dbc }), { archived: 0, deleted: 0 }, '第二次没得搬');
  assert.deepEqual(fake.archive.map((e) => e.id), [1, 2], '归档表里不得出现重复行');
});

// ── 裁定 C：没有归档能力的介质**跳过并留痕**（不抛错、也不报成"归档成功 0 行"）──────────────
// 这是 JSON 介质（干净机器）上真实发生的那条路：同一份文件里没有 events_archive 表。
test('介质自报没有归档能力 ⇒ 跳过并留痕（返回值是 skipped，不是"归档 0 行"）', async () => {
  const traces = [];
  const dbc = {
    capabilities: () => ({ medium: 'jsonfile', archive: false, rawSql: false }),
    audit: { append: async (f) => { traces.push(f); return { id: traces.length }; } },
  };
  const r = await archiveOldEvents({ dbc });
  assert.equal(r.skipped, true, '返回 skipped');
  assert.match(r.reason, /events_archive/, '原因里要说清缺的是什么');
  assert.deepEqual(traces.map((t) => t.action), ['archive:skip'], '必须留痕（一条 archive:skip 审计）');
  assert.match(traces[0].detail, /^events: /, 'detail 里写清范围与原因');
  assert.match(traces[0].detail, /jsonfile/, 'detail 里带上介质名（排障时要知道是哪一份介质）');
});

test('领域侧不再自己写 SQL：搬表语句只在介质里（策略与机制分家）', () => {
  const src = read('server/eventlog.js');
  assert.equal(/INSERT INTO events_archive|DELETE FROM events/.test(src), false, 'eventlog.js 里不许再出现搬表语句');
  assert.match(src, /capabilities\(\)|mediumCapabilities/, '跳过判据来自介质自报的能力面');
});

test('两条路径都要建归档表（存量库走迁移、新库走 SCHEMA，缺一不可）', () => {
  assert.ok(VERSIONS.some((v) => v.id === '0004_events_archive'), '迁移链必须有 0004_events_archive');
  assert.match(read('server/db.js'), /CREATE TABLE IF NOT EXISTS events_archive/, '新库 SCHEMA 也要建这张表');
  assert.match(read('server/index.js'), /archiveOldEvents/, '必须接到既有清理入口（不清 = 表照样无界增长）');
});

// 机检：本文件的形状（真库探测**不许**在模块顶层 await）。为什么非有它不可：那种坏形态在读数里只表现为
// "数字变小"，没有任何一条断言会红 ⇒ 不机检的话，下一个"顺手简化"回去的人不会被拦住。
// **它必须登记在真库探测之前**（这条不是风格）：顶层 await 会把它后面注册的一切都吞掉，包括机检自己 ——
// 实测把探测改回顶层 await 时，放在它后面的机检连跑都跑不到（读数仍是 4 条 / skipped 0，看不出红）。
test('机检：真库探测不许在模块顶层 await（否则那条测试来不及登记，读数少一条却报 skipped 0）', () => {
  const src = read('test/eventlog-archive.test.mjs');
  const topLevelAwait = src.split(/\r?\n/).filter((l) => l === l.trimStart() && /^(?:await\b|(?:const|let|var)\s+\w+\s*=\s*await\b)/.test(l));
  assert.deepEqual(topLevelAwait, [], '顶层 await 会让它后面的 test() 在 --test-force-exit 下根本没被登记：' + topLevelAwait.join(' / '));
  assert.match(src, /await dbReachable\(\)/, '真库可达性探测必须在测试体内（先登记，再决定跑或如实 skip）');
});

// ── 真库：自己造的 100 天前行，验证"归档 → 删除"真的走通 ────────────────────────────────────
// 只用 conversation_id = 负哨兵造数据、只按这个 id 清理；**绝不动真实事件数据**。
// 阈值用库的 NOW() 比较（不拿 JS 本地时间推断，时区/时钟偏差都不会把结论带歪）。
// ⚠️ CI（GitHub Actions）**没有 MySQL**：真库不可达时这条必须**跳过**并说明原因，
//    否则"本地能跑、CI 判红"，久而久之大家就不看 CI 了。跳过不是掩盖——它只跳过"真库"这一条，
//    前面三条（可注入假库）在任何环境都跑。
const SENTINEL = -990004701;
const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const myRows = async (tbl) => (await pool.query(`SELECT COUNT(*) c FROM ${tbl} WHERE conversation_id=?`, [SENTINEL]))[0][0].c;

// 可达性探测**必须留在测试体内**（2026-09-15 修；原实现是模块顶层 `await pool.query('SELECT 1')`）：
//   为什么顶层不行：本仓基线命令是 `node --test --test-force-exit`。已登记的测试一跑完，运行器就结束进程，
//   **顶层 await 的续体根本没机会恢复** ⇒ 它后面那条 `test(...)` 从未被登记：读数只剩 4 条、`# skipped 0`。
//   那不是"跳过"，是"少了一条却看不出来"——比红更坏（绿得没有依据）。放进体内则：测试**先登记**，
//   跑不跑由体内探测决定，读数里永远看得见"这条没跑，因为无库"。
// 不另加超时阈值：连不上时 mysql2 自己的 connectTimeout（默认 10s）就把探测收敛成 reject，够用。
const dbReachable = async () => {
  try { await pool.query('SELECT 1'); return true; } catch { return false; }
};

test('真库：100 天前的行被搬进 events_archive 并从 events 删除（阈值内的行不动）', async (t) => {
  if (!(await dbReachable())) return t.skip('真库不可达（CI 无 MySQL；本地隧道开着时应跑这条）');

  const cleanup = async () => {
    await pool.query('DELETE FROM events WHERE conversation_id=?', [SENTINEL]);
    await pool.query('DELETE FROM events_archive WHERE conversation_id=?', [SENTINEL]);
  };
  await cleanup();
  try {
    const [[{ now }]] = await pool.query('SELECT NOW() now');
    const old1 = new Date(now.getTime() - 100 * 86400000), old2 = new Date(now.getTime() - 95 * 86400000);
    const recent = new Date(now.getTime() - 3600000); // 1 小时前：远在阈值内
    for (const [i, at] of [old1, old2, recent].entries()) {
      await pool.query('INSERT INTO events (conversation_id, seq, type, payload, created_at) VALUES (?,?,?,?,?)',
        [SENTINEL, i + 1, 'tool_done', JSON.stringify({ probe: i }), fmt(at)]);
    }
    assert.equal(await myRows('events'), 3, '夹具自己造的三行必须都在（造数据失败就别往下结论）');
    assert.equal(await myRows('events_archive'), 0);

    const a = await archiveOldEvents();
    assert.ok(a.archived >= 2 && a.deleted >= 2, '至少搬走自己造的两行，实际 ' + JSON.stringify(a));
    assert.equal(await myRows('events'), 1, '只剩 1 小时前那一行（阈值内的不许动）');
    assert.equal(await myRows('events_archive'), 2, '两行 100/95 天前的行已在归档表');
  } finally {
    await cleanup(); // 跑完清理自己造的数据，别给真库留垃圾
  }
  assert.equal(await myRows('events'), 0, '清理过了：events 里不留哨兵行');
  assert.equal(await myRows('events_archive'), 0, '清理过了：归档表里不留哨兵行');
});
