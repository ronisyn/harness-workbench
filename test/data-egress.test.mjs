// test/data-egress.test.mjs - D3（OP-01）数据出口：注入层必须按账号过滤 + 边界要如实声明
//
// 起因是一个真缺口（不是假想）：错题召回（OP-12）的候选 SQL 写在 server/index.js 里，
// `SELECT ... FROM reviews WHERE result='bug' ...` **没有任何账号过滤** ⇒ 取的是全平台所有账号的错题，
// 再按"实词重叠"最多挑 3 条注入当前会话的上下文；而同一份数据在 HTTP 面（GET /api/reviews）是
// 按 `account_id=?` 过滤的 —— 两处口径不一致，模型上下文因此成了一条绕过账号边界的数据出口。
// 修法：SQL 与过滤条件收进 server/lessonrecall.js 的 recallLessons（照 /api/reviews 那一条口径，不发明新规则），
// 本夹具直接断言"过滤条件在不在、参数对不对"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recallLessons, LESSON_CANDIDATE_SQL, pickLessons } from '../server/lessonrecall.js';
import { capabilityManifest, DATA_EGRESS, ENFORCEMENT_VALUES } from '../server/capabilities.js';
import { listDeliveries, MAX_LIST } from '../server/deliveries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 假库：记录收到的 SQL 与参数，返回两行候选（一行属于本账号、一行属于别的账号——真实现里后者根本不该被查出来）
function fakeDb(rows) {
  const seen = [];
  return { seen, query: async (sql, params) => { seen.push({ sql, params }); return rows; } };
}

test('候选 SQL 必须带账号过滤（这是"注入层按账号过滤"的落点）', async () => {
  assert.match(LESSON_CANDIDATE_SQL, /account_id=\?/, 'SQL 里必须有 account_id 过滤条件');
  assert.match(LESSON_CANDIDATE_SQL, /result='bug'/, '仍然只看错题（原口径不变）');
  const db = fakeDb([]);
  await recallLessons(db, { accountId: 42, content: '修一下这个 bug' });
  assert.equal(db.seen.length, 1, '只该发一条查询');
  assert.deepEqual(db.seen[0].params, [42, 30], '第一个参数必须是本会话账号（第二个是候选上限）');
});

test('不同账号 → 参数跟着变（不是把 42 写死在别处）', async () => {
  const db = fakeDb([]);
  await recallLessons(db, { accountId: 7, content: '修复登录报错', limit: 5 });
  assert.deepEqual(db.seen[0].params, [7, 5]);
});

test('拿不到账号就不召回（宁可不注入，也不查全平台）', async () => {
  const db = fakeDb([{ id: 1, bug_reason: '修复登录报错时踩过 X' }]);
  assert.deepEqual(await recallLessons(db, { content: '修复登录报错' }), [], '缺 accountId 时必须返回空');
  assert.deepEqual(await recallLessons(null, { accountId: 1, content: 'x' }), [], '缺库时同样返回空');
  assert.equal(db.seen.length, 0, '缺账号时**不该发出任何查询**——那正是原来的泄漏形态');
});

test('召回仍然"宁缺勿滥"：闲聊不注入、不沾边不注入（原有行为不许退化）', async () => {
  const rows = [{ id: 1, bug_reason: '修复登录接口时踩过 cookie 作用域问题' }, { id: 2, bug_reason: '部署脚本少了一个换行' }];
  const db = fakeDb(rows);
  const hit = await recallLessons(db, { accountId: 1, content: '修复登录接口的 cookie 问题' });
  assert.equal(hit.length, 1, '沾边的那条要召回');
  assert.equal(hit[0].id, 1);
  const chat = await recallLessons(db, { accountId: 1, content: '今天天气不错' });
  assert.deepEqual(chat, [], '闲聊一条都不注入');
  assert.deepEqual(pickLessons('修复登录接口', []), [], '没有候选就返回空');
});

test('能力清单必须如实写数据出口的边界（不能让人以为已经隔离好了）', () => {
  const m = capabilityManifest({ permission: 'full', preset: 'all', mode: 'chat' }, { tools: ['read_file'] });
  assert.ok(m.dataEgress, 'dataEgress 必须是一等字段');
  assert.ok(ENFORCEMENT_VALUES.includes(m.dataEgress.level), 'level 取值域必须与 §7.2 同域');
  assert.equal(m.dataEgress.level, 'partial', '边界是"按会话权限"而不是行级租户隔离 ⇒ 只能报 partial');
  assert.equal(m.dataEgress.injectedScope, 'account', '注入层的口径要写出来');
  assert.match(m.dataEgress.note, /db_query/, '最容易被误读的那条（全库只读、不做行级隔离）必须点出来');
  assert.ok(m.promptInjection && m.promptInjection.level, 'promptInjection 不许被这次改动挤掉');
});

test('注入层的代码里不再有"不带账号过滤的错题查询"（源码级回归锁）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.ok(!/FROM reviews WHERE result='bug'/.test(idx), 'SQL 不该再留在 index.js 里手拼');
  assert.match(idx, /recallLessons\(db, \{ accountId: req\.user\.id/, '注入点必须用带账号过滤的那个入口');
});

// ── 同一个边界的第二条路：死信列表 `GET /api/deliveries`（C-49，2026-09-16 补）────────────────────
// 缺口原文：该路由只有 `requireAuth`，而 `listDeliveries` 的查询**没有任何账号维度** ⇒ 任何登录账号
// 都能读到别人的 idemKey / conversationId / lastError / messageId / runId。收口口径照本文件那条老规矩：
// **按调用者账号过滤**（全仓没有管理员角色/中间件，也没有跨账号运营视图，所以不发明一个）。
test('死信列表按账号**下推**到介质（不是取回来再在内存里筛）', async () => {
  const seen = [];
  const store = { deliveries: { list: async (q) => { seen.push(q); return []; } } };
  await listDeliveries({ state: 'failed', limit: 5, accountId: 42, store });
  assert.deepEqual(seen, [{ state: 'failed', limit: 5, accountId: 42 }],
    '账号必须跟着查询一起到介质：只有落进 WHERE account_id=?，LIMIT 窗口才是"我的最近几条"；'
    + '在内存里事后筛等于先把别人的行算进窗口，我自己的死信反而会被挤掉');
  assert.equal(MAX_LIST, 100, '窗口上限仍是接口自己那个值（收口不许顺手改它）');
});

test('不传账号＝不筛：默认行为不变，收口由调用方显式决定', async () => {
  const seen = [];
  const store = { deliveries: { list: async (q) => { seen.push(q); return []; } } };
  await listDeliveries({ limit: 5, store });
  assert.deepEqual(seen, [{ state: null, limit: 5, accountId: undefined }], '不传就是 undefined，介质据此不加账号条件');
});

test('路由那一行必须把调用者账号传下去（这条是源码锁；行为面由上面两条 + 真库夹具覆盖）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const at = idx.indexOf("app.get('/api/deliveries'");
  assert.ok(at > 0, '路由必须还在（改名要连带改这条）');
  const body = idx.slice(at, idx.indexOf('});', at));
  assert.match(body, /listDeliveries\(\{[^}]*accountId:\s*req\.user\.id/s,
    '该路由必须显式传调用者账号：漏掉这一行就是"任何登录账号都能读别人的投递记录"');
});
