// test/eventstream.test.mjs - RA-37 夹具：事件契约 + "仅靠事件流重建全过程"
// 依据《RW-Agent 架构 v1.1》§14.9 RA-37。
// 本夹具测的是**消费者**（src/eventstream.js 的纯重建器），不是服务端实现细节——
// 所以它既跑合成流（覆盖正常/中断/异常/护栏各终态），也用同一段代码对账"重建 vs 服务端事实"。
// 真实 HTTP 链路的取证见 scripts/ra37-rebuild.mjs（抓真 SSE → 同一重建器 → 与库对账）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSse, rebuild, applyEvent, createRunView, verifyRebuild, EVENT_PROTOCOL_VERSION } from '../src/eventstream.js';

const frame = (obj, id) => (id ? `id: ${id}\n` : '') + `data: ${JSON.stringify(obj)}\n\n`;
const stream = (arr) => arr.map(([o, id]) => frame(o, id)).join('') + ': ping\n\n';

// 一段"正常完成"的真实形态：run_start → 思考 → 工具 → 正文流 → done → run_end
const NORMAL = stream([
  [{ type: 'intent', label: 'act', echo: null, hit: null }],
  [{ type: 'run_start', v: 1, conversationId: 900, runId: 33, light: false, provider: 'deepseek', model: 'deepseek-v4-flash', preset: 'all', permission: 'full' }],
  [{ type: 'thinking', round: 1 }, 1],
  [{ type: 'think', text: '先看一下目录' }, 2],
  [{ type: 'tool_start', tool: { name: 'list_dir', args: { path: '.' }, seq: 1, status: 'running' } }, 3],
  [{ type: 'tool_done', tool: { name: 'list_dir', args: { path: '.' }, seq: 1, status: 'done', durationMs: 12, result: 'a,b' } }, 4],
  [{ type: 'delta', delta: '目录里' }, 5],
  [{ type: 'delta', delta: '有 a、b 两项。' }, 6],
  [{ type: 'done', usage: { tokens_in: 100, tokens_out: 20 }, messageId: 777, runId: 33, totals: { tokens_in: 100, tokens_out: 20, cost: 0.0012, hit_rate: 0.9 } }],
  [{ type: 'run_end', v: 1, conversationId: 900, runId: 33, status: 'saved', messageId: 777, contentLength: 14, finishReason: 'stop', usage: { tokens_in: 100, tokens_out: 20 }, totals: { cost: 0.0012 }, spentYuan: 0.001 }],
]);

test('RA-37 契约：帧解析支持 id: 行与心跳注释帧，未知字段不炸', () => {
  const evs = parseSse(': ping\n\nid: 7\ndata: {"type":"delta","delta":"x"}\n\n');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].delta, 'x');
  assert.equal(evs[0]._seq, 7);
  assert.equal(parseSse('data: {不是json}\n\n').length, 0, '坏帧被丢弃而不是抛错');
});

test('RA-37 重建：正常一段 → 正文/工具/轮次/落库回执全部拼得出来', () => {
  const v = rebuild(NORMAL);
  assert.equal(v.status, 'done');
  assert.equal(v.answer, '目录里有 a、b 两项。');
  assert.equal(v.runId, 33);
  assert.equal(v.messageId, 777);
  assert.equal(v.tools.length, 1);
  assert.equal(v.tools[0].status, 'done');
  assert.equal(v.rounds, 1);
  assert.equal(v.endReason, 'saved');
  assert.equal(v.totals.cost, 0.0012);
  assert.deepEqual(v.gaps, []);
  assert.deepEqual(v.unknownTypes, []);
});

test('RA-37 保真：与服务端事实逐字对账通过（正例）', () => {
  const v = rebuild(NORMAL);
  const r = verifyRebuild(v, { storedContent: '目录里有 a、b 两项。', messageId: 777, usageRounds: 1 });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test('RA-37 保真负例：正文少一段就必须报红（否则"重建"是空话）', () => {
  const broken = NORMAL.replace(frame({ type: 'delta', delta: '有 a、b 两项。' }, 6), '');
  const v = rebuild(broken);
  const r = verifyRebuild(v, { storedContent: '目录里有 a、b 两项。' });
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes('正文逐字一致'), JSON.stringify(r.checks));
});

test('RA-37 保真负例：未知事件类型 / 丢帧都要被记下来', () => {
  const withUnknown = NORMAL.replace('data: {"type":"think"', 'data: {"type":"v2_new_thing"') + frame({ type: 'something_new' });
  const v = rebuild(withUnknown);
  assert.ok(v.unknownTypes.includes('something_new'), '未知类型要留痕（契约只增不改）');
  const gapped = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'delta', delta: 'a', _seq: 5 }, { type: 'delta', delta: 'b', _seq: 9 }]);
  assert.equal(gapped.gaps.length, 1, '序号跳变要能被发现');
  assert.equal(verifyRebuild(gapped, {}).ok, false);
});

