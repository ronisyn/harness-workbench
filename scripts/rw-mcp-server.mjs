#!/usr/bin/env node
// scripts/rw-mcp-server.mjs - 把平台当 MCP server 跑起来（stdio），供别的 agent 当工具调（D4-B）
//
// 用法（在客户/调用方的 MCP 配置里）：
//   { "mcpServers": { "rw": { "command": "node", "args": ["<平台目录>/scripts/rw-mcp-server.mjs"],
//                            "env": { "RW_MCP_USER": "...", "RW_MCP_PASS": "..." } } } }
//
// 环境变量：
//   RW_MCP_BASE_URL    平台地址（默认 http://127.0.0.1:880）
//   RW_MCP_USER/PASS   调用账号（缺省回落到 RW_ADMIN_USER/RW_ADMIN_PASS；也可用 .rw-keys.env，见下）
//   RW_MCP_PERMISSION  新建会话的权限（默认 **read**：最小权限。要让它真干活由运维显式提权）
//   RW_MCP_WAIT_SECONDS  rw_chat 单次最多等多久（默认 60 秒）
//
// 它**只**用已冻结的对外契约（docs/会话API契约-v1.md）：登录 / 建会话 / chat(SSE) / messages / export-full。
// 也就是说：这份代码本身就是那份契约的第一个真实外部消费者——契约写错了，这里就会踩到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStdio } from '../server/mcp-server.js';
// 自造会话的标题走**统一声明**（`__probe__ …`）：本适配器建的会话是我们自己发起的，不属于"真实流量"
// （v0.3 §0.3.1 的口径："探针 ≠ 真实流量"；判据唯一实现在 server/cohort.js）。
// 声明方式只有**一处出处**——`probeTitle`（server/cohort.js 导出，脚本侧由 ./cohort.mjs 转发）；别写死前缀。
import { probeTitle } from './cohort.mjs';

const BASE = (process.env.RW_MCP_BASE_URL || 'http://127.0.0.1:880').replace(/\/$/, '');
const PERMISSION = process.env.RW_MCP_PERMISSION || 'read';
const DEFAULT_WAIT = Number(process.env.RW_MCP_WAIT_SECONDS || 60);

// 账号：环境变量 → 运行账户家目录的 .rw-keys.env（与 selfcheck/agent-smoke 同一口径，不在代码里写死路径）
function creds() {
  let user = process.env.RW_MCP_USER || process.env.RW_ADMIN_USER || '';
  let pass = process.env.RW_MCP_PASS || process.env.RW_ADMIN_PASS || '';
  if (!user || !pass) {
    try {
      const f = path.join(os.homedir(), '.rw-keys.env');
      const txt = fs.readFileSync(f, 'utf8');
      const get = (k) => txt.split('\n').find((l) => l.startsWith(k + '='))?.split('=').slice(1).join('=').trim();
      user = user || get('RW_ADMIN_USER'); pass = pass || get('RW_ADMIN_PASS');
    } catch { /* 交由下面报错 */ }
  }
  return { user, pass };
}

let token = null;
async function login() {
  const { user, pass } = creds();
  if (!user || !pass) throw new Error('缺账号：设 RW_MCP_USER/RW_MCP_PASS（或 RW_ADMIN_USER/RW_ADMIN_PASS），或在运行账户家目录放 .rw-keys.env');
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
  const j = await r.json();
  if (!j.token) throw new Error('平台登录失败：' + (j.message || r.status) + '（code=' + (j.code || '-') + '）');
  token = j.token;
}

// 所有调用都过这里：401 时**重新登录一次**再试（token 会过期，而 MCP 进程可能活很久）
async function api(pathname, { method = 'GET', body, raw = false } = {}) {
  if (!token) await login();
  const call = () => fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await call();
  if (r.status === 401) { token = null; await login(); r = await call(); }
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('平台返回 ' + r.status + '：' + (j.message || JSON.stringify(j).slice(0, 200)) + (j.code ? '（code=' + j.code + '）' : ''));
  return j;
}

