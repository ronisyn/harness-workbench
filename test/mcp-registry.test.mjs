// test/mcp-registry.test.mjs - OP-18 统一工具装载器（2026-09-15）
//
// 背景：MCP 外部工具原来是"另一张表"（MCP_EXTRA 只给模型看的 defs）+ execTool 里按名字模式**现造**伪工具。
// 同一工具两处表述 ⇒ 装配期校验（重名/缺描述/缺 run/缺权限）不覆盖它们、工具界限表看不见它们、
// 重名只能等厂商返回 400 后再由网关静默去重。DSH（`dsh-mcp-client`）的做法是注册进**同一个** tools 注册表：
// 一个失败就回滚整批、server 列出重名工具直接抛错、tools/list 跟随 nextCursor 分页。本夹具锁这三条 + 端到端。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, toolDefs, execTool, syncMcpTools } from '../server/tools/index.js';
import { dynamicSourceIds, registerDynamicTools } from '../server/tools/registry.js';
import { connectMcp, disconnectMcp, listMcpClients, callMcpTool } from '../server/mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 夹具放在 scripts/fixtures 而不是 test/fixtures：`node --test` 会把 test/ 下所有 .mjs 当测试文件，
// 那个"等 stdin"的假 server 一旦被当测试跑起来，整套测试会永久挂住（实测 600s 无输出）。
const FAKE = path.join(HERE, '../scripts/fixtures/fake-mcp-server.mjs');
const CTX = () => ({ permission: 'full', root: process.cwd(), conversationId: 0, accountId: 0, __signal: new AbortController().signal });
const N = (n) => 'mcp_test_' + n;
const entry = (n, extra = {}) => ({ name: N(n), description: '夹具 ' + n, permission: 'write', timeoutMs: 15000, mcpServer: 'test', rawTool: n, params: {}, run: async () => ({ content: n }), ...extra });

test.before(() => {
  // 本文件是唯一注册 mcp 动态来源的夹具；先清空，保证与其它夹具互不影响
  syncMcpTools([]);
});
test.after(() => { syncMcpTools([]); });

test('注册后进同一个 TOOLS：一个工具面、一条 toolDefs 路径', () => {
  const before = TOOLS.length;
  assert.equal(syncMcpTools([{ id: 'test', tools: [{ name: 'ping', description: '探活', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }] }]), 1);
  assert.equal(TOOLS.length, before + 1, 'MCP 工具必须出现在同一个 TOOLS 里（不再有第二张表）');
  const d = toolDefs('all', null, null).find((x) => x.function.name === N('ping'));
  assert.ok(d, 'toolDefs 必须含它（同一条路径，不再拼接）');
  assert.deepEqual(d.function.parameters, { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, 'MCP 自带 JSON Schema 必须原样透传');
  assert.deepEqual(dynamicSourceIds(), ['mcp']);
});

test('装配期校验对 MCP 同样生效：缺描述/缺 run/缺权限/界限非法 → 整批拒绝，且保留上一代', () => {
  const keep = TOOLS.length;
  const bad = [
    [entry('no_desc', { description: '' }), /缺少 description/],
    [entry('no_run', { run: undefined }), /缺少 run 实现/],
    [entry('no_perm', { permission: '' }), /缺少 permission/],
    [entry('bad_bound', { timeoutMs: 0 }), /界限非法/],
  ];
  for (const [badEntry, re] of bad) {
    const out = registerDynamicTools('probe', [badEntry]);
    assert.equal(out.ok, false, '非法条目必须被拒绝：' + badEntry.name);
    assert.match(out.error, re);
  }
  assert.equal(TOOLS.length, keep, '被拒绝的批次不得改动工具面（全有或全无）');
  assert.deepEqual(dynamicSourceIds().includes('probe'), false, '被拒绝的来源不得留下空壳');
});

test('重名即拒绝（不是静默去重）：同一 server 内重名、跨 server 撞名、同一批内撞名', () => {
  // 同一 server 列出重名工具（DSH：server listed tool X more than once — invalid tool list）
  assert.throws(() => syncMcpTools([{ id: 'dup', tools: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] }]), /重复列出工具/);
  // 跨 server 撞名：mcp_a_b_c 既能由 (a, b_c) 也能由 (a_b, c) 生成 —— 必须在装配期拦下
  // （否则厂商直接 400 "Tool names must be unique"，而网关的静默去重会让模型看不见其中一个却不知为什么）
  assert.throws(() => syncMcpTools([
    { id: 'a', tools: [{ name: 'b_c', description: 'x' }] },
    { id: 'a_b', tools: [{ name: 'c', description: 'y' }] },
  ]), /工具重名/);
  // 同一批里的重名（不经 syncMcpTools 的生成逻辑）同样拦下
  const out = registerDynamicTools('probe', [entry('dup2'), entry('dup2')]);
  assert.equal(out.ok, false);
  assert.match(out.error, /工具重名/);
});

