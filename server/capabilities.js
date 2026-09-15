// server/capabilities.js - RA-31 能力清单 + OP-16 降级语义（enforcement 三值）2026-09-15
//
// 为什么要有这个模块：
//   《RW-Agent 架构 v1.1》§10 要求 agent 侧暴露四件东西：① 结束原因 ② 用量 ③ **用了哪些能力** ④ "自述不可信"这一前提。
//   ①②④ 早已在事件里，**③ 一直是空的**——验收矩阵 `RA-31` 因此记 🟡（"能力清单未成文暴露"）。
//   §7.2 还要求"降级后逐次如实上报 `enforcement: full | partial | none`"，而实现里这三个值**零命中**
//   （`OP-16` 挂着的正是这件事）。
//
// 本模块的立场：**这是声明，不是自夸**。一期没有沙箱，四层隔离里只有第 3 层真在工作，
//   所以整体只能如实报 `partial` —— 把"我们到底拦住了什么、没拦住什么"逐层写出来，
//   比给一个漂亮的 `full` 有用得多（§7.2：禁止静默降级）。
//
// 2026-09-16 增补（候选 D，《提示注入防线-方案-20260916》§3-D / §5）：新增一等字段 `promptInjection`。
//   此前清单里**根本没有"提示注入"这一项**，读清单的人（和用户）会以为四层就是全部风险面——那是自夸。
//
// 2026-09-16 增补（v0.3 §7.1 ⑰ 沙箱服务与分级）：**四层里第 2 层（引擎自带沙箱）的 state 从硬编码常量
//   改成探测结果**（符合性核对 §2.3 第 4 件），并新增一等字段 `sandbox` 暴露"哪个 runner、探没探、为什么不可用"。
//   · 探测在 `server/sandbox/`（runner 链 + 功能性探针 + 进程级有界缓存）；本模块**只读它的合成结果**，
//     且是**动态 import**——声明面不该把执行后端/DB 拖进依赖里（那是"清单模块被启动路径绑死"的老毛病）。
//   · 为什么是"读缓存"而不是"在这里探"：`enforcementReport` 被 index.js 在**每条 run_end** 上调三次，
//     在里面起子进程是不可接受的；探测一次、结论复用（界与出处见 `server/sandbox/probe-state.js`）。
//   · 取值纪律不变：`full` 只有真做到才写。本平台第 1 层（独立内核）未接入 ⇒ 第 2 层就算探针全过也只报
//     `partial`；拿不到 runner ⇒ `none`。夹具（test/sandbox.test.mjs）把这条钉住。
import { listHooks, hookPolicySummary } from './tools/hooks.js';
import { toolDefs } from './tools/index.js';
import { TOOL_META } from './tools/registry.js';

export const ENFORCEMENT_VALUES = ['full', 'partial', 'none'];

/**
 * 候选 D（2026-09-16 拍板）：提示注入的**如实声明**。
 *
 * 为什么是一等字段、而不是塞进 `enforcement.layers`：四层是 §7.2 定义的**隔离层**（少一层就是漏报），
 *   而"提示注入有没有防住"是另一件事——今天平台侧**没有任何**"按来源判定能不能当指令"的机制
 *   （方案 §4-2/§4-3 明确不做按来源加门禁）；硬塞会让 `layers.length===4` 与 §7.2 语义同时失真（方案 D7）。
 * 取值沿用 §7.2 的三值语义：`full | partial | none` —— 今天是 `none`（不是"没做全"，是"一条都没有"）。
 *   ⚠️ 没有防线就不得改口：把它写成 `partial`/`full` 必须同时带来一条**真机制** + 一条夹具（见 test/capabilities.test.mjs）。
 * 为什么必须进用户可见面：清单里没有它，读清单的人会以为四层就是全部风险面（RA-31 ④"自述不可信"的同一立意）。
 * ⚠️ 它**不进模型上下文**：这份清单只走 HTTP `/api/agent/capabilities` 与 run_end 事件（**给人看**）。
 *   这是诚实性声明，不是提示词——把它塞进系统提示是另一件事（会换纪元、也改变了权威面），本文件不做。
 */
export const PROMPT_INJECTION = {
  level: 'none',
  note: '提示注入未防住：外部内容（网页/飞书文档/MCP 返回/渠道消息）与用户输入一样以普通消息进上下文，平台不判定"哪条能当指令"；动作层只有 7 项受控工具审批（按工具名，不按来源）与占位符检疫（按内容形状）。',
};