// 跑一轮对话：POST /api/chat 是 SSE，这里按契约的帧格式解到 done/run_end 为止
async function chatStream(conversationId, message, waitSeconds) {
  if (!token) await login();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5, waitSeconds) * 1000);
  let content = '';
  let done = null; let runEnd = null; let errMsg = null;
  try {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId, content: message }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('平台返回 ' + r.status + '：' + (j.message || '') + (j.code ? '（code=' + j.code + '）' : ''));
    }
    // 帧格式：`[id: <seq>\n]data: <json>\n\n`，另有 `: ping` 保活（契约 §4）
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue; // 跳过 `id:` 与 `: ping`
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          // 帧字段名以契约为准（§4）：流式正文在 `delta` 里；`text` 只是兼容旧写的兜底。
          if (ev.type === 'delta') content += (ev.delta !== undefined ? ev.delta : (ev.text || ''));
          else if (ev.type === 'done') { done = ev; if (ev.content) content = ev.content; }
          else if (ev.type === 'run_end') runEnd = ev;
          else if (ev.type === 'error') errMsg = ev.message;
        }
      }
      // 读满即 **break**，**不要**在这里 `ac.abort()`（2026-09-16 实测，由 ⑳ JSON-RPC 的核对撞出来）：
      // abort 会让这个 `for await` 的 next() 当场以 AbortError 拒绝、落进下面的"超时"分支 ⇒
      // **流明明跑完了却报 status:'timeout'、run_id 丢成 null**（内容靠回读落库那条兜住了，肉眼很难发现）。
      // abort 只留给真正的超时（上面的 timer）。
      if (runEnd || done) break;
    }
  } catch (e) {
    if (e.name === 'AbortError' || /aborted/i.test(String(e.message))) {
      // 超时不是失败：平台上的活还在跑（契约 §4：调用方断开=服务端中止本轮！所以这里要说清"我们主动放弃了等待"）
      return { status: 'timeout', content, note: '等待超时：已停止等待（平台本轮会因断开而中止）。长任务请把 wait_seconds 调大，或改用 rw_status 轮询。' };
    }
    throw e;
  } finally { clearTimeout(timer); }
  if (errMsg) throw new Error('平台本轮执行失败：' + errMsg);
  return { status: runEnd ? runEnd.status : 'unknown', content, runId: (runEnd && runEnd.runId) || null, messageId: (runEnd && runEnd.messageId) || (done && done.messageId) || null };
}

const backend = {
  async chat(args) {
    let cid = args.conversation_id ? Number(args.conversation_id) : null;
    let created = false;
    if (!cid) {
      const c = await api('/api/conversations', { method: 'POST', body: { title: probeTitle('MCP: ' + String(args.message).slice(0, 40)), permission: PERMISSION } });
      cid = c.id; created = true;
    }
    const r = await chatStream(cid, String(args.message), Number(args.wait_seconds) || DEFAULT_WAIT);
    // 兜底：流里没拿到正文（例如这一轮不是流式、或我们晚接了），**回读落库的那条**——
    // 调用方要的是"平台说了什么"，不该因为我们没接全 delta 就给它一个空串。
    let content = r.content || '';
    if (!content) {
      try {
        const m = await api('/api/conversations/' + cid + '/messages');
        const last = (m.messages || []).filter((x) => x.role === 'assistant').pop();
        if (last) content = String(last.content || '');
      } catch { /* 读不回就算了，下面如实给空 */ }
    }
    return {
      conversation_id: String(cid), created, status: r.status, content,
      run_id: r.runId ? String(r.runId) : null, message_id: r.messageId ? String(r.messageId) : null,
      ...(r.note ? { note: r.note } : {}),
      ...(r.status === 'timeout' ? { hint: '用 rw_status {conversation_id} 查进度' } : {}),
    };
  },
  async status(args) {
    const cid = Number(args.conversation_id);
    if (!cid) throw new Error('conversation_id 必填');
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
    const m = await api('/api/conversations/' + cid + '/messages');
    const all = (m.messages || m.rows || []).slice(-limit);
    return {
      conversation_id: String(cid),
      count: (m.messages || m.rows || []).length,
      messages: all.map((x) => ({ id: String(x.id), role: x.role, content: String(x.content || '').slice(0, 2000), created_at: x.created_at })),
    };
  },
  async exportSession(args) {
    const cid = Number(args.conversation_id);
    if (!cid) throw new Error('conversation_id 必填');
    const j = await api('/api/conversations/' + cid + '/export-full');
    const pack = j.content || {};
    return { filename: j.filename || null, format: pack.format, formatVersion: pack.formatVersion, messages: (pack.messages || []).length, pack };
  },
};

serveStdio({ backend, input: process.stdin, output: process.stdout });
console.error('[mcp-server] rw-platform MCP server 已就绪（stdio，base=' + BASE + '，新建会话权限=' + PERMISSION + '）');
