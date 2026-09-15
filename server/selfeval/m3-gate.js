// server/selfeval/m3-gate.js —— v0.3 §0.4 **M3 出口标准**的判据载体（纯函数；夹具直测）
//
// ── 为什么要有它（本轮补的那一个缺口）────────────────────────────────────────────────────
//   §0.4 M3 出口原文：「连续**两个周期**产出并落地提案，其中 ≥1 条来自外部对标、≥1 条来自自我体检；
//                     每条附**前后指标对比**；**全程无自我放行**。」
//   ㉔ 的 `regression-gate.js` 判的是**单批**："这批提案有没有对比对象、准入前置在不在位"。
//   它判不了 M3 出口，因为出口标准是**跨周期**的：它要数"已完成的周期数"、要数"已落地的提案"
//   并区分来源、要每条落地提案都指得到对比对象、要落地痕迹里有人工审批。这四样此前**没有任何载体**。
//
// ── 一条也不新造的口径（逐条指回既有实现）────────────────────────────────────────────────
//   · 来源词表（自我体检 / 外部对标 / 业务反馈）：`./propose.js` 的 `SOURCE_CN` —— **引用不复制**。
//   · 落地判据（`extension_demands.status='采纳'` / `evo_goals.status='active'`）：`server/db.js` 的列注释
//     与 `server/index.js:2642` 的状态枚举（待审|采纳|驳回|升级）；`server/scheduler.js:108` 按
//     `g.status="active"` 取进化目标 ⇒ 那就是这两张表各自的"活着"口径。
//   · 人工审批痕迹（`audit_log` 的 `ext:demand_status` / `evo:goal_create`）：`server/index.js:2645` 与
//     `server/index.js:2009` 的既有落账动作名。**不新造动作名、不新造列**。
//   · 报告身份/可比性（`ref.path` / `baselineRef` / 窗口三要素）：`./regression-gate.js` 的
//     `compareWindows` 与 `snapshotRef` —— **直接调**，不另写一套窗口判据。
//
// ── 铁律：数据不足 ⇒ `undecided`，**绝不许判成 pass**（本轮的核心防线）──────────────────────
//   三态出口只有 `pass` / `fail` / `undecided` 三个字面量（`M3_VERDICT`）。合成规则是一条**单向**规则：
//     任一 required 判 `fail`          ⇒ 总判 `fail`
//     没有 fail、但有 required 未判    ⇒ 总判 `undecided`
//     全部 required 都 pass            ⇒ 总判 `pass`
//   "没有数据"走的正是第二条：它**进不了** pass 分支，因为 required 判据只有拿到对象才可能返回 pass。
//   真库现状（2026-09-16 只读实测：evo_goals / evo_goal_tasks / extension_demands 各 0 行）⇒ 本模块
//   在真库上**必然**返回 `undecided`。这是如实结论，不是缺陷：M3 还没走完两个周期。
//
// ── 输入：台账（`ledger`）的形状 ─────────────────────────────────────────────────────────
//   {
//     cycles: [ { id, label?, completedAt|null, landedIds?[] } ],
//     landed: [ { id, source, table, status, ref, baselineRef } ],
//     snaps:  [ 指标报告，形状＝ scripts/metrics-report.mjs 的 composeReport 产物 ]
//   }
//   台账是**不可变的历史记录**（进仓库、随 `proposals/` 一起留档）；本模块不写台账，只读它。
//   为什么"完成的周期"要显式 `completedAt`（或由落地记录兜底推算）：周期是否走完是**事实记录**，
//   不是本模块能从读数里推测出来的东西（推测出来的"周期数"就是自我表演）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { SOURCE_CN } from './propose.js';
import { compareWindows } from './regression-gate.js';

/** 三态出口：**只有这三个字面量**（与 `regression-gate.js` 的 `GATE_VERDICT` 同名同值，但不是同一个常量，
 *  因为这里判的是 M3 出口、那边判的是单批门禁；两处结论各自独立，不许互相顶替）。 */
