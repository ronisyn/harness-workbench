// test/metrics-gate.test.mjs —— ㉔「优先级判据 + 指标回归门禁」夹具（**不碰真库、不跑真金标、零 LLM 成本**）
//
// 为什么锁这几条（逐条对应 v0.3 原文，见 server/selfeval/regression-gate.js 顶部引用）：
//   ① **§0.4 优先级判据**：「① 能减少 C4 失效/降成本 ② 能提高交付速度 ③ 能减少人工介入 —— 三者优先于
//      "加新功能"」。这句必须是**可机检的排序**，不是注释 ⇒ 夹具直接断言"自称加新功能的那条排在三类之后"，
//      并且用**负例**挡住"哪天把加新功能塞进第一档"。
//   ② **§0.4 准入前置**：「金标回归 + 失效监控（C4）必须在位」⇒ 缺一个就红，且"跳过/读不到"**不算在位**。
//   ③ **§0.4 M3 出口标准**：「每条附前后指标对比」⇒ 提案没有对比对象就红。
//   ④ **前后对比必须先判"集合变了还是行为变了"**：金标 `eval/code.json` 增删一条断言会改 total，
//      直接比 passed 会把"扩充金标"读成"回归"（㉒㉓ 代理点名的坑）⇒ 夹具给正反两个用例。
//   ⑤ **铁律·不许发明阈值**（C-31 规则4）：变差**只报数不设线**、不阻断；门禁三态只看"在不在位"。
//      夹具用两个**数值极端**（恶化 100 倍 / 改善 100 倍）反证"门禁结论与数值大小无关"。
//   ⑥ **跳过不等于通过**：读不到库时如实 skip（`databaseAvailable=false`、`available=false`），不许当绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  rankProposals, TIER, diffMetrics, diffGolden, compareWindows, evaluateGate, gateBlocks,
  gateLine, GATE_VERDICT, goldenInPlace, c4InPlace, METRIC_PATHS, metricValue,
  normalizeCodeId, snapshotRef, buildMetricsReport, checkMetricsReport, loadMetricsReport,
} from '../server/selfeval/regression-gate.js';
import {
  buildGoldenSection, composeReport, detectCodeAnchor, writeMetricsSnapshot, readLatestPointer,
  formatReport, METRICS_REPORT_FORMAT, METRICS_REPORT_VERSION, METRICS_ROOT,
} from '../scripts/metrics-report.mjs';
import { collectReport } from '../scripts/metrics-report.mjs';
import { buildSnapshot, goldenSetIdentities } from '../server/selfeval/collect.js';
import { evaluatePriority } from '../server/selfeval/priority.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = ['c4-or-cost', 'delivery-speed', 'manual-effort'];
const P = (id, over = {}) => ({ id, title: id, ...over });

