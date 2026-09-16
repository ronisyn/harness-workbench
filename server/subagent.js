// server/subagent.js - 子代理（F16/F17）：主代理可派生子代理独立执行任务
// 设计：子代理复用 runAgent 完整循环（自带工具 + 完成度判断 + 护栏）；
//       同步模式=等结果；异步模式=立即返回 id，用 subagent_output 轮询取结果。
//       子代理内部工具步骤实时转发给前端（事件名前缀 "子:"），并落 tool_calls 留痕。
// RA-12（§14.4）：调用方可传 tools 只给一个子集 → 子代理工具清单里**只有这些**（其他根本不出现，执行层同口径拒绝）。
// RA-13（§14.4）：子代理失败**不再返回光秃秃的异常**——失败原因、已花的钱、已做的工具步骤、已产出的部分正文一并回传，
//                 由父代理"照出交付物并标注该块未取得"。
// RA-14（§14.4）：调用方可切一块额度（budgetYuan）给子代理；子代理只烧这块（与段阈值/会话总账 min 叠加）；
//                 未花完的部分**显式回收**（回传 budget/spent/remaining），父级始终留有汇总。
import { runAgent } from './agent.js';
import { parseToolWhitelist, narrowEnabled } from './subtools.js';
import { childEmit } from '../scripts/child-emit.js';
import { db } from './db.js';
import { storage } from './storage/index.js'; // v0.3 §4.6「预算与审计：本地兜底」：派生留痕的写口走接口

export const subs = new Map(); // id -> { status: running|done|error, prompt, name, result, error, createdAt }
let subSeq = 0;

// OP-08：子代理深度上限（settings `subagent_max_depth`，默认 3，1=禁止派生）。
// 读不到设置就回退 3 —— 与旧硬编码行为完全一致（"没有证据不动行为"）；10 秒缓存防每轮查库。
export const SUBAGENT_MAX_DEPTH_DEFAULT = 3;
let _depthCache = null, _depthAt = 0;
export async function subagentMaxDepth() {
  if (_depthCache != null && Date.now() - _depthAt < 10000) return _depthCache;
  let v = SUBAGENT_MAX_DEPTH_DEFAULT;
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', ['subagent_max_depth']);
    if (r && r[0] && r[0].svalue != null) {
      const n = Number(r[0].svalue);
      if (Number.isFinite(n) && n >= 1 && n <= 8) v = Math.floor(n);
    }
  } catch { /* 设置读不到按默认 */ }
  _depthCache = v; _depthAt = Date.now();
  return v;
}

// 长期运行护栏：finished 记录保留 2 小时；超过 300 条时淘汰最老的已完成项
const SUB_TTL_MS = 2 * 60 * 60 * 1000;
const SUB_MAX = 300;
export function pruneSubs() {
  const now = Date.now();
  let doneCount = 0;
  for (const [id, s] of subs) {
    if (s.status !== 'running' && now - new Date(s.createdAt).getTime() > SUB_TTL_MS) subs.delete(id);
    else if (s.status !== 'running') doneCount++;
  }
  if (doneCount > SUB_MAX) {
    const finished = [...subs.entries()].filter(([, s]) => s.status !== 'running')
      .sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
    for (const [id] of finished.slice(0, doneCount - SUB_MAX)) subs.delete(id);
  }
}

export function makeSubId() {
  subSeq += 1;
  return 'sub-' + subSeq + '-' + Date.now().toString(36);
}

function cap(s, n) { return String(s || '').slice(0, n); }

// 子代理序号段：每个子代理独占 1000 个序号，避免与父/兄弟事件撞号
let seqBaseCursor = 0;
function nextSeqBase() { seqBaseCursor += 1000; return seqBaseCursor; }

// 转发子代理内部事件给前端（实现见 scripts/child-emit.js：与 RA-37 实测脚本共用同一条转发路径）
function forwardChildEvent(parentEmit, subId, label, seqBase) {
  return childEmit(parentEmit, subId, label, seqBase);
}

/**
 * RA-13：把一条子代理记录转成"父代理可消费的结果"。
 * 失败时**不抛**，而是如实给出：失败原因 + 已花费 + 已完成的工具步骤 + 已产出的部分正文 + 取证入口。
 * @returns {object} 足够父代理"照出交付物并标注该块未取得"的最小结构化数据
 */
