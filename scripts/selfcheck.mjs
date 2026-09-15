#!/usr/bin/env node
// scripts/selfcheck.mjs - RW 平台自检脚本（可在服务器上随时重复执行）
// 用法: node scripts/selfcheck.mjs [baseUrl] [username] [password]
// 账号取值顺序：命令行参数 → 环境变量 RW_ADMIN_USER/RW_ADMIN_PASS → 平台目录 .env（config.js 已解析）
//              → 运行账户家目录的 .rw-keys.env（原来是写死的 /root/.rw-keys.env，客户机上不存在）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';

const BASE = process.argv[2] || 'http://127.0.0.1:880';
let user = process.argv[3] || config.admin.user || '';
let pass = process.argv[4] || config.admin.pass || '';
if (!user || !pass) {
  try {
    const env = fs.readFileSync(path.join(os.homedir(), '.rw-keys.env'), 'utf8');
    const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.split('=').slice(1).join('=').trim();
    user = user || get('RW_ADMIN_USER');
    pass = pass || get('RW_ADMIN_PASS');
  } catch { /* 环境不可用时走参数 */ }
}
if (!user || !pass) { console.error('缺账号：传参、设 RW_ADMIN_USER/RW_ADMIN_PASS，或在平台 .env / ' + path.join(os.homedir(), '.rw-keys.env') + ' 里写'); process.exit(2); }

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

// 5b. **受限权限会话也要跑得通**（2026-09-16 加，起因是一个只在 read/write 会话上炸的真 bug）：
// 实测 `/api/chat` 的 run_end 里 `root: permission === 'full' ? RW_FS_ROOT : ws` 中的 `ws` 声明在
// 内层块里、被引用在块外 ⇒ 三元表达式只在**非 full** 时求值到它 ⇒ 每轮 read/write 会话跑完都抛
// `ws is not defined`（full 会话永远看不到，所以之前 12/12 全绿也没发现；MCP server 默认 read 才踩出来）。
// 这条检查把"权限档位"这一轴纳入部署后自检——同一件事在别的档位上是不是也成立，不能靠"默认档位能跑"推断。
let permErr = '';
try {
  const cp = await json(await jreq('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '__selfcheck_write__', permission: 'write' }) }, token));
  let sawDone = false, sawRunEnd = null, sawErr = '';
  const res = await fetch(BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ conversationId: cp.id, content: '回答一个字：好' }),
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
      if (j.type === 'done') sawDone = true;
      if (j.type === 'run_end') sawRunEnd = j.status;
      if (j.type === 'error') sawErr = j.message;
    }
  }
  await jreq('/api/conversations/' + cp.id, { method: 'DELETE' }, token);
  permErr = sawErr || (sawRunEnd ? '' : '没有收到 run_end（这一轮的收尾抛错了？）');
  step('write 权限会话也能跑完一轮', sawDone && sawRunEnd === 'saved', 'done=' + sawDone + ' run_end=' + (sawRunEnd || '-') + (sawErr ? ' err=' + sawErr : ''));
} catch (e) { step('write 权限会话也能跑完一轮', false, e.message); }

// 6. 清理
const d = await jreq('/api/conversations/' + c1.id, { method: 'DELETE' }, token);
step('delete conversation', d.ok === true);

console.log('\n=== ' + ok.length + ' passed, ' + fail.length + ' failed ===');
process.exit(fail.length ? 1 : 0);
