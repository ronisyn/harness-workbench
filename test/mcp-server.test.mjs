// test/mcp-server.test.mjs - 平台作为 MCP server 的协议面（D4-B，2026-09-16）
//
// 为什么要夹具：MCP 是**对外协议**，错在协议层（少一个字段、把工具失败写成 JSON-RPC error、
// 分页游标装作没看见）时，调用方看到的是"连不上/工具面为空/莫名报错"，而我们的日志里一切正常。
// 这里把协议行为逐条钉住：握手回声、工具表、未知方法与未知工具、必填参数、**工具失败走 isError**、
// 通知不回、以及 stdio 的分帧（粘包/半行/坏 JSON）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleMessage, serveStdio, PROTOCOL_VERSION, SERVER_INFO, toolDefs } from '../server/mcp-server.js';

const calls = [];
const backend = {
  chat: async (a) => { calls.push(['chat', a]); return { conversation_id: '7', created: true, status: 'saved', content: '干完了' }; },
  status: async (a) => { calls.push(['status', a]); return { conversation_id: '7', count: 2, messages: [] }; },
  exportSession: async (a) => { calls.push(['export', a]); return { format: 'rw-session', formatVersion: 1, messages: 2 }; },
};

test('initialize：回声协议版本 + 声明 tools 能力（与我们的客户端握手逐字对齐）', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'x', version: '1' } } }, backend);
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION, '必须回声客户端/我们客户端用的同一个版本');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(r.result.serverInfo, SERVER_INFO);
});

test('tools/list：三个平台能力工具，schema 完整（对外只暴露"平台能力"，不搬内部 90+ 个模型工具）', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, backend);
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['rw_chat', 'rw_export', 'rw_status']);
  for (const t of r.result.tools) {
    assert.ok(t.description && t.description.length > 10, t.name + ' 要有给人/给模型看的说明');
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(Array.isArray(t.inputSchema.required), t.name + ' 要声明必填参数');
  }
  assert.deepEqual(toolDefs().find((t) => t.name === 'rw_chat').inputSchema.required, ['message']);
  assert.equal(r.result.nextCursor, undefined, '工具少，不分页');
});

test('分页纪律：收到不该出现的 cursor 要如实报错（别装作没看见、更别静默截断）', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { cursor: 'whatever' } }, backend);
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /cursor/);
});

test('tools/call：参数透传后端，结果按 MCP 口径包成 content[].text', async () => {
  calls.length = 0;
  const r = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rw_chat', arguments: { message: '你好', wait_seconds: 30 } } }, backend);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { message: '你好', wait_seconds: 30 });
  assert.equal(r.result.content[0].type, 'text');
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.status, 'saved');
  assert.equal(payload.conversation_id, '7');
  assert.equal(r.result.isError, undefined, '成功时不该带 isError');
});

test('未知工具 / 缺必填参数 → -32602（这是"你不会说协议"，不是工具执行失败）', async () => {
  const a = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rw_nope', arguments: {} } }, backend);
  assert.equal(a.error.code, -32602);
  const b = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rw_chat', arguments: {} } }, backend);
  assert.equal(b.error.code, -32602);
  assert.match(b.error.message, /message/);
});

test('工具执行失败 → **结果里带 isError**（不是 JSON-RPC error）——客户端的处理方式完全不同', async () => {
  const bad = { ...backend, chat: async () => { throw new Error('平台返回 500：内部错误（code=INTERNAL）'); } };
  const r = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'rw_chat', arguments: { message: 'x' } } }, bad);
  assert.equal(r.error, undefined, '不该是 JSON-RPC error');
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /工具执行失败.*INTERNAL/);
});

test('通知不回；未知方法 -32601；缺 method 是 Invalid Request', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, backend), null);
  const a = await handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, backend);
  assert.equal(a.error.code, -32601);
  const b = await handleMessage({ jsonrpc: '2.0', id: 9 }, backend);
  assert.equal(b.error.code, -32600);
  const c = await handleMessage([{ jsonrpc: '2.0', id: 10, method: 'ping' }], backend);
  assert.equal(c.error.code, -32600, '批量请求（数组）在 MCP 里没有约定，明确拒绝比猜要好');
});

test('stdio 分帧：粘包、半行、坏 JSON 都要活下来（一次喂两行 + 一条跨 chunk 的行）', async () => {
  const input = new EventEmitter();
  const written = [];
  const output = { write: (s) => { written.push(s); } };
  serveStdio({ backend, input, output, onError: () => {} });
  const line = (o) => JSON.stringify(o) + '\n';
  // 一个 chunk 里两条完整消息（粘包）+ 一条只有前半截
  input.emit('data', Buffer.from(
    line({ jsonrpc: '2.0', id: 11, method: 'ping' })
    + line({ jsonrpc: '2.0', method: 'notifications/initialized' })
    + '{"jsonrpc":"2.0","id":12,"method":"tools/l',
  ));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(written.length, 1, '通知不回、半行不处理 ⇒ 此刻只有 ping 的响应');
  input.emit('data', Buffer.from('ist"}\n'));
  input.emit('data', Buffer.from('这不是 JSON\n'));
  await new Promise((r) => setTimeout(r, 20));
  const msgs = written.map((s) => JSON.parse(s.trim()));
  assert.equal(msgs.length, 3, 'ping + tools/list + parse error');
  // **按 id 配对，不按顺序**：JSON-RPC 不保证响应顺序（多个 chunk 落在同一个 tick 时，同步报错会先写出去），
  // 客户端本来就该按 id 匹配（我们自己的 server/mcp.js 与 DSH 都是 pending.set(id) 这么做的）。
  const byId = new Map(msgs.map((m) => [m.id, m]));
  assert.ok(byId.get(11) && byId.get(11).result, 'ping 要有响应');
  assert.ok(Array.isArray(byId.get(12) && byId.get(12).result.tools), '跨 chunk 的那半行要能拼回来');
  const parseErr = msgs.find((m) => m.error);
  assert.equal(parseErr.error.code, -32700);
  assert.equal(parseErr.id, null, '坏 JSON 连 id 都读不出来 ⇒ id: null（规范允许）');
  for (const s of written) assert.ok(s.endsWith('\n'), '每条响应一行（newline-delimited）');
});
