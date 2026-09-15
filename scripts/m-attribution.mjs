// scripts/m-attribution.mjs - 只读：把"每轮新增 m"拆开看是谁贡献的（先量后改，不发明阈值）
//
// 口径（为什么这么算）：
//   · m := 该轮 `usage_stats.kind='round'` 的 **cache_miss_tokens** —— "这轮进了请求但没命中缓存的那段"，
//     即每轮新增的权威数字（命中率 = 1 − m/上下文，见《缓存追平DSH-方案》§5.2）。
//   · **必须先分类再看**（第一版没分类，量出"残差占 95%"，与稳态测量矛盾——那是把预期重建算进了新增）：
//       first   该会话第一条 round（没有可命中的上文）
//       segment 与上一轮相比 `prefix_tools_hash`/`prefix_sys_hash` 变了（换段＝预期整段重建）
//       steady  同段衔接（**这才是"每轮新增"的真实口径**）
//   · 稳态轮里，m 由三部分构成：上一轮模型输出（tokens_out_{r-1}）、上一轮工具结果的文本
//     （工具结果下一轮才进请求：落在 usage_{r-1} 与 usage_r 之间那批 tool_calls.result_bytes）、
//     残差（平台注入：运行时快照/尾巴区条目/assistant 的 arguments 回填等）。
//   · 字节→token 沿用仓库既有常数 3.2（toolresult-profile.mjs 同口径），不另造折算率。
//   · **只统计真实会话**（conversation_id > 0）：0/负数是夹具与探针的哨兵会话（C-26 的教训）。
//
// 用法：node scripts/m-attribution.mjs [--days 7] [--top 12]
import { db, pool } from '../server/db.js';

const argv = process.argv.slice(2);
const DAYS = Number(argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 7) || 7;
const TOP = Number(argv.includes('--top') ? argv[argv.indexOf('--top') + 1] : 12) || 12;
const BYTES_PER_TOK = 3.2; // 与 toolresult-profile.mjs 同口径
const tok = (bytes) => Math.round((Number(bytes) || 0) / BYTES_PER_TOK);
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

const rounds = await db.query(
  `SELECT id, conversation_id cid, tokens_in, tokens_out, cache_hit_tokens AS hit, cache_miss_tokens AS miss,
          tokens_in AS tokensIn, prefix_sys_hash sys, prefix_tools_hash tools, created_at
   FROM usage_stats WHERE kind='round' AND conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY
   ORDER BY conversation_id, id`, [DAYS]);
const calls = await db.query(
  `SELECT conversation_id cid, id, tool_name, result_bytes, created_at
   FROM tool_calls WHERE conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY ORDER BY conversation_id, id`, [DAYS]);

const byConv = new Map();
for (const r of rounds) { if (!byConv.has(r.cid)) byConv.set(r.cid, { rounds: [], calls: [] }); byConv.get(r.cid).rounds.push(r); }
for (const c of calls) { if (byConv.has(c.cid)) byConv.get(c.cid).calls.push(c); }

const rows = []; const perTool = new Map(); const top = [];
for (const [cid, g] of byConv) {
  const rs = g.rounds.slice().sort((a, b) => a.id - b.id);
  for (let i = 0; i < rs.length; i++) {
    const cur = rs[i], prev = rs[i - 1];
    const m = Number(cur.miss) || 0;
    const cls = !prev ? 'first' : ((cur.tools !== prev.tools || cur.sys !== prev.sys) ? 'segment' : 'steady');
    const gapMin = prev ? Math.round((new Date(cur.created_at) - new Date(prev.created_at)) / 60000) : null;
    const outTok = prev ? (Number(prev.tokens_out) || 0) : 0;
    let bytes = 0; const names = [];
    if (prev) for (const c of g.calls) if (c.created_at > prev.created_at && c.created_at <= cur.created_at) { bytes += Number(c.result_bytes) || 0; names.push(c); }
    const toolTok = tok(bytes);
    rows.push({ cid, round: i + 1, cls, m, outTok, toolTok, resid: m - outTok - toolTok, bytes, gapMin });
    if (cls === 'steady') for (const c of names) {
      const e = perTool.get(c.tool_name) || { n: 0, bytes: 0 };
      e.n++; e.bytes += Number(c.result_bytes) || 0; perTool.set(c.tool_name, e);
      top.push({ cid, tool: c.tool_name, bytes: Number(c.result_bytes) || 0 });
    }
  }
}

