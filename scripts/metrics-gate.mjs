#!/usr/bin/env node
// scripts/metrics-gate.mjs —— ㉔「指标回归门禁」的**判定那一半 + 前后对比器**
//
// ── 门禁的原话（v0.3，见 server/selfeval/regression-gate.js 顶部的逐字引用）────────────────
//   §0.4 M3 出口标准：「……**每条附前后指标对比**；全程无自我放行」
//   §0.4 M3 准入前置：「**金标回归 + 失效监控（C4）必须在位**，否则自进化=盲改」
//   §7.1 ㉔：「优先级判据 + 指标回归门禁」（准入前置见第 370 行）
//
// ── 铁律：不许发明阈值（C-31「规则4：只报数不设线，不发明阈值」）──────────────────────────
//   本脚本**不设任何数字线**。它只做两件事：
//     (a) **在位性判定**：金标回归 / C4 失效监控 / 每条提案的前后对比 —— 缺了就红；
//     (b) **只报数不设线**：指标变好变差照实打出来（`变好/变差/新增/消失/无变化`），**不阻断**。
//   "变差多少算回归"这条线 v0.3 没给 —— 需要线的场合一律输出"需人判"，并在报告里单列给人拍板。
//
// 用法（本机；比的是两次**同一窗口口径**的采集）：
//   node scripts/metrics-gate.mjs                                  # 本次=tmp/metrics/latest.json，基线=上一次指针里的
//   node scripts/metrics-gate.mjs --baseline tmp/metrics/…/snapshot.json
//   node scripts/metrics-gate.mjs --proposals tmp/proposals.json    # 才判"每条提案附了前后指标对比"
//   node scripts/metrics-gate.mjs --json                            # 结构化输出（喂给别的东西）
// 退出码：0=通过；1=**不通过**（硬条件缺位）或**未判**（不可比/读不到 —— 未判也不放行）；2=用法错误
//
// `--proposals <file>`：提案数组 JSON（每项至少 `{id,title}`；要过"附了前后对比"这一关需带
//   `baselineRef` —— 即 `server/selfeval/regression-gate.js` 的 `snapshotRef(report).path`，
//   或 `metricComparison: {baseline, metrics:[path…]}`）。没有这个参数就只判报告侧的两条硬条件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../server/config.js';
import {
  evaluateGate, diffMetrics, compareWindows, gateLine, GATE_VERDICT, resolveBaselinePath,
  checkMetricsReport, METRIC_PATHS, goldenInPlace, c4InPlace,
} from '../server/selfeval/regression-gate.js';

const STATE_CN = {
  improved: '变好', degraded: '变差', new: '新增', gone: '消失', unchanged: '无变化', changed: '变了（方向未定）',
};
const fmt = (v, unit) => (v == null ? '-' : (unit === 'ratio' ? (v * 100).toFixed(2) + '%' : Number(v).toLocaleString('en-US')));

/** 人读的逐项对比（四态 + 集合两态）。`formatDiff` 带表头，`formatDiffBody` 只有行（CLI 自己印表头，好把真实文件路径放进去） */
export function formatDiffBody(diff) {
  const L = [];
  if (!diff.hasBaseline) {
    L.push('  没有基线报告 ⇒ 无法对比（这是"缺前后对比"，**不是"通过"**）');
    return L.join('\n');
  }
  for (const r of diff.rows) {
    const mark = { improved: '✅', degraded: '⚠️', new: '＋', gone: '－', unchanged: '＝', changed: '？' }[r.state] || ' ';
    L.push('  ' + mark + ' ' + STATE_CN[r.state] + ' ' + r.path + '：' + fmt(r.from, r.unit) + ' → ' + fmt(r.to, r.unit)
      + (r.note ? '　（' + r.note + '）' : ''));
  }
  const g = diff.golden;
  L.push('  金标：' + (g.setChanged ? '**集合变了**（不可当行为回归）' : (g.behaviorChanged ? '**行为变了**' : '同一套金标、行为未变')));
  for (const n of g.notes) L.push('    · ' + n);
  return L.join('\n');
}