// ── 报告工厂（手工组装，**不查库**；形状与 scripts/metrics-report.mjs 的 composeReport 产物一致）──
function mkGolden({ passed = 9, total = 9, sha = 'aaaa11112222', skipped = false, cases = null, ref = 'code' } = {}) {
  const cs = cases || Array.from({ length: total }, (_, i) => ({ i: i + 1, q: 'q' + (i + 1), pass: i < passed }));
  return {
    skipped, reason: skipped ? '未配置 eval.goldenSetRef' : null, at: '2026-09-16T00:00:00Z',
    goldenSets: [{ ref, exists: true, count: total, sha1_12: sha }],
    identity: sha, identityOf: 'goldenSets',
    total: skipped ? null : total, passed: skipped ? null : passed, shellsJudged: skipped ? 0 : 1,
    shells: skipped
      ? [{ shell: 'default', ref: null, skipped: true, reason: '未配置 eval.goldenSetRef' }]
      : [{ shell: 'code', ref, skipped: false, passed, total, identity: { ref, exists: true, count: total, sha1_12: sha }, cases: cs }],
  };
}
function mkReport(over = {}) {
  const metrics = {
    c1c2: { status: 'ok', cohorts: { real: { status: 'ok', rounds: 40, c1: 0.9, c2Median: 2000, c2P95: 9000 } } },
    c3: { status: 'ok', perRun: 10, total: 400 },
    c4c5: { status: 'ok', available: true, c4Invalidate: 0, c5Exempt: 157, c5Collapse: 1 },
    failures: { status: 'ok', failRate: 0.05, calls: 500, fails: 25 },
  };
  const base = {
    schema: 1, kind: 'rw-metrics-report', format: METRICS_REPORT_FORMAT, formatVersion: METRICS_REPORT_VERSION,
    batchId: 'selfeval-2026-09-16-7d', at: '2026-09-16T04:00:00Z',
    code: { commit: 'abc123def456', dirty: false, at: '2026-09-16T04:00:00Z' },
    window: { days: 7, cutoff: null, unit: '库本地时间(UTC+8)' },
    databaseAvailable: true, collectErrors: [],
    metrics, golden: mkGolden(), ...over,
  };
  base.ref = { path: 'tmp/metrics/' + base.batchId + '/abc123def456/snapshot.json', batchId: base.batchId, codeId: 'abc123def456', hash: 'h' };
  return base;
}
/** 只改某一档指标（deep merge 一层就够用；夹具要的是"指标不同、其它全同"） */
function withMetrics(rep, patch) {
  const metrics = { ...rep.metrics };
  for (const [k, v] of Object.entries(patch)) metrics[k] = { ...(metrics[k] || {}), ...v };
  return { ...rep, metrics };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ① 优先级判据排序（v0.3 §0.4：三者优先于"加新功能"）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-① 排序：「加新功能」必须排在三类判据之后（可机检，不是写在注释里）', () => {
  const yes = evaluatePriority({ judged: { 'c4-or-cost': true, 'delivery-speed': false, 'manual-effort': false } });
  const no = evaluatePriority({ judged: { 'c4-or-cost': false, 'delivery-speed': false, 'manual-effort': false } });
  const unknown = evaluatePriority({ evidence: '减少人工介入，不用每天手动抄一遍', expectedBenefit: '省事' });   // 有信号、无实测
  const rows = rankProposals([
    P('feature', { title: '新增模型市场页', priority: no, newFeatureOnly: true }),
    P('unknown-cost', { priority: unknown }),
    P('yes-manual', { priority: yes }),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['yes-manual', 'unknown-cost', 'feature'],
    '有判据支持的 → 判不了交人的 → 加新功能（三者优先于加新功能）');
  assert.deepEqual(rows.map((r) => r.tier), [TIER.CRITERIA, TIER.UNJUDGED, TIER.NEW_FEATURE]);
  // 另一条路径：加新功能**且三条有信号但都判不了** ⇒ 仍进最后档（不是"判不了"档）
  const featUnknown = rankProposals([P('f2', { priority: unknown, newFeatureOnly: true })]);
  assert.equal(featUnknown[0].tier, TIER.NEW_FEATURE, '自称加新功能 → 最后档，不许借"判不了"往前挤');
  assert.deepEqual(rows.map((r) => r.order), [1, 2, 3], 'order 从 1 起（"第几条做"）');
  // "加新功能"排在三类**之后**这句必须能在 reasons 里读到（人看报表时不用去翻文档）
  // 注意正则要**认标记本身**（自称"加新功能"），不能只认"加新功能"四个字：判据支持的正常理由里也有这四个字
  assert.ok(rows[2].reasons.some((x) => /自称"加新功能"/.test(x)), '要写出"排在三类判据之后"的理由：' + rows[2].reasons.join(' / '));
  assert.ok(featUnknown[0].reasons.some((x) => /自称"加新功能"/.test(x)), '借"判不了"往前挤的加新功能也要写明降级理由');
  assert.ok(rows[0].reasons.some((x) => /判据支持/.test(x)));
  // 负例：判据支持 + 自称加新功能 ⇒ 仍然进第一档（判据优先，不是"提到新功能就降级"）
  const mixed = rankProposals([P('both', { priority: yes, newFeatureOnly: true })]);
  assert.equal(mixed[0].tier, TIER.CRITERIA, '有判据支持的加新功能仍在第一档');
  assert.ok(!mixed[0].reasons.some((x) => /自称"加新功能"/.test(x)), '判据支持的那条不该被贴"加新功能"的降级理由');
  // 同级保持输入顺序（稳定排序，不引入隐性权重）
  const same = rankProposals([P('a', { priority: yes }), P('b', { priority: yes })]);
  assert.deepEqual(same.map((r) => r.id), ['a', 'b']);
  // 没判过的提案（priority 缺失）不许被静默丢掉，按"判不了/交人"处理，且**不许**跑到第一档
  const unjudged = rankProposals([P('x')])[0];
  assert.equal(unjudged.tier, TIER.UNJUDGED, '没判过 ⇒ 排在判据支持之后（未判不等于有价值，也不等于没价值）');
  assert.equal(unjudged.id, 'x');
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ② 对比器四态（变好/变差/新增/消失）+ 方向未定只报数
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-② 对比器四态各一条：变好 / 变差 / 新增 / 消失', () => {
  const prev = withMetrics(mkReport({ at: '2026-09-16T04:00:00Z' }), {
    c1c2: { cohorts: { real: { status: 'ok', rounds: 40, c1: 0.80, c2Median: 2000, c2P95: 9000 } } },
  });
  const cur = withMetrics(mkReport({ at: '2026-09-16T05:00:00Z' }), {
    c1c2: { cohorts: { real: { status: 'ok', rounds: 40, c1: 0.95, c2Median: 5000, c2P95: 9000 } } },
  });
  const d = diffMetrics(prev, cur);
  const byPath = Object.fromEntries(d.rows.map((r) => [r.path, r]));
  assert.equal(byPath['metrics.c1c2.cohorts.real.c1'].state, 'improved', 'C1 升 = 变好');
  assert.equal(byPath['metrics.c1c2.cohorts.real.c2Median'].state, 'degraded', 'C2 升 = 变差（越低越好）');
  assert.equal(byPath['metrics.c1c2.cohorts.real.c2P95'].state, 'unchanged');
  // 新增：上次读不到、这次读到了（分母从 0 变有 ⇒ 失败率从 null 变有值）
  const newOne = diffMetrics(withMetrics(prev, { failures: { failRate: null, calls: 0 } }), withMetrics(cur, { failures: { failRate: 0.05, calls: 500 } }));
  assert.equal(newOne.rows.find((r) => r.path === 'metrics.failures.failRate').state, 'new');
  assert.match(newOne.rows.find((r) => r.path === 'metrics.failures.failRate').note, /不是变好也不是变差/);
  // 消失：这次读不到（C4 台账读不到 ⇒ null）
  const gone = diffMetrics(cur, withMetrics(cur, { c4c5: { available: false, c4Invalidate: 0 } }));
  assert.equal(gone.rows.find((r) => r.path === 'metrics.c4c5.c4Invalidate').state, 'gone');
  assert.match(gone.rows.find((r) => r.path === 'metrics.c4c5.c4Invalidate').note, /不是变差，但也不能当没发生/);
  // 方向未定（口径没登记哪边算好）：只报数 + 需人判，不许猜
  assert.equal(byPath['metrics.c1c2.cohorts.real.rounds'].state, 'unchanged');
  const rounds = diffMetrics(withMetrics(prev, { c1c2: { cohorts: { real: { rounds: 10 } } } }), cur);
  assert.equal(rounds.rows.find((r) => r.path === 'metrics.c1c2.cohorts.real.rounds').state, 'changed');
  assert.match(rounds.rows.find((r) => r.path === 'metrics.c1c2.cohorts.real.rounds').note, /需人判/);
  // 没有基线 ⇒ hasBaseline=false（"缺前后对比"，不是"通过"）
  assert.equal(diffMetrics(null, cur).hasBaseline, false);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ③ 集合变了 vs 行为变了（㉒㉓ 代理点名的坑）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-③ 集合变化 vs 行为变化必须分开：扩充金标不得被读成回归', () => {
  // 集合变了：金标从 9 条扩到 10 条（身份与 total 都变），passed 仍是 9/9 —— 这不是回归
  const grew = diffGolden(mkReport({ golden: mkGolden({ passed: 9, total: 9, sha: 'aaaa' }) }), mkReport({ golden: mkGolden({ passed: 9, total: 10, sha: 'bbbb' }) }));
  assert.equal(grew.setChanged, true);
  assert.equal(grew.behaviorChanged, false, '**集合变了就不许下"行为变差"的结论**');
  assert.match(grew.notes.join(' '), /不是同一套金标/);
  assert.match(grew.notes.join(' '), /不可当作行为回归/);
  // 行为变了：同一套金标（身份+total 一样），第 3 条从过变成不过
  const casesA = [{ i: 1, q: 'a', pass: true }, { i: 2, q: 'b', pass: true }, { i: 3, q: 'c', pass: true }];
  const casesB = [{ i: 1, q: 'a', pass: true }, { i: 2, q: 'b', pass: true }, { i: 3, q: 'c', pass: false }];
  const flip = diffGolden(
    mkReport({ golden: mkGolden({ passed: 3, total: 3, sha: 'same', cases: casesA }) }),
    mkReport({ golden: mkGolden({ passed: 2, total: 3, sha: 'same', cases: casesB }) }));
  assert.equal(flip.setChanged, false, '身份与条目数一致 ⇒ 不是集合变化');
  assert.equal(flip.behaviorChanged, true);
  assert.deepEqual(flip.flips.map((f) => f.key), ['code#3'], '要能指出**是哪一条**翻了');
  assert.match(flip.notes.join(' '), /行为变了/);
  // 反向核对（曾真踩过的错法）：只看 total 就会把"扩充金标"当回归 —— 这里明确断言"不是"
  assert.notEqual(grew.setChanged, grew.behaviorChanged);
  // 两边都没判过（全 skipped）：既不是集合变化也不是行为变化，且**不能算在位**
  const skipped = diffGolden(mkReport({ golden: mkGolden({ skipped: true }) }), mkReport({ golden: mkGolden({ skipped: true }) }));
  assert.equal(skipped.setChanged, false);
  assert.equal(skipped.behaviorChanged, false);
  assert.equal(goldenInPlace(mkReport({ golden: mkGolden({ skipped: true }) })).inPlace, false, 'skipped ≠ 在位');
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ④ 门禁：在位性判定（缺了就红）+ 窗口语义 + **数值不参与判定**（不发明阈值）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-④ 门禁三态：金标/C4 在位 + 有可比基线 ⇒ pass', () => {
  const g = evaluateGate({ current: mkReport(), baseline: mkReport(), proposals: [] });
  assert.equal(g.verdict, GATE_VERDICT.PASS);
  assert.equal(gateBlocks(g), false, '只有显式 pass 才放行');
  assert.equal(g.checks.golden.inPlace, true);
  assert.equal(g.checks.c4.inPlace, true);
  assert.match(gateLine(g), /在位性判定/);
});

