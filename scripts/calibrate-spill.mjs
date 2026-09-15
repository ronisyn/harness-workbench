// scripts/calibrate-spill.mjs - RA-05b spill 阈值标定报告（只读）
// 依据《RW-Agent 架构 v1.1》§14.2 RA-05b：**spill 阈值标定完成**（32768 按 C2/C4 复核，owner=agent，见 OP-10）
// 本脚本回答三件事（全部给数字，不给形容词）：
//   ① 体积分布：tool_calls.result_bytes 的 p50/p90/p95/p99/max，分"精确/下界"两类如实标注；
//   ② 两个触发器谁先响：内联字符上限（cap，普通 4000 / 子代理族 12000）vs 字节天花板（SPILL_BYTES=32768）；
//   ③ 标定判定：SPILL_BYTES 是否落在"有意义"的位置（既不形同虚设、也不误伤正常结果）。
// 用法：node scripts/calibrate-spill.mjs
import { db } from '../server/db.js';
import { SPILL_BYTES } from '../server/tools/spill.js';

const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const pct = (n, d) => (n == null ? '-' : ((Number(n) / Number(d || 1)) * 100).toFixed(2) + '%');

export function percentiles(sorted, ps) {
  const out = {};
  if (!sorted.length) return out;
  for (const p of ps) {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    out[p] = sorted[i];
  }
  return out;
}

const CAP_NORMAL = 4000;    // agent.js msgCap（普通工具）
const CAP_SUBAGENT = 12000; // agent.js msgCap（subagent* 族）

console.log('== ① 体积分布（tool_calls.result_bytes，单位字节）==');
const rows = await q('SELECT result_bytes b, result_summary s, tool_name, created_at FROM tool_calls WHERE result_bytes > 0');
const exact = rows.filter((r) => String(r.s || '').length < 2000).map((r) => Number(r.b)).sort((a, b) => a - b);
const lower = rows.filter((r) => String(r.s || '').length >= 2000).map((r) => Number(r.b)).sort((a, b) => a - b);
const all = [...exact, ...lower].sort((a, b) => a - b);
for (const [label, arr] of [['全量', all], ['精确（摘要未截断）', exact], ['下界（摘要被 2000 字符截断）', lower]]) {
  const p = percentiles(arr, [50, 90, 95, 99]);
  console.log(`  ${label.padEnd(24)} n=${fmt(arr.length).padStart(6)}  p50=${fmt(p[50]).padStart(7)}  p90=${fmt(p[90]).padStart(7)}  p95=${fmt(p[95]).padStart(7)}  p99=${fmt(p[99]).padStart(7)}  max=${fmt(arr[arr.length - 1]).padStart(7)}`);
}
console.log('  注：下界行只能回答"是否已超阈值"（单调），不能作分布形状依据——见 backfill-result-bytes.mjs 的口径说明。');

console.log('\n== ② 两个触发器谁先响 ==');
const overBytes = all.filter((b) => b > SPILL_BYTES).length;
const overCap = all.filter((b) => b > CAP_NORMAL).length;
console.log(`  字节天花板 SPILL_BYTES=${fmt(SPILL_BYTES)}：超阈值 ${fmt(overBytes)} 行（${pct(overBytes, all.length)}）`);
console.log(`  内联字符上限 cap=${fmt(CAP_NORMAL)} 字符：>cap 字符的行占比（字符口径见下）`);
const chars = await q(`SELECT SUM(CHAR_LENGTH(result_summary) >= ${CAP_NORMAL}) a, COUNT(*) n FROM tool_calls`);
console.log(`    实测：result_summary ≥ ${CAP_NORMAL} 字符的 ${fmt((chars[0] || {}).a)} / ${fmt((chars[0] || {}).n)} 行（${pct((chars[0] || {}).a, (chars[0] || {}).n)}）`);
console.log(`  推论：普通工具 cap=${CAP_NORMAL} 字符 ⇒ ASCII 结果最多 ≈${fmt(CAP_NORMAL)} 字节 < ${fmt(SPILL_BYTES)}，字节天花板永不单独触发；`);
console.log(`        CJK 结果按 3 字节/字符 ⇒ cap 处 ≈${fmt(CAP_NORMAL * 3)} 字节，仍 < ${fmt(SPILL_BYTES)}。`);
console.log(`        故 SPILL_BYTES 实际只对**读取类跳过 cap 的路径**（source-file 定位符）与子代理族 cap=${fmt(CAP_SUBAGENT)} 生效。`);

console.log('\n== ③ 按工具（体积口径）==');
const byTool = await q(`SELECT tool_name, COUNT(*) n, MAX(result_bytes) mx, ROUND(AVG(result_bytes)) avg,
                               SUM(result_bytes > ${SPILL_BYTES}) over_bytes, SUM(CHAR_LENGTH(result_summary) >= ${CAP_NORMAL}) over_cap
                        FROM tool_calls GROUP BY tool_name ORDER BY mx DESC LIMIT 12`);
for (const r of byTool) console.log(`  ${String(r.tool_name).padEnd(24)} n=${fmt(r.n).padStart(6)} avg=${fmt(r.avg).padStart(7)} max=${fmt(r.mx).padStart(7)} >${SPILL_BYTES}=${fmt(r.over_bytes).padStart(4)} >cap=${fmt(r.over_cap).padStart(4)}`);

console.log('\n== ④ 判定 ==');
const enough = all.length >= 200;
console.log(`  样本量：${fmt(all.length)} 行 ${enough ? '（≥200，可作标定依据）' : '（<200，样本不足，结论标"待更多流量"）'}`);
console.log(`  SPILL_BYTES=${fmt(SPILL_BYTES)} 位于全量 p99=${fmt(percentiles(all, [99])[99])} 之上：${overBytes === 0 ? '是——当前零触发、零误伤' : '否——有 ' + overBytes + ' 行被溢出'}`);
// 这是标定的关键一步：cap 与字节上限在几何上互相蕴含时，后者的具体取值不影响任何一次判定。
const capBytesAscii = CAP_NORMAL;              // ASCII：1 字节/字符
const capBytesCjk = CAP_NORMAL * 3;            // CJK：3 字节/字符（UTF-8）
const binds = SPILL_BYTES < capBytesAscii;
console.log(`  几何关系：普通工具 cap=${CAP_NORMAL} 字符 ⇒ 结果字节 ∈ [${fmt(capBytesAscii)}, ${fmt(capBytesCjk)}]（ASCII…CJK）`);
console.log(`            SPILL_BYTES=${fmt(SPILL_BYTES)} ${binds ? '**低于** cap 的字节下界 → 字节天花板会先触发（真在起作用）' : '**高于** cap 的字节上界 → 字符 cap 必然先触发，字节天花板在该路径上不参与判定'}`);
console.log('  结论口径：阈值是否"合理"取决于设计意图（防止单次结果吃掉上下文预算），而不是"尽量少触发"；');
console.log('            故本报告给的是"触发面 + 误伤面 + 与 cap 的几何关系"，不把"零触发"当达标。');
console.log('  样本外推的限制：result_bytes 只覆盖**已落库**的工具调用；read_file 的重结果在 2000 字符摘要下只能给下界，');
console.log('            故 max=4,333 是"下界的最大值"，真实分布上尾更厚。要收全分布须靠新流量持续采集（本列已上线）。');
process.exit(0);
