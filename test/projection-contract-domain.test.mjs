// test/projection-contract-domain.test.mjs - 契约域事实不得被折成"当前 run 出错"（C-46① 的夹具，2026-09-15）
//
// 背景：C-39② 判定 `contract_events` 与 `events` **同源**（`server/eventlog.js` 的 `persistContractEvent`
//   一次调用里先落账本、后落投影行），契约事实从此也进同一个账本；追溯判据是**等式**：
//   账本 `type` === 契约 `kind`、账本 `payload.contractId` === `contract_events.contract_id`。
// 为什么必须钉住：契约 `kind` 里就有 `error` / `run_end` 这类**与会话帧同名**的值。投影器若按 `type` 折叠，
//   一条 `type='error'` 的契约事实就会被折成"当前 run 出错"，凭空产出 `run:-` 这条账本里根本没有的结局。
//   发生面窄，但"投影会说谎"是投影最不能有的毛病——它的全部价值就是与业务表对账时，说的每一条都真发生过。
// 判据（都只看投影结果，不看实现）：
//   ① 混入契约事实的账本 与 只有会话帧的账本，投影结果**逐字节相同**（含 `__applied`）；
//   ② 同名的 `type='error'`：带 `contractId` 的整条跳过，不带的仍按会话帧折叠（收窄的只是契约域）。
import { test } from 'node:test';
import assert from 'node:assert';
import { project, verifyProjection } from '../server/projection.js';

// 一段正常的会话账本（一个 run：跑了一轮、调了一次工具、正常存下）
const SESSION = [
  { id: 1, seq: 0, type: 'run_start', payload: { runId: 21, permission: 'full', preset: 'all', light: false } },
  { id: 2, seq: 0, type: 'thinking', payload: { round: 1 } },
  { id: 3, seq: 0, type: 'tool_start', payload: { tool: { name: 'read_file', seq: 1 } } },
  { id: 4, seq: 0, type: 'tool_done', payload: { tool: { name: 'read_file', seq: 1, status: 'done' } } },
  { id: 5, seq: 0, type: 'done', payload: { runId: 21, usage: {} } },
  { id: 6, seq: 0, type: 'run_end', payload: { runId: 21, status: 'saved', reason: 'saved', guard: null } },
];
// 契约域事实：`type` 与契约 `kind` 同值。两条都挑"按 type 折必然踩雷"的：
//   · `error` —— 与 outcomes 的 case 'error' 同名，会被写成"当前 run 出错"；
//   · `candidate_done` —— 契约里最常见的那条事实（等待用户复测确认），投影不认它类型（不认也不能算错）。
const CONTRACT_ERROR = { id: 101, seq: 0, type: 'error', payload: { contractId: 7, detail: '驱动器执行异常: …' } };
const CONTRACT_CANDIDATE = { id: 102, seq: 0, type: 'candidate_done', payload: { contractId: 7, detail: '等待用户复测确认' } };
// 混在会话帧**之间**：第一条排在 run_start 之前 —— 这正是"凭空冒出一条 run:-"的那种排布
const MIXED = [CONTRACT_ERROR, ...SESSION.slice(0, 3), CONTRACT_CANDIDATE, ...SESSION.slice(3)];

const snap = (s) => JSON.stringify({ r: s.runStats, f: s.toolFace, o: s.outcomes, n: s.__applied });

test('契约域事实整条跳过：混入后与"只有会话帧"的投影逐字节相同', () => {
  const mixed = project(MIXED);
  const pure = project(SESSION);
  assert.equal(snap(mixed), snap(pure), '契约事实不得改动投影的任何一位（含 __applied）');
  assert.equal(mixed.__applied, SESSION.length, '__applied 只数真正折进去的会话帧');
});

test('反向：契约事实的 type=error 不许产出 run:- 假条目，也不许改写当前 run 的结局', () => {
  const { runStats, outcomes } = project(MIXED);
  assert.deepEqual(Object.keys(runStats.runs), ['run:21'], '账本里只有一个 run_start，就只能有一个 run');
  assert.equal(Object.prototype.hasOwnProperty.call(outcomes.runs, 'run:-'), false,
    'run:- 是假条目：账本里没有任何一帧会话事件把它开出来（它正是被折出来的那条假结局）');
  assert.deepEqual(Object.keys(outcomes.runs), ['run:21']);
  assert.equal(outcomes.runs['run:21'].terminal, 'done', '夹在会话帧之间的契约事实不得改写这个 run 的终结事件');
  assert.equal(outcomes.runs['run:21'].status, 'saved');
});

test('判据是 payload.contractId（结构字段），不是 type 前缀：同名的会话帧口径不变', () => {
  const sessionError = project([{ id: 1, seq: 0, type: 'error', payload: { reason: 'boom' } }]);
  assert.equal(sessionError.outcomes.runs['run:-'].terminal, 'error',
    '不带 contractId 的 error 仍按会话帧折叠（轻量问答不登记现场，照旧归 run:-）');
  const contractError = project([CONTRACT_ERROR]);
  assert.deepEqual(contractError.outcomes.runs, {}, '带 contractId 的同名 type 必须整条跳过');
  assert.equal(contractError.__applied, 0);
  assert.deepEqual(sessionError.runStats.runs, {}, 'error 本来就不进 runStats（既有口径，顺带锁住）');
});

test('对账也说真话：假条目不许出现在"run 结局"那一条里', async () => {
  // 假 db：账本里只有一个 run（21），库里的 agent_runs 也只有它 —— 对账应当全 ✓，且一个字都不提 run:-
  const db = {
    async query(sql) {
      if (/FROM agent_runs/.test(sql)) return [{ id: 21, status: 'completed', rounds: 1 }];
      if (/FROM tool_calls/.test(sql)) return [{ tool_name: 'read_file', status: 'done', error_code: null }];
      if (/FROM usage_stats/.test(sql)) return [];
      throw new Error('夹具没准备这条 SQL：' + sql);
    },
  };
  const { checks } = await verifyProjection({ conversationId: 9, states: project(MIXED), db, ctx: new Map() });
  const outcome = checks.find((c) => c.name.includes('run 结局'));
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /run 21=saved/);
  assert.doesNotMatch(outcome.detail, /run:-/,
    'run:- 一出现，对账就在报告一次没发生过的轻量问答——那就是"投影在说谎"');
});