test('㉔-④b 缺"金标回归在位" ⇒ fail；跳过/跑不起来**都不算在位**', () => {
  const g = evaluateGate({ current: mkReport({ golden: mkGolden({ skipped: true }) }), baseline: mkReport() });
  assert.equal(g.verdict, GATE_VERDICT.FAIL);
  assert.equal(gateBlocks(g), true);
  assert.match(g.reasons.find((r) => r.code === 'prerequisite.golden').text, /不在位/);
  // 壳报错（跑不起来）同样不算在位
  const err = mkReport({ golden: mkGolden() });
  err.golden.shells = [{ shell: 'code', ref: 'code', error: 'SyntaxError: boom' }];
  err.golden.total = null; err.golden.passed = null; err.golden.shellsJudged = 0;
  assert.equal(goldenInPlace(err).inPlace, false);
  assert.match(goldenInPlace(err).why, /boom|没有壳真跑过/);
});

test('㉔-④c 缺"失效监控（C4）在位" ⇒ fail；台账读不到 ≠ 0 次失效', () => {
  const g = evaluateGate({ current: withMetrics(mkReport(), { c4c5: { available: false, c4Invalidate: 0, errors: ['getaddrinfo ENOTFOUND db'] } }), baseline: mkReport() });
  assert.equal(g.verdict, GATE_VERDICT.FAIL);
  assert.equal(c4InPlace(mkReport()).inPlace, true);
  assert.equal(c4InPlace(withMetrics(mkReport(), { c4c5: { available: false, errors: ['boom'] } })).inPlace, false);
  // 有 c4c5 档但缺 available 字段（老报告）⇒ 不许当在位（宁可报"没读到"）
  assert.equal(c4InPlace(withMetrics(mkReport(), { c4c5: { available: undefined, c4Invalidate: 0 } })).inPlace, false);
});

