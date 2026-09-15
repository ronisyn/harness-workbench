// test/metric-alerts.test.mjs —— 指标告警线夹具（2026-09-16）
//
// 依据：v0.3 §4.4.1 规则4「**增量最小化**：大结果一律溢出；给'每轮新增'设阈值并监控」。
// 主导架构师拍板：**阈值机制在位、缺省不设线、由配置给数**。本夹具逐条锁住这四句：
//   ① 缺省（配置为空/缺行）⇒ **一条告警都不产**，行为与改造前逐字相同（"只报数不设线"的原状）；
//   ② 配了线且越线 ⇒ 告警出现（进制形状：指标/运算符/阈值/实测值/单位/可读一句）；
//   ③ 配了线未越线 ⇒ 不告警；
//   ④ **越线不阻断**：评估函数没有 throw / exit / 拒绝分支；越线在流水线里只多一条**待审提案**。
//   反向核对（这是本批最要紧的一条）：**代码里不许有任何默认阈值数字** ——
//   把设置键的 def 与 alerts.js 的源码都扫一遍，出现"内部自带一个 1000/5000/0.99"就是违规。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPERATORS, METRIC_DEFS, METRIC_KEYS, parseLines, crossed, evaluateLines, metricsFromSnapshot,
} from '../server/selfeval/alerts.js';
import { rulesFromSnapshot, buildProposals, checkIronLaw } from '../server/selfeval/propose.js';
import { SETTINGS_SCHEMA, schemaByKey, validateSetting } from '../server/settingsSchema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALERTS_SRC = fs.readFileSync(path.join(ROOT, 'server', 'selfeval', 'alerts.js'), 'utf8');

/** 一份最小快照（形状与 collect.js 的 buildSnapshot 同形；数值是夹具自造的样本，不是真库读数） */
function snapWith({ c2Median = 3200, c2P95 = 9000, c1 = 0.42, perRun = 2.89, c4 = 3 } = {}) {
  return {
    kind: 'rw-selfeval-snapshot', schema: 1, batchId: 'selfeval-2026-09-16-7d',
    window: { days: 7, cutoff: null, unit: '库本地时间(UTC+8)' },
    metrics: {
      c1c2: { status: 'ok', cohorts: { real: { status: 'ok', rounds: 40, c1, c2Median, c2P95 } } },
      c3: { status: 'ok', perRun, total: 115.6, runs: 40 },
      c4c5: { status: 'ok', c4Invalidate: c4, c5Exempt: 12 },
      failures: { status: 'ok', calls: 500, fails: 25 },
      canary: { status: 'ok', available: true, shells: [{ skey: 'code', total: 9, passed: 9 }] },
      pipeline: { status: 'ok', evoGoals: 1, evoGoalTasks: 1, demandsByStatus: [{ status: '待审', n: 2 }], evoMemos: 1 },
    },
    benchmarkSources: [], collectErrors: [],
  };
}

// ── ① 缺省：不设线 ⇒ 零告警（与现在一致）──────────────────────────────────────────────────
test('告警线①：设置缺省为空 ⇒ 一条告警都不产（"只报数不设线"的原状）', () => {
  const m = metricsFromSnapshot(snapWith());
  assert.equal(evaluateLines({ lines: '', metrics: m }).length, 0, '空配置必须零告警');
  assert.equal(evaluateLines({ lines: '   ', metrics: m }).length, 0, '空白串同义');
  assert.equal(evaluateLines({ lines: null, metrics: m }).length, 0, 'null 同义');
  assert.equal(evaluateLines({ metrics: m }).length, 0, '不传 lines 同义');
  assert.deepEqual(parseLines(''), {}, '空配置解析成"没有线"，而不是"默认线"');
  // 反向：库的**缺行**与"空"必须是同一件事（设置表里没有这条键的种子行）
  const schema = schemaByKey('metric_alert_lines');
  assert.ok(schema, 'metric_alert_lines 必须登记在 settingsSchema（一处声明 → API 校验/UI 渲染/默认值同源）');
  assert.equal(schema.def, '', '缺省必须是空（不设线）——def 写数字就是"发明阈值"');
});

