// server/sandbox/report.js - 把**探测结果**翻译成 §4.6/OP-16 的两样东西：四层 state + `enforcement` 三值
//
// 为什么要单独一个文件（不是为了拆而拆）：
//   · `server/capabilities.js` 是**声明面**（给人看的清单 + 逐次事件上报），它是纯的、不碰进程；
//     而"探测"要起进程、要读环境。两者混在一起，`enforcementReport()` 就从纯函数变成有副作用的函数，
//     而它被 index.js 在每条 run_end 上调用三次——那意味着每条上报都可能多起一个进程。
//   · DSH 的分工也正是这样（`dsh-sandbox`＝接口/类型、`dsh-sandbox-local`＝探测与实现、
//     消费者各自报结果）。本文件＝**纯格式化器**（零 import、零副作用），探测在 backends/、缓存在 index.js。
//
// 依据：v0.3 §4.6 沙箱那一行（失败语义 + `enforcement: full/partial/none` 逐次上报）、
//      《v0.3-符合性核对-20260916》§2.3 第 4 件（`enforcementReport` 由硬编码常量改成探测结果）。
export const ENFORCEMENT_VALUES = Object.freeze(['full', 'partial', 'none']);

/**
 * 第 1/4 层的**现状**（两处都尚未接入，如实写 'none'；它们是 §7.1 的 ⑰ 之外的事项，
 * 不在本轮范围里，但**必须逐层出现在清单里**——少一层就是漏报）。
 * 第 3 层（工具层围栏）由 `permission` 推导，不在本表。
 */
export const STATIC_LAYERS = Object.freeze({
  1: { name: '环境隔离（gVisor / microVM）', state: 'none', note: '一期未接入；属 M2 硬门禁（OP-07）' },
  4: { name: '网络出口（默认全断 + 白名单代理）', state: 'none', note: 'run_command / fetch_url / web_search 均可直连外网；未做出口白名单' },
});

/** 探测结果为空时的**如实**兜底：没探过 ≠ 没有沙箱，但也绝不等于有。 */
export const UNPROBED = Object.freeze({ probed: false, ok: false, runner: null, enforcement: 'none', reason: '未探测（没有拿到沙箱探测结果）' });

/**
 * 探测结果 → `enforcement` 三值（§4.6 的 `full/partial/none`）。
 *
 * ⚠️ 这里最要紧的一条：**`full` 在本平台是够不到的**（不是"暂时没做到"，是这一轮的判据使然）：
 *   · 我们唯一的真隔离来源是 `bwrap` / `unshare` / 部署方助手命令，它们给的是**同一内核**的挂载/令牌级隔离；
 *     §4.6 的第 1 层（独立内核）未接入 ⇒ 第 2 层就算 100% 工作，整体也不是 full。
 *   · 所以 runner 探测通过 ⇒ `partial`（真隔离 + 已留痕 + 已上报），探测不通过 ⇒ `none`（显式降级）。
 *   · 想让这里出现 `full`，必须**同时**满足：第 2 层有 runner **且**第 1/3/4 层都到位
 *     （第 3 层要求权限档不是 full；第 1/4 层要真接入）。在那之前报 full 就是自夸，夹具会报红。
 * @param {{probed?:boolean, ok?:boolean, runner?:object|null, enforcement?:string}} probe
 * @returns {'full'|'partial'|'none'}
 */
export function enforcementOf(probe = UNPROBED) {
  if (probe && probe.ok && probe.runner) return 'partial';
  return 'none';
}

/**
 * 探测结果 → §7.2 的四层逐层状态。
 * 第 2 层的 state 从**常量改成探测结果**（符合性核对 §2.3 第 4 件）：有 runner ⇒ `partial`
 * （同一个内核，如实不报 full），没 runner ⇒ `none`。
 * @param {{permission?:string, root?:string}} ctx
 * @param {object} probe backends/index.js 的 probeCandidates 结果（或夹具注入的假结果）
 * @param {string} level enforcementOf(probe) 的结果
 * @returns {Array<{id:number,name:string,state:string,note:string}>}
 */
