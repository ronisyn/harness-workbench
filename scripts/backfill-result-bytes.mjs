// scripts/backfill-result-bytes.mjs - RA-05b：把存量 tool_calls.result_bytes 标定到"能标定"的程度
// ── 口径（为什么只能到这一步，不能假装精确）────────────────────────────────────────
// 运行时算式（`server/tools/index.js` 的 resultBytesOf，与 spill 判定同口径）：
//     result_bytes = byteLength(JSON.stringify(result))      ← 工具返回值的 UTF-8 字节数，进 LLM 上下文的就是它
// 关键是**在 `result_summary` 的 2000 字符截断之前**量；截断只影响留痕，不影响上下文（上下文走 spill 的另一条路）。
// 存量行没有 result 本体，只有 `result_summary = JSON.stringify(result).slice(0, 2000)`，因此：
//   · 摘要未截断（长度 <2000）→ `JSON.parse` 可还原整个 result → **精确值**（exact）
//   · 摘要被截断（长度 ==2000）→ 只能得到 `floor(2000)` 字符的序列化前缀 → 只能给**下界**（lower bound）
// 下界的性质：序列化前缀的字节数 ≤ 真实字节数；CJK 文本上二者可差数倍（3 字节/字符）。
// 所以下界**只用于回答"是否已超阈值"**这个单调问题（下界已超 → 真实必超），不作分布形状依据。
// **这不是遗憾，而是 RA-05b 要新加这一列的原因**：存量数据本就无法回算，故必须从今往后按次采集。
// 本脚本的产物因此有两层价值：① 3057 行精确样本立刻可用于标定；② 其余行给出可证伪的下界。
//
// 用法：node scripts/backfill-result-bytes.mjs [--dry]
//   --dry 只统计不写库。幂等：只处理 result_bytes=0 的存量行。
import { db } from '../server/db.js';
import { resultBytesOf } from '../server/tools/index.js';

const DRY = process.argv.includes('--dry');
const BATCH = 500;
const TRUNC_LEN = 2000; // tools/index.js 的 rResult 截断长度

let lastId = 0, scanned = 0, exact = 0, lower = 0, skipped = 0;
let maxExact = 0, overBytes = 0;
const jobs = [];
for (;;) {
  const rows = await db.query(`SELECT id, result_summary FROM tool_calls WHERE result_bytes = 0 AND id > ? ORDER BY id LIMIT ${BATCH}`, [lastId]);
  if (!rows.length) break;
  for (const r of rows) {
    lastId = r.id; scanned++;
    const s = String(r.result_summary ?? '');
    if (!s) { skipped++; continue; }
    let bytes = null;
    if (s.length < TRUNC_LEN) {
      try { bytes = resultBytesOf(JSON.parse(s)); } catch { bytes = null; }
      if (bytes != null) { exact++; if (bytes > maxExact) maxExact = bytes; }
    }
    if (bytes == null) { bytes = resultBytesOf(s); lower++; } // 下界（含解析失败的非截断行，一并按下界记并计入 skipped 说明）
    if (bytes > 32768) overBytes++;
    jobs.push([bytes, r.id]);
  }
}
if (!DRY && jobs.length) {
  for (let i = 0; i < jobs.length; i += 200) {
    const slice = jobs.slice(i, i + 200);
    await db.query('UPDATE tool_calls SET result_bytes = CASE id ' + slice.map(() => 'WHEN ? THEN ?').join(' ') + ' END WHERE id IN (' + slice.map(() => '?').join(',') + ')',
      [...slice.flatMap(([b, id]) => [id, b]), ...slice.map(([, id]) => id)]);
  }
}
const after = (await db.query('SELECT COUNT(*) n, SUM(result_bytes=0) zeros, MAX(result_bytes) mx FROM tool_calls'))[0];
console.log(`${DRY ? '[dry] ' : ''}扫描 ${scanned} 行：精确 ${exact} 行 · 下界 ${lower} 行 · 空摘要跳过 ${skipped} 行`);
console.log(`精确最大值 ${maxExact} 字节；本次写入值中 >32768 的有 ${overBytes} 行`);
console.log(`现存：${after.n} 行，其中 result_bytes=0 仍为 ${after.zeros} 行；库内最大 ${after.mx} 字节`);
process.exit(0);
