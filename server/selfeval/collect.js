// server/selfeval/collect.js —— 自进化①「自我体检」的**采集**那一半（v0.3 §7.1 ㉒、§0.4 M3 三源之二）
//
// ── 为什么要有它（先问 DSH 怎么做，再定我们这一半）────────────────────────────────────────
// DSH 的对应物是「会话投影 + 遥测」：`dsh-session-telemetry` / `-otel` / `dsh-session-stats`
// 把运行态读数折进**结构化投影**，读数与展示分离。**DSH 没有自进化提案链**，提案与审批走人。
// ⇒ 我们照它学的那一半＝**把散在脚本里的读数收成一个结构化快照对象**；提案与审批那一半
//   （`propose.js` / `priority.js`）按 v0.3 §0.4 自己定：**只产出提案，改自己代码仍需人工审批**。
//
// ── 现状（为什么要新写一个而不是改脚本）──────────────────────────────────────────────────
// C1–C5 的读数此前只活在 `scripts/{baseline-cost,kpi,failure-report,ra35-report}.mjs` 的
// **控制台文本**里（见《v0.3-符合性核对-20260916》§1.4 ㉒：「自我体检无采集入口、无读数→提案接线」）。
// 文本没法当提案的依据，也没法做前后对比 ⇒ 本模块是**唯一**的成型出口，脚本保持不动。
//
// ── 口径三条（一条都不新造）──────────────────────────────────────────────────────────────
//   ① **口径复用**：真实/探针/孤儿的分档直接用 `server/cohort.js`（§0.3.1 的定稿判据，单一出处）；
//      失败率用 `failure-report.mjs` 的口径（`status='fail' AND conversation_id > 0`，排除夹具哨兵会话）。
//   ② **只报数不设线**：C2/C3/C4/C5 一律给数不给阈值。脚本里的 RA-35 判定线（99%/1k/5k）属于
//      别处已有的口径，本模块**不复制**它们，也不对读数下"达标/未达标"的结论。
//   ③ **查库与成型分开**：`collect*` 只负责读库，`buildSnapshot` 是**纯函数**（假库/夹具直测），
//      CLI 把两者串起来。这条与 `server/eventlog.js` 的 `eventRow` / `dbc` 缝同款做法。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.js';
import { db } from '../db.js';
import { storage } from '../storage/index.js';   // 2026-09-18：读法逐步迁到存储接口（见 collectFailures）
import {
  REAL_WHERE, HUMAN_WHERE, SCHEDULED_WHERE, PROBE_WHERE, ORPHAN_WHERE,
} from '../cohort.js';
import { loadGoldenItems } from '../canary.js';   // 金标条目**从随包的那一份读**（身份口径不许另立一套）

/** 快照结构版本：字段变了就 +1（下游据此判"这份快照能不能比"）。 */
export const SNAPSHOT_SCHEMA = 1;
/** 默认窗口：7 天（与 `kpi.mjs` / `failure-report.mjs` 的默认天数一致，不另立口径）。 */
export const DEFAULT_DAYS = 7;

/** 自检闸门：`failures.total===0` 时不算 0%，而是"没有调用"（否则会得出"失败率 0%，很好"的假结论）。 */
export const METRIC_STATUS = Object.freeze({ OK: 'ok', NO_DENOMINATOR: 'no-denominator', NO_DATA: 'no-data' });

// ── 小工具（纯函数）──────────────────────────────────────────────────────────────────────
const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 比例：**分母为 0 一律 null**，不返回 0 —— 0 会被读成"命中率 0%"，与"没有数据"是两回事。 */
export function ratio(num, den) {
  const n = int(num), d = int(den);
  if (d <= 0) return null;
  return n / d;
}

/**
 * 一组数值 → {n, min, median, p95, max}（空数组返回全 null）。
 * 这里不用 SQL 的窗口函数：夹具要能直测成型，而 `baseline-cost.mjs` 的窗口函数口径
 * 依赖 MySQL 版本；纯函数算出来的同一批数在哪都一样。
 * P95 用**最近秩**（nearest-rank）：`ceil(0.95*n)-1` 号位（0 基）——n=40 时落在 0 基 index 37
 * （末 2 个离群值会被 0.95 挡在秩外，这是最近秩的正常行为，不是 bug）。
 * 与 `ra35-report.mjs` 的 `FLOOR(c*0.95)`（1 基第 38 个 → 0 基 index 37）**同秩**。
 */
