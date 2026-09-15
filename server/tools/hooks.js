// server/tools/hooks.js - P1-1 hooks 事件系统（借鉴 Claude Code PreToolUse / PostToolUse 事件钩子）
// 目的：把"工具使用纪律/安全网"从平台静态门禁（preset/启用集/权限）升级为可动态注册的钩子——
//   - before：工具执行【前】触发。钩子可拦截（返回 {stop:true, reason}）或改写参数（返回 {args:{...patch}}，浅合并进执行参数）
//   - after：工具执行【后】触发（观察/审计用；返回 stop 仅记录在 result，不撤销已完成执行）
//
// ── OP-03 策略引擎失败语义（2026-09-15 补齐）─────────────────────────────────────────────
// 旧实现的问题：**失败语义靠一个隐式默认**（`builtin && failClosed` 才拦，其余抛错一律 warn 放过），
//   架构 §15 的 `OP-03` 因此一直挂着"缺失"。现在改成三条硬规则：
//   ① **注册时必须显式声明** `failure: 'closed' | 'open'`（不声明直接抛错）—— 语义从"默认值"变成"契约"；
//   ② **超时按同一语义处置**：钩子挂起会卡住工具（旧实现没有超时，一个死循环钩子能冻住整轮），
//      现在每个钩子有 `timeoutMs`（默认 2000）；超时与抛错走同一条 failure 分支；
//   ③ **失败必留痕**：抛错/超时落 `audit_log`（`hook:error` / `hook:timeout`），失败不再是"日志里一行 warn"。
//   另：改写参数时记录改写前后（`emitHooks` 返回 `rewrites`），由 execTool 落 `hook:rewrite` 账本——
//   此前"日志记的是改写前还是改写后"没有答案，现在两个都记。
//
// 内置钩子（模块加载即注册，平台级强制纪律）：
//   1. danger_command_guard（before run_command）—— 破坏性命令（删根/fork bomb/写盘/关机等）fail-closed 拦截
//   2. system_write_guard（before 写类工具）—— 写系统关键区（/etc /boot /usr/bin 等）fail-closed 拦截
//   3. preset_tier_guard（before *）—— preset 暴露面（minimal/standard 调 core/pro 级外工具 → 指引）
//   4. enabled_tools_guard（before *）—— 账号工具启用集未含且非平台豁免 → 指引（可恢复：设置→工具 勾选）
//   5. readonly_intent_guard（before 改动类）—— 请求级只读规划意图（P4）时禁改动工具
//   6. shell_readonly_guard（before run_command）—— 读型命令（cat/ls/grep/…）引导用专门工具
// P2（2026-09 批2）：3/4/5/6 为"纪律统一层"——从 execTool 内联门禁迁来，纪律集中一处可 listHooks 审计、可动态调整。
// 平台扩展：server/index.js 等可 import { registerHook } 追加纪律钩子；模型侧用 hooks_list 工具查看（只读）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TOOL_META, PLATFORM_EXEMPT } from './registry.js';
import { db } from '../db.js';
const execFileAsync = promisify(execFile);
const registry = [];
const MAX_HOOKS = 128;
const DEFAULT_TIMEOUT_MS = 2000;
const FAILURE_MODES = ['closed', 'open'];

// 注册钩子。side='before'|'after'；tool=具体工具名或 '*'（全部工具）。
// opts.failure **必填**：'closed'=出事（抛错/超时）就拦，'open'=出事就放行（并 warn + 留痕）。
// opts.timeoutMs 默认 2000；opts.rewritesArgs 声明"本钩子可能改写参数"（供审计口径核对）。
export function registerHook(side, tool, name, fn, opts = {}) {
  if (!['before', 'after'].includes(side)) throw new Error('hook side 非法: ' + side);
  if (typeof fn !== 'function') throw new Error('hook fn 必须是函数');
  if (registry.length >= MAX_HOOKS) throw new Error('hooks 注册超上限 ' + MAX_HOOKS);
  // OP-03 规则①：失败语义必须显式声明。兼容旧的 failClosed 布尔（老调用方），但两者都没有就拒绝注册。
  let failure = opts.failure;
  if (!failure && opts.failClosed !== undefined) failure = opts.failClosed ? 'closed' : 'open';
  if (!FAILURE_MODES.includes(failure)) {
    throw new Error(`hook ${name} 必须显式声明失败语义 opts.failure='closed'|'open'（OP-03：语义不能靠隐式默认）`);
  }
  const h = {
    side, tool: tool || '*', name, fn, builtin: !!opts.builtin,
    failure, timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS,
    rewritesArgs: !!opts.rewritesArgs,
  };
  registry.push(h);
  return { side: h.side, tool: h.tool, name: h.name, builtin: h.builtin, failure: h.failure };
}

