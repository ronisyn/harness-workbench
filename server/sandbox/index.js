// server/sandbox/index.js - 沙箱**服务本体**（v0.3 §4.6「沙箱：服务 + 按平台后端」；§7.1 ⑰；依赖 ⑯）
//
// 分层照 DSH（先问规矩）：
//   `dsh-sandbox`（服务/接口 + SandboxUnavailableError）+ `dsh-sandbox-policy`（策略）
//   + `dsh-sandbox-local`（本地实现：平台 runner 链 + 功能探针 + 结果有界缓存）
//   + 按子系统的适配器（`dsh-bash-sandbox` / `dsh-fs-sandbox`）。
//   本目录同形：`policy.js`＝策略、`backends/`＝按平台后端与探针、`probe-state.js`＝探测与有界缓存、
//   `report.js`＝纯格式化、`degrade.js`＝降级三件套、`index.js`＝**服务动词**（本文件）。
//
// 服务动词（照 DSH 的 `SandboxProvider`，只留我们真用得上的）：
//   · `probe()` / `available()` / `probeCacheState()` / `resetProbeCache()` —— 探测与结果（结构化）
//   · `modeFor(permission)` / `policy(ctx)`  —— 会话权限档 → 沙箱模式（DSH `sandboxPolicy.resolve` 同一件事）
//   · `confine(argv|line, policy)`           —— **argv 级接缝**：把一次执行的 argv 包进 runner
//   · `compose(ctx)`                          —— 喂 `server/capabilities.js` 的四层 state + enforcement 三值
//   · `guard()`                               —— 启动门禁（严格模式拒绝启动；默认显式降级）
//
// ── 拒绝语义（DSH vs 本平台：本模块最要紧的一段）────────────────────────────────
//   DSH：拿不到 runner ⇒ `SandboxUnavailableError`（**拒绝执行**，绝不静默裸奔）。
//   v0.3 §4.6：第 2 层拿不到模式 ⇒ **拒绝启动**。
//   ⚠️ 迁移期偏离（用户拍板的落地方式，必须写进注释与交付说明）：
//     **本平台现在没有任何沙箱后端**，若默认就拒绝启动/拒绝执行，线上会直接不可用。所以：
//       · 默认：`confine()` **带原因放行**（enforcement='none' + confined:false + 一句能直接读到的话），
//         并**落降级账 + 逐次如实上报**——§4.6 的"禁止静默降级"就是这一条：可以降，但不许不说；
//       · `RW_SANDBOX_REQUIRED=1`：走 **v0.3 字面语义**——`confine()` 抛 `SandboxUnavailableError`，
//         启动链调 `guard()` 直接拒绝启动；
//       · 两种模式**共用同一份探测结论**，不因为"放行"就少探一次、少报一层。
//   为什么放行时也一定要给个不同的东西：调用方要能区分"跑成功了"与"**没隔离地**跑成功了"，
//   所以放行时 `enforcement` 一律 `'none'`（真 runner 通过时是 `'partial'`）。
import os from 'node:os';
import { RW_WORKSPACE } from '../env.js';
import { SANDBOX_MODES, modeForPermission, policyFor, subsystemOf, SANDBOXED_TOOLS } from './policy.js';
import { candidateChain, runProbe, PROBE_TIMEOUT_MS, probe, readProbe, probeCacheState, probePending, resetProbeCache, available, compose, warmup } from './probe-state.js';
import * as linuxBackend from './backends/linux.js';
import { composeEnforcement, fakeProbe, UNPROBED } from './report.js';
import { approvalRequired, auditDegrade, auditDegradeOnce, resetDegradeLedger, sandboxRequired, startupGuard, SandboxUnavailableError } from './degrade.js';

export {
  // 策略
  SANDBOX_MODES, modeForPermission, policyFor, subsystemOf, SANDBOXED_TOOLS,
  // 探测与缓存
  probe, readProbe, probeCacheState, probePending, resetProbeCache, available, compose, PROBE_TIMEOUT_MS, warmup,
  candidateChain, runProbe, composeEnforcement, fakeProbe, UNPROBED,
  // 降级三件套
  approvalRequired, auditDegrade, auditDegradeOnce, resetDegradeLedger, sandboxRequired, startupGuard, SandboxUnavailableError,
};

