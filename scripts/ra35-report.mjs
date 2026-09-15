// scripts/ra35-report.mjs - RA-35 判定报告（只读，可复跑）
//
// ── 为什么需要"分段"而不是只看一个累计 C1 ────────────────────────────────────────────────
// C1 是**整个口径累计**的比（命中/(命中+未命中)）。于是有两件事会让累计值**再也反映不了当前机制**：
//   ① 改造前的真实轮次已经永久留在分子分母里（本库 1,600 条真实人发起轮次全是改造前的）；
//   ② 集中度极端——真实流量 3 个会话占 98.3% 的未命中，#184 一个会话就占 62.7%。
// 结论：**累计 C1 只能当成本基线，不能当"现在好不好"的判据**。判据必须按**改造生效时刻切段**：
//   · 基线段：改造前的历史轮次（冻结，不可改，只用于算成本账）
//   · 新段：改造生效后的轮次（这才是"机制是否生效"的证据来源）
// 本报告把两段分开算，并明确"新段真实流量不足时判不了"——而不是拿探针成绩或旧数据顶判据。
//
// 用法：node scripts/ra35-report.mjs
//   环境变量 RA35_CUTOFF 可覆盖切段时刻（默认 2026-09-15 05:00:00，**库本地时间**）
import { db } from '../server/db.js';
import { REAL_WHERE, HUMAN_WHERE, SCHEDULED_WHERE, PROBE_WHERE, ORPHAN_WHERE } from './cohort.mjs';

const CUTOFF = process.env.RA35_CUTOFF || '2026-09-15 05:00:00';
const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');

