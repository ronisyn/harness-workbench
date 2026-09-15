// scripts/cache-perrequest.mjs - 按**单次请求**口径算缓存命中率（与 DSH 右下角那个数同口径）
// 为什么必须换口径：DSH 显示的是"这次请求的输入里有多少 token 从缓存读"，
//   而 baseline-cost / c1-* 系列算的是"整个会话累计命中/(累计命中+累计未命中)"——
//   后者把第一轮的全量输入、以及每一轮的工具结果都留在分母里，**天然比前者低一个量级**，两者不可比。
// 本脚本用**每轮**为单位给分布：中位/P90/P95 + 最好的轮 + 最差的轮，并给出"最差那几轮的成因"。
// 用法：node scripts/cache-perrequest.mjs [--cutoff 'YYYY-MM-DD HH:MM:SS']
import { db } from '../server/db.js';
import { REAL_WHERE, PROBE_WHERE } from './cohort.mjs';

const argv = process.argv.slice(2);
const CUTOFF = argv.includes('--cutoff') ? argv[argv.indexOf('--cutoff') + 1] : null;
const q = async (s, p = []) => { try { return await db.query(s, p); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

const where = CUTOFF ? `AND u.created_at >= '${CUTOFF}'` : '';
console.log(`口径：**每轮（每次模型请求）** 命中率 = hit/(hit+miss)${CUTOFF ? `　窗口：${CUTOFF} 起` : '　窗口：全量'}`);

for (const [label, w] of [['真实流量', REAL_WHERE('u')], ['探针', PROBE_WHERE('u')]]) {
  const rows = await q(`SELECT u.conversation_id cid, c.title, u.cache_hit_tokens hit, u.cache_miss_tokens miss,
                               (u.cache_hit_tokens + u.cache_miss_tokens) tot, u.tokens_in, u.created_at
                        FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                        WHERE u.kind='round' AND (u.cache_hit_tokens + u.cache_miss_tokens) > 0 AND (${w}) ${where}
                        ORDER BY u.id`);
  if (!rows.length || rows[0].__err) { console.log(`\n${label}：（无数据）`); continue; }
  const rates = rows.map((r) => Number(r.hit) / Number(r.tot)).sort((a, b) => a - b);
  const p = (x) => rates[Math.min(rates.length - 1, Math.max(0, Math.ceil(x * rates.length) - 1))];
  const aggH = rows.reduce((a, r) => a + Number(r.hit), 0), aggT = rows.reduce((a, r) => a + Number(r.tot), 0);
  console.log(`\n== ${label}（${fmt(rows.length)} 轮）==`);
  console.log(`  单轮命中率分布：中位 ${pct(p(0.5))} · P75 ${pct(p(0.75))} · P90 ${pct(p(0.9))} · P95 ${pct(p(0.95))} · 最好 ${pct(rates[rates.length - 1])} · 最差 ${pct(rates[0])}`);
  console.log(`  累计口径（对照，会被历史稀释）：${pct(aggH / aggT)}`);
  const over995 = rates.filter((x) => x >= 0.995).length;
  const over99 = rates.filter((x) => x >= 0.99).length;
  console.log(`  ≥99.5% 的轮：${over995}/${rates.length}（${((over995 / rates.length) * 100).toFixed(0)}%）· ≥99% 的轮：${over99}/${rates.length}（${((over99 / rates.length) * 100).toFixed(0)}%）`);
  console.log('  最差 5 轮（这些才是要治的）：');
  for (const r of [...rows].sort((a, b) => (a.hit / a.tot) - (b.hit / b.tot)).slice(0, 5)) {
    console.log(`    conv=${String(r.cid).padEnd(5)} ${String(r.created_at).slice(11, 19)} 命中率 ${pct(r.hit / r.tot).padStart(7)}  命中 ${String(r.hit).padStart(7)} / 未命中 ${String(r.miss).padStart(6)} / 输入 ${String(r.tokens_in).padStart(7)}  ${String(r.title).slice(0, 22)}`);
  }
}
process.exit(0);
