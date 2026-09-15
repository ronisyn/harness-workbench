// scripts/c1-breakdown.mjs - RA-35 缺口定位（只读）：逐会话给 C1/C2，把"结构地板"和"可省失效"分清楚
//
// 关键校正（本脚本存在的理由）：C1 是**会话级聚合**，每个会话的**第一轮必然 100% 未命中**（无前缀可命中）。
// 于是口径级硬上界是
//      C1_max = 1 − 会话数 / 总轮数          ← 假设"首轮之外全部命中"
// 注意它取决于**会话数/总轮数**这个比，而不是"平均轮数 ≥100"——早前报告里那句推导是错的，已删。
// 所以判 RA-35 要看两件不同的事：
//   ① 结构地板：1 − 会话数/轮数（会话越短，地板越高；短会话不可能拿到 99%）
//   ② 地板与实测之间的差 = "可省的失效"（前缀改写 / 工具面变更 / 长空闲 / 切模型），这才是机制该负责的部分
// 本脚本逐会话列出 C1，让"谁在拖后腿"和"改造后到底有没有变好"一眼可见。
// 用法：node scripts/c1-breakdown.mjs [--all]
import { db } from '../server/db.js';
import { REAL_WHERE, PROBE_WHERE, ORPHAN_WHERE } from './cohort.mjs';

const ALL = process.argv.includes('--all');
const CUTOFF = process.env.RA35_CUTOFF || '2026-09-15 05:00:00';
const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

const where = ALL ? '1=1' : REAL_WHERE('u');
const rows = await q(`
  SELECT u.conversation_id cid, c.title, COUNT(*) rounds,
         SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss,
         ROUND(SUM(u.cost),4) cost, MIN(u.created_at) first_at, MAX(u.created_at) last_at,
         ROUND(AVG(u.cache_miss_tokens)) avg_miss,
         (SELECT COUNT(*) FROM auditsel x) x
  FROM usage_stats u LEFT JOIN conversations c ON c.id = u.conversation_id
  WHERE u.kind='round' AND ${where}
  GROUP BY u.conversation_id, c.title
  HAVING rounds > 0
  ORDER BY rounds DESC`.replace(/,?\s*\(SELECT COUNT\(\*\) FROM auditsel x\) x/, ''));

console.log(`${ALL ? '全量（含探针）' : '真实流量（排除探针/孤儿）'}逐会话：`);
console.log('会话                      轮数   C1       首轮之外上界   C2 均值   成本       窗口');
let th = 0, tm = 0, tc = 0, tconv = 0, tFloor = 0;
for (const r of rows) {
  const hit = Number(r.hit || 0), miss = Number(r.miss || 0);
  const c1 = (hit + miss) > 0 ? hit / (hit + miss) : null;
  const rounds = Number(r.rounds);
  const ceiling = 1 - 1 / rounds; // 单会话：首轮那一次未命中
  th += hit; tm += miss; tc += Number(r.cost || 0); tconv++; tFloor += 1 / rounds;
  const name = (String(r.cid) + ' ' + String(r.title || '')).slice(0, 24).padEnd(25);
  console.log(`${name} ${String(rounds).padStart(5)}  ${pct(c1).padStart(7)}  ${pct(ceiling).padStart(11)}  ${fmt(r.avg_miss).padStart(8)}  ¥${String(r.cost).padStart(8)}  ${String(r.first_at).slice(5, 16)}→${String(r.last_at).slice(5, 16)}`);
}
const c1All = (th + tm) > 0 ? th / (th + tm) : null;
const floorGap = tFloor; // Σ(1/轮数) 的近似（精确口径见 c1-ceiling.mjs：会话数/总轮数）
console.log('─'.repeat(108));
console.log(`合计：${fmt(tconv)} 会话 · 命中 ${fmt(th)} / 未命中 ${fmt(tm)} → C1 ${pct(c1All)} · 成本 ¥${tc.toFixed(4)}`);
console.log(`口径上界（1 − 会话数/总轮数）与"可省缺口"见 node scripts/c1-ceiling.mjs`);

console.log('\n== 改造后（库本地 2026-09-15 05:00 起）逐会话 ==');
// 口径一律引用 cohort.mjs（不要在这里另写一份正则）——三处各写一份是漂移的起点：
// 这里第一版就漏了"孤儿"，把 conversation_id IS NULL 的无主行标成了「真实」。
for (const r of await q(`
  SELECT u.conversation_id cid, c.title, COUNT(*) rounds, SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss,
         ROUND(SUM(u.cost),4) cost,
         CASE WHEN ${ORPHAN_WHERE('u')} THEN '孤儿'
              WHEN ${PROBE_WHERE('u')} THEN '探针'
              ELSE '真实' END kind
  FROM usage_stats u LEFT JOIN conversations c ON c.id = u.conversation_id
  WHERE u.kind='round' AND u.created_at >= '${CUTOFF}'
  GROUP BY u.conversation_id, c.title ORDER BY kind, cid`)) {
  if (r.__err) { console.log('  ' + r.__err); continue; }
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  console.log(`  [${r.kind}] conv=${String(r.cid).padEnd(6)} ${String(r.title || '').slice(0, 20).padEnd(21)} 轮 ${String(r.rounds).padStart(3)}  C1 ${pct(c1).padStart(7)}  命中 ${fmt(r.hit)} / 未命中 ${fmt(r.miss)}  ¥${r.cost}`);
}
process.exit(0);