export const M3_VERDICT = Object.freeze({ PASS: 'pass', FAIL: 'fail', UNDECIDED: 'undecided' });
/** 中文说法（人读；报表与登记里都用这三句，避免各处自造措辞） */
export const M3_VERDICT_CN = Object.freeze({ pass: '通过', fail: '不通过', undecided: '未判（数据不足）' });
/** 判定项的名字（单一出处：check 的 code、结论文本、夹具断言都引这里） */
export const M3_CHECK = Object.freeze({
  CYCLES: 'm3.cycles',
  LANDED: 'm3.landed',
  COMPARISON: 'm3.comparison',
  APPROVAL: 'm3.approval',
});
/** §0.4 M3 出口明确点名的两个来源（"≥1 条来自外部对标、≥1 条来自自我体检"）—— 键取 `SOURCE_CN` 的键 */
export const M3_REQUIRED_SOURCES = Object.freeze(['benchmark', 'selfeval']);
/** "连续两个周期"里的那个 2。**这是文档原文给的数量，不是我发明的阈值**（见文件头引用）。 */
export const M3_MIN_CYCLES = 2;

// ── 小工具（纯函数） ─────────────────────────────────────────────────────────────────────
const s = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);

/** 台账里 `source` 的**唯一**合法取值＝`SOURCE_CN` 的键（自我体检/外部对标/业务反馈），不做大小写宽容 */
export const M3_SOURCE_KEYS = Object.freeze(Object.keys(SOURCE_CN));
const sourceCn = (src) => SOURCE_CN[src] || null;
const isKnownSource = (src) => Object.prototype.hasOwnProperty.call(SOURCE_CN, src);

/** 一条提案的落地判据（见文件头"落地判据"）：两张载体表各自的"活着"状态，缺一不可 */
const LANDED_STATE = Object.freeze({
  extension_demands: '采纳',   // server/index.js:2642 的状态枚举
  evo_goals: 'active',        // server/db.js 列注释 + server/scheduler.js:108
});
/** 人工审批痕迹的落账动作名（既有动作名，不新造）：需求审批台 / 进化目标建立 */
export const M3_APPROVAL_ACTIONS = Object.freeze(['ext:demand_status', 'evo:goal_create']);

const check = (code, verdict, text, extra = {}) => ({ code, verdict, text, ...extra });

// ── ① 周期数 ─────────────────────────────────────────────────────────────────────────────
/**
 * 数"已完成的周期"。
 * **完成**的判据（任一）：① 显式给了 `completedAt`；② 该周期下已有落地的提案（落地即走完）。
 * 都不满足 ⇒ 进行中（**不计入**"连续两个周期产出并落地提案"的那个数）。
 *
 * 为什么"有提案记录"不算完成：出口标准要的是"产出**并落地**"。只产出入闸、没人批的周期是
 * **进行中**，把它算成完成就是把"没落地"读成"落地了"——那正是 §0.4 风险①"自我表演"。
 */
export function cycleStats(ledger) {
  const cycles = arr(ledger && ledger.cycles);
  const raw = arr(ledger && ledger.landed);
  const landedIds = new Set();
  for (const r of raw) {
    const id = r && r.id;
    if (id != null) landedIds.add(String(id));
  }
  const completed = [], inProgress = [];
  for (const c of cycles) {
    if (!c || c.id == null) continue;
    const declared = s(c.completedAt);
    const bound = arr(c.landedIds).map(String);
    const hasLanded = bound.length > 0 || (landedIds.size > 0 && bound.some((x) => landedIds.has(x)));
    const isDone = Boolean(declared) || hasLanded;
    // 周期"什么时候走完"：优先人写的 completedAt；否则退到该周期最后一条落地记录的时间
    // （**只在有落地记录时**兜底；两者都没有就是没有，不给一个猜的时间）
    let closedAt = declared || null;
    if (!closedAt && hasLanded) {
      const ts = raw.filter((r) => r && bound.includes(String(r.id))).map((r) => s(r.landedAt)).filter(Boolean);
      if (ts.length) closedAt = ts.sort().at(-1);
    }
    const row = { id: c.id, label: s(c.label) || null, completedAt: closedAt, landedCount: bound.length };
    (isDone ? completed : inProgress).push(row);
  }
  return {
    total: cycles.length,
    completed,
    inProgress,
    completedCount: completed.length,
    // 台账本身残缺（有周期行，却一条 id 都没有）：如实标出来，别让它静默变成"0 个周期"
    malformed: cycles.length > 0 && completed.length === 0 && inProgress.length === 0,
  };
}

