// scripts/c1c2-forensics.mjs - RA-35 C1 / C2-P95 的**轮次级归因**（只读，可复跑）
//
// ── 为什么需要它 ───────────────────────────────────────────────────────────────
// `scripts/ra35-report.mjs` 只给"新段真实流量 = 50 轮 / C1 84.24% / P95 7,163"这**一个**数，
// 回答不了"差在哪几轮、为什么"。而这两个指标都是**尾部敏感**的：
//   · C1 是 hit/(hit+miss) 的比 ⇒ 一轮 m≈10k 的重建轮就能吃掉几十个稳态轮的质量；
//   · P95 在小样本上取的是**第 floor(n×0.95) 名** ⇒ n=50 时它等于**第 4 名**，一个尾部轮就定死了读数。
// 所以必须先落到"哪一轮、为什么"，再决定要不要改代码（目标驱动：先量后改）。
//
// ── 分类口径（全部沿用仓库既有信号，不发明阈值）──────────────────────────────────
//   first     该会话在本窗口的第一轮（没有可命中的上文；对应 C5 的 `first-round` 豁免）
//   face      该轮 (sys,tools) 指纹与同会话上一轮不同 —— 与 `scripts/m-attribution.mjs` 的 `segment` 判据**同一句**
//   epoch-gap 上一轮与本轮之间落了一行 `prefix:epoch-change` 账本（= 这中间发生过一次部署/换纪元）
//   nofp      上一轮存在，但指纹列不全 ⇒ **机检判不了**（如实标出，不拿"m 大"倒推成因）
//   steady    以上都不是（同段衔接）
// 另外有一条**形状判据**（不是新阈值，是既有 COLD 的用法）：`prefix-attribution.mjs` 的 `--cold 3000` 默认值
//   用来圈"冷启动候选轮"；这里把它与"输入几乎没变"合起来用：
//       m ≥ 3000 **且** |本轮回输入 − 上一轮输入| < m/2  ⇒ 输入没长多少却有一大段没命中 ⇒ **前缀被打破**
//   （若只是"新增长出来"，m 应当 ≈ 输入增量；这条判据正是"整段重建"与"真增量"的分界，阈值只有既有的 3000）
//
// ⚠️ `prefix:epoch-change` 账本 2026-09-15 20:44 才上线、`prefix_sys_hash/prefix_tools_hash` 更晚
//    （真实会话从 09-15 19:46 起才有）。**在它们之前的轮次，换纪元在机检上是看不见的** —— 本脚本如实打印
//    `nofp` 计数与逐轮的"形状判据 + 部署时间线"证据，不把"看不见"写成"没发生"。
//
// ── 分层（每层都打印轮数；<30 轮按既有判据写"不可判"，见 ra35-report.mjs 的 realRounds<30 那条）────
//   L0 官方口径        ＝ cohort.js 的 REAL_WHERE（探针/孤儿已排除）
//   L1 L0 − 机检可证的换纪元轮（face / epoch-gap）
//   L2 L1 − 形状判据判出的"前缀被打破"轮
//   L3 L2 − **口径外自造会话**（rw-run: / RW_STORAGE 探针 / MCP: / RA35样本-）
//   S1 L0 − 3 个 rw-run 单轮哨兵（C2-P95 的尾部就是它们）
//   S2 L0 − 全部口径外自造会话
// ⚠️ "口径外自造会话"这一层**不是 cohort 口径**：探针/哨兵的唯一口径仍是 `server/cohort.js`，本脚本一行都没另写；
//    它只是"这几条会话是我们自己为验证而发起"这一事实的敏感性分析（标题族见下，id 会打印出来可核）。
//
// 用法：node scripts/c1c2-forensics.mjs
import { db, pool } from '../server/db.js';
import { REAL_WHERE, HUMAN_WHERE, SAMPLE_WHERE } from './cohort.mjs';

