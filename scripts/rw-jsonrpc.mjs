#!/usr/bin/env node
// scripts/rw-jsonrpc.mjs - 把平台当**通用 JSON-RPC 2.0 服务端**跑起来（stdio），供普通程序/客户内网系统直接调
//
// 为什么有这个脚本（v0.3 §0.4 三级形态的第三级、§7.1 ⑳）：
//   `scripts/rw-mcp-server.mjs` 解决的是"别的 **agent** 把我们当工具调"——方法名与结果形状由 MCP 规范定死
//   （`tools/call` + `content[].text`）。本脚本解决另一半："**别的程序**把我们当 RPC 服务调"——
//   方法名与结果形状由我们自己定（见 `server/jsonrpc.js` 的 `METHODS`），调用方拿到的是结构化结果，
//   不必先把 MCP 的内容块解一遍 JSON。两层共用同一个后端封装思路（登录 / 建会话 / chat SSE / messages / export-full），
//   因为**对外能力只有一份**：`docs/会话API契约-v1.md` §3 的端点表。**本脚本不新造任何能力。**
//
// 用法（stdio；stdout 只走协议帧，日志全在 stderr）：
//   echo '{"jsonrpc":"2.0","id":1,"method":"system.capabilities"}' | node scripts/rw-jsonrpc.mjs
//   echo '{"jsonrpc":"2.0","id":2,"method":"session.chat","params":{"message":"你好"}}' | node scripts/rw-jsonrpc.mjs
//
// 环境变量：
//   RW_JSONRPC_BASE_URL   平台地址（默认 http://127.0.0.1:880）
//   RW_JSONRPC_USER/PASS  调用账号（缺省回落到 RW_ADMIN_USER/RW_ADMIN_PASS；再缺省读运行账户家目录的 .rw-keys.env）
//   RW_JSONRPC_PERMISSION 新建会话的权限（默认 **read**：最小权限；要让它真干活由运维显式提权）
//   RW_JSONRPC_WAIT_SECONDS  session.chat 单次最多等多久（默认 60 秒）
//
// 与 MCP 适配器共用一条**如实**的口径（契约 §4「断连即中止」）：我们等待超时后主动断开 SSE，
// 平台侧会因此**中止本轮**。所以超时的返回值是 `status:'timeout'` + 一句人话说明，**不假装它还在后台跑**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStdioWith, SERVER_NAME, PROTOCOL_VERSION } from '../server/jsonrpc.js';

const BASE = (process.env.RW_JSONRPC_BASE_URL || 'http://127.0.0.1:880').replace(/\/$/, '');
const PERMISSION = process.env.RW_JSONRPC_PERMISSION || 'read';
const DEFAULT_WAIT = Number(process.env.RW_JSONRPC_WAIT_SECONDS || 60);

// 账号：环境变量 → 运行账户家目录的 .rw-keys.env（与 selfcheck/agent-smoke/MCP 适配器同一口径）
function creds() {
  let user = process.env.RW_JSONRPC_USER || process.env.RW_ADMIN_USER || '';
  let pass = process.env.RW_JSONRPC_PASS || process.env.RW_ADMIN_PASS || '';
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
  if (!user || !pass) throw new Error('缺账号：设 RW_JSONRPC_USER/RW_JSONRPC_PASS（或 RW_ADMIN_USER/RW_ADMIN_PASS），或在运行账户家目录放 .rw-keys.env');
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('平台登录失败：' + (j.message || r.status) + '（code=' + (j.code || '-') + '）');
  token = j.token;
}

// 所有调用都过这里：401 时**重新登录一次**再试（token 会过期，而这个进程可能活很久）
async function api(pathname, { method = 'GET', body, headers } = {}) {
  if (!token) await login();
  const call = () => fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(headers || {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let r = await call();
  if (r.status === 401) { token = null; await login(); r = await call(); }
  const j = await r.json().catch(() => ({}));
  // 错误码照实带出来（契约 §5.3）：调用方要能按 code 分流（PARAM_MISSING / CONV_NOT_FOUND / CONCURRENCY_LIMIT …），
  // 而不是去猜 message 里的人话。平台没给 code 的路径（如 /api/chat/stop）就如实不带。
  if (!r.ok) throw new Error('平台返回 ' + r.status + '：' + (j.message || JSON.stringify(j).slice(0, 200)) + (j.code ? '（code=' + j.code + '）' : ''));
  return j;
}

// 跑一轮对话：POST /api/chat 是 SSE，这里按契约 §4 的帧格式解到 done/run_end 为止。
//
// ⚠️ 这里刻意**不**把"读完一帧就 ac.abort()"写在 try 里（`scripts/rw-mcp-server.mjs` 就是那么写的，那是它的
// 一个真缺陷，本轮不动它、只报告）：`for await (const chunk of r.body)` 的 `next()` 在读到 run_end 之后本来就
// 会 resolve 成 `done:true` 并结束循环；而在循环体内 abort ⇒ 那个 `next()` **当场以 AbortError 拒绝**，
// AbortError 落到下面的 catch 里，正好命中"超时"那条分支。
// 后果：**流明明跑完了，调用方却收到 status='timeout'**（内容靠回读落库消息兜回来了，所以不易察觉；
// 2026-09-16 用桩平台实测：一次请求 `status:"timeout"` + `runId:null`，而桩平台发的是 `run_end{status:'saved'}`）。
// 所以：读完立刻停下的做法保留（对端不必等我们），但**先 return 出 try**，让 catch 只接真正的超时/网络故障。
async function chatStream(conversationId, message, waitSeconds, extraHeaders) {
  if (!token) await login();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(5, waitSeconds) * 1000);
  let content = '';
  let done = null; let runEnd = null; let errMsg = null;
  // 读流：正常收尾返回 true；被超时中止返回 false（false 只可能来自 abort，见下 catch）
  const readStream = async (body) => {
    // 帧格式：`[id: <seq>\n]data: <json>\n\n`，另有 `: ping` 保活（契约 §4）
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of body) {
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
      if (runEnd || done) break; // 本轮已结束：跳出即可，不必再等对端关流（更不要 abort，见上）
    }
    return true;
  };
  try {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream', ...(extraHeaders || {}) },
      body: JSON.stringify({ conversationId, content: message }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('平台返回 ' + r.status + '：' + (j.message || '') + (j.code ? '（code=' + j.code + '）' : ''));
    }
    await readStream(r.body);
  } catch (e) {
    // **只有"还没读到本轮结束"的中止才算超时**（读到 done/run_end 之后被 abort 的情形已经不会走到这里）
    if (runEnd || done) throw e;
    if (e.name === 'AbortError' || /aborted/i.test(String(e.message))) {
      return { status: 'timeout', content, note: '等待超时：已停止等待（平台本轮会因断开而中止，契约 §4）。长任务请把 waitSeconds 调大，或改用 session.status 轮询。' };
    }
    throw e;
  } finally { clearTimeout(timer); }
  if (errMsg) throw new Error('平台本轮执行失败：' + errMsg);
  return {
    status: runEnd ? runEnd.status : 'unknown',
    content,
    runId: (runEnd && runEnd.runId) || null,
    messageId: (runEnd && runEnd.messageId) || (done && done.messageId) || null,
    finishReason: (runEnd && runEnd.finishReason) || null,
    usage: (done && done.usage) || null,
    reason: (runEnd && runEnd.reason) || null,
  };
}

