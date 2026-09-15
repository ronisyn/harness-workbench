// scripts/c1-dsh-parity.mjs - 只读：**用 DSH 的口径**算我们自己的数（回答"为什么到不了 99.8%"）
//
// 口径澄清（本文件存在的理由）：
//   DSH 右下角那个 99.8% **不是每请求命中率**，而是**会话日志累计**
//   cacheRead / (uncachedInput + cacheRead + cacheWrite)。
//   累计比随会话变长**单调趋近 100%**：每轮输入 in_t = P + m·t ⇒ Σin ≈ m·N²/2，而 Σmiss ≈ P + m·N，
//   于是 累计 ≈ 1 − (P + m·N)/(P·N + m·N²/2) → 大 N 时 ≈ 1 − 2/N。
//   ⇒ **要显示 99.8%，一个会话得跑到约 1000 轮**（与 m 关系不大，见 §④）。
//   所以"我们的 12%"与"DSH 的 99.8%"不是同一个统计量，直接比是错的。
//
// 本脚本给出可直接对标的四组数：
//   ① 逐会话累计（DSH 口径）+ 天花板 + 分期（破窗期 / 修复期 / 当前期）
//   ② 逐执行累计（一次 runAgent = 最接近"DSH 一次会话"的单位）
//   ③ 缺口归因：未命中拆成 冷启动 / 轮内固有新增 / 异常重建
//   ④ "显示 99.8%"需要多长会话（按实测 m）
//
// 用法：node scripts/c1-dsh-parity.mjs [--min-rounds 30]
import { db } from '../server/db.js';
import { REAL_WHERE } from './cohort.mjs';

const c1Ceiling = (prefix, perRound, N) => {
  if (N <= 0) return null;
  let inPrev = prefix + perRound, H = prefix, M = perRound;
  for (let t = 2; t <= N; t++) { H += inPrev; M += perRound; inPrev += perRound; }
  return H / (H + M);
};

const argv = process.argv.slice(2);
const MIN_ROUNDS = argv.includes('--min-rounds') ? Number(argv[argv.indexOf('--min-rounds') + 1]) : 30;
const P = 10496; // 实测固定前缀（系统提示 + 工具面 + 环境块）tokens
// 分期：按日画像定（09-10 及以前每轮 miss 4 万+ = 前缀每轮被击穿；09-11 起跨会话前缀复用生效）
const ERAS = [
  ['破窗期  ≤09-10', '2000-01-01', '2026-09-11'],
  ['修复期  09-11~09-14', '2026-09-11', '2026-09-15'],
  ['当前期  ≥09-15', '2026-09-15', '2099-01-01'],
];

const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '  -  ' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Math.round(Number(n)).toLocaleString('en-US'));
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

console.log('== 口径对齐：DSH 显示的是**会话累计**命中率，不是每请求命中率 ==');
console.log(`   我们的固定前缀 P ≈ ${fmt(P)} tokens（实测，跨会话共享）`);
console.log('   会话跑到 N 轮时累计 ≈ 1 − (P + m·N)/(P·N + m·N²/2)，大 N 时 ≈ 1 − 2/N');

