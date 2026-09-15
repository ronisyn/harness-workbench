// scripts/cache-ttl-probe.mjs - 受控实验：量出"前缀缓存能活多久"（决定 A/B 方案的关键参数）
//
// 设计（并行，总耗时 = 最大间隔）：
//   对每个间隔 Δ ∈ {60, 120, 300, 600, 900} 秒，各开**一个全新会话**：
//     ① t0：第一次请求（建立前缀）→ 记录命中率（应较低，因前缀还没被这个会话用过）
//     ② t0+Δ：第二次请求（同一会话、同一问题）→ **看命中率**
//        · 命中率高（≥90%）⇒ Δ 内缓存仍存活
//        · 命中率低（<50%）⇒ 已过期，前缀需重建
//   所有"第一次"先跑完，再等各自 Δ 后跑"第二次"，因此总耗时 ≈ max(Δ) = 15 分钟。
// 成本：10 次短请求 ≈ 每次 0.002 元 ⇒ 总计约 0.02–0.05 元。
//
// 用法（服务器上）：node scripts/cache-ttl-probe.mjs [--model deepseek-v4-flash] [--dry]
import { db } from '../server/db.js';
import { runAgent } from '../server/agent.js';
import { config } from '../server/config.js';

const argv = process.argv.slice(2);
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'deepseek-v4-flash';
const DRY = argv.includes('--dry');
const DELTAS = [60, 120, 300, 600, 900];
const Q1 = '请用一句话说明你是谁。';
const Q2 = '再用一句话说明你能做什么。';

const admin = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
const convs = [];

async function ask(cid, q) {
  const r = await runAgent({
    provider: 'deepseek', model: MODEL, permission: 'read',
    messages: [{ role: 'user', content: q }],
    ctx: { permission: 'read', accountId: admin.id, conversationId: cid, root: '/', __light: false, preset: 'all', mode: 'chat' },
    keys: config.keys, temperature: 0,
  });
  const row = (await db.query(`SELECT cache_hit_tokens hit, cache_miss_tokens miss, tokens_in tin, cost
                               FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id DESC LIMIT 1`, [cid]))[0];
  const tot = row ? Number(row.hit) + Number(row.miss) : 0;
  return { rate: tot > 0 ? Number(row.hit) / tot : null, hit: Number(row.hit || 0), miss: Number(row.miss || 0), tin: Number(row.tin || 0), cost: Number(row.cost || 0), content: String(r.content || '').slice(0, 40) };
}

console.log(`模型=${MODEL}　间隔集合=${DELTAS.join('/')}s　${DRY ? '（dry：只建会话不发请求）' : ''}`);
for (const d of DELTAS) {
  const c = await db.query("INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)",
    [admin.id, `__ttl_probe_${d}s__`, 'read', 'chat', 'all', 'default']);
  convs.push({ d, cid: c.insertId, t0: Date.now() });
}
if (DRY) {
  console.log('已建会话：' + convs.map((c) => `${c.d}=conv${c.cid}`).join(' '));
  for (const c of convs) await db.query('DELETE FROM conversations WHERE id=?', [c.cid]);
  process.exit(0);
}

console.log('\n== ① 建立前缀（每个会话第一次请求）==');
for (const c of convs) {
  const r = await ask(c.cid, Q1);
  c.first = r;
  console.log(`  Δ=${String(c.d).padStart(4)}s conv=${c.cid}  命中率 ${r.rate == null ? '-' : (r.rate * 100).toFixed(2) + '%'}  命中 ${r.hit} / 未命中 ${r.miss} / 输入 ${r.tin}  ¥${r.cost.toFixed(4)}`);
}

console.log('\n== ② 各等 Δ 秒后再问一次（看缓存是否存活）==');
const results = [];
for (const c of convs) {
  const waitMs = Math.max(0, c.t0 + c.d * 1000 - Date.now());
  if (waitMs > 0) { console.log(`  …等 ${Math.round(waitMs / 1000)}s（Δ=${c.d}s）`); await new Promise((r) => setTimeout(r, waitMs)); }
  const r = await ask(c.cid, Q2);
  results.push({ d: c.d, cid: c.cid, ...r });
  console.log(`  Δ=${String(c.d).padStart(4)}s conv=${c.cid}  命中率 ${r.rate == null ? '-' : (r.rate * 100).toFixed(2) + '%'}  命中 ${String(r.hit).padStart(6)} / 未命中 ${String(r.miss).padStart(6)} / 输入 ${String(r.tin).padStart(6)}  ¥${r.cost.toFixed(4)}`);
}

console.log('\n== 结论 ==');
const alive = results.filter((r) => r.rate != null && r.rate >= 0.9).map((r) => r.d);
const dead = results.filter((r) => r.rate != null && r.rate < 0.5).map((r) => r.d);
console.log(`  仍存活（≥90%）的间隔：${alive.length ? alive.join('/') + 's' : '（无）'}`);
console.log(`  已失效（<50%）的间隔：${dead.length ? dead.join('/') + 's' : '（无）'}`);
const sorted = results.filter((r) => r.rate != null).sort((a, b) => a.d - b.d);
console.log('  逐点：' + sorted.map((r) => `${r.d}s→${(r.rate * 100).toFixed(1)}%`).join('  '));
console.log(`  总成本 ¥${results.reduce((a, r) => a + r.cost, 0).toFixed(4)}`);
console.log('\n  解读：存活区间 = 可安全使用的"保温间隔上限"；若 300s 存活而 900s 失效，则保温心跳取 ≤300s。');

// 清理
for (const c of convs) {
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [c.cid]);
  await db.query('DELETE FROM conversations WHERE id=?', [c.cid]);
  await db.query('DELETE FROM audit_log WHERE conversation_id=?', [c.cid]);
}
console.log('（探针会话已清理）');
process.exit(0);
