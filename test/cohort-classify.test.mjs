// test/cohort-classify.test.mjs —— 五档归类的 **JS 复算**（`classifyConversationIds`）判据夹具
//
// 为什么单独一条：2026-09-18 起 `collectUsage` 不再按五档各发两条带子查询的 SQL，而是
// "一次读回窗口内的行 + 在 JS 里分档"。分档判据**只能有一份**（与那些 SQL 片段同源），
// 所以这里逐档锁边界，并锁住"同源"这件事本身（常量从同一个出处来，不许各抄一份）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyConversationIds, cohortOf, PROBE_TITLE_RE, SAMPLE_TASK_PREFIX,
  REAL_WHERE, HUMAN_WHERE, SCHEDULED_WHERE, PROBE_WHERE, ORPHAN_WHERE,
} from '../server/cohort.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = () => fs.readFileSync(path.join(ROOT, 'server', 'cohort.js'), 'utf8');

const CONVS = [
  { id: 1, title: '真实长会话' },
  { id: 2, title: 'B2 方案对比' },              // 被判据证伪过的误杀样本：必须算真实
  { id: 3, title: '讨论探针与 B1 的那次复盘' },   // 正文/标题里出现"探针"但**不在命名族**：算真实
  { id: 4, title: '__probe__ rw-run: 日报' },   // 命名族 __xxx__
  { id: 5, title: 'ST-压测' },                  // 命名族 ST-
  { id: 6, title: 'B3' },                       // 命名族 B3
  { id: 7, title: '定时任务：每日巡检' },         // 定时任务档
  { id: 8, title: '定时任务：RA35样本-日报', externalId: 'task-9' },   // 样本（同时满足定时任务）
  { id: 9, title: '定时任务：别的任务', externalId: 'task-8' },        // 普通定时任务（外部 id 指向非样本任务）
  { id: 10, title: '真实但已删过的会话' },
];
const TASKS = [{ id: 9, name: 'RA35样本-日报' }, { id: 8, name: '别的任务' }];
const mk = (o = {}) => classifyConversationIds({ conversations: CONVS, scheduledTasks: TASKS, ...o });

test('五档边界：命名族/账本/已删/定时/样本/无主行，逐条对', () => {
  const c = mk({ probeLedgerConvIds: [11, 10] });
  assert.equal(c.label(1), 'human');
  assert.equal(c.label(2), 'human', 'B2 方案对比 不能被 `B[1-7]` 误杀（判据已收紧，有历史教训）');
  assert.equal(c.label(3), 'human', '标题里有"探针"二字但不在命名族 ⇒ 真实（关键词判据已被证伪）');
  assert.equal(c.label(4), 'probe');
  assert.equal(c.label(5), 'probe');
  assert.equal(c.label(6), 'probe');
  assert.equal(c.label(7), 'scheduled');
  assert.equal(c.label(8), 'sample', '`task-9` 且任务名带样本前缀 ⇒ 样本档');
  assert.equal(c.label(9), 'scheduled', '外部 id 指向的任务不是样本 ⇒ 仍是定时任务');
  assert.equal(c.label(null), 'orphan', '无主行（headless/直调）');
  assert.equal(c.label(999), 'orphan', '查不到的会话 id ⇒ 孤儿（已删）');
  assert.equal(c.label(10), 'human', '账本里出现过、但**现存的**会话不算探针（2026-09-15 实测踩过）');
  assert.equal(c.label(11), 'probe', '账本里出现过、且**已不在** conversations ⇒ 捞回成探针（已删的探针会话）');
});

test('"真实流量"＝人发起 ∪ 定时任务 ∪ 样本（与 `REAL_WHERE` 同一条判据）', () => {
  const c = mk({ probeLedgerConvIds: [11] });
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 999];
  const labelOf = (id) => (id === 999 ? 'orphan' : c.label(id));
  const real = ids.filter((id) => cohortOf(labelOf(id)) === 'real');
  assert.deepEqual(real, [1, 2, 3, 7, 8, 9, 10], '真实流量＝人发起(1/2/3/10) ∪ 定时(7/9) ∪ 样本(8)');
  assert.equal(cohortOf('probe'), 'probe');
  assert.equal(cohortOf('orphan'), 'orphan');
  const human = ids.filter((id) => labelOf(id) === 'human');
  assert.deepEqual(human, [1, 2, 3, 10], '「人发起」显式排掉定时任务与样本（不排就会同时算进两档）');
});

test('同源锁：JS 复算与那四条 SQL 片段必须由同一组常量生成（不许各抄一份）', () => {
  const s = src();
  // JS 侧：探针族必须用 `new RegExp(PROBE_TITLE_RE)`、样本必须用 `SAMPLE_TASK_PREFIX`
  assert.match(s, /const re = new RegExp\(PROBE_TITLE_RE\)/, '探针判据要复用导出的常量，不许手写第二份正则');
  assert.match(s, /startsWith\(SAMPLE_TASK_PREFIX\)/, '样本判据要复用导出的前缀常量');
  assert.match(s, /startsWith\('定时任务：'\)/, '定时任务档与 `SCHEDULED_WHERE` 用同一个标题前缀');
  // SQL 侧：那几条片段也必须引用同一组常量（模板里出现常量名/同一前缀字面量）
  assert.match(s, /export const SCHEDULED_WHERE[\s\S]*?定时任务：/, 'SCHEDULED_WHERE 的标题前缀');
  assert.match(s, /export const SAMPLE_WHERE[\s\S]*?\$\{SAMPLE_TASK_PREFIX\}/, 'SAMPLE_WHERE 必须引用样本前缀常量');
  assert.match(s, /export const PROBE_WHERE[\s\S]*?\$\{PROBE_TITLE_RE\}/, 'PROBE_WHERE 必须引用探针族常量');
  // 锚点仍在：这几条片段是"跨表子查询"形态，JS 复算才是走接口那条路
  assert.match(REAL_WHERE('u'), /conversation_id IN \(SELECT id FROM conversations/);
  assert.ok(PROBE_WHERE('u') && ORPHAN_WHERE('u') && HUMAN_WHERE('u') && SCHEDULED_WHERE('u'));
  assert.ok(PROBE_TITLE_RE.length > 0);
});
