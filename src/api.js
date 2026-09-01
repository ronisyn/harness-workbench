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
  if (!res.ok || data.ok === false) throw new Error(data.message || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  models: () => request('/api/models'),
  conversations: () => request('/api/conversations'),
  createConversation: (title, permission) => request('/api/conversations', { method: 'POST', body: JSON.stringify({ title, permission }) }),
  patchConversation: (id, patch) => request('/api/conversations/' + id, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteConversation: (id) => request('/api/conversations/' + id, { method: 'DELETE' }),
  messages: (id) => request('/api/conversations/' + id + '/messages'),
  capabilities: () => request('/api/capabilities'),
  setCapabilities: (updates) => request('/api/capabilities', { method: 'PUT', body: JSON.stringify({ updates }) }),
  usageStats: (conversationId) => request('/api/usage/stats' + (conversationId ? '?conversationId=' + conversationId : '')),
};

// SSE 流式对话：onDelta(增量), onDone, onError
export async function streamChat({ conversationId, content, provider, model }, onDelta, onDone, onError) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: JSON.stringify({ conversationId, content, provider, model }),
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
        if (j.type === 'delta') onDelta(j.delta);
        else if (j.type === 'done') onDone(j.usage || {});
        else if (j.type === 'error') onError(j.message);
      } catch { /* ignore */ }
    }
  }
}