console.log(`窗口：近 ${DAYS} 天 · 真实会话（conversation_id>0）· 轮数 ${fmt(rows.length)}（会话 ${fmt(byConv.size)}）`);
console.log(`字节→token 折算 ${BYTES_PER_TOK}（与 toolresult-profile.mjs 同口径）\n`);
if (!rows.length) { console.log('窗口内没有可归因的轮。'); await pool.end(); process.exit(0); }

const clsOf = (k) => rows.filter((r) => r.cls === k);
console.log('== ① 先分类：每轮新增 m（tokens）按轮次性质分开看 ==');
for (const k of ['first', 'segment', 'steady']) {
  const g = clsOf(k); if (!g.length) continue;
  const M = g.map((r) => r.m);
  const why = k === 'first' ? '没有可命中的上文，m≈整段上下文（正常）'
    : k === 'segment' ? '换段/换面（预期整段重建，只在动工具面或系统提示时出现）'
      : '**这才是"每轮新增"的真实口径**';
  console.log(`  ${k.padEnd(8)} 轮数 ${String(g.length).padStart(5)}  m 中位 ${fmt(med(M)).padStart(7)}  P90 ${fmt(pct(M, 0.9)).padStart(7)}  均值 ${fmt(avg(M)).padStart(8)}  ← ${why}`);
}