/**
 * D3（OP-01）数据出口的**如实声明**（2026-09-16 加，与 `promptInjection` 同一立意：清单里没有这一项，
 * 读的人就会以为"数据面已经隔离好了"）。
 *
 * 平台自己的形态先说清：**这是工作台，不是多租户 SaaS** —— 一个账号里的会话可以读平台自己的库与文件，
 * 边界是**会话权限**（read/write/full）而不是行级租户隔离。所以这一项报 `partial` 而不是 `full`：
 *   · 注入层（把平台数据放进模型上下文的那几条通道）：**按账号过滤**——知识库走 kbVisibleWhere，
 *     错题召回走 recallLessons（2026-09-16 修：那条 SQL 原来没有账号过滤，全平台错题标题会注进任意会话），
 *     会话内数据（早期摘要/目标/现场/后台任务）都限定在本会话；
 *   · 工具出口：按**会话权限**放行；其中 `db_query` 是**全库只读**、不做行级账号隔离（read 权限即可用），
 *     这是工作台形态的有意选择，不是漏做——但它必须被写出来，不能被当成"已经隔离好了"。
 * 取值同样用 §7.2 的三值语义；改口（partial→full）必须同时带来一条真机制 + 一条夹具。
 * ⚠️ 与 `promptInjection` 一样**不进模型上下文**：只走 HTTP `/api/agent/capabilities` 与 run_end 事件（给人看）。
 */
export const DATA_EGRESS = {
  level: 'partial',
  injectedScope: 'account',
  toolScope: 'session-permission',
  note: '注入层按账号过滤（知识库/错题召回/会话内数据）；工具出口按会话权限放行，其中 db_query 是全库只读、'
    + '不做行级账号隔离——本平台是工作台形态（边界=会话权限），不是多租户隔离。',
};

/**
 * 四层隔离在本平台的真实状态（§7.2）。逐层给 state + 一句实话。
 *
 * **2026-09-16 起第 2 层不再是常量**（v0.3 §7.1 ⑰ / 符合性核对 §2.3 第 4 件）：它的 state 由
 * `server/sandbox/` 的**功能性探针**结论决定（有 runner ⇒ partial，拿不到 ⇒ none）。
 * 为了让"声明面"保持**纯**且不把执行后端拖进依赖：
 *   · 探测结果的读取走**动态 import**（只 import `server/sandbox/probe-state.js`，它只读缓存、不起进程）；
 *   · 拿不到（模块缺失/加载抛错）就退回"未探测"这一如实状态（第 2 层报 none），**不假装**探过；
 *   · 夹具要注入假探测结果时直接传 `ctx.sandbox`（探针三态都能在夹具里钉住，不依赖本机装没装 bwrap）。
 * @param {{permission?:string, root?:string, sandbox?:object}} ctx 沙箱态可注入：`ctx.sandbox` 优先于内部读取
 * @returns {{level:'full'|'partial'|'none', layers:Array<{id:number,name:string,state:string,note:string}>, sandbox:{enforcement:string, runner:string|null, probed:boolean}}}
 */
export function enforcementReport(ctx = {}) {
  const s = sandboxCompose(ctx);
  return { level: s.level, layers: s.layers, sandbox: { enforcement: s.enforcement, runner: s.runner, probed: s.probed } };
}

/**
 * 读沙箱合成结果（第 2 层 state + `enforcement` 三值的**唯一出处**）。
 * 动态 import 的理由见 `enforcementReport` 的注释；`ctx.sandbox` 是夹具/调用方的注入缝。
 * @returns {{level:string, layers:Array, enforcement:string, runner:string|null, probed:boolean}}
 */
function sandboxCompose(ctx = {}) {
  if (ctx.sandbox && Array.isArray(ctx.sandbox.layers)) return ctx.sandbox;   // 调用方直接给合成结果
  const mod = sandboxModule();                                                // 同步读已加载的模块（不起进程）
  // 只读缓存 + 纯合成，热路径安全（`compose` 存在性也要判：声明面不许因为一个缝坏了就整条报错）
  if (mod && typeof mod.compose === 'function') return mod.compose({ permission: ctx.permission, root: ctx.root });
  // 沙箱模块还没加载好（首次调用）：**如实**按"未探测"上报，并触发一次加载——加载完成后本模块即吃到真探测结果。
  // 注：用同步读取而不是 await —— 见下方 sandboxModule() 的说明（异步探测在下一次调用时生效，仍如实报 none）。
  loadSandbox();
  return {
    level: 'partial',
    enforcement: 'none',
    runner: null,
    probed: false,
    layers: [
      { id: 1, name: '环境隔离（gVisor / microVM）', state: 'none', note: '一期未接入；属 M2 硬门禁（OP-07）' },
      { id: 2, name: '引擎自带沙箱（按平台 runner 链 + 功能探针）', state: 'none', note: '探测结果尚未就绪（此轮按"没有"上报，不假装有沙箱）' },
      {
        id: 3, name: '工具层围栏（文件与 shell 同根 + 命令策略先于执行）',
        state: (ctx.permission || 'full') === 'full' ? 'partial' : 'full',
        note: (ctx.permission || 'full') === 'full'
          ? '本会话权限=full：围栏的"根"就是整台机器，因此只对危险命令模式（danger_command_guard，fail-closed）有效'
          : '权限只允许访问 ' + String(ctx.root || '工作区') + '：limitPath 同根 + danger_command_guard（fail-closed）',
      },
      { id: 4, name: '网络出口（默认全断 + 白名单代理）', state: 'none', note: 'run_command / fetch_url / web_search 均可直连外网；未做出口白名单' },
    ],
  };
}

