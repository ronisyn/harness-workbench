// test/connectors-watchdog.test.mjs —— MCP 看门狗：声明的源"挂了要能自己回来"（v0.3 §0.2 G2 的另一半）
//
// 为什么补这条夹具（2026-09-17）：子进程意外退出时 `server/mcp.js` 的 `proc.on('exit')` 会把客户端从池里
//   删掉（对的），但**没有任何东西把它拉回来** —— 会话从此静默缺 `mcp_*` 工具。旧看门狗只盯
//   `settings.mcp_servers` ⇒ **`kind=mcp` 的连接器挂了不会被拉回来**（这份夹具锁的就是这条）。
//
// 三组判据：
//   ① 纯函数 `declaredMcpIds`：两份声明的并集（mcp_servers ∪ connectors(kind=mcp)）、去重、忽略 http 连接器、
//      声明非法时只认 mcp_servers、非数组/脏项一律不当成声明；
//   ② 正例（真 spawn 假 MCP server）：**连接器声明的** MCP 源从池里消失后，一拍之内被拉回来、工具面恢复；
//   ③ 负例：没有缺失时**一个源都不动**（不撤、不重连）——看门狗不许顺手把工具面清掉。
//
// 环境：假库只认 settings 那条 SELECT；不调模型、不碰真库、不连外部服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAKE_MCP = path.join(HERE, '../scripts/fixtures/fake-mcp-server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-watchdog-'));
process.env.RW_CREDENTIALS_FILE = path.join(TMP, '.credentials.yaml'); // 必须在 import 之前设

const { declaredMcpIds, reconnectMissingDeclared } = await import('../server/connectors.js');
const { disconnectMcp, listMcpClients } = await import('../server/mcp.js');
const { TOOLS, syncMcpTools } = await import('../server/tools/index.js');
const { dynamicSourceIds, unregisterDynamicTools } = await import('../server/tools/registry.js');

/** 假库：只认 settings 那一张表的 SELECT（其余一律抛错，免得夹具悄悄假装支持了什么）。 */
class FakeDb {
  constructor(settings = {}) { this.rows = new Map(Object.entries(settings)); }
  set(key, value) { this.rows.set(key, value); return this; }
  async query(sql, params) {
    if (/^SELECT svalue FROM settings WHERE skey=\?$/.test(sql)) {
      return this.rows.has(params[0]) ? [{ svalue: this.rows.get(params[0]) }] : [];
    }
    throw new Error('假库不认识的查询：' + sql);
  }
}

const mcpConn = (id, args = [FAKE_MCP]) => ({ id, kind: 'mcp', command: process.execPath, args });
const mcpServer = (id, args = [FAKE_MCP]) => ({ id, command: process.execPath, args });
const httpConn = (id) => ({ id, kind: 'http', baseUrl: 'https://api.example.com/v1', credential: 'X', actions: [{ name: 'a', method: 'GET', path: '/a' }] });

