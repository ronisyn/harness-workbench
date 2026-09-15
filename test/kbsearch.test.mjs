// test/kbsearch.test.mjs —— 知识检索后端层（v0.3 §4.3「记忆」行：「全文检索（FTS5）打底 + 分层召回 +
// 受限自动沉淀；**向量留接口位置后补**」里的「全文检索打底」与「留接口位置」两半）
//
// 为什么要这份夹具：改造前的"检索"是 `server/tools/index.js` 里现写的
// `title LIKE ? OR body LIKE ?` —— 没有索引、没有相关度、也没有"换个检索后端"的位置。
// 本轮把口径收进 `server/kbsearch/`（接口 + 唯一选择点 + 实现）。两份东西必须有**机检**，否则
// "设计上应该没问题"就是全部证据：
//   ① 真的走 `MATCH … AGAINST`（ngram 分词），不是把 LIKE 换个名字；
//   ② 有分数、按分数降序排（相关度不是摆设）；
//   ③ 索引不可用时**如实回落 LIKE 并标明 mode='like'**（不许静默假装是全文检索），
//      而**不是这一类**的错误必须如实抛（兜底不许吞掉真故障）；
//   ④ 接缝：未知后端名如实抛错（照 test/exec-backend.test.mjs / test/storage.test.mjs 的同款写法）；
//   ⑤ 空查询 / 无结果如实返回空数组，不抛。
//
// ⚠️ 本文件**不连数据库**：`searchKnowledge` 收 db 参数就是为这个（夹具要能在任何机器上跑）。
// 真实介质上的行为（ngram 生效、中文搜得到、`MATCH` 报 1191）由一次性库实测覆盖，原始输出见交付报告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertBackend, selectBackend, searchKnowledge, searchAvailable,
  BACKEND_NAMES, KB_SEARCH_BACKEND, KB_SEARCH_BACKEND_NAME,
} from '../server/kbsearch/index.js';
import { id as FTS_ID, INDEX_NAME, INDEX_COLUMNS, isIndexUnavailable, toBooleanQuery, toLikePattern, scopeClause } from '../server/kbsearch/fts.js';
import { RW_KB_SEARCH } from '../server/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 夹具：一个记账用的假介质（不连库）----
// 只做两件事：按 SQL 形态决定返回哪一批行（模拟 MATCH / LIKE 两条路），并**记下**跑过的 SQL 与参数。
function ftsRow(n, score) {
  return { id: n, scope: 'global', title: '标题' + n, body: '正文' + n, created_at: '2026-09-16 00:00:0' + n, score };
}
function likeRow(n) {
  return { id: n, scope: 'global', title: '标题' + n, body: '正文' + n, created_at: '2026-09-16 00:00:0' + n };
}
function fakeDb({ rows = [], error = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (error) throw error;
      return rows;
    },
  };
}
function ftsKeyMissing() {
  const e = new Error("Can't find FULLTEXT index matching the column list");
  e.code = 'ER_FT_MATCHING_KEY_NOT_FOUND';
  e.errno = 1191;
  return e;
}
// 调用方（kb_search）给的可见范围条件，形状与 `kbVisibleWhere()` 产出的一致
const SCOPE = { where: 'account_id=? AND (scope="global") AND status="active"', params: [7] };

// ---- ① 真的走全文索引（不是把 LIKE 换个名字）----

