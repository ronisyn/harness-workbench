// test/kbsearch-js.test.mjs —— 检索后端之二（`server/kbsearch/like.js`：纯 JS 子串匹配）的机检
//                                ＋ 它在存储接口上的取数通道（`storage.knowledge.all`）。
//
// 为什么要有这份夹具（G1 收口 2026-09-17）：
//   在它之前，检索层只有 `fts.js` 一个实现（MySQL 8 FULLTEXT + ngram）⇒ **没有 MySQL 的机器上整条检索不可用**
//   （`kb_search` 与错题召回都拿不到结果）。补的第二个实现必须被机检，否则"设计上应该能跑"就是全部证据。
//
// 判据（七组，缺一不可）：
//   ① 真能搜到：给出记录 ⇒ 按关键词命中、按命中次数降序、同分 id 降序（顺序确定可复现）；
//   ② **如实标注**：`mode:'like'`、`degraded:true`、`backend:'like'` —— 它没有索引、没有介质给的相关度，
//      标成 fts 或标成不降级都是假话；
//   ③ 可见范围与状态守卫**由调用方那份 where/params 决定**（`kbVisibleWhere` 的产出）：
//      别人的账号 / 别人的会话 / superseded 都不许被搜出来；看不懂的条件**如实抛**（不许"当没条件"放行）；
//   ④ 对外条目形状与 fts 的 `toItem` **逐字段相同**（id/scope/title/body/createdAt 五键同名同截断口径）；
//   ⑤ `available()` 是 probe：报事实、不抛（没有记录来源 ⇒ available:false，不假装可用）；
//   ⑥ 取数通道：`storage.knowledge.all(accountId)` 两个实现都要有，且回中性字段名（与 like 的比对面一致）；
//   ⑦ 反向核对锚点：默认后端仍是 **fts**、fts 收到 `storage` 也不改行为（不许悄悄回落/切后端）。
//
// ⚠️ 本文件**不连库**：mysql 侧用假 pool（照 test/storage.test.mjs 的做法），jsonfile 侧用一次性文件。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKEND_NAMES, KB_SEARCH_BACKEND, KB_SEARCH_BACKEND_NAME, selectBackend, searchKnowledge, searchAvailable,
} from '../server/kbsearch/index.js';
import * as like from '../server/kbsearch/like.js';
import { compileWhereFn } from '../server/kbsearch/like.js';
import { kbVisibleWhere } from '../server/knowledge.js';
import { RW_KB_SEARCH } from '../server/env.js';
// ⚠️ 装载顺序要紧（与 test/storage.test.mjs 同款，实测踩过）：必须先 `storage/index.js`、再 `storage/mysql.js`。
// 反过来（先 mysql.js）会踩 ESM 环：mysql.js → db.js → … → storage/index.js → createStorage() → mysql.js 的
// `const IMPL`（还在 TDZ 里）⇒ `ReferenceError: Cannot access 'IMPL' before initialization`。
// 这是**既有**的环（不是本轮引入），本文件按既有夹具的顺序装载即可绕开。
import { CONTRACT } from '../server/storage/index.js';
import { createMysqlStorage } from '../server/storage/mysql.js';
import { createJsonFileStorage } from '../server/storage/jsonfile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-kblike-'));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// ---- 夹具：一批知识记录（形状＝存储接口的中性字段名，两个实现回的都是这个形状）----
const ACCOUNT = 7;
const CONV = 9;
const ROWS = [
  { id: 1, accountId: ACCOUNT, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '部署口径', body: '蓝绿部署的约定', status: 'active', createdAt: '2026-09-16 00:00:00' },
  { id: 2, accountId: ACCOUNT, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '无关标题', body: '正文里三次提到 部署口径、部署口径、部署口径', status: 'active', createdAt: '2026-09-16 00:00:00' },
  { id: 3, accountId: ACCOUNT, scope: 'conv', conversationId: CONV, shellId: null, kind: 'guide', title: '本会话私有', body: '部署口径', status: 'active', createdAt: '2026-09-16 00:00:00' },
  { id: 4, accountId: ACCOUNT, scope: 'conv', conversationId: 8, shellId: null, kind: 'guide', title: '别的会话私有', body: '部署口径', status: 'active', createdAt: '2026-09-16 00:00:00' },
  { id: 5, accountId: ACCOUNT, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '已被取代', body: '部署口径', status: 'superseded', createdAt: '2026-09-16 00:00:00' },
  { id: 6, accountId: 8, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '别人的账号', body: '部署口径', status: 'active', createdAt: '2026-09-16 00:00:00' },
];
const SCOPE = kbVisibleWhere({ accountId: ACCOUNT, shellId: null, conversationId: CONV });

