#!/usr/bin/env node
// scripts/failure-report.mjs —— 失败码统计（统一失败分类的"回报"那一半）
//
// 为什么要有它：有了码表却不看，等于没分类。这里只做一件事——按失败码汇总，回答
//   · 最常见的失败是哪几种（拦截类 vs 执行类）？
//   · 哪个工具最常失败、以什么方式失败？
// 只读，不改任何数据。用法：node scripts/failure-report.mjs [天数，默认 7]
import { db, pool } from '../server/db.js';
import { FAIL, failSpec } from '../server/failures.js';

const days = Math.max(1, Number(process.argv[2]) || 7);
const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

const byCode = await db.query(
  `SELECT COALESCE(error_code, '(无码/存量行)') AS code, COUNT(*) AS n, COUNT(DISTINCT tool_name) AS tools
   FROM tool_calls WHERE status='fail' AND created_at >= ? GROUP BY code ORDER BY n DESC`, [since]);
const byTool = await db.query(
  `SELECT tool_name, COALESCE(error_code,'(无码)') AS code, COUNT(*) AS n
   FROM tool_calls WHERE status='fail' AND created_at >= ? GROUP BY tool_name, code ORDER BY n DESC LIMIT 20`, [since]);
const totals = await db.query(
  `SELECT COUNT(*) AS all_n, SUM(status='fail') AS fail_n FROM tool_calls WHERE created_at >= ?`, [since]);

const t = totals[0] || { all_n: 0, fail_n: 0 };
console.log(`=== 工具失败码统计（近 ${days} 天）===`);
console.log(`工具调用 ${t.all_n || 0} 次，其中失败 ${t.fail_n || 0} 次`
  + (t.all_n ? `（失败率 ${((t.fail_n || 0) / t.all_n * 100).toFixed(1)}%）` : ''));
console.log('\n按失败码：');
if (!byCode.length) console.log('  （无失败记录）');
for (const r of byCode) {
  const spec = failSpec(r.code);
  console.log('  ' + String(r.code).padEnd(24) + String(r.n).padStart(5) + ' 次  ' + (spec ? (spec.retryable ? '[可重试] ' : '[不可重试] ') + spec.note : '（未登记的码或存量行）'));
}
console.log('\n按工具（前 20）：');
if (!byTool.length) console.log('  （无失败记录）');
for (const r of byTool) console.log('  ' + String(r.tool_name).padEnd(24) + String(r.code).padEnd(24) + String(r.n).padStart(5) + ' 次');
console.log('\n码表共 ' + Object.keys(FAIL).length + ' 个（server/failures.js 一处维护）。');
await pool.end();
