// test/projection.test.mjs - 确定性投影夹具：折叠是纯函数，对账会如实报差异
//
// 为什么这么锁（架构增量二）：
//   ① 投影的意义就是"同一段账本任何时刻折出来都一样"——顺序、幂等（重放同一行不重复计数）、未知事件不抛错，
//      这三条破了，"确定性"就是空话；
//   ② 对账的价值在**不一致时如实报**：只会说 ✓ 的对账等于没有对账，所以这里既造"一致"也造"不一致"，
//      断言不一致时差异真的出现在 detail 里（而不是被吞掉）。
import { test } from 'node:test';
import assert from 'node:assert';
import { project, verifyProjection, PROJECTIONS, REGISTRY } from '../server/projection.js';

// 一段合成账本：两个 run（一个正常存下、一个护栏挂起），带工具成功/失败/失败码/重试/未知类型
const EV = [
  { id: 1, seq: 0, type: 'intent', payload: { label: 'act' } },
  { id: 2, seq: 0, type: 'run_start', payload: { runId: 11, permission: 'full', preset: 'all', light: false } },
  { id: 3, seq: 0, type: 'thinking', payload: { round: 1 } },
  { id: 4, seq: 0, type: 'tool_start', payload: { tool: { name: 'read_file', seq: 1 } } },
  { id: 5, seq: 0, type: 'tool_done', payload: { tool: { name: 'read_file', seq: 1, status: 'done' } } },
  { id: 6, seq: 0, type: 'llm_retry', payload: { retry: { attempt: 1, reason: 'rate' } } },
  { id: 7, seq: 0, type: 'thinking', payload: { round: 2 } },
  { id: 8, seq: 0, type: 'tool_start', payload: { tool: { name: 'run_command', seq: 2 } } },
  { id: 9, seq: 0, type: 'tool_done', payload: { tool: { name: 'run_command', seq: 2, status: 'fail', code: 'UPSTREAM_UNAVAILABLE' } } },
  { id: 10, seq: 0, type: 'future_event_v9', payload: { anything: [1, 2, 3] } },
  { id: 11, seq: 0, type: 'done', payload: { runId: 11, usage: {} } },
  { id: 12, seq: 0, type: 'run_end', payload: { runId: 11, status: 'saved', reason: 'saved', guard: null } },
  { id: 13, seq: 0, type: 'run_start', payload: { runId: 12, permission: 'read', preset: 'all', light: false } },
  { id: 14, seq: 0, type: 'thinking', payload: { round: 1 } },
  { id: 15, seq: 0, type: 'tool_start', payload: { tool: { name: 'read_file', seq: 1 } } },
  { id: 16, seq: 0, type: 'tool_done', payload: { tool: { name: 'read_file', seq: 1, status: 'done' } } },
  { id: 17, seq: 0, type: 'done', payload: { runId: 12, usage: {} } },
  { id: 18, seq: 0, type: 'run_end', payload: { runId: 12, status: 'saved', reason: 'saved', guard: 'budget' } },
];

const fold = (evs) => project(evs);

test('纯函数：不改入参（折叠两次，账本与第一次结果都不许变）', () => {
  const snapshot = JSON.stringify(EV);
  const a = fold(EV);
  assert.equal(JSON.stringify(EV), snapshot, 'events 入参不得被就地改写');
  const aJson = JSON.stringify({ r: a.runStats, f: a.toolFace, o: a.outcomes });
  const b = fold(EV);
  assert.equal(JSON.stringify({ r: b.runStats, f: b.toolFace, o: b.outcomes }), aJson, '同一段账本折两次必须逐字相同（确定性）');
});

