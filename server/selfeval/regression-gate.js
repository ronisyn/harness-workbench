// server/selfeval/regression-gate.js —— v0.3 §7.1 ㉔「优先级判据 + 指标回归门禁」的**判定那一半**
//
// ── 文档原文（v0.3，逐字引用；本文件里所有分支都必须能指回下面某一句）──────────────────────
//   §0.4 M3 出口标准：「连续两个周期产出并落地提案，其中 ≥1 条来自外部对标、≥1 条来自自我体检；
//                       **每条附前后指标对比**；**全程无自我放行**」
//   §0.4 M3 优先级判据：「① 能减少 C4 失效 / 降成本 ② 能提高交付速度 ③ 能减少人工介入
//                       —— **三者优先于"加新功能"**」（防风险①"自我表演"）
//   §0.4 M3 准入前置：「**金标回归 + 失效监控（C4）必须在位**，否则自进化=盲改」
//   §0.4 M3 风险①：「自我表演（对策=优先级判据 + 前后指标对比）」
//   §7.1 ㉔：「优先级判据 + 指标回归门禁」（准入前置写在第 370 行：金标回归 + 失效监控在位）
//
// ── 本模块只做两件事（别的都不做）──────────────────────────────────────────────────────
//   ① **优先级排序**：把 §0.4 那三条判据做成**可机检的排序**——"加新功能"必须排在三类之后。
//      判据本身**不在这里实现**：那是 `./priority.js`（㉒㉓ 已交付，夹具在 test/selfeval.test.mjs）。
//      本文件只把它判出来的三值**翻译成名次**（0 有判据支持 / 2 三条有信号但都判不了 / 3 三条判否或加新功能）。
//      导出 `rankProposals` 的返回里带 `order`（1 起），因为 v0.3 说的是"优先"，优先**体现在名次上**。
//   ② **指标回归门禁**：金标回归 + C4 失效监控**在位**、每条提案**附了前后指标对比**——缺了就红。
//
// ── 铁律：不许发明阈值（《架构文档冲突登记-20260915》C-31「规则4：只报数不设线，不发明阈值」）──
//   v0.3 **没有**给"变差多少算回归"的线。所以本模块的判定只允许两种形态：
//     (a) **在位性判定**：机制在不在、指标读没读到、提案有没有对比对象 —— 这些都是"有/无"，不是"多少"；
//     (b) **只报数不设线**：`diffMetrics` 把变好/变差照实标出来（`improved`/`degraded`），
//         **但不阻断**任何东西；哪天真要一条线，必须由人拍板后写进这里并注明出处。
//   机检兜底：`metricVerdict` 的三态出口只有 'pass' / 'fail' / 'undecided' 三个字面量，
//   任何"数值比较"都进不了它 —— 夹具 test/metrics-gate.test.mjs 逐条锁住这条。
//
// ── 为什么改名次而不是加权重分 ──────────────────────────────────────────────────────────
//   §0.4 只说"三者优先于加新功能"，**没有**在①②③之间排序、也没给过任何权重。所以这里：
//     · ①②③ 同级（都进第 1 档），谁先谁后**保持输入顺序**（不引入隐性偏好）；
//     · "加新功能"落在最后（第 3 档），排在**已判否**之后 —— 因为已判否至少还是"落在三条判据的射程里"的提案，
//       而"加新功能"是判据明确要说"让让"的那一类。
import { ROOT } from '../config.js';
import { SNAPSHOT_SCHEMA, looksLikeConnectionError } from './collect.js';
import { CRITERIA } from './priority.js';   // §0.4 三条判据的键**只有一个出处**（priority.js），这里引用不复制
// 转出采集侧的"库根本读不到"口径（release / 门禁 CLI 用同一句判断，不许各写一份正则）
export { looksLikeConnectionError };

// ── ① 优先级判据 → 名次 ─────────────────────────────────────────────────────────────────
/** 三条判据的键（**引用 `priority.js`，不复制**）：名次判定要逐条看"判成什么" */
const CRITERIA_KEYS = CRITERIA;

