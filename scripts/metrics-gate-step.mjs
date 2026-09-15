#!/usr/bin/env node
// scripts/metrics-gate-step.mjs —— 发布流水线里的**第 2.7 步本体**（㉔ 指标回归门禁）
//
// 为什么单独一个文件（而不是写在 release.mjs 里）：
//   ① `scripts/release.mjs` 是**顶层 await 的脚本**：import 它就会把整条发布流水线跑一遍（含 vite build）。
//      门禁这一步要能**被单独验证**（fixture / 别的脚本 / CI），就不能把它埋在那种文件里。
//   ② 这一步的判定口径与 `scripts/metrics-gate.mjs`（CLI）**同源**：都走 `server/selfeval/regression-gate.js`，
//      这里只负责"发布场景"的三件事：产出报告、找基线、把三态结论交给 release 的 `step()`。
//
// 判定只允许两种形态（C-31 规则4「只报数不设线，不发明阈值」，v0.3 §0.4 / §7.1 ㉔）：
//   (a) **在位性判定**：金标回归 + 失效监控（C4）在位、每条提案附前后指标对比 —— 缺了就红；
//   (b) **只报数不设线**：指标变好/变差照实打出来，**不阻断**（"变差多少算回归"这条线 v0.3 没给）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import {
  resolveBaselinePath, loadMetricsReport, evaluateGate, gateBlocks, gateLine,
  goldenInPlace, c4InPlace, diffMetrics, looksLikeConnectionError,
} from '../server/selfeval/regression-gate.js';

/** 这一步的名字（单一出处：release 用它登记，夹具据此断言"确实在阻断路径上"） */
export const METRICS_STEP = '指标回归门禁（㉔：金标+C4 在位；变差只报数不设线）';
/** 本批入闸提案清单的约定位置（有才判"每条附前后指标对比"；没有就只判报告侧两条硬条件） */
export const PROPOSALS_PATH = path.join(ROOT, 'tmp', 'metrics', 'proposals.json');

/**
 * 跑第 2.7 步：产出本次指标报告 → 找基线 → 判定 → 交给 `register(name, ok, extra)`。
 *
 * @param {object} opts
 *   `register`：release 的 `step()`（**必须是布尔**：这条链路上只有"通过/不通过"两种结果）；
 *   `goldenReport`：2.6 刚跑过的金标结果（复用，**不重跑第二遍**）；
 *   `days`：窗口天数（与基线一致才可直接对比，否则门禁报"不可比"）；
 *   `quiet`：不打印过程（夹具用）
 * @returns {Promise<{current:object|null, gate:object, baselinePath:string|null, dbUnavailable:boolean, skipped:boolean}>}
 */
export async function metricsGateStep({ register, goldenReport = null, days = 7, quiet = false } = {}) {
  const say = (s) => { if (!quiet) console.log(s); };
  const reg = { resolveBaselinePath, loadMetricsReport, evaluateGate, gateBlocks, gateLine, goldenInPlace, c4InPlace, diffMetrics, looksLikeConnectionError };
  const mrep = await import('./metrics-report.mjs');
  let current = null;
  let collectThrew = null;
  try {
    const { report } = await mrep.collectReport({ days, goldenReport });
    try {
      const w = mrep.writeMetricsSnapshot(report);
      say('   本次指标报告：' + w.rel + '（指针 tmp/metrics/latest.json）');
    } catch (e) { say('   （报告写盘失败，不影响门禁判定：' + String((e && e.message) || e).slice(0, 60) + '）'); }
    current = report;
  } catch (e) { collectThrew = e; current = null; }
  // 指针在写盘时已被本次覆盖 ⇒ 报告里的 baselineRef 才是"改动前"那一份（写盘前读的）
  const basePath = (current && current.baselineRef) ? path.resolve(ROOT, String(current.baselineRef).split(/[\\/]/).join(path.sep)) : null;
  const baseline = (basePath && fs.existsSync(basePath)) ? await reg.loadMetricsReport(basePath) : null;
  let proposals = [];
  let propNote = '';
  try {
    const j = JSON.parse(fs.readFileSync(PROPOSALS_PATH, 'utf8'));
    proposals = Array.isArray(j) ? j : (Array.isArray(j.proposals) ? j.proposals : []);
    propNote = ' · 本批提案 ' + proposals.length + ' 条（' + path.relative(ROOT, PROPOSALS_PATH) + '）';
  } catch { propNote = ' · 本批没有提案清单（' + path.relative(ROOT, PROPOSALS_PATH) + ' 不存在）'; }
  const gate = reg.evaluateGate({ current, baseline: (baseline && !baseline.__err) ? baseline : null, proposals });
  const gi = reg.goldenInPlace(current), ci = reg.c4InPlace(current);
  say('   指标：金标' + (gi.inPlace ? '在位' : '**不在位**') + ' · C4 监控' + (ci.inPlace ? '在位' : '**不在位**')
    + ' · 基线 ' + (baseline && !baseline.__err ? path.relative(ROOT, basePath) : '无（本次是第一份）') + propNote);
  if (current && Array.isArray(current.collectErrors) && current.collectErrors.length) say('   采集未取到 ' + current.collectErrors.length + ' 项（如实列在报告里，不静默）');
  // 只报数不设线：变差照实打出来，但**不进** ok/fail
  const diff = reg.diffMetrics((baseline && !baseline.__err) ? baseline : null, current);
  const degraded = diff.rows.filter((r) => r.state === 'degraded');
  if (degraded.length) say('   ⚠️ 变差（**只报数不设线**，不阻断；要不要处置需人判）：' + degraded.map((r) => r.path + ' ' + r.from + '→' + r.to).join('；'));
  // 判定：
  //   ① 有报告可判 → 只有显式 pass 才放行（fail / undecided 都不放行）；
  //   ② 一份报告都没产出来 → 这一条**没判**。此时按 §0.4 准入前置的机器侧解释处理：
  //      · 库**读到了**、只是没写盘/没采集 ⇒ 能判不判 = 红（有数不看就是盲改）；
  //      · 库**读不到**（库只在开发机/服务器上有）⇒ 如实 skipped、不阻断，但必须把原因打出来 ——
  //        客户机/无库环境的发布不能被这条卡死，这与 golden 步的既有口径一致（**跳过不等于通过**）。
  const dbUnavailable = current ? current.databaseAvailable === false : reg.looksLikeConnectionError(String((collectThrew && collectThrew.message) || ''));
  const skipped = Boolean(dbUnavailable);
  if (typeof register === 'function') {
    if (skipped) {
      register(METRICS_STEP, true, 'skipped —— 读不到库，本次没得判（**跳过不等于通过**）：' + String((current && current.collectErrors && current.collectErrors[0]) || (collectThrew && collectThrew.message) || '').slice(0, 120));
    } else {
      register(METRICS_STEP, !reg.gateBlocks(gate), reg.gateLine(gate));
    }
  }
  return { current, gate, baselinePath: basePath, dbUnavailable, skipped };
}