/**
 * 假 MySQL：只认 `storage.knowledge.all` 那条语句（照 test/storage.test.mjs 的假 pool 做法，不连库）。
 * ⚠️ 回的必须是**列名形状**（`account_id` 而不是 `accountId`）——介质给的是列名，映射成中性字段名是
 * `mysql.js` 的 `toRecord()` 干的活。夹具要是直接把手里的中性记录递回去，就绕过了被测的那一步。
 */
const COLS_OF = { accountId: 'account_id', conversationId: 'conversation_id', shellId: 'shell_id', createdAt: 'created_at' };
function fakeMysql({ rows = ROWS, fail = null } = {}) {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (fail) throw fail;
      const m = /^SELECT \* FROM knowledge WHERE account_id=\? ORDER BY id ASC$/i.exec(String(sql).replace(/\s+/g, ' ').trim());
      if (!m) throw new Error('假 MySQL 不认识的语句：' + sql);
      return rows
        .filter((r) => Number(r.accountId) === Number(params[0]))
        .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [COLS_OF[k] || k, v])));
    },
    run: async () => { throw new Error('本夹具不该有写操作'); },
  };
  return { calls, storage: createMysqlStorage({ db, pool: { getConnection: async () => { throw new Error('本夹具不用事务'); } } }) };
}

// ---- ① 真能搜到 + ② 如实标注 ----

test('① 在已读出的记录上真的搜得到：命中按次数降序、同分 id 降序（顺序确定可复现）', async () => {
  const r = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params, limit: 8, snippet: 1200 });
  assert.equal(r.backend, 'like');
  assert.equal(r.mode, 'like', '本实现走的就是子串匹配 ⇒ mode 必须如实报 like');
  assert.equal(r.degraded, true, '无索引、无介质分数 ⇒ degraded 必须如实为 true（不许假装不降级）');
  // 命中集合：账号 7 + (global | 本会话 conv) + active ⇒ 1/2/3；2 的正文命中 3 次 ×2（正文里出现两处"部署口径" + 三个词）——
  // 具体次数由 countOf 数出来，这里只钉"次序"这条可复现的判据
  assert.deepEqual(r.items.map((x) => x.id), [2, 3, 1], '命中次数降序、同分 id 降序（1 与 3 都命中 1 次 ⇒ id 大的在前）');
  assert.deepEqual(r.items.map((x) => x.score), [3, 1, 1], 'score 是**命中次数**（不是介质相关度），如实带出供排序核对');
  assert.match(r.detail, /纯 JS 子串匹配/, 'detail 要说清走的是哪条路');
  // 反向：不该出现的三条一个都不许出现
  for (const id of [4, 5, 6]) {
    assert.ok(!r.items.some((x) => x.id === id), 'id=' + id + ' 不在可见范围/不是当前事实，不许被搜出来');
  }
  // 同一条查询跑两遍必须逐字一致（顺序确定可复现）
  const again = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params });
  assert.deepEqual(again.items, r.items, '同一条查询两次结果必须逐字一致');
});

test('① 空查询不读介质（mode=empty）；多词查询沿用既有 LIKE 口径（词间 % 连接后整串子串）', async () => {
  let read = 0;
  const storage = { knowledge: { all: async () => { read += 1; return ROWS; } } };
  const e = await like.search('   ', { storage, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params });
  assert.deepEqual(e.items, []);
  assert.equal(e.mode, 'empty');
  assert.equal(read, 0, '空查询不许读介质');
  // 多词：`部署 口径` 经 toLikePattern 变成 `%部署%口径%` —— 与 fts 的 LIKE 兜底**逐字相同**的形态
  const r = await like.search('部署 口径', { rows: ROWS, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params });
  assert.deepEqual(r.items.map((x) => x.id), [], '「部署 口径」要求"部署…口径"这一整串连续出现（既有 LIKE 口径），本实现不另立一套');
  assert.deepEqual((await like.search('部署', { rows: ROWS, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params })).items.map((x) => x.id).length > 0, true);
});

// ---- ③ 可见范围 / 状态守卫 / 看不懂就抛 ----

test('③ 可见范围由调用方那份 where/params 决定：别人的账号、别人的会话、superseded 都搜不出来', async () => {
  const all = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: '', params: [], includeHistorical: true });
  assert.equal(all.items.length, 6, '不加任何条件、且要历史时全部命中（这是对照，证明上面的"搜不出来"不是"怎么都搜不到"）');
  const scoped = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: SCOPE.where, params: SCOPE.params });
  assert.deepEqual(scoped.items.map((x) => x.id).sort((a, b) => a - b), [1, 2, 3]);
  // includeHistorical 与 fts 同名同义：要历史才给 true
  const hist = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: 'account_id=? AND (scope="global" OR (scope="conv" AND conversation_id=?))', params: [ACCOUNT, CONV], includeHistorical: true });
  assert.ok(hist.items.some((x) => x.id === 5), 'includeHistorical:true ⇒ superseded 也要能看到（管理视图口径）');
});