/** 名次常量（数字＝序号，不是分数；**越大越靠后**）。单一出处：夹具与报表都引这里。 */
export const TIER = Object.freeze({
  /** 有机器可核的判据支持（§0.4 ①②③ 任一判为 true）—— 三者优先 */
  CRITERIA: 1,
  /** 三条判据都"有信号但无实测" ⇒ 判不了，交人看。排在判据支持之后、判否与加新功能之前（不静默丢掉） */
  UNJUDGED: 2,
  /** §0.4 明确要"让让"的那一类：三条判否，或（判据没支持却）自称加新功能 */
  NEW_FEATURE: 3,
});

/**
 * 把提案排成"三类判据优先于加新功能"的**可机检顺序**（纯函数，无 I/O）。
 *
 * @param {Array} proposals 每项需带 `id` 与 `priority`（`./priority.js` 的 `evaluatePriority` 返回值）；
 *   可选 `newFeatureOnly`（`./priority.js` 的 `isNewFeatureOnly` 结果，或提案侧自己的同类标记）
 * @returns {Array<{id, tier, order, reasons:string[]}>} 同名次内保持输入顺序
 */
export function rankProposals(proposals) {
  const arr = Array.isArray(proposals) ? proposals : [];
  const rows = arr.map((p, i) => {
    const pr = (p && p.priority && typeof p.priority === 'object') ? p.priority : null;
    const satisfied = (pr && Array.isArray(pr.satisfied)) ? pr.satisfied.filter((c) => typeof c === 'string') : [];
    const judgedMap = (pr && pr.criteria && typeof pr.criteria === 'object') ? pr.criteria : null;
    // "没判过"与"判否"必须分开：`criteria[c]` 缺键 ⇒ **判不了**（交人），不许被读成"判否"。
    // （priority.js 的 tri() 也是这个口径：非布尔一律 null；这里只是不把"没有 priority"折叠成"三条全否"。）
    const unknown = [];
    for (const c of CRITERIA_KEYS) {
      const v = judgedMap ? judgedMap[c] : null;
      if (v === true || v === false) continue;
      if (!unknown.includes(c)) unknown.push(c);
    }
    for (const c of ((pr && Array.isArray(pr.unknown)) ? pr.unknown : [])) {
      if (typeof c === 'string' && !unknown.includes(c)) unknown.push(c);
    }
    const note = (pr && typeof pr.note === 'string' && pr.note) ? pr.note : '';
    const newFeature = Boolean(p && p.newFeatureOnly === true);
    let tier;
    if (satisfied.length) tier = TIER.CRITERIA;                       // 有判据支持 ⇒ 第一档（哪怕它顺手加了新功能）
    else if (newFeature) tier = TIER.NEW_FEATURE;                     // 自称加新功能且**没有**判据支持 ⇒ 最后档（§0.4 原文）
    else if (unknown.length) tier = TIER.UNJUDGED;                    // 有信号无实测 ⇒ 判不了，交人看（排在加新功能之前）
    else tier = TIER.NEW_FEATURE;                                     // 三条判否 ⇒ 最后档
    const reasons = [];
    if (satisfied.length) reasons.push('判据支持：' + satisfied.join('、') + '（§0.4 ①②③ 优先于加新功能）');
    if (unknown.length) reasons.push('判不了交人：' + unknown.join('、') + '（没实测数据不许自己给自己打高分·§0.4 风险①）');
    if (tier === TIER.NEW_FEATURE && satisfied.length === 0 && unknown.length === 0) reasons.push('三条判据均判否');
    if (newFeature && tier !== TIER.CRITERIA) reasons.push('自称"加新功能"且没有判据支持：排在三类判据之后（§0.4 原文"三者优先于加新功能"）');
    if (note) reasons.push(note);
    return { id: (p && p.id != null) ? p.id : null, tier, order: 0, reasons };
  });
  rows.sort((a, b) => a.tier - b.tier);            // **稳定排序**：同名次保持输入顺序（Node 的 sort 是稳定排序）
  for (let i = 0; i < rows.length; i++) rows[i].order = i + 1;   // order 从 1 起（"第几条做"）
  return rows;
}

