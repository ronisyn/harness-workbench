// server/mcp.js - MCP client 框架（2026-09 批5，P11）
// 协议：Model Context Protocol（JSON-RPC 2.0 over stdio）。
// 职责：管理外部 MCP server 连接（spawn 子进程），暴露 tools/list + tools/call 给 execTool 层。
// 首批：接入点由 settings mcp_servers 配置：[{ id, command, args[], env{} }]。
// 安全：MCP server 由管理员配置（settings）；其工具以 mcp_<serverId>_<tool> 名前缀注册，受统一权限/纪律层约束。
import { spawn } from 'node:child_process';
import { db } from './db.js';

const clients = new Map(); // serverId -> { proc, reqId, pending: Map<id,{resolve,reject}>, buf, tools: [] }

async function getSetting(key, def) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', [key]);
    if (!r[0]) return def;
    try { return JSON.parse(r[0].svalue); } catch { return r[0].svalue; }
  } catch { return def; }
}

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

// 连接（spawn 子进程 + 初始化握手 + tools/list）
export async function connectMcp(id, command, args = [], env = {}) {
  if (clients.has(id)) return { ok: true, note: '已连接' };
  const proc = spawn(command, args, {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const cl = { proc, reqId: 0, pending: new Map(), buf: '', tools: [] };
  clients.set(id, cl);
  proc.stderr.on('data', (d) => { /* MCP server stderr 记录（调试用） */ console.log('[mcp:' + id + ']', String(d).slice(0, 300)); });
  proc.on('exit', (code) => { console.log('[mcp:' + id + '] 退出 code=' + code); clients.delete(id); });
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
  const init = await rpc(cl, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rw', version: '1' } });
  await rpc(cl, 'notifications/initialized', {});
  const t = await rpc(cl, 'tools/list', {});
  cl.tools = (t && t.tools) || [];
  return { ok: true, serverId: id, tools: cl.tools.map((x) => x.name), init: init && init.serverInfo };
}

export function disconnectMcp(id) {
  const cl = clients.get(id);
  if (cl) { try { cl.proc.kill(); } catch { /* ignore */ } clients.delete(id); }
}

export function listMcpClients() {
  return [...clients.entries()].map(([id, cl]) => ({ id, tools: cl.tools.map((t) => t.name) }));
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
export async function connectConfiguredMcps() {
  try {
    const cfg = await getSetting('mcp_servers', []);
    if (!Array.isArray(cfg)) return [];
    const out = [];
    for (const s of cfg) {
      if (!s || !s.id || !s.command) continue;
      try { const r = await connectMcp(s.id, s.command, s.args || [], s.env || {}); out.push({ id: s.id, ok: true, tools: (r.tools || []).length }); }
      catch (e) { out.push({ id: s.id, ok: false, error: String(e.message).slice(0, 120) }); }
    }
    return out;
  } catch { return []; }
}