/** 周期数 ≥ `M3_MIN_CYCLES`（§0.4 原文"连续两个周期"） */
export function checkCycles(ledger) {
  const st = cycleStats(ledger);
  if (st.malformed) {
    return check(M3_CHECK.CYCLES, M3_VERDICT.UNDECIDED,
      `台账里有 ${st.total} 行周期，但没有一行带 id ⇒ 读不懂，未判（不许把残缺台账读成"0 个周期"）`, { stats: st });
  }
  if (!st.total) {
    return check(M3_CHECK.CYCLES, M3_VERDICT.UNDECIDED,
      '台账里没有任何周期记录（真库现状：提案链还没真跑过）⇒ 未判，**不是通过**', { stats: st });
  }
  if (st.completedCount < M3_MIN_CYCLES) {
    return check(M3_CHECK.CYCLES, M3_VERDICT.UNDECIDED,
      `已完成的周期 ${st.completedCount} 个 < ${M3_MIN_CYCLES}（§0.4 M3 出口："连续两个周期"）；`
      + `进行中 ${st.inProgress.length} 个 ⇒ 未判，**不是通过**`, { stats: st });
  }
  return check(M3_CHECK.CYCLES, M3_VERDICT.PASS,
    `已完成的周期 ${st.completedCount} 个 ≥ ${M3_MIN_CYCLES}（§0.4 M3 出口："连续两个周期"）`, { stats: st });
}

// ── ② 已落地的提案 + 来源 ────────────────────────────────────────────────────────────────
/**
 * 逐条判"这条落地记录站不站得住"：载体表合法、状态是该表的"活着"值、来源在词表里、带可寻址标签。
 * 任何一条**不**站得住 ⇒ 整个 landed 判 `fail`（不是 undecided）——因为台账里已经有东西了，
 * 只是它不合格：这与"台账是空的"是两回事，处置也不同（一个是补记录，一个是补数据）。
 */
export function landedStats(ledger) {
  const rows = arr(ledger && ledger.landed);
  const ok = [], bad = [];
  const bySource = { selfeval: [], benchmark: [], feedback: [] };
  const unknownSource = [];
  for (const r of rows) {
    const id = r && r.id;
    const reasons = [];
    if (id == null || id === '') reasons.push('缺 id');
    const table = s(r && r.table);
    if (!Object.prototype.hasOwnProperty.call(LANDED_STATE, table)) reasons.push(`载体表「${table || '（缺）'}」不在允许的两张表里`);
    else if (s(r && r.status) !== LANDED_STATE[table]) {
      reasons.push(`状态「${s(r && r.status) || '（缺）'}」不是 ${table} 的落地值「${LANDED_STATE[table]}」`);
    }
    const src = s(r && r.source);
    if (!isKnownSource(src)) {
      reasons.push(`来源「${src || '（缺）'}」不在词表里（只认 ${M3_SOURCE_KEYS.join(' / ')}，词表出自 propose.js 的 SOURCE_CN）`);
      unknownSource.push({ id: id ?? null, source: src || null });
    }
    const anchor = s(r && r.ref) || s(r && r.fingerprint);
    if (!anchor) reasons.push('缺可寻址标签（ref 或 fingerprint）——落地记录必须能对回提案本身');
    const row = { id: id ?? null, source: src || null, sourceCn: sourceCn(src), table, status: s(r && r.status), ref: s(r && r.ref) || null };
    if (reasons.length) bad.push({ ...row, reasons });
    else { ok.push(row); bySource[src].push(row); }
  }
  return {
    total: rows.length, ok, bad, bySource, unknownSource,
    bySourceCount: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
  };
}