test.beforeEach(() => {
  for (const c of listMcpClients()) disconnectMcp(c.id);
  syncMcpTools([]);
  for (const sid of dynamicSourceIds()) unregisterDynamicTools(sid);
});
test.after(() => {
  for (const c of listMcpClients()) disconnectMcp(c.id);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── ① 判据本体（纯函数，穷举那些"看着像声明、其实不该去连"的输入） ─────────────────────────
test('① declaredMcpIds：两份声明的并集；http 连接器、脏项、非法声明都不算"要盯的源"', () => {
  assert.deepEqual(declaredMcpIds([mcpServer('a'), mcpServer('b')], [], {}), ['a', 'b'], '只有 mcp_servers 时就是它');
  assert.deepEqual(declaredMcpIds([], [mcpConn('c')], {}), ['c'], 'kind=mcp 的连接器也要盯（这就是旧看门狗漏掉的那半边）');
  assert.deepEqual(declaredMcpIds([mcpServer('a')], [mcpConn('a'), mcpConn('c')], {}), ['a', 'c'], '同 id 取一次（两处声明同一个 server 是常见的）');
  assert.deepEqual(declaredMcpIds([mcpServer('a')], [httpConn('h')], {}), ['a'], 'HTTP 连接器不是 MCP 客户端，不进这份清单');
  assert.deepEqual(declaredMcpIds([mcpServer('a')], [mcpConn('c')], { connectorsOk: false }), ['a'],
    '连接器声明非法时那半边冻结：只认 mcp_servers（不去按坏声明重连）');
  // 脏输入：不是数组 / 没有 id / null 项 —— 一律不当成"声明的源"（宁可漏连，不可凭空连接）
  assert.deepEqual(declaredMcpIds(null, undefined, {}), []);
  assert.deepEqual(declaredMcpIds([{ command: 'x' }, null], [{ kind: 'mcp' }, null], {}), []);
  assert.deepEqual(declaredMcpIds('mcp_servers 不是数组', [mcpConn('c')], {}), ['c'], '一处声明写坏不拖累另一处');
});

// ── ② 正例：连接器声明的 MCP 源"挂了" ⇒ 一拍之内被拉回来、工具面恢复 ────────────────────────
test('② 连接器声明的 MCP 源掉了 ⇒ reconnectMissingDeclared 把它拉回来（旧看门狗在这里一动不动）', async () => {
  const db = new FakeDb({ connectors: [mcpConn('watchdog_conn')] });
  // 先让声明生效（等价于启动/reload 之后的状态）
  const first = await reconnectMissingDeclared(db);
  assert.deepEqual(first.missing, ['watchdog_conn'], '池里还没有它 ⇒ 一拍就该认出"声明了但不在池里"');
  assert.deepEqual(first.reconnected, ['watchdog_conn'], '并且真的连上了：' + JSON.stringify(first));
  assert.ok(listMcpClients().some((c) => c.id === 'watchdog_conn'), '池子里要有它');
  const tools = TOOLS.filter((t) => t.name.startsWith('mcp_watchdog_conn_')).map((t) => t.name);
  assert.ok(tools.length > 0, '工具面里要有它的工具：' + JSON.stringify(TOOLS.map((t) => t.name).filter((n) => n.startsWith('mcp_'))));

  // 模拟"子进程意外退出"：`server/mcp.js` 的 exit 钩子会把客户端从池里删掉 —— 这里直接做同一件事
  disconnectMcp('watchdog_conn');
  assert.ok(!listMcpClients().some((c) => c.id === 'watchdog_conn'), '前置：它确实从池里消失了');
  // 注意：此时**工具面还是上一代**（没人调 syncMcpTools）——这正是"静默缺工具"的形态：
  // 池子空了、模型那边看起来一切正常，直到下一次 reload/重启。看门狗要做的就是把两端都恢复。

  const second = await reconnectMissingDeclared(db);
  assert.deepEqual(second.missing, ['watchdog_conn'], '看门狗必须认出它掉了');
  assert.deepEqual(second.reconnected, ['watchdog_conn'], '并且把它拉回来：' + JSON.stringify(second));
  assert.ok(second.registeredTools > 0, '重连后要把工具重新注册进同一张表（否则连上了也没有工具）');
  assert.ok(TOOLS.some((t) => t.name.startsWith('mcp_watchdog_conn_')), '工具面恢复了');
  assert.deepEqual(second.failures, [], '没失败就别报失败：' + JSON.stringify(second.failures));
});

// ── ③ 负例：没有缺失时一个源都不动（看门狗不许"顺手清工具面"） ─────────────────────────────
test('③ 没有缺失 ⇒ 零副作用：已连接的源不动、工具面不动、返回 missing 为空', async () => {
  const db = new FakeDb({ connectors: [mcpConn('watchdog_conn2')] });
  await reconnectMissingDeclared(db);
  const before = listMcpClients().map((c) => c.id).sort();
  const toolsBefore = TOOLS.map((t) => t.name).sort();
  const r = await reconnectMissingDeclared(db);
  assert.deepEqual(r.missing, [], '都在池里 ⇒ 没什么可重连的');
  assert.equal(r.registeredTools, null, '没做事就不该谎报"注册了 N 个工具"');
  assert.deepEqual(listMcpClients().map((c) => c.id).sort(), before, '已连接的客户端不许被断开重连（那会打断正在跑的工具调用）');
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), toolsBefore, '工具面必须一模一样');
});

// ── ④ 源码级锁：看门狗真的走这条判据（不然上面三条证的是"没人用的函数"） ────────────────────
test('④ 接线：定时看门狗调用 reconnectMissingDeclared（判据与 reload 同源）', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  // 只看**看门狗那一段**（`mcpWatchdog` 到 `unref`）：文件别处读 `mcp_servers` 是别的事（/api/mcp 路由等），
  // 一刀切会误伤——判据要钉的是"这一段用什么判据"，不是"全文件不许出现这个字符串"。
  const from = src.indexOf('const mcpWatchdog');
  const to = src.indexOf('.unref', from);
  assert.ok(from > 0 && to > from, '要能定位看门狗那一段');
  const block = src.slice(from, to);
  assert.match(block, /reconnectMissingDeclared\(\)/, '看门狗必须调它');
  assert.ok(!/getSetting\('mcp_servers'/.test(block), '这一段里旧的"只读 mcp_servers"判据不得复活（那正是漏掉连接器的那半边）');
  const conn = readFileSync(path.join(ROOT, 'server', 'connectors.js'), 'utf8');
  assert.match(conn, /export function declaredMcpIds/, '判据本体要能被夹具直接打（纯函数）');
  assert.match(conn, /readConnectorConfig\(dbc\)[\s\S]{0,160}readMcpConfig\(dbc\)/, '两份声明都要读（缺一份就漏半边）');
});