/** 会话权限档 → 沙箱模式（服务动词，与 DSH 的 `sandboxPolicy.resolve` 同形）。 */
export function modeFor(permission) { return modeForPermission(permission); }

/** 完整策略（模式 + 可写根 + 理由）。 */
export function policy(ctx = {}) { return policyFor(ctx); }

/**
 * **argv 级接缝**（照 DSH 的 `SandboxProvider.confine(argv, policy)`；DSH 的 `dsh-bash-sandbox`
 * 就是在这里把 `bash -c <cmd>` 换成 `runner … -- bash -c <cmd>`，其余一概不动）。
 *
 * @param {string[]|string} argvOrLine 内层 argv，或一条命令串（字符串会被包成该平台的 shell argv）
 * @param {{cmdline?:Function, mode?:string, permission?:string, workspaceRoot?:string, tempRoot?:string,
 *          platform?:string, required?:boolean, probeResult?:object, timeoutMs?:number, runProbeFn?:Function}} [policyArg]
 *        `cmdline`：把命令串换成 argv 的**调用方口径**（通常直接传 ⑯ 的 `execPlan`）——
 *        这样"命令串怎么变成 argv"只有一处实现，本模块不再抄第二份（没有它时按 `lineToArgv` 兜底）。
 * @returns {{argv:string[], confined:boolean, mode:string, enforcement:'full'|'partial'|'none',
 *            runner:string|null, denialSignatures:string[], reason:string}}
 */
export function confine(argvOrLine, policyArg = {}) {
  const innerArgv = Array.isArray(argvOrLine)
    ? argvOrLine.map(String)
    : (typeof policyArg.cmdline === 'function'
      ? (() => { const pl = policyArg.cmdline(argvOrLine); return [pl.command, ...(pl.args || [])]; })()
      : lineToArgv(String(argvOrLine), policyArg.platform || process.platform));
  const mode = policyArg.mode || modeForPermission(policyArg.permission || 'full');
  const workspaceRoot = policyArg.workspaceRoot || RW_WORKSPACE;
  const tempRoot = policyArg.tempRoot || os.tmpdir();
  if (!SANDBOX_MODES.includes(mode)) throw new Error('未知沙箱模式：' + mode + '（合法值：' + SANDBOX_MODES.join(' / ') + '）');

  // ① full-access：**按设计不沙箱**（不是"拿不到"）。如实返回 enforcement=none，理由写清是权限档使然。
  if (mode === 'full-access') {
    return {
      argv: innerArgv, confined: false, mode, enforcement: 'none', runner: null, denialSignatures: [],
      reason: '本会话权限=full：按 §4.6 不沙箱（仍如实上报 enforcement=none，不许因为"是设计"就报 full）',
    };
  }

  // ② 需要沙箱：看有没有可用 runner。优先用调用方给的探测结果；其次读缓存（热路径零副作用）；
  //    缓存里**没探过**（readProbe 给出 UNPROBED）则看加载期预热是否在进行：
  //      · 探测**未就绪**时不许猜——严格模式抛（fail-closed），迁移期按"未隔离"如实放行并**标明未就绪**；
  //      · 真的没在探（预热被 RW_SANDBOX_PROBE_AT_LOAD=0 关掉）才就地补探一次（异步，不 await——
  //        本函数是同步的 argv 接缝；补探结果在下一次调用生效，本轮按"未隔离"如实上报）。
  const cached = policyArg.probeResult || readProbe();
  const p = (cached.runner || cached.probed)
    ? cached
    : (probePending()
      ? { probed: false, ok: false, runner: null, unavailableReason: '沙箱探针尚未就绪（加载期探测进行中）' }
      : (probe({ source: 'confine-first-use', timeoutMs: policyArg.timeoutMs, runProbeFn: policyArg.runProbeFn }),
        { probed: false, ok: false, runner: null, unavailableReason: '沙箱探针尚未就绪（本轮首次执行触发了探测）' }));
  const platform = p.platform || policyArg.platform || process.platform;
  if (p.ok && p.runner) {
    const chain = candidateChain({ platform, env: process.env });
    const cand = chain.find((c) => c.id === p.runner.id) || null;
    if (!cand || typeof cand.build !== 'function') {
      // 探测说可用、但当前链里找不到对应的 build ⇒ 配置在两次探测之间变了。**不做静默兜底**：
      // 要么抛（严格），要么如实降级放行（迁移期），绝不用另一个 runner 顶上（那会换掉隔离语义）。
      return unconfined(innerArgv, mode, '探测结果与当前候选链不一致（runner=' + p.runner.id + '）——不静默换 runner', policyArg);
    }
    const args = cand.build({ mode, workspaceRoot, tempRoot }, innerArgv);
    return {
      argv: args.map(String), confined: true, mode, enforcement: p.runner.enforcement || 'partial',
      runner: cand.id, denialSignatures: cand.denialSignatures || [],
      reason: '已包进 ' + cand.id + '（模式 ' + mode + '，可写根 ' + workspaceRoot + '）',
    };
  }

  // ③ 拿不到 runner：DSH 在这里抛；我们默认降级放行、严格模式抛（见文件头"拒绝语义"）
  return unconfined(innerArgv, mode, String(p.unavailableReason || '没有可用 runner'), policyArg);
}