export function numericStats(values) {
  const arr = (Array.isArray(values) ? values : []).map(Number).filter((x) => Number.isFinite(x));
  if (!arr.length) return { n: 0, min: null, median: null, p95: null, max: null };
  const s = [...arr].sort((a, b) => a - b);
  const nearestRank = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, min: s[0], median: mid, p95: nearestRank(0.95), max: s[s.length - 1] };
}

/** C5 归因分桶：把 `prefix:exempt` 的 detail 首词映射成大类（**只分组，不判好坏**） */
export function attributableBucket(detailWord) {
  const w = String(detailWord || '').trim().toLowerCase();
  if (!w) return 'unknown';
  if (w.includes('first-round')) return 'first-round';
  if (w.includes('tool-face')) return 'tool-face-changed';
  if (w.includes('model')) return 'model-switched';
  if (w.includes('collapse')) return 'collapse';
  return 'unknown';
}

const bjDate = (d) => {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().slice(0, 10);
};

/** 批次 id：库里用的是**本地时间**（`server/cohort.js` 实测 @@session.time_zone=UTC+8），
 *  所以批次日也按 UTC+8 算 —— 否则凌晨 8 点前的采集会和前一天分成两批。 */
export function batchIdOf(at, days = DEFAULT_DAYS) {
  return `selfeval-${bjDate(at)}-${days}d`;
}

/** 内容指纹：幂等判据（同批次重复跑不产生重复提案）。为了能在库表里按前缀查，用短哈希。 */
export function fingerprint(...parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p == null ? '' : p)).join('\u0000'), 'utf8').digest('hex').slice(0, 16);
}
/** 落进库文本里的指纹标记（`extension_demands.content` / `evo_goals.descr` 都靠它去重）。 */
export function fprintTag(fp) { return `fprint:${fp}`; }

// ── ① 外部对标源指纹（**不是抓取器**）──────────────────────────────────────────────────────
// 诚实登记：本仓**没有**自动读 DS/CD 变化的机制，本轮也**不硬造**一个抓取器（那会造出"未经验证的
// 外部事实"，正是 v0.3 §0.4 风险①"自我表演"的燃料）。这里只做一件有据可查的事：
// 把**人工/文档输入**这半自动源的文件身份记进快照（路径 + 大小 + mtime + 内容哈希），
// 让"这一批提案依据的是哪一版文档"可追溯、可对账。
export const BENCHMARK_SOURCES = [
  { id: 'cli-borrow-list', path: 'docs/Codex与主流CLI-机制借鉴清单-v1.md', kind: 'list', note: '自述"不再维护"的历史借鉴清单（⬜ 项＝未做）' },
  { id: 'dsh-cache-report', path: 'docs/dsh-cache-hit-99.8-report.md', kind: 'report', note: 'DSH 缓存机制源码考证（§5 是"可移植做法"清单）' },
];

export function sourceFingerprint(relPath, root = ROOT) {
  const abs = path.join(root, relPath);
  try {
    const st = fs.statSync(abs);
    const buf = fs.readFileSync(abs);
    return {
      path: relPath, exists: true, bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      sha1_12: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12),
    };
  } catch (e) {
    // 读不到就如实说读不到（快照里留 exists:false）——不许把"文件缺失"省略成"没有对标项"
    return { path: relPath, exists: false, bytes: null, mtime: null, sha1_12: null, error: String(e.message || e) };
  }
}

// ── ② 查库（每个读数一个函数，全部只读）──────────────────────────────────────────────────
const sel = async (dbc, sql, params) => {
  try { return await dbc.query(sql, params); } catch (e) { return [{ __err: String(e.message || e) }]; }
};
const failed = (rows) => Array.isArray(rows) && rows.length === 1 && rows[0] && rows[0].__err ? rows[0].__err : null;

// 走**存储接口**的读法包装（2026-09-18）：接口方法出错时**抛**，而本模块的报错口径只有一种
// （`[{__err}]` ＋ `failed()`），所以在这里适配一次 —— 报错形状与直连 SQL 那条路**完全一致**，
// 上层的 `errors` 汇总、`looksLikeConnectionError` 的判定一个字都不用改。
const viaInterface = async (p) => {
  try { return await p; } catch (e) { return [{ __err: String(e.message || e) }]; }
};