test('顺序：事件按账本顺序折叠，run_start 之后的事件归当前 run，runId 显式优先', () => {
  const { runStats, outcomes } = fold(EV);
  assert.deepEqual(Object.keys(runStats.runs), ['run:11', 'run:12']);
  assert.equal(runStats.runs['run:11'].rounds, 2, '轮次按 round 去重后的个数');
  assert.equal(runStats.runs['run:11'].toolStarted, 2);
  assert.equal(runStats.runs['run:11'].toolDone, 1);
  assert.equal(runStats.runs['run:11'].toolFail, 1);
  assert.deepEqual(runStats.runs['run:11'].failureCodes, { UPSTREAM_UNAVAILABLE: 1 });
  assert.equal(runStats.runs['run:11'].llmRetries, 1);
  assert.equal(runStats.runs['run:12'].rounds, 1, '第二个 run 不继承第一个 run 的轮次');
  assert.equal(runStats.runs['run:12'].toolStarted, 1);
  // 结局：done 记终结事件，run_end 给 status/reason/guard（护栏挂起也走 saved，靠 guard 区分）
  assert.equal(outcomes.runs['run:11'].terminal, 'done');
  assert.equal(outcomes.runs['run:11'].status, 'saved');
  assert.equal(outcomes.runs['run:11'].guard, null);
  assert.equal(outcomes.runs['run:12'].guard, 'budget');
  // 没收到 run_end 的 run 不得假装有结局
  const cut = fold(EV.slice(0, 13));
  assert.equal(cut.outcomes.runs['run:11'].terminal, 'done');
  assert.equal(cut.outcomes.runs['run:12'].status, null);
});

test('工具面：集合去重、首次出现顺序、计数不去重', () => {
  const { toolFace } = fold(EV);
  assert.deepEqual(toolFace.order, ['read_file', 'run_command'], '同一工具出现两次只记一次顺序');
  assert.deepEqual(toolFace.counts, { read_file: 2, run_command: 1 });
  assert.equal(toolFace.calls, 3);
  assert.equal(fold([]).toolFace.calls, 0, '空会话：零，不是 undefined');
});

test('幂等：同一行重复折叠不重复计数（按行 id 去重；无 id 时按 seq）', () => {
  const dup = fold([...EV, ...EV]); // 整段重放第二次
  const once = fold(EV);
  assert.equal(dup.__applied, once.__applied, '重复行必须被丢掉');
  assert.equal(JSON.stringify(dup.runStats), JSON.stringify(once.runStats));
  assert.equal(JSON.stringify(dup.outcomes), JSON.stringify(once.outcomes));
  assert.equal(JSON.stringify(dup.toolFace), JSON.stringify(once.toolFace));
  // 同一 seq 重复（账本行 id 缺失时的兜底口径）：只算一次
  const synthetic = [
    { seq: 7, type: 'tool_start', payload: { tool: { name: 'read_file' } } },
    { seq: 7, type: 'tool_start', payload: { tool: { name: 'read_file' } } },
  ];
  assert.equal(project(synthetic).toolFace.calls, 1);
  // 反向锁：seq=0（真库 events.seq 目前全是 0）**不能**被当成"重复"整段吃掉
  const zeroSeq = [
    { id: 101, seq: 0, type: 'tool_start', payload: { tool: { name: 'a' } } },
    { id: 102, seq: 0, type: 'tool_start', payload: { tool: { name: 'b' } } },
  ];
  assert.equal(project(zeroSeq).toolFace.calls, 2);
});

test('未知事件类型：不抛错、不改变状态；空会话返回各投影的 init 状态', () => {
  const before = fold(EV.slice(0, 10));
  const after = fold([...EV.slice(0, 10), { id: 900, seq: 0, type: '完全没见过的事件', payload: { x: 1 } }]);
  delete before.__applied; delete after.__applied;
  assert.deepEqual(after, before, '未知类型必须原样返回状态（契约只增不改）');
  assert.doesNotThrow(() => project([{ type: null }, null, 42, { type: 'thinking' }]));
  const empty = fold([]);
  assert.deepEqual(empty.runStats, { runs: {}, current: null });
  assert.deepEqual(empty.toolFace, { order: [], counts: {}, calls: 0 });
  assert.deepEqual(empty.outcomes, { runs: {}, current: null });
  // 未注册的 key 要**报错**，不能静默给个空状态（那会让对账"看起来通过"）
  assert.throws(() => project([], ['runStats', '不存在的投影']), /未知投影 key/);
  assert.deepEqual(PROJECTIONS.map((d) => d.key), ['runStats', 'toolFace', 'outcomes']);
  assert.equal(REGISTRY.size, 3);
  for (const d of PROJECTIONS) assert.ok(Number.isInteger(d.stateVersion) && d.stateVersion >= 0);
});

