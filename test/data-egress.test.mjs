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
