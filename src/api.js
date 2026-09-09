// src/api.js - 前端 API 封装（含 SSE 流式）
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
  models: () => request('/api/models'),
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
  approvals: () => request('/api/approvals'),
  decideApproval: (id, decision) => request('/api/approvals/' + id, { method: 'POST', body: JSON.stringify({ decision }) }),
  asks: () => request('/api/asks'),
  decideAsk: (id, option) => request('/api/asks/' + id, { method: 'POST', body: JSON.stringify({ option }) }),
  stopChat: (conversationId) => request('/api/chat/stop', { method: 'POST', body: JSON.stringify({ conversationId }) }),
  // B1 壳 + ④ 知识库
  shells: () => request('/api/shells'),
  shellGet: (key) => request('/api/shells/' + encodeURIComponent(key)),
  shellExport: (key) => request('/api/shells/' + encodeURIComponent(key) + '/export'),
  shellImport: (pack) => request('/api/shells', { method: 'POST', body: JSON.stringify({ pack }) }),
  shellClone: (key, newKey, name) => request('/api/shells/' + encodeURIComponent(key) + '/clone', { method: 'POST', body: JSON.stringify({ newKey, name }) }),
  shellPatch: (key, patch) => request('/api/shells/' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify(patch) }),
  shellDisable: (key) => request('/api/shells/' + encodeURIComponent(key), { method: 'DELETE' }),
  shellCanary: (key) => request('/api/shells/' + encodeURIComponent(key) + '/canary', { method: 'POST', body: JSON.stringify({}) }),
  // 扩展中心数据（A0 载体；装配向导 step6 与扩展中心页共用）
  extensions: (params) => request('/api/extensions?' + new URLSearchParams(params || {}).toString()),
  extensionRegister: (body) => request('/api/extensions', { method: 'POST', body: JSON.stringify(body) }),
  extensionStatus: (type, key, status) => request('/api/extensions/' + encodeURIComponent(type) + '/' + encodeURIComponent(key) + '/status', { method: 'PATCH', body: JSON.stringify({ status }) }),
  extensionGet: (type, key) => request('/api/extensions/' + encodeURIComponent(type) + '/' + encodeURIComponent(key)),
  shellExtensions: (key) => request('/api/shells/' + encodeURIComponent(key) + '/extensions'),
  setShellExtensions: (key, extensions) => request('/api/shells/' + encodeURIComponent(key) + '/extensions', { method: 'PUT', body: JSON.stringify({ extensions }) }),
  demands: (params) => request('/api/extensions/demands?' + new URLSearchParams(params || {}).toString()),
  demandStatus: (id, status) => request('/api/extensions/demands/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status }) }),
  demandCreate: (key, body) => request('/api/extensions/' + encodeURIComponent(key) + '/demand', { method: 'POST', body: JSON.stringify(body) }),
  skillsList: () => request('/api/skills'),
  knowledgeList: (params) => request('/api/knowledge?' + new URLSearchParams(params || {}).toString()),
  knowledgeImport: (body) => request('/api/knowledge/import', { method: 'POST', body: JSON.stringify(body) }),
  knowledgeDelete: (id) => request('/api/knowledge/' + id, { method: 'DELETE' }),
  // M2 统一后台（§7.2 八板块）
  modelToggle: (id, enabled) => request('/api/models/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  providerTest: (baseUrl, apiKey) => request('/api/providers/test', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) }),
  telemetryDaily: (params) => request('/api/telemetry/daily?' + new URLSearchParams(params || {}).toString()),
  reviewsList: (params) => request('/api/reviews?' + new URLSearchParams(params || {}).toString()),
  reviewsAdd: (conversationId, result, bugReason) => request('/api/reviews', { method: 'POST', body: JSON.stringify({ conversationId, result, bugReason }) }),
  audit: (limit) => request('/api/audit?limit=' + (Number(limit) || 100)),
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
// onDelta / onThinking(round) / onThink(text) / onToolStart / onToolDone / onPlan / onApproval / onDone / onError；signal 可中止
// M1：onIntent / onRoute —— 意图识别与档案路由的灰字回显（系统行，不入历史；§6.1/6.2/§8）
export async function streamChat({ conversationId, content, provider, model }, handlers, signal) {
  const { onDelta, onThinking, onThink, onToolStart, onToolDone, onPlan, onApproval, onAsk, onIntent, onRoute, onDone, onError } = handlers || {};
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
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.type === 'delta') onDelta?.(j.delta);
        else if (j.type === 'thinking') onThinking?.(j.round);
        else if (j.type === 'think') onThink?.(j.text);
        else if (j.type === 'tool_start') onToolStart?.(j.tool);
        else if (j.type === 'tool_done') onToolDone?.(j.tool);
        else if (j.type === 'plan') onPlan?.(j.plan);
        else if (j.type === 'approval') onApproval?.(j);
        else if (j.type === 'ask') onAsk?.(j);
        else if (j.type === 'intent') onIntent?.(j);
        else if (j.type === 'route') onRoute?.(j);
        else if (j.type === 'done') onDone?.(j.usage || {});
        else if (j.type === 'error') onError?.(j.message);
      } catch { /* ignore */ }
    }
  }
}