// 查看已注册钩子（hooks_list 工具用；含失败语义——"出事时是拦还是放"必须可审计）
export function listHooks() {
  return registry.map((h) => ({
    side: h.side, tool: h.tool, name: h.name, builtin: h.builtin,
    failure: h.failure, timeoutMs: h.timeoutMs, rewritesArgs: h.rewritesArgs,
  }));
}

// OP-03 启动自检：每个钩子的失败语义必须可判定（数量对账 + 取值合法）。返回 {n, closed, open, bad[]}
export function hookPolicySummary() {
  const bad = registry.filter((h) => !FAILURE_MODES.includes(h.failure)).map((h) => h.name);
  return {
    n: registry.length,
    closed: registry.filter((h) => h.failure === 'closed').length,
    open: registry.filter((h) => h.failure === 'open').length,
    rewriters: registry.filter((h) => h.rewritesArgs).map((h) => h.name),
    bad,
  };
}

// 移除钩子（平台配置/管理用；side/tool/name 可部分省略做通配）
export function clearHook(side, tool, name) {
  const i = registry.findIndex(
    (h) => (!side || h.side === side) && (!tool || h.tool === tool) && (!name || h.name === name)
  );
  if (i < 0) return false;
  registry.splice(i, 1);
  return true;
}

// 钩子失败留痕（OP-03 规则③）：不阻断主流程，失败必须可事后查到。
function logHookFailure(h, kind, reason) {
  try {
    db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)',
      [null, 'hook:' + kind, `hook=${h.name} side=${h.side} tool=${h.tool} failure=${h.failure} ${String(reason).slice(0, 200)}`]).catch(() => {});
  } catch { /* 留痕失败不影响主流程 */ }
}

// 触发某 side+工具名的全部钩子。payload 传入 {args, ctx}；钩子可改 payload.args（浅合并语义）。
// 返回 { stopped, reason?, by?, allowed?, rewrites?:[{by,asked,used}] }
//   · 某钩子 stop 后不再执行后续钩子；
//   · allow 短路（P6 规则层）：返回 {allow:true} 则跳过其余钩子并标记 allowed；
//   · rewrites：本 side 内发生过的参数改写（调用方据此落 `hook:rewrite` 账本）。
export async function emitHooks(side, tool, payload) {
  // P2：把当前工具名注入 payload.ctx.__toolName，供 '*' 纪律钩子（preset/启用集等）按名判定
  if (payload && payload.ctx && typeof payload.ctx === 'object') payload.ctx.__toolName = tool;
  const rewrites = [];
  for (const h of registry) {
    if (h.side !== side) continue;
    if (h.tool !== tool && h.tool !== '*') continue;
    let r = null;
    let timer = null;
    try {
      // OP-03 规则②：钩子必须有超时——旧实现没有超时，一个挂起的钩子能冻住整轮工具调用。
      r = (await Promise.race([
        Promise.resolve().then(() => h.fn(payload)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('hook timeout ' + h.timeoutMs + 'ms')), h.timeoutMs); }),
      ])) || {};
    } catch (e) {
      const isTimeout = /^hook timeout /.test(String((e && e.message) || ''));
      const msg = (e && e.message ? e.message : String(e));
      logHookFailure(h, isTimeout ? 'timeout' : 'error', msg);
      if (h.failure === 'closed') {
        return { stopped: true, reason: '钩子 ' + h.name + (isTimeout ? ' 超时' : ' 异常') + '，按其声明的 fail-closed 语义拦截：' + msg, by: h.name, rewrites };
      }
      console.warn('[hooks] ' + side + ':' + tool + ' 钩子 ' + h.name + (isTimeout ? ' 超时' : ' 抛错') + '已按 fail-open 放行: ' + msg);
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (r.allow) return { stopped: false, allowed: true, by: h.name, rewrites }; // P6 allow 短路
    if (r.stop) return { stopped: true, reason: r.reason || h.name, by: h.name, rewrites };
    if (r.args && typeof r.args === 'object') {
      const asked = { ...(payload.args || {}) };
      payload.args = { ...(payload.args || {}), ...r.args };
      rewrites.push({ by: h.name, asked, used: { ...payload.args } });
    }
  }
  return { stopped: false, rewrites };
}

