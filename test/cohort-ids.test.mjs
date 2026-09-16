// test/cohort-ids.test.mjs —— 真实流量归属的**JS 复算**与 SQL 判据同源（裁定 A 的第一块，v0.3 §4.1 / §4.8 C1/C2）
//
// 为什么补这条夹具：`REAL_WHERE` 带跨表子查询，JSON 介质表达不了 ⇒ 裁定 A 把归属改成"先解析 id 集合、
//   再按 id 取用量行"。这条路径的全部风险集中在"**JS 那套会不会和 SQL 那套判得不一样**"——本题把它钉死：
//   同源（都由 `PROBE_TITLE_RE` 生成）＋ 逐条对齐 SQL 的语义（含两次实测踩过的坑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realConversationIds, PROBE_TITLE_RE, PROBE_WHERE, REAL_WHERE } from '../server/cohort.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = (id, title) => ({ id, title });

test('探针命名族：四种写法都判成探针（`__x__` / `ST-` / `B1`、`B1-x`、`B2C` / `PROBE`）', () => {
  const conversations = [
    C(1, '__probe__ 一次性'), C(2, 'ST-冒烟'), C(3, 'B1'), C(4, 'B1-x'), C(5, 'B2C'), C(6, 'B7'), C(7, 'PROBE'),
    C(8, '正常会话'), C(9, '看板复盘'),
  ];
  assert.deepEqual(realConversationIds({ conversations }), [8, 9], '只有两个真实会话');
});

test('反向：真实标题里出现"探针/探针会话"不算探针（那条判据已被证伪，别再走回头路）', () => {
  const conversations = [C(1, '讨论：探针怎么加'), C(2, 'B2 方案对比'), C(3, 'PROBE 这个词的用法')];
  // `B2 方案对比` 是 PROBE_TITLE_RE 收紧的原因（数字后必须紧跟 -/结束/大写字母）；`PROBE 这个词…` 不是裸 PROBE
  assert.deepEqual(realConversationIds({ conversations }), [1, 2, 3], '关键词不是判据：三个都该算真实');
});

test('已删除的探针会话：账本（prefix:）里出现过、且已不在 conversations ⇒ 判探针（捞回来）', () => {
  const conversations = [C(10, '正常会话'), C(11, '另一个正常会话')];
  const ids = realConversationIds({ conversations, probeLedgerConvIds: [10, 11, 528, 569] });
  // 10/11 是**现存**会话 ⇒ 即便落了 prefix 账也不算探针（2026-09-15 实测：不这样限定会把真实会话误杀）
  assert.deepEqual(ids, [10, 11], '现存的照样算真实，已删的（528/569）不影响名单');
  // 已删的会话本来就不在名单里（名单只由现存会话构成），这一条钉的是"不会被捞进来"
  assert.equal(ids.includes(528) || ids.includes(569), false);
});

test('孤儿与空值：`conversation_id IS NULL` / 会话已删 的行天然不在名单里；空输入不炸', () => {
  assert.deepEqual(realConversationIds({ conversations: [], probeLedgerConvIds: [1, 2, null, undefined] }), []);
  assert.deepEqual(realConversationIds({}), []);
  assert.deepEqual(realConversationIds({ conversations: [C(3, '真实')], probeLedgerConvIds: [null, undefined] }), [3], '账本里的空值跳过，不影响判断');
});

test('同源：JS 复算与 SQL 判据由同一组常量生成（各写一套 = 两套 cohort 口径）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'cohort.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function realConversationIds'));
  assert.match(fn, /new RegExp\(PROBE_TITLE_RE\)/, 'JS 侧必须用同一份命名族常量（不是抄一份正则）');
  assert.match(PROBE_TITLE_RE, /^\^\(/, '命名族常量本身是个正则串');
  assert.match(PROBE_WHERE('u'), /title REGEXP/, 'SQL 侧也是同一份常量');
  assert.match(REAL_WHERE('u'), /NOT .*PROBE_WHERE|NOT \(/, '真实流量 = 非探针 且 非孤儿（两边同一条定义）');
  assert.match(REAL_WHERE('u'), /NOT \(u\.conversation_id IS NULL/, '孤儿那一支（含 NULL）也在定义里');
});