// ── ② 配了线且越线 ⇒ 告警出现（形状可读、可落账）─────────────────────────────────────────
test('告警线②：配了线且越线 ⇒ 告警出现，形状含指标/线/实测值/单位', () => {
  const m = metricsFromSnapshot(snapWith({ c2Median: 3200 }));
  const a = evaluateLines({ lines: '{"c2Median":{"op":"<=","value":1000}}', metrics: m });
  assert.equal(a.length, 1);
  assert.equal(a[0].metric, 'c2Median');
  assert.equal(a[0].op, '<=');
  assert.equal(a[0].value, 1000);
  assert.equal(a[0].actual, 3200);
  assert.equal(a[0].level, 'alert');
  assert.match(a[0].message, /c2Median 3,200 > 1,000/);
  assert.equal(a[0].unit, METRIC_DEFS.c2Median.unit);
  // 数组写法同义（两种写法都只认同一份取值域）
  assert.deepEqual(parseLines('{"c2Median":["<=",1000]}'), { c2Median: { op: '<=', value: 1000 } });
  assert.equal(evaluateLines({ lines: '{"c2Median":["<=",1000]}', metrics: m }).length, 1);
});

// ── ③ 配了线但没越线 ⇒ 不告警 ───────────────────────────────────────────────────────────
test('告警线③：配了线未越线 ⇒ 不告警（且四个运算符语义都是它字面的意思）', () => {
  const m = metricsFromSnapshot(snapWith({ c2Median: 800, c1: 0.995, c4: 0 }));
  assert.equal(evaluateLines({ lines: '{"c2Median":{"op":"<=","value":1000}}', metrics: m }).length, 0, '800 ≤ 1000 不越线');
  assert.equal(evaluateLines({ lines: '{"c1":{"op":">=","value":0.99}}', metrics: m }).length, 0, '0.995 ≥ 0.99 不越线');
  assert.equal(evaluateLines({ lines: '{"c4Invalidate":{"op":"<=","value":0}}', metrics: m }).length, 0, 'C4=0 不越线');
  // 四个运算符的边界语义（恰好等于线 = 不越线；越线一律是"越过了"那一侧）
  assert.equal(crossed('<=', 1000, 1000), false);
  assert.equal(crossed('<=', 1001, 1000), true);
  assert.equal(crossed('<', 1000, 1000), true);
  assert.equal(crossed('>=', 0.99, 0.99), false);
  assert.equal(crossed('>=', 0.98, 0.99), true);
  assert.equal(crossed('>', 0.99, 0.99), true);
  assert.deepEqual(OPERATORS, ['<=', '<', '>=', '>']);
});

// ── 缺数不判（no-denominator ≠ 越线，也 ≠ 达标）────────────────────────────────────────
test('告警线④：读数缺项（null）⇒ 不判（既不报越线，也不当达标）', () => {
  const m = metricsFromSnapshot({ metrics: { c1c2: { cohorts: { real: { status: 'no-data' } } }, c3: {}, c4c5: {} } });
  const lines = '{"c2Median":{"op":"<=","value":1000},"c1":{"op":">=","value":0.99},"c4Invalidate":{"op":"<=","value":0}}';
  assert.equal(evaluateLines({ lines, metrics: m }).length, 0, '没有读数就没有可比对象，不许造出假告警');
  assert.equal(evaluateLines({ lines: '{"c2Median":{"op":"<=","value":1000}}', metrics: {} }).length, 0);
});

// ── 配置写错 ⇒ 如实抛错（不静默忽略）────────────────────────────────────────────────────
test('告警线⑤：配置形状/指标名/数字不合法 ⇒ 如实抛错（静默忽略比不设线更坏）', () => {
  assert.throws(() => parseLines('{不是 json'), /不是合法 JSON/);
  assert.throws(() => parseLines('[1,2]'), /需为对象/);
  assert.throws(() => parseLines('{"c9Median":{"op":"<=","value":1}}'), /unknown metric/);
  assert.throws(() => parseLines('{"c2Median":{"op":"≈","value":1}}'), /运算符不合法/);
  assert.throws(() => parseLines('{"c2Median":{"op":"<=","value":"一千"}}'), /阈值不是数字/);
  // 设置写入口也要拦（留空＝不设，非空必须能 JSON.parse）
  assert.equal(validateSetting('metric_alert_lines', '').ok, true);
  assert.equal(validateSetting('metric_alert_lines', '  ').ok, true);
  assert.equal(validateSetting('metric_alert_lines', '{"c2Median":{"op":"<=","value":1000}}').ok, true);
  assert.equal(validateSetting('metric_alert_lines', '{坏').ok, false);
});