// 一个口径 × 一个时间段的 C1/C2
async function metrics(label, whereFn, since = null) {
  const w = whereFn('u');
  const tw = since ? `AND u.created_at >= '${since}'` : '';
  const r = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT u.conversation_id) convs,
                             SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                      FROM usage_stats u WHERE u.kind='round' AND ${w} ${tw}`))[0] || {};
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  const c2 = (await q(`WITH t AS (SELECT u.cache_miss_tokens m, ROW_NUMBER() OVER (ORDER BY u.cache_miss_tokens) rn, COUNT(*) OVER () c
                                    FROM usage_stats u WHERE u.kind='round' AND u.cache_miss_tokens IS NOT NULL AND ${w} ${tw})
                       SELECT MAX(c) n, MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.50)) THEN m END) p50,
                              MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.95)) THEN m END) p95 FROM t`))[0] || {};
  return { label, rounds: Number(r.n || 0), convs: Number(r.convs || 0), hit: Number(r.hit || 0), miss: Number(r.miss || 0), c1, p50: c2.p50, p95: c2.p95, cost: Number(r.cost || 0) };
}

const line = (m) => console.log(`  ${m.label.padEnd(22)} 轮 ${fmt(m.rounds).padStart(6)} · 会话 ${fmt(m.convs).padStart(4)} · C1 ${pct(m.c1).padStart(8)} · C2 中位 ${fmt(m.p50).padStart(7)} / P95 ${fmt(m.p95).padStart(7)} · ¥${m.cost.toFixed(4)}`);

console.log(`切段时刻（库本地时间）：${CUTOFF}`);
console.log('判据：C1 ≥ 99% · C2 中位 ≤ 1,000 · P95 ≤ 5,000（《架构》§14.2 RA-35）\n');

console.log('== ① 基线段：改造生效前的历史轮次（冻结，只用于算成本账）==');
const base = {};
for (const [k, f] of [['真实流量', REAL_WHERE], ['  ├ 人发起', HUMAN_WHERE], ['  └ 定时任务', SCHEDULED_WHERE], ['探针', PROBE_WHERE]]) {
  base[k] = await metrics(k, f, null);
  base[k].label = k;
}
for (const k of Object.keys(base)) line(base[k]);
console.log('  （基线段的 C1 不代表机制现状：那段历史发生在改造之前，且已永久计入累计值）');

console.log('\n== ② 新段：改造生效后的轮次（机制是否生效的**唯一**证据来源）==');
// 口径必须与 ① 完全同源（同一组 WHERE），否则"新段真实流量"会把孤儿/探针算进来——
// 本报告第一版就踩过：一行 conversation_id IS NULL 的无主行被算成"真实"。
const IN_SEG = (w) => `(${w}) AND u.created_at >= '${CUTOFF}'`;
const rowsNew = await q(`SELECT u.conversation_id cid, c.title, COUNT(*) rounds, SUM(u.cache_hit_tokens) hit,
                                SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                         FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                         WHERE u.kind='round' AND ${REAL_WHERE('u')} AND u.created_at >= '${CUTOFF}'
                         GROUP BY u.conversation_id, c.title ORDER BY rounds DESC`);
const probeNew = await q(`SELECT u.conversation_id cid, c.title, COUNT(*) rounds, SUM(u.cache_hit_tokens) hit,
                                 SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                          FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                          WHERE u.kind='round' AND ${PROBE_WHERE('u')} AND u.created_at >= '${CUTOFF}'
                          GROUP BY u.conversation_id, c.title ORDER BY rounds DESC`);
const orphanNew = (await q(`SELECT COUNT(*) n FROM usage_stats u WHERE u.kind='round' AND ${ORPHAN_WHERE('u')} AND u.created_at >= '${CUTOFF}'`))[0] || {};
for (const r of probeNew) {
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  console.log(`  [探针] conv=${String(r.cid).padEnd(6)} 轮 ${String(r.rounds).padStart(4)} · C1 ${pct(c1).padStart(8)} · 命中 ${fmt(r.hit).padStart(10)} / 未命中 ${fmt(r.miss).padStart(9)} · ¥${r.cost} · ${String(r.title || '').slice(0, 22)}`);
}
for (const r of rowsNew) {
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  console.log(`  [真实] conv=${String(r.cid).padEnd(6)} 轮 ${String(r.rounds).padStart(4)} · C1 ${pct(c1).padStart(8)} · 命中 ${fmt(r.hit).padStart(10)} / 未命中 ${fmt(r.miss).padStart(9)} · ¥${r.cost} · ${String(r.title || '').slice(0, 22)}`);
}
console.log(`  [孤儿] 新段无主/已删会话轮次 ${fmt(orphanNew.n)}（不计入真实流量）`);

const realRounds = rowsNew.reduce((a, r) => a + Number(r.rounds), 0);
const realMiss = rowsNew.reduce((a, r) => a + Number(r.miss), 0);
const realHit = rowsNew.reduce((a, r) => a + Number(r.hit), 0);
const probeRounds = probeNew.reduce((a, r) => a + Number(r.rounds), 0);
console.log(`\n  → 新段：真实流量 ${fmt(realRounds)} 轮（会话 ${rowsNew.length}）· 探针 ${fmt(probeRounds)} 轮（会话 ${probeNew.length}）`);
if (realRounds < 30) {
  console.log('  → **判定：不可判**。新段真实流量过少（<30 轮），任何 C1/C2 读数都会被单会话/单轮噪声主导。');
  console.log('     要判 RA-35，必须先有改造后的真实使用（人发起或定时任务）积累到足够轮次；');
const probeHitSum = probeNew.reduce((a, r) => a + Number(r.hit), 0);
const probeMissSum = probeNew.reduce((a, r) => a + Number(r.miss), 0);
const probeC1 = (probeHitSum + probeMissSum) > 0 ? probeHitSum / (probeHitSum + probeMissSum) : null;
console.log(`     探针成绩（本段实测 C1 ${pct(probeC1)}）只是机制级取证，**不能**当真实流量成绩引用。`);
} else if (realMiss === 0 && realHit === 0) {
  console.log('  → 新段真实流量存在但**无计费 token**（未实际调用模型）：同样不可判，但可确认"没有产生未命中"。');
} else {
  const m1 = realHit / (realHit + realMiss);
  const c2 = (await q(`WITH t AS (SELECT u.cache_miss_tokens m, ROW_NUMBER() OVER (ORDER BY u.cache_miss_tokens) rn, COUNT(*) OVER () c
                                    FROM usage_stats u WHERE u.kind='round' AND u.cache_miss_tokens IS NOT NULL AND ${IN_SEG(REAL_WHERE('u'))})
                       SELECT MAX(c) n, MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.50)) THEN m END) p50,
                              MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.95)) THEN m END) p95 FROM t`))[0] || {};
  console.log(`  → 判定：C1 ${pct(m1)} ${m1 >= 0.99 ? '达标' : '**未达标**'} · C2 中位 ${fmt(c2.p50)} ${c2.p50 != null && c2.p50 <= 1000 ? '达标' : '**未达标**'} · P95 ${fmt(c2.p95)} ${c2.p95 != null && c2.p95 <= 5000 ? '达标' : '**未达标**'}`);
}

console.log('\n== ③ 成本基线（累计，不受分段影响）==');
const cost = (await q('SELECT ROUND(SUM(cost),4) all_cost FROM usage_stats'))[0] || {};
const realCost = (await q(`SELECT ROUND(SUM(u.cost),4) c FROM usage_stats u WHERE ${REAL_WHERE('u')}`))[0] || {};
console.log(`  全库累计 ¥${cost.all_cost} · 真实流量累计 ¥${realCost.c}`);
console.log(`  真实流量当前 C1 = ${pct(base['真实流量'].c1)}（基线段的累计值，会被历史大会话锁住，见 c1-ceiling.mjs 的集中度）`);
console.log('  提示：本段只作成本账。**别用累计 C1 判"现在好不好"**——判断只看 ② 新段。');
console.log('\n复跑：node scripts/ra35-report.mjs   （可用 RA35_CUTOFF 覆盖切段时刻）');
process.exit(0);