// ── ② 指标白名单（口径与 collect.js 同源；每条都带"变好是哪边"）─────────────────────────
//
// 为什么要有白名单：提案 `basis` 里只写"看 c1"，机器拿不到 JSON path（㉒㉓ 代理列的接口点④）。
// 这里把可比的指标**逐个登记**，每条给出 3 件事：path（唯一标识）、取值函数、变好的方向。
// `direction` 只影响**报表用词**（变好/变差哪个方向），**不参与判定**——它也是"口径"不是"阈值"：
//   成本/C2/C4 变低=好，C1 变高=好。方向拿不准的一律 `null` ⇒ 只报数标"需人判"，绝不猜。
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const n0 = (v) => (v == null ? null : (Number(v) || 0));

/** 一档（real/human/scheduled/probe/orphan）的取值器：该档没数据 ⇒ null（不是 0） */
const cohort = (snap, key) => ((((snap || {}).metrics || {}).c1c2 || {}).cohorts || {})[key] || {};

export const METRIC_PATHS = Object.freeze([
  { path: 'metrics.c1c2.cohorts.real.c1', cn: 'C1 真实流量缓存命中率', direction: 1, unit: 'ratio',
    value: (s) => num(cohort(s, 'real').c1) },
  { path: 'metrics.c1c2.cohorts.real.c2Median', cn: 'C2 真实流量未命中中位', direction: -1, unit: 'tokens',
    value: (s) => num(cohort(s, 'real').c2Median) },
  { path: 'metrics.c1c2.cohorts.real.c2P95', cn: 'C2 真实流量未命中 P95', direction: -1, unit: 'tokens',
    value: (s) => num(cohort(s, 'real').c2P95) },
  { path: 'metrics.c1c2.cohorts.real.rounds', cn: '真实流量轮次（样本量：不足时以上各项不可判）', direction: null, unit: '轮',
    value: (s) => num(cohort(s, 'real').rounds) },
  { path: 'metrics.c3.perRun', cn: 'C3 每 run 成本', direction: -1, unit: '元',
    value: (s) => num(((s || {}).metrics || {}).c3 && s.metrics.c3.perRun) },
  { path: 'metrics.c3.total', cn: 'C3 窗口内累计成本', direction: -1, unit: '元',
    value: (s) => num(((s || {}).metrics || {}).c3 && s.metrics.c3.total) },
  // C4：**失效监控在位的读数**。台账查得到而这类一行都没有 ⇒ 就是 0（真库现状）；
  // 台账没读到（available=false）⇒ null —— 这两种情况绝不许混（"读不到"被当成"没失效"就是盲改）。
  { path: 'metrics.c4c5.c4Invalidate', cn: 'C4 非预期前缀失效次数（机检口径 prefix:invalidate）', direction: -1, unit: '次',
    value: (s) => ((((s || {}).metrics || {}).c4c5 || {}).available === true ? n0(s.metrics.c4c5.c4Invalidate) : null) },
  { path: 'metrics.c4c5.c5Exempt', cn: 'C5 豁免失效（只报数、不设 0）', direction: null, unit: '次',
    value: (s) => ((((s || {}).metrics || {}).c4c5 || {}).available === true ? n0(s.metrics.c4c5.c5Exempt) : null) },
  { path: 'metrics.failures.failRate', cn: '失败率（真实会话）', direction: -1, unit: 'ratio',
    value: (s) => num(((s || {}).metrics || {}).failures && s.metrics.failures.failRate) },
  { path: 'metrics.failures.calls', cn: '工具调用数（失败率的分母；0 时失败率不可判）', direction: null, unit: '次',
    value: (s) => num(((s || {}).metrics || {}).failures && s.metrics.failures.calls) },
  { path: 'golden.total', cn: '金标断言总数（**集合大小**，不是成绩）', direction: null, unit: '条',
    value: (s) => num(goldenOf(s).total) },
  { path: 'golden.passed', cn: '金标通过数', direction: 1, unit: '条',
    value: (s) => num(goldenOf(s).passed) },
  { path: 'golden.shellsJudged', cn: '真判过的金标壳数（跑不起来的壳不算）', direction: null, unit: '个',
    value: (s) => num(goldenOf(s).shellsJudged) },
]);

/** 报告里的 `golden` 档（本模块的**输入约定**：`{ shells:[{shell,ref,skipped,passed,total,cases?}], identity, identityOf }`） */
function goldenOf(s) {
  return ((s || {}).golden && typeof s.golden === 'object') ? s.golden : {};
}