/** ≥1 来自外部对标、≥1 来自自我体检（§0.4 原文点名的那两条）；业务反馈可有可无 */
export function checkLanded(ledger) {
  const st = landedStats(ledger);
  if (!st.total) {
    return check(M3_CHECK.LANDED, M3_VERDICT.UNDECIDED,
      '台账里没有任何落地记录（真库现状：extension_demands / evo_goals 各 0 行）⇒ 未判，**不是通过**', { stats: st });
  }
  if (st.bad.length) {
    return check(M3_CHECK.LANDED, M3_VERDICT.FAIL,
      `${st.bad.length} 条落地记录不合格：` + st.bad.map((b) => `${b.id ?? '?'}（${b.reasons.join('；')}）`).join('；'), { stats: st });
  }
  const missing = M3_REQUIRED_SOURCES.filter((k) => !st.bySource[k].length).map((k) => SOURCE_CN[k]);
  if (missing.length) {
    return check(M3_CHECK.LANDED, M3_VERDICT.FAIL,
      `已落地 ${st.total} 条，但缺 §0.4 点名的来源：${missing.join('、')}`
      + `（现有：${Object.entries(st.bySourceCount).filter(([, n]) => n).map(([k, n]) => `${SOURCE_CN[k]} ${n}`).join(' / ') || '无'}）`, { stats: st });
  }
  return check(M3_CHECK.LANDED, M3_VERDICT.PASS,
    `已落地 ${st.total} 条，来源齐备（${Object.entries(st.bySourceCount).filter(([, n]) => n).map(([k, n]) => `${SOURCE_CN[k]} ${n}`).join(' / ')}）`
    + `—— 满足"≥1 条来自外部对标、≥1 条来自自我体检"`, { stats: st });
}

// ── ③ 前后指标对比（**复用** regression-gate 的口径与引用约定）─────────────────────────────
/** 绝对路径 → 仓库相对（快照进仓库之后，`ref.path` 用 `/` 分隔的相对路径，与 `snapshotRef` 同款） */
export function relPath(p, root = ROOT) {
  const a = s(p);
  if (!a) return null;
  const rel = path.isAbsolute(a) ? path.relative(root, a) : a;
  return rel.split(path.sep).join('/');
}

/** 读一份指标报告（读不到返回 `{ __err }`，**不抛**）——与 `regression-gate.loadMetricsReport` 同款语义，
 *  区别只是错误里带上尝试过的路径（台账读不到时要能一眼看出找的是哪个文件）。 */
export function loadSnap(p, root = ROOT) {
  const a = s(p);
  if (!a) return { __err: '（没有给路径）' };
  const abs = path.isAbsolute(a) ? a : path.join(root, a);
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); }
  catch (e) { return { __err: `${String((e && e.message) || e).slice(0, 160)}（找的是 ${relPath(abs, root)}）` }; }
}

/**
 * 逐条落地记录查对比对象。**引用口径整个复用既有约定**（`ref.path` 与 `baselineRef`，见
 * `regression-gate.snapshotRef`）：`current` 取落地记录自己写的那一份快照（它承载"改动后"的读数），
 * `baseline` 取它 `baselineRef` 指向的那一份（"改动前"）。两处都读不到就如实说读不到。
 * @returns {Array<{id, source, currentRef, baselineRef, hasBaseline, comparable, windowDiffs, current, baseline, error}>}
 */
export function comparisonRows(ledger, { root = ROOT } = {}) {
  const byRef = new Map();
  for (const snap of arr(ledger && ledger.snaps)) {
    const p = relPath(((snap || {}).ref || {}).path, root);
    if (p) byRef.set(p, snap);
  }
  return arr(ledger && ledger.landed).map((r) => {
    const cur = relPath(r && r.ref, root);
    const base = relPath(r && r.baselineRef, root);
    const row = {
      id: (r && r.id) ?? null, source: s(r && r.source) || null, sourceCn: sourceCn(s(r && r.source)),
      currentRef: cur, baselineRef: base,
      hasBaseline: Boolean(base), comparable: null, windowDiffs: [], current: null, baseline: null, error: null,
    };
    if (!cur) return { ...row, error: '这条落地记录没写 ref（指不到"改动后"那份快照）' };
    if (!base) return { ...row, error: '这条落地记录没写 baselineRef（指不到"改动前"那份快照）' };
    // 快照正文先在手边找（台账自带的 `snaps`），找不到再按路径读盘 —— 读盘的是**同一份报告文件**
    const curDoc = byRef.get(cur) || loadSnap(cur, root);
    const baseDoc = byRef.get(base) || loadSnap(base, root);
    row.current = curDoc; row.baseline = baseDoc;
    const miss = [];
    if (curDoc && curDoc.__err) miss.push(`"改动后"快照读不到：${curDoc.__err}`);
    if (baseDoc && baseDoc.__err) miss.push(`"改动前"快照读不到：${baseDoc.__err}`);
    if (miss.length) return { ...row, current: null, baseline: null, error: miss.join('；') };
    // 窗口可比性：**直接调既有实现**（`compareWindows` 的三要素：天数 / 截止时间 / 时间单位，+ schema）
    const w = compareWindows(baseDoc, curDoc);
    return { ...row, comparable: w.comparable, windowDiffs: w.diffs };
  });
}