// ---- 沙箱模块的**动态加载**缝（唯一目的：让声明面不依赖执行后端；见 enforcementReport 注释）----
//
// 为什么不是顶层 `import`：`server/sandbox/` 会（经由 backends/）读 env.js 与执行后端事实，
//   而 capabilities.js 被 http/agent/夹具到处 import——顶层 import 会把"探测沙箱"变成**加载即发生**的副作用，
//   连不认识沙箱的夹具也会被牵连。动态 import 把这件事压到"第一次真要报告能力时"。
// 为什么是同步读：`enforcementReport` 是同步函数（index.js 的三处 run_end 都同步用），不能 await。
//   `import()` 是异步的 ⇒ 第一次调用只能拿到"未探测"（如实报 none），加载完成后的下一次调用就吃到真结果。
//   这不是妥协的假象：探测结果本身有进程级缓存，所以"第一次之后的每一次"都是同一个真结论。
//
// ⚠️ 这里踩过一个坑，写下来防回归：**别用"只在 __sandboxMod === undefined 时才 import"这种写法**——
//   `import()` 是异步的，第一次调用发出请求后立即返回，第二次调用看到的仍是 undefined，于是**反复发请求**；
//   而 `probe-state` 的探测缓存只在"真正执行到 probe()"时才会被填上。正确做法是**记住那个 promise**：
//   无论调用多少次，都只加载一次，加载完成后所有调用读同一个模块实例。
let __sandboxMod = null;       // 就绪后的模块命名空间；null=未就绪（加载中或加载失败）
let __sandboxLoadError = null; // 加载失败的原因（只记一次，不反复重试、不刷日志）
let __sandboxLoading = null;   // 进行中的加载 promise（同一个进程内只发一次 import）
function sandboxModule() { return __sandboxMod; }
function loadSandbox() {
  if (__sandboxLoading) return __sandboxLoading;
  if (__sandboxMod || __sandboxLoadError) return null; // 已就绪 / 已失败：都不再重发
  __sandboxLoading = import('./sandbox/probe-state.js')
    .then((m) => { __sandboxMod = m; return m; })
    .catch((e) => {
      __sandboxLoadError = e;
      console.warn('[capabilities] 沙箱模块加载失败，第 2 层按"未接入"上报（不假装有沙箱）：' + ((e && e.message) || e));
      return null;
    });
  return __sandboxLoading;
}

/** 夹具用：复位沙箱模块加载缝（让"首次调用"路径可被重复断言）。 */
export function __resetSandboxLoader() { __sandboxMod = null; __sandboxLoadError = null; __sandboxLoading = null; }

/**
 * OP-16：显式降级 / 断网降级的**用户可见语义**目录（代码名词 ↔ 实际文案 ↔ 出口）。
 * 每一条都对应实现里真实存在的一条降级路径；新增降级必须在此登记，否则 UI 无从显示。
 */