/** 拿不到 runner 时的两条路（同一个判据，只有严格开关不同）。 */
function unconfined(innerArgv, mode, why, policyArg = {}) {
  const strict = policyArg.required !== undefined ? !!policyArg.required : sandboxRequired();
  if (strict) throw new SandboxUnavailableError(mode, why);
  return {
    argv: innerArgv, confined: false, mode, enforcement: 'none', runner: null, denialSignatures: [],
    reason: '没有可用 runner（' + why + '）：按迁移期口径**未隔离执行**，如实上报 enforcement=none'
      + '（RW_SANDBOX_REQUIRED=1 时这里会拒绝执行）',
  };
}

/**
 * 命令串 → 内层 argv。**兜底口径**：调用方应优先传 ⑯ 的 `execPlan`（那才是唯一实现），
 * 本函数只在"调用方直接给命令串、又没给 cmdline"时用，形状与 `server/exec/local.js` 的 `argvFor` 对齐。
 * 为什么不 import 执行后端：⑰ 与 ⑯ 的接缝方向是"⑯ 调 ⑰ 包 argv"，反向 import 会绕成环。
 */
export function lineToArgv(line, platform = process.platform) {
  const s = String(line);
  return platform === 'win32'
    ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', s]
    : ['/bin/bash', '-c', s];
}

/** 逐次上报用的紧凑值（`capabilitySummary` 的 `enforcement` 就是它）。 */
export function enforcementOfCurrent(ctx = {}) { return compose(ctx).enforcement; }

/** 降级留痕（每进程一次；启动链可显式调用，也可由清单渲染时调用）。 */
export async function noteDegrade(ctx = {}, extra = {}) {
  const c = compose(ctx);
  const logged = await auditDegradeOnce(c, extra);
  return { composed: c, logged };
}

/** 启动门禁（接 `server/index.js` 启动链；严格模式下拒绝启动）。**启动时真探一次**，不吃缓存。 */
export async function guard(o = {}) {
  const p = await probe({ force: true, source: o.source || 'startup', timeoutMs: o.timeoutMs, runProbeFn: o.runProbeFn });
  const composed = composeEnforcement(o.ctx || {}, p);
  return startupGuard({ probe: p, composed, required: o.required, extra: o.extra });
}

/** 诊断用的一次性真探（运维/夹具；**会起进程**，别放进热路径）。 */
export function diagnose(o = {}) { return probe({ force: true, source: o.source || 'diagnose', ...o }); }

// Linux 后端的探针脚本与宿主核对函数在这里再导出一次：部署方/夹具要在**不改本模块**的前提下核对判据。
export const PROBE_SCRIPT = linuxBackend.PROBE_SCRIPT;
export function hostCrossCheck(p) { return linuxBackend.hostCrossCheck(p); }