/**
 * 采集错误里哪些是**连不上库**（㉔ 指标回归门禁必须分清"窗口里真没数据"与"库根本读不到"：
 * 前者是正常读数，后者是**盲改**）。判据取既有驱动/池子的报错原文，不新造错误码。
 */
const CONN_ERROR = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|EAI_AGAIN|PROTOCOL_CONNECTION_LOST|Access denied|Unknown database|Pool is closed|Connection lost/i;
export function looksLikeConnectionError(text) {
  return CONN_ERROR.test(String(text == null ? '' : text));
}


/** usage_stats 一档（真实/人发起/定时/探针/孤儿）× 一个时间窗的 C1/C2/C3 原始行 */
export async function collectUsage({ dbc = db, days = DEFAULT_DAYS, cutoff = null } = {}) {
  const d = Math.max(1, Math.floor(Number(days) || DEFAULT_DAYS));
  const out = { days: d, cutoff, cohorts: {}, errors: {} };
  const COHORTS = [
    ['real', REAL_WHERE], ['human', HUMAN_WHERE], ['scheduled', SCHEDULED_WHERE],
    ['probe', PROBE_WHERE], ['orphan', ORPHAN_WHERE],
  ];
  for (const [key, mk] of COHORTS) {
    const where = mk('u');
    // ① 基础计数与累计（真库本地时间；时间窗用参数化的 INTERVAL ? DAY，不用字符串拼时间）
    const base = await sel(dbc,
      `SELECT COUNT(*) rounds, COUNT(DISTINCT u.conversation_id) convs,
              COALESCE(SUM(u.cache_hit_tokens),0) hit, COALESCE(SUM(u.cache_miss_tokens),0) miss,
              COALESCE(ROUND(SUM(u.cost),6),0) cost
         FROM usage_stats u
        WHERE u.kind='round' AND ${where} AND u.created_at > NOW() - INTERVAL ? DAY`, [d]);
    if (failed(base)) { out.errors[key] = failed(base); continue; }
    // ② 逐轮 miss 全量取回（够算中位/P95；n 超过上限时如实标 truncated，**不静默截断后当全量**）
    const LIMIT = 20000;
    const rows = await sel(dbc,
      `SELECT COALESCE(u.cache_miss_tokens,0) m, COALESCE(u.cache_hit_tokens,0) h, COALESCE(u.cost,0) cost,
              u.conversation_id cid, u.agent_run_id rid
         FROM usage_stats u
        WHERE u.kind='round' AND COALESCE(u.cache_miss_tokens,0) IS NOT NULL AND ${where}
          AND u.created_at > NOW() - INTERVAL ? DAY
        ORDER BY u.id LIMIT ?`, [d, LIMIT + 1]);
    if (failed(rows)) { out.errors[key] = failed(rows); continue; }
    const truncated = rows.length > LIMIT;
    const slice = truncated ? rows.slice(0, LIMIT) : rows;
    out.cohorts[key] = { base: base[0] || {}, rounds: slice, truncated, limit: LIMIT };
  }
  // ③ 成本 top 会话（C3：成本高度集中，见 v0.3 §0.3 的"三个长会话占 93%"）
  const top = await sel(dbc,
    `SELECT u.conversation_id cid, c.title, COUNT(*) rounds, COALESCE(ROUND(SUM(u.cost),6),0) cost
       FROM usage_stats u LEFT JOIN conversations c ON c.id = u.conversation_id
      WHERE u.kind='round' AND ${REAL_WHERE('u')} AND u.created_at > NOW() - INTERVAL ? DAY
      GROUP BY u.conversation_id, c.title ORDER BY cost DESC LIMIT 10`, [d]);
  out.topConversations = failed(top) ? [] : top;
  if (failed(top)) out.errors.topConversations = failed(top);
  return out;
}

