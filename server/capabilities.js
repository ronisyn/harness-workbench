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
 * @returns {{level:'full'|'partial'|'none', layers:Array<{id:number,name:string,state:string,note:string}>}}
 */
export function enforcementReport(ctx = {}) {
  const perm = ctx.permission || 'full';
  const layers = [
    { id: 1, name: '环境隔离（gVisor / microVM）', state: 'none', note: '一期未接入；属 M2 硬门禁（OP-07）' },
    { id: 2, name: '引擎自带沙箱', state: 'none', note: '本平台不驱动外部引擎，工具直接在其宿主上执行' },
    {
      id: 3, name: '工具层围栏（文件与 shell 同根 + 命令策略先于执行）',
      state: perm === 'full' ? 'partial' : 'full',
      note: perm === 'full'
        ? '本会话权限=full：围栏的"根"就是整台机器，因此只对危险命令模式（danger_command_guard，fail-closed）有效'
        : '权限只允许访问 ' + String(ctx.root || '工作区') + '：limitPath 同根 + danger_command_guard（fail-closed）',
    },
    { id: 4, name: '网络出口（默认全断 + 白名单代理）', state: 'none', note: 'run_command / fetch_url / web_search 均可直连外网；未做出口白名单' },
  ];
  const hasNone = layers.some((l) => l.state === 'none');
  const hasPartial = layers.some((l) => l.state === 'partial');
  const level = hasNone || hasPartial ? 'partial' : 'full';
  return { level, layers };
}

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