/** 每条落地记录都要指得到对比对象，且那一对窗口可比（不可比 ⇒ 未判，拒绝直接对比） */
export function checkComparison(ledger, { root = ROOT } = {}) {
  const rows = comparisonRows(ledger, { root });
  if (!rows.length) {
    return check(M3_CHECK.COMPARISON, M3_VERDICT.UNDECIDED,
      '没有落地记录 ⇒ 没有需要附前后对比的对象（§0.4："每条附前后指标对比"）。未判，**不是通过**', { rows });
  }
  const broken = rows.filter((r) => r.error);
  if (broken.length) {
    return check(M3_CHECK.COMPARISON, M3_VERDICT.FAIL,
      `${broken.length} 条落地提案缺前后指标对比：` + broken.map((b) => `${b.id ?? '?'}（${b.error}）`).join('；'), { rows });
  }
  const bad = rows.filter((r) => r.comparable !== true);
  if (bad.length) {
    return check(M3_CHECK.COMPARISON, M3_VERDICT.UNDECIDED,
      `${bad.length} 条落地提案的两次快照**窗口不可比**，拒绝直接对比（口径＝regression-gate.compareWindows）：`
      + bad.map((b) => `${b.id ?? '?'}（${(b.windowDiffs || []).join('；') || '原因未记录'}）`).join('；'), { rows });
  }
  return check(M3_CHECK.COMPARISON, M3_VERDICT.PASS,
    `${rows.length} 条落地提案均指到对比对象，且两次窗口可比（${rows.map((r) => r.id ?? '?').join('、')}）`, { rows });
}

// ── ④ 无自我放行（人工审批痕迹）──────────────────────────────────────────────────────────
/**
 * 落地记录里必须有**人工审批**的痕迹（§0.4 风险②）。
 * 痕迹来自**既有**审批动作名（`M3_APPROVAL_ACTIONS`），落在既有的 `audit_log` 上：
 *   `extension_demands` 的审批台 → `ext:demand_status`（`server/index.js:2645`）；
 *   `evo_goals` 由人建立（引擎只产提案）→ `evo:goal_create`（`server/index.js:2009`）。
 * 两者**都由人发起**；提案落库那条路（`write.js`）只写 '待审' 与默认 'active'，不落这两个动作，
 * 所以"有痕迹"与"自我放行"是可区分的（这是本判据能立住的全部依据）。
 */
export function approvalStats(ledger) {
  const ev = arr(ledger && ledger.approvals);
  const rows = arr(ledger && ledger.landed);
  const byAction = {};
  for (const e of ev) {
    const a = s(e && e.action);
    if (a) byAction[a] = (byAction[a] || 0) + 1;
  }
  const known = ev.filter((e) => M3_APPROVAL_ACTIONS.includes(s(e && e.action)));
  // 按载体表 + 记录 id 归位：一条落地记录只有在**它自己那张表**上有人工痕迹才算数
  const covered = [], uncovered = [];
  for (const r of rows) {
    const id = r && r.id;
    const table = s(r && r.table);
    const hit = known.find((e) => s(e.targetTable) === table && String(e.targetId ?? '') === String(id ?? '\u0000'));
    if (hit) covered.push({ id: id ?? null, table, by: hit.accountId ?? null, action: s(hit.action), at: s(hit.at) || null });
    else uncovered.push({ id: id ?? null, table, status: s(r && r.status) });
  }
  const untargeted = known.filter((e) => !s(e.targetTable));
  return { total: ev.length, byAction, known, untargeted, covered, uncovered };
}