test('① FTS：走 MATCH … AGAINST（ngram 索引列）而不是 LIKE，且 mode 如实报 fts', async () => {
  const db = fakeDb({ rows: [ftsRow(2, 0.9), ftsRow(1, 0.3)] });
  const r = await searchKnowledge('部署 口径', { db, ...SCOPE, limit: 8 });
  assert.equal(r.mode, 'fts', '走了全文索引就必须如实报 fts');
  assert.equal(r.backend, FTS_ID);
  assert.equal(r.degraded, false);
  assert.equal(db.calls.length, 1, 'fts 路径只该发一条查询（不许先探测再查，多一次往返）');
  const { sql, params } = db.calls[0];
  assert.match(sql, /MATCH\(title, body\) AGAINST \(\? IN BOOLEAN MODE\)/, '必须是真的 MATCH … AGAINST');
  assert.ok(!/LIKE/i.test(sql), 'fts 路径里不许出现 LIKE（那正是改造前那条假检索）');
  assert.match(sql, /ORDER BY score DESC, id ASC/, '必须按相关度降序（同分按 id 升，让顺序确定可复现）');
  assert.ok(sql.includes(SCOPE.where), '可见范围条件必须原样进 WHERE（可见性口径只有 kbVisibleWhere 一份）');
  // MATCH 必须在 WHERE 的**最前面**：实测（MySQL 8.0.46，一次性库脚本）绑定参数排在 MATCH 前面时，
  // 优化器会选 idx_kb_scope（B-tree）计划 ⇒ 同一条 SQL 返回 0 行（搜得到悄悄变成一条都搜不到）。
  // 这条断言把那个正确性要求钉住：下一个人"整理 WHERE 顺序"会当场报红。
  assert.match(sql, /WHERE MATCH\(title, body\) AGAINST \(\? IN BOOLEAN MODE\) AND \(/, 'MATCH 必须排在 WHERE 最前（排在绑定参数之后会返回 0 行）');
  assert.deepEqual(params, ['"部署" "口径"', '"部署" "口径"', 7, 8], '参数顺序必须跟着占位符：MATCH(选择项) → MATCH(WHERE) → 可见范围参数 → limit');
  assert.deepEqual(r.items.map((x) => x.id), [2, 1]);
});

test('① 相关度是**介质给的分数**：原样带出、按分数降序，不自造分数也不设阈值', async () => {
  const db = fakeDb({ rows: [ftsRow(3, 1.25), ftsRow(1, 0.5), ftsRow(2, 0.5)] });
  const r = await searchKnowledge('口径', { db, ...SCOPE });
  assert.deepEqual(r.items.map((x) => x.score), [1.25, 0.5, 0.5], '分数原样透传（本层不改写、不归一）');
  assert.deepEqual(r.items.map((x) => x.id), [3, 1, 2], '同分时的次序由介质（score DESC, id ASC）决定');
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i - 1].score >= r.items[i].score, '分数必须非升序');
  }
});

// ---- ② 兜底路径：索引不在 ⇒ 回落 LIKE，且**如实标明** ----

test("② 兜底：MATCH 报 1191 ⇒ 回落 LIKE、mode='like'、degraded=true，绝不假装 fts", async () => {
  const boom = ftsKeyMissing();
  const db = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql: String(sql), params });
      if (this.calls.length === 1) throw boom;          // 第一次：全文查询报"找不到 FULLTEXT 索引"
      return [likeRow(5), likeRow(4)];                  // 第二次：LIKE 兜底给结果
    },
  };
  const r = await searchKnowledge('部署 口径', { db, ...SCOPE });
  assert.equal(r.mode, 'like', '回落了就必须说 like —— 静默假装 fts 是最坏的一类错（§4.6 禁止静默降级同一纪律）');
  assert.equal(r.degraded, true);
  assert.equal(r.backend, FTS_ID, '后端仍是 fts，走的是它的兜底路（不是换了后端）');
  assert.match(r.detail, /回落/, '要说明白为什么退回来的');
  assert.match(r.error, /FULLTEXT index/, '原始错误要带出来，便于排障');
  assert.deepEqual(r.items.map((x) => x.id), [5, 4]);
  assert.equal('score' in r.items[0], false, 'LIKE 路径没有相关度 ⇒ 不带 score（不许编一个）');
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].sql, /\(title LIKE \? OR body LIKE \?\)/, '兜底这条路仍是改造前的口径');
  assert.ok(!/MATCH/i.test(db.calls[1].sql));
  // 参数顺序＝占位符顺序（LIKE 的两问号在最前——status 缺省守卫是**字面量**，不占位）
  assert.deepEqual(db.calls[1].params, ['%部署%口径%', '%部署%口径%', 7, 8], 'LIKE 形态沿用改造前口径（词间加 %）');
});