test('㉔-④d 缺前后对比 ⇒ 红；**没有基线**或**窗口不可比**都算缺', () => {
  const noRef = [{ id: 'REQ-1' }];
  const g1 = evaluateGate({ current: mkReport(), baseline: mkReport(), proposals: noRef });
  assert.equal(g1.verdict, GATE_VERDICT.FAIL);
  assert.equal(g1.checks.proposals.missing[0].id, 'REQ-1');
  // 有对比对象 + 有基线 ⇒ 这一条过
  const g2 = evaluateGate({ current: mkReport(), baseline: mkReport(), proposals: [{ id: 'REQ-1', baselineRef: 'tmp/metrics/a/snapshot.json' }] });
  assert.equal(g2.checks.proposals.missing.length, 0);
  assert.equal(g2.verdict, GATE_VERDICT.PASS);
  // 窗口不可比：**拒绝直接对比** ⇒ undecided（不放行），且明确说清差在哪
  const g3 = evaluateGate({ current: mkReport({ window: { days: 30, cutoff: null, unit: '库本地时间(UTC+8)' } }), baseline: mkReport(), proposals: [] });
  assert.equal(g3.verdict, GATE_VERDICT.UNDECIDED);
  assert.equal(gateBlocks(g3), true, '**未判也不放行**');
  assert.match(g3.reasons.find((r) => r.code === 'window.comparable').text, /窗口天数 7 → 30/);
  // 没有基线 ⇒ 也是"缺对比对象"，报得清楚（不许含糊成"窗口不一致"）
  assert.equal(compareWindows(null, mkReport()).diffs[0], '没有基线报告（缺对比对象）');
  const g4 = evaluateGate({ current: mkReport(), baseline: null, proposals: [] });
  assert.equal(g4.verdict, GATE_VERDICT.UNDECIDED);
  assert.equal(gateBlocks(g4), true);
});

