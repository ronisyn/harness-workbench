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
// 只统计**真实会话**（conversation_id > 0）：本仓库用 0/负数作夹具与探针的哨兵会话，而夹具会真的走 execTool
// 并把失败落账（例如"子代理工具面收窄""壳未装载"各 42 次、MCP 未连接 41 次全是夹具产生的）。
// 不排除它们，这个仪表就会把测试噪音报成生产失败——实测：7 天内失败 186 次里 139 次来自哨兵会话。
// 另一侧（哨兵）的口径照常打印，**不藏数据**：要判断"夹具是不是在污染账本"时看那一行。
const REAL = 'conversation_id > 0';

const byCode = await db.query(
  `SELECT COALESCE(error_code, '(无码/存量行)') AS code, COUNT(*) AS n, COUNT(DISTINCT tool_name) AS tools
   FROM tool_calls WHERE status='fail' AND ${REAL} AND created_at >= ? GROUP BY code ORDER BY n DESC`, [since]);
const byTool = await db.query(
  `SELECT tool_name, COALESCE(error_code,'(无码)') AS code, COUNT(*) AS n
   FROM tool_calls WHERE status='fail' AND ${REAL} AND created_at >= ? GROUP BY tool_name, code ORDER BY n DESC LIMIT 20`, [since]);
const totals = await db.query(
  `SELECT COUNT(*) AS all_n, SUM(status='fail') AS fail_n,
          (SELECT COUNT(*) FROM tool_calls WHERE conversation_id<=0 AND created_at >= ?) AS probe_all,
          (SELECT COUNT(*) FROM tool_calls WHERE conversation_id<=0 AND status='fail' AND created_at >= ?) AS probe_fail
   FROM tool_calls WHERE ${REAL} AND created_at >= ?`, [since, since, since]);

const t = totals[0] || { all_n: 0, fail_n: 0 };
console.log(`=== 工具失败码统计（近 ${days} 天，仅真实会话）===`);
console.log(`工具调用 ${t.all_n || 0} 次，其中失败 ${t.fail_n || 0} 次`
  + (t.all_n ? `（失败率 ${((t.fail_n || 0) / t.all_n * 100).toFixed(1)}%）` : '')
  + `　·　另：夹具/哨兵会话 ${t.probe_all || 0} 次调用、${t.probe_fail || 0} 次失败（**已排除**，不混进上面的数字）`);
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