test('② 状态守卫：缺省只搜"当前事实"；显式给了 status / includeHistorical 才放开（与 kbVisibleWhere 同名同义）', async () => {
  // 会话侧的既有纪律（A6）：superseded/obsolete 不参与检索——这条**必须**在检索层成立，
  // 否则"从 kb_search 调只搜当前事实、从管理面调连历史一起搜"就成了没人看得出的分叉。
  const plain = fakeDb({ rows: [] });
  await searchKnowledge('部署', { db: plain, ...SCOPE, includeHistorical: true }); // SCOPE.where 里已自带 status
  const noGuard = fakeDb({ rows: [] });
  await searchKnowledge('部署', { db: noGuard, where: 'account_id=?', params: [7] });
  assert.match(noGuard.calls[0].sql, /AND status='active'/, '没给 status 又没要历史 ⇒ 必须补上 status=\'active\' 守卫');
  const hist = fakeDb({ rows: [] });
  await searchKnowledge('部署', { db: hist, where: 'account_id=?', params: [7], includeHistorical: true });
  assert.ok(!/status='active'/.test(hist.calls[0].sql), 'includeHistorical:true ⇒ 不补守卫（管理视图要看到 superseded/obsolete）');
  const explicit = fakeDb({ rows: [] });
  await searchKnowledge('部署', { db: explicit, ...SCOPE });
  assert.ok(!/AND status='active'/.test(explicit.calls[0].sql), 'where 里已经自己写了 status ⇒ 不重复插一条（同一件事不许两个出处）');
  // 兜底那条路共用同一份过滤条件（不许 fts 带守卫、like 不带）
  const fb = { calls: [], async query(sql, params) { this.calls.push({ sql: String(sql), params }); if (this.calls.length === 1) throw ftsKeyMissing(); return []; } };
  await searchKnowledge('部署', { db: fb, where: 'account_id=?', params: [7] });
  assert.match(fb.calls[1].sql, /status='active'/, 'LIKE 兜底也要带同一个守卫（两处口径必须一致）');
});

test('② 兜底判据是**窄**的：不是"索引不可用"的错一律如实抛（兜底不许吞掉真故障）', async () => {
  // 连不上/权限/语法错 —— 这些都不是"索引没建好"，接住它们就变成静默降级
  for (const e of [
    Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('Access denied for user'), { code: 'ER_ACCESS_DENIED_ERROR' }),
    Object.assign(new Error('You have an error in your SQL syntax'), { code: 'ER_PARSE_ERROR' }),
  ]) {
    const db = fakeDb({ error: e });
    await assert.rejects(() => searchKnowledge('部署', { db, ...SCOPE }), (err) => err === e,
      e.code + ' 必须原样抛出（不许被兜底吞掉）');
    assert.equal(db.calls.length, 1, '抛了就不该再发第二条查询');
  }
});

test('② 允许兜底的判据本身可机检（isIndexUnavailable 的真值表）', () => {
  assert.equal(isIndexUnavailable(ftsKeyMissing()), true);
  assert.equal(isIndexUnavailable(Object.assign(new Error("Can't find FULLTEXT index matching the column list"), { code: 'ER_FT_MATCHING_KEY_NOT_FOUND' })), true);
  // 无 ngram 插件的库：索引根本建不起来 ⇒ 归入"索引不可用"这一类（如实回落并在 detail 写明）
  assert.equal(isIndexUnavailable(new Error('Plugin ngram is not loaded')), true);
  assert.equal(isIndexUnavailable(new Error('Unknown parser ngram')), true);
  assert.equal(isIndexUnavailable(new Error('The used table type doesn\'t support FULLTEXT indexes')), true);
  // 非这一类
  assert.equal(isIndexUnavailable(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), false);
  assert.equal(isIndexUnavailable(Object.assign(new Error('Access denied for user x'), { code: 'ER_ACCESS_DENIED_ERROR' })), false);
  assert.equal(isIndexUnavailable(new Error('some unrelated failure')), false);
});