// ---------------------------------------------------------------------------
// P6 allow/deny 规则层（2026-09 批2）：管理员级规则（settings access_rules，由 index.js 读入 ctx.__accessRules）
// 语义：deny 命中 → 无条件拦截；allow 命中 → 短路跳过后续纪律钩子并标记 allowed（调用方免 guard 审批）。
// 规则顺序=数组序，先匹配先生效；无规则命中 → 走常规纪律/审批。规则格式：
//   { id, pattern: 工具名正则, argPattern?: 参数 JSON 正则(可空), action: 'allow'|'deny', why }
// 本钩子最先注册（registry 序），deny 在 allow 前判定——管理员 deny 永远优先于 allow。
// **失败语义 = open**（显式声明，OP-03）：它挂 `before '*'`，一旦 fail-closed，任何一次正则异常都会
//   让**整个工具面停摆**；而平台真正的硬门禁是权限层 + 受控工具审批，本钩子是管理员便利层。
//   "放行不等于不声张"：异常已由 emitHooks 落 `hook:error` 账本（OP-03 规则③）。
// ---------------------------------------------------------------------------
registerHook('before', '*', 'access_rules_guard', ({ args, ctx }) => {
  const name = ctx?.__toolName;
  const rules = ctx?.__accessRules;
  if (!name || !Array.isArray(rules) || !rules.length) return {};
  let denied = null;
  for (const r of rules) {
    if (!r || !r.pattern) continue;
    let m = null;
    try { m = new RegExp(r.pattern).test(name); } catch { continue; }
    if (!m) continue;
    if (r.argPattern) {
      let hit = false;
      try { hit = new RegExp(r.argPattern).test(JSON.stringify(args || {})); } catch { hit = false; }
      if (!hit) continue;
    }
    if (r.action === 'deny') { denied = r; break; }
    if (r.action === 'allow') {
      // 该规则显式放行此工具（+参数）：短路后续纪律钩子；调用方据 allowed 免 guard 审批
      return { allow: true, ruleId: r.id, why: r.why || '' };
    }
  }
  if (denied) return { stop: true, reason: 'access 规则 deny（id=' + denied.id + '）：' + (denied.why || denied.pattern) + '。确需执行可 ask_user 请平台管理员调整规则' };
  return {};
}, { builtin: true, failure: 'open' });

// ---------------------------------------------------------------------------
// 内置纪律钩子（平台强制安全网，fail-closed）
// ---------------------------------------------------------------------------
const DANGER_PATTERNS = [
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~)(\s|$)/, why: 'rm -rf 直接删除根/家目录' },
  { re: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/\*\s*/, why: 'rm -rf /* 删除根下全部文件' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: 'fork 炸弹' },
  { re: /\bdd\s+[^|;&]*of=\/dev\/(sd|hd|vd|nvme)/, why: 'dd 直写块设备' },
  { re: /(^|[;&|])\s*>\s*\/dev\/(sd|hd|vd|nvme)/, why: '重定向写入块设备' },
  { re: /\bmkfs(\.\w+)?\s+\S*\/dev\//, why: '格式化磁盘分区' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/, why: '关机/重启/断电（影响平台服务器）' },
  { re: /\binit\s+[06]\s*($|[;&|])/, why: 'init 切换运行级（关机/重启）' },
  { re: /\bkill\s+-?9?\s+1\b/, why: 'kill 进程 1（系统核心）' },
  { re: /\bchmod\s+-R\s+777\s+(\/|~)/, why: '递归 chmod 777 根/家目录' },
];
registerHook('before', 'run_command', 'danger_command_guard', ({ args }) => {
  // O-4 修复（2026-09 批2）：run_command 实参键是 cmd（tools/index.js params），此前读 args.command → 从未触发
  const cmd = String((args && (args.cmd ?? args.command)) || '');
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(cmd)) {
      return { stop: true, reason: p.why + '（命中危险模式 ' + p.re + '）。请改用精确/受限目标重试；确需执行须 ask_user 请平台管理员确认' };
    }
  }
  return {};
}, { builtin: true, failure: 'closed' });

