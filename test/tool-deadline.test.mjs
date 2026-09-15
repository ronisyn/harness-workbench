// test/tool-deadline.test.mjs - 工具级界限（架构对齐 DSH `dsh-tool-call-timeout-policy`）
//
// 锁三件事：
//   ① 截止语义：未声明就不设线；到点后 signal 带自有分类码；**上游中止 ≠ 本工具超时**（否则"用户停了"会被误报成"工具超时"）
//   ② 执行收口：工具越界返回时结果被**如实**改写（不假装它没跑过），未声明者不受影响，工具能看到派生 signal
//   ③ 工具面不变量：界限不得写死在实现里、声明值必须合法、等人工的工具绝不能被设线
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armDeadline, toolTimeoutResult, TOOL_TIMEOUT } from '../server/tools/deadline.js';
import { TOOLS, execTool } from '../server/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- ① 截止语义 ----------
test('未声明界限就不设线：null/0/负数/NaN 一律返回 null（不替工具编一个数）', () => {
  for (const v of [null, undefined, 0, -1, NaN, 'abc', Infinity]) {
    assert.equal(armDeadline(null, v), null, 'timeoutMs=' + String(v) + ' 不应派生出截止');
  }
});

test('到点后 expired() 为真，且 signal 带着本接口自有分类码', async () => {
  const d = armDeadline(null, 40);
  assert.equal(d.expired(), false, '刚派生时不该是已到期');
  assert.equal(d.signal.aborted, false);
  await sleep(80);
  assert.equal(d.expired(), true);
  assert.equal(d.signal.aborted, true);
  assert.equal(d.signal.reason.code, TOOL_TIMEOUT, 'signal.reason 必须带分类码，嵌套截止才分得清是谁到期');
  assert.match(d.signal.reason.message, /40ms/);
  d.dispose();
});

test('上游中止不算"本工具超时"：分类必须可分（用户停止 ≠ 工具越界）', async () => {
  const up = new AbortController();
  const d = armDeadline(up.signal, 10000);
  up.abort();
  await sleep(10);
  assert.equal(d.signal.aborted, true, '上游中止应传导到派生 signal');
  assert.equal(d.expired(), false, '上游中止不得被算成本截止到期');
  assert.notEqual(d.signal.reason && d.signal.reason.code, TOOL_TIMEOUT);
  d.dispose();
});

test('上游已中止时派生 signal 立刻就是中止态；dispose 后不再触发（计时器不泄漏）', async () => {
  const up = new AbortController();
  up.abort();
  const d = armDeadline(up.signal, 10000);
  assert.equal(d.signal.aborted, true);
  d.dispose();
  const d2 = armDeadline(null, 30);
  d2.dispose(); // 提前释放
  await sleep(60);
  assert.equal(d2.expired(), false, 'dispose 之后不得再判为到期');
});

test('越界结果的形状：面向模型说明+结构化 code（留痕走正常通道成为 fail 行）', () => {
  const r = toolTimeoutResult('read_file', 15000);
  assert.equal(r.code, TOOL_TIMEOUT);
  assert.equal(r.timeoutMs, 15000);
  assert.match(r.error, /^工具 read_file 超时/);
  assert.match(r.error, /15000ms/);
});

// ---------- ② 执行收口（真实 execTool 路径，注入假工具） ----------
const CTX = () => ({ permission: 'full', root: ROOT, conversationId: 0, accountId: 0, __signal: new AbortController().signal });
function inject(tool) { TOOLS.push(tool); return tool.name; }

test('execTool：越过声明界限才返回 → 结果被如实改写成 TOOL_TIMEOUT', async () => {
  const name = inject({ name: 'zz_slow_declared', description: '夹具：慢工具（声明界限）', permission: 'read', timeoutMs: 40, params: {}, run: async () => { await sleep(120); return { ok: true }; } });
  const r = await execTool(name, {}, CTX());
  assert.equal(r.code, TOOL_TIMEOUT, '越界返回必须被改写为超时，而不是把 {ok:true} 当成功交出去');
  assert.match(r.error, /超时/);
});

test('execTool：未声明界限的工具不受影响（不设线 = 不干预）', async () => {
  const name = inject({ name: 'zz_slow_undeclared', description: '夹具：慢工具（未声明）', permission: 'read', params: {}, run: async () => { await sleep(60); return { ok: true }; } });
  const r = await execTool(name, {}, CTX());
  assert.deepEqual(r, { ok: true }, '未声明的工具不该被平台的截止改写结果');
});

test('execTool：工具拿到的是派生 signal —— 到点即中止（用户"停止"与界限走同一条通道）', async () => {
  let seenAborted = null;
  const name = inject({
    name: 'zz_signal_seen', description: '夹具：观察 signal', permission: 'read', timeoutMs: 40, params: {},
    run: async (a, ctx) => { await sleep(120); seenAborted = ctx.__signal.aborted; return { ok: true }; },
  });
  await execTool(name, {}, CTX());
  assert.equal(seenAborted, true, '工具必须看到到点即中止的 signal；否则它无法自己收口（DSH 的"协作式"前提）');
});

// ---------- ③ 工具面不变量（源级；不依赖 DB） ----------
const toolsDir = path.join(ROOT, 'server/tools');
const toolSrcs = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js')).map((f) => ({ f, s: fs.readFileSync(path.join(toolsDir, f), 'utf8') }));

test('界限不得写死在实现里：私有超时字面量必须变成工具定义上的声明', () => {
  const bad = toolSrcs.filter((x) => /AbortSignal\.timeout\(/.test(x.s)).map((x) => x.f);
  assert.deepEqual(bad, [], '这些文件把超时写死在实现里（既不出现在工具面上，也吞掉用户"停止"）：' + bad.join(', '));
});

test('声明值必须合法：正有限数（否则等于没声明，却看着像声明了）', () => {
  for (const t of TOOLS) {
    if (t.timeoutMs === undefined) continue;
    assert.ok(Number.isFinite(t.timeoutMs) && t.timeoutMs > 0, t.name + ' 的 timeoutMs 非法：' + t.timeoutMs);
  }
});

test('等人工的工具绝不能被设线（答案什么时候来由用户决定）', () => {
  const ask = TOOLS.find((t) => t.name === 'ask_user');
  assert.ok(ask, 'ask_user 必须在工具面里');
  assert.equal(ask.timeoutMs, undefined, 'ask_user 声明界限＝给"等人"编一个数：到点会把正在等用户回答的调用判成超时');
});

test('外呼类工具必须声明界限（新增此类工具时忘记声明会在这里被拦下）', () => {
  const mustDeclare = ['web_search', 'fetch_url', 'ocr_image', 'view_image', 'run_command', 'feishu_doc_read', 'feishu_sheet_read', 'feishu_bitable_read'];
  for (const n of mustDeclare) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n + ' 不在工具面里');
    assert.ok(Number.isFinite(t.timeoutMs) && t.timeoutMs > 0, n + ' 会阻塞在外部调用上，必须在工具定义上声明 timeoutMs');
  }
});