// ---- ③ 关键词 → 查询串（纯函数；含操作符字符的输入构不成注入形态）----

test('③ 布尔查询串：逐词加引号，操作符字符只当普通词（实测口径）', () => {
  assert.equal(toBooleanQuery('部署 口径'), '"部署" "口径"');
  assert.equal(toBooleanQuery('  部署   口径  '), '"部署" "口径"', '多余空白折叠');
  assert.equal(toBooleanQuery('+部署'), '"+部署"', '布尔操作符被引号包住 ⇒ 不当操作符解析');
  assert.equal(toBooleanQuery('-天气'), '"-天气"');
  assert.equal(toBooleanQuery('部署)'), '"部署)"');
  assert.equal(toBooleanQuery('a"b'), '"ab"', '内部引号被去掉，不会提前闭合短语');
  assert.equal(toBooleanQuery(''), '', '空查询 → 空串（调用方据此不落库）');
  assert.equal(toBooleanQuery('   '), '');
  assert.equal(toBooleanQuery(null), '');
  assert.equal(toBooleanQuery(123), '"123"', '非字符串按 String() 处理（模型偶尔传数字）');
});

test('③ LIKE 兜底形态与改造前**逐字相同**（词间加 %，两端加 %）', () => {
  assert.equal(toLikePattern('部署 口径'), '%部署%口径%');
  assert.equal(toLikePattern('  部署  '), '%部署%');
  assert.equal(toLikePattern(''), '%%');
});

test('③ 可见范围片段：像 SQL 片段就整体括起来（不与后面的关键词条件粘连）', () => {
  assert.equal(scopeClause('account_id=? AND status="active"'), '(account_id=? AND status="active")');
  assert.equal(scopeClause('(account_id=? AND status="active")'), '(account_id=? AND status="active")', '已经括好的不重复括');
  assert.equal(scopeClause(''), '', '空条件＝不加限制');
  assert.equal(scopeClause(null), '');
});

// ---- ④ 接口层：未知后端名如实抛错（照 exec/storage 的同款夹具）----

test('④ 选择点：默认 fts；未知后端**如实抛错**，不静默回落', () => {
  assert.equal(String(RW_KB_SEARCH).length > 0, true);
  assert.deepEqual([...BACKEND_NAMES], ['fts'], '"有哪些后端"只有一个出处（实现表）');
  assert.equal(selectBackend().id, 'fts', '缺省＝RW_KB_SEARCH，而它的缺省是 fts');
  assert.equal(KB_SEARCH_BACKEND.id, 'fts');
  assert.equal(KB_SEARCH_BACKEND_NAME, KB_SEARCH_BACKEND.id);
  for (const bad of ['vector', 'FTS', 'fts ', '', 'like']) {
    assert.throws(() => selectBackend(bad), /未知检索后端/, '未知名字必须如实抛错（静默回落到 fts 会让人以为换了后端）：' + JSON.stringify(bad));
  }
  assert.throws(() => selectBackend('vector'), /RW_KB_SEARCH 可选：fts/, '错误信息要说清可选值，否则运维只能读代码');
});

test('④ 后端不满足接口时在**装配期**就抛（缺动词/缺 id，不等到第一次检索）', () => {
  assert.throws(() => assertBackend('x', { id: 'x', search() {} }), /缺动词 .*available/, '少一个动词也不许装起来');
  assert.throws(() => assertBackend('x', { id: 'x', available() {} }), /缺动词 .*search/);
  const { id: _omit, ...noId } = { id: 'x', search() {}, available() {} };
  assert.throws(() => assertBackend('x', noId), /缺 id/);
  assert.equal(assertBackend('x', { id: 'x', search() {}, available() {} }).id, 'x', '满足接口的实现要能装起来');
  // 这是"向量留位置"的机检那一半：**加一个实现＝写一个模块 + 在实现表加一行**，
  // 只要它满足这两个动词就能被选择点选中——接口面不因为"将来是向量"而改变。
  assert.equal(typeof KB_SEARCH_BACKEND.search, 'function');
  assert.equal(typeof KB_SEARCH_BACKEND.available, 'function');
});