// O-5 修复（2026-09 批2）：写类守卫只挂【写类工具】（write_file/append_file/edit_file/copy_move/delete_file/mkdir），
// 不挂 '*'——此前 '*' 使 read_file 读 /etc 配置也被"写守卫"误拦（读不是写，无写入风险）。
// 路径判定不做 path.resolve（Windows 下会把 /etc 变 E:\etc 破坏匹配；服务器是 Linux，直接按原样正则判定，
// 同时把 \ 归一为 / 兜底）。工具实参可能是相对路径（工作区内）——相对路径不在系统区，直接放行。
const SYSTEM_WRITE_RE = /^\/(etc|boot|bin|sbin|dev|proc|sys|root)(\/|$)|^\/usr\/(bin|sbin|lib(64)?)(\/|$)/;
const WRITE_PATH_TOOLS = ['write_file', 'append_file', 'edit_file', 'copy_move', 'delete_file', 'mkdir'];
for (const w of WRITE_PATH_TOOLS) {
  registerHook('before', w, 'system_write_guard', ({ args }) => {
    // 写位置判定：write/edit/append/delete/mkdir 用 path；copy_move 目标是 dst（写点），src 仅读源不必拦
    let p = '';
    if (typeof args.path === 'string') p = args.path;
    else if (w === 'copy_move' && typeof args.dst === 'string') p = args.dst;
    else if (typeof args.src === 'string') p = args.src;
    if (!p) return {};
    const norm = p.replace(/\\/g, '/');
    if (norm.startsWith('/') && SYSTEM_WRITE_RE.test(norm)) {
      return { stop: true, reason: '写入系统关键区被纪律钩子拦截：' + p + '（平台代码/工作区文件可正常写；确需写系统文件请改用 run_command 并明确经用户确认）' };
    }
    return {};
  }, { builtin: true, failure: 'closed' });
}

// ---------------------------------------------------------------------------
// P2 纪律统一层（2026-09 批2）：从 execTool 内联门禁迁入的纪律钩子——
// 纪律集中一处（listHooks 可审计、可动态调整），execTool 只保留权限层（checkPerm/limitPath/审批）与安全网（占位符检疫/快照）。
// **失败语义一律 open**（显式声明，OP-03）：纪律是**引导**（拦的是"用错工具/越档调用"，不是危险动作），
// 钩子自身出问题时应放行并留痕，而不是把主流程一起拖停。真正 fail-closed 的只有上面两处安全网
// （danger_command_guard / system_write_guard）——"出事时是拦还是放"现在写在每一处注册上，不再是隐式默认。
// ---------------------------------------------------------------------------

// 3. preset 暴露面门禁（原 execTool 内联：非 all 会话调用未暴露层级 → 指引）
registerHook('before', '*', 'preset_tier_guard', ({ args, ctx }) => {
  const name = ctx?.__toolName;
  if (!name) return {};
  if (ctx.preset && ctx.preset !== 'all') {
    const allowT = ctx.preset === 'minimal' ? new Set(['core']) : ctx.preset === 'standard' ? new Set(['core', 'pro']) : null;
    const metaTier = TOOL_META[name]?.tier;
    if (allowT && metaTier && !allowT.has(metaTier)) {
      return { stop: true, reason: `工具 ${name}（${metaTier} 级）不在当前会话 preset=${ctx.preset} 的暴露范围。可 ask_user 请用户把 preset 切到 standard/all，或改用 core 级工具完成。` };
    }
  }
  return {};
}, { builtin: true, failure: 'open' });

// 4. 启用集门禁（原 execTool 内联：账号启用集未含且非平台豁免 → 指引）
registerHook('before', '*', 'enabled_tools_guard', ({ args, ctx }) => {
  const name = ctx?.__toolName;
  if (!name) return {};
  // P24(O-21)：MCP 工具（mcp_*）由管理员在 settings mcp_servers 配置信任（动态命名无法进静态启用集），豁免启用集门禁；
  // 但仍受权限(checkPerm write 级)/只读意图/审计约束（已并入 execTool 主通道）。
  if (name.startsWith('mcp_')) return {};
  if (ctx.__enabledTools && !ctx.__enabledTools.has(name) && !PLATFORM_EXEMPT.includes(name)) {
    return { stop: true, reason: `工具 ${name} 未在工具启用集内（默认 28 项）。可在 设置→工具 勾选启用后重试，或改用已启用工具完成。` };
  }
  return {};
}, { builtin: true, failure: 'open' });

