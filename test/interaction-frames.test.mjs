// test/interaction-frames.test.mjs —— v0.3 §4.7「交互契约四要素」接线批的**纯函数那一半**（2026-09-17）
//
// 这一批把三处"后端有、客户端看不见"的接起来（帧字段只增不改），另外接了两处"模块写好没挂"的挂点。
// 本文件测的是**不需要起服务**的那部分（函数级判据 + 事件重建器认帧）；需要真 HTTP/真 SSE 的那部分
// 在 test/interaction-e2e.test.mjs（真服务 + 离线模型壳）。
//
// 覆盖：
//   ① 溢出事实（§2.5 第 4/5 条）：判据是**结构性**的（进上下文的文本 ≠ 工具原样结果），
//      三条定位符路径（溢出文件 / 源文件 / 存盘失败降级）各自读出什么、**读不出来时不许编数字**；
//   ② 进度帧（§4.7「可观测…进度…」）：轮次/上限/计划步三个数怎么算的（上限只认既有 settings，不发明）；
//   ③ 续订缺口（§4.7「断线重连不丢现场」）：缺口判定的边界表（含"新订阅不算缺口""环已回收"）；
//   ④ 受限自动沉淀的取数与接线（§4.3）：状态词映射、缺句柄如实记 errors、**产出提案不写库**；
//   ⑤ 事件重建器认 `progress`（契约只增不改：新增 type 不许掉进 unknownTypes）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// spill.js / env.js 在 import 时读 RW_WORKSPACE（agent.js 会连着把它带进来）⇒ 必须先设好再动态 import
// （与 test/spill.test.mjs 同一做法：溢出文件只许落在这次性目录里，不许污染仓库根的 spill/）。
const WS = path.join(os.tmpdir(), 'rw-interaction-' + Date.now());
process.env.RW_WORKSPACE = WS;
fs.mkdirSync(WS, { recursive: true });

let spillToolResult, spillOwnerDir, spillFactOf, streamGap, activityWindow, planProgress, plans;
let applyEvent, createRunView, loadSessionForSink, sinkSessionKnowledge, SINK_TAG;

before(async () => {
  ({ spillToolResult, spillOwnerDir } = await import('../server/tools/spill.js'));
  ({ spillFactOf, streamGap, activityWindow, planProgress } = await import('../server/agent.js'));
  ({ plans } = await import('../server/tools/index.js'));
  ({ applyEvent, createRunView } = await import('../src/eventstream.js'));
  ({ loadSessionForSink, sinkSessionKnowledge, SINK_TAG } = await import('../server/selfeval/knowledge-sink.js'));
});

after(() => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 忽略 */ } });

// ── ① 溢出事实：结构判据 + 三条定位符路径 ─────────────────────────────────────────────────────
test('溢出①：没超限 ⇒ 没有这条事实（帧上不出现 spill 字段）', () => {
  const small = JSON.stringify({ ok: true, stdout: 'hello' });
  const out = spillToolResult(small, 4000, { tool: 'list_dir', conversationId: 77, callId: 'c0' });
  assert.equal(out, small, '未超限必须原样放行（既有行为不变）');
  assert.equal(spillFactOf({ tool: 'list_dir', callId: 'c0', raw: small, content: out }), null,
    '没有改写 ⇒ 没有省略这条事实（null，而不是一个 omitted:false 的假对象）');
});