/** 失效账本（C4 `prefix:invalidate` / C5 `prefix:exempt` / `prefix:collapse`，落 `audit_log`）
 *  2026-09-18：四条读法**改走存储接口**（`audit.countByActionPrefix/recentByActions/timeRange` ＋
 *  已有的 `countByFirstToken` 加可选时间窗）——迁移前它们直连 SQL ⇒ 干净机器（jsonfile 介质）上
 *  这一档整块是空的。返回形状与迁移前**逐字一致**（`[{action,n}]`、`[{word,n}]`、
 *  `[{id,action,detail,cid,at}]`、`{at,at2}`）：快照是给人看也给 M3 判据读的。
 *  `action='prefix:exempt'` 的首词分布那条仍走 `countByFirstToken`（同一个介质方法，新增时间窗参数）。
 */
export async function collectLedger({ dbc = storage, days = DEFAULT_DAYS } = {}) {
  const d = Math.max(1, Math.floor(Number(days) || DEFAULT_DAYS));
  const counts = await viaInterface(dbc.audit.countByActionPrefix('prefix:', { days: d }));
  const exempt = await viaInterface(dbc.audit.countByFirstToken('prefix:exempt', { days: d }));
  const recent = await viaInterface(dbc.audit.recentByActions({ prefix: 'prefix:', actions: ['prefix:invalidate', 'prefix:collapse'], days: d, limit: 20 }));
  const range = await viaInterface(dbc.audit.timeRange({ prefix: 'prefix:', days: d }));
  return {
    counts: failed(counts) ? [] : counts,
    exemptWords: failed(exempt) ? [] : exempt,
    recent: failed(recent) ? [] : recent,
    range: failed(range) ? null : (Array.isArray(range) ? (range[0] || null) : (range || null)),
    errors: [failed(counts), failed(exempt), failed(recent), failed(range)].filter(Boolean),
  };
}

/** 失败率（口径＝`scripts/failure-report.mjs`：真实会话 status='fail' 按 error_code 汇总）
 *  2026-09-18：三条读法**改走存储接口**（`toolCalls.failureTotals/failByCode/failByTool`）——
 *  迁移前它们直连 SQL ⇒ 干净机器（jsonfile 介质）上"失败率"这一格整块是空的。
 *  返回形状与迁移前**逐字一致**（键名 `calls/fails/probe_calls/probe_fails`、`{code,n,tools}`、`{tool,code,n}`）：
 *  快照是给人看、也给 M3 判据读的，换介质不该改报告的形状。
 *  `dbc` 这个注入缝仍在（默认真存储），失败时如实进 `errors`（不吞、也不假装是空数据）。
 */
export async function collectFailures({ dbc = storage, days = DEFAULT_DAYS } = {}) {
  const d = Math.max(1, Math.floor(Number(days) || DEFAULT_DAYS));
  const totals = await viaInterface(dbc.toolCalls.failureTotals({ days: d }));
  const byCode = await viaInterface(dbc.toolCalls.failByCode({ days: d }));
  const byTool = await viaInterface(dbc.toolCalls.failByTool({ days: d, limit: 20 }));
  const t = failed(totals) ? null : (Array.isArray(totals) ? (totals[0] || null) : (totals || null));
  return {
    totals: t && !t.__err ? t : null,
    byCode: failed(byCode) ? [] : byCode,
    byTool: failed(byTool) ? [] : byTool,
    errors: [failed(totals), failed(byCode), failed(byTool)].filter(Boolean),
  };
}

/** 金标回归读数（v0.3 §0.4 M3 的**准入前置**之一；本模块只报数，不当门禁用——门禁是 ㉔ 的另一半）
 *  @param {{dbc?:object, checks?:Function}} opts `checks` 是**夹具缝**（默认走 `server/canary.js`
 *    的 `runGoldenChecks`）：金标实现会 import `tools/manifest.js`，并行改动可能让它暂时语法不过，
 *    夹具不该被这件事牵连成假红/假绿。
 */