// 5. 只读意图门禁（原 execTool 内联 P4：请求级只读规划时禁改动类工具）
const READONLY_MUTATING = new Set([
  'write_file', 'append_file', 'edit_file', 'delete_file', 'mkdir', 'copy_move', 'undo_checkpoint',
  'run_command', 'run_long_task', 'kill_process', 'db_write',
  'git_commit', 'git_pull_push', 'skill_save', 'set_limits', 'reload_platform',
  // P24(O-23) 只读意图清单补齐（间接副作用工具）：git_branch(checkout 切分支)/kb_del(删记忆)/create_contract(排程无人值守执行)/finish_task(触发业务区 auto-commit)
  'git_branch', 'kb_del', 'create_contract', 'finish_task',
]);
for (const m of READONLY_MUTATING) {
  registerHook('before', m, 'readonly_intent_guard', ({ args, ctx }) => {
    if (ctx?.__readonlyIntent) {
      return { stop: true, reason: '只读规划意图（本轮）：工具 ' + m + ' 已被禁用。规划阶段只用只读工具（read/list/grep/find/web/db_query）；把方案作为回答展示，等用户批准后再执行改动。' };
    }
    return {};
  }, { builtin: true, failure: 'open' });
}
// P24(O-21/O-23)：MCP 外部工具（动态命名）同样受只读意图约束——管理员信任 ≠ 只读轮可执行外部副作用
registerHook('before', '*', 'readonly_mcp_guard', ({ args, ctx }) => {
  const name = ctx?.__toolName;
  if (ctx?.__readonlyIntent && name && name.startsWith('mcp_')) {
    return { stop: true, reason: '只读规划意图（本轮）：MCP 外部工具 ' + name + ' 已被禁用。规划阶段只用只读工具；把方案作为回答展示，等用户批准后再执行。' };
  }
  return {};
}, { builtin: true, failure: 'open' });

// 6. 换目录规范化：把 `cd <简单目录> && 其余` 改写成 {cwd, cmd}（2026-09-15）
//
// 这条钩子的历史：原来叫 `shell_readonly_guard`，用一张黑名单（cat|ls|grep|find|sed|head|cd|echo）
// **拦下**读型 shell 命令，理由是"省 token"。2026-09-15 拍板**去掉黑名单**，只留换目录改写，依据三条：
//   ① DSH 全库没有任何"别用 shell，去用专门工具"的预拦钩子——它的边界是**沙箱**（真实能力边界），
//      省 token 靠**输出层**（spill/截断）；② 我们**已经有**同一套输出层机制（runCmd 8000 字符截断 +
//      spillToolResult 大结果落盘 + result_bytes 遥测），再用"拦掉一整轮"去做同一件事，是拿更差的手段
//      重复实现；③ 黑名单不是能力边界，是自己发明的风格规则——而"模型想用 shell"本身没有错。
// 保留意图但不花轮次：run_command 命中读型别名时在**结果里**附一行提示（模型照样看得见，不必重来一轮）。
// 换目录改写则保留：`cd X && …` 与 cwd=X 语义等价，改掉它比让模型重写一遍便宜得多（实测 14 天 40 次 cd 被拦）。
registerHook('before', 'run_command', 'shell_cd_normalizer', ({ args }) => {
  const cmdline = String((args && (args.cmd ?? args.command)) || '').trim();
  if (!args || args.cwd !== undefined) return {}; // 模型自己给了 cwd 就尊重它，不猜它想用哪个
  // 只认最保险的形态：cd 在开头、目录里没有 shell 元字符。猜不准的形态一律不动（照原样执行）。
  const m = /^cd\s+([A-Za-z0-9_./~-]+)\s*&&\s*(\S[\s\S]*)$/.exec(cmdline);
  if (!m) return {};
  const rest = m[2].trim();
  // 只处理**一层**：若剩下的还以 cd 开头（`cd a && cd b && …`），不改写——run_command 是 execFile 直调
  // （不过 shell），`cd` 是 shell 内建、不是可执行文件，改写后剩下的那个 cd 会在运行期 ENOENT。
  if (/^cd(\s|$)/.test(rest)) return {};
  return { args: { ...args, cwd: m[1], cmd: rest } };
}, { builtin: true, failure: 'open', rewritesArgs: true });