test('溢出②：落盘路径 ⇒ 事实里给出省略量 + 溢出文件路径（且路径真的是那份全文）', () => {
  const big = 'X'.repeat(9000);
  const out = spillToolResult(big, 4000, { tool: 'run_command', conversationId: 77, callId: 'call_1' });
  const f = spillFactOf({ tool: 'run_command', callId: 'call_1', raw: big, content: out });
  assert.equal(f.omitted, true);
  assert.equal(f.tool, 'run_command');
  assert.equal(f.kind, 'file');
  assert.ok(f.path && fs.existsSync(f.path), '路径必须是磁盘上真存在的那份溢出文件：' + f.path);
  assert.equal(fs.readFileSync(f.path, 'utf8'), big, '溢出文件里必须是**全文**（模型/人都能按范围取回）');
  assert.ok(f.omittedBytes > 0 && f.omittedChars > 0, '省略量要如实报出：' + JSON.stringify(f));
  assert.equal(f.bytes, Buffer.byteLength(big, 'utf8'), 'bytes＝工具原样结果的体积');
  assert.ok(f.returnedBytes < f.bytes, '进上下文的那一份必须更小（否则"溢出"这两个字不成立）');
  // 定位符就在文本里，事实与文本必须对得上（同一件事不许两个说法）
  assert.match(out, new RegExp('已省略 ' + f.omittedBytes + ' 字节（' + f.omittedChars + ' 字符）'), '省略量必须与文本里的标记一致');
});

test('溢出③：读取类 ⇒ 定位符指向源文件（不落盘），事实里如实标 source', () => {
  const big = 'Y'.repeat(9000);
  const out = spillToolResult(big, 4000, { tool: 'read_file', args: { path: path.join(WS, 'big.txt') }, conversationId: 77, callId: 'call_2' });
  const f = spillFactOf({ tool: 'read_file', callId: 'call_2', raw: big, content: out });
  assert.equal(f.kind, 'source');
  assert.equal(f.path, path.join(WS, 'big.txt'), '定位符＝源文件本身（§5.4 "read 跳过落盘"）');
  assert.ok(f.omittedBytes > 0);
});

test('溢出④（反向）：拿不到定位符时只报"确实省略了"，**不许编数字**（降级路径 + 格式漂移）', () => {
  // 降级路径：把会话目录的路径占成**文件**，mkdirSync 必然失败（与 test/spill.test.mjs 同一手法）
  const conv = 7788;
  fs.writeFileSync(spillOwnerDir(conv), 'x');
  try {
    const big = 'Z'.repeat(9000);
    const out = spillToolResult(big, 4000, { tool: 'db_query', conversationId: conv, callId: 'call_3' });
    assert.match(out, /全文未能存盘/, '这一条要的正是降级分支：' + out.slice(0, 120));
    const f = spillFactOf({ tool: 'db_query', callId: 'call_3', raw: big, content: out });
    assert.equal(f.omitted, true, '降级也是"确实省略了"（事实不依赖定位符能不能读出来）');
    assert.equal(f.kind, 'degraded');
    assert.equal(f.path, null, '取不回的路径就是 null —— 不许把"未存盘"写成某个路径');
  } finally {
    fs.rmSync(spillOwnerDir(conv), { force: true });
  }
  // 格式漂移：文本确实被改写过，但没有任何可解析的标记 ⇒ 只有"省略了"这一条事实
  const f2 = spillFactOf({ tool: 'run_command', raw: 'A'.repeat(500), content: '（另一种改写法，没有标记）' });
  assert.equal(f2.omitted, true);
  assert.equal(f2.kind, 'unknown');
  assert.equal(f2.path, null);
  assert.equal(f2.omittedBytes, null, '读不出省略量就是 null —— 不猜一个数（那是假事实）');
  assert.equal(f2.omittedChars, null);
});

// ── ② 进度帧：三个数都来自既有状态 ───────────────────────────────────────────────────────────
test('进度①：计划进度＝第一个未完成步骤（无计划/全完成 ⇒ current 为 null，不造"第 0 步"）', () => {
  assert.equal(planProgress(4242), null, '没有计划的会话如实返回 null');
  plans.set('4242', { steps: [] });
  assert.equal(planProgress(4242), null, '空计划清单同样返回 null');
  plans.set('4242', { steps: [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: false }] });
  assert.deepEqual(planProgress(4242), { total: 3, done: 1, current: 2 });
  plans.set('4242', { steps: [{ text: 'a', done: true }, { text: 'b', done: true }] });
  assert.deepEqual(planProgress(4242), { total: 2, done: 2, current: null }, '全完成 ⇒ current=null（不谎报还有下一步）');
  plans.delete('4242');
});