export async function collectCanary({ dbc = storage, checks = null } = {}) {
  // 2026-09-18：两条读法都改走存储接口（`shells.listWithEvalRef` + `audit.lastByAction`）——
  // 迁移前直连 SQL ⇒ 干净机器（jsonfile 介质）上这一档整块是空的（"没有壳"与"读不到库"分不开）。
  // 形状与迁移前逐字一致：壳那行按中性字段 `evalRef` 取，`lastRun` 仍是 `{at, detail}`。
  const shellRows = await viaInterface(dbc.shells.listWithEvalRef());
  if (failed(shellRows)) return { available: false, error: failed(shellRows), shells: [] };
  const shells = (Array.isArray(shellRows) ? shellRows : []).map((s) => ({ id: s.id, skey: s.skey, name: s.name, eval_ref: s.evalRef ?? null }));
  let runGoldenChecks = checks;
  if (typeof runGoldenChecks !== 'function') {
    try { ({ runGoldenChecks } = await import('../canary.js')); }
    catch (e) { return { available: false, error: 'runGoldenChecks 不可用：' + String(e.message || e), shells: [] }; }
  }
  const out = [];
  for (const s of shells) {
    try {
      const r = await runGoldenChecks(s.eval_ref, { id: s.id });
      out.push({ shellId: s.id, skey: s.skey, ref: s.eval_ref, skipped: !!r.skipped, total: r.total ?? null, passed: r.passed ?? null, reason: r.reason || null });
    } catch (e) {
      // 跑不起来 ≠ 通过：如实记 error（§0.4 准入前置的判定不能把异常当绿）
      out.push({ shellId: s.id, skey: s.skey, ref: s.eval_ref, error: String(e.message || e) });
    }
  }
  // canary:run 最近一次账本行（`server/canary.js` 的调用方落 audit_log）：走既有读法 `lastByAction`
  const last = await viaInterface(dbc.audit.lastByAction('canary:run'));
  const lastRow = failed(last) ? null : (last && last.createdAt !== undefined ? { at: last.createdAt, detail: last.detail ?? null } : null);
  // 金标集身份**从逐壳读数出**（`out` 的各项带 `ref`），不是从上面的 DB 行出：
  // DB 行的字段名是 `eval_ref`，而 `goldenSetIdentities` 读的是 `s.ref` —— 传错字段会让这 65 条读数
  // 全部落进 `{ref: undefined, exists:false, count:0}`，于是同一份报告里 `metrics.canary.goldenSets`
  // 恒报"金标不存在"，而顶层 `golden`（同一批壳、同一套金标）报 `code@<sha>(9条)` —— 自相矛盾。
  // 两处形状对齐的依据在 `scripts/metrics-report.mjs`：那边也是 `shells.map(s => ({ ref: s.ref }))`。
  return { available: true, shells: out, goldenSets: goldenSetIdentities(out.map((s) => ({ ref: s.ref }))), lastRun: lastRow };
}

/**
 * 金标集的**身份**（㉔ 门禁要能回答"前后跑的是不是同一套金标"）：
 * sha1 over 条目集合的规范化 JSON（q / expectIntent / expectTool / expectExposed，按文件顺序）。
 * 为什么要身份而不是只留 total：`eval/code.json` 增删一条断言会改 total（集合变了），
 * 与"同一套金标这次没过"（行为变了）是两回事 —— 处置完全不同（见 regression-gate.js 的 diffGolden）。
 * 用 sha1 而不是 mtime/字节数：换行与格式微调不该算"金标变了"。
 */
export function goldenSetIdentities(shells) {
  return (shells || []).map((s) => {
    let items = null;
    try { items = loadGoldenItems(s.ref); } catch { items = null; }
    if (!items || !items.length) return { ref: s.ref, exists: false, count: 0, sha1_12: null };
    const canon = JSON.stringify(items.map((it) => [it.q, it.expectIntent ?? null, it.expectTool ?? null, it.expectExposed ?? null]));
    return { ref: s.ref, exists: true, count: items.length, sha1_12: crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12) };
  });
}


/** 进化集/审批台水位（㉓ 的载体；**空转**是《符合性核对》§1.4 的核心症状，必须能一眼看见） */
export async function collectPipeline({ dbc = db } = {}) {
  const one = async (sql, p = []) => {
    const r = await sel(dbc, sql, p);
    return failed(r) ? { __err: failed(r) } : (r[0] || {});
  };
  return {
    evoGoals: await one('SELECT COUNT(*) n FROM evo_goals'),
    evoGoalTasks: await one('SELECT COUNT(*) n FROM evo_goal_tasks'),
    evoMemos: await one('SELECT COUNT(*) n FROM evo_memos'),
    demandsByStatus: await sel(dbc, 'SELECT status, COUNT(*) n FROM extension_demands GROUP BY status ORDER BY n DESC'),
  };
}