// A5 硬闸门（§8.6 关键流程技能）：开发需求采集必须走 intake 流程——
// 未在本会话载入对应 intake 技能（plugin-dev-intake/app-dev-intake/shell-intake）时拒绝 intake_submit，
// 引导先 skill_load 该技能完成字段采集（不猜口令词、不跳流程；动作层拦截）。
const INTAKE_SKILL_BY_TYPE = { plugin: 'plugin-dev-intake', app: 'app-dev-intake', shell: 'shell-intake' };
registerHook('before', 'intake_submit', 'intake_skill_guard', async ({ args, ctx }) => {
  const atype = args && args.assetType;
  const need = INTAKE_SKILL_BY_TYPE[atype];
  if (!need) return {};
  const loaded = new Set(Object.keys((ctx && ctx.skills) || {}));
  if (ctx && ctx.conversationId) {
    try {
      const rows = await db.query('SELECT skill_name FROM conv_skills WHERE conversation_id=?', [ctx.conversationId]);
      for (const r of rows) loaded.add(r.skill_name);
    } catch { /* DB 不可用时以 ctx.skills 为准 */ }
  }
  if (!loaded.has(need)) {
    return { stop: true, reason: `开发需求采集硬闸（§8.6）：intake_submit(${atype}) 前必须先载入流程技能 "${need}"（skill_load {name:"${need}"}）——它会逐项向你采集 触发场景/期望效果/涉及壳/代码动作类型，字段齐才允许立项，防跳过需求采集直接开发。` };
  }
  return {};
}, { builtin: true, failure: 'open' });

// ---------------------------------------------------------------------------
// G 域质量钩子（2026-09 批4）：after 型（观察/留痕，不阻断已执行）——
//   7. code_syntax_check（after write_file/edit_file）：改 .js/.mjs/.cjs 后自动 node --check，语法错误写入 result.hookNote
//   8. finish_selfcheck_note（after finish_task）：校验 summary 长度与 selfCheck 提示（留痕引导提测质量）
// after 型一律 failure: 'open'：**执行已经完成**，此时"拦"没有意义；且它们只写 `result.hookNote`，
//   hookNote 是附加上下文，按 §7.3 双投影接缝不得替换工具结果本身。
// ---------------------------------------------------------------------------
const CODE_EXT = /\.(js|mjs|cjs)$/;
// ⚠️ 2026-09-15 改异步：原实现用 `execFileSync` 跑 `node --check`（超时 8s）——**同步子进程会把整个
//   Node 进程冻住**，而它挂在 write_file/edit_file 的 after 上，也就是 **agent 写代码的必经之路**：
//   那一瞬间所有会话的 SSE 流、心跳、别的用户全部停摆。而且同步代码会堵住事件循环，
//   连 emitHooks 新加的 timeoutMs 都**没机会触发**（定时器要等同步调用返回才轮到）。
//   改成异步之后：不冻进程，且钩子超时真的能生效。内层 6000 < 钩子 8000，让"命令自己超时"优先。
const syntaxNote = async ({ args, result }) => {
  try {
    const p = String((args && args.path) || '');
    if (!CODE_EXT.test(p)) return {};
    await execFileAsync('node', ['--check', p], { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result && typeof result === 'object' && !Array.isArray(result)) result.hookNote = '语法检查通过（node --check）';
  } catch (e) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const msg = String((e && e.stderr) || (e && e.message) || e || '').split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 260);
      result.hookNote = '⚠️ 语法检查失败：' + msg + '（请修复后再提交）';
    }
  }
  return {};
};
registerHook('after', 'write_file', 'code_syntax_check', syntaxNote, { builtin: true, failure: 'open', timeoutMs: 8000 });
registerHook('after', 'edit_file', 'code_syntax_check', syntaxNote, { builtin: true, failure: 'open', timeoutMs: 8000 });