test('③ 状态守卫与 fts 同一条判据：缺省只认 active；where 里自己写了 status / includeHistorical 就不补', async () => {
  const noGuard = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: 'account_id=?', params: [ACCOUNT] });
  assert.ok(!noGuard.items.some((x) => x.id === 5), '没给 status 又没要历史 ⇒ 必须补 status="active" 守卫');
  const explicit = await like.search('部署口径', { rows: ROWS, accountId: ACCOUNT, where: 'account_id=? AND status="superseded"', params: [ACCOUNT] });
  assert.deepEqual(explicit.items.map((x) => x.id), [5], 'where 里显式写了 status ⇒ 不重复插守卫（同一件事不许两个出处）');
});

test('③ 看不懂的可见范围形态**如实抛**（不许"当没条件"把别人的私有条目放行）', () => {
  for (const bad of ['account_id LIKE ?', 'account_id IN (1,2)', 'account_id>=?', 'account_id=? OR', 'unknown_col=?']) {
    assert.throws(() => compileWhereFn(bad, [1, 2]), (e) => e.code === 'KB_LIKE_UNSUPPORTED_CONDITION',
      '看不懂的条件必须抛 KB_LIKE_UNSUPPORTED_CONDITION：' + bad);
  }
  // 看得懂的那几种要真的算得对：`<=>` 是 NULL 安全等（shell_id 为 null 的会话正好靠它命中）
  const f = compileWhereFn('account_id=? AND shell_id<=>?', [7, null]);
  assert.equal(f({ accountId: 7, shellId: null }, [7, null]), true, '两边都 NULL ⇒ 命中（MySQL `<=>` 的语义）');
  assert.equal(f({ accountId: 7, shellId: 3 }, [7, null]), false);
  assert.equal(f({ accountId: '7', shellId: null }, [7, null]), true, '数字 vs 数字串按数值比（介质给的类型不一定统一）');
  assert.equal(compileWhereFn('', [])({ anything: 1 }, []), true, '空条件＝不加限制');
});

// ---- ④ 对外形状 ----

test('④ 对外条目形状与 fts 逐字段相同（五键同名、body 截断口径 1200 不变）', async () => {
  const long = 'x'.repeat(2000);
  const rows = [{ id: 1, accountId: 7, scope: 'global', title: 'x', body: long, status: 'active', createdAt: '2026-09-16 00:00:00' }];
  const r = await like.search('x', { rows, accountId: 7, where: '', params: [], snippet: 1200 });
  const keys = Object.keys(r.items[0]).sort();
  assert.deepEqual(keys, ['body', 'createdAt', 'id', 'scope', 'score', 'title'],
    '与 fts 的 toItem 同一组字段（score 是本实现多出来的"命中次数"，如实标注而不是假装相关度）');
  assert.equal(r.items[0].body.length, 1200, 'body 截断口径 1200（调用方既有口径）');
  assert.equal(r.items[0].createdAt, '2026-09-16 00:00:00');
  const full = await like.search('x', { rows, accountId: 7, where: '', params: [], snippet: 0 });
  assert.equal(full.items[0].body.length, 2000, 'snippet:0 ⇒ 不截断（不发明新阈值）');
});

// ---- ⑤ available 是 probe ----

test('⑤ available 是 probe：有记录来源＝true、没有＝false，都报事实不抛', async () => {
  const withRows = await like.available({ rows: ROWS });
  assert.equal(withRows.available, true);
  assert.equal(withRows.backend, 'like');
  assert.match(withRows.detail, /无索引/);
  const none = await like.available({});
  assert.equal(none.available, false, '拿不到任何记录 ⇒ 不许假装可用');
  assert.match(none.detail, /不可用/);
  const st = fakeMysql().storage;
  assert.equal((await like.available({ storage: st })).available, true, '有存储接口（knowledge.all）就算就绪');
  assert.equal((await like.available({ storage: {} })).available, false, '接口对象没有 knowledge.all ⇒ 不算就绪');
  // 缺记录来源时 search 是**编程错误**，如实抛（空结果与"没搜"在调用方那里长得一样）
  await assert.rejects(() => like.search('部署', { accountId: 7 }), /需要 opts\.storage/, '缺 storage/rows 必须抛，不许静默返回空');
});

// ---- ⑥ 取数通道：storage.knowledge.all（两个实现都要有，回中性字段名）----