// ── ③ 成型（纯函数：把上面查回来的行拼成快照对象）────────────────────────────────────────
function cohortMetric(raw) {
  if (!raw) return { status: METRIC_STATUS.NO_DATA, note: '该档未取到数据（查询失败或未采集）' };
  const b = raw.base || {};
  const rounds = int(b.rounds);
  if (!rounds) {
    return {
      status: METRIC_STATUS.NO_DATA, rounds: 0, conversations: int(b.convs),
      note: '该档在本窗口内 0 轮 —— 不是"指标为 0"，是**无数据**（v0.3 §0.3.1 第 3 条：新段真实流量不足时不可判）',
    };
  }
  const hit = int(b.hit), miss = int(b.miss);
  const missValues = (raw.rounds || []).map((r) => int(r.m));
  const costs = (raw.rounds || []).map((r) => Number(r.cost) || 0);
  const c2 = numericStats(missValues);
  const perRound = numericStats(costs);
  return {
    status: METRIC_STATUS.OK,
    rounds, conversations: int(b.convs),
    // C1：缓存读 ÷（缓存读 + 未命中）；分母 0 → null（不写成 0%）
    cacheHitTokens: hit, cacheMissTokens: miss,
    c1: ratio(hit, hit + miss),
    // C2：**只报数不设线**（脚本里的 1k/5k 判定线不在这里复制）
    c2Median: c2.median, c2P95: c2.p95, c2Max: c2.max,
    // C3：本档累计与每轮均价（v0.3 §0.3 的 C3 口径：同类任务总成本）
    cost: Number(b.cost) || 0,
    costPerRound: perRound.median,
    missSample: { n: c2.n, truncated: !!raw.truncated, limit: raw.limit ?? null },
    note: raw.truncated ? `逐轮样本已达上限 ${raw.limit}，中位/P95 是**截断后**的值（如实标注，不当全量）` : null,
  };
}

function ledgerMetric(raw) {
  if (!raw) return { status: METRIC_STATUS.NO_DATA, note: '账本未采集' };
  const byAction = {};
  for (const r of raw.counts || []) byAction[r.action] = int(r.n);
  const exemptByWord = {};
  for (const r of raw.exemptWords || []) exemptByWord[r.word || 'unknown'] = int(r.n);
  // C5 归因：把首词映射成大类（同一件事换名字不会让报表断掉）
  const attributable = {};
  for (const [w, n] of Object.entries(exemptByWord)) {
    const k = attributableBucket(w);
    attributable[k] = (attributable[k] || 0) + n;
  }
  const invalidate = byAction['prefix:invalidate'] ?? 0;
  const errors = raw.errors || [];
  return {
    status: METRIC_STATUS.OK,
    // C4：**非预期**失效次数（`prefix:invalidate` 机检口径；v0.3 §0.3 的两口径不可混用）。
    // 账本查得到而这类一行都没有 ⇒ 就是 0（真库现状），**不是** null；null 只留给"账本没取到"。
    c4Invalidate: invalidate,
    // C5：豁免失效（只报数、不设 0）
    c5Exempt: byAction['prefix:exempt'] ?? null,
    c5Collapse: byAction['prefix:collapse'] ?? null,
    // ㉔ 准入前置要判"失效监控（C4）在不在位"：**台账读到了**才算在位。
    // 读不到时 c4Invalidate 仍是 0/旧值形态，仅看数字会把"没读到"读成"没失效"——所以这里显式给一个在位数。
    available: errors.length === 0,
    ...(errors.length ? { unavailableReason: '台账没读到：' + String(errors[0]).slice(0, 160) } : {}),
    attributable, exemptByWord, byAction,
    window: { from: raw.range ? raw.range.at : null, to: raw.range ? raw.range.at2 : null },
    recent: (raw.recent || []).map((r) => ({ id: r.id, action: r.action, detail: r.detail, conversationId: r.cid, at: r.at })),
    errors,
  };
}

