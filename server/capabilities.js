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
import { listHooks, hookPolicySummary } from './tools/hooks.js';
import { toolDefs } from './tools/index.js';
import { TOOL_META } from './tools/registry.js';

export const ENFORCEMENT_VALUES = ['full', 'partial', 'none'];

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
  return { enforcement: e.level, layers: e.layers.filter((l) => l.state !== 'full').map((l) => l.id + ':' + l.state), used: [...new Set(used || [])].slice(0, 40) };
}