registerHook('after', 'finish_task', 'finish_selfcheck_note', ({ args, result }) => {
  try {
    const summary = String((args && args.summary) || '');
    const selfCheck = String((args && args.selfCheck) || '');
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      result.hookNote = summary.length < 10
        ? '⚠️ 完成总结过短（' + summary.length + ' 字），建议补充做了什么/结果/验证'
        : (!selfCheck ? '提示：建议附 selfCheck（对照验收标准自检）' : '自审信息完整');
    }
  } catch { /* 忽略 */ }
  return {};
}, { builtin: true, failure: 'open' });

// ---------------------------------------------------------------------------
// B-①② 策略写入的归属 + 单独可审计（2026-09-16 拍板 ·《提示注入防线-方案-20260916》§3-B / §5）
//
// 要解决的问题（P1）：`db_write` 是 global 级，而 write / full 会话**不弹审批**（审批只对 guard 档生效），
//   于是改 `settings` 里的策略键（access_rules / toolset_enabled / systemPrompt / mcp_servers …）与
//   "插一条业务数据"在账本里**完全同形**：都只有一条 `tool:db_write`，事后一眼看不出"这次改的是策略"。
//   本节把它变成**可识别 + 可归属 + 单独一行账**——**不拦截**。
// 为什么不做拦截（B-③ 已明确不做）：full 会话能 write_file 改平台源码 + reload_platform，拦 settings 挡不住
//   那条路，是安全剧场；平台真正的硬门禁是权限层 + guard 审批（那是"按动作"的，不可被上下文绕开）。
// 清单口径（一次定全，方案 §3-B / §6-D3）：settings 里的策略键 6 个 + 模型能改的"保险丝"键。
//   护栏键以 `server/settingsSchema.js` 的**实际键名**为准：方案里写的 `max_progress_stall_n` 不存在，
//   真名是 `progress_stall_n`；`max_parallel_tools` 方案没点名，但 `set_limits` 能写它（同一把保险丝），一并纳入。
// 边界（如实说，别当全覆盖）：识别点是**工具执行路径**（db_write 的 after 钩子）。
//   绕过工具直接改库（mysql CLI / 别的进程 / 其它写 settings 的代码）**不会被识别**——那需要库内机制
//   （settings 上的触发器）或对账，都超出了"最小改动"的范围，见交付报告的"需决策"一节。
//   本节的承诺只到："凡经平台工具改的策略键，都单独留下一行可定位的账。"
// ---------------------------------------------------------------------------
export const POLICY_SETTINGS_KEYS = [
  // settings 里的策略键（消费点：server/index.js 的 getSetting 调用，逐键有锚点，见 test/policy-write.test.mjs）
  'access_rules', 'systemPrompt', 'toolset_enabled', 'mcp_servers', 'task_budget_total', 'max_concurrent_chats',
  // 运行护栏键（`set_limits` 能写的那几个 + 无进展判据，都是同一类"保险丝"）
  'time_budget_min', 'round_cap', 'loop_guard', 'max_parallel_tools', 'progress_stall_n',
];

// 写 settings 的语句形态：只认三种"目标就是 settings"的写法。
// 为什么不直接搜 `settings` 字样：`INSERT INTO x SELECT … FROM settings` 是**读** settings，不该误判成策略写入。
const SETTINGS_WRITE_FORMS = [
  { kind: 'insert', re: /^\s*(?:insert|replace)\s+(?:ignore\s+)?into\s+`?settings`?(?![\w])/i },
  { kind: 'update', re: /^\s*update\s+`?settings`?(?![\w])/i },
  { kind: 'delete', re: /^\s*delete\s+from\s+`?settings`?(?![\w])/i },
];

/**
 * 从一条 SQL 认出"这是不是在改策略"（**纯函数**：不碰库、不看工具名、不依赖调用方是谁）。
 * 键名按**标识符边界**匹配，`my_round_cap_backup` 不会命中 `round_cap`。
 * 只认出现在语句里的策略键字面量——`db_write` 不带参数（`db.run(sql, undefined)`），所以键名必然在文本里。
 * @returns {{kind:'insert'|'update'|'delete', keys:string[]}|null} 非策略写入返回 null
 */
export function policyWriteOf(sql) {
  const s = String(sql || '');
  const form = SETTINGS_WRITE_FORMS.find((f) => f.re.test(s));
  if (!form) return null;
  const padded = ' ' + s + ' ';
  const keys = POLICY_SETTINGS_KEYS.filter((k) => new RegExp('[^A-Za-z0-9_]' + k + '[^A-Za-z0-9_]').test(padded));
  return keys.length ? { kind: form.kind, keys } : null; // 改 settings 但没碰策略键（temperature / prefix_epoch:… ）= 普通写入
}

