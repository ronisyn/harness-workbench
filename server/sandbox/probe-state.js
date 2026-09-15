// server/sandbox/probe-state.js - **探测结果的进程级缓存**（有界缓存 + 同步读取缝）
//
// 为什么单独一个文件（不是一个文件拆成两个）：
//   `server/capabilities.js` 要读探测结果，而它被 `server/index.js` 在**每条 run_end** 上调用三次。
//   于是"读探测结果"有两个硬要求：① **同步**（事件路径上是同步代码，不能 await）；
//   ② **绝不能起进程**（否则每条事件都多一个子进程）。探测本身必须同步（`execFileSync`）且只跑一次。
//   把"缓存 + 同步读"独立出来，`capabilities.js` 就能通过**动态 import 这一个模块**拿到它，
//   而不必把 `server/exec/`（⑯ 的执行后端，装配期会校验 RW_EXEC_BACKEND）拖进声明面的依赖里。
//
// 依据：v0.3 §4.6 / 《v0.3-符合性核对-20260916》§2.3 第 2、4 件；
//      探针时长与缓存界的出处见 `backends/index.js` 与 `index.js` 的注释（不发明阈值）。
import { RW_WORKSPACE } from '../env.js';
import { PROBE_TIMEOUT_MS, candidateChain, runProbe, probeCandidates } from './backends/index.js';
import { composeEnforcement, UNPROBED } from './report.js';

export { PROBE_TIMEOUT_MS, candidateChain, runProbe };
export { composeEnforcement, UNPROBED };

/**
 * 有界缓存的**界**：一个进程生命周期内只探一次（无 TTL）。
 * 出处＝DSH `LocalSandboxProvider.selectRunner` 的 `selectedRunner ??= chainVerdict()`：provider 生命周期内一次。
 * 为什么不设 TTL（"不发明阈值"）：runner 是否可用**不会在进程生命周期内漂移**（装 bwrap 要重装系统级软件、
 * 内核开关要重启），给它编一个"60 秒过期"只会让运行期平白多出几次子进程；需要重探时有三条明路——
 * 进程重启 / `await probe({force:true})` / `resetProbeCache()`。
 */
let cache = null;
let firstProbeSource = null;
let inFlight = null; // 进行中的探测（同一个进程内只发一次；并发调用者共享它）

/**
 * 探测（**异步**；默认走缓存）。这是全流程唯一的"真探"入口。
 *
 * 为什么必须异步（2026-09-16，`test/no-sync-subprocess.test.mjs` 的红线）：`execFileSync` 会冻住**整个
 *   Node 进程**——所有会话的 SSE、心跳、别的用户一起停摆，而探针跑在启动链上，那就是"平台起不来"的一种形态。
 * 异步带来的一个**新的、必须如实处置**的状态：探测还没回来。三条规矩：
 *   ① `readProbe()` 在探测未就绪时返回"未探测"（`probed:false`），永远**不假装**；
 *   ② `confine()` 在未就绪时**不许猜**：严格模式抛（fail-closed），迁移期按"未隔离"如实放行并标注"探测未就绪"
 *      （见 `server/sandbox/index.js`）；
 *   ③ `await probe()` 只等一次（共享同一个 in-flight promise），并发调用不会各起一个探针进程。
 * @param {{force?:boolean, source?:string, platform?:string, env?:object, workspaceRoot?:string,
 *          timeoutMs?:number, runProbeFn?:Function, crossCheckFn?:Function}} o
 * @returns {Promise<object>}
 */
