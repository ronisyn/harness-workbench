// server/mcp.js - MCP client 框架（2026-09 批5，P11）
// 协议：Model Context Protocol（JSON-RPC 2.0 over stdio）。
// 职责：管理外部 MCP server 连接（spawn 子进程），暴露 tools/list + tools/call 给 execTool 层。
// 首批：接入点由 settings mcp_servers 配置：[{ id, command, args[], env{} }]。
// 凭据（C-18）：env 里的密钥**不在这里读明文**——settings 里存的是引用（`__CRED__:NAME`），
//   真值只有 `server/credentials.js` 一条路能取到；老配置里还裸着的明文由它按"键名同名凭据"兼容解析。
// 安全：MCP server 由管理员配置（settings）；其工具以 mcp_<serverId>_<tool> 名前缀注册，受统一权限/纪律层约束。
import { spawn } from 'node:child_process';
import { db } from './db.js';
import { readMcpConfig, resolveEnv, redactSecretValues } from './credentials.js';
import { RW_OS } from './env.js';
import { PROTOCOL_VERSION } from './mcp-version.js'; // 两个方向（客户端/服务端）说同一个协议版本，单一出处

const clients = new Map(); // serverId -> { proc, reqId, pending: Map<id,{resolve,reject}>, buf, tools: [] }

// JSON-RPC 发送 + 等待响应（method 以 notifications/ 开头=通知，无 id 不期待响应）
function rpc(cl, method, params) {
  if (method.startsWith('notifications/')) {
    cl.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve({});
  }
  const id = ++cl.reqId;
  return new Promise((resolve, reject) => {
    cl.pending.set(id, { resolve, reject });
    cl.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (cl.pending.has(id)) { cl.pending.delete(id); reject(new Error('MCP ' + method + ' 响应超时(15s)')); } }, 15000);
  });
}

function ensureServer(id) {
  const cl = clients.get(id);
  if (!cl) throw new Error('MCP server 未连接: ' + id);
  return cl;
}

// tools/list 全量拉取（2026-09-15，OP-18）：原来只取第一页 ⇒ 工具数超过一页的 server 会被**静默截断**
// （模型看不见后面的工具，且没有任何提示）。照 DSH `dsh-mcp-client` 的分页纪律：跟随 nextCursor 取完，
// 并对"重复游标"直接抛错（服务端分页坏了就该如实失败，而不是死循环或悄悄少给工具）。
async function listAllTools(cl) {
  const out = [];
  const seenCursors = new Set();
  let cursor;
  do {
    const r = await rpc(cl, 'tools/list', cursor ? { cursor } : {});
    for (const t of (r && r.tools) || []) out.push(t);
    cursor = r && r.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error('MCP server 重复返回 tools/list 游标（无效分页）：' + String(cursor).slice(0, 40));
      seenCursors.add(cursor);
    }
  } while (cursor);
  return out;
}