/** 取值（纯函数）：白名单里没有的路径返回 null —— 因为"没登记"就不该被拿来对比 */
export function metricValue(snap, path) {
  const d = METRIC_PATHS.find((x) => x.path === path);
  return d ? d.value(snap) : null;
}

// ── ③ 前后对比：**先判"集合变了还是行为变了"** ─────────────────────────────────────────
//
// 为什么必须先判集合（㉒㉓ 代理点名的坑，本仓真会踩）：
//   金标 `eval/code.json` 是**会长大**的（新增一条断言 ⇒ total 9→10）。若直接比 passed/total，
//   每次扩充金标都会显示"成绩变了"，看起来像回归 —— 这是**集合变了**，不是**行为变了**。
//   两者的处置完全不同：集合变了 → 只标注"这次比的不是同一套金标"，行为层面不报变差；
//   行为变了（同一套金标、同一批条目，通过情况翻了）→ 那才是行为回归的信号。
// 判集合变没变，靠**身份**（金标条目集合的 sha1）与**集合大小**（total/条目数），不靠成绩。

/** 金标条目集合的身份：优先用（器具给的）items 指纹，退回（壳集合 + 各壳条目数）的合成指纹 */
export function goldenIdentity(snap) {
  const g = goldenOf(snap);
  if (typeof g.identity === 'string' && g.identity) return { id: g.identity, of: g.identityOf || 'items' };
  const shells = ((g.shells) || []).filter((s) => s && !s.skipped)
    .map((s) => [String(s.shell), String(s.ref == null ? '' : s.ref), String(s.total == null ? '-' : s.total)].join('='));
  if (!shells.length) return { id: null, of: 'none' };
  return { id: shells.slice().sort().join('|'), of: 'shells+total' };
}

/** 逐条明细的可比指纹：同一套条目里哪几条翻了（行为变化的最小证据） */
function caseFlips(prev, cur) {
  const idx = (g) => {
    const m = new Map();
    for (const s of ((g.shells) || [])) {
      if (!s || s.skipped) continue;
      for (const c of (s.cases || [])) m.set(String(s.shell) + '#' + String(c.i), Boolean(c.pass));
    }
    return m;
  };
  const a = idx(prev), b = idx(cur);
  const flipped = [];
  for (const [k, v] of b) if (a.has(k) && a.get(k) !== v) flipped.push({ key: k, from: a.get(k), to: v });
  for (const [k, v] of a) if (!b.has(k)) flipped.push({ key: k, from: v, to: null });   // 条目这次没跑（skipped/消失）
  return flipped;
}

/** 金标档对比：集合变了 / 行为变了 / 都在位且一致 */
export function diffGolden(prev, cur) {
  const a = goldenOf(prev), b = goldenOf(cur);
  // 集合变化 = 身份变了（金标集本身被增删）
  const idA = goldenIdentity(prev), idB = goldenIdentity(cur);
  const setChanged = (idA.id !== idB.id);
  // 行为变化 = **同一身份**下，通过数/逐条结果翻了。身份不同就不下"行为变差"的结论（那是两个不同的东西在比）
  const pa = num(a.passed), pb = num(b.passed);
  const flips = setChanged ? [] : caseFlips(a, b);
  const behaviorChanged = !setChanged && (flips.length > 0 || (pa != null && pb != null && pa !== pb));
  const added = setChanged ? ((num(b.total) || 0) - (num(a.total) || 0)) : 0;
  const notes = [];
  if (setChanged) {
    notes.push('金标**集合变了**（身份 ' + (idA.id || '无') + ' → ' + (idB.id || '无') + '，断言数 '
      + (num(a.total) == null ? '-' : a.total) + ' → ' + (num(b.total) == null ? '-' : b.total) + '）'
      + '：这次比的**不是同一套金标**，成绩差不可当作行为回归；要判行为请用同一套金标再跑一次基线');
  }
  if (behaviorChanged) {
    notes.push('金标**行为变了**（同一套金标 ' + (idB.id || '无') + '，通过 ' + pa + ' → ' + pb
      + (flips.length ? '，逐条翻动 ' + flips.slice(0, 5).map((f) => f.key + ':' + (f.to ? '过→不过' : '状态变')).join('、') : '') + '）');
  }
  return { setChanged, behaviorChanged, identity: idA.id, identityTo: idB.id, addedItems: added, flips, notes };
}