// ── ⓪ 分期总账 ─────────────────────────────────────────────────────────────
console.log('\n== ⓪ 分期：真实流量（人发起 + 定时任务 + 样本）==');
console.log('阶段                  轮数    会话   轮/会话   累计命中(DSH口径)   未命中   平均每轮 miss   成本');
for (const [label, from, to] of ERAS) {
  const r = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT u.conversation_id) convs,
                             SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                      FROM usage_stats u WHERE u.kind='round' AND (${REAL_WHERE('u')})
                        AND u.created_at >= '${from}' AND u.created_at < '${to}'`))[0];
  if (!r || !r.n) { console.log(`${label.padEnd(20)} （无数据）`); continue; }
  const H = Number(r.hit), M = Number(r.miss), N = Number(r.n);
  console.log(`${label.padEnd(20)} ${fmt(N).padStart(5)} ${fmt(r.convs).padStart(6)}  ${(N / Number(r.convs)).toFixed(1).padStart(6)}   ${pct(H / (H + M)).padStart(14)}   ${fmt(M).padStart(11)}   ${fmt(M / N).padStart(12)}   ¥${r.cost}`);
}

// ── ① 逐会话累计（DSH 口径）────────────────────────────────────────────────
const rows = await q(`SELECT u.conversation_id cid, c.title,
                             COUNT(*) rounds, SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss,
                             ROUND(SUM(u.cost),4) cost, MIN(u.created_at) t0, MAX(u.created_at) t1
                      FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                      WHERE u.kind='round' AND (${REAL_WHERE('u')})
                      GROUP BY u.conversation_id, c.title
                      HAVING rounds >= ? ORDER BY miss DESC`, [MIN_ROUNDS]);

console.log(`\n== ① 逐会话累计（真实流量，≥${MIN_ROUNDS} 轮）共 ${rows.length} 个，按未命中排序 ==`);
console.log('会话     轮数   累计命中   天花板   每轮新增m 重建轮(过量tok)  成本        起止               标题');
const perConv = [];
for (const r of rows) {
  const N = Number(r.rounds), H = Number(r.hit), M = Number(r.miss);
  const c1 = H + M > 0 ? H / (H + M) : null;
  const missRows = await q(`SELECT cache_miss_tokens m FROM usage_stats WHERE kind='round' AND conversation_id=? ORDER BY id`, [r.cid]);
  const arr = missRows.map((x) => Number(x.m)).filter((x) => isFinite(x));
  const mMed = med(arr) || 1;
  const rebuild = arr.filter((x) => x > 3 * mMed);
  const excess = rebuild.reduce((a, b) => a + b, 0) - rebuild.length * mMed;
  const ceiling = c1Ceiling(P, mMed, N);
  perConv.push({ ...r, N, H, M, c1, mMed, ceiling, rebuildN: rebuild.length, excess: Math.max(0, excess) });
  const d = (x) => String(x).slice(0, 10);
  console.log(`${String(r.cid).padEnd(8)} ${String(N).padStart(5)}  ${pct(c1).padStart(9)}  ${pct(ceiling).padStart(7)}  ${fmt(mMed).padStart(9)}  ${String(rebuild.length).padStart(5)}(${fmt(Math.max(0, excess))})  ¥${String(r.cost).padStart(9)}  ${d(r.t0)}~${d(r.t1)}  ${String(r.title || '').slice(0, 18)}`);
}

// ── ② 逐执行累计（最接近"DSH 一次会话"的单位）─────────────────────────────
console.log('\n== ② 逐执行累计（一次 runAgent = 一个可比"会话"）==');
const runs = await q(`SELECT u.conversation_id cid, u.agent_run_id rid, COUNT(*) rounds, MIN(u.created_at) t0,
                             SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                      FROM usage_stats u WHERE u.kind='round' AND (${REAL_WHERE('u')}) AND u.agent_run_id IS NOT NULL
                      GROUP BY u.conversation_id, u.agent_run_id ORDER BY miss DESC LIMIT 15`);
console.log('会话     执行      日期        轮数   执行累计命中   平均每轮miss   成本');
for (const r of runs) {
  const H = Number(r.hit), M = Number(r.miss);
  console.log(`${String(r.cid).padEnd(8)} ${String(r.rid).padEnd(8)} ${String(r.t0).slice(0, 10)} ${String(r.rounds).padStart(5)}   ${pct(H + M > 0 ? H / (H + M) : null).padStart(12)}   ${fmt(M / Number(r.rounds)).padStart(12)}   ¥${r.cost}`);
}
for (const [label, from] of [['当前期 ≥09-15', '2026-09-15']]) {
  const r = (await q(`SELECT SUM(hit) hit, SUM(miss) miss, COUNT(*) n FROM (
                        SELECT SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) miss
                        FROM usage_stats u WHERE u.kind='round' AND (${REAL_WHERE('u')}) AND u.agent_run_id IS NOT NULL
                          AND u.created_at >= '${from}'
                        GROUP BY u.conversation_id, u.agent_run_id) z`))[0];
  if (r && r.n) console.log(`  ${label}：${fmt(r.n)} 次执行 · 逐执行累计合计 ${pct(Number(r.hit) / (Number(r.hit) + Number(r.miss)))}`);
}

// ── ③ 缺口归因 ─────────────────────────────────────────────────────────────
console.log(`\n== ③ 缺口归因（≥${MIN_ROUNDS} 轮会话）==`);
console.log('会话     未命中       冷启动≤P占比   异常重建占比   轮内固有占比   重建归零后累计');
let sumM = 0, sumEx = 0, sumFloor = 0, sumHit = 0;
for (const s of perConv) {
  if (!s.M) continue;
  const floor = Math.min(s.M, P);
  sumM += s.M; sumHit += s.H; sumEx += s.excess; sumFloor += floor;
  console.log(`${String(s.cid).padEnd(8)} ${fmt(s.M).padStart(11)}   ${pct(floor / s.M).padStart(12)}   ${pct(s.excess / s.M).padStart(12)}   ${pct(Math.max(0, s.M - floor - s.excess) / s.M).padStart(12)}   ${pct(s.H / (s.H + s.M - s.excess)).padStart(14)}`);
}
if (sumM > 0) {
  console.log(`\n  合计 ${fmt(sumM)} = 冷启动 ${fmt(sumFloor)}（${pct(sumFloor / sumM)}）+ 异常重建 ${fmt(sumEx)}（${pct(sumEx / sumM)}）+ 轮内固有 ${fmt(Math.max(0, sumM - sumFloor - sumEx))}（${pct(Math.max(0, sumM - sumFloor - sumEx) / sumM)}）`);
  console.log(`  这些会话累计命中：现 ${pct(sumHit / (sumHit + sumM))} → 重建归零后 ${pct(sumHit / (sumHit + sumM - sumEx))}`);
}

// ── ④ 到 99.8% 还差多少轮 ──────────────────────────────────────────────────
const cur = (await q(`SELECT SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) miss, COUNT(*) n
                      FROM usage_stats u WHERE u.kind='round' AND (${REAL_WHERE('u')}) AND u.created_at >= '2026-09-15'`))[0];
const mCur = cur && cur.n ? Number(cur.miss) / Number(cur.n) : 2000;
console.log(`\n== ④ "显示 99.8%"需要多长会话（当前期实测 m = ${fmt(mCur)} tokens/轮）==`);
for (const target of [0.98, 0.99, 0.995, 0.998]) {
  let n = 2; while (n < 500000 && c1Ceiling(P, mCur, n) < target) n++;
  console.log(`  目标 ${pct(target).padStart(7)} → 约 ${fmt(n)} 轮（同会话、无异常重建）`);
}
console.log('\n  结论：DSH 的 99.8% 是**长会话累计比**，不是每轮质量；要"追平"它，');
console.log('        要么把会话拉长（口径红利），要么把每轮新增 m 压小（真实质量）。');
console.log('        真正该守的每请求指标见：node scripts/cache-perrequest.mjs');
process.exit(0);