// ── ⑥ 越线**不阻断**：只多一条待审提案（走既有处置路径）──────────────────────────────────
test('告警线⑥：越线在流水线里只产一条待审提案，不阻断、不自作主张', () => {
  const snap = snapWith({ c2Median: 3200 });
  const lines = '{"c2Median":{"op":"<=","value":1000}}';
  const rules = rulesFromSnapshot(snap, lines);
  const r8 = rules.filter((r) => r.rule === 'R8-metric-alert-line');
  assert.equal(r8.length, 1, '越线应当产出一条 R8 提案');
  assert.match(r8[0].title, /指标越线 1 项/);
  assert.match(r8[0].basis, /1,000/);
  // 走提案流水线：铁律自检必须过（缺"验证方式"/出现自动化措辞都会被拒），且必须声明需人工审批
  const built = buildProposals({ snapshot: snap, alertLines: lines });
  const p = built.proposals.find((x) => x.rule === 'R8-metric-alert-line');
  assert.ok(p, 'R8 提案必须能进流水线（未被铁律拦下）');
  assert.equal(p.manualApprovalRequired, true, '仍须人工审批（M3 铁律不松）');
  assert.equal(p.autoApply, undefined);
  assert.equal(checkIronLaw(p).ok, true);
  assert.equal(built.rejected.length, 0);
});

// ── ⑧ 页面标记那一半：字段名与形状必须与 Dashboard 读的一致 ───────────────────────────────
test('告警线⑧：页面标记读的字段与 alerts 产出的形状同源（前端不自己解释指标）', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'src', 'Dashboard.jsx'), 'utf8');
  assert.match(dash, /hitSum\.metricAlerts/, 'Dashboard 必须读 hitSum.metricAlerts（缺省无此字段⇒不显示，行为与现状相同）');
  const a = evaluateLines({ lines: '{"c2Median":{"op":"<=","value":1000}}', metrics: metricsFromSnapshot(snapWith()) });
  assert.equal(typeof a[0].message, 'string', '页面标记只用 .message（形状对不上就会渲染出 undefined）');
  assert.equal(a[0].level, 'alert', '告警级别只有"告警"一档（不设熔断档，见文件头）');
  // 服务端接线点必须写在 alerts.js 文件头里（本批未动 server/index.js，接手的人要一眼找到）
  assert.match(ALERTS_SRC, /未做的接线|本批\*\*未动\*\*/, 'alerts.js 必须如实写出"页面标记的服务端接线未做"');
});

// ── 反向核对：代码/配置里不许有默认阈值数字 ───────────────────────────────────────────────
test('告警线⑦（反向）：alerts.js 与设置键里都不许自带默认数字（不许发明阈值）', () => {
  // ① 设置键的缺省必须为空；提示语里不许出现"默认 1000"这类默认线
  const s = schemaByKey('metric_alert_lines');
  assert.equal(s.def, '');
  assert.equal(s.type, 'json');
  // ② alerts.js 源码：把注释剥掉后，除 JSON 示例与单位说明外不许出现阈值数字字面量。
  //    判据取"看起来像阈值的数字"（>=100 的整数/小数、0.9x 这类比率）—— 误报就改源码，不许放宽判据。
  const code = ALERTS_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/^\s*\/\/.*$/gm, '')          // 行注释
    .replace(/`[^`]*`/g, '``');            // 模板串（说明文案）
  const numericLiterals = [...code.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)].map((m) => m[1]);
  const suspicious = numericLiterals.filter((n) => Number(n) >= 100 || /^0\.(9\d+)$/.test(n));
  assert.deepEqual(suspicious, [], 'alerts.js 里出现了像阈值/默认线一样的数字字面量：' + suspicious.join(', ')
    + '（线只允许来自配置；要举例就写进注释或模板串）');
  // ③ 整份 schema 里除本键之外，不许再冒出第二个"指标线"式的键（线只有一个出处）
  const lineKeys = SETTINGS_SCHEMA.filter((x) => /alert|line|threshold|阈值/i.test(x.key));
  assert.deepEqual(lineKeys.map((x) => x.key), ['metric_alert_lines'], '线的配置入口只允许有一个');
  // ④ 可设线的指标就是 METRIC_DEFS 那几个（本夹具用它算过，别悄悄加/减）
  assert.deepEqual(METRIC_KEYS, ['c1', 'c2Median', 'c2P95', 'c3PerRun', 'c4Invalidate', 'c5Exempt']);
});