test('进度②：事件重建器认识 progress（契约只增不改；不许掉进 unknownTypes）', () => {
  const v = applyEvent(createRunView(), { type: 'progress', v: 1, round: 3, roundCap: 8, plan: { total: 5, done: 2, current: 3 } });
  assert.deepEqual(v.unknownTypes, [], 'progress 是契约内的事件类型（新增 type 允许），重建器必须认它');
  assert.deepEqual(v.progress, { round: 3, roundCap: 8, plan: { total: 5, done: 2, current: 3 } });
  // 没设上限 / 没有计划：如实为 null（不把"不限"写成 0，也不造一个空计划）
  const v2 = applyEvent(createRunView(), { type: 'progress', round: 1, roundCap: null, plan: null });
  assert.deepEqual(v2.progress, { round: 1, roundCap: null, plan: null });
});

// ── ③ 续订缺口：边界表 ───────────────────────────────────────────────────────────────────────
test('缺口①：判定就是"请求的起点早于环内最早一条"，新订阅（after<=0）不算缺口', () => {
  // 新订阅：客户端说"我什么都没看过" ⇒ 它自己会拉 /messages 全量，报缺口只是噪音
  assert.equal(streamGap({ after: 0, earliest: 5 }), false);
  assert.equal(streamGap({ after: 0, earliest: null }), false);
  assert.equal(streamGap({ after: -1, earliest: 5 }), false);
  assert.equal(streamGap({ after: null, earliest: 5 }), false);
  // "起点"＝客户端要的**下一条**（after+1）。after=4 ⇒ 它要的是 5，而环里最早正是 5 ⇒ 接得上，不是缺口
  assert.equal(streamGap({ after: 4, earliest: 5 }), false, 'after+1 === earliest：要的下一条还在，不许报缺口');
  assert.equal(streamGap({ after: 5, earliest: 5 }), false);
  // after=3 ⇒ 它要的是 4，而 4 已经被环丢掉了（环只从队头丢）⇒ 如实报缺口
  assert.equal(streamGap({ after: 3, earliest: 5 }), true, 'after+1 < earliest：中间那条收不回来了');
  assert.equal(streamGap({ after: 1, earliest: 5 }), true);
  // 环已回收/空：声明看过任何 seq 都只能如实说"我手里什么都没有"
  assert.equal(streamGap({ after: 9, earliest: null }), true);
});

test('缺口②：空环的窗口快照如实为 null（不假装"从 0 开始还能补"）', () => {
  assert.deepEqual(activityWindow(999999), { earliest: null, latest: null, count: 0 });
});

// ── ④ 受限自动沉淀：取数 + 接线（产出提案、不写库）────────────────────────────────────────────
function fakeStorage({ messages = [], toolCalls = [], throwMessages = false } = {}) {
  return {
    messages: { history: async () => { if (throwMessages) throw new Error('读消息炸了'); return messages; } },
    toolCalls: { list: async () => toolCalls },
  };
}
function fakeDb({ summary = null, onQuery = null } = {}) {
  return { query: async (sql, params) => { if (onQuery) onQuery(sql, params); return summary ? [summary] : []; } };
}

