// test/jsonrpc.test.mjs - 通用 JSON-RPC 2.0 门面的协议面（v0.3 §4.7 对外形态 / §7.1 ⑳，P3）
//
// 为什么要夹具：这是**对外协议**。协议层错一条（少一个错误码、把业务失败写成 JSON-RPC error、
// 通知回了帧、粘包时只处理第一条），调用方看到的是"连不上 / 莫名报错 / 我的程序卡住了"，
// 而我们的日志里一切正常——MCP 那边的 8 条夹具就是照这个理由写的，这里同一套纪律。
//
// 本轮钉住 8 条：① 方法与契约映射表无孤儿（**不许新造对外能力**）② 握手（含平台不可达时如实报 error）
// ③ 未知方法 -32601 ④ 参数非法 -32602 ⑤ 坏 JSON -32700 ⑥ 业务失败走结果里的 isError
// ⑦ 通知不回（含未知方法的通知）⑧ stdio 分帧（粘包 / 半行 / 多字节字符跨 chunk）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Registry, ERR, createRegistry, dispatch, serveStdio, JSONRPC_VERSION } from '../server/jsonrpc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 假后端：字段名与 METHODS 的 `资源.动作` 同名（`session.chat` → `backend['session.chat']`）。
// 与 MCP 夹具同一种风格：**不起真平台、不发网络请求**，只把协议行为钉住。
const calls = [];
const backend = {
  'system.capabilities': async (a, ctx) => {
    calls.push(['caps', {}]);
    // 与线上适配器同形状：方法表从 **ctx 里的注册表**出（手抄第二份就会过期）
    return { server: 'rw-platform-jsonrpc', protocolVersion: 1, platform: { ok: true, service: 'rw', ts: 1 }, methods: ctx.registry.face() };
  },
  'session.chat': async (a) => { calls.push(['chat', a]); return { conversationId: '7', created: true, status: 'saved', content: '干完了' }; },
  'session.stop': async (a) => { calls.push(['stop', a]); return { conversationId: a.conversationId, stopped: true }; },
  'session.status': async (a) => { calls.push(['status', a]); return { conversationId: a.conversationId, count: 2, messages: [] }; },
  'session.export': async (a) => { calls.push(['export', a]); return { format: 'rw-session', formatVersion: 1, messages: 2 }; },
  'session.activity': async (a) => { calls.push(['activity', a]); return { conversationId: a.conversationId, seq: 9, items: [] }; },
};
const registry = createRegistry(backend);
const ctx = { registry }; // 线上由 serveStdioWith 注入同一个注册表
const ask = (id, method, params) => dispatch({ jsonrpc: JSONRPC_VERSION, id, method, ...(params === undefined ? {} : { params }) }, registry, ctx);
// 内存流上起一个真的 stdio 服务端（**走与线上同一条装配路径**：注册表与 ctx 同源，处理器才读得到方法表）
function stdio() {
  const input = new EventEmitter();
  const written = [];
  const errs = [];
  serveStdio({ registry, ctx, input, output: { write: (s) => written.push(s) }, onError: (m) => errs.push(m) });
  return { input, written, errs, msgs: () => written.map((s) => JSON.parse(s.trim())) };
}

// ---------------------------------------------------------------- ① 映射表：不许有孤儿

