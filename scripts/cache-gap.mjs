// scripts/cache-gap.mjs - RA-35（DSH 口径）缺口归因：改造后的轮里，未命中到底是什么
// 口径（与 DSH 右下角一致）：**单次请求** 命中率 = hit/(hit+miss)。
// 本脚本只在**改造后窗口**内取轮次，并把每轮的未命中拆到可归因的来源上：
//   · 是否该会话/该段的**首个请求**（首轮必然把系统提示+工具面全量算作未命中——这份前缀之前没被这个会话用过）
//   · 该轮调了哪些工具、工具结果多大（result_bytes）
//   · 上一轮模型输出多大（上一轮 output → 本轮 input，必然 new）
// 用法：node scripts/cache-gap.mjs [--cutoff 'YYYY-MM-DD HH:MM:SS']
import { db } from '../server/db.js';
import { REAL_WHERE } from './cohort.mjs';

const argv = process.argv.slice(2);
const CUTOFF = argv.includes('--cutoff') ? argv[argv.indexOf('--cutoff') + 1] : '2026-09-15 05:00:00';
const q = async (s) => { try { return await db.query(s); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

// 逐轮（限定窗口）
const rounds = await q(`SELECT u.id uid, u.conversation_id cid, c.title, u.cache_hit_tokens hit, u.cache_miss_tokens miss,
                               u.tokens_in tin, u.tokens_out tout, u.created_at
                        FROM usage_stats u JOIN conversations c ON c.id=u.conversation_id
                        WHERE u.kind='round' AND (u.cache_hit_tokens+u.cache_miss_tokens)>0
                          AND u.created_at >= '${CUTOFF}' AND (${REAL_WHERE('u')})
                        ORDER BY u.id`);
console.log(`窗口：${CUTOFF} 起（真实流量、且有计费 token）`);
if (!rounds.length || rounds[0].__err) { console.log('（无数据）' + (rounds[0] && rounds[0].__err ? ' ' + rounds[0].__err : '')); process.exit(0); }

// 取每轮的工具轨迹：用 tool_calls 的时间邻近归属（同一会话、时间在轮开始前的 3 分钟内）
const detail = [];
for (const [i, r] of rounds.entries()) {
  const tools = await q(`SELECT tool_name, status, result_bytes, duration_ms, created_at FROM tool_calls
                         WHERE conversation_id=${r.cid} AND created_at <= '${new Date(new Date(r.created_at).getTime() + 1000).toISOString().slice(0, 19).replace('T', ' ')}'
                         ORDER BY id DESC LIMIT 6`);
  // 上一轮（同会话前一条 round）的输出
  const prev = rounds[i - 1] && rounds[i - 1].cid === r.cid ? rounds[i - 1] : null;
  const isFirstOfConv = !prev;
  const rate = Number(r.hit) / (Number(r.hit) + Number(r.miss));
  detail.push({ ...r, tools, isFirstOfConv, prevOut: prev ? Number(prev.tout) : 0, rate });
}

console.log('\n轮次明细（改造后真实流量）：');
console.log('  会话       时间      命中率   未命中   上轮输出  工具数  工具结果字节  首轮?  标题');
for (const d of detail) {
  const tb = d.tools.reduce((a, t) => a + Number(t.result_bytes || 0), 0);
  console.log(`  ${String(d.cid).padEnd(6)} ${String(d.created_at).slice(11, 19)} ${pct(d.rate).padStart(8)} ${String(d.miss).padStart(8)} ${String(d.prevOut).padStart(8)} ${String(d.tools.length).padStart(6)} ${String(tb).padStart(12)}  ${d.isFirstOfConv ? '是  ' : '    '} ${String(d.title).slice(0, 20)}`);
}

const rates = detail.map((d) => d.rate).sort((a, b) => a - b);
const P = (x) => rates[Math.min(rates.length - 1, Math.ceil(x * rates.length) - 1)];
const missSum = detail.reduce((a, d) => a + Number(d.miss), 0);
const hitSum = detail.reduce((a, d) => a + Number(d.hit), 0);
console.log(`\n合计：${detail.length} 轮 · 单请求命中率 中位 ${pct(P(0.5))} · P90 ${pct(P(0.9))} · 最好 ${pct(rates[rates.length - 1])} · 最差 ${pct(rates[0])}`);
console.log(`      累计口径（会被历史稀释）：${pct(hitSum / (hitSum + missSum))}`);

// 归因：把未命中按来源拆
const firsts = detail.filter((d) => d.isFirstOfConv);
const rest = detail.filter((d) => !d.isFirstOfConv);
const sum = (arr, k) => arr.reduce((a, d) => a + Number(d[k]), 0);
console.log('\n== 归因 ==');
console.log(`  ① 该会话首个请求：${firsts.length} 轮，未命中合计 ${fmt(sum(firsts, 'miss'))}（占 ${pct(sum(firsts, 'miss') / missSum)}）← 前缀只在这个会话里第一次用，必然全量计费`);
console.log(`  ② 会话内后续轮：${rest.length} 轮，未命中合计 ${fmt(sum(rest, 'miss'))}（占 ${pct(sum(rest, 'miss') / missSum)}）`);
if (rest.length) {
  const m = rest.map((d) => Number(d.miss)).sort((a, b) => a - b);
  const Mr = (x) => m[Math.min(m.length - 1, Math.ceil(x * m.length) - 1)];
  console.log(`     其中未命中 中位 ${fmt(Mr(0.5))} · P90 ${fmt(Mr(0.9))} · 最大 ${fmt(m[m.length - 1])}`);
  const toolBytes = sum(rest, 'miss') ? rest.reduce((a, d) => a + d.tools.reduce((x, t) => x + Number(t.result_bytes || 0), 0), 0) : 0;
  console.log(`     这些轮的工具结果合计 ${fmt(toolBytes)} 字节 ≈ ${fmt(Math.round(toolBytes / 3.2))} tokens（按 3.2 字节/token 粗估）`);
  console.log(`     ⇒ 若"未命中≈工具结果 + 用户消息 + 上轮回复"，则工具结果解释了约 ${pct(Math.min(1, (toolBytes / 3.2) / sum(rest, 'miss')))} 的后续轮未命中`);
}
process.exit(0);
