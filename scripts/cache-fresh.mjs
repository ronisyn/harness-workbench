// scripts/cache-fresh.mjs - "一条全新对话，从 0 开始"到底是多少（走生产 HTTP 路径，真累积历史）
//
// ⚠️ 第一版有 bug（2026-09-15 自查发现，已重写）：原先每轮直调 runAgent 且 messages 只带"本轮那一条提问"，
//   等于发了 **N 次互不相干的单轮请求**，而且读的是每次运行**最后一轮**的账 —— 报出来的"稳态 546"既不是
//   多轮会话的数、也不是当轮的新增。现在改成走 /api/chat（服务端自己拼历史），并读**该会话全部轮次**。
//
// 判读：
//   · 第 1 轮 = 冷启动轮，但它**不该是 0%** —— 规范前缀（系统提示+工具面）跨会话共享，首次请求就命中它；
//   · 第 2 轮起，输入随历史累积而增长，命中率应**逐轮爬升**（分母在长，分子几乎全中）；
//   · 稳态下 **未命中 ≈ 每轮新增** = 上轮助手正文 + 本轮工具结果 + 平台每轮注入。这是唯一值得盯的工程量。
//
// 用法：node scripts/cache-fresh.mjs [--rounds 6] [--keep]
import fs from 'node:fs';
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const num = (f, d) => (argv.includes(f) ? Number(argv[argv.indexOf(f) + 1]) : d);
const ROUNDS = num('--rounds', 6);
const KEEP = argv.includes('--keep');
const BASE = process.env.RW_BASE || 'http://127.0.0.1:880';
const WS = '/srv/rw-workspace/tmp/fresh-probe';

let user = process.env.RW_ADMIN_USER, pass = process.env.RW_ADMIN_PASS;
if (!user || !pass) {
  try {
    const env = fs.readFileSync('/root/.rw-keys.env', 'utf8');
    const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.split('=').slice(1).join('=').trim();
    user = user || get('RW_ADMIN_USER'); pass = pass || get('RW_ADMIN_PASS');
  } catch { /* 走参数 */ }
}
if (!user || !pass) { console.error('缺账号：设 RW_ADMIN_USER/RW_ADMIN_PASS 或提供 /root/.rw-keys.env'); process.exit(2); }
const lg = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })).json();
if (!lg.token) { console.error('登录失败', lg); process.exit(2); }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.token };

const c = await (await fetch(BASE + '/api/conversations', { method: 'POST', headers: H, body: JSON.stringify({ title: '__cache_fresh__' }) })).json();
const cid = c.id;
await db.query("UPDATE conversations SET permission='full' WHERE id=?", [cid]);
console.log(`全新会话 conv=${cid}（走 /api/chat，服务端自己拼历史）　轮数=${ROUNDS}\n`);

const TASKS = [
  `在 ${WS} 下建目录并写一个文件 a.mjs，内容：export const a = 1;  只做这一件事。`,
  `用 read_file 读回 ${WS}/a.mjs 确认内容。`,
  `用 list_dir 列出 ${WS} 目录。`,
  `把 ${WS}/a.mjs 里的 1 改成 2。`,
  `用 run_command 跑 node --check ${WS}/a.mjs，把输出原样告诉我。`,
  `一句话总结刚才做了什么。`,
];

async function chat(text) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ conversationId: cid, content: text }) });
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; let ok = false; let err = '';
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const part of buf.split('\n\n')) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let j = null; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (j.type === 'done') ok = true;
      if (j.type === 'error') err = j.message;
    }
  }
  return { ok, err, secs: (Date.now() - t0) / 1000 };
}

for (let i = 0; i < Math.min(ROUNDS, TASKS.length); i++) {
  const r = await chat(TASKS[i]);
  console.log(`  第 ${i + 1} 轮 ${r.ok ? '✅' : '❌'} ${r.secs.toFixed(1)}s${r.err ? ' — ' + r.err : ''}`);
}

const rows = await db.query("SELECT id, tokens_in tin, cache_hit_tokens h, cache_miss_tokens m, cost, prefix_sys_hash s, prefix_tools_hash t FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id", [cid]);
console.log('\n轮   输入      命中      未命中   命中率     本轮新增≈未命中   成本      前缀/工具面指纹');
rows.forEach((r, i) => {
  const tin = Number(r.tin), h = Number(r.h), m = Number(r.m);
  console.log(String(i + 1).padStart(2) + '  ' + String(tin).padStart(7) + '  ' + String(h).padStart(8) + '  ' + String(m).padStart(7)
    + '  ' + ((h / tin) * 100).toFixed(2).padStart(6) + '%  ' + String(m).padStart(15) + '   ¥' + Number(r.cost).toFixed(4) + '   ' + r.s + '/' + r.t);
});

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const warm = rows.slice(1).map((r) => ({ rate: Number(r.h) / Number(r.tin), m: Number(r.m) }));
const HIT = rows.reduce((s, r) => s + Number(r.h), 0), MISS = rows.reduce((s, r) => s + Number(r.m), 0);
console.log('\n== 结论（这一条会话，不掺任何历史）==');
console.log('  第 1 轮（冷启动）命中率 ' + ((Number(rows[0].h) / Number(rows[0].tin)) * 100).toFixed(2) + '%　未命中 ' + rows[0].m + ' tokens');
if (warm.length) {
  console.log('  第 2 轮起：命中率 中位 ' + (med(warm.map((x) => x.rate)) * 100).toFixed(2) + '%　最好 ' + (Math.max(...warm.map((x) => x.rate)) * 100).toFixed(2) + '%　最差 ' + (Math.min(...warm.map((x) => x.rate)) * 100).toFixed(2) + '%');
  console.log('  每轮新增（≈未命中）中位 ' + med(warm.map((x) => x.m)) + ' tokens　最大 ' + Math.max(...warm.map((x) => x.m)));
}
console.log('  会话累计命中率（DSH 口径）= ' + ((HIT / (HIT + MISS)) * 100).toFixed(2) + '%（' + HIT + '/' + (HIT + MISS) + '）');
console.log('  全程成本 ¥' + rows.reduce((s, r) => s + Number(r.cost), 0).toFixed(4));
const faces = [...new Set(rows.map((r) => r.t))];
console.log('  工具面指纹种类 = ' + faces.length + '（会话内应 ≤2：单向粘滞最多翻一次）');

console.log('\n== 本轮的工具结果体积（每轮新增的主要来源）==');
for (const r of await db.query(`SELECT t.tool_name, t.result_bytes b FROM tool_calls t WHERE t.conversation_id=? ORDER BY t.id`, [cid])) {
  console.log('  ' + String(r.tool_name).padEnd(16) + String(r.b).padStart(6) + 'B ≈' + Math.round(Number(r.b) / 3.2) + ' tok');
}

if (!KEEP) {
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [cid]);
  await db.query('DELETE FROM audit_log WHERE conversation_id=?', [cid]);
  await db.query('DELETE FROM conversations WHERE id=?', [cid]);
  console.log('\n（探针会话已清理；加 --keep 可保留）');
} else console.log('\n（已保留 conv=' + cid + '）');
process.exit(0);
