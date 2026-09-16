// server/selfeval/alerts.js —— 指标告警线：**阈值机制在位、缺省不设线、由配置给数**（2026-09-16）
//
// 依据：v0.3 §4.4.1 规则 4「**增量最小化**：大结果一律溢出；给'每轮新增'设阈值并监控」。
// 主导架构师拍板的口径（这一条与本仓既有裁定不冲突，两者都要落）：
//   · **机制在位**：本文件把"线"这件事做成可配置、可评估、可机检的机制（`metric_alert_lines`）；
//   · **缺省不设线**：配置为空 ⇒ `evaluateLines` 恒返回 `[]`，**行为与改造前逐字相同**（只报数）；
//   · **由配置给数**：本文件**不写任何默认数字**，也不发明阈值——线只可能来自设置键，或被显式传给
//     `evaluateLines({ lines })` 的调用方（例如夹具）。
//   · **越线只告警、绝不阻断**：告警的唯一形态是"一条可读的告警记录"（由调用方落成待审提案/页面标记）；
//     本模块**没有**任何 throw/exit/拒绝执行的分支——"设阈值并监控"的能力在位，但线不是熔断器。
//
// 与既有分工的关系（别混用两把尺）：
//   · `server/selfeval/collect.js` —— 只采集与成型（口径单一出处），**不判达标**；
//   · 本文件 —— 只把"读数 vs 配置的线"比一下，产出告警记录；
//   · `server/selfeval/propose.js` —— 把告警记录转成**待审提案**（人工处置，M3 铁律不松）；
//   · `scripts/ra35-report.mjs` 里的 99%/1k/5k —— 那是 RA-35 **判定报告**自带的判定线，属另一处既有口径，
//     本模块**不复制**它，也不把它当默认值（"只报数不设线"是本仓对文档的登记偏离，见交付报告）。
//
// 设线怎么落到产品面（**2026-09-17 已接，接线点如下**）：
//   · 引擎侧：本模块 + 设置键 `metric_alert_lines` + `propose.js` 的 R8 规则（待审提案）；
//   · 页面标记（`src/Dashboard.jsx`）：`GET /api/cache-hit/summary` 现在会带出 `metricAlerts` 字段 ——
//     在 C2 取到之后加的那一行就是（读数全部取自该端点**已经查回来的** c1/c2/c3/c4/c5，不新采集、不重算口径）：
//       `metricAlerts: evaluateLines({ lines: await loadMetricAlertLines(), metrics: { c1, c2Median: c2.median, c2P95: c2.p90, c3PerRun: c3.perRun, c4Invalidate: c4.count, c5Exempt: c5.total } })`
//     缺省不设线 ⇒ 空数组 ⇒ 页面那段什么都不显示，行为与接线前逐字相同。
//     线写坏了（不是合法 JSON/未知指标/运算符不合法）**不会把整页打成 500**：原因进同一个响应体的
//     `metricAlertsError`，页面照常出数——"监控看着像开着"比"这一块显示不出来"更坏，所以不静默吞。
//   · 原文留痕（历史登记，已由上面这条兑现）：接线前这里写的是「页面标记要 `GET /api/cache-hit/summary`
//     多带一个字段（`server/index.js` 本批**未动**，由平台面接手）——在 C2 取到之后加一行即可」。

/** 运算符：只收四个，语义就是它字面的意思（不引入"警告档/严重档"这类要拍脑袋的档位）。 */
export const OPERATORS = Object.freeze(['<=', '<', '>=', '>']);

/**
 * 可设线的指标（**取值域的唯一出处**）：键＝快照/METER 字段名，值＝单位与来源说明。
 * 全部取自 `collect.js` 已成型的那几个读数——**不新采集任何东西**，也不重复它的口径。
 */
export const METRIC_DEFS = Object.freeze({
  c1: { unit: '比率 0–1', from: 'metrics.c1c2.cohorts.real.c1', note: 'C1 会话整体命中率（真实流量档）' },
  c2Median: { unit: 'tokens（每轮新增未命中的中位）', from: 'metrics.c1c2.cohorts.real.c2Median', note: 'v0.3 §4.4.1 规则4 点名的"每轮新增"' },
  c2P95: { unit: 'tokens（上述 P95）', from: 'metrics.c1c2.cohorts.real.c2P95', note: '同上，看尾部' },
  c3PerRun: { unit: '元/run', from: 'metrics.c3.perRun', note: 'C3 单位任务成本' },
  c4Invalidate: { unit: '次', from: 'metrics.c4c5.c4Invalidate', note: 'C4 非预期前缀失效' },
  c5Exempt: { unit: '次', from: 'metrics.c4c5.c5Exempt', note: 'C5 豁免失效（只报数）' },
});

export const METRIC_KEYS = Object.freeze(Object.keys(METRIC_DEFS));

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * 解析配置（纯函数）：`metric_alert_lines` 的原始值 → `{ '<metric>': { op, value } }`。
 *
 * 空/缺省 ⇒ `{}`（**不设线**，这是缺省语义，不是错误）。形状不对 ⇒ **如实抛错**：
 * "线"这种配置写错了却静默忽略，比不设线更坏——人会以为监控开着（与 v0.3 §4.6「禁止静默降级」同一纪律）。
 * 未知指标名同样抛错（`METRIC_DEFS` 是取值域唯一出处，配置写到别处就是写错了）。
 *
 * 收两种写法（都只认同一份取值域）：`{"c2Median":{"op":"<=","value":1000}}` 与 `{"c2Median":["<=",1000]}`。
 */
