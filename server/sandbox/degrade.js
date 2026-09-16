// server/sandbox/degrade.js - §4.6 的"显式降级"三件套：**留痕 + 提高审批 + 客户可见**
//
// v0.3 §4.6 原文（沙箱那一行）：「第 2 层（引擎自带沙箱）拿不到模式 → **拒绝启动**；
//   第 1/3/4 层能力缺失 → **显式降级**（留痕 + 提高审批 + 客户可见，禁止静默降级）；
//   降级程度逐次上报 `enforcement: full/partial/none`」。
// 本文件管的正是"留痕"与"提高审批"两件；"客户可见"由 `server/capabilities.js` 的清单/事件出口承担；
// "逐次上报"由 `capabilitySummary`（每条 run_end）承担。
//
// ⚠️ **一处必须写明的偏离**（用户口径：迁移期落地方式，必须写进注释与交付说明）：
//   v0.3 的字面语义是"第 2 层拿不到模式 ⇒ 拒绝启动"。但**本平台现在没有任何沙箱后端**——
//   若默认就拒绝启动，线上服务会直接起不来（等于拿"安全"换"服务不可用"）。
//   所以落地方式是：**默认＝显式降级（留痕 + 上报 + 提高审批 + 客户可见）**；
//   另加部署开关 `RW_SANDBOX_REQUIRED=1` 走 **v0.3 的严格语义**（拿不到就拒绝启动）。
//   一旦目标机上装好 `bwrap`（或配好部署方 runner）并把开关打开，就是 v0.3 的字面语义，无需改代码。
//   开关的**定义**归 `server/env.js`（真值表只有那一份实现，本模块转调；env 参数只是夹具的缝）。
import { db } from '../db.js';
import { storage } from '../storage/index.js'; // v0.3 §4.6「预算与审计：本地兜底」：降级留痕的写口走接口
import { sandboxRequiredEnv } from '../env.js';

/** 严格开关的真值判定（部署开关就该只认这几个写法；`0`/`false`/空一律当没开）。实现见 env.js。 */
export const sandboxRequired = (env) => sandboxRequiredEnv(env);

/** 严格模式：拿不到模式时的**结构化错误**（调用方据此拒绝启动；不在这里 process.exit——那会让夹具无法断言）。 */
export class SandboxUnavailableError extends Error {
  constructor(mode, detail) {
    super('沙箱模式 "' + mode + '" 拿不到（本机没有可用 runner），RW_SANDBOX_REQUIRED=1 下拒绝启动。'
      + (detail ? '原因：' + detail : ''));
    this.name = 'SandboxUnavailableError';
    this.code = 'SANDBOX_UNAVAILABLE';
    this.mode = mode;
  }
}

/**
 * 降级账本行（`audit_log`，与 `hooks.js` 的 `hook:error`、`epoch.js` 的 `prefix:warmup` 同一写法）。
 * action=`sandbox:degrade`（用户点名要的形态），detail 里带**缺失层 + 原因 + 逐次上报值**——
 * "为什么降级"必须能从账上直接读出来，而不是让人再去翻一次探测。
 * 失败只打日志，绝不抛（与 hooks.js 的留痕同一条纪律：留痕失败不改判主流程）。
 * @returns {Promise<boolean>} 是否真的落账（夹具据此断言"降级必须落账"）
 * @param {object} [store] 存储接口的**注入缝**（默认用进程单例）：夹具靠它挡在真库之外——
 *   这条路径原先没有任何夹具覆盖，2026-09-16 迁写口时"忘了 import storage"只在**服务器启动**时才炸
 *   （`storage is not defined`），本地全量门禁是绿的。补上注入缝 + 夹具之后这类漏网当场可见。
 */
export async function auditDegrade(composed, extra = {}, store = storage) {
  const c = composed || {};
  const layers = Array.isArray(c.layers) ? c.layers : [];
  const missing = layers.filter((l) => l.state !== 'full').map((l) => l.id + ':' + l.state);
  const detail = JSON.stringify({
    enforcement: c.enforcement || 'none',
    level: c.level || null,
    probed: !!c.probed,
    runner: c.runner || null,
    missingLayers: missing,
    reason: String((extra && extra.reason) || (layers.find((l) => l.id === 2) || {}).note || '').slice(0, 300),
    platform: (extra && extra.platform) || process.platform,
    accountId: (extra && extra.accountId) ?? null,
    conversationId: (extra && extra.conversationId) ?? null,
  }).slice(0, 1000);
  try {
    await store.audit.append({ accountId: (extra && extra.accountId) ?? null, action: 'sandbox:degrade', detail: detail, shellId: (extra && extra.shellId) ?? null, conversationId: (extra && extra.conversationId) ?? null });
    return true;
  } catch (e) {
    // 与 hooks.js/epoch.js 同口径：账本写不进去要出声，但不能把主流程带走。
    console.error('[sandbox] 降级账本缺行（降级已发生）：' + ((e && e.message) || e));
    return false;
  }
}

/**
 * 进程级降级账本（**每个进程只落一次**）。
 * 为什么需要它：`capabilitySummary` 在**每条 run_end** 上被调用（index.js 的三条路径各一次），
 * 而"本机没有沙箱"这件事在一个进程生命周期里只应该记一次——否则账本会被同一句话刷满
 * （这正是"留痕"变成"噪音"的常见方式）。逐次上报仍然逐次发生（那是 §4.6 明确要求的），
 * 只是**账本行**按进程去重。
 * @returns {Promise<boolean>} 本次是否落了账（true=第一次）
 */