test('沉淀取数①：状态词只在这一处映射（账本 done⇒ok），其余原样交出去', async () => {
  const rows = await loadSessionForSink(5, {
    storage: fakeStorage({ messages: [{ role: 'user', content: '你好' }], toolCalls: [{ toolName: 'run_command', status: 'done' }, { toolName: 'db_query', status: 'fail' }, { toolName: 'x', status: 'pruned' }] }),
    dbc: fakeDb({ summary: { summary: '本轮摘要' } }),
  });
  assert.deepEqual(rows.errors, []);
  assert.equal(rows.messages.length, 1);
  assert.deepEqual(rows.toolCalls, [
    { tool_name: 'run_command', status: 'ok' },   // 账本里是 done，候选抽取认 ok
    { tool_name: 'db_query', status: 'fail' },
    { tool_name: 'x', status: 'pruned' },          // 不认识的状态原样交出去（不冒充成功）
  ]);
  assert.deepEqual(rows.summary, { summary: '本轮摘要' });
});

test('沉淀取数②：句柄缺了/读炸了 ⇒ 那一项为空、原因进 errors（缺不是失败）', async () => {
  const noHandles = await loadSessionForSink(5, {});
  assert.deepEqual(noHandles.messages, []);
  assert.equal(noHandles.errors.length, 3, '三样来源全没有 ⇒ 三条如实说明：' + noHandles.errors.join('；'));
  const broken = await loadSessionForSink(5, { storage: fakeStorage({ throwMessages: true }), dbc: fakeDb() });
  assert.match(broken.errors.join('；'), /读会话消息失败/);
  const badId = await loadSessionForSink(0, {});
  assert.match(badId.errors.join('；'), /会话 id 不合法/);
});

test('沉淀接线③：一句话接上 ⇒ 产出待审卡片（asks 队列），**全程没有 INSERT**', async () => {
  const ins = [];
  const dbc = fakeDb({
    summary: null,
    onQuery: (sql) => { if (/INSERT\s+INTO/i.test(sql)) ins.push(sql); },
  });
  const created = [];
  const emitted = [];
  const r = await sinkSessionKnowledge({
    conversationId: 5, dbc,
    storage: fakeStorage({
      messages: [{ role: 'user', content: '把这批夹具跑一遍' }],
      // 同一会话里"先失败后成功"＝候选②（结构性事实，不需要任何阈值）
      toolCalls: [{ toolName: 'run_test', status: 'fail' }, { toolName: 'run_test', status: 'done' }],
    }),
    createAskFn: (question, options, o) => { const ap = { id: 'ask-fixture-' + (created.length + 1), question, options, o }; created.push(ap); return ap; },
    emit: (card) => emitted.push(card),
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.pending.length, 1, '应当抽到"失败后跑通"这一条候选：' + JSON.stringify(r.pending));
  assert.match(r.pending[0].title, /run_test 失败后跑通了/);
  assert.match(r.pending[0].body, /run_test/);
  assert.equal(r.created.length, 1, '卡片必须真的建了（挂在既有 asks 队列上）');
  assert.deepEqual(emitted.map((c) => c.type), ['ask'], '出口是既有的 ask 事件形状');
  assert.equal(emitted[0].id, r.pending[0].askId, '事件里的卡片 id ＝ 队列里那张卡的 id（跨端按 id 对得回）');
  assert.deepEqual(ins, [], '产提案路径**一个 INSERT 都不许有**（写库要等有人答了卡，见 writeKnowledge）');
  assert.match(SINK_TAG, /提案式/);
});

test('沉淀接线④（反向）：没有候选 ⇒ pending 为空、不建卡、不发帧（静默跳过）', async () => {
  const created = [];
  const emitted = [];
  const r = await sinkSessionKnowledge({
    conversationId: 6, dbc: fakeDb(),
    storage: fakeStorage({ messages: [{ role: 'user', content: '你好' }], toolCalls: [{ toolName: 'list_dir', status: 'done' }] }),
    createAskFn: () => { created.push(1); return { id: 'x' }; },
    emit: (c) => emitted.push(c),
  });
  assert.equal(r.pending.length, 0);
  assert.equal(created.length, 0, '没有候选就不许建卡（不许打扰正常收尾）');
  assert.equal(emitted.length, 0, '也不许发帧');
  assert.match(r.skipped[0], /没有够格的候选/);
});