/** 指标对比的一行（四态之一 + 集合两态），**只报数不设线** */
function metricRow(descriptor, prev, cur) {
  const a = descriptor.value(prev), b = descriptor.value(cur);
  const base = { path: descriptor.path, cn: descriptor.cn, direction: descriptor.direction, unit: descriptor.unit || null, from: a, to: b };
  if (a == null && b == null) return { ...base, state: 'unchanged', note: '两期都没读到（**没有分母/窗口内无数据**，不等于 0）' };
  if (a == null) return { ...base, state: 'new', note: '上次没有这个读数（集合新增 / 首次进入窗口）——**不是变好也不是变差**' };
  if (b == null) return { ...base, state: 'gone', note: '这次读不到（**集合消失或读库失败**）——**不是变差，但也不能当没发生**' };
  if (a === b) return { ...base, state: 'unchanged' };
  const dir = descriptor.direction;
  const state = dir == null ? 'changed' : ((b - a) * dir > 0 ? 'improved' : 'degraded');
  return { ...base, state, note: dir == null ? '方向未定（口径里没登记"哪边算好"）⇒ 只报数，需人判' : null };
}

/**
 * 逐项对比（纯函数，v0.3 §0.4"每条附前后指标对比"的机器实现）。
 * 返回：`rows`（四态 + unchanged）、`golden`（集合 vs 行为的判定）、`judged`（这次到底有没有可比的基线）
 */
export function diffMetrics(prev, cur) {
  const rows = METRIC_PATHS.map((d) => metricRow(d, prev, cur));
  const golden = diffGolden(prev, cur);
  const hasBaseline = Boolean(prev && prev.metrics);
  return {
    hasBaseline,
    // 引用优先取报告自己的 `ref.path`（可寻址位置，㉒㉓ 代理接口点③）；`baselineRef` 只是兜底
    baselineRef: hasBaseline ? (((prev.ref || {}).path) || (typeof prev.baselineRef === 'string' ? prev.baselineRef : null)) : null,
    currentRef: (cur && (((cur.ref || {}).path) || (typeof cur.baselineRef === 'string' ? cur.baselineRef : null))) || null,
    rows,
    golden,
    counts: rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {}),
    // 变差**照实数出来**，但这里不给它任何"是否阻断"的含义（那是 metricVerdict 的事，而它不看这些数）
    degraded: rows.filter((r) => r.state === 'degraded').map((r) => r.path),
  };
}

// ── ④ 窗口语义校验（㉒㉓ 代理接口点⑧）──────────────────────────────────────────────────
/** 可比性：天数、截止时间、时间单位三者一致才允许**直接**对比；不一致 ⇒ 拒绝直接对比，报"需人判" */
export function compareWindows(prev, cur) {
  // "没有基线"与"窗口不一致"**分开说**：前者是"根本没有对比对象"，后者是"两次窗口不同"。
  // 合成一句会让排查的人分不清该补哪一样（状态含糊 = 没人看）。
  if (!prev || !prev.metrics) return { comparable: false, diffs: ['没有基线报告（缺对比对象）'] };
  const a = ((prev || {}).window) || {}, b = ((cur || {}).window) || {};
  const diffs = [];
  const eq = (k, cn) => { if ((a[k] ?? null) !== (b[k] ?? null)) diffs.push(cn + ' ' + String(a[k] ?? '（缺）') + ' → ' + String(b[k] ?? '（缺）')); };
  eq('days', '窗口天数');
  eq('cutoff', '截止时间');
  eq('unit', '时间单位');
  if ((prev && prev.schema) !== (cur && cur.schema)) diffs.push('快照 schema ' + String((prev || {}).schema ?? '（缺）') + ' → ' + String((cur || {}).schema ?? '（缺）'));
  return { comparable: diffs.length === 0 && Boolean(prev && prev.metrics), diffs };
}

