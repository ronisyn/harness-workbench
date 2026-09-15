// scripts/cache-idle-survival.mjs - 只读：用**真实生产数据**量前缀缓存的存活窗口（比人造探针更可信）
//
// 为什么要用生产数据：人造探针（scripts/cache-ttl2.mjs）只能测小时以内的窗口，而且很难排除
// "公共前缀被隔壁请求顺手刷新"的混淆。生产数据里，一个会话**自己独有的历史**只能被它自己刷新，
// 所以"隔了很久之后仍然命中"就是厂商侧缓存真的活着的硬证据。
//
// 判据：同一会话内相邻两轮间隔 G 秒，后一轮的 miss。
//   miss ≪ 输入  ⇒ 空闲 G 秒后前缀仍存活
//   miss ≈ 输入  ⇒ 已失效（须结合"前缀有没有变"才能归因，见 proposals/缓存追平DSH-方案-v1-20260915.md §2.2）
//
// 结论（2026-09-15 实测）：会话 269 空闲 167.9 小时仍命中 97.1%；会话 185 连续三天 24 小时空闲
//   未命中恒为 142（1.0%）。而同一会话在前缀变了 +46 tokens 的那天，24 小时空闲后未命中 92.8%。
//   ⇒ **缓存不是被时间清掉的，是被"前缀变了"清掉的。**
//
// 用法：node scripts/cache-idle-survival.mjs [--min-gap 1800] [--min-input 5000]
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const num = (flag, dflt) => (argv.includes(flag) ? Number(argv[argv.indexOf(flag) + 1]) : dflt);
const MIN_GAP = num('--min-gap', 1800);
const MIN_INPUT = num('--min-input', 5000);

const rows = await db.query(`
  SELECT conversation_id cid, id, created_at t, tokens_in tin, cache_hit_tokens hit, cache_miss_tokens miss,
         TIMESTAMPDIFF(SECOND, LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY id), created_at) gap
  FROM usage_stats WHERE kind='round'`);
const big = rows.filter((r) => r.gap != null && Number(r.gap) >= MIN_GAP)
  .map((r) => ({ ...r, gap: Number(r.gap), tin: Number(r.tin), hit: Number(r.hit), miss: Number(r.miss) }));

console.log(`== 全库「相邻两轮间隔 ≥${Math.round(MIN_GAP / 60)} 分钟」的轮次：共 ${big.length} 条 ==`);
const band = (g) => (g < 3600 ? '30–60 分' : g < 7200 ? '1–2 时' : g < 21600 ? '2–6 时' : g < 86400 ? '6–24 时' : g < 172800 ? '1–2 天' : g < 604800 ? '2–7 天' : '≥7 天');
const bands = {};
for (const r of big) {
  const b = band(r.gap); bands[b] = bands[b] || { n: 0, hit: 0, miss: 0, tin: 0 };
  bands[b].n++; bands[b].hit += r.hit; bands[b].miss += r.miss; bands[b].tin += r.tin;
}
console.log('空闲区间        次数   合计命中     合计未命中   合计输入     未命中占输入');
for (const b of ['30–60 分', '1–2 时', '2–6 时', '6–24 时', '1–2 天', '2–7 天', '≥7 天']) {
  const x = bands[b]; if (!x) continue;
  console.log(`${b.padEnd(14)} ${String(x.n).padStart(5)}  ${String(x.hit).padStart(10)}  ${String(x.miss).padStart(11)}  ${String(x.tin).padStart(10)}   ${((x.miss / x.tin) * 100).toFixed(1).padStart(6)}%`);
}

console.log(`\n== 干净样本（间隔 ≥${Math.round(MIN_GAP / 60)} 分 且 输入 ≥${MIN_INPUT}，按空闲时长倒序）==`);
const clean = big.filter((r) => r.tin >= MIN_INPUT).sort((a, b) => b.gap - a.gap);
console.log('会话     空闲时长      输入     命中     未命中   未命中占比   时间');
for (const r of clean.slice(0, 25)) {
  console.log(`${String(r.cid).padEnd(8)} ${((r.gap / 3600).toFixed(1) + ' 时').padStart(9)}  ${String(r.tin).padStart(8)} ${String(r.hit).padStart(8)} ${String(r.miss).padStart(8)}   ${((r.miss / r.tin) * 100).toFixed(1).padStart(6)}%   ${String(r.t).slice(0, 19)}`);
}
const alive = clean.filter((r) => r.miss < r.tin * 0.25);
console.log(`\n  干净样本 ${clean.length} 条，其中"仍命中 ≥75%"的 ${alive.length} 条`);
if (alive.length) {
  const mx = alive.reduce((a, b) => (a.gap > b.gap ? a : b));
  console.log(`  ⇒ 存活最久：会话 ${mx.cid} 空闲 ${(mx.gap / 3600).toFixed(1)} 小时后，输入 ${mx.tin} 只未命中 ${mx.miss}（${((mx.miss / mx.tin) * 100).toFixed(1)}%）`);
}
console.log('  注：这只能证明"缓存能活多久"，**不能**证明"某次冷启动是过期还是前缀变更"——那要靠逐日比对首轮输入量，见方案文档 §2.2。');
process.exit(0);