/**
 * 策略写入的账本 detail（**纯函数**，便于夹具核对"谁改的 / 改前改后 / 都带了"）。
 * 截断到 1000 字符——与 `tool:<名>` 那行的既有口径一致。
 */
export function policyWriteDetail({ kind, keys, from, to, ctx = {}, result, sql, actor = 'model-via-tool', via = 'db_write' } = {}) {
  const cut = (v) => (v === undefined || v === null ? null : String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 160));
  const brief = (o) => Object.fromEntries((keys || []).map((k) => [k, cut(o && o[k])]));
  return JSON.stringify({
    // 「谁改的」：默认是"模型经工具"（能走到 execTool 那条路的只可能是模型——approval 只对 guard 档生效）。
    // 2026-09-16 起**人工路径也落同一条账**（C-29）：人经设置页改策略走 PUT /api/settings，
    // 那条路显式传 actor='human-via-api' / via='PUT /api/settings'，于是"策略变更"这件事
    // 无论谁发起都能一条 SQL 查全（此前人工改动没有任何账本行，C-28 的漂移检测因此不成立）。
    actor,
    via,
    kind, keys,
    from: brief(from), to: brief(to),
    affected: (result && result.affected) ?? null,
    by: { accountId: ctx.accountId ?? null, conversationId: ctx.conversationId ?? null, shellId: ctx.shellId ?? null },
    sql: String(sql || '').slice(0, 300),
  }).slice(0, 1000);
}

/** 读策略键的当前值（只读）。失败返回 null，由账本如实标成 `from:null`，不假装读到了。 */
async function readPolicyValues(keys) {
  try {
    const rows = await db.query('SELECT skey, svalue FROM settings WHERE skey IN (' + keys.map(() => '?').join(',') + ')', keys);
    return Object.fromEntries(rows.map((r) => [r.skey, r.svalue]));
  } catch { return null; }
}

// 改**前**的值只能在写之前读：before 阶段读一次，留在 ctx 上（before 与 after 拿到的是同一个 eff 对象）。
registerHook('before', 'db_write', 'policy_write_capture', async ({ args, ctx = {} }) => {
  const p = policyWriteOf(args && args.sql);
  if (!p) return {}; // 非策略写入：一个多余查询都不做（这条钩子挂在**每一次** db_write 上）
  ctx.__policyBefore = { ...p, sql: String(args.sql).slice(0, 300), from: await readPolicyValues(p.keys) };
  return {};
}, { builtin: true, failure: 'open' });

// 改**后**：落一条**单独**的账本行 `policy:settings-write`（与 `tool:db_write` 并列，一眼可辨），
// detail 带 键 / 改前→改后 / 谁（账号·会话·壳）/ 原始 SQL。失败语义 open：留痕绝不影响工具本身。
registerHook('after', 'db_write', 'policy_write_audit', async ({ args, result, ctx = {} }) => {
  const cap = ctx.__policyBefore;
  const p = cap || policyWriteOf(args && args.sql);
  if (!p) return {};
  // 写失败 = 什么都没改：不写"策略被改"的行（失败本身已由 `tool:db_write` 行带错误码记下），免得账本谎报。
  if (result && result.error) return {};
  const detail = policyWriteDetail({ kind: p.kind, keys: p.keys, from: cap ? cap.from : null, to: await readPolicyValues(p.keys), ctx, result, sql: cap ? cap.sql : (args && args.sql) });
  try {
    await db.query('INSERT INTO audit_log (account_id, action, detail, shell_id, conversation_id) VALUES (?,?,?,?,?)',
      [ctx.accountId ?? null, 'policy:settings-write', detail, ctx.shellId ?? null, ctx.conversationId ?? null]);
  } catch (e) {
    // 留痕失败必须出声（与 tool-audit 同口径）：工具已经改完了，不能因为写账失败就改判，但绝不能静默。
    console.error('[policy-audit] 策略写入账本缺行（策略已被改）conv=' + (ctx.conversationId || '-') + ' keys=' + p.keys.join(',') + '：' + ((e && e.message) || e));
  }
  return {};
}, { builtin: true, failure: 'open' });