export function parseLines(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return {};
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error('metric_alert_lines 不是合法 JSON：' + (e && e.message)); }
  if (obj == null) return {};
  if (!isPlainObject(obj)) throw new Error('metric_alert_lines 需为对象（{指标:{op,value}}）；当前是 ' + typeof obj);
  const out = {};
  for (const [key, spec] of Object.entries(obj)) {
    if (!METRIC_KEYS.includes(key)) {
      throw new Error('unknown metric「' + key + '」：可设线的指标只有 ' + METRIC_KEYS.join(' / ') + '（取值域＝本文件的 METRIC_DEFS，不另立一份）');
    }
    const op = Array.isArray(spec) ? spec[0] : (spec && spec.op);
    const value = Array.isArray(spec) ? spec[1] : (spec && spec.value);
    if (!OPERATORS.includes(String(op))) throw new Error('指标 ' + key + ' 的运算符不合法：' + op + '（只收 ' + OPERATORS.join(' ') + '）');
    if (!Number.isFinite(Number(value))) throw new Error('指标 ' + key + ' 的阈值不是数字：' + value);
    out[key] = { op: String(op), value: Number(value) };
  }
  return out;
}

/** 比较（纯函数）。`<=` 语义＝"不超过这条线"，即 `actual <= value` 为**越线**（反向指标）—— */
/** 为什么不是 `>=`：C2 的线是"每轮新增不得超过多少"，配置写的是**上限值**，越线＝超上限。 */
export function crossed(op, actual, value) {
  switch (op) {
    case '<=': return actual > value;
    case '<': return actual >= value;
    case '>=': return actual < value;
    case '>': return actual <= value;
    default: throw new Error('未知运算符：' + op);
  }
}

/** 人类可读的一句：`c2Median 3,200 > 1,000（tokens（每轮新增未命中的中位））` */
const fmtNum = (n) => (n == null ? '未取到' : Number(n).toLocaleString('en-US'));
function describe(key, line, actual) {
  const def = METRIC_DEFS[key] || {};
  const rel = { '<=': '>', '<': '>=', '>=': '<', '>': '<=' }[line.op];
  return `${key} ${fmtNum(actual)} ${rel} ${fmtNum(line.value)}（${def.unit || '未知单位'}）`;
}

/**
 * 读设置键（**只读一处**）：`settings.metric_alert_lines`。读不到/为空 ⇒ `''`（＝不设线）。
 * `dbc` 是夹具缝（与 `collect.js` 的只读函数同一做法）：不传就走真库。
 * ⚠️ 读不到设置行**不等于**"线不存在"以外的任何事——本仓没有这条键的种子行，缺行就是缺省。
 */
export async function loadMetricAlertLines({ dbc = null, key = 'metric_alert_lines' } = {}) {
  const conn = dbc || (await import('../db.js')).db;
  try {
    const rows = await conn.query('SELECT svalue FROM settings WHERE skey=?', [key]);
    const row = Array.isArray(rows) ? rows[0] : null;
    return row && row.svalue != null ? String(row.svalue) : '';  } catch (e) {
    // 读设置失败**不阻断**任何事：如实报"没读到线"，按"不设线"继续（只报数）。
    console.warn('[alerts] 读不到 ' + key + '（按"不设线"继续，只报数）：' + ((e && e.message) || e));
    return '';
  }
}

/**
 * 评估：读数 vs 线 → 告警数组（**只产出告警记录，没有任何阻断动作**）。
 *
 * @param {object} o
 *   · `lines`   —— `metric_alert_lines` 的原始值（字符串/对象都收）。空 ⇒ 返回 `[]`（缺省不设线）。
 *   · `metrics` —— 读数（键见 `METRIC_DEFS`；缺项/`null` **不判**：没读数不是"越线"，也不是"达标"）。
 *   · `at`      —— 评估时刻（ISO 串，可省）。
 * @returns {Array<{metric, op, value, actual, level:'alert', unit, message, at}>}
 */
export function evaluateLines({ lines = '', metrics = {}, at = null } = {}) {
  const parsed = parseLines(typeof lines === 'string' ? lines : JSON.stringify(lines));
  const keys = Object.keys(parsed);
  if (!keys.length) return [];   // 缺省：不设线 ⇒ 一条告警都没有（与改造前逐字相同）
  const out = [];
  for (const key of keys) {
    const line = parsed[key];
    const actual = metrics ? metrics[key] : null;
    // 没读数（null/undefined/NaN）⇒ 不判。把"缺数"读成"越线"会造出假告警，读成"达标"会掩盖缺口——
    // 与 collect.js「no-denominator 不写成 0」同一条纪律。
    if (actual == null || !Number.isFinite(Number(actual))) continue;
    const a = Number(actual);
    if (!crossed(line.op, a, line.value)) continue;
    out.push({
      metric: key,
      op: line.op,
      value: line.value,
      actual: a,
      level: 'alert',
      unit: (METRIC_DEFS[key] || {}).unit || null,
      message: describe(key, line, a),
      at: at || null,
    });
  }
  return out;
}

/**
 * 把快照（`collect.js` 的成型产物）摊成 `evaluateLines` 认的读数——**只读它已有的字段，不重算口径**。
 * 调用方（例如 `propose.js` 的 R8）用它把"读数"和"线"接起来，避免第二处解释指标的代码。
 */
export function metricsFromSnapshot(snapshot) {
  const m = (snapshot && snapshot.metrics) || {};
  const real = ((m.c1c2 || {}).cohorts || {}).real || {};
  const c3 = m.c3 || {};
  const ledger = m.c4c5 || {};
  return {
    c1: real.c1 ?? null,
    c2Median: real.c2Median ?? null,
    c2P95: real.c2P95 ?? null,
    c3PerRun: c3.perRun ?? null,
    c4Invalidate: ledger.c4Invalidate ?? null,
    c5Exempt: ledger.c5Exempt ?? null,
  };
}