let degradedLogged = false;
export async function auditDegradeOnce(composed, extra = {}) {
  if (degradedLogged) return false;
  degradedLogged = true;
  return auditDegrade(composed, extra);
}

/** 夹具用：复位"每进程一次"的标记（不去重就无法断言第二次不落账）。 */
export function resetDegradeLedger() { degradedLogged = false; }

/**
 * 「提高审批」的**触发条件**（纯函数，不弹卡、不入队——队列是 `server/approval.js` / `asks.js` 的既有能力）。
 *
 * 判据（照 §4.6 的字面，不做过度发挥）：
 *   · `full` / `partial` ⇒ **runner 在工作**（`partial` 是本平台的正常上限：第 1 层未接入，见 report.js），
 *     不需要额外审批；
 *   · `none` ⇒ 第 2 层失效（该被沙箱兜的动作此刻是裸的）⇒ 需要审批；
 *   · `mode === 'full-access'` ⇒ 本会话**按权限设计就不沙箱**（§4.6 说这种情况仍要"如实降级上报"，
 *     但它不是"能力缺失"，而是"权限档如此"）⇒ 不因沙箱而提高审批。
 *     ⚠️ 这里是一个**有意的取舍**，写清理由：若把 full 会话也算作"需要审批"，那么本机默认的
 *     full 会话里**每一次 write_file / run_command 都要人工点一次**——那是把整台机器变成审批泥潭，
 *     而 §4.6 想要的是"拿不到隔离时更小心"，不是"让工作无法进行"。即便如此，`enforcement` 仍照实报
 *     （`none`/`partial` 都照报）——**上报**与**审批**是两件事，不能因为不提高审批就把上报也吞掉，
 *     那就是静默降级。
 *   · `read-only` 模式 + 无沙箱 ⇒ 只读会话本来就不该有写动作，需要审批的只有命令执行（`command` 子系统）。
 * @param {{enforcement?:string}} composed capabilitySummary / 清单里的沙箱值
 * @param {{mode?:string, subsystem?:'command'|'fs'|null, sandboxed?:boolean}} ctx
 * @returns {{required:boolean, why:string}}
 */
export function approvalRequired(composed = {}, ctx = {}) {
  const enforcement = String(composed.enforcement || 'none');
  const mode = String(ctx.mode || 'read-only');
  if (enforcement === 'full' || enforcement === 'partial') {
    return { required: false, why: '沙箱 runner 在工作（enforcement=' + enforcement + '），无需额外审批' };
  }
  if (mode === 'full-access') return { required: false, why: '本会话权限=full：按设计不沙箱（仍如实上报 ' + enforcement + '），不额外提高审批' };
  const sub = ctx.subsystem || null;
  return {
    required: true,
    why: '沙箱不可用（enforcement=' + enforcement + '）：' + (sub ? sub + ' 子系统此刻没有隔离，需人工确认' : '该动作不在沙箱保护内'),
  };
}

/**
 * 启动门禁（**接通点只有这一处**）：`server/index.js` 启动链里调用它即可。
 *
 *   const g = await sandboxStartupGuard();
 *   if (!g.ok) { console.error(g.message); process.exit(1); }
 *
 * 两种行为：
 *   · `RW_SANDBOX_REQUIRED=1`（严格，v0.3 字面语义）：拿不到模式 ⇒ `ok:false` + 结构化错误，调用方拒绝启动；
 *   · 默认（迁移期）：`ok:true` 但 `degraded:true`，并**落一条 `sandbox:degrade` 账**（显式降级，禁止静默）。
 * @param {{probe?:object, composed?:object, limit?:object, required?:boolean, extra?:object}} o
 * @returns {Promise<{ok:boolean, strict:boolean, degraded:boolean, enforcement:string, runner:string|null, message:string, error?:Error}>}
 */
export async function startupGuard(o = {}) {
  const composed = o.composed || {};
  const enforcement = String(composed.enforcement || 'none');
  const strict = o.required !== undefined ? !!o.required : sandboxRequired();
  const detail = (o.probe && (o.probe.unavailableReason || (o.probe.runner && o.probe.runner.detail))) || composed.runner || null;
  if (enforcement === 'full' || composed.runner) {
    return { ok: true, strict, degraded: false, enforcement, runner: composed.runner || null, message: '沙箱 runner=' + composed.runner + '（enforcement=' + enforcement + '）' };
  }
  const message = '沙箱不可用（enforcement=' + enforcement + '，本机没有可用 runner）：'
    + (detail || '未探测到可用 runner')
    + (strict ? '　⇒ RW_SANDBOX_REQUIRED=1：按 v0.3 §4.6 拒绝启动。' : '　⇒ 迁移期默认：显式降级（已落 sandbox:degrade 账，enforcement 逐次上报）。');
  if (strict) {
    const error = new SandboxUnavailableError('read-only', detail || '无可用 runner');
    return { ok: false, strict: true, degraded: false, enforcement, runner: null, message, error };
  }
  await auditDegrade(composed, { ...(o.extra || {}), reason: detail || '无可用 runner' });
  return { ok: true, strict: false, degraded: true, enforcement, runner: null, message };
}