// ── ⑤ 门禁三态（㉒㉓ 代理接口点⑥）──────────────────────────────────────────────────────
/** 门禁结论：只有这三个字面量。**注意没有第四个** —— 任何"变差多少"都进不来。 */
export const GATE_VERDICT = Object.freeze({ PASS: 'pass', FAIL: 'fail', UNDECIDED: 'undecided' });

const reason = (code, ok, text) => ({ code, ok: Boolean(ok), text });

/** 金标回归在不在位：要有壳**真判过**（skipped / 跑不起来都不算在位，㉒㉓ 的 canaryMetric 已把这点定死） */
export function goldenInPlace(report) {
  const g = goldenOf(report);
  const shells = (g.shells || []).filter((s) => s && !s.skipped);
  const judged = shells.filter((s) => typeof s.total === 'number' && typeof s.passed === 'number');
  if (!judged.length) {
    const why = (g.shells || []).map((s) => (s && (s.reason || s.error)) || '').filter(Boolean);
    return { inPlace: false, why: why.length ? why.join('；') : '没有壳真跑过金标（未配 eval.goldenSetRef / 金标文件缺失 / 全 skipped 都算未在位）' };
  }
  return { inPlace: true, shells: judged.length, passed: judged.reduce((n, s) => n + (s.passed || 0), 0), total: judged.reduce((n, s) => n + (s.total || 0), 0) };
}

/** 失效监控（C4）在不在位：台账**读到了**才算在位（读不到 ⇒ 未在位，不是"0 次失效"） */
export function c4InPlace(report) {
  const c = (((report || {}).metrics || {}).c4c5) || null;
  if (!c) return { inPlace: false, why: '快照里没有 c4c5 档（指标报告不完整）' };
  if (c.available !== true) return { inPlace: false, why: 'C4 台账没读到：' + ((c.errors || [])[0] || c.note || '原因未记录') };
  return { inPlace: true, invalidate: c.c4Invalidate, window: c.window || null };
}

/**
 * 门禁判定（纯函数；夹具锁三态与"不看数值"）。
 *
 * @param {{current:object, baseline?:object, proposals?:Array}} input
 *   `current`：本次指标报告（含 `metrics` / `golden` / `window`）
 *   `baseline`：上一次报告（可缺 —— 缺就是"没有对比对象"，照样红）
 *   `proposals`：要入闸的提案（每条需带 `id` 与 `metricComparison`/`baselineRef`，见下）
 * @returns {{verdict:'pass'|'fail'|'undecided', reasons:Array, checks:object}}
 *
 * 三条硬条件（v0.3 原文，缺一即红）：
 *   prerequisite.golden —— §0.4「金标回归……必须在位」
 *   prerequisite.c4     —— §0.4「失效监控（C4）必须在位」
 *   proposal.comparison —— §0.4 M3 出口标准「每条附前后指标对比」
 * 一条"报告侧"的软条件（不是 v0.3 的硬条件，故只影响 verdict 的"未判"而不单独报红）：
 *   window —— 两次快照窗口语义不一致 ⇒ **拒绝直接对比**
 */