export function probe(o = {}) {
  if (cache && !o.force) return Promise.resolve(cache);
  if (inFlight && !o.force) return inFlight;
  if (!firstProbeSource) firstProbeSource = o.source || 'first-call';
  const t0 = Date.now();
  const p = probeCandidates({
    platform: o.platform || process.platform,
    env: o.env || process.env,
    workspaceRoot: o.workspaceRoot || RW_WORKSPACE,
    timeoutMs: o.timeoutMs || PROBE_TIMEOUT_MS,
    runProbeFn: o.runProbeFn || runProbe,
    crossCheckFn: o.crossCheckFn,
  }).then((r) => {
    cache = {
      probed: true,
      platform: r.platform,
      ok: !!r.runner,
      runner: r.runner,
      candidates: r.candidates,
      unavailableReason: r.unavailableReason,
      modeForProbe: 'workspace-write',
      ms: Date.now() - t0,
      cache: 'process',
    };
    if (!cache.ok) {
      console.warn('[sandbox] 没有可用 runner：' + (cache.unavailableReason || '未说明')
        + '（enforcement 将如实上报 none；§4.6 显式降级：留痕 + 提高审批 + 客户可见）');
    }
    return cache;
  }).finally(() => { inFlight = null; });
  inFlight = p;
  return p;
}

/** 进行中的探测（没有就返回 null）。调用方据此区分"探测未就绪"与"真的没有 runner"。 */
export function probePending() { return inFlight; }

/** 只读缓存（**同步、零副作用、不起进程**）：探测过就给结果，没探过/还没探完就给"未探测"（见 report.js 的 UNPROBED）。 */
export function readProbe() { return cache || UNPROBED; }

/** 缓存状态（夹具断言"有界"与"谁触发的首次探测"用）。 */
export function probeCacheState() {
  return { cached: cache !== null, pending: inFlight !== null, ok: cache ? cache.ok : null, firstProbeSource, timeoutMs: PROBE_TIMEOUT_MS, cache: 'process' };
}

/** 清空缓存（下一次 `probe()` 会重新真探）。夹具与运维排查用。 */
export function resetProbeCache() { cache = null; firstProbeSource = null; inFlight = null; }

/**
 * 有没有可用沙箱（只读缓存：**不会**因为被问到就去起进程——这一点与 DSH 的择机探测一致）。
 * @param {{force?:boolean}} o force=true 才真探（返回 Promise）
 */
export function available(o = {}) { return !!(o.force ? probe(o) : readProbe()).ok; }

/**
 * 合成 §4.6/清单要的结果：四层 state + `enforcement` 三值。
 * 热路径专用（`capabilityManifest` / `capabilitySummary` 都走它）：**纯读缓存、同步、零副作用**。
 * @param {{permission?:string, root?:string, probeResult?:object}} ctx
 */
export function compose(ctx = {}) {
  return composeEnforcement({ permission: ctx.permission, root: ctx.root }, ctx.probeResult || readProbe());
}

// ---- 加载期预热：为什么要在模块加载时就发起探测 --------------------------------
// 问题：探测是异步的，而"第一次执行"（`confine()` 的首次调用）走的是请求路径——在那里等一次探测
//   （最长 PROBE_TIMEOUT_MS）同样不可接受；若把首次探测完全推迟到那时，`capabilities` 也就只能一直报
//   "未探测"，而 §4.6 要的是**逐次如实上报**（报"未探测"虽保守，但它不是结论）。
// 处置：**模块加载时就发起探测（不 await）**。代价是"起一个探针子进程"，且只发生在"确实要用沙箱的进程"里
//   （`capabilities.js` 是动态 import 本模块的，纯声明面/夹具不会被牵连）；收益是此后所有上报与
//   `confine()` 都拿到真结论。异步带来的"未就绪窗口"由上面三条规矩如实处置（不猜、不假装）。
// 关闭方式：`RW_SANDBOX_PROBE_AT_LOAD=0`（想让进程完全不起探针子进程时用；之后首次 `confine()`/`guard()` 会补探）。
/** 加载期预热的 promise（测试与启动链可 await 它；没预热就是 null）。 */
export let warmup = null;
if (String(process.env.RW_SANDBOX_PROBE_AT_LOAD ?? '1') !== '0') {
  warmup = probe({ source: 'module-load' }).catch((e) => {
    console.warn('[sandbox] 加载期探针异常（按不可用处理）：' + ((e && e.message) || e));
    return null;
  });
}
