#!/usr/bin/env node
// scripts/selfcheck.mjs - RW 平台自检脚本（可在服务器上随时重复执行）
// 用法: node scripts/selfcheck.mjs [baseUrl] [username] [password]
// 默认 http://127.0.0.1:880 ，账号优先取 RW_ADMIN_USER/RW_ADMIN_PASS 环境变量或 /root/.rw-keys.env
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:880';
let user = process.argv[3];
let pass = process.argv[4];
if (!user || !pass) {
  try {
    const env = fs.readFileSync('/root/.rw-keys.env', 'utf8');
    const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.split('=').slice(1).join('=').trim();
    user = user || get('RW_ADMIN_USER');
    pass = pass || get('RW_ADMIN_PASS');
  } catch { /* 环境不可用时走参数 */ }
}
if (!user || !pass) { console.error('缺账号：传参或设 RW_ADMIN_USER/RW_ADMIN_PASS'); process.exit(2); }

const ok = [];
const fail = [];
const step = (name, cond, extra = '') => {
  (cond ? ok : fail).push(name);
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
};
const json = (r) => r.json().catch(() => ({}));
const jreq = (path, opts = {}, token) => fetch(BASE + path, {
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...opts,
});

// 1. 健康
const h = await json(await jreq('/api/health'));
step('health endpoint', h.ok === true && h.service === 'rw');

// 2. 登录
const lg = await json(await jreq('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: pass }) }));
const token = lg.token;
step('login', Boolean(token));

// 3. 基础 API
for (const p of ['/api/models', '/api/providers', '/api/toolset', '/api/settings', '/api/tasks', '/api/approvals', '/api/market/list']) {
  const r = await json(await jreq(p, {}, token));
  step('GET ' + p, r.ok === true);
}

// 4. 会话增删
const c1 = await json(await jreq('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '__selfcheck__' }) }, token));
step('create conversation', Boolean(c1.id));

// 5. 普通对话 SSE（真实 LLM，需模型可达）
// ⚠️ 帧解析注意：`part.split('\n').find(...)` 在加了 `id: <seq>` 行之后仍然有效（data 行在其后，find 会找到它）；
//    但下面的 buf 每轮重新整体 split 会**重复计数**已处理的帧，故 deltaCount 只当"有没有 delta"用，
//    不作精确条数（要精确请用 src/eventstream.js 的 parseSse）。
let deltaCount = 0, doneFlag = false, errMsg = '';
try {
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ conversationId: c1.id, content: '回答一个字：好' }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const part of buf.split('\n\n')) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let j = null;
      try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (j.type === 'delta') deltaCount++;
      if (j.type === 'done') doneFlag = true;
      if (j.type === 'error') errMsg = j.message;
    }
  }
} catch (e) { errMsg = e.message; }
// 原先第三个参数写的是未定义的 `result` → 这行必抛 ReferenceError，被上面 catch 吞成 errMsg，
// 于是"流明明正常"也永远报 ❌（12/12 与 11/12 的差别就来自这里）。改成真实诊断信息。
step('plain chat SSE streaming', deltaCount > 0 && doneFlag, errMsg || ('deltas=' + deltaCount + ' done=' + doneFlag));

// 6. 清理
const d = await jreq('/api/conversations/' + c1.id, { method: 'DELETE' }, token);
step('delete conversation', d.ok === true);

console.log('\n=== ' + ok.length + ' passed, ' + fail.length + ' failed ===');
process.exit(fail.length ? 1 : 0);