test('命名空间化后不会与内置工具撞名（内置 read_file ≠ mcp_test_read_file）', () => {
  const out = registerDynamicTools('probe', [entry('read_file')]);
  assert.equal(out.ok, true);
  assert.ok(TOOLS.some((t) => t.name === 'read_file'), '内置 read_file 仍在');
  assert.ok(TOOLS.some((t) => t.name === N('read_file')), 'MCP 的同名工具按命名空间另立一条');
  registerDynamicTools('probe', []);
});

test('已连接 MCP 的真实工具面受壳白名单约束，且 minimal 档不裁掉它们（沿用原口径）', () => {
  syncMcpTools([{ id: 'test', tools: [{ name: 'ping', description: '探活' }] }]);
  const names = (sh) => toolDefs('minimal', new Set(), sh).map((d) => d.function.name).filter((n) => n.startsWith('mcp_'));
  assert.deepEqual(names(null), [N('ping')], 'minimal 档也应暴露 MCP 工具（由管理员在壳上装载，不受档位裁剪）');
  assert.deepEqual(names({ presetBase: 'all', mcpAllow: ['other'] }), [], '壳未装载该 server → 工具面对它不可见');
  assert.deepEqual(names({ presetBase: 'all', mcpAllow: ['test'] }), [N('ping')]);
});

test('执行走同一条路径（findTool 查表，不再按名字现造伪工具）', async () => {
  syncMcpTools([{ id: 'test', tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }]);
  const r = await execTool(N('echo'), { text: 'hi' }, CTX());
  assert.ok(r && (r.content !== undefined || r.error !== undefined), '应返回结果对象');
  // 壳白名单未装载 → 执行层同口径拦截（返回 error 而不是抛出中断整轮）
  const blocked = await execTool(N('echo'), {}, { ...CTX(), __shellSchema: { mcpAllow: ['other'] } });
  assert.match(blocked.error, /未被当前壳装载/);
});

test('端到端：真实 spawn 一个 MCP server，分页 tools/list 全取回，tools/call 打通', async () => {
  const info = await connectMcp('fake', process.execPath, [FAKE]);
  try {
    assert.deepEqual(info.tools.sort(), ['echo', 'second_page_tool'], '必须跟随 nextCursor 取完两页（原来只取第一页＝静默截断）');
    const n = syncMcpTools(listMcpClients());
    assert.equal(n, 2);
    assert.deepEqual((await callMcpTool('fake', 'echo', { text: 'ok' })).content, 'echo:ok');
    const r = await execTool('mcp_fake_echo', { text: 'ok' }, CTX());
    assert.equal(r.content, 'echo:ok', 'execTool 必须能直接调用注册进注册表的 MCP 工具');
  } finally { disconnectMcp('fake'); syncMcpTools([]); }
});

test('端到端：服务端分页坏掉（重复游标）必须如实报错，而不是死循环', async () => {
  await assert.rejects(() => connectMcp('bad', process.execPath, [FAKE, '--bad-cursor']), /重复返回 tools\/list 游标/);
  disconnectMcp('bad');
});
