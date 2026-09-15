#!/usr/bin/env node
// scripts/selfeval-collect.mjs —— 自我体检**采集**入口（v0.3 §7.1 ㉒；只读，不写库）
//
// 做什么：把 C1–C5 / 失败率 / 金标读数 / 提案载体水位 / 外部对标源指纹读成**一个结构化快照**并打印。
// 口径：全部复用既有出处（`server/cohort.js` 的分档、`collect.js` 的纯函数成型），不新造阈值、不判定达标。
// 只读保证：本脚本只发 SELECT；进程结束前只 close 池子（MySQL 的空闲连接不会超时回收，不关就一直挂着）。
//
// 用法（服务器上）：
//   node scripts/selfeval-collect.mjs                          # 近 7 天，人读摘要 + 完整 JSON
//   node scripts/selfeval-collect.mjs --days 30 --json         # 只打 JSON（喂给后续步骤/存档）
//   node scripts/selfeval-collect.mjs --out tmp/snap.json      # 另存一份 JSON
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { pool } from '../server/db.js';
import { collectSnapshot } from '../server/selfeval/collect.js';

const args = process.argv.slice(2);
const val = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] ?? '') : d; };
const DAYS = Math.max(1, Number(val('days', 7)) || 7);
const AS_JSON = args.includes('--json');
const OUT = val('out');
const CUTOFF = val('cutoff');

/** 池子是懒连接的：没有活连接时 close() 会结束进程，没有活连接时 end() 会去握手（可能挂住）——所以先探。 */
async function closePool() {
  try { if (typeof pool._idleTimeout === 'number') await pool.close(); else await pool.end(); } catch { /* 关不掉也不影响结论 */ }
}

try {
  const snap = await collectSnapshot({ days: DAYS, cutoff: CUTOFF });
  if (OUT) {
    const p = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap, null, 2), 'utf8');
    console.error('[selfeval] 快照已存 ' + p);
  }
  if (AS_JSON) {
    console.log(JSON.stringify(snap, null, 2));
  } else {
    const m = snap.metrics;
    const pct = (x) => (x == null ? '  -  ' : (x * 100).toFixed(2) + '%');
    const num = (x) => (x == null ? '-' : Number(x).toLocaleString('en-US'));
    const c = m.c1c2.cohorts;
    const L = [];
    L.push(`=== 自我体检快照 ${snap.batchId}（近 ${snap.window.days} 天，库本地时间）===`);
    L.push('C1/C2 分档（口径 server/cohort.js；**只报数不设线**）：');
    for (const [k, label] of [['real', '真实流量'], ['human', '  ├ 人发起'], ['scheduled', '  ├ 定时任务'], ['probe', '探针'], ['orphan', '孤儿']]) {
      const x = c[k] || {};
      const star = x.rounds >= 30 ? '' : ' ⚠ 轮次<30：不可判';
      L.push(`  ${label.padEnd(10)} 轮 ${num(x.rounds).padStart(6)} · 会话 ${num(x.conversations).padStart(4)}`
        + ` · C1 ${pct(x.c1).padStart(8)} · C2 中位 ${num(x.c2Median).padStart(7)} / P95 ${num(x.c2P95).padStart(7)}`
        + ` · ¥${Number(x.cost || 0).toFixed(4)}${star}`);
    }
    L.push(`C3 单位成本：每 run ${m.c3.perRun == null ? '-' : '¥' + m.c3.perRun.toFixed(4)}（${num(m.c3.runs)} runs）`
      + ` · 每会话 ${m.c3.perConversation == null ? '-' : '¥' + m.c3.perConversation.toFixed(4)}（${num(m.c3.conversations)}）`
      + ` · 累计 ¥${Number(m.c3.total || 0).toFixed(4)}`);
    L.push(`C4 非预期失效（机检口径 prefix:invalidate）：${num(m.c4c5.c4Invalidate)} 次`
      + `　C5 豁免（只报数）：exempt ${num(m.c4c5.c5Exempt)} · collapse ${num(m.c4c5.c5Collapse)}`);
    L.push(`     C5 归因：${Object.entries(m.c4c5.attributable || {}).map(([k, v]) => k + '=' + v).join(' ') || '（无）'}`);
    L.push(`失败率（口径 failure-report，排除夹具哨兵会话）：${num(m.failures.fails)}/${num(m.failures.calls)}`
      + ` = ${m.failures.failRate == null ? '无分母（不算 0%）' : (m.failures.failRate * 100).toFixed(1) + '%'}`
      + `　probe 会话 ${num(m.failures.probeCalls)} 次调用单列`);
    const cShells = (m.canary.shells || []).map((s) => `${s.skey}=${s.error ? 'error(' + String(s.error).slice(0, 40) + ')' : s.skipped ? 'skipped' : s.passed + '/' + s.total}`);
    L.push(`金标读数：${m.canary.status === 'ok' ? cShells.join(' ') || '（ok 但无壳）' : (m.canary.error ? '（跑不起来：' + String(m.canary.error).slice(0, 90) + '）' : (cShells.join(' ') || '（未在位：没有配 eval_ref 的壳）'))}`);
    L.push(`提案载体：evo_goals=${num(m.pipeline.evoGoals)} · evo_goal_tasks=${num(m.pipeline.evoGoalTasks)}`
      + ` · evo_memos=${num(m.pipeline.evoMemos)} · demands=${(m.pipeline.demandsByStatus || []).map((d) => d.status + '=' + d.n).join(' ') || 0}`);
    L.push('外部对标源（半自动：只记文档身份，**未做自动读 DS/CD 变化**）：');
    for (const s of snap.benchmarkSources) L.push(`  ${s.exists ? '✓' : '✗'} ${s.path} ${s.exists ? `${s.bytes}B mtime=${s.mtime} sha1=${s.sha1_12}` : '（读不到：' + (s.error || '-') + '）'}`);
    if (snap.collectErrors.length) L.push('⚠ 采集未取到：\n  - ' + snap.collectErrors.join('\n  - '));
    L.push('\n（完整快照用 --json；本脚本只读，不写任何表）');
    console.log(L.join('\n'));
  }
  await closePool();
  process.exit(0);
} catch (e) {
  console.error('[selfeval] 采集失败：' + String((e && e.message) || e));
  console.error('提示：需要能连上 MySQL（走 server/db.js 与仓库 .env），请在服务器上跑。');
  await closePool();
  process.exit(2);
}