export function subagentOutcome(rec) {
  if (!rec) return { status: 'error', reason: '子代理记录不存在（可能已按 TTL 清理，保留 2 小时）', degraded: true };
  // RA-14：实花以 runAgent 回传的 spentYuan 为准；它缺失时**不下结论**（不拿 0 冒充"没花钱"），
  // 但已花的成本仍然被记进 usage_stats（父级的会话总账），所以"父级留汇总"这一半始终成立。
  const spent = rec.spentYuan != null ? rec.spentYuan : null;
  const base = {
    sub_id: rec.id,
    name: rec.name,
    kind: rec.kind || 'spawn',
    status: rec.status,
    durationMs: rec.durationMs ?? null,
    // RA-12 回执：实际下发的工具清单（null=继承父级，未收窄）——父代理据此知道这一块能取到什么
    tools: rec.tools || null,
    // RA-14 回执：切给它的额度、实际花了多少、还剩多少（未花完=显式回收，父级留汇总）
    budgetYuan: rec.budgetYuan ?? null,
    spentYuan: spent,
    refundYuan: rec.budgetYuan != null && spent != null ? Math.round((rec.budgetYuan - spent) * 1000) / 1000 : null,
    toolSteps: (rec.toolLog || []).length,
    lastSteps: (rec.toolLog || []).slice(-8),
  };
  if (rec.status === 'done') return { ...base, result: cap(rec.result, 6000) };
  // 失败/挂起：交付物照出（部分正文 + 完成步骤），并明确标注该块未取得
  return {
    ...base,
    degraded: true,
    error: rec.error || rec.reason || '未说明的失败',
    result: cap(rec.result, 6000),
    note: '该块数据未取得：子代理' + (rec.status === 'error' ? '执行出错' : '被护栏挂起') + '，以上是它已产出的部分内容与已完成步骤；'
      + '父代理应在交付物中照常给出这一块并标注"未取得"，不要静默省略、也不要伪造其结论。完整步骤用 subagent_report {id:"' + rec.id + '"} 取证。',
  };
}