export function evaluateGate({ current = null, baseline = null, proposals = [] } = {}) {
  const reasons = [];
  if (!current || !current.metrics) {
    return {
      verdict: GATE_VERDICT.UNDECIDED,
      reasons: [reason('current.missing', false, '没有本次指标报告（采集没跑/没写盘）——未判，禁止放行')],
      checks: { golden: { inPlace: false, why: '无报告' }, c4: { inPlace: false, why: '无报告' }, window: { comparable: false, diffs: ['无报告'] }, proposals: { total: 0, withComparison: 0, missing: [] } },
    };
  }
  const g = goldenInPlace(current);
  const c4 = c4InPlace(current);
  const win = compareWindows(baseline, current);
  reasons.push(reason('prerequisite.golden', g.inPlace,
    g.inPlace ? '金标回归在位：' + g.shells + ' 个壳真判过（passed=' + g.passed + '/' + g.total + '）'
      : '金标回归**不在位**（v0.3 §0.4 准入前置）：' + g.why));
  reasons.push(reason('prerequisite.c4', c4.inPlace,
    c4.inPlace ? '失效监控（C4）在位：台账已读到，本窗口 prefix:invalidate=' + String(c4.invalidate)
      : '失效监控（C4）**不在位**（v0.3 §0.4 准入前置）：' + c4.why));

  const list = Array.isArray(proposals) ? proposals : [];
  const missing = [];
  let withComparison = 0;
  for (const p of list) {
    const ref = p && (p.baselineRef || p.metricComparison);
    const okRef = typeof ref === 'string' ? ref.trim().length > 0 : Boolean(ref);
    const okBase = Boolean(baseline && baseline.metrics && (p && p.baselineMatched !== false));
    if (okRef && okBase) withComparison++;
    else missing.push({ id: (p && p.id != null) ? p.id : null, title: (p && p.title) || null, why: okRef ? '没有可比的基线（上次报告缺或窗口不可比）' : '没附前后指标对比（缺 baselineRef/metricComparison）' });
  }
  // 一条提案都没有 ⇒ 不构成"缺对比"（本批没东西入闸）。但本批入闸提案为空这件事**不隐藏**，写在 checks 里。
  const proposalOk = missing.length === 0;
  reasons.push(reason('proposal.comparison', proposalOk,
    list.length === 0 ? '本批入闸提案 0 条（没有需要附对比的提案；这不等于"检查通过"，只是没有对象）'
      : (proposalOk ? list.length + ' 条提案均附前后指标对比' : missing.length + ' 条提案缺前后指标对比：' + missing.map((m) => (m.id || '?') + '（' + m.why + '）').join('；'))));

  const failChecks = [g.inPlace, c4.inPlace, proposalOk].filter((x) => !x).length;
  let verdict;
  if (failChecks > 0) verdict = GATE_VERDICT.FAIL;         // 硬条件缺位 ⇒ 红（缺了就是缺了）
  else if (!win.comparable) verdict = GATE_VERDICT.UNDECIDED; // 硬条件在位、但两次快照窗口不可比 ⇒ 未判
  else verdict = GATE_VERDICT.PASS;
  if (!win.comparable) reasons.push(reason('window.comparable', false, '两次快照窗口不一致，**拒绝直接对比**：' + win.diffs.join('；')));
  return {
    verdict, reasons,
    checks: {
      golden: g, c4,
      window: win,
      proposals: { total: list.length, withComparison, missing },
    },
  };
}

/** 结论一行（人读；release/CI 打印用） */
export function gateLine(r) {
  const head = r.verdict === GATE_VERDICT.PASS ? '通过（在位性判定 + 只报数不设线）'
    : r.verdict === GATE_VERDICT.FAIL ? '**不通过**（硬条件缺位）' : '未判（准入前置满足，但两次快照不可比）';
  return head + ' · ' + r.reasons.filter((x) => !x.ok).map((x) => x.text).join('；') || head;
}

/** step() 用的**布尔**：只有显式 pass 才是放行 —— 'undecided'/'fail' 一律 false（禁止把"未判"读成"通过"） */
export function gateBlocks(r) {
  return r && r.verdict === GATE_VERDICT.PASS ? false : true;
}

// ── ⑥ 快照的落盘位置与身份（㉒㉓ 代理接口点①②③）──────────────────────────────────────
//
// 为什么要有**不可变**落盘位置：门禁比的是"改动前 vs 改动后"两份快照。只给 `--out` 临时文件时，
//   第二次采集会把第一次覆盖掉 ⇒ 永远没有"改动前"。所以：
//     tmp/metrics/<batchId>/<codeId>/snapshot.json   每次采集一个**新目录**（同目录已存在也不覆盖，见 metrics-report）
//     tmp/metrics/latest.json                        指针：指向最新一次（含 ref/batchId/code，供工具定位）
//   命名给两段：**批次**（batchId，回答"哪个窗口"）与**代码版本**（codeId=git sha 或 nogit，回答"哪一版代码"）。
//   为什么两段都要：同一窗口下改代码会产出两份快照（这正是"前后对比"的来源）；同一份代码换窗口也一样。
// 为什么用 tmp/ 而不是新目录：`.gitignore` 的 `tmp/` 已经在那，门禁写盘不许把工作区搞脏
//   （release.mjs 第 1 步就查工作区干净 —— 见 test/golden-gate.test.mjs 的同款断言）。落盘是**本机产物**，
//   不进 git；要长期留档就随报告一起导出（`--out` 到仓库外）。