test('⑥ storage.knowledge.all(accountId)：mysql 实现只按账号收口、回中性字段名（含 createdAt）', async () => {
  const f = fakeMysql();
  const rows = await f.storage.knowledge.all(ACCOUNT);
  console.log('[debug] calls=', JSON.stringify(f.calls), ' rows=', JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5], '只回本账号的行（别人的不许串进来）、按 id 升序（顺序确定）');
  assert.equal(rows[0].accountId, ACCOUNT, '回的是**中性字段名**（accountId），不是 account_id');
  for (const k of ['scope', 'conversationId', 'shellId', 'kind', 'title', 'body', 'status', 'createdAt']) {
    assert.ok(k in rows[0], '记录形状缺字段 ' + k + '（检索层与展示层都读它）');
  }
  assert.equal(rows[0].createdAt, '2026-09-16 00:00:00', '介质时间戳要带出来（对外条目里的 createdAt 就是它）');
  assert.match(f.calls[0].sql, /FROM knowledge WHERE account_id=\?/, '过滤下推到 SQL（不是取回来再在内存里筛）');
  assert.deepEqual(f.calls[0].params, [ACCOUNT]);
});

test('⑥ storage.knowledge.all(accountId)：jsonfile 实现同一条语义（只按账号收口、同一个字段形状）', async () => {
  const file = path.join(TMP, 'kb-store.json');
  const st = createJsonFileStorage({ file });
  // 直接按存储文件的形状铺数据（本实现只读 knowledge；写入路径不在本轮范围，见报告 ⑥）
  const doc = {
    format: 'rw-store-json', version: 1, counters: { knowledge: 6 },
    tables: { knowledge: Object.fromEntries(ROWS.map((r) => [String(r.id), { ...r }])) },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  const rows = await st.knowledge.all(ACCOUNT);
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4, 5], '与 mysql 实现同一条口径：只回本账号、id 升序');
  assert.equal(rows[0].accountId, ACCOUNT);
  assert.ok('createdAt' in rows[0]);
  // 读出去的是快照：改返回值不许改到文件里
  rows[0].title = '被调用方改掉的值';
  assert.equal((await st.knowledge.all(ACCOUNT))[0].title, '部署口径', '读出去的对象若与介质内部共享引用，调用方就"改了文件但没落盘"');
});

// ---- ⑦ 反向核对：默认仍是 fts，fts 收到 storage 也不改行为 ----
test('⑦ 默认后端仍是 fts；like 只在显式选中时生效（不许悄悄回落/切后端）', () => {
  assert.equal(RW_KB_SEARCH, 'fts', 'RW_KB_SEARCH 的缺省必须仍是 fts —— 有 MySQL 的机器行为一个字节都不变');
  assert.deepEqual([...BACKEND_NAMES], ['fts', 'like'], '"有哪些后端"只有一个出处');
  assert.equal(KB_SEARCH_BACKEND.id, 'fts');
  assert.equal(KB_SEARCH_BACKEND_NAME, 'fts');
  assert.equal(KB_SEARCH_BACKEND_NAME, KB_SEARCH_BACKEND.id);
  assert.equal(selectBackend('like').id, 'like', '显式选中 like 才走 JS 实现');
  assert.throws(() => selectBackend('like '), /未知检索后端/, '名字带空格同样是未知（不做 trim 猜测）');
});

test('⑦ 选中的 fts 收到 storage 也不改行为（不因为多了个参数就换路/回落）', async () => {
  const calls = [];
  const db = {
    async query(sql, params) { calls.push({ sql: String(sql), params }); return [{ id: 1, scope: 'global', title: 't', body: 'b', created_at: 'x', score: 0.5 }]; },
  };
  const r = await searchKnowledge('部署', { db, storage: fakeMysql().storage, accountId: 7, where: 'account_id=?', params: [7], limit: 8 });
  assert.equal(r.mode, 'fts', '有 MySQL 时仍走 MATCH … AGAINST（storage 参数不该把它带偏）');
  assert.equal(r.backend, 'fts');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /MATCH\(title, body\) AGAINST/);
  const av = await searchAvailable({ db });
  assert.equal(av.backend, 'fts');
  assert.equal(av.available, false);
});

test('⑦ 后端名与实现表对得上：`like` 就是 like.js（不是把 fts 换个名字）', () => {
  assert.equal(like.id, 'like');
  assert.equal(typeof like.search, 'function');
  assert.equal(typeof like.available, 'function');
  // 源码级：like.js 里不许出现 SQL 关键字（它存在的全部理由就是"不碰 SQL"）
  const src = fs.readFileSync(path.join(ROOT, 'server', 'kbsearch', 'like.js'), 'utf8');
  for (const kw of ['MATCH(', 'SELECT ', 'FROM knowledge', 'LIKE ?']) {
    assert.ok(!src.includes(kw), 'like.js 里不该出现 SQL 片段 ' + JSON.stringify(kw) + '（那它就不是"纯 JS"实现了）');
  }
});