test('① 每个注册的方法都能指到一个**已冻结的契约端点**（METHODS 里不许有孤儿）', () => {
  // 契约端点的唯一出处是文档（docs/会话API契约-v1.md §3 端点表），这里是**解析**它，不是抄一份副本：
  // 抄一份就等于又多了一个会过期的事实源（v0.3 §0.4 / 治理口径：状态和事实都不许手抄）。
  const doc = fs.readFileSync(path.join(ROOT, 'docs', '会话API契约-v1.md'), 'utf8');
  const endpoints = new Set();
  for (const line of doc.split('\n')) {
    const m = line.match(/^\|\s*\d+\s*\|\s*(GET|POST)\s*\|\s*`([^`]+)`/);
    if (m) endpoints.add(m[1] + ' ' + m[2]);
  }
  assert.ok(endpoints.size >= 10, '契约端点表没解析出来（表格式变了？）——本用例失效前先修解析，别让它假装通过');

  const orphans = [];
  for (const m of registry.list()) {
    const list = Array.isArray(m.contract) ? m.contract : [m.contract];
    for (const c of list) if (!endpoints.has(c)) orphans.push(m.name + ' → ' + c);
    assert.ok(m.description && m.description.length > 8, m.name + ' 需要一句给调用方看的说明');
    assert.equal(m.params.type, 'object', m.name + ' 的参数声明必须是对象');
  }
  assert.deepEqual(orphans, [], '这些方法指向的端点不在契约端点表里（＝新造了对外能力，或端点写错了）：' + orphans.join('；'));

  // 反向：门面必须**恰好**覆盖这几个能力，多一个（偷偷加能力）少一个（声明与实现不符）都要报红
  assert.deepEqual(registry.list().map((m) => m.name).sort(),
    ['session.activity', 'session.chat', 'session.export', 'session.status', 'session.stop', 'system.capabilities']);
  // 方法与后端能力一一对应：注册表里不许有"注册了但没有实现"的方法
  assert.deepEqual(registry.list().filter((m) => typeof backend[m.name] !== 'function').map((m) => m.name), []);
});

test('①-2 注册表自身的两条硬约束：重复注册 / 没声明契约端点，都在装配期就报错', () => {
  const r = new Registry();
  const d = { description: 'x'.repeat(12), contract: 'GET /api/health', params: { type: 'object', properties: {}, required: [] } };
  r.register('a.b', async () => ({}), d);
  assert.throws(() => r.register('a.b', async () => ({}), d), /重复注册/);
  assert.throws(() => r.register('c.d', async () => ({}), { ...d, contract: null }), /契约端点/);
  assert.throws(() => r.register('c.d', async () => ({}), { ...d, params: null }), /参数表/);
  // 后端缺能力 ⇒ 装配期抛错（不是等到调用时才 500）
  assert.throws(() => createRegistry({ 'system.capabilities': async () => ({}) }), /后端缺能力/);
});

// ---------------------------------------------------------------- ② 握手

test('② 握手：system.capabilities 报服务身份 + **从注册表出的**方法表 + 平台存活', async () => {
  const r = await ask(1, 'system.capabilities');
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 1);
  assert.equal(r.result.server, 'rw-platform-jsonrpc');
  assert.equal(r.result.protocolVersion, 1);
  assert.deepEqual(r.result.platform, { ok: true, service: 'rw', ts: 1 });
  // 方法表**来自注册表**（含每条对应的契约端点）：手抄一份到这儿就等于多了一个会过期的事实源
  assert.deepEqual(r.result.methods.map((m) => m.name).sort(), registry.list().map((m) => m.name).sort());
  const chat = r.result.methods.find((m) => m.name === 'session.chat');
  assert.deepEqual(chat.contract, ['POST /api/conversations', 'POST /api/chat']);
  assert.equal(chat.params.type, 'object');
  assert.equal(chat.handler, undefined, '握手不得把处理器（函数）带出去');
  assert.equal(r.error, undefined);
  // 平台不可达 ⇒ 业务失败（isError），不是协议错误：这是"这次没干成"，调用方可以稍后重试
  const bad = createRegistry({ ...backend, 'system.capabilities': async () => { throw new Error('平台返回 500：鉴权失败'); } });
  const rb = await dispatch({ jsonrpc: '2.0', id: 2, method: 'system.capabilities' }, bad);
  assert.equal(rb.error, undefined);
  assert.equal(rb.result.isError, true);
  assert.match(rb.result.message, /500/);
});

// ---------------------------------------------------------------- ③④⑤ 协议错误码

test('③ 未知方法与非法请求：-32601 / -32600（都是"你不会说协议"，不是业务失败）', async () => {
  const a = await ask(3, 'session.nope');
  assert.equal(a.error.code, ERR.METHOD_NOT_FOUND);
  assert.match(a.error.message, /session\.nope/);
  const b = await ask(4, 'rw_chat'); // MCP 门面的工具名在这里**不是**方法：两个门面各有各的方法名，不许混用
  assert.equal(b.error.code, ERR.METHOD_NOT_FOUND);
  const c = await dispatch({ jsonrpc: '2.0', id: 5 }, registry);
  assert.equal(c.error.code, ERR.INVALID_REQUEST, '缺 method');
  const d = await dispatch([{ jsonrpc: '2.0', id: 6, method: 'system.capabilities' }], registry);
  assert.equal(d.error.code, ERR.INVALID_REQUEST, '批量请求（数组）没有约定，明确拒绝好过猜');
  assert.equal(d.id, null);
  const e = await dispatch('这不是对象', registry);
  assert.equal(e, null, '不是对象、也没有 id ⇒ 通知位上的垃圾请求只能丢掉');
});

test('④ 参数非法：缺必填 / 类型错 / **多余参数** 一律 -32602，且不碰后端', async () => {
  calls.length = 0;
  const a = await ask(10, 'session.chat', { conversationId: '7' });
  assert.equal(a.error.code, ERR.INVALID_PARAMS);
  assert.match(a.error.message, /message/);
  const b = await ask(11, 'session.chat', { message: '你好', waitSeconds: '30' });
  assert.equal(b.error.code, ERR.INVALID_PARAMS, '类型不对要在协议层拦下，不要透传到后端再炸');
  assert.match(b.error.message, /waitSeconds/);
  // 写错一个参数名却"成功返回"是最坏的一种骗人（契约 §6「不静默」的同一口径）
  const c = await ask(12, 'session.chat', { message: '你好', wait_seconds: 30 });
  assert.equal(c.error.code, ERR.INVALID_PARAMS);
  assert.match(c.error.message, /不认识的参数.*wait_seconds/);
  assert.equal(calls.length, 0, '参数不合法时后端一次都不该被调用');
  // 空串按"没给"处理：命令行 `--id=` 会变成空串，不该被当成一个合法会话 id
  const d = await ask(13, 'session.status', { conversationId: '' });
  assert.equal(d.error.code, ERR.INVALID_PARAMS);
});

test('⑤ 坏 JSON → -32700，id 必须是 null（连 id 都读不出来，规范允许）', async () => {
  const s = stdio();
  s.input.emit('data', Buffer.from('这不是 JSON\n'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.written.length, 1);
  const m = s.msgs()[0];
  assert.equal(m.error.code, ERR.PARSE_ERROR);
  assert.equal(m.id, null);
  assert.equal(m.jsonrpc, '2.0');
});

// ---------------------------------------------------------------- ⑥ 业务失败

test('⑥ 业务失败走**结果里的 isError**（不是 JSON-RPC error）——调用方的处理方式完全不同', async () => {
  const bad = createRegistry({
    ...backend,
    'session.chat': async () => { const e = new Error('平台返回 429：并发达上限（code=CONCURRENCY_LIMIT）'); e.code = 'CONCURRENCY_LIMIT'; throw e; },
  });
  const r = await dispatch({ jsonrpc: '2.0', id: 20, method: 'session.chat', params: { message: 'x' } }, bad);
  assert.equal(r.error, undefined, '业务失败不是 JSON-RPC error');
  assert.equal(r.result.isError, true);
  assert.match(r.result.message, /CONCURRENCY_LIMIT/);
  assert.equal(r.result.code, 'CONCURRENCY_LIMIT', '平台给的机器可读 code 要原样透出来，别让调用方解析人话');
  // 成功时**不带** isError：调用方靠"有没有 isError"分流，成功也带就等于没有信号
  const okRes = await ask(21, 'session.status', { conversationId: '7' });
  assert.equal(okRes.result.isError, undefined);
  assert.equal(okRes.result.conversationId, '7');
});

// ---------------------------------------------------------------- ⑦ 通知

test('⑦ 通知一律不回（已注册的、未知方法的、缺 method 的都不回）', async () => {
  calls.length = 0;
  const s = stdio();
  const line = (o) => JSON.stringify(o) + '\n';
  s.input.emit('data', Buffer.from(
    line({ jsonrpc: '2.0', method: 'session.status', params: { conversationId: '7' } }) // 已注册的通知
    + line({ jsonrpc: '2.0', method: 'nope.nope' })                                     // 未知方法的通知
    + line({ jsonrpc: '2.0', params: {} })                                              // 缺 method 的通知
    + line({ jsonrpc: '2.0', id: 30, method: 'session.status', params: { conversationId: '7' } }), // 请求
  ));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.written.length, 1, '三条通知都不该有响应，只有那条带 id 的请求有');
  const m = s.msgs()[0];
  assert.equal(m.id, 30);
  assert.equal(m.result.conversationId, '7');
  // 通知**执行了**（一次），带 id 的那条请求**也执行了**（一次）——区别只在"写不写响应"
  assert.deepEqual(calls.map((c) => c[0]), ['status', 'status'], '已注册的通知要执行，但**不写响应**');
});

// ---------------------------------------------------------------- ⑧ 分帧

test('⑧ stdio 分帧：粘包、半行、多字节字符跨 chunk 都要活下来；每帧一行、按 id 配对', async () => {
  const s = stdio();
  const line = (o) => JSON.stringify(o) + '\n';

  // 一个 chunk 里：两条完整消息（粘包）+ 一条只有前半截
  s.input.emit('data', Buffer.from(
    line({ jsonrpc: '2.0', id: 40, method: 'system.capabilities' })
    + line({ jsonrpc: '2.0', method: 'nope.nope' }) // 通知：不回
    + '{"jsonrpc":"2.0","id":41,"method":"session.st',
  ));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.written.length, 1, '通知不回、半行不处理 ⇒ 此刻只有第一条的响应');

  // 跨 chunk 补完后半截：**故意把汉字"你好"从中间劈开**（UTF-8 三字节切成 1+2）
  s.input.emit('data', Buffer.from('atus","params":{"conversationId":"7"}}\n'));
  const full = Buffer.from(line({ jsonrpc: '2.0', id: 42, method: 'session.chat', params: { message: '你好，世界' } }));
  const cut = full.indexOf(Buffer.from('你')) + 1; // 切在"你"的三个字节中间
  s.input.emit('data', full.subarray(0, cut));
  s.input.emit('data', full.subarray(cut));
  s.input.emit('data', Buffer.from('这不是 JSON\n'));
  await new Promise((r) => setTimeout(r, 30));

  // **按 id 配对，不按顺序**：JSON-RPC 不保证响应顺序（多个 chunk 落在同一个 tick 时，同步报错会先写出去）
  const byId = new Map(s.msgs().map((m) => [m.id, m]));
  assert.ok(byId.get(40) && byId.get(40).result, '第一条要有响应');
  assert.ok(byId.get(41) && byId.get(41).result, '跨 chunk 的半行要能拼回来');
  assert.ok(byId.get(42) && byId.get(42).result, '被切成两半的那条也要能拼回来');
  assert.equal(byId.get(42).result.conversationId, '7');
  // 那个汉字参数必须**逐字**送到后端（用 toString() 拼帧的实现会在这里变成替换字符）
  const chatCall = calls.filter((c) => c[0] === 'chat').pop();
  assert.equal(chatCall[1].message, '你好，世界', 'UTF-8 多字节字符跨 chunk 时不得损坏');
  const parseErr = s.msgs().find((m) => m.error);
  assert.equal(parseErr.error.code, ERR.PARSE_ERROR);
  assert.equal(parseErr.id, null);
  for (const out of s.written) assert.ok(out.endsWith('\n'), '每条响应一行（newline-delimited）');
  assert.equal(s.errs.length, 0, '正常路径不该往 stderr 写东西');
});

test('⑧-2 stdin 结束时还剩半行：**如实记一笔**到 stderr，不当成坏 JSON 去回帧', async () => {
  const s = stdio();
  s.input.emit('data', Buffer.from('{"jsonrpc":"2.0","id":50,"method":"session.st'));
  s.input.emit('end');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.written.length, 0, '半行不是帧，不能当坏 JSON 回 -32700（否则每个半行都换来一条假错误）');
  assert.equal(s.errs.length, 1);
  assert.match(s.errs[0], /还剩半行/);
});

// ---------------------------------------------------------------- ⑨ 与既有两个入口的分工（不碰它们，但要证明没混线）

test('⑨ 两个门面各有各的方法名：JSON-RPC 门面不认 MCP 的方法，MCP 门面也不受这里影响', async () => {
  // 这条夹具是"外科手术式改动"的证据：`server/mcp-server.js` 一行未改（它的 8 条夹具仍全绿），
  // 且 MCP 的方法名（initialize/tools/list/tools/call）在本门面**一律 -32601** —— 两层是并列的两个适配器，
  // 不是一层套一层。调用方拿 MCP 的方法名来调 JSON-RPC 门面，应当立刻看到"方法不存在"，而不是行为怪异的成功。
  for (const m of ['initialize', 'tools/list', 'tools/call', 'ping']) {
    const r = await ask(60, m);
    assert.equal(r.error.code, ERR.METHOD_NOT_FOUND, m + ' 不该出现在 JSON-RPC 门面里');
  }
  // 反向：MCP 门面里的方法名与本门面**不共用注册表**（两边各 6/3 个方法，没有交集）
  assert.equal(registry.list().some((m) => m.name.startsWith('tools/')), false);
});