test('㉔-④e **铁律·不发明阈值**：指标恶化一百倍与改善一百倍，门禁结论必须一样', () => {
  const base = mkReport();
  const worst = withMetrics(mkReport(), { c3: { perRun: 1000, total: 40000 }, failures: { failRate: 0.9, calls: 500, fails: 450 }, c4c5: { available: true, c4Invalidate: 999 } });
  const best = withMetrics(mkReport(), { c3: { perRun: 0.1, total: 4 }, failures: { failRate: 0.001, calls: 500, fails: 1 }, c4c5: { available: true, c4Invalidate: 0 } });
  const gw = evaluateGate({ current: worst, baseline: base, proposals: [] });
  const gb = evaluateGate({ current: best, baseline: base, proposals: [] });
  assert.equal(gw.verdict, GATE_VERDICT.PASS, '变差**不阻断**（只报数不设线）');
  assert.equal(gb.verdict, GATE_VERDICT.PASS);
  assert.deepEqual(gw.reasons.map((r) => r.code).sort(), gb.reasons.map((r) => r.code).sort(), '判定理由集合与数值大小无关');
  // 变差照样**被数出来**（只是不阻断）
  const worstDiff = diffMetrics(base, worst);
  assert.equal(worstDiff.degraded.includes('metrics.c1c2.cohorts.real.c2P95'), false, 'C2P95 没变就不该出现在变差里');
  assert.equal(worstDiff.degraded.length >= 3, true, '变差条数照实报：' + worstDiff.degraded.join('、'));
  // 判定函数里不许出现**阈值形态**的比较（`> < >= <=`，以及 `x.foo > 0.5` 这类）—— 与 golden-gate 夹具同款源码机检。
  // `!== false` / `=== true` / `=== undefined` 这类**等值/存在性**比较是允许的：它们判的是"有没有"，不是"多少"。
  const src = read('server/selfeval/regression-gate.js');
  const body = src.slice(src.indexOf('export function evaluateGate'), src.indexOf('/** 结论一行'));
  const cmps = body.match(/(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\s*(?:===|!==|>=|<=|>|<)\s*(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*/g) || [];
  const thresholds = cmps.filter((c) => /[<>]/.test(c));
  assert.deepEqual(thresholds, [], '判定分支里不许有大小比较（那条线就是阈值）：' + thresholds.join(' / '));
  // 门禁三态只由"在位/可比"决定，因此 `evaluateGate` 里不许读任何指标数值（读了就有机会拿去比）
  assert.ok(!/\.c1\b|\.c2Median|\.c2P95|\.perRun|\.failRate|\.c4Invalidate\b/.test(body),
    '判定函数不许读指标数值（只在位性判定）');
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ⑤ 报告与落盘（不可变 + 指针 + 身份）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-⑤ 报告：格式/版本/身份齐全；金标档带**身份**（不是只有 9/9）', () => {
  const snap = buildSnapshot({ at: new Date('2026-09-16T04:00:00Z'), days: 7, code: { commit: 'deadbeefcafe', dirty: true, at: '2026-09-16T04:00:00Z' } });
  const rep = composeReport(snap, buildGoldenSection({ at: '2026-09-16T04:00:00Z', shells: [{ shell: 'code', ref: 'code', skipped: false, passed: 9, total: 9, cases: [] }], goldenSets: [{ ref: 'code', exists: true, count: 9, sha1_12: 'cafe12345678' }] }), snap.code);
  assert.equal(rep.format, METRICS_REPORT_FORMAT);
  assert.equal(rep.formatVersion, METRICS_REPORT_VERSION);
  assert.match(rep.at, /^\d{4}-\d{2}-\d{2}T/, '报告头必须带时间戳');
  assert.equal(rep.golden.passed, 9);
  // 身份走**真实现**（`buildGoldenSection`），不是夹具自己编一个 hash —— 夹具要证明的是"身份被带进报告"，
  // 而不是"我编的 hash 等于我编的 hash"。
  const realIdent = buildGoldenSection({ at: '2026-09-16T04:00:00Z', shells: [{ shell: 'code', ref: 'code', skipped: false, passed: 9, total: 9, cases: [] }], goldenSets: [{ ref: 'code', exists: true, count: 9, sha1_12: 'cafe12345678' }] }).identity;
  assert.match(realIdent, /^[0-9a-f]{12}$/);
  assert.equal(rep.golden.identity, realIdent, '金标身份必须在报告里（判"前后是不是同一套"）');
  assert.equal(rep.golden.goldenSets[0].count, 9);
  // 身份会随 (ref, 条目数, 条目 hash) 变：任一变了就该被判成"集合变了"
  const other = buildGoldenSection({ at: '2026-09-16T04:00:00Z', shells: [{ shell: 'code', ref: 'code', skipped: false, passed: 9, total: 10, cases: [] }], goldenSets: [{ ref: 'code', exists: true, count: 10, sha1_12: 'cafe12345678' }] }).identity;
  assert.notEqual(other, realIdent);
  assert.equal(rep.code.commit, 'deadbeefcafe');
  assert.match(rep.ref.path, /^tmp\/metrics\/selfeval-2026-09-16-7d\/deadbeefcafe\/snapshot\.json$/);
  assert.match(rep.ref.hash, /^[0-9a-f]{12}$/, '报告自带内容指纹（核对"比的是不是同一份"）');
  assert.deepEqual(checkMetricsReport(rep), []);
  // 金标没跑（读不到库）⇒ 如实 skipped + 原因，且**不是** passed:0
  const noG = buildGoldenSection(null, '读不到库：ECONNREFUSED');
  assert.equal(noG.skipped, true);
  assert.match(noG.reason, /ECONNREFUSED/);
  assert.equal(noG.passed, null, '不许把"没跑"写成 0 分');
  assert.equal(noG.identity, null);
  // 报告读不懂时宁可报读不懂
  assert.deepEqual(checkMetricsReport(null), ['不是 JSON 对象']);
  assert.ok(checkMetricsReport({ kind: 'x' }).length >= 2);
});

test('㉔-⑤b 金标集身份：改一条断言 ⇒ 身份变；格式微调 ⇒ 身份不变', () => {
  // 真文件（随包 eval/code.json）：同一 ref 两次算出的身份必须一致（确定性）
  const a = goldenSetIdentities([{ ref: 'code' }])[0];
  const b = goldenSetIdentities([{ ref: 'code' }])[0];
  assert.deepEqual(a, b);
  assert.equal(a.exists, true, 'eval/code.json 必须随仓库在（金标随包）');
  assert.ok(a.count > 0);
  assert.match(a.sha1_12, /^[0-9a-f]{12}$/);
  // 不存在的 ref：如实 exists:false（不抛错、不编一个 hash）
  assert.deepEqual(goldenSetIdentities([{ ref: '不存在的金标集-xyz' }])[0], { ref: '不存在的金标集-xyz', exists: false, count: 0, sha1_12: null });
});

test('㉔-⑤c 不可变落盘 + 指针：同目录第二次采集**不覆盖**第一份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-metrics-'));
  try {
    const r1 = mkReport({ at: '2026-09-16T04:00:00Z' });
    const r2 = mkReport({ at: '2026-09-16T05:00:00Z' });
    const w1 = writeMetricsSnapshot(r1, { root: dir });
    const w2 = writeMetricsSnapshot(r2, { root: dir });
    assert.match(w1.rel, new RegExp('^' + METRICS_ROOT.replace('/', '\\/') + '/selfeval-2026-09-16-7d/abc123def456/snapshot\\.json$'));
    assert.notEqual(w1.rel, w2.rel, '第二份必须另起一个文件（覆盖掉就没法前后对比）');
    assert.equal(fs.existsSync(path.join(dir, w1.rel)), true);
    assert.equal(fs.existsSync(path.join(dir, w2.rel)), true);
    const back = JSON.parse(fs.readFileSync(path.join(dir, w1.rel), 'utf8'));
    assert.equal(back.at, '2026-09-16T04:00:00Z', '第一份原样还在');
    // 指针指向最新一份（门禁默认拿它当"本次"）
    const ptr = JSON.parse(fs.readFileSync(path.join(dir, METRICS_ROOT, 'latest.json'), 'utf8'));
    assert.equal(ptr.path, w2.rel);
    assert.equal(ptr.codeId, 'abc123def456');
    assert.equal(ptr.hash, r2.ref.hash);
    // 写盘方**不设** baselineRef：那是采集侧（readLatestPointer）的事 —— 这里断言它不越权
    assert.equal('baselineRef' in r1, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('㉔-⑤d 读盘：读不到返回 __err（不抛），缺字段的报告报"读不懂"', async () => {
  const missing = await loadMetricsReport(path.join(ROOT, 'tmp', 'metrics', '根本不存在的.json'));
  assert.match(missing.__err, /ENOENT|no such file/i);
  assert.equal(normalizeCodeId({ commit: 'abcdef1234567890' }), 'abcdef123456', '代码锚截 12 位');
  assert.equal(normalizeCodeId(null), 'nogit', '读不到 git ⇒ nogit（不编假版本）');
  const ref = snapshotRef({ batchId: 'b', at: 'x', code: { commit: null } });
  assert.match(ref.path, /^tmp\/metrics\/b\/nogit\/snapshot\.json$/);
  assert.equal(ref.url.startsWith('file:///'), true);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ⑥ 读不到库：如实 skip（不是 pass）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-⑥ 读不到库：`--no-db` 如实标"没读"（databaseAvailable=null），不许当绿', async () => {
  const { report } = await collectReport({ days: 7, noDb: true, at: new Date('2026-09-16T04:00:00Z'), code: { commit: null, dirty: false, at: 'x' } });
  assert.equal(report.databaseAvailable, null, 'null = 本次没读（既不是"读到了"也不是"读不到"）');
  assert.match(report.collectErrors.join(' '), /没有读库|no-db/i);
  assert.equal(report.golden.skipped, true);
  assert.match(report.golden.reason, /跳过不等于通过/);
  // 报告侧硬条件因此不满足：未判，不放行
  const g = evaluateGate({ current: report, baseline: null, proposals: [] });
  assert.equal(g.verdict, GATE_VERDICT.FAIL);
  assert.match(gateLine(g), /不在位/);
  // 人类可读摘要也要说清"没读"
  assert.match(formatReport(report), /本次没读|没读到/);
});

test('㉔-⑥b CLI 契约：缺报告时 metrics-gate 退出码 1 且说"禁止放行"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-metrics-cli-'));
  try {
    let out = '', code = 0;
    try {
      // `--current` 指向不存在的文件：走"找不到报告 = 未判"这条路径
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'metrics-gate.mjs'), '--current', path.join(dir, '无.json')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    assert.equal(code, 1, '未判 ⇒ 退出码 1（不放行）');
    assert.match(out, /未判|禁止放行/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// ⑦ 接线：release 里必须在阻断路径上（静态断言，锚点式机检的既有做法）
// ═══════════════════════════════════════════════════════════════════════════════════════
test('㉔-⑦ 接线：release.mjs 必须把这一步接在阻断路径上，且"变差"不许进布尔', () => {
  const rel = read('scripts/release.mjs');
  assert.match(rel, /'\.\/metrics-gate-step\.mjs'/, 'release 必须调第 2.7 步本体（脚本顶层 await：不能 import 它本身做验证）');
  assert.match(rel, /register:\s*step/, '判定结果必须交给 release 的 step()（复用既有布尔守卫）');
  const stepMod = read('scripts/metrics-gate-step.mjs');
  const name = /export const METRICS_STEP = '([^']+)'/.exec(stepMod);
  assert.ok(name, '步骤名必须是常量（夹具据此断言它确实在阻断路径上）');
  assert.match(stepMod, /server\/selfeval\/regression-gate\.js/, '必须用 ㉔ 的门禁实现（不许自己另写一套判定）');
  assert.match(stepMod, /gateBlocks\(gate\)/, '必须用三态出口，不许自己写布尔表达式绕过');
  assert.match(rel, /if \(fail\.length\)[\s\S]{0,120}process\.exit\(1\)/, 'fail 非空即退出码 1（既有机制）');
  // 不许把变差直接塞进 register 的布尔里（那等于偷偷设了一条线）
  assert.ok(!/register\([^)]*(?:degraded|diff)\b/.test(stepMod), 'register 的布尔只能来自门禁三态，不许来自"变差条数"');
  assert.match(stepMod, /只报数不设线/, '这一步必须写明"变差只报数不设线"');
  assert.match(rel, /只报数不设线/, 'release 的这一步注释也要写明（读 release 的人看不到 step 模块）');
});

test('㉔-⑦b 步本体可独立跑（结论照样登记；"跳过"绝不登记成"判定通过"）', async () => {
  const { metricsGateStep, METRICS_STEP: NAME } = await import('../scripts/metrics-gate-step.mjs');
  const seen = [];
  // `register` 是 release 的 step()：这里用替身接住（**不跑 release.mjs** —— 它有 vite build 等一堆前置）。
  // 不断言 verdict（它取决于本机有没有历史基线）：断言的是**契约**——恰好登记一步、布尔、且与三态出口一致。
  const r = await metricsGateStep({
    days: 7, quiet: true, goldenReport: null,
    register: (name, ok, extra) => { seen.push({ name, ok, extra }); },
  });
  assert.equal(seen.length, 1, '必须恰好登记一步');
  assert.equal(seen[0].name, NAME);
  assert.equal(typeof seen[0].ok, 'boolean', 'release 的 step() 只收布尔（非布尔会抛 TypeError）');
  if (r.dbUnavailable) {
    // 读不到库：如实跳过（不阻断）——但理由里必须写清"跳过不等于通过"
    assert.equal(seen[0].ok, true);
    assert.match(String(seen[0].extra), /跳过不等于通过/);
    assert.equal(r.gate.verdict === GATE_VERDICT.PASS, false, '没得判 ⇒ 结论不可能是 pass');
  } else {
    // 有报告可判：登记的布尔必须**就是**三态出口的结果（不许自己另写一个表达式）
    assert.equal(seen[0].ok, !gateBlocks(r.gate), 'register 的布尔必须来自 gateBlocks（三态出口）');
  }
});

test('㉔-⑦b 白名单与三态：路径可取值、判定出口只有三个字面量', () => {
  const rep = mkReport();
  assert.equal(metricValue(rep, 'metrics.c1c2.cohorts.real.c1'), 0.9);
  assert.equal(metricValue(rep, 'golden.passed'), 9);
  assert.equal(metricValue(rep, 'metrics.c4c5.c4Invalidate'), 0);
  assert.equal(metricValue(rep, '不存在的.path'), null, '白名单外的路径取不到值（写了也等于没写）');
  assert.deepEqual(Object.keys(GATE_VERDICT).map((k) => GATE_VERDICT[k]).sort(), ['fail', 'pass', 'undecided']);
  // 每条白名单都必须真的能取到值（否则对比表里会出现永远 '-' 的行）
  for (const d of METRIC_PATHS) assert.notEqual(d.value(rep), undefined, d.path + ' 的取值器不允许返回 undefined');
});

test('㉔-⑦c 代码版本锚：本仓能取到 git sha + 脏标记（读不到时如实记 error）', () => {
  const c = detectCodeAnchor({ cwd: ROOT });
  assert.match(c.commit, /^[0-9a-f]{40}$|^[0-9a-f]{7,}$/, '要拿到真实 sha（这份读数属于哪一版代码）');
  assert.equal(typeof c.dirty, 'boolean');
  assert.match(c.at, /^\d{4}-\d{2}-\d{2}T/);
  const bad = detectCodeAnchor({ cwd: path.join(ROOT, 'tmp') });   // 不是仓库根也要能跑（不抛）
  assert.equal(typeof bad.commit === 'string' || bad.commit === null, true);
});