function failuresMetric(raw) {
  if (!raw || !raw.totals) return { status: METRIC_STATUS.NO_DATA, note: '失败账未取到（查询失败）' };
  const calls = int(raw.totals.calls), fails = int(raw.totals.fails);
  return {
    status: calls > 0 ? METRIC_STATUS.OK : METRIC_STATUS.NO_DENOMINATOR,
    calls, fails,
    // 分母 0 → null：**不许把"没有调用"报成"失败率 0%"**
    failRate: ratio(fails, calls),
    probeCalls: int(raw.totals.probe_calls),
    probeFails: int(raw.totals.probe_fails),
    byCode: (raw.byCode || []).map((r) => ({ code: r.code, n: int(r.n), tools: int(r.tools) })),
    byTool: (raw.byTool || []).map((r) => ({ tool: r.tool, code: r.code, n: int(r.n) })),
    errors: raw.errors || [],
  };
}

function costMetric(usage) {
  if (!usage || !usage.cohorts || !usage.cohorts.real) return { status: METRIC_STATUS.NO_DATA, note: '成本档未取到' };
  const real = usage.cohorts.real;
  const rounds = real.rounds || [];
  const convIds = new Set(rounds.map((r) => r.cid).filter((x) => x != null));
  const runIds = new Set(rounds.map((r) => r.rid).filter((x) => x != null));
  const total = rounds.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const top = (usage.topConversations || []).map((r) => ({
    conversationId: r.cid, title: r.title || null, rounds: int(r.rounds), cost: Number(r.cost) || 0,
    share: total > 0 ? (Number(r.cost) || 0) / total : null,
  }));
  return {
    status: rounds.length ? METRIC_STATUS.OK : METRIC_STATUS.NO_DATA,
    // C3：单位任务成本（只报数）。run 未挂账的轮次用会话口径兜底（与 `kpi.mjs` 的 orphanRounds 同因）
    runs: runIds.size, conversations: convIds.size, total,
    perRun: runIds.size ? total / runIds.size : null,
    perConversation: convIds.size ? total / convIds.size : null,
    topConversations: top,
    note: 'perRun 的分母是**本窗口内真实流量轮次出现过的 agent_run_id 个数**（未挂 run 的轮次不计入分母，与 kpi.mjs 的 orphanRounds 同因）；'
      + '跨窗口不可直接相加，做前后对比请用同一 days 的两次快照。',
  };
}

function pipelineMetric(raw) {
  if (!raw) return { status: METRIC_STATUS.NO_DATA, note: '提案载体未采集' };
  const n = (o) => (o && !o.__err ? int(o.n) : null);
  return {
    status: METRIC_STATUS.OK,
    evoGoals: n(raw.evoGoals), evoGoalTasks: n(raw.evoGoalTasks), evoMemos: n(raw.evoMemos),
    demandsByStatus: (raw.demandsByStatus || []).filter((r) => !r.__err).map((r) => ({ status: r.status, n: int(r.n) })),
  };
}

/** 金标读数成型。跑不起来 ≠ 通过：既有错误**也包括原因**，不许把它吞成一句"未取到"。
 *  `status` 的口径：**只有"至少有一个壳真跑出了结果、且没有壳报错"才是 ok**；
 *  一个壳都没配 eval_ref、或所有壳都 error ⇒ `no-data`（= 准入前置不满足）。
 *  逐壳的 `skipped`/`error`/`passed`/`total` 原样保留（判"是否在位"要靠它们，不能只看这一个状态）。 */
function canaryMetric(canary) {
  if (!canary) return { status: METRIC_STATUS.NO_DATA, note: '未采集金标读数' };
  if (!canary.available) {
    return {
      status: METRIC_STATUS.NO_DATA,
      available: false, shells: [], failedShells: [],
      error: canary.error || '金标读数不可用（未给出原因）',
      note: '金标实现跑不起来：' + (canary.error || '未给出原因'),
      lastRun: canary.lastRun || null,
    };
  }
  const shells = canary.shells || [];
  const failedShells = shells.filter((s) => s.error || s.skipped || (s.total != null && s.passed !== s.total));
  const okShells = shells.filter((s) => !s.error && !s.skipped && s.total != null && s.passed === s.total);
  return {
    ...canary,
    failedShells,
    status: (shells.length && !failedShells.length && okShells.length) ? METRIC_STATUS.OK : METRIC_STATUS.NO_DATA,
  };
}

