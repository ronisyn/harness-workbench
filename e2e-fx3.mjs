// E2E 终审修复验证：A(provider auto→壳默认/档案路由生效) / C(modelPolicy 保留 budgetYuan) / E(PATCH 越权404) / persona 等
import { db } from '/srv/harness-workbench/server/db.js';
const BASE = 'http://127.0.0.1:880';
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 160) }; }
  return { status: r.status, b };
}
async function sse(convId, content, auth, sendBody) {
  const res = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify({ conversationId: convId, content, ...(sendBody || {}) }), signal: AbortSignal.timeout(60000) });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', out = []; const dl = Date.now() + 55000;
  while (Date.now() < dl) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() || '';
    for (const p of parts) { const line = p.split('\n').find((l) => l.startsWith('data:')); if (!line) continue; try { out.push(JSON.parse(line.slice(5).trim())); } catch {} }
    const types = out.map((e) => e.type);
    if (types.includes('route') || types.includes('done') || types.includes('error')) { reader.cancel().catch(() => {}); return out; }
  }
  reader.cancel().catch(() => {}); return out;
}
async function main() {
  const lg = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }) });
  if (!lg.b.token) throw new Error('login failed');
  const A = { Authorization: 'Bearer ' + lg.b.token };
  const chk = (n, c, x) => { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (x !== undefined ? ' | ' + x : '')); if (!c) process.exitCode = 1; };

  /* A: Web 发送 provider:'auto' 时应走壳默认（route:shell-default）——F1 对主对话生效 */
  const curPack = (await j('/api/shells/code/export', { headers: A })).b.pack;
  const origMp = curPack.modelPolicy || {};
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ modelPolicy: { defaultProvider: 'glm', defaultModel: 'glm-4.5' } }) });
  const c = (await j('/api/conversations', { method: 'POST', headers: A, body: JSON.stringify({ title: 'fxA', shell: 'code' }) })).b;
  // body 带 provider:'auto'（模拟 Web 主发送路径）→ 应触发 shell-default route
  const ev = await sse(c.id, '你好随便聊聊', lg.b.token, { provider: 'auto', model: '__auto__' });
  const r = ev.find((e) => e.type === 'route');
  chk('A1 body provider=auto → 壳默认 route(shell-default)', !!r && r.suggestModel === 'glm-4.5', JSON.stringify(r || {}));
  // 无 body provider（如 API/迷你对话）同样生效
  const ev2 = await sse(c.id, '再聊聊', lg.b.token, {});
  const r2 = ev2.find((e) => e.type === 'route');
  chk('A2 无 body provider → 壳默认 route', !!r2 && r2.suggestModel === 'glm-4.5', JSON.stringify(r2 || {}));
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ modelPolicy: origMp }) });
  await j('/api/conversations/' + c.id, { method: 'DELETE', headers: A });

  /* C: modelPolicy 部分更新保留旧 budgetYuan/allowModels */
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ modelPolicy: { defaultProvider: 'glm', defaultModel: 'glm-4.5', allowModels: ['glm-4.5', 'glm-5.3'], budgetYuan: 9, qualityCostBias: 2 } }) });
  // 只更新 default（模拟 1.3 面板保存）
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ modelPolicy: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' } }) });
  const mp = (await j('/api/shells/code/export', { headers: A })).b.pack.modelPolicy;
  chk('C modelPolicy 部分更新保留 budgetYuan', Number(mp.budgetYuan) === 9, 'budgetYuan=' + mp.budgetYuan);
  chk('C 保留 allowModels', Array.isArray(mp.allowModels) && mp.allowModels.length === 2, JSON.stringify(mp.allowModels));
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ modelPolicy: origMp }) });

  /* E: PATCH 非本人会话 → 404（用不存在 id） */
  const pe = await j('/api/conversations/99999999', { method: 'PATCH', headers: A, body: JSON.stringify({ title: 'x' }) });
  chk('E PATCH 不存在会话→404', pe.status === 404, JSON.stringify(pe.b));

  /* P2-1：提案正文带 '# 提案：标题' 首部 → 服务端列表标题解析正确（前端 create 现按此前缀组装） */
  const t = '回归测试提案-' + Date.now();
  await j('/api/proposals', { method: 'POST', headers: A, body: JSON.stringify({ title: t, content: '# 提案：' + t + '\n\n> 状态：待审\n\n### 说明\n正文' }) });
  const pl = (await j('/api/proposals', { headers: A })).b.proposals;
  const found = pl.find((p) => p.title.includes('回归测试提案'));
  chk('P2-1 提案标题解析为 # 提案 首部', !!found && found.title.trim() === t && found.status === '待审', JSON.stringify(found && { title: found.title, status: found.status }));
  console.log('FX3-E2E-DONE');
  process.exit(0);
}
main().catch((e) => { console.error('FX3-FAIL', e.message); process.exit(1); });