export function layersOf(ctx = {}, probe = UNPROBED, level = enforcementOf(probe)) {
  const perm = ctx.permission || 'full';
  const probed = probe && probe.probed !== false;
  const ok = !!(probe && probe.ok && probe.runner);
  const runnerId = ok ? String(probe.runner.id) : null;
  return [
    { id: 1, ...STATIC_LAYERS[1] },
    {
      id: 2,
      name: '引擎自带沙箱（按平台 runner 链 + 功能探针）',
      state: ok ? 'partial' : 'none',
      note: ok
        ? 'runner=' + runnerId + '（' + probe.runner.enforcement + '）：功能性探针通过（真起一次，验证了工作区外写入被拒），'
          + '同内核的挂载/令牌级隔离——第 1 层未接入，故如实报 partial'
        : (probed ? ('不可用：' + String(probe.unavailableReason || probe.reason || '没有可用 runner'))
          : '未探测（没有拿到沙箱探测结果，按"没有"上报）'),
    },
    {
      id: 3,
      name: '工具层围栏（文件与 shell 同根 + 命令策略先于执行）',
      state: perm === 'full' ? 'partial' : 'full',
      note: perm === 'full'
        ? '本会话权限=full：围栏的"根"就是整台机器，因此只对危险命令模式（danger_command_guard，fail-closed）有效'
        : '权限只允许访问 ' + String(ctx.root || '工作区') + '：limitPath 同根 + danger_command_guard（fail-closed）',
    },
    { id: 4, ...STATIC_LAYERS[4] },
  ];
}

/**
 * 四层 → 整体档（与改造前的合成口径**一致**，只是输入从常量变成探测结果）：
 * 有任何一层不是 full ⇒ 整体 partial；全部 full ⇒ full。
 * 为什么 `none` 不会从四层里"消失"：整体档只说"能不能说 full"，**逐层的 none 才是给人看的**——
 * 所以 `capabilitySummary` 仍然把 `id:state` 非 full 的层全部带出去（改造前就是这么做的）。
 * @param {Array<{state:string}>} layers
 * @returns {'full'|'partial'|'none'}
 */
export function levelOf(layers) {
  if (layers.some((l) => l.state === 'none')) return 'partial';
  if (layers.some((l) => l.state === 'partial')) return 'partial';
  return 'full';
}

/**
 * 一次性产出清单需要的两段（清单与逐次上报用同一份判据，避免两处口径漂移）。
 * @returns {{level:'full'|'partial'|'none', layers:Array, enforcement:string, probed:boolean, runner:string|null}}
 */
export function composeEnforcement(ctx = {}, probe = UNPROBED) {
  const enforcement = enforcementOf(probe);
  const layers = layersOf(ctx, probe, enforcement);
  return {
    level: levelOf(layers),
    layers,
    enforcement,                                   // §4.6 的逐次上报值（沙箱这一维）
    probed: !!(probe && probe.probed !== false),
    runner: probe && probe.ok && probe.runner ? String(probe.runner.id) : null,
  };
}

/**
 * 供夹具/调用方构造一个假探测结果（**只造数据，不碰进程**）。
 * @param {{ok?:boolean, runner?:string, enforcement?:string, reason?:string, candidates?:Array, platform?:string}} o
 */
export function fakeProbe(o = {}) {
  const ok = !!o.ok;
  return {
    probed: o.probed !== false,
    // platform 必须带（夹具默认 linux）：`confine()` 要按**探测时那个平台**的候选链去找 runner，
    // 否则在 Windows 开发机上跑 Linux 链的 argv 断言会找不到候选（那不是被测代码的错，是夹具缺了上下文）。
    platform: o.platform || 'linux',
    ok,
    runner: ok ? { id: o.runner || 'fake-runner', kind: o.runner || 'fake-runner', enforcement: o.enforcement || 'partial', detail: '假 runner（夹具）' } : null,
    candidates: o.candidates || [],
    unavailableReason: ok ? null : (o.reason || '夹具注入：没有可用 runner'),
  };
}