/** 代码版本锚（㉒㉓ 代理接口点②）：快照必须能回答"这份读数属于哪一版代码" */
export function normalizeCodeId(code) {
  const c = (code && typeof code === 'object') ? code : {};
  const commit = typeof c.commit === 'string' && c.commit ? c.commit : null;
  return commit ? commit.slice(0, 12) : 'nogit';
}

/** 本次快照的可寻址引用（提案 `basis` 该引这个，而不是引一段读数文本） */
export function snapshotRef(report) {
  const r = report || {};
  const batch = r.batchId || 'unknown';
  const code = normalizeCodeId(r.code);
  const p = ['tmp', 'metrics', batch, code, 'snapshot.json'].join('/');
  return {
    path: p,
    url: 'file:///' + [String(ROOT || '').replace(/\\/g, '/'), p].join('/').replace(/\/+/g, '/'),
    batchId: batch,
    codeId: code,
    commit: (r.code && r.code.commit) || null,
    dirty: Boolean(r.code && r.code.dirty),
    at: r.at || null,
    // 跨机器/跨目录也能核对"比的是不是同一份"：与文件一起导出，比 path 更硬
    hash: null,   // 由写盘方回填（sha1_12），读盘方在 manifest 里核对
  };
}

// ── ⑦ 读盘（唯一有 I/O 的地方；全部只读）──────────────────────────────────────────────
const METRICS_DIR = () => [ROOT, 'tmp', 'metrics'];

/** 读一份报告（给门禁 CLI / release 用）。读不到返回 { __err }，**不抛** —— 调用方要如实说"读不到"。 */
export async function loadMetricsReport(file) {
  const fs = await import('node:fs');
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(txt);
    return obj;
  } catch (e) {
    return { __err: String((e && e.message) || e).slice(0, 200) };
  }
}

/** 上一次报告的位置：`<baseline>` 显式给了就用它，否则用 tmp/metrics/latest.json 指向的那份 */
export async function resolveBaselinePath({ explicit = null } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  if (explicit) return { path: path.resolve(explicit), source: 'explicit' };
  const ptr = path.join(...METRICS_DIR(), 'latest.json');
  try {
    const j = JSON.parse(fs.readFileSync(ptr, 'utf8'));
    if (j && j.path) return { path: path.resolve(ROOT, j.path), source: 'latest.json' };
    if (j && j.dir) return { path: path.resolve(ROOT, j.dir, 'snapshot.json'), source: 'latest.json(dir)' };
  } catch { /* 没有指针文件就是"没有基线"，如实返回 */ }
  return { path: null, source: 'none' };
}

/** 把一份"采集快照"（collect.js 的产物 + golden 档）补成**指标报告**（㉒㉓ 代理点①②⑤） */
export function buildMetricsReport(snapshot) {
  const s = snapshot || {};
  const withRef = { ...s };
  // `at`（报告头的时间戳，形状照 golden-report.mjs）：快照侧叫 `generatedAt`，这里对齐成同一个名字，
  // 免得每处读报告的人各自猜"哪个是这次采集的时间"。
  withRef.at = s.at || (s.generatedAt ? String(s.generatedAt).replace(/\.\d{3}Z$/, 'Z') : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const ref = snapshotRef(withRef);
  return {
    ...withRef,
    ref,
    kind: 'rw-metrics-report',
    schema: s.schema ?? SNAPSHOT_SCHEMA,
  };
}

/** 报告自检：**格式/版本/身份三件必须齐全**，否则门禁宁可报"读不懂"也不猜 */
export function checkMetricsReport(report) {
  const problems = [];
  if (!report || typeof report !== 'object') return ['不是 JSON 对象'];
  if (report.kind && report.kind !== 'rw-metrics-report') problems.push('kind=' + report.kind + '（期望 rw-metrics-report）');
  if (!report.metrics) problems.push('缺 metrics 档');
  if (!report.at) problems.push('缺 at（时间戳）');
  if (!report.batchId) problems.push('缺 batchId（窗口批次）');
  return problems;
}