const CUTOFF = process.env.RA35_CUTOFF || '2026-09-15 05:00:00';
const COLD = 3000; // ← prefix-attribution.mjs 的 --cold 既有默认值，原样引用（不另设线）
const q = async (s, p = []) => { try { return await db.query(s, p); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');
const ts = (d) => { if (!d) return '-'; const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`; };
// 与 ra35-report.mjs 的 SQL 同一算式（rn=GREATEST(1,FLOOR(c*p))，1-based）——换算式会让"复跑对不上"
const perc = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.max(1, Math.floor(s.length * p)) - 1]; };
const stat = (rows) => {
  const hit = rows.reduce((a, r) => a + Number(r.hit || 0), 0);
  const miss = rows.reduce((a, r) => a + Number(r.miss || 0), 0);
  const ms = rows.map((r) => Number(r.miss) || 0);
  return { n: rows.length, convs: new Set(rows.map((r) => r.cid)).size, hit, miss, c1: (hit + miss) > 0 ? hit / (hit + miss) : null, p50: perc(ms, 0.50), p95: perc(ms, 0.95) };
};
const verdict = (s) => (s.n < 30
  ? `**不可判**（轮数 ${s.n} < 30；判据沿用 ra35-report.mjs「新段真实流量 <30 轮 ⇒ 任何读数都会被单会话/单轮噪声主导」）`
  : `C1 ${pct(s.c1)} ${s.c1 >= 0.99 ? '达标' : '**未达标**'} · C2 中位 ${fmt(s.p50)} ${s.p50 != null && s.p50 <= 1000 ? '达标' : '**未达标**'} · P95 ${fmt(s.p95)} ${s.p95 != null && s.p95 <= 5000 ? '达标' : '**未达标**'}`);

console.log('== RA-35 C1 / C2-P95 轮次级归因（只读）==');
console.log(`切段：u.created_at >= '${CUTOFF}'（库本地时间，RA35_CUTOFF 可覆盖）· 口径：cohort.js 的 REAL_WHERE`);
console.log('判据（v0.3 §0.3）：C1 ≥ 99% · C2 中位 ≤ 1,000 · P95 ≤ 5,000\n');

// ── 数据 ─────────────────────────────────────────────────────────────────────
const rounds = await q(`
  SELECT u.id, u.conversation_id cid, c.title, c.permission perm, u.created_at t,
         u.tokens_in tin, u.tokens_out tout, u.cache_hit_tokens hit, u.cache_miss_tokens miss,
         u.prefix_sys_hash sys, u.prefix_tools_hash tools,
         TIMESTAMPDIFF(SECOND, (SELECT MAX(v.created_at) FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id), u.created_at) gap,
         (SELECT v.tokens_in FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id ORDER BY v.id DESC LIMIT 1) prev_tin,
         (SELECT v.prefix_sys_hash FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id ORDER BY v.id DESC LIMIT 1) prev_sys,
         (SELECT v.prefix_tools_hash FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id ORDER BY v.id DESC LIMIT 1) prev_tools
  FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
  WHERE u.kind='round' AND u.created_at >= '${CUTOFF}' AND ${REAL_WHERE('u')}
  ORDER BY u.conversation_id, u.id`);
if (rounds.length && rounds[0].__err) { console.log('查询失败：' + rounds[0].__err); await pool.end(); process.exit(1); }
const epochs = (await q(`SELECT id, detail, created_at t FROM audit_log WHERE action='prefix:epoch-change' AND created_at >= '${CUTOFF}' ORDER BY id`)).filter((x) => !x.__err);
// 口径外自造会话：标题族 + cohort 既有的样本档（SAMPLE_WHERE 是既有实现，不是本脚本发明的）
const selfMade = new Map();
for (const r of await q(`SELECT DISTINCT u.conversation_id cid, c.title FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                         WHERE u.kind='round' AND u.created_at >= '${CUTOFF}' AND ${REAL_WHERE('u')}
                           AND (c.title LIKE 'rw-run:%' OR c.title LIKE 'RW_STORAGE 探针%' OR c.title LIKE 'MCP:%' OR ${SAMPLE_WHERE('u')})`))
  if (!r.__err) selfMade.set(Number(r.cid), String(r.title));

// ── 逐轮分类 ─────────────────────────────────────────────────────────────────
const byC = new Map();
for (const r of rounds) { if (!byC.has(r.cid)) byC.set(r.cid, []); byC.get(r.cid).push(r); }
const clsOf = new Map(); // id -> {cls, why}
for (const [, list] of byC) {
  for (let i = 0; i < list.length; i++) {
    const r = list[i], prev = list[i - 1];
    if (!prev) { clsOf.set(r.id, { cls: 'first', why: '本会话在本窗口的第一轮（C5 first-round 豁免）' }); continue; }
    const fpKnown = r.sys != null && r.tools != null && prev.sys != null && prev.tools != null;
    const faceChanged = fpKnown && (r.sys !== prev.sys || r.tools !== prev.tools);
    const hit = (epochs || []).filter((e) => new Date(e.t) > new Date(prev.t) && new Date(e.t) <= new Date(r.t));
    if (faceChanged) clsOf.set(r.id, { cls: 'face', why: `前缀面变了：sys ${prev.sys}→${r.sys} / tools ${prev.tools}→${r.tools}` });
    else if (hit.length) clsOf.set(r.id, { cls: 'epoch-gap', why: `两次之间落 ${hit.length} 行 prefix:epoch-change（${ts(hit[0].t)} 起：${String(hit[0].detail).slice(0, 58)}）` });
    else if (!fpKnown) clsOf.set(r.id, { cls: 'nofp', why: `指纹列不全（本轮 sys=${r.sys} tools=${r.tools}）⇒ 机检判不了` });
    else clsOf.set(r.id, { cls: 'steady', why: '同段衔接（只追加）' });
  }
}
// 形状判据：输入没长多少（或变小）却有一大段未命中 ⇒ 前缀被打破，不是"新增长出来"
const shapeBreak = (r) => r.prev_tin != null && Number(r.miss) >= COLD && Math.abs(Number(r.tin) - Number(r.prev_tin)) < Number(r.miss) / 2;

// ── 输出 ①：逐轮明细 ────────────────────────────────────────────────────────
console.log('== ① 逐轮明细（C1 视角）==');
console.log('轮id    会话   时间            输入     命中      m     C1      间隔s  类别      判据/原因');
for (const r of rounds) {
  const c = clsOf.get(r.id);
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  const shape = shapeBreak(r) ? ` ★前缀被打破（m≥${COLD} 且 |Δ输入|=${fmt(Math.abs(Number(r.tin) - Number(r.prev_tin)))} < m/2=${fmt(Math.round(Number(r.miss) / 2))}）` : '';
  console.log(`${String(r.id).padEnd(7)} ${String(r.cid).padEnd(6)} ${ts(r.t)} ${fmt(r.tin).padStart(8)} ${fmt(r.hit).padStart(8)} ${fmt(r.miss).padStart(7)} ${(c1 == null ? '-' : (c1 * 100).toFixed(2) + '%').padStart(7)} ${String(r.gap).padStart(6)}  ${c.cls.padEnd(9)} ${c.why}${shape}`);
}

// ── 输出 ②：C1 分类占比 ─────────────────────────────────────────────────────
console.log('\n== ② C1 缺口的分类占比（分母 = 本口径未命中总量）==');
const totalMiss = rounds.reduce((a, r) => a + Number(r.miss || 0), 0);
const tally = new Map();
for (const r of rounds) { const k = (shapeBreak(r) ? 'shape-break' : clsOf.get(r.id).cls); const e = tally.get(k) || { n: 0, miss: 0 }; e.n++; e.miss += Number(r.miss) || 0; tally.set(k, e); }
for (const [k, e] of [...tally.entries()].sort((a, b) => b[1].miss - a[1].miss))
  console.log(`  ${k.padEnd(12)} 轮 ${String(e.n).padStart(3)}  未命中 ${fmt(e.miss).padStart(8)}  占未命中 ${pct(totalMiss ? e.miss / totalMiss : null)}  占轮数 ${pct(rounds.length ? e.n / rounds.length : null)}`);
console.log(`  合计未命中 ${fmt(totalMiss)} · 轮数 ${rounds.length}（shape-break 覆盖了下面分层的 L1→L2 差额）`);

// ── 输出 ③：部署时间线（两份证据，各自说清覆盖范围）───────────────────────────
console.log('\n== ③ 部署时间线（用于判"这轮的重建是不是我们自己部署造成的"）==');
console.log(`  证据 A：prefix:epoch-change 账本（${epochs.length} 行；⚠️ 本机制 09-15 20:44 才上线，之前为空）`);
for (const e of epochs.slice(0, 6)) console.log(`    #${e.id} ${ts(e.t)} ${String(e.detail).slice(0, 100)}`);
if (epochs.length > 6) console.log(`    …… 其余 ${epochs.length - 6} 行见 node scripts/prefix-attribution.mjs`);
console.log('  证据 B：真实会话**自己输出里记录的 HEAD**（样本任务每轮跑 `git log`，于是它的回复把当时的部署版本记进了库；09-15 17:06 起才有）');
for (const m of await q(`SELECT conversation_id cid, id, created_at t, content FROM messages
                         WHERE conversation_id IN (SELECT DISTINCT u.conversation_id FROM usage_stats u WHERE u.kind='round' AND u.created_at >= '${CUTOFF}' AND ${REAL_WHERE('u')})
                           AND role='assistant' ORDER BY created_at`)) {
  if (m.__err) break;
  const h = /HEAD=\`?([0-9a-f]{7,9})/.exec(String(m.content)) || /最新提交\s*\`([0-9a-f]{7,9})\`/.exec(String(m.content));
  if (h) console.log(`    conv=${String(m.cid).padEnd(5)} ${ts(m.t)} msg#${String(m.id).padEnd(5)} 自报 HEAD=${h[1]}`);
}

// ── 输出 ④：分层读数 ────────────────────────────────────────────────────────
console.log('\n== ④ 分层读数（每层同一算式；<30 轮判"不可判"）==');
const isMachineEpoch = (r) => ['face', 'epoch-gap'].includes(clsOf.get(r.id).cls);
const L0 = rounds;
const L1 = rounds.filter((r) => !isMachineEpoch(r));
const L2 = L1.filter((r) => !shapeBreak(r));
const L3 = L2.filter((r) => !selfMade.has(Number(r.cid)));
const S1 = rounds.filter((r) => !(String(r.title || '').startsWith('rw-run:')));
const S2 = rounds.filter((r) => !selfMade.has(Number(r.cid)));
const human = await q(`SELECT u.id, u.conversation_id cid, c.title, u.created_at t, u.tokens_in tin, u.tokens_out tout,
                              u.cache_hit_tokens hit, u.cache_miss_tokens miss
                       FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                       WHERE u.kind='round' AND u.created_at >= '${CUTOFF}' AND ${HUMAN_WHERE('u')} ORDER BY u.id`);
const humanNoSelf = (human || []).filter((r) => !r.__err && !selfMade.has(Number(r.cid)));
const layers = [
  ['L0 官方口径（cohort.js REAL_WHERE）', L0],
  ['L1 L0 − 机检可证的换纪元轮（face/epoch-gap）', L1],
  ['L2 L1 − 形状判据"前缀被打破"轮', L2],
  ['L3 L2 − 口径外自造会话', L3],
  ['S1 L0 − 3 个 rw-run 单轮哨兵（P95 尾部）', S1],
  ['S2 L0 − 全部口径外自造会话', S2],
  ['参考：cohort 人发起档（HUMAN_WHERE，含样本）', human],
  ['参考：人发起档 − 口径外自造会话', humanNoSelf],
];
for (const [label, rows] of layers) {
  const s = stat((rows || []).filter((r) => r && !r.__err));
  console.log(`  ${label}`);
  console.log(`     轮 ${String(s.n).padStart(3)} · 会话 ${String(s.convs).padStart(2)} · 命中 ${fmt(s.hit).padStart(9)} / 未命中 ${fmt(s.miss).padStart(8)} → ${verdict(s)}`);
}
console.log(`  （"口径外自造会话"＝ ${[...selfMade.entries()].map(([c, t]) => `conv=${c}《${String(t).slice(0, 14)}》`).join(' / ')}`);
console.log('    按 server/cohort.js 的口径它们**仍属真实流量**（标题不在探针命名族、也没有"已删除会话的 prefix 账本"）；');
console.log('    这一层只是"这些轮是我们自己发起"的敏感性分析，不是新口径，也不改 cohort.js）');

// ── 输出 ⑤：C2-P95 尾部逐条 + 构成 ─────────────────────────────────────────
console.log('\n== ⑤ C2（每轮新增 m）尾部逐条 + 构成 ==');
const rank95 = Math.max(1, Math.floor(rounds.length * 0.95));
console.log(`  P95 口径与 ra35-report 一致（第 floor(n×0.95) 名；n=${rounds.length} ⇒ 第 ${rank95} 名 = 降序第 ${rounds.length - rank95 + 1} 大）`);
const calls = await q(`SELECT conversation_id cid, created_at t, tool_name, result_bytes FROM tool_calls WHERE created_at >= '${CUTOFF}' ORDER BY conversation_id, id`);
const byCall = new Map();
for (const c of calls) { if (!byCall.has(c.cid)) byCall.set(c.cid, []); byCall.get(c.cid).push(c); }
const top = [...rounds].sort((a, b) => Number(b.miss) - Number(a.miss)).slice(0, 8);
console.log('轮id    会话   时间            m      占本轮输入 类别/形状   构成（工具结果 / 上轮模型输出 / 残差）');
for (const r of top) {
  const prev = (byC.get(r.cid) || []).filter((x) => x.id < r.id).pop();
  let bytes = 0; const names = [];
  if (prev) for (const c of (byCall.get(r.cid) || [])) if (new Date(c.t) > new Date(prev.t) && new Date(c.t) <= new Date(r.t)) { bytes += Number(c.result_bytes) || 0; names.push(`${c.tool_name}:${c.result_bytes}B`); }
  const outTok = prev ? Number(prev.tout) || 0 : 0;
  const toolTok = Math.round(bytes / 3.2); // 3.2 = 仓库既有折算率（toolresult-pro数据/m-attribution 同口径）
  const resid = Number(r.miss) - outTok - toolTok;
  const tag = shapeBreak(r) ? 'shape-break' : clsOf.get(r.id).cls;
  console.log(`${String(r.id).padEnd(7)} ${String(r.cid).padEnd(6)} ${ts(r.t)} ${fmt(r.miss).padStart(7)} ${pct(Number(r.tin) ? Number(r.miss) / Number(r.tin) : null).padStart(9)}  ${tag.padEnd(11)} 工具 ${fmt(toolTok)}/${fmt(bytes)}B${names.length ? '（' + names.join(',') + '）' : '（无）'} · 上轮输出 ${fmt(outTok)} · 残差 ${fmt(resid)}`);
}
console.log('\n  尾部集中在哪几个会话：');
const tailSet = new Map();
for (const r of top) tailSet.set(r.cid, (tailSet.get(r.cid) || 0) + 1);
for (const [cid, n] of tailSet) { const r0 = top.find((x) => x.cid === cid); console.log(`    conv=${cid} ${n} 轮 · 《${String(r0.title).slice(0, 32)}》 · perm=${r0.perm} · ${selfMade.has(Number(cid)) ? '**我们自造**' : '非自造'}`); }

// ── 输出 ⑥：这些会话在做什么（用它们自己的内容取证，不猜）──────────────────────
console.log('\n== ⑥ 尾部会话在做什么（会话内自述，原始字段）==');
for (const cid of [...new Set(top.map((r) => r.cid))]) {
  const m = (await q(`SELECT id, role, LEFT(content, 130) head FROM messages WHERE conversation_id=? ORDER BY id LIMIT 1`, [cid]))[0];
  if (m && !m.__err) console.log(`  conv=${cid} 首条消息（${m.role}）：${String(m.head).replace(/\n/g, ' ')}`);
}
console.log('\n  出处（仓库内可查）：`rw-run:` 由 scripts/rw-run.mjs:256 建会话（包 bin=rw-run，v0.3 §7.1 ⑬ headless 形态）；');
console.log('  `RA35样本-` 由 scripts/schedule-test-task.mjs:16 / run-ra35-sample.mjs:19 创建（cohort.js 的 SAMPLE 档）；');
console.log('  `MCP:` 是 MCP server 联调、`RW_STORAGE 探针` 是存储面探针 —— 四条都是"我们发起"的轮次。');

console.log('\n复跑：node scripts/c1c2-forensics.mjs');
await pool.end();
process.exit(0);
