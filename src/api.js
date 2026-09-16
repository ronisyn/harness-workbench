// src/api.js - 前端 API 封装（含 SSE 流式）
// 2026-09-18：流式那一半接到 `src/eventstream.js`（RA-37 客户端重建器）——判别/重建只有那一份实现。
import { applyEvent, createRunView, lastSeq, parseSse, resumeDecision } from './eventstream.js';
const TOKEN_KEY = 'rw_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}), ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    // note=服务端排障字段（如 providers/test 的鉴权失败/无法连通原因）；并入错误信息避免被吞
    const err = new Error(data.message || data.note || `请求失败 (${res.status})`);
    err.status = res.status; err.note = data.note || '';
    throw err;
  }
  return data;
}

export const api = {
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  providers: () => request('/api/providers'),
  conversations: () => request('/api/conversations'),
  createConversation: (title, permission) => request('/api/conversations', { method: 'POST', body: JSON.stringify({ title, permission }) }),
  patchConversation: (id, patch) => request('/api/conversations/' + id, { method: 'PATCH', body: JSON.stringify(patch) }),
  autoTitle: (id, force) => request('/api/conversations/' + id + '/autotitle', { method: 'POST', body: JSON.stringify({ force: !!force }) }),
  deleteConversation: (id) => request('/api/conversations/' + id, { method: 'DELETE' }),
  messages: (id) => request('/api/conversations/' + id + '/messages'),
  toolcalls: (id) => request('/api/conversations/' + id + '/toolcalls'),
  activity: (id, after) => request('/api/conversations/' + id + '/activity?after=' + (Number(after) || 0)),
  getToolset: () => request('/api/toolset'),
  setToolset: (enabled) => request('/api/toolset', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  getToolUsage: () => request('/api/toolusage'),
  getRules: () => request('/api/access-rules'),
  saveRules: (rules) => request('/api/access-rules', { method: 'PUT', body: JSON.stringify({ rules }) }),
  proposals: () => request('/api/proposals'),
  proposalContent: (file) => request('/api/proposals/' + encodeURIComponent(file)),
  createProposal: (title, content) => request('/api/proposals', { method: 'POST', body: JSON.stringify({ title, content }) }),
  mcpStatus: () => request('/api/mcp'),
  mcpReload: () => request('/api/mcp/reload', { method: 'POST' }),
  usageStats: (conversationId) => request('/api/usage/stats' + (conversationId ? '?conversationId=' + conversationId : '')),
  cacheHitSummary: () => request('/api/cache-hit/summary'),
  marketList: () => request('/api/market/list'),
  marketRefresh: () => request('/api/market/refresh', { method: 'POST' }),
  marketConnect: (source, modelIds) => request('/api/market/connect', { method: 'POST', body: JSON.stringify({ source, modelIds }) }),
  upload: (name, base64) => request('/api/upload', { method: 'POST', body: JSON.stringify({ name, data: base64 }) }),
  getFile: (path) => request('/api/file?path=' + encodeURIComponent(path)),
  getSettings: () => request('/api/settings'),
  setSettings: (updates) => request('/api/settings', { method: 'PUT', body: JSON.stringify({ updates }) }),
  tasks: () => request('/api/tasks'),
  createTask: (t) => request('/api/tasks', { method: 'POST', body: JSON.stringify(t) }),
  patchTask: (id, p) => request('/api/tasks/' + id, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteTask: (id) => request('/api/tasks/' + id, { method: 'DELETE' }),
  runTaskOnce: (id) => request('/api/tasks/' + id + '/run', { method: 'POST', body: JSON.stringify({}) }),
  taskHistory: (id, limit) => request('/api/tasks/' + id + '/history?limit=' + (Number(limit) || 20)),
  taskAlerts: () => request('/api/tasks/alerts'),
  // A7 进化集
  evoSummary: () => request('/api/evo/summary'),
  evoGoals: () => request('/api/evo/goals'),
  evoGoalCreate: (g) => request('/api/evo/goals', { method: 'POST', body: JSON.stringify(g) }),
  evoGoalPatch: (id, p) => request('/api/evo/goals/' + id, { method: 'PATCH', body: JSON.stringify(p) }),
  evoGoalDelete: (id) => request('/api/evo/goals/' + id, { method: 'DELETE' }),
  evoGoalBind: (id, taskIds) => request('/api/evo/goals/' + id + '/tasks', { method: 'PUT', body: JSON.stringify({ taskIds }) }),
  evoMemos: () => request('/api/evo/memos'),
  evoMemoCreate: (content) => request('/api/evo/memos', { method: 'POST', body: JSON.stringify({ content }) }),
  evoMemoPatch: (id, p) => request('/api/evo/memos/' + id, { method: 'PATCH', body: JSON.stringify(p) }),
  evoMemoDelete: (id) => request('/api/evo/memos/' + id, { method: 'DELETE' }),
  approvals: () => request('/api/approvals'),
  decideApproval: (id, decision) => request('/api/approvals/' + id, { method: 'POST', body: JSON.stringify({ decision }) }),
  asks: () => request('/api/asks'),
  decideAsk: (id, option) => request('/api/asks/' + id, { method: 'POST', body: JSON.stringify({ option }) }),
  stopChat: (conversationId) => request('/api/chat/stop', { method: 'POST', body: JSON.stringify({ conversationId }) }),
  // B1 壳 + ④ 知识库
  shells: () => request('/api/shells'),
  shellTemplates: () => request('/api/shell-templates'),
  shellGet: (key) => request('/api/shells/' + encodeURIComponent(key)),
  shellExport: (key) => request('/api/shells/' + encodeURIComponent(key) + '/export'),
  shellImport: (pack) => request('/api/shells', { method: 'POST', body: JSON.stringify({ pack }) }),
  shellClone: (key, newKey, name) => request('/api/shells/' + encodeURIComponent(key) + '/clone', { method: 'POST', body: JSON.stringify({ newKey, name }) }),
  shellPatch: (key, patch) => request('/api/shells/' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify(patch) }),
  shellDisable: (key) => request('/api/shells/' + encodeURIComponent(key), { method: 'DELETE' }),
  shellCanary: (key) => request('/api/shells/' + encodeURIComponent(key) + '/canary', { method: 'POST', body: JSON.stringify({}) }),
  // 扩展中心数据（A0/A3：插件/MCP/应用 统一资产 + 需求闭环 + 指标 v1 两层 + MCP 资产化）
  extensions: (params) => request('/api/extensions?' + new URLSearchParams(params || {}).toString()),
  extensionRegister: (body) => request('/api/extensions', { method: 'POST', body: JSON.stringify(body) }),
  extensionStatus: (type, key, status) => request('/api/extensions/' + encodeURIComponent(type) + '/' + encodeURIComponent(key) + '/status', { method: 'PATCH', body: JSON.stringify({ status }) }),
  extensionGet: (type, key) => request('/api/extensions/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)),
  extensionMetrics: (params) => request('/api/extensions/metrics?' + new URLSearchParams(params || {}).toString()),
  extensionMcpSync: () => request('/api/extensions/mcp-sync', { method: 'POST', body: JSON.stringify({}) }),
  shellExtensions: (key) => request('/api/shells/' + encodeURIComponent(key) + '/extensions'),
  setShellExtensions: (key, extensions) => request('/api/shells/' + encodeURIComponent(key) + '/extensions', { method: 'PUT', body: JSON.stringify({ extensions }) }),
  demands: (params) => request('/api/extensions/demands?' + new URLSearchParams(params || {}).toString()),
  demandStatus: (id, status) => request('/api/extensions/demands/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status }) }),
  demandCreate: (key, body) => request('/api/extensions/' + encodeURIComponent(key) + '/demand', { method: 'POST', body: JSON.stringify(body) }),
  skillsList: () => request('/api/skills'),
  skillGet: (name) => request('/api/skills/' + encodeURIComponent(name)),
  skillSave: (name, content) => request('/api/skills/' + encodeURIComponent(name), { method: 'POST', body: JSON.stringify({ content }) }),
  skillPatch: (name, patch) => request('/api/skills/' + encodeURIComponent(name), { method: 'PATCH', body: JSON.stringify(patch) }),
  skillDelete: (name) => request('/api/skills/' + encodeURIComponent(name), { method: 'DELETE' }),
  skillSmoke: (name) => request('/api/skills/' + encodeURIComponent(name) + '/smoke', { method: 'POST', body: JSON.stringify({}) }),
  knowledgeList: (params) => request('/api/knowledge?' + new URLSearchParams(params || {}).toString()),
  knowledgeImport: (body) => request('/api/knowledge/import', { method: 'POST', body: JSON.stringify(body) }),
  knowledgeDelete: (id) => request('/api/knowledge/' + id, { method: 'DELETE' }),
  knowledgePatch: (id, patch) => request('/api/knowledge/' + id, { method: 'PATCH', body: JSON.stringify(patch) }),
  // M2/A 系列统一后台（console 各板块 API）
  modelToggle: (id, enabled) => request('/api/models/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  defaultModels: () => request('/api/default-models'),
  setDefaultModels: (defaults) => request('/api/default-models', { method: 'PUT', body: JSON.stringify({ defaults }) }),
  shellModelOverview: () => request('/api/shells/model-overview'),
  providerTest: (baseUrl, apiKey) => request('/api/providers/test', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }),
  telemetryDaily: (params) => request('/api/telemetry/daily?' + new URLSearchParams(params || {}).toString()),
  reviewsList: (params) => request('/api/reviews?' + new URLSearchParams(params || {}).toString()),
  reviewsAdd: (conversationId, result, bugReason, difficulty) => request('/api/reviews', { method: 'POST', body: JSON.stringify({ conversationId, result, bugReason, difficulty }) }),
  audit: (limit) => request('/api/audit?limit=' + (Number(limit) || 100)),
  auditQuery: (params) => request('/api/audit?' + new URLSearchParams(params || {}).toString()),
  auditArchiveStats: () => request('/api/audit/archive-stats'),
  auditArchive: (days) => request('/api/audit/archive', { method: 'POST', body: JSON.stringify({ days: Number(days) || 90 }) }),
  convTrace: (id) => request('/api/conversations/' + id + '/trace'),
  // ⑥ 任务模板库
  templates: () => request('/api/templates'),
  templateGet: (key) => request('/api/templates/' + encodeURIComponent(key)),
  templateExport: async (key) => { const res = await fetch('/api/templates/' + encodeURIComponent(key) + '/export', { headers: { Authorization: 'Bearer ' + getToken() } }); if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.message || '导出失败'); } return res.text(); },
  templateImport: (template) => request('/api/templates/import', { method: 'POST', body: JSON.stringify({ template }) }),
  templateClone: (key, newKey, name) => request('/api/templates/' + encodeURIComponent(key) + '/clone', { method: 'POST', body: JSON.stringify({ newKey, name }) }),
  templatePrompt: (key, goal) => request('/api/templates/' + encodeURIComponent(key) + '/prompt', { method: 'POST', body: JSON.stringify({ goal }) }),
  templateApply: (key, shellKey) => request('/api/templates/' + encodeURIComponent(key) + '/apply', { method: 'POST', body: JSON.stringify({ shellKey }) }),
  // D9 应用形态
  apps: () => request('/api/apps'),
  appGet: (key) => request('/api/apps/' + encodeURIComponent(key)),
  appLaunch: (key, body) => request('/api/apps/' + encodeURIComponent(key) + '/launch', { method: 'POST', body: JSON.stringify(body || {}) }),
};

// SSE 流式对话（带轨迹流式回调）：
// onDelta / onThinking(round) / onThink(text) / onToolStart / onToolDone / onPlan / onProgress / onApproval / onDone / onError；signal 可中止
// M1：onIntent / onRoute —— 意图识别与档案路由的灰字回显（系统行，不入历史；§6.1/6.2/§8）
// 2026-09-17：onProgress —— 进度帧 `{type:'progress', round, roundCap, plan}`（v0.3 §4.7「可观测…进度…逐步可见」）；
//   另：`tool_done` 的 tool 上可能多一个**只增**字段 `spill`（真的发生了溢出时才有，见 src/Chat.jsx 的展示）。
// 2026-09-18（裁定 B 落地）：**判别与重建交给 `src/eventstream.js`**（RA-37 的客户端重建器），
//   本函数不再自己 `JSON.parse` + 一长串 if/else —— 那正是"契约写了一份、客户端另实现一份"的老毛病：
//   契约新增事件时，重建器认得、这个 switch 不认得，于是界面上表现为"事件丢了"而没有任何报错。
//   现在：帧 → `applyEvent` 进视图 → **由视图的字段变化驱动回调**（回调面与改造前逐字一致，UI 不用改）。
//   同时补上 RA-37 G5「断线重连不丢现场」：POST 流**没收到收段帧就断了**（网络抖动/服务重启）时，
//   自动按 `Last-Event-ID` 续订；只有开播帧如实说 `gap:true`（环已回收）才回落 /messages 拉全量，
//   回落通过 `handlers.onReload?.(conversationId)` 交给界面（界面本来就有 loadMessages）。
export async function streamChat({ conversationId, content, provider, model }, handlers, signal) {
  const h = handlers || {};
  const { onDelta, onThinking, onThink, onToolStart, onToolDone, onPlan, onProgress, onApproval, onAsk, onIntent, onRoute, onDone, onError } = h;
  let view = createRunView();
  // 一帧 → 视图 → 回调。返回新视图（重建器是纯函数，这里只负责"哪一格变了就叫哪个回调"）。
  const consume = (ev, prev) => {
    const next = applyEvent(prev, ev);
    switch (ev.type) {
      case 'delta': onDelta?.(String(ev.delta ?? '')); break;
      case 'thinking': onThinking?.(ev.round); break;
      case 'think': onThink?.(ev.text); break;
      case 'tool_start': onToolStart?.(ev.tool); break;
      case 'tool_done': onToolDone?.(ev.tool); break;
      case 'plan': onPlan?.(ev.plan); break;
      case 'progress': onProgress?.(ev); break;
      case 'approval': onApproval?.(ev); break;
      case 'ask': onAsk?.(ev); break;
      case 'intent': onIntent?.(ev); break;
      case 'route': onRoute?.(ev); break;
      case 'done': onDone?.(ev.usage || {}); break;
      case 'error': onError?.(ev.message); break;
      default: break;   // 其余（run_start/stream_hello/stream_end/prefix_face…）只进视图，不改界面
    }
    return next;
  };
  // 读一条 SSE 流：按 chunk 增量切帧（传输层的事），切出来的每帧交给重建器（语义层的事）。
  // `stopAtGap`：续订时**只看开播帧**——服务端如实说"你要的下一条已被环回收"就立刻停，
  // 把后续那半截（从环里还能捞到的、不连续的事件）**丢掉**：把它接到本地不完整的视图上，
  // 拼出来的正文就是错的，而错得看不出来（这正是"断线重连不丢现场"要防的）。
  const pump = async (body, { stopAtGap = false } = {}) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const feed = async (text) => {
      const parts = text.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        for (const ev of parseSse(part)) {
          view = consume(ev, view);
          if (stopAtGap && ev.type === 'stream_hello' && resumeDecision(view) === 'reload') {
            try { await reader.cancel(); } catch { /* 取消失败不影响结论 */ }
            return 'reload';
          }
        }
      }
      return null;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const stop = await feed(buf);
      if (stop) return stop;
    }
    if (buf.trim()) await feed(buf + '\n\n');
    return 'end';
  };
  const terminal = () => ['done', 'stopped', 'error'].includes(view.status) || view.contentLength !== null;
  // 续订（GET /api/conversations/:id/stream）：带标准头 Last-Event-ID，从视图的游标接着要
  const resumeOnce = async () => {
    const res2 = await fetch('/api/conversations/' + conversationId + '/stream', {
      headers: { Authorization: 'Bearer ' + getToken(), 'Last-Event-ID': String(lastSeq(view)) },
      signal,
    });
    if (!res2.ok || !res2.body) throw new Error('续订失败（HTTP ' + res2.status + '）');
    return pump(res2.body, { stopAtGap: true });
  };
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ conversationId, content, provider, model }),
    signal,
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.message || '对话失败');
  }
  await pump(res.body);
  // 传输断了但这一轮**没有收段** ⇒ 现场还在服务端（事件环里），按序号续订，不重新发一遍问题
  if (!terminal() && !(signal && signal.aborted)) {
    const how = await resumeOnce();
    if (how === 'reload') {
      // 服务端如实说了"你要的下一条已经被环回收"：本地这份重建不完整，交给界面回落 /messages 拉全量
      h.onReload?.(conversationId);
    } else if (!terminal()) {
      onError?.('连接中断，已按序号续订仍未收段（现场见 /messages）');
    }
  }
  return view;
}
