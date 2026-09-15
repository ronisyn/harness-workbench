// scripts/baseline-cost.mjs - 成本基线只读测量（C1–C4）
// 用法（服务器上）：node scripts/baseline-cost.mjs
// 只做 SELECT；走应用自己的 db.js，不单独处理凭证。用于改造前后对照（《引擎改造计划》§0.3）。
import { db } from '../server/db.js';

const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');

const avail = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT conversation_id) convs, COUNT(DISTINCT agent_run_id) runs,
                               MIN(created_at) mn, MAX(created_at) mx, ROUND(SUM(cost),4) cost FROM usage_stats`))[0];
console.log('数据：' + JSON.stringify(avail));

for (const [label, where] of [['全量', '1=1'], ['近7天', 'created_at > NOW() - INTERVAL 7 DAY']]) {
  const r = (await q(`SELECT SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) miss, ROUND(SUM(cost),4) cost, COUNT(*) n
                        FROM usage_stats WHERE ${where}`))[0];
  const rate = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  console.log(`C1 ${label}：命中 ${fmt(r.hit)} / 未命中 ${fmt(r.miss)} → **${pct(rate)}**（成本 ${r.cost}，行 ${fmt(r.n)}）`);
}

for (const [label, where] of [['全量', "kind='round'"], ['近7天', "kind='round' AND created_at > NOW() - INTERVAL 7 DAY"]]) {
  const r = (await q(`WITH t AS (SELECT cache_miss_tokens m, ROW_NUMBER() OVER (ORDER BY cache_miss_tokens) rn, COUNT(*) OVER () c
                                     FROM usage_stats WHERE ${where} AND cache_miss_tokens IS NOT NULL)
                      SELECT MAX(c) n, MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.50)) THEN m END) p50,
                             MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.95)) THEN m END) p95, MAX(m) mx FROM t`))[0];
  console.log(`C2 ${label}：中位 ${fmt(r.p50)} / P95 ${fmt(r.p95)} / 最大 ${fmt(r.mx)}（n=${fmt(r.n)}）`);
}

const perRun = (await q(`SELECT COUNT(DISTINCT agent_run_id) runs, ROUND(SUM(cost),4) cost FROM usage_stats WHERE agent_run_id IS NOT NULL`))[0];
const perConv = (await q(`SELECT COUNT(*) n, ROUND(SUM(cost),4) cost, ROUND(AVG(cost),4) avg FROM
                            (SELECT conversation_id, SUM(cost) cost FROM usage_stats WHERE conversation_id IS NOT NULL GROUP BY conversation_id) x`))[0];
console.log(`C3：每 run ≈ ${perRun.runs ? (perRun.cost / perRun.runs).toFixed(4) : '-'}（${fmt(perRun.runs)} runs）；每会话 ≈ ${perConv.avg}（${fmt(perConv.n)} 个）`);

const c4 = (await q(`SELECT COUNT(*) n FROM usage_stats WHERE kind='round' AND IFNULL(cache_hit_tokens,0)=0 AND tokens_in > 5000`))[0];
console.log(`C4 近似（整段作废候选）：${fmt(c4.n)} 次`);
process.exit(0);
