#!/usr/bin/env node
// scripts/selfeval-propose.mjs —— 三源 → 提案（v0.3 §7.1 ㉓；**默认 dry-run，不写库**）
//
// 三源输入：
//   ① 自我体检：`collect.js` 从真库读快照（或用 --snapshot 读一份已存快照，此时**完全不碰库**）
//   ② 外部对标：`--benchmark` 读 `docs/` 下的借鉴清单与实测报告，解析候选对标项（**半自动，人工输入**）
//   ③ 业务反馈：`--feedback <文件>` 逐行读人工录入的痛点/绩效（**人工采集半自动**）
//
// 铁律（v0.3 §0.4，不提供关闭开关）：
//   · 默认只打印提案，**不写任何表**；
//   · `--write` 也只允许写 `extension_demands`（待审）与 `evo_goals`（`server/selfeval/write.js` 的白名单）；
//   · 提案文本里出现"自动执行/自动提交"字样 → 拒；缺"验证方式" → 拒（`checkIronLaw`）；
//   · **不会**改代码、**不会** git 提交。
//   · 告警线（`settings.metric_alert_lines`）**缺省为空＝不设线**：此时 R8 不产出，行为与改造前逐字相同；
//     设了线且越线，只多一条**待审提案**（告警），不阻断任何执行（v0.3 §4.4.1 规则4）。
//
// 用法（服务器上）：
//   node scripts/selfeval-propose.mjs                              # dry-run：采集 + 打印提案
//   node scripts/selfeval-propose.mjs --benchmark --verbose        # 带上"外部对标候选"并展开全部字段
//   node scripts/selfeval-propose.mjs --benchmark --feedback docs/selfeval-业务反馈.txt
//   node scripts/selfeval-propose.mjs --write --benchmark --account 1   # 落库（仅两张提案表）
//   node scripts/selfeval-propose.mjs --snapshot tmp/snap.json     # 用已存快照出提案（不碰库）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { pool } from '../server/db.js';
import { collectSnapshot, BENCHMARK_SOURCES } from '../server/selfeval/collect.js';
import { buildProposals, collectBenchmarkCandidates, readFeedbackFile, formatProposals } from '../server/selfeval/propose.js';
// 指标告警线（v0.3 §4.4.1 规则4；2026-09-16）：线**只**来自设置键 `metric_alert_lines`，缺省为空＝不设线
// （不设线时 R8 不产出，整条链路的行为与改造前逐字相同）。这与三源里的**读库那一半**同处：读库在这里，成型在纯函数里。
import { loadMetricAlertLines } from '../server/selfeval/alerts.js';
import { writeProposals, WRITABLE_TABLES } from '../server/selfeval/write.js';

const args = process.argv.slice(2);
const val = (k, d = null) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] ?? '') : d; };
const DAYS = Math.max(1, Number(val('days', 7)) || 7);
const WRITE = args.includes('--write');
const VERBOSE = args.includes('--verbose');
const SNAP_IN = val('snapshot');
const ACCOUNT = val('account') == null ? null : Number(val('account'));
const FEEDBACK = val('feedback');

async function closePool() {
  try { if (typeof pool._idleTimeout === 'number') await pool.close(); else await pool.end(); } catch { /* ignore */ }
}
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

try {
  // ── 快照（自我体检源）──────────────────────────────────────────────────────────────
  let snapshot;
  if (SNAP_IN) {
    const p = abs(SNAP_IN);
    if (!fs.existsSync(p)) throw new Error('--snapshot 文件不存在：' + p);
    snapshot = JSON.parse(fs.readFileSync(p, 'utf8'));
  } else {
    snapshot = await collectSnapshot({ days: DAYS });
  }

  // ── 外部对标源（半自动：文档输入）─────────────────────────────────────────────────
  let benchmark = { items: [], errors: [] };
  if (args.includes('--benchmark')) {
    benchmark = collectBenchmarkCandidates({ root: ROOT, sources: BENCHMARK_SOURCES });
  } else {
    benchmark.errors.push('未加 --benchmark：本轮不含外部对标候选（这一源是半自动，需显式打开）');
  }

  // ── 业务反馈源（人工输入）─────────────────────────────────────────────────────────
  let feedback = { items: [], errors: [] };
  if (FEEDBACK) feedback = readFeedbackFile({ root: ROOT, file: FEEDBACK });

  // ── 告警线（**配置给数**，缺省为空＝不设线）─────────────────────────────────────────
  // 为什么在这里读：`propose.js` 是纯函数（dry-run 才能真正只读），读设置与三源读库同处。
  // 读不到/为空 ⇒ 传空串 ⇒ R8 不产出（与改造前逐字相同）。线上没有这条键的种子行，缺行就是缺省。
  const alertLines = await loadMetricAlertLines();

  const result = buildProposals({ snapshot, benchmark, feedback, alertLines });
  console.log(formatProposals(result, { verbose: VERBOSE }));

  if (result.rejected.length) {
    console.log('\n被拦下的提案（未产出，原因如下）：');
    for (const r of result.rejected) console.log(`  · ${r.title}\n    ${[...(r.missing || []).map((f) => '缺字段 ' + f), ...(r.violations || [])].join('；')}`);
  }

  if (!WRITE) {
    console.log('\n[dry-run] 未写库。落库请加 --write（只允许写 ' + WRITABLE_TABLES.join(' / ') + '）；'
      + '本脚本不会改代码、不会 git 提交（v0.3 §0.4 铁律）。');
    await closePool();
    process.exit(0);
  }

  const report = await writeProposals(result.proposals, { accountId: ACCOUNT });
  console.log('\n[--write] 结果：');
  console.log(`  新落 ${report.created.length} 条：` + (report.created.map((x) => `${x.table}#${x.id}`).join(', ') || '（无）'));
  console.log(`  幂等跳过 ${report.skipped.length} 条（同批次已存在）：` + (report.skipped.map((x) => `${x.table}#${x.id}`).join(', ') || '（无）'));
  if (report.failed.length) {
    console.log(`  ⚠️ 失败 ${report.failed.length} 条：`);
    for (const f of report.failed) console.log(`    · ${f.title} → ${f.error}`);
  }
  console.log('  下一步：在进化集审批台逐条审（extension_demands 的 status 默认「待审」）。');
  await closePool();
  process.exit(report.failed.length ? 1 : 0);
} catch (e) {
  console.error('[selfeval] 提案失败：' + String((e && e.message) || e));
  await closePool();
  process.exit(2);
}