export const DEGRADE_CATALOG = [
  { code: 'spill-degraded', when: '大结果存盘失败', visible: '「⚠️ 全文未能存盘…已按内联截断降级」', where: 'tool result' },
  { code: 'subagent-degraded', when: '子代理失败/超时', visible: '「该块未取得」+ degraded:true', where: 'tool result / 父交付物' },
  { code: 'tool-face-shrunk', when: '子代理白名单 or 壳 schema 收窄', visible: '工具清单变短（执行层同口径拒绝）', where: 'capabilities.tools' },
  { code: 'model-window-unknown', when: '未知模型窗口', visible: '「窗口未知，回退绝对阈值 30000」', where: 'journalctl / 折叠诊断' },
  { code: 'guard-halt', when: '预算/轮次/时间护栏触发', visible: '「（达到 N 轮护栏上限，任务已挂起…）」', where: 'assistant 正文 + run_end.guard' },
  { code: 'approval-queued', when: '无人值守下需要授权', visible: '「【无人值守】该操作需要你授权，已排队」', where: 'tool result' },
  { code: 'network-none', when: '断网/无外网（客户形态）', visible: '联网工具失败并如实报错（不假装成功）', where: 'tool result' },
  // v0.3 §4.6 / §7.1 ⑰：沙箱降级是**显式降级**的一种，必须进这本目录（"客户可见"靠它 + enforcement 上报）。
  { code: 'sandbox-degraded', when: '沙箱 runner 不可用（没装 bwrap / 没配部署方 runner / 探针不通过）', visible: '「⚠️ 本机没有可用的沙箱 runner：命令按未隔离执行，enforcement=none」+ 提高审批', where: 'capabilities.sandbox / run_end.capabilities.enforcement / audit_log(sandbox:degrade)' },
  { code: 'sandbox-refused-startup', when: 'RW_SANDBOX_REQUIRED=1（严格）且拿不到沙箱模式', visible: '启动被拒绝（v0.3 §4.6 字面语义：第 2 层拿不到模式 → 拒绝启动）', where: 'stderr + audit_log(sandbox:degrade)' },
];

/**
 * RA-31 能力清单：把"这个会话里的 agent 能做什么、受什么约束、降级时会怎样"一次说清。
 * @param {object} ctx runAgent 的 ctx（permission/preset/root/shellId 等）
 * @param {object} extra { guards, tools } 由调用方补充（护栏现值、已暴露工具名）
 */
export function capabilityManifest(ctx = {}, extra = {}) {
  const enforcement = enforcementReport(ctx);
  let names = Array.isArray(extra.tools) ? extra.tools : null;
  if (!names) {
    try { names = toolDefs(ctx.preset || 'all', null, null).map((d) => d.function.name); } catch { names = []; }
  }
  const tiers = { core: 0, pro: 0, expert: 0, unknown: 0 };
  for (const n of names) {
    const t = TOOL_META[n] && TOOL_META[n].tier;
    tiers[t && tiers[t] !== undefined ? t : 'unknown']++;
  }
  const hooks = hookPolicySummary();
  return {
    version: 1,
    enforcement,
    // v0.3 §4.6 / §7.1 ⑰：沙箱这一维的**如实暴露**（第 2 层由探测结果驱动；4.6 要的逐次上报值在这里
    // 也随清单一起对客户可见——"哪个 runner、探没探过、为什么不可用"都能直接读出来，不用猜）。
    sandbox: {
      ...enforcement.sandbox,
      source: 'server/sandbox/（runner 链：Linux bwrap → unshare；Windows 仅部署方 runner）',
    },
    promptInjection: PROMPT_INJECTION, // 候选 D：用户可见的诚实性字段（不进模型上下文）
    dataEgress: DATA_EGRESS, // D3/OP-01：数据出口的边界同样如实写出来（同样不进模型上下文）
    session: {
      permission: ctx.permission || 'full',
      preset: ctx.preset || 'all',
      mode: ctx.mode || 'chat',
      root: ctx.root || null,
      shellId: ctx.shellId ?? null,
      light: !!ctx.__light,
    },
    tools: { total: names.length, tiers, names: names.slice(0, 200) },
    hooks: { ...hooks, list: listHooks().map((h) => ({ name: h.name, side: h.side, tool: h.tool, failure: h.failure })) },
    guards: extra.guards || null,
    degrade: DEGRADE_CATALOG,
    honesty: {
      selfReportUntrusted: true, // §10 ④：模型自述一律不可信，最终状态以文件系统/git/DB 实时查询为准
      autoVerifyOwnerOpen: 'OP-02：自动验证"谁读业务数据"未处置，诚实性机制当前只能部分生效',
    },
  };
}

/** 事件流里用的紧凑版（RA-31：run_end 带"用了哪些能力"，但不要把整个清单塞进每一条事件）。 */
export function capabilitySummary(ctx = {}, used = []) {
  const e = enforcementReport(ctx);
  // 候选 D：run_end 同样要带诚实性字段（D8 拍板=进用户可见面）。只带取值，不带那句实话——紧凑版要小。
  return { enforcement: e.level, promptInjection: PROMPT_INJECTION.level, layers: e.layers.filter((l) => l.state !== 'full').map((l) => l.id + ':' + l.state), used: [...new Set(used || [])].slice(0, 40) };
}
