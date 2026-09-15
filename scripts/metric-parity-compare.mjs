// scripts/metric-parity-compare.mjs - 两套命中口径的对照（只读）：**同一个库，两种数，结论不一样**
//
// 为什么要这份对照（2026-09-15 用户要求"先给我看两组数据的对比再定"）：
//   口径 A = **每请求命中率**（这一次调用里有多少输入从缓存读）—— 与"有没有失效"同向；
//   口径 B = **会话累计命中率**（cacheRead ÷ 全部输入）—— DSH 右下角那个 99.8% 就是它。
//   两者不可互推：B 会**因为会话变长而自动升高**（只追加历史下 ≈ 1 − 2/N，与每轮增量无关），
//   也会**因为历史欠账而被永久压低**（累计比把改造前的轮次永久留在分子分母里）。
// 本脚本用**同一个库的真实数据**把这两件事各证一次，并给出与成本的关系。
//
// 用法：node scripts/metric-parity-compare.mjs [--days 30]
import { db } from '../server/db.js';
import { REAL_WHERE, HUMAN_WHERE, SCHEDULED_WHERE, SAMPLE_WHERE, PROBE_WHERE } from './cohort.mjs';

const argv = process.argv.slice(2);
const DAYS = argv.includes('--days') ? Number(argv[argv.indexOf('--days') + 1]) : 30;
const P = 10496; // 实测固定前缀（tokens）
const ERAS = [
  ['破窗期  ≤09-10', '2000-01-01', '2026-09-11'],
  ['修复期  09-11~09-14', '2026-09-11', '2026-09-15'],
  ['当前期  ≥09-15', '2026-09-15', '2099-01-01'],
];
const q = async (s, p = []) => { try { return await db.query(s, p); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '  -  ' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Math.round(Number(n)).toLocaleString('en-US'));
const qtl = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
const c1Ceiling = (prefix, perRound, N) => { if (N <= 0) return null; let inPrev = prefix + perRound, H = prefix, M = perRound; for (let t = 2; t <= N; t++) { H += inPrev; M += perRound; inPrev += perRound; } return H / (H + M); };

console.log('== 表一：同一批真实流量，两套口径并排（口径 A 每请求 vs 口径 B 会话累计）==');
console.log('阶段                   轮数   会话   口径A 中位   口径A P90   口径B 累计   每轮成本     总成本');
const eraRows = {};
for (const [label, from, to] of ERAS) {
  const rows = await q(`SELECT cache_hit_tokens h, cache_miss_tokens m, cost, conversation_id cid
                          FROM usage_stats u
                         WHERE u.kind='round' AND (${REAL_WHERE('u')})
                           AND u.created_at >= ? AND u.created_at < ?`, [from, to]);
  if (!rows.length || rows[0].__err) { console.log(label.padEnd(22) + ' （无数据）'); continue; }
  const rates = rows.filter((r) => Number(r.h) + Number(r.m) > 0).map((r) => Number(r.h) / (Number(r.h) + Number(r.m)));
  const H = rows.reduce((s, r) => s + Number(r.h), 0), M = rows.reduce((s, r) => s + Number(r.m), 0);
  const cost = rows.reduce((s, r) => s + Number(r.cost || 0), 0);
  eraRows[label] = { n: rows.length, H, M, cost, median: qtl(rates, 0.5) };
  console.log(label.padEnd(22) + String(rows.length).padStart(5) + String(new Set(rows.map((r) => r.cid)).size).padStart(7)
    + '   ' + pct(qtl(rates, 0.5)).padStart(10) + '   ' + pct(qtl(rates, 0.9)).padStart(10)
    + '   ' + pct(H / (H + M)).padStart(10) + '   ¥' + (cost / rows.length).toFixed(4).padStart(8) + '   ¥' + cost.toFixed(2).padStart(8));
}

console.log('\n  读法：口径 A（每请求）与成本**同向**——破窗期每轮 ¥0.1117 对应 A 中位 5% 上下；');
console.log('        当前期每轮降到 ¥0.0077（14 倍）时 A 已经很高。而口径 B 在同一批数据上只从 6% 爬到 86%，');
console.log('        看上去"还差得远"，其实钱已经省下来了 —— 因为 B 被破窗期的历史欠账锁住。');

console.log('\n== 表二：口径 B 会**因为会话变长自动升高**（同样的每轮增量，什么都不改）==');
const cur = eraRows['当前期  ≥09-15'] || eraRows['修复期  09-11~09-14'];
const m = cur ? Math.round(cur.M / cur.n) : 1766;
console.log(`  用当前期实测每轮新增 m = ${fmt(m)} tokens / 固定前缀 P = ${fmt(P)}（脚本算的是模型，不是实测）`);
console.log('  轮数        20      50     100     200     500    1000    2000');
console.log('  口径B    ' + [20, 50, 100, 200, 500, 1000, 2000].map((n) => pct(c1Ceiling(P, m, n)).padStart(7)).join(' ') + `   ← 每轮成本一次都没变`);
console.log('  ⇒ **口径 B 只要把会话拖长就会自己涨到 99.8%**（1000 轮 ≈ 99.8%），而它并不回答"这次有没有白花钱"。');
console.log('  ⇒ 这也是 DSH 那个 99.8% 的来历：它的会话平均每次请求 443,486 tokens（v0.3 §2.1 实测），分母巨大。');

console.log('\n== 表三：口径 B 也会**被历史欠账永久压低**（同一个会话，同一套机制，只看怎么切）==');
for (const r of await q(`SELECT u.conversation_id cid, c.title, COUNT(*) n,
                                SUM(u.cache_hit_tokens) h, SUM(u.cache_miss_tokens) m, ROUND(SUM(u.cost),2) cost
                           FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                          WHERE u.kind='round' AND (${REAL_WHERE('u')})
                          GROUP BY u.conversation_id, c.title ORDER BY m DESC LIMIT 5`)) {
  const rateRows = await q("SELECT cache_hit_tokens h, cache_miss_tokens m FROM usage_stats WHERE kind='round' AND conversation_id=? AND cache_hit_tokens+cache_miss_tokens>0", [r.cid]);
  const rates = rateRows.map((x) => Number(x.h) / (Number(x.h) + Number(x.m)));
  console.log(`  会话 ${String(r.cid).padEnd(5)} 轮 ${String(r.n).padStart(5)}  口径B ${pct(Number(r.h) / (Number(r.h) + Number(r.m))).padStart(8)}  口径A 中位 ${pct(qtl(rates, 0.5)).padStart(8)}  ¥${String(r.cost).padStart(8)}  ${String(r.title || '').slice(0, 20)}`);
}
console.log('  ⇒ 注意：**按会话聚合时两套口径都会被历史拖住**（184/185 的中位同样很低）——');
console.log('    所以"换个口径"救不了历史欠账，救它的是**按时间切段**（表一就是这么切的）。');
console.log('    那为什么还要选 A？因为切段之后 A 回答的是"这一次调用有没有白花钱"（可归因到具体事件、可行动），');
console.log('    而 B 即使切段也仍然混着"会话有多长"这个因子（表二）。');

console.log('\n== 表四：与 DSH 的可比数字（同一口径 A）==');
console.log('  对象            口径A 中位    口径A P90    口径B        平均每次请求输入');
console.log('  DSH（v0.3 §2.1 实测）  99.94%      99.98%     99.72%     443,486 tokens');
const allReal = await q(`SELECT cache_hit_tokens h, cache_miss_tokens m FROM usage_stats u WHERE u.kind='round' AND (${REAL_WHERE('u')})`);
const allRates = allReal.filter((r) => Number(r.h) + Number(r.m) > 0).map((r) => Number(r.h) / (Number(r.h) + Number(r.m)));
const avgIn = allReal.length ? allReal.reduce((s, r) => s + Number(r.h) + Number(r.m), 0) / allReal.length : 0;
console.log('  Roni（全量真实流量）  ' + pct(qtl(allRates, 0.5)) + '      ' + pct(qtl(allRates, 0.9)) + '     '
  + pct(allReal.reduce((s, r) => s + Number(r.h), 0) / allReal.reduce((s, r) => s + Number(r.h) + Number(r.m), 0)) + '     ' + fmt(avgIn) + ' tokens');
const recent = allReal.slice(-400);
const recRates = recent.filter((r) => Number(r.h) + Number(r.m) > 0).map((r) => Number(r.h) / (Number(r.h) + Number(r.m)));
console.log('  Roni（最近 400 轮）   ' + pct(qtl(recRates, 0.5)) + '      ' + pct(qtl(recRates, 0.9)) + '     （略）');
console.log('\n  ⇒ 真正的差距在**口径 A 的中位**（99.94% vs 我们），而不是"5% vs 99.8%"那个吓人的对比；');
console.log('    而且我们最近 400 轮的 A 中位已经由本例直接读出（见上），差距是可量化、可收敛的。');
process.exit(0);