// 连接（spawn 子进程 + 初始化握手 + tools/list）
export async function connectMcp(id, command, args = [], env = {}) {
  if (clients.has(id)) return { ok: true, note: '已连接' };
  const proc = spawn(command, args, {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    // Windows：npm/npx 只有 .cmd 形式，spawn 直呼必然 ENOENT（显式写 .cmd 在 Node 22 上还会 EINVAL）。
    // 过 shell 让 PATHEXT 解析生效；这里用 Node 的 shell:true（Windows 上就是 cmd /d /s /c）而不是
    // PowerShell：MCP 是 JSON-RPC 字节流，cmd 只做透传，PowerShell 会按自己的格式化规则改写子进程输出。
    ...(RW_OS === 'win32' ? { shell: true } : {}),
  });
  const cl = { proc, reqId: 0, pending: new Map(), buf: '', tools: [] };
  clients.set(id, cl);
  proc.stderr.on('data', (d) => { /* MCP server stderr 记录（调试用）。外部进程的 stderr 可能把我们给它的密钥回显出来 ⇒ 出口统一过凭据脱敏 */ console.log('[mcp:' + id + ']', redactSecretValues(String(d).slice(0, 300))); });
  proc.on('exit', (code) => { console.log('[mcp:' + id + '] 退出 code=' + code); clients.delete(id); });
  // 2026-09-16 修（真崩溃 bug，子代理实测发现）：**spawn 失败是 `'error'` 事件，没有监听器就抛成
  // unhandled 'error' 并带走整个进程** —— `connectConfiguredMcps` 的 try/catch 抓不到它（那时 promise
  // 还没 reject）。触发条件很日常：command 配错、PATH 变化、工具没装（实测 `spawn npx` 在只有 `npx.cmd`
  // 的 Windows 上必 ENOENT）。修法：把本次连接的所有 pending 请求以同一个错 reject，并把 client 摘掉。
  proc.on('error', (e) => {
    console.error('[mcp:' + id + '] 启动失败：' + ((e && e.message) || e));
    clients.delete(id);
    for (const [, p] of cl.pending) { try { p.reject(new Error('MCP server ' + id + ' 启动失败：' + ((e && e.message) || e))); } catch { /* ignore */ } }
    cl.pending.clear();
  });
  proc.stdin.on('error', () => { /* pipe 关闭 */ });
  // 解析 stdout JSON-RPC
  proc.stdout.on('data', (d) => {
    cl.buf += d.toString();
    let idx;
    while ((idx = cl.buf.indexOf('\n')) >= 0) {
      const line = cl.buf.slice(0, idx).trim(); cl.buf = cl.buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && cl.pending.has(msg.id)) {
        const p = cl.pending.get(msg.id); cl.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('MCP ' + (msg.error.message || 'error')));
        else p.resolve(msg.result);
      } else if (msg.method === 'notifications/message' || msg.method?.startsWith('notifications/')) {
        // 通知忽略（可扩展：记录）
      }
    }
  });
  // 握手
  const init = await rpc(cl, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'rw', version: '1' } });
  await rpc(cl, 'notifications/initialized', {});
  const t = await listAllTools(cl);
  cl.tools = t;
  return { ok: true, serverId: id, tools: cl.tools.map((x) => x.name), init: init && init.serverInfo };
}

export function disconnectMcp(id) {
  const cl = clients.get(id);
  if (cl) { try { cl.proc.kill(); } catch { /* ignore */ } clients.delete(id); }
}

export function listMcpClients() {
  // 返回含完整工具定义（name/description/inputSchema）——syncMcpTools 需 schema 生成 function calling 描述并注册进统一工具表
  return [...clients.entries()].map(([id, cl]) => ({ id, tools: cl.tools }));
}

// 调用 MCP 工具（execTool 层注册为 mcp_<id>_<tool>）
export async function callMcpTool(serverId, toolName, args) {
  const cl = ensureServer(serverId);
  const r = await rpc(cl, 'tools/call', { name: toolName, arguments: args || {} });
  // MCP 返回 { content: [{type:'text', text}] } 或 { content: [{type:'image',...}] }
  if (r && r.content && Array.isArray(r.content)) {
    return { content: r.content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image ' + (c.mimeType || '?') + ']' : JSON.stringify(c))).join('\n') };
  }
  return { content: JSON.stringify(r || {}).slice(0, 4000) };
}

// 由配置（settings mcp_servers）连接全部已配置 server
/**
 * 连接全部已配置的 MCP server。
 * @param {object} [dbc] 可注入的库（夹具用假库；真库会被连/被写，单测不能碰它）。
 *   2026-09-16 改：原来是 `__setDbForTest()` **就地改模块级 db 绑定**——那是"生产文件里的测试缝"，
 *   而且改的是全局对象，夹具之间会互相影响。改成**普通参数**（缺省仍是真库），语义直白、没有隐藏状态。
 */
export async function connectConfiguredMcps(dbc = db) {
  try {
    const cfg = await readMcpConfig(dbc);
    if (!Array.isArray(cfg)) return [];
    const out = [];
    for (const s of cfg) {
      if (!s || !s.id || !s.command) continue;
      // 凭据在这里解析（引用 → 真值）；缺密钥时 resolveEnv 直接抛错，下面照原样记成 ok:false（不静默降级）
      try { const r = await connectMcp(s.id, s.command, s.args || [], resolveEnv(s.env)); out.push({ id: s.id, ok: true, tools: (r.tools || []).length }); }
      catch (e) { out.push({ id: s.id, ok: false, error: String(e.message).slice(0, 120) }); }
    }
    return out;
  } catch { return []; }
}