const S = clsOf('steady');
if (S.length) {
  // ⑥ 先看"是不是整段重建"：miss/tokens_in 接近 1 就是整段重建（缓存过期/换段/首轮），不是"新增"
  const rate = (r) => (r.tokensIn > 0 ? r.m / r.tokensIn : 0);
  // 空闲间隔**分档描述**（不设阈值、不判定）：看缓存到底在哪个档位断掉
  const BANDS = [[0, 1, '<1 分钟'], [1, 5, '1–5 分钟'], [5, 30, '5–30 分钟'], [30, 120, '0.5–2 小时'], [120, 720, '2–12 小时'], [720, Infinity, '>12 小时']];
  console.log('== ② 稳态轮里，m 与"空闲间隔"的关系（描述性分档，不设阈值）==');
  console.log('  空闲间隔        轮数    m 中位     m P90   未命中占本轮输入(中位)   读法');
  for (const [lo, hi, label] of BANDS) {
    const g = S.filter((r) => r.gapMin != null && r.gapMin >= lo && r.gapMin < hi);
    if (!g.length) continue;
    const M = g.map((r) => r.m), RR = g.map((r) => rate(r));
    const rmed = med(RR);
    console.log(`  ${label.padEnd(14)} ${String(g.length).padStart(5)} ${fmt(med(M)).padStart(9)} ${fmt(pct(M, 0.9)).padStart(9)}   ${(rmed * 100).toFixed(0).padStart(6)}%               ${rmed > 0.8 ? '≈整段重建（缓存已失效）' : rmed < 0.2 ? '真·增量（前缀仍命中）' : '部分失效'}`);
  }
  const whole = S.filter((r) => rate(r) > 0.8).length;
  console.log(`\n  ⇒ 稳态轮里"其实发生了整段重建"的：${fmt(whole)}/${fmt(S.length)}（${((whole / S.length) * 100).toFixed(0)}%）`);
  const tight = S.filter((r) => r.gapMin != null && r.gapMin < 5 && rate(r) <= 0.8);
  console.log(`  ⇒ 紧凑衔接（<5 分钟）且未整段重建的轮：${fmt(tight.length)} 轮 —— **只看这批，才是"每轮新增"的干净样本**`);

  const M = S.map((r) => r.m), T = S.map((r) => r.toolTok), O = S.map((r) => r.outTok), R = S.map((r) => r.resid);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const share = (a) => ((sum(a) / sum(M)) * 100).toFixed(0) + '%';
  console.log('\n== ③ 稳态轮的 m 构成（tokens；含整段重建轮，故残差被抬高）==');
  console.log(`  m（每轮新增）        中位 ${fmt(med(M)).padStart(7)}  P90 ${fmt(pct(M, 0.9)).padStart(7)}  占比 100%`);
  console.log(`  ├─ 工具结果          中位 ${fmt(med(T)).padStart(7)}  P90 ${fmt(pct(T, 0.9)).padStart(7)}  占比 ${share(T)}`);
  console.log(`  ├─ 上一轮模型输出    中位 ${fmt(med(O)).padStart(7)}  P90 ${fmt(pct(O, 0.9)).padStart(7)}  占比 ${share(O)}`);
  console.log(`  └─ 残差（含整段重建）中位 ${fmt(med(R)).padStart(7)}  P90 ${fmt(pct(R, 0.9)).padStart(7)}  占比 ${share(R)}`);

  if (tight.length) {
    const M2 = tight.map((r) => r.m), T2 = tight.map((r) => r.toolTok), O2 = tight.map((r) => r.outTok), R2 = tight.map((r) => r.resid);
    const share2 = (a) => ((sum(a) / sum(M2)) * 100).toFixed(0) + '%';
    console.log('\n== ④ 干净样本（<5 分钟衔接且未整段重建）的构成 ==');
    console.log(`  m                    中位 ${fmt(med(M2)).padStart(7)}  P90 ${fmt(pct(M2, 0.9)).padStart(7)}  占比 100%`);
    console.log(`  ├─ 工具结果          中位 ${fmt(med(T2)).padStart(7)}  P90 ${fmt(pct(T2, 0.9)).padStart(7)}  占比 ${share2(T2)}`);
    console.log(`  ├─ 上一轮模型输出    中位 ${fmt(med(O2)).padStart(7)}  P90 ${fmt(pct(O2, 0.9)).padStart(7)}  占比 ${share2(O2)}`);
    console.log(`  └─ 残差（平台注入等）中位 ${fmt(med(R2)).padStart(7)}  P90 ${fmt(pct(R2, 0.9)).padStart(7)}  占比 ${share2(R2)}`);
  }

  console.log('\n== ⑤ 稳态轮里工具结果的贡献排行 ==');
  const toolRows = [...perTool.entries()].map(([name, e]) => ({ name, ...e, t: tok(e.bytes) })).sort((a, b) => b.t - a.t).slice(0, 12);
  if (!toolRows.length) console.log('  （稳态轮里没有工具结果——说明这段窗口的轮次多为无工具的对话轮）');
  for (const r of toolRows) console.log(`  ${String(r.name).padEnd(20)} 次数 ${String(r.n).padStart(6)}  合计 ${fmt(r.t).padStart(9)} tok  均次 ${fmt(Math.round(r.t / r.n)).padStart(6)} tok`);

  console.log('\n== ④ 最重的单次结果（稳态轮）==');
  const tops = top.sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
  if (!tops.length) console.log('  （无）');
  for (const r of tops) console.log(`  ${String(r.tool).padEnd(18)} ${fmt(r.bytes).padStart(9)} 字节 ≈ ${fmt(tok(r.bytes)).padStart(7)} tok  conv=${r.cid}`);

  const big = S.filter((r) => r.resid > 1000).length;
  console.log(`\n== ⑤ 结论指向 ==\n  残差 > 1000 tok 的稳态轮：${fmt(big)}/${fmt(S.length)}（${((big / S.length) * 100).toFixed(0)}%）`);
  console.log(`  工具结果 > 模型输出的稳态轮：${((S.filter((r) => r.toolTok > r.outTok).length / S.length) * 100).toFixed(0)}%`);
  console.log('  读法：残差高 ⇒ 先查平台注入（尾巴区/快照/arguments 回填）；工具结果高 ⇒ 先整形工具结果。');
}
await pool.end();