// 后端能力：**与 METHODS 同名**（`session.chat` → `backend['session.chat']`），一个方法一个函数，无框架
const backend = {
  // GET /api/health（契约 #1）：握手**如实**反映"平台在不在"——进程活着不代表平台活着（后者要连库）
  async 'system.capabilities'(args, ctx) {
    const h = await api('/api/health');
    return {
      server: SERVER_NAME,
      protocolVersion: PROTOCOL_VERSION,
      platform: { ok: h.ok === true, service: h.service || null, ts: h.ts || null },
      // 方法表从**注册表**出（含每条对应的契约端点）：调用方据此在编码阶段发现方法名写错，
      // 也不必去读我们的文档才知道有哪些方法；手抄一份到这儿就等于多了一个会过期的事实源。
      methods: ctx && ctx.registry ? ctx.registry.face() : [],
    };
  },
  // POST /api/conversations（#5，不给 id 时先建） + POST /api/chat（#6，唯一执行入口）
  async 'session.chat'(args) {
    let cid = args.conversationId ? Number(args.conversationId) : null;
    let created = false;
    if (!cid) {
      const c = await api('/api/conversations', { method: 'POST', body: { title: 'JSON-RPC: ' + String(args.message).slice(0, 40), permission: PERMISSION } });
      cid = c.id; created = true;
    }
    const headers = args.idempotencyKey ? { 'Idempotency-Key': String(args.idempotencyKey) } : null;
    const r = await chatStream(cid, String(args.message), Number(args.waitSeconds) || DEFAULT_WAIT, headers);
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
      conversationId: String(cid), created, status: r.status, content,
      runId: r.runId ? String(r.runId) : null,
      messageId: r.messageId ? String(r.messageId) : null,
      ...(r.finishReason ? { finishReason: r.finishReason } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.usage ? { usage: r.usage } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.status === 'timeout' ? { hint: '用 session.status {conversationId} 查进度' } : {}),
    };
  },
  // POST /api/chat/stop（#7）
  async 'session.stop'(args) {
    const cid = Number(args.conversationId);
    const r = await api('/api/chat/stop', { method: 'POST', body: { conversationId: cid } });
    return { conversationId: String(cid), stopped: r.stopped === true };
  },
  // GET /api/conversations/:id/messages（#9）
  async 'session.status'(args) {
    const cid = Number(args.conversationId);
    // 上限 20 沿用 MCP 适配器的既有口径（工具面与本门面都暴露"最近几条"，多取只会烧掉调用方的上下文）
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
    const m = await api('/api/conversations/' + cid + '/messages');
    const all = m.messages || [];
    return {
      conversationId: String(cid),
      count: all.length,
      messages: all.slice(-limit).map((x) => ({ id: String(x.id), role: x.role, content: String(x.content || '').slice(0, 2000), created_at: x.created_at })),
    };
  },
  // GET /api/conversations/:id/export-full（#11，带 formatVersion 的自描述包）
  async 'session.export'(args) {
    const cid = Number(args.conversationId);
    const j = await api('/api/conversations/' + cid + '/export-full');
    const pack = j.content || {};
    return { filename: j.filename || null, format: pack.format, formatVersion: pack.formatVersion, messages: (pack.messages || []).length, pack };
  },
  // GET /api/conversations/:id/activity?after=（#15，事件环增量轮询）
  async 'session.activity'(args) {
    const cid = Number(args.conversationId);
    const after = Number(args.after) || 0;
    const j = await api('/api/conversations/' + cid + '/activity?after=' + encodeURIComponent(after));
    return { conversationId: String(cid), seq: j.seq, items: j.items || [] };
  },
};

serveStdioWith(backend, { input: process.stdin, output: process.stdout });
console.error('[' + SERVER_NAME + '] 已就绪（stdio JSON-RPC 2.0，base=' + BASE + '，新建会话权限=' + PERMISSION + '）');
