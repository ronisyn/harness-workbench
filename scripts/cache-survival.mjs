// scripts/cache-survival.mjs - 只读：缓存随"轮间隔"的存活曲线（回答"空闲多久前缀就失效"）
// 口径：同一会话内相邻两轮，间隔 Δt 秒；看后一轮的**单请求命中率**随 Δt 的分布。
//   若存在明确拐点（如 Δt>阈值 后命中率塌到很低），那就是厂商侧的缓存存活窗口。
// 注意：只统计"同一会话内相邻轮"，且命中率用该轮自身的 hit/(hit+miss)。
// 用法：node scripts/cache-survival.mjs
import { db } from '../server/db.js';

const q = async (s) => { try { return await db.query(s); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

const rows = await q(`SELECT u.conversation_id cid, u.id, u.cache_hit_tokens hit, u.cache_miss_tokens miss,
                             u.tokens_in tin, u.created_at
                      FROM usage_stats u
                      WHERE u.kind='round' AND (u.cache_hit_tokens + u.cache_miss_tokens) > 0
                      ORDER BY u.conversation_id, u.id`);

// 组装 (Δt, 命中率) 样本
const pairs = [];
let prev = null;
for (const r of rows) {
  if (prev && prev.cid === r.cid) {
    const dt = Math.round((new Date(r.created_at).getTime() - new Date(prev.created_at).getTime()) / 1000);
    if (dt >= 0) pairs.push({ dt, rate: Number(r.hit) / (Number(r.hit) + Number(r.miss)), miss: Number(r.miss), cid: r.cid, at: r.created_at });
  }
  prev = r;
}
console.log(`样本：同会话相邻轮 ${fmt(pairs.length)} 对\n`);

const BUCKETS = [
  ['≤10s', 0, 10], ['10–60s', 10, 60], ['1–5min', 60, 300], ['5–10min', 300, 600],
  ['10–30min', 600, 1800], ['30–60min', 1800, 3600], ['1–6h', 3600, 21600], ['>6h', 21600, Infinity],
];
console.log('间隔分桶     样本   命中率 中位   命中率 均值   P10      未命中 中位');
for (const [label, lo, hi] of BUCKETS) {
  const s = pairs.filter((p) => p.dt > lo && p.dt <= hi);
  if (!s.length) { console.log(`  ${label.padEnd(10)} ${String(0).padStart(5)}   （无样本）`); continue; }
  const rates = s.map((x) => x.rate).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)];
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const p10 = rates[Math.floor(rates.length * 0.1)];
  const misses = s.map((x) => x.miss).sort((a, b) => a - b);
  console.log(`  ${label.padEnd(10)} ${String(s.length).padStart(5)}   ${pct(med).padStart(8)}      ${pct(avg).padStart(8)}     ${pct(p10).padStart(7)}   ${fmt(misses[Math.floor(misses.length / 2)])}`);
}

console.log('\n== 改造后窗口（2026-09-15 05:00 起）单独看 ==');
const recent = pairs.filter((p) => new Date(p.at).getTime() >= new Date('2026-09-15T05:00:00+08:00').getTime());
console.log(`  样本 ${fmt(recent.length)} 对；命中率 ≥95% 的占 ${pct(recent.filter((p) => p.rate >= 0.95).length / Math.max(1, recent.length))}`);
for (const [label, lo, hi] of BUCKETS) {
  const s = recent.filter((p) => p.dt > lo && p.dt <= hi);
  if (!s.length) continue;
  const rates = s.map((x) => x.rate).sort((a, b) => a - b);
  console.log(`  ${label.padEnd(10)} n=${String(s.length).padStart(4)}  中位 ${pct(rates[Math.floor(rates.length / 2)])}   最小 ${pct(rates[0])}`);
}
process.exit(0);