test('④ 索引名与列只有一份口径（建索引的两条路径 + 实现要用同一个名字）', () => {
  assert.equal(INDEX_NAME, 'ft_kb_text');
  assert.deepEqual(INDEX_COLUMNS, ['title', 'body']);
  // db.js 是"全新库按最终形状建表"那条路径：索引名与列必须与实现一致，否则新库的索引白建
  const dbSrc = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');
  assert.ok(dbSrc.includes(`FULLTEXT KEY ${INDEX_NAME} (title, body) WITH PARSER ngram`),
    'db.js 的建表语句里必须有同名同列的 ngram 全文索引（否则全新库路径缺索引）');
  // migrations.js 是"存量库升级"那条路径
  const migSrc = fs.readFileSync(path.join(ROOT, 'server', 'migrations.js'), 'utf8');
  assert.ok(migSrc.includes(`CREATE FULLTEXT INDEX ${INDEX_NAME} ON knowledge (title, body) WITH PARSER ngram`),
    'migrations.js 的链尾必须有同名同列的 ngram 全文索引（否则存量库升不上去）');
});

// ---- ⑤ available()：probe 语义（只查元数据，如实报告，不抛）----

test('⑤ available：查得到 FULLTEXT 索引 ⇒ available:true；查不到 ⇒ available:false + 说清原因', async () => {
  const ok = fakeDb({ rows: [{ INDEX_NAME: INDEX_NAME, INDEX_TYPE: 'FULLTEXT', TABLE_NAME: 'knowledge' }] });
  const a1 = await searchAvailable({ db: ok });
  assert.equal(a1.available, true);
  assert.equal(a1.backend, FTS_ID);
  assert.equal(a1.index, INDEX_NAME);
  assert.match(a1.detail, /已存在/);
  assert.match(ok.calls[0].sql, /information_schema\.STATISTICS/, 'probe 只查元数据，不起真查询');
  assert.match(ok.calls[0].sql, /TABLE_SCHEMA = DATABASE\(\)/, '按当前库查（不写死库名）');
  assert.deepEqual(ok.calls[0].params, [INDEX_NAME]);

  const none = fakeDb({ rows: [] });
  const a2 = await searchAvailable({ db: none });
  assert.equal(a2.available, false, '索引不在就必须如实说不可用');
  assert.match(a2.detail, /LIKE/, '要说明白会退到哪条路');

  const broken = fakeDb({ error: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const a3 = await searchAvailable({ db: broken });
  assert.equal(a3.available, false, '查不动介质时不许假装可用');
  assert.match(a3.error, /ETIMEDOUT/, 'probe 的语义是报事实，不是抛（照 exec/local.js 的 probe）');
});

// ---- ⑥ 空查询 / 无结果：如实返回空数组，不抛 ----

test('⑥ 空查询不落库（mode=empty）；有查询但无命中 ⇒ items 空、mode 仍是真实那条路', async () => {
  const db = fakeDb({ rows: [] });
  const e1 = await searchKnowledge('', { db });
  assert.deepEqual(e1.items, []);
  assert.equal(e1.mode, 'empty');
  const e2 = await searchKnowledge('   ', { db });
  assert.deepEqual(e2.items, []);
  assert.equal(e2.mode, 'empty');
  const e3 = await searchKnowledge(null, { db });
  assert.equal(e3.mode, 'empty');
  assert.equal(db.calls.length, 0, '空查询不许打库（省一次往返，也避免"SELECT 全表"）');

  const none = fakeDb({ rows: [] });
  const r = await searchKnowledge('不存在的词', { db: none, ...SCOPE });
  assert.deepEqual(r.items, []);
  assert.equal(r.mode, 'fts', '没命中也是走了全文检索这条路（mode 说的是路，不是有没有结果）');
  assert.equal(r.degraded, false);
});

// ---- ⑦ 形状回归：kb_search 对外那三个字段不许漂 ----

test('⑦ 条目形状与改造前一致（id/scope/title/body/createdAt），body 截断口径 1200 不变', async () => {
  const long = 'x'.repeat(2000);
  const db = fakeDb({ rows: [{ id: 1, scope: 'conv', title: 't', body: long, created_at: '2026-09-16 00:00:00', score: 0.4 }] });
  const r = await searchKnowledge('x', { db, ...SCOPE, snippet: 1200 });
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['body', 'createdAt', 'id', 'scope', 'score', 'title'],
    'score 是新增的（相关度要看得见），其余五个字段名与改造前逐字相同');
  assert.equal(r.items[0].body.length, 1200, 'body 截断口径 1200（改造前就是 slice(0, 1200)）');
  assert.equal(r.items[0].createdAt, '2026-09-16 00:00:00');
  // 不传 snippet 时＝既有口径 1200；传 0 时＝不截断（本层不发明新阈值，只给调用方开关）
  const r2 = await searchKnowledge('x', { db, ...SCOPE });
  assert.equal(r2.items[0].body.length, 1200);
  const r3 = await searchKnowledge('x', { db, ...SCOPE, snippet: 0 });
  assert.equal(r3.items[0].body.length, 2000, 'snippet:0 ⇒ 不截断（调用方明说要全量时才给）');
});

test('⑦ 缺 db 是**编程错误**：如实抛，不静默返回空', async () => {
  await assert.rejects(() => searchKnowledge('x', {}), /需要 opts\.db/);
  await assert.rejects(() => searchAvailable({}), /需要 opts\.db/);
});

// ---- ⑨ 管理面接线守卫（GET /api/knowledge 的 `q`）----
//
// 为什么用"读源码"的判据：`server/index.js` 是**入口模块**（`import` 它就会 Express 起服务、连库、跑 initSchema），
// 没法在夹具里 import 进来打桩，这条路由也没有把处理逻辑抽成可注入的函数（抽出去＝重构，超出本笔范围）。
// 本仓已有同形的源码级机检先例（`server/tools/registry.js` 的 `assertNoPermissionDeclarations`、
// `test/schema-sync.test.mjs` 抠 db.js 建表语句），所以这里照做：**钉住"这一处走的是检索后端、没有再写一份 LIKE"**。
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
function adminKnowledgeHandler() {
  const start = INDEX_SRC.indexOf("app.get('/api/knowledge'");
  assert.ok(start > 0, "找不到 app.get('/api/knowledge'（路由被改名/搬走了？这条守卫要跟着改）");
  const end = INDEX_SRC.indexOf("app.patch('/api/knowledge/:id'", start);
  assert.ok(end > start, '找不到紧随其后的 app.patch(\'/api/knowledge/:id\'（守卫的切片边界失效了）');
  return INDEX_SRC.slice(start, end);
}

test("⑨ 管理面：带 q 时走 searchKnowledge，不再自己写一份 `title LIKE OR body LIKE`", () => {
  const body = adminKnowledgeHandler();
  assert.match(body, /searchKnowledge\(q,/, '带 q 的检索必须调检索后端（全仓唯一一份"知识怎么搜"）');
  assert.ok(!/title LIKE/.test(body), '管理面不许再自己写 title/body 的 LIKE 检索（那样"怎么搜"就有两份口径）');
  assert.ok(!/k\.body LIKE/.test(body), '同上（旧写法是 k.title LIKE ? OR k.body LIKE ?）');
});

test("⑨ 管理面：空 q 走纯列表（不碰检索层）、命中后仍按 id DESC 返回展示列", () => {
  const body = adminKnowledgeHandler();
  // 空 q = 没给：`String(req.query.q || '').trim()` 之后再判真假，所以 `?q=` / `?q=%20` 都走列表那条路
  assert.match(body, /const q = String\(req\.query\.q \|\| ''\)\.trim\(\);/, 'q 要先 trim 再判真假（空白词不许当检索词）');
  assert.match(body, /if \(q\) \{/, '带 q / 不带 q 必须是两条明确分开的路');
  // 不带 q 那条路仍要 LEFT JOIN shells 取展示列（前端 web/dist 读 body_preview 与 shell_key）
  assert.match(body, /LEFT JOIN shells s ON s\.id = k\.shell_id/, '展示列仍要取（shell_key/body_preview 是管理视图的列形状）');
  assert.match(body, /LEFT\(k\.body, 200\) AS body_preview/, 'body_preview 必须在（前端读它）');
  assert.match(body, /s\.skey AS shell_key/, 'shell_key 必须在（前端读它）');
  // 顺序口径：FTS 那条路按分数、兜底按 id；管理面最后统一成 id DESC → 也就是管理视图的既有顺序
  assert.match(body, /rows\.sort\(\(a, b\) => Number\(b\.id\) - Number\(a\.id\)\)/, '管理面顺序仍按 id DESC（不改展示口径）');
});

test('⑨ 管理面：治理视图要看得见历史条目（includeHistorical 跟着 status 筛）', () => {
  const body = adminKnowledgeHandler();
  assert.match(body, /includeHistorical: !status/, '没显式筛 status ⇒ 要历史（管理视图本来就返回 superseded/obsolete）');
  // 组合过滤条件与检索层同名同义（不带表别名）：account_id/scope/shell_id/kind/status
  for (const c of ["'account_id=?'", "'scope=?'", "'shell_id=?'", "'kind=?'", "'status=?'"]) {
    assert.ok(body.includes(c), '管理面的过滤条件要与检索层同名同义：' + c);
  }
});

// ---- ⑩ 归档：复核 server/lessonrecall.js 不能走同一接口（只报告，不改） ----

test('⑩ lessonrecall 走的是 reviews 表（不是 knowledge），因此不该接 searchKnowledge', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'lessonrecall.js'), 'utf8');
  assert.match(src, /FROM reviews WHERE result='bug'/, '错题召回的候选来自 reviews 表——与 knowledge 全文索引无关');
  assert.ok(!/FROM knowledge/.test(src), '它不查 knowledge，所以检索后端接不上（硬塞就是把两个不同的东西并成一个）');
  assert.match(src, /export function pickLessons/, '它现在用的是"实词 2-gram 重叠"判据（纯函数、可夹具），不是关键词检索');
});