test('RA-26 等待确认是独立状态：approval/ask 不被当成"还在跑"', () => {
  const v = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'approval', id: 'ap-1', desc: '要跑 rm -rf' }]);
  assert.equal(v.status, 'waiting-approval');
  assert.equal(v.approvals.length, 1);
  const v2 = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'ask', id: 'ask-1', question: '选哪个？', options: [] }]);
  assert.equal(v2.status, 'waiting-answer');
});

test('RA-26 四面②④：wait_start/wait_end 让"等确认"与"执行中"在事件流上可分辨，等待时长可累加对账', () => {
  const v = rebuild([
    { type: 'run_start', runId: 1, conversationId: 1 },
    { type: 'delta', delta: '先问一下' },
    { type: 'wait_start', wait: { kind: 'ask', id: 'ask-1', round: 1 } },
  ]);
  assert.equal(v.status, 'waiting-answer', '进入等待时不再是"执行中"');
  assert.equal(v.wait.id, 'ask-1');
  const v2 = rebuild([
    { type: 'run_start', runId: 1, conversationId: 1 },
    { type: 'wait_start', wait: { kind: 'ask', id: 'ask-1', round: 1 } },
    { type: 'wait_end', wait: { kind: 'ask', id: 'ask-1', round: 1, reason: 'answered', ms: 4200 } },
    { type: 'wait_start', wait: { kind: 'approval', id: 'ap-1', round: 2 } },
    { type: 'wait_end', wait: { kind: 'approval', id: 'ap-1', round: 2, decision: 'approve', ms: 3100 } },
    { type: 'run_end', status: 'saved', messageId: 9, contentLength: 4, totals: { waitedMs: 7300 } },
  ]);
  assert.equal(v2.status, 'done');
  assert.equal(v2.waitedMs, 7300, '两段等待都要累加');
  assert.equal(v2.wait, null, '等待结束后不再处于等待态');
  const r = verifyRebuild(v2, { waitedMs: 7300 });
  assert.ok(r.checks.find((c) => c.name === '等待时长对账').ok, JSON.stringify(r.checks));
});

test('RA-37 终止态齐备：stopped / 护栏挂起 / 异常 三种都能从事件流看出结局与原因', () => {
  const stopped = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'delta', delta: '半句' }, { type: 'stopped' }, { type: 'run_end', status: 'stopped', reason: 'user', reasonText: '用户点击停止', messageId: 5 }]);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.endReason, 'user');
  assert.equal(stopped.answer, '半句', '中断也要保留已流出的正文');

  // 护栏挂起：服务端以 done 收尾（内容即挂起文案），run_end 带 guard
  const guarded = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'delta', delta: '（达到 5 分钟时间预算，任务已挂起…）' }, { type: 'done', usage: {} }, { type: 'run_end', status: 'saved', guard: 'budget', messageId: 6, contentLength: 20 }]);
  assert.equal(guarded.status, 'done');
  assert.match(guarded.answer, /任务已挂起/);

  const errored = rebuild([{ type: 'run_start', runId: 1, conversationId: 1 }, { type: 'error', message: '上游 502' }, { type: 'run_end', status: 'error', reason: 'exception', reasonText: '上游 502', messageId: 7 }]);
  assert.equal(errored.status, 'error');
  assert.equal(errored.endReason, 'exception', 'run_end 的 reason 覆盖 error 的裸 message（结构化原因）');
});

test('RA-37 幂等与纯度：applyEvent 不改入参，重复事件不会把状态搞脏', () => {
  const v0 = createRunView();
  const v1 = applyEvent(v0, { type: 'delta', delta: 'a' });
  assert.equal(v0.answer, '', '入参视图不得被改写');
  assert.equal(v1.answer, 'a');
  const dup = rebuild([{ type: 'run_start', runId: 1 }, { type: 'tool_start', tool: { name: 'x', seq: 1 } }, { type: 'tool_start', tool: { name: 'x', seq: 1 } }]);
  assert.equal(dup.tools.length, 1, '同 seq 同名的 tool_start 应覆盖而不是堆积');
});

test('RA-37 协议版本随事件下发且与消费端一致', () => {
  const v = rebuild([{ type: 'run_start', v: EVENT_PROTOCOL_VERSION, runId: 1, conversationId: 1 }]);
  assert.equal(v.protocol, EVENT_PROTOCOL_VERSION);
});

test('RA-37 契约文档在位，且列出的每个事件类型都能被重建器识别', () => {
  const doc = fs.readFileSync(new URL('../docs/事件契约.md', import.meta.url), 'utf8');
  // 文档里用 `### xxx` 或表格首列列出事件名；逐个喂给重建器，不得落进 unknownTypes
  const names = [...doc.matchAll(/^\|\s*`([a-z][a-z_]+)`\s*\|/gm)].map((m) => m[1]).filter((n) => n !== 'type');
  assert.ok(names.length >= 8, '契约文档应列出全部事件类型，实际 ' + names.length + ' 个');
  for (const n of new Set(names)) {
    const v = rebuild([{ type: n, tool: { name: 'x', seq: 1 }, plan: [], status: 'saved' }]);
    assert.equal(v.unknownTypes.length, 0, '契约里写了 ' + n + '，但重建器不认识它');
  }
});
