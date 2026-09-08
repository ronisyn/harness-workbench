// E2E FINAL-REGRESSION 今日全部任务最终态：核心链路+各批次数据面往返+孤儿
import { db } from '/srv/harness-workbench/server/db.js';
import xlsx from '/srv/harness-workbench/node_modules/xlsx/xlsx.js';
import { kbVisibleWhere } from '/srv/harness-workbench/server/knowledge.js';
const BASE = 'http://127.0.0.1:880';
const P = 'fin-';
let PASS = 0, FAIL = 0;
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 160) }; }
  return { status: r.status, b };
}
function chk(n, c, x) { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (x !== undefined ? ' | ' + x : '')); if (c) PASS++; else FAIL++; }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
async function sse(convId, content, tok, waitDone) {
  const res = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ conversationId: convId, content }), signal: AbortSignal.timeout(60000) });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '', out = [], intentAt = 0; const dl = Date.now() + 55000;
  while (Date.now() < dl) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n'); buf = parts.pop() || '';
    for (const p of parts) { const line = p.split('\n').find((l) => l.startsWith('data:')); if (!line) continue; try { out.push(JSON.parse(line.slice(5).trim())); } catch {} }
    const types = out.map((e) => e.type);
    if (types.includes('route') || types.includes('error')) { reader.cancel().catch(() => {}); return out; }
    if (types.includes('done')) { reader.cancel().catch(() => {}); return out; }
    if (types.includes('intent') && !intentAt) intentAt = Date.now();
    if (!waitDone && intentAt && Date.now() - intentAt > 2000) { reader.cancel().catch(() => {}); return out; }
  }
  reader.cancel().catch(() => {}); return out;
}
async function main() {
  const lg = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }) });
  if (!lg.b.token) throw new Error('login failed');
  const tok = lg.b.token; const A = { Authorization: 'Bearer ' + tok };
  const mk = async (t, e) => { const c = (await j('/api/conversations', { method: 'POST', headers: A, body: JSON.stringify({ title: t, ...e }) })).b; return c; };
  const cleanup = [];
  const cA = await mk(P + 'A', {}); cleanup.push(cA.id);
  const cB = await mk(P + 'B', { shell: 'code' }); cleanup.push(cB.id);
  const cC = await mk(P + 'C', { shell: 'code', provider: 'glm', model: 'glm-4.5' }); cleanup.push(cC.id);

  /* 1) R1/R2/R5 涉及的 API 往返（shared 组件的数据源） */
  const caps0 = (await j('/api/capabilities', { headers: A })).b.list || [];
  const capOne = caps0.find((c) => c.key === 'c_cap_5');
  if (capOne) { await j('/api/capabilities', { method: 'PUT', headers: A, body: JSON.stringify({ updates: { [capOne.key]: !capOne.enabled } }) }); const m = (await j('/api/capabilities', { headers: A })).b.list.find((c) => c.key === capOne.key); chk('1 capabilities 往返', m.enabled === !capOne.enabled); await j('/api/capabilities', { method: 'PUT', headers: A, body: JSON.stringify({ updates: { [capOne.key]: capOne.enabled } }) }); }
  const ts0 = (await j('/api/toolset', { headers: A })).b.tools || [];
  const en0 = ts0.filter((t) => t.enabled).map((t) => t.name);
  const putT = await j('/api/toolset', { method: 'PUT', headers: A, body: JSON.stringify({ enabled: en0 }) });
  chk('2 toolset 幂等写回', putT.status === 200 && (await j('/api/toolset', { headers: A })).b.tools.filter((t) => t.enabled).length === en0.length);
  const rules0 = (await j('/api/access-rules', { headers: A })).b.rules || [];
  const putR = await j('/api/access-rules', { method: 'PUT', headers: A, body: JSON.stringify({ rules: rules0 }) });
  chk('3 access-rules 写回', putR.status === 200, JSON.stringify(putR.b).slice(0, 40));
  const pr = await j('/api/proposals', { headers: A });
  chk('4 proposals 读(对象数组)', pr.status === 200 && Array.isArray(pr.b.proposals) && pr.b.proposals.every((x) => typeof x === 'object' && x.file), 'n=' + (pr.b.proposals || []).length);
  const s0 = (await j('/api/settings', { headers: A })).b.settings;
  await j('/api/settings', { method: 'PUT', headers: A, body: JSON.stringify({ updates: { temperature: 0.6 } }) });
  const s1 = (await j('/api/settings', { headers: A })).b.settings;
  chk('5 settings 温度往返', Number(s1.temperature) === 0.6);
  await j('/api/settings', { method: 'PUT', headers: A, body: JSON.stringify({ updates: { temperature: s0.temperature } }) });

  /* 2) 会话删除级联 contract_events + 无 bg_tasks 报错 */
  const cX = await mk(P + 'X', {});
  const tc = await db.query('INSERT INTO task_contracts (account_id, title, goal, conv_id, status) VALUES (?,?,?,?,?)', [lg.b.user.id, P + 'ct', 'g', cX.id, 'queued']);
  await db.query('INSERT INTO contract_events (contract_id, kind, detail) VALUES (?,?,?)', [tc.insertId, 'start', P + 'e']);
  const delX = await j('/api/conversations/' + cX.id, { method: 'DELETE', headers: A });
  const orphanCe = (await db.query('SELECT COUNT(*) c FROM contract_events WHERE detail LIKE ?', [P + '%']))[0].c;
  chk('6 删会话级联清 contract_events', delX.status === 200 && orphanCe === 0, 'orphan=' + orphanCe);

  /* 3) persona JSON patch 往返 */
  const oldP = (await j('/api/shells/code', { headers: A })).b.shell.persona;
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ persona: '回归中文人格' }) });
  const g1 = (await j('/api/shells/code', { headers: A })).b.shell.persona;
  chk('7 persona JSON patch 中文', g1 === '回归中文人格' || (typeof g1 === 'string' && g1.includes('回归')), JSON.stringify(g1));
  await j('/api/shells/code', { method: 'PATCH', headers: A, body: JSON.stringify({ persona: oldP || null }) });

  /* 4) B3 路由/壳默认/C4：shell-default 仅无显式且档案未命中；点名档案→route；显式→无 route */
  const ev1 = await sse(cB.id, '按 small-fix 档案处理一个简单问题', tok);
  const r1 = ev1.find((e) => e.type === 'route');
  chk('8 点名档案 route(small-fix)', !!r1 && r1.profile === 'small-fix', JSON.stringify(r1 || {}));
  const ev2 = await sse(cC.id, '按 small-fix 档案处理', tok);
  chk('9 显式模型锁: 点名档案无 route', !ev2.find((e) => e.type === 'route'), JSON.stringify(ev2.find((e) => e.type === 'route') || {}));

  /* 5) ④ 知识 scope 可见性 + ⑤ telemetry + reviews */
  const gk = await j('/api/knowledge/import', { method: 'POST', headers: A, body: JSON.stringify({ name: P + 'g.txt', data: b64(P + '全局条目'), scope: 'global' }) });
  chk('10 kb import global', gk.status === 200 && gk.b.inserted === 1);
  const sk = await j('/api/knowledge/import', { method: 'POST', headers: A, body: JSON.stringify({ name: P + 's.txt', data: b64(P + '壳私有'), scope: 'shell', shellKey: 'code' }) });
  chk('11 kb import shell', sk.status === 200 && sk.b.inserted === 1);
  const qC = kbVisibleWhere({ accountId: lg.b.user.id, shellId: cB.shellId, conversationId: cB.id });
  const rC = await db.query('SELECT scope FROM knowledge WHERE ' + qC.where + ' AND title LIKE ?', [...qC.params, P + '%']);
  chk('12 code 壳会话见 shell 私有', rC.some((x) => x.scope === 'shell'));
  const qA = kbVisibleWhere({ accountId: lg.b.user.id, conversationId: cA.id });
  const rA = await db.query('SELECT scope FROM knowledge WHERE ' + qA.where + ' AND title LIKE ?', [...qA.params, P + '%']);
  chk('13 无壳仅 global', rA.length > 0 && !rA.some((x) => x.scope === 'shell'));
  // telemetry
  await sse(cA.id, '你好', tok, true);
  await new Promise((r) => setTimeout(r, 1500));
  const tel = await db.query('SELECT COUNT(*) c FROM model_telemetry WHERE conversation_id=?', [cA.id]);
  chk('14 telemetry 落表', tel[0].c >= 1, 'n=' + tel[0].c);
  const rv1 = await j('/api/reviews', { method: 'POST', headers: A, body: JSON.stringify({ conversationId: cA.id, result: 'pass' }) });
  chk('15 reviews 写', rv1.status === 200);

  /* 6) 灰字事件 intent */
  const ev3 = await sse(cA.id, 'RW 部署目录？', tok);
  chk('16 问答含 intent 事件', ev3.some((e) => e.type === 'intent'), (ev3 || []).map((e) => e.type).join(','));
  /* 7) 模型启停（勿动默认，还原） */
  const prov = (await j('/api/providers', { headers: A })).b.providers || [];
  const ds = prov.find((p) => p.provider_key === 'deepseek');
  const tgt = (ds.models || []).find((m) => !['deepseek-v4-flash', 'deepseek-chat'].includes(m.model_id)) || (ds.models || [])[0];
  if (tgt) { const oe = Boolean(tgt.enabled); await j('/api/models/' + tgt.id, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: !oe }) }); const row = (await db.query('SELECT enabled FROM models WHERE id=?', [tgt.id]))[0]; chk('17 models 启停', Boolean(row.enabled) === !oe); await j('/api/models/' + tgt.id, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: oe }) }); }

  /* 清理 */
  for (const id of cleanup) await j('/api/conversations/' + id, { method: 'DELETE', headers: A });
  const all = await j('/api/knowledge', { headers: A });
  for (const k of (all.b.knowledge || [])) if (String(k.title).startsWith(P)) await j('/api/knowledge/' + k.id, { method: 'DELETE', headers: A });
  const orphans = (await db.query(`SELECT (SELECT COUNT(*) FROM model_telemetry mt WHERE NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=mt.conversation_id)) t, (SELECT COUNT(*) FROM reviews r WHERE NOT EXISTS(SELECT 1 FROM conversations c WHERE c.id=r.conversation_id)) rv, (SELECT COUNT(*) FROM knowledge k WHERE k.title LIKE 'fin-%') k, (SELECT COUNT(*) FROM conversations c WHERE c.title LIKE 'fin-%') c`))[0];
  chk('18 无孤儿残留', orphans.t === 0 && orphans.rv === 0 && orphans.k === 0 && orphans.c === 0, JSON.stringify(orphans));
  console.log(`\n==== FINAL-REGRESSION RESULT: PASS=${PASS} FAIL=${FAIL} ====`);
  process.exit(FAIL > 0 ? 1 : 0);
}
main().catch((e) => { console.error('FINAL-REGRESSION-FAIL', e.message); process.exit(1); });