/**
 * 成型：原始读数 → 结构化快照（**纯函数**，夹具直测）。
 * @param {{at:Date, days:number, cutoff?:string, usage?:object, ledger?:object, failures?:object,
 *          canary?:object, pipeline?:object, sources?:Array, collectErrors?:string[], code?:object}} raw
 *   `code`（㉔ 用，可选）：`{ commit, dirty, at, error }` —— 这份读数属于哪一版代码。纯函数收进来，
 *   **不在这里调 git**（成型是纯函数，不许有进程外副作用；调 git 的是 scripts/metrics-report.mjs）。
 */
export function buildSnapshot(raw) {
  const at = raw && raw.at instanceof Date ? raw.at : new Date();
  const days = Math.max(1, Math.floor(Number(raw && raw.days) || DEFAULT_DAYS));
  const collectErrors = [...((raw && raw.collectErrors) || [])];
  const usageErrors = (raw && raw.usage && raw.usage.errors) ? Object.entries(raw.usage.errors).map(([k, v]) => `usage.${k}: ${v}`) : [];
  collectErrors.push(...usageErrors);
  const cohorts = (raw && raw.usage && raw.usage.cohorts) || {};
  return {
    schema: SNAPSHOT_SCHEMA,
    kind: 'rw-selfeval-snapshot',
    batchId: batchIdOf(at, days),
    generatedAt: at.toISOString(),
    // 代码版本锚（㉔：门禁要能回答"这份读数属于哪一版代码"）。读不到 git 就如实记 error，**不编一个假版本**。
    code: (raw && raw.code) ? { commit: raw.code.commit ?? null, dirty: Boolean(raw.code.dirty), at: raw.code.at ?? null, ...(raw.code.error ? { error: String(raw.code.error).slice(0, 160) } : {}) } : null,
    // 时间窗口径：库本地时间（server/cohort.js 实测 @@session.time_zone=UTC+8），与报表脚本同源
    window: { days, cutoff: (raw && raw.cutoff) || null, unit: '库本地时间(UTC+8)' },
    // 库到底读没读到（㉔ 准入前置判"在位"要用）：连接级报错出现过 ⇒ false（那不是"窗口里没数据"）。
    databaseAvailable: !collectErrors.some((e) => looksLikeConnectionError(e)),
    metrics: {
      // 分档照 §0.3.1：真实流量 / 人发起 / 定时任务 / 探针 / 孤儿。**不合并隐藏**，也不设达标线
      c1c2: {
        status: (cohorts.real ? METRIC_STATUS.OK : METRIC_STATUS.NO_DATA),
        cohorts: {
          real: cohortMetric(cohorts.real),
          human: cohortMetric(cohorts.human),
          scheduled: cohortMetric(cohorts.scheduled),
          probe: cohortMetric(cohorts.probe),
          orphan: cohortMetric(cohorts.orphan),
        },
        note: '口径＝`server/cohort.js`（§0.3.1 定稿）：探针成绩不得当真实流量成绩引用；累计 C1 会被历史锁死，判据看新段。',
      },
      c3: costMetric(raw && raw.usage),
      c4c5: ledgerMetric(raw && raw.ledger),
      failures: failuresMetric(raw && raw.failures),
      canary: canaryMetric(raw && raw.canary),
      pipeline: pipelineMetric(raw && raw.pipeline),
    },
    // 外部对标源：**半自动**——只记文档身份，不做抓取（见本文件顶部 BENCHMARK_SOURCES 注释）
    benchmarkSources: (raw && raw.sources) || [],
    collectErrors,
  };
}

/** 采集全流程（查库 + 成型）；CLI 与 `propose.js` 都用它，保证两处拿到的是同一份快照。 */
export async function collectSnapshot({ dbc = db, days = DEFAULT_DAYS, cutoff = null, at = new Date(), root = ROOT, code = null } = {}) {
  const [usage, ledger, failures, canary, pipeline] = await Promise.all([
    collectUsage({ dbc, days, cutoff }),
    collectLedger({ dbc, days }),
    collectFailures({ dbc, days }),
    collectCanary({ dbc }),    collectPipeline({ dbc }),
  ]);
  const sources = BENCHMARK_SOURCES.map((s) => ({ ...s, ...sourceFingerprint(s.path, root) }));
  return buildSnapshot({ at, days, cutoff, usage, ledger, failures, canary, pipeline, sources, code });
}