/** 每条落地记录都要有人工审批痕迹；一条都没有 ⇒ 未判（"没数据"不许当通过） */
export function checkApproval(ledger) {
  const st = approvalStats(ledger);
  const rows = arr(ledger && ledger.landed);
  if (!rows.length) {
    return check(M3_CHECK.APPROVAL, M3_VERDICT.UNDECIDED,
      '没有落地记录 ⇒ 没有需要核审批痕迹的对象（§0.4："全程无自我放行"）。未判，**不是通过**', { stats: st });
  }
  if (st.uncovered.length) {
    return check(M3_CHECK.APPROVAL, M3_VERDICT.FAIL,
      `${st.uncovered.length} 条落地记录**查不到人工审批痕迹**（这正是"自我放行"，v0.3 §0.4 风险②）：`
      + st.uncovered.map((u) => `${u.id ?? '?'}（${u.table || '载体缺'}，状态 ${u.status || '缺'}）`).join('；')
      + `。痕迹只认既有动作 ${M3_APPROVAL_ACTIONS.join(' / ')} 落在 audit_log 上的行`, { stats: st });
  }
  return check(M3_CHECK.APPROVAL, M3_VERDICT.PASS,
    `${st.covered.length} 条落地记录均带人工审批痕迹（${M3_APPROVAL_ACTIONS.join(' / ')}）`, { stats: st });
}

// ── ⑤ 合成（三态；数据不足一律 undecided）────────────────────────────────────────────────
/**
 * M3 出口判定（纯函数；夹具直测）。四条 required 判据的合成规则见文件头"铁律"。
 * @param {{ledger?:object}} input
 * @returns {{verdict:'pass'|'fail'|'undecided', checks:object, reasons:Array, line:string}}
 */
export function evaluateM3Exit({ ledger = null } = {}) {
  const checks = {
    cycles: checkCycles(ledger),
    landed: checkLanded(ledger),
    comparison: checkComparison(ledger),
    approval: checkApproval(ledger),
  };
  const all = Object.values(checks);
  const failed = all.filter((c) => c.verdict === M3_VERDICT.FAIL);
  const undecided = all.filter((c) => c.verdict === M3_VERDICT.UNDECIDED);
  let verdict;
  if (failed.length) verdict = M3_VERDICT.FAIL;
  else if (undecided.length) verdict = M3_VERDICT.UNDECIDED;
  else verdict = M3_VERDICT.PASS;
  const reasons = all.map((c) => c.text);
  return { verdict, checks, reasons, line: m3Line({ verdict, checks, reasons }) };
}

/** 只放行显式 pass —— `undecided` / `fail` 一律 true（**禁止把"未判"读成"通过"**） */
export function m3Blocks(result) {
  return !(result && result.verdict === M3_VERDICT.PASS);
}

/** 结论一行（人读）：`未判（数据不足） · …`；逐条判据的中文三态也一并给出来 */
export function m3Line(result) {
  const checks = (result && result.checks) || {};
  const order = [M3_CHECK.CYCLES, M3_CHECK.LANDED, M3_CHECK.COMPARISON, M3_CHECK.APPROVAL];
  const names = { [M3_CHECK.CYCLES]: '周期数', [M3_CHECK.LANDED]: '落地来源', [M3_CHECK.COMPARISON]: '前后对比', [M3_CHECK.APPROVAL]: '无自我放行' };
  const parts = order.filter((k) => checks[k]).map((k) => `${names[k]}＝${M3_VERDICT_CN[checks[k].verdict]}`);
  const head = 'M3 出口：' + M3_VERDICT_CN[(result && result.verdict) || M3_VERDICT.UNDECIDED];
  const why = Object.values(checks).filter((c) => c.verdict !== M3_VERDICT.PASS).map((c) => c.text);
  return [head + ' · ' + parts.join(' · '), ...why].join('\n  ');
}