export async function spawnSubagent({ prompt, name, provider, model, permission = 'full', parentCtx = {}, keys, temperature = 0.4, depth = 0, seedMessages = [], noSubagentOverride = false, contract = null, tools = null, budgetYuan = null }) {
  pruneSubs();
  const id = makeSubId();
  const seqBase = nextSeqBase();
  // RA-12：白名单在这里解析（纯函数，含"名字不在清单里"的当场报错）——装配期发现问题，不留到运行期
  const whitelist = parseToolWhitelist(tools);
  const effectiveEnabled = narrowEnabled(parentCtx.__enabledTools, whitelist);
  // RA-14：额度切分。0/null/负数 = 不切（沿用父级段阈值语义，行为不变）
  const quota = Number(budgetYuan) > 0 ? Number(budgetYuan) : null;
  const record = {
    id, status: 'running', prompt: cap(prompt, 2000), name: name || '子代理', createdAt: new Date().toISOString(), depth,
    kind: (seedMessages && seedMessages.length) ? 'fork' : 'spawn',
    tools: whitelist ? [...whitelist] : null,
    budgetYuan: quota,
  };
  subs.set(id, record);
  // 子代理上下文：继承会话与账号，禁止再无限套娃（depth>=上限 或调用方强制 noSubagentOverride）
  // OP-08（2026-09-15）：上限原本**硬编码 3**，而"2 层够不够"从未实证。两件事一起补：
  //   ① 上限改为可配置（settings `subagent_max_depth`，默认 3）——运维可收紧/放开而不用改代码；
  //   ② 每次派生记录实际深度。**2026-09-16 更正**：原先这里写"journalctl + agent_runs.tool_counts 可统计"，
  //      其中后半句**不成立**——子代理不进 `agent_runs`（那张表记的是 /api/chat 的运行），
  //      于是"有数据可查"其实只有 stdout 日志一种，重启即散。现在把每次派生落一行审计账本，深度变成可查的：
  //        SELECT JSON_EXTRACT(detail,'$.depth') d, COUNT(*) FROM audit_log WHERE action='subagent:spawn' GROUP BY d;
  //      **本次不改默认值**：没有证据就不动行为。
  const maxDepth = await subagentMaxDepth();
  const childDepth = (parentCtx.depth || 0) + 1;
  const childCtx = {
    ...parentCtx,
    permission,
    depth: childDepth,
    skills: parentCtx.skills || {},
    noSubagent: noSubagentOverride || childDepth >= maxDepth,
    // RA-12：收窄后的启用集 + 白名单本体（执行层门禁也读它）
    __enabledTools: effectiveEnabled,
    __subTools: whitelist,
    // RA-14：子代理额度（agent.js 每轮与段阈值/会话总账取 min 后判定）
    __subBudgetYuan: quota,
  };
  record.depth = childDepth;
  console.log('[subagent] depth=' + childDepth + '/' + maxDepth + ' id=' + id + ' name=' + String(record.name || '').slice(0, 40)
    + ' tools=' + (whitelist ? whitelist.size : 'inherit') + (childCtx.noSubagent ? '（本层不可再派生）' : ''));
  // OP-08 的证据落账（见上面 ② 的更正）：深度要能**用 SQL 查**，否则"2 层够不够"永远只能靠日志翻。
  // 留痕失败必须出声（本仓库的教训：静默 catch 会让账本静默缺行），但**不得阻断派生**。
  // 只在**有会话归属**时落账：没有归属的派生（夹具/无会话调用）落了也没法归因，只会污染"真实任务用到第几层"
  // 这个统计——实测夹具用 `conversationId: 0` 起子代理，若不加这条，测试跑一遍就往证据里灌一批 depth=1。
  if (parentCtx.conversationId) {
    storage.audit.append({ accountId: parentCtx.accountId ?? null, action: 'subagent:spawn', detail: JSON.stringify({ id, name: String(record.name || '').slice(0, 60), depth: childDepth, maxDepth, canSpawnMore: !childCtx.noSubagent, tools: whitelist ? whitelist.size : null }), shellId: parentCtx.shellId ?? null, conversationId: parentCtx.conversationId })
      .catch((e) => console.warn('[subagent] 派生留痕失败（不影响执行，但 OP-08 的深度证据会缺行）：' + ((e && e.message) || e)));
  }
  const t0 = Date.now();
  // P10 子代理输出契约（2026-09 批4）：默认注入结构化输出模板（调用方可传 contract 覆盖/关闭）。
  // 目的：子代理返回"可消费的结构化结果"而非自由散文——父代理/驱动器可稳定解析（结论/产物/验证/遗留）。
  const SUB_CONTRACT = [
    '【子代理输出契约】任务完成后按以下结构返回（markdown，简洁）：',
    '## 结论（1-3 句直接回答）',
    '## 做了什么（要点列表，含关键文件/路径/命令）',
    '## 结果与验证（实测证据：输出/测试/截图，区分"已验证"与"推断"）',
    '## 遗留/风险（未完成事项、假设、需父代理注意点；无则写"无"）',
    '只返回上述结构内容，不要额外寒暄。',
  ].join('\n');
  const effContract = contract === null ? SUB_CONTRACT : (contract ? String(contract) : '');
  const runPromise = runAgent({
    provider, model, permission,
    messages: [...(seedMessages || []), { role: 'user', content: prompt + (effContract ? '\n\n' + effContract : '') }],
    ctx: childCtx, keys, temperature,
    emit: forwardChildEvent(parentCtx.__emit, id, record.name, seqBase),
  });
  const settle = async () => {
    try {
      const r = await runPromise;
      // 护栏挂起（含 RA-14 额度用尽）也走这里：runAgent 正常返回，但内容只是挂起文案，
      // 且 toolLog 里的步骤是真实产出 —— 不能当成功，也不能丢。
      const guarded = r && (r.guard || r.paused);
      record.status = guarded ? 'error' : 'done';
      record.reason = guarded ? ('guard=' + (r.guard || 'paused')) : null;
      record.durationMs = Date.now() - t0;
      record.result = r.content;
      if (guarded) record.error = r.content;
      record.usage = r.usage || {};
      record.spentYuan = r.spentYuan != null ? r.spentYuan : (record.usage && record.usage.cost != null ? Math.round(Number(record.usage.cost) * 1000) / 1000 : null);
      record.toolLog = (r.toolLog || []).slice(-15).map((t) => ({ name: t.name, status: t.status }));
    } catch (e) {
      record.status = 'error';
      record.error = e.message;
      // RA-13：失败也要留住"已经做出来的东西"——异常路径下部分正文可能挂在 error 对象上（网关把已收内容带出来了）
      if (e && e.partialContent) record.result = e.partialContent;
      // RA-14：runAgent 抛出时拿不到 cumCost（它是循环内变量）。失败在第一次 LLM 调用前（如"厂商未配置 API Key"）
      // 是常态，此时实花就是 0；但**不猜**成 0 之外的值——成本口径宁缺勿假（真实消耗仍由 usage_stats 记账）。
      if (record.spentYuan == null) record.spentYuan = 0;
      record.spentNote = '失败路径：实花按 0 记（未产生计费调用）；若已产生调用，其成本仍在 usage_stats 会话总账内';
    }
    return record;
  };
  // 后台静默结算（不 await 也保证 record 最终更新）
  const done = settle();
  return { id, promise: done };
}

export async function waitSub(id, ms = 900000) {
  const rec = subs.get(id);
  if (!rec) throw new Error('子代理不存在: ' + id);
  const t0 = Date.now();
  while (rec.status === 'running' && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 800));
  }
  return rec;
}