// ---- ⑪ 反向核对锚点：破坏上述任一条，本文件必须报红 ----
// （实测记录见交付报告：把 db.js 的 WITH PARSER ngram 去掉 ⇒ ④ 报红；把 fts.js 的兜底去掉 ⇒ ② 报红）

// ---- ⑧ 启动即失败：RW_KB_SEARCH 指到不存在的后端时进程起不来（照 exec 的同款夹具）----

test('⑧ RW_KB_SEARCH 指到不存在的后端时**进程起不来**（启动即失败，不是运行到一半才发现）', async () => {
  const url = pathToFileURL(path.join(ROOT, 'server', 'kbsearch', 'index.js')).href;
  const load = (backend) => new Promise((resolve) => {
    execFile(process.execPath, ['-e', 'import(' + JSON.stringify(url) + ')'],
      { env: { ...process.env, RW_KB_SEARCH: backend } },
      (err, stdout, stderr) => resolve({ ok: !err, stderr }));
  });
  const good = await load('fts');
  assert.equal(good.ok, true, 'fts 必须能装载（这条同时是对照，证明不是"怎么都失败"）：' + good.stderr);
  const bad = await load('vector');
  assert.equal(bad.ok, false, '未知后端必须让进程起不来');
  assert.match(bad.stderr, /未知检索后端/, '错误要说明白：' + bad.stderr.slice(0, 300));
});