// ── 对账夹具：造"一致"与"不一致"两种情形 ───────────────────────────────────────────────────
// 假 db：按 SQL 里的关键词回放数据集（真夹具不连库——对账函数要能脱离 DB 被测）
function fakeDb({ runs = [], calls = [], faces = [] }) {
  return {
    async query(sql) {
      if (/FROM agent_runs/.test(sql)) return runs;
      if (/FROM tool_calls/.test(sql)) return calls;
      if (/FROM usage_stats/.test(sql)) return faces;
      throw new Error('夹具没准备这条 SQL：' + sql);
    },
  };
}

test('对账：一致时全 ✓（并且把数字写进 detail，便于人工复核）', async () => {
  const states = fold(EV);
  const { checks } = await verifyProjection({
    conversationId: 9,
    states,
    db: fakeDb({
      runs: [{ id: 11, status: 'completed' }, { id: 12, status: 'completed' }],
      calls: [
        { tool_name: 'read_file', status: 'done', error_code: null },
        { tool_name: 'read_file', status: 'done', error_code: null },
        { tool_name: 'run_command', status: 'fail', error_code: 'UPSTREAM_UNAVAILABLE' },
      ],
      faces: [{ prefix_tools_hash: 'abcdef123456' }],
    }),
    ctx: new Map(), // 不给工具面上下文 ⇒ 工具面那一项按"无法判定"处理，不算错
  });
  const bad = checks.filter((c) => c.ok === false);
  assert.deepEqual(bad, [], '一致时不该有任何 ✗：' + JSON.stringify(checks));
  assert.equal(checks.length, 5);
  assert.match(checks[0].detail, /投影 2 个 \/ 库 2 个/);
  assert.match(checks[1].detail, /各 3 次（done 2 \/ fail 1）/);
  assert.match(checks[2].detail, /UPSTREAM_UNAVAILABLE×1/);
  assert.equal(checks[3].ok, null, '没给上下文 ⇒ 工具面无法判定（如实标 —，不是 ✓）');
});

test('对账：不一致时如实报出差异（每类分叉都各自现形）', async () => {
  const states = fold(EV);
  const { checks } = await verifyProjection({
    conversationId: 9,
    states,
    db: fakeDb({
      runs: [{ id: 11, status: 'interrupted' }, { id: 13, status: 'completed' }], // run 12 不在库、run 13 不在账本、11 结局不符
      calls: [
        { tool_name: 'read_file', status: 'done', error_code: null },             // 少两次调用（账本 3 / 库 1）
        { tool_name: 'run_command', status: 'fail', error_code: 'TOOL_SHELL_DENIED' }, // 失败码也不同
      ],
      faces: [{ prefix_tools_hash: 'abcdef123456' }],
    }),
    ctx: new Map(),
  });
  const byName = (frag) => checks.find((c) => c.name.includes(frag));
  assert.equal(byName('run 数').ok, false);
  assert.match(byName('run 数').detail, /只在账本里：12/);
  assert.match(byName('run 数').detail, /只在库里：13/);
  assert.equal(byName('工具调用数').ok, false);
  assert.match(byName('工具调用数').detail, /calls: 投影 3 \/ 库 2/);
  assert.equal(byName('失败码').ok, false);
  assert.match(byName('失败码').detail, /UPSTREAM_UNAVAILABLE: 投影 1 \/ 库 0/);
  assert.match(byName('失败码').detail, /TOOL_SHELL_DENIED: 投影 0 \/ 库 1/);
  assert.equal(byName('run 结局').ok, false);
  assert.match(byName('run 结局').detail, /run 11：账本 saved \/ 库 interrupted/);
  assert.equal(checks.filter((c) => c.ok === false).length, 4, '四处不一致必须都报出来，不许只报第一处');
});

test('对账：护栏挂起的 run 不因 status=saved 而被判"与库一致"若库说它还在跑', async () => {
  const states = fold(EV);
  const { checks } = await verifyProjection({
    conversationId: 9,
    states,
    db: fakeDb({ runs: [{ id: 11, status: 'completed' }, { id: 12, status: 'running' }], calls: [], faces: [] }),
    ctx: new Map(),
  });
  const outcome = checks.find((c) => c.name.includes('run 结局'));
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /run 12：账本 saved\(guard=budget\) \/ 库 running/);
});