/** 完整块（含表头行；`--json` 或别处引用时用） */
export function formatDiff(diff) {
  const head = '── 前后指标对比（**只报数不设线**：变差不阻断；只有"缺对比对象/机制不在位"才红）──';
  if (!diff.hasBaseline) return [head, formatDiffBody(diff)].join('\n');
  return [head, '  基线 ' + (diff.baselineRef || '（未记 ref）') + '  →  本次 ' + (diff.currentRef || '（未记 ref）'), formatDiffBody(diff)].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] ?? '') : d; };
  const AS_JSON = argv.includes('--json');
  const explicitCur = val('current');
  const explicitBase = val('baseline');
  const propFile = val('proposals');

  // ① 本次报告：默认取指针（tmp/metrics/latest.json）
  const curWhere = explicitCur
    ? { path: path.resolve(explicitCur), source: 'explicit' }
    : await resolveBaselinePath({});
  if (!curWhere.path || !fs.existsSync(curWhere.path)) {
    console.error('❌ 找不到本次指标报告' + (curWhere.path ? '（' + curWhere.path + '）' : '')
      + '\n   先跑：node scripts/metrics-report.mjs   —— 没有报告 = 未判，禁止放行');
    process.exitCode = 1;
    return;
  }
  const current = JSON.parse(fs.readFileSync(curWhere.path, 'utf8'));
  const problems = checkMetricsReport(current);
  if (problems.length) {
    console.error('❌ 报告读不懂（' + problems.join('；') + '）：宁可报读不懂，也不拿它当判定依据');
    process.exitCode = 1;
    return;
  }

  // ② 基线：显式给就用它；否则用指针里的**上一次**（release 场景：报告要在判定前先落盘，见 release.mjs 的注释）
  let baseline = null, basePath = null;
  if (explicitBase) {
    basePath = path.resolve(explicitBase);
  } else if (current.baselineRef) {
    // 报告里带 baselineRef 时以它为准（collect 侧记的"上一份是哪一份"，比"当前指针"更准）
    basePath = path.resolve(ROOT, String(current.baselineRef).replace(/^file:\/\/\//, ''));
  }
  if (basePath) {
    if (!fs.existsSync(basePath)) {
      console.error('⚠️ 基线文件不存在：' + basePath + ' ⇒ 按"没有对比对象"处理（红）');
    } else {
      baseline = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    }
  }
  const diff = diffMetrics(baseline, current);
  const win = compareWindows(baseline, current);

  // ③ 提案侧：给了文件才判"每条附了前后指标对比"
  let proposals = [];
  let proposalsNote = null;
  if (propFile) {
    try {
      const j = JSON.parse(fs.readFileSync(path.resolve(propFile), 'utf8'));
      proposals = Array.isArray(j) ? j : (Array.isArray(j.proposals) ? j.proposals : []);
      // 白名单外的指标路径会被悄悄忽略（".find 找不到就拉倒"）—— 那正好是"看着在、其实没拦"的形态。
      // 这里把它标成**不匹配**：写了个不存在的 path 等于没写对比对象（㉒㉓ 代理接口点④）。
      for (const p of proposals) {
        const mc = p && p.metricComparison;
        if (!mc || !Array.isArray(mc.metrics)) continue;
        const known = new Set(METRIC_PATHS.map((d) => d.path));
        const bad = mc.metrics.filter((m) => !known.has(m));
        if (bad.length) { p.baselineMatched = false; p.__badPaths = bad; }
      }
    } catch (e) {
      proposalsNote = '提案文件读不到（' + String((e && e.message) || e).slice(0, 120) + '）';
    }
  }
  const gate = evaluateGate({ current, baseline, proposals });

  if (AS_JSON) {
    console.log(JSON.stringify({ verdict: gate.verdict, reasons: gate.reasons, checks: gate.checks, diff, window: win, proposalsNote }, null, 2));
  } else {
    console.log('=== 指标回归门禁（v0.3 §7.1 ㉔）· 不发明阈值：只在位性判定 + 只报数不设线 ===');
    console.log('本次报告 ' + path.relative(ROOT, curWhere.path) + '（' + curWhere.source + '）· 代码 ' + ((current.code && current.code.commit) || '未记录')
      + (current.code && current.code.dirty ? '（脏工作区）' : ''));
    // 对比对象的真身：显示**这次实际打开的两个文件**（报告里的 ref 是相对路径，两边都印出来会像同一个文件）
    console.log('── 前后指标对比（**只报数不设线**：变差不阻断；只有"缺对比对象/机制不在位"才红）──');
    console.log('  基线 ' + (basePath ? path.relative(ROOT, basePath) : '（无）') + '  →  本次 ' + path.relative(ROOT, curWhere.path));
    console.log(formatDiffBody(diff));
    if (baseline && !win.comparable) console.log('⚠️ 窗口不可比（**拒绝直接对比**）：' + win.diffs.join('；'));
    if (proposalsNote) console.log('⚠️ ' + proposalsNote);
    if (proposals.length) {
      for (const p of (gate.checks.proposals.missing || [])) console.log('   ❌ 提案 ' + (p.id || '?') + '：' + p.why + (p.__badPaths ? '（白名单外的指标路径：' + p.__badPaths.join('、') + '）' : ''));
    }
    for (const r of gate.reasons) console.log('  ' + (r.ok ? '✅' : (r.code === 'proposal.comparison' ? '⚠️' : '❌')) + ' ' + r.text);
    console.log('\n结论：' + (gate.verdict === GATE_VERDICT.PASS ? '✅ 通过' : gate.verdict === GATE_VERDICT.FAIL ? '❌ **不通过**' : '❌ **未判**（不放行）')
      + ' —— ' + gateLine(gate));
    if (!propFile) console.log('（提示：加 --proposals <file> 才会判"每条提案附了前后指标对比"这一条）');
  }

  // ④ 退出码：只有显式 pass 是 0 —— 未判也**不放行**（"不知道"不许读成"没问题"）
  process.exitCode = gate.verdict === GATE_VERDICT.PASS ? 0 : 1;
}

const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith(SELF)) {
  try { await main(); } catch (e) { console.error('[' + (e.name || 'Error') + '] ' + String((e && e.message) || e)); process.exitCode = 2; }
}
