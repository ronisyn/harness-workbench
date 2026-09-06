// server/tools/hooks.js - P1-1 hooks 事件系统（借鉴 Claude Code PreToolUse / PostToolUse 事件钩子）
// 目的：把"工具使用纪律/安全网"从平台静态门禁（preset/启用集/权限）升级为可动态注册的钩子——
//   - before：工具执行【前】触发。钩子可拦截（返回 {stop:true, reason}）或改写参数（返回 {args:{...patch}}，浅合并进执行参数）
//   - after：工具执行【后】触发（观察/审计用；返回 stop 仅记录在 result，不撤销已完成执行）
// 任何钩子抛错：内置安全钩子（builtin+failClosed）保守拦截（fail-closed），其余 warn 后忽略——钩子永不拖垮主流程
// 内置钩子（模块加载即注册，平台级强制纪律）：
//   1. danger_command_guard（before run_command）—— 破坏性命令（删根/fork bomb/写盘/关机等）fail-closed 拦截
//   2. system_write_guard（before 写类工具）—— 写系统关键区（/etc /boot /usr/bin 等）fail-closed 拦截
//   3. preset_tier_guard（before *）—— preset 暴露面（minimal/standard 调 core/pro 级外工具 → 指引）
//   4. enabled_tools_guard（before *）—— 账号工具启用集未含且非平台豁免 → 指引（可恢复：设置→工具 勾选）
//   5. readonly_intent_guard（before 改动类）—— 请求级只读规划意图（P4）时禁改动工具
//   6. shell_readonly_guard（before run_command）—— 读型命令（cat/ls/grep/…）引导用专门工具
// P2（2026-09 批2）：3/4/5/6 为"纪律统一层"——从 execTool 内联门禁迁来，纪律集中一处可 listHooks 审计、可动态调整。
// 平台扩展：server/index.js 等可 import { registerHook } 追加纪律钩子；模型侧用 hooks_list 工具查看（只读）。
import { execFileSync } from 'node:child_process';
import { TOOL_META, PLATFORM_EXEMPT } from './meta.js';

const registry = [];
const MAX_HOOKS = 128;

// 注册钩子。side='before'|'after'；tool=具体工具名或 '*'（全部工具）；opts.builtin/failClosed 标记内置安全钩子
export function registerHook(side, tool, name, fn, opts = {}) {
  if (!['before', 'after'].includes(side)) throw new Error('hook side 非法: ' + side);
  if (typeof fn !== 'function') throw new Error('hook fn 必须是函数');
  if (registry.length >= MAX_HOOKS) throw new Error('hooks 注册超上限 ' + MAX_HOOKS);
  registry.push({ side, tool: tool || '*', name, fn, builtin: !!opts.builtin, failClosed: !!opts.failClosed });
  return { side, tool: tool || '*', name, builtin: !!opts.builtin };
}

// 查看已注册钩子（hooks_list 工具用）
export function listHooks() {
  return registry.map((h) => ({ side: h.side, tool: h.tool, name: h.name, builtin: h.builtin }));
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

// 触发某 side+工具名的全部钩子。payload 传入 {args, ctx}；钩子可改 payload.args（浅合并语义）。
// 返回 { stopped:boolean, reason?, by?, allowed?:boolean }——某钩子 stop 后不再执行后续钩子；
// allow 短路（P6 规则层）：某钩子返回 {allow:true} 则跳过其余钩子并标记 allowed（调用方免审批/免纪律拦截）。
export async function emitHooks(side, tool, payload) {
  // P2：把当前工具名注入 payload.ctx.__toolName，供 '*' 纪律钩子（preset/启用集等）按名判定
  if (payload && payload.ctx && typeof payload.ctx === 'object') payload.ctx.__toolName = tool;
  for (const h of registry) {
    if (h.side !== side) continue;
    if (h.tool !== tool && h.tool !== '*') continue;
    let r = null;
    try {
      r = (await h.fn(payload)) || {};
    } catch (e) {
      if (h.builtin && h.failClosed) {
        return { stopped: true, reason: '内置钩子 ' + h.name + ' 异常，fail-closed 拦截：' + (e && e.message ? e.message : e), by: h.name };
      }
      console.warn('[hooks] ' + side + ':' + tool + ' 钩子 ' + h.name + ' 抛错已忽略（不阻断主流程）: ' + (e && e.message ? e.message : e));
      continue;
    }
    if (r.allow) return { stopped: false, allowed: true, by: h.name }; // P6 allow 短路：跳过其余纪律钩子
    if (r.stop) return { stopped: true, reason: r.reason || h.name, by: h.name };
    if (r.args && typeof r.args === 'object') payload.args = { ...(payload.args || {}), ...r.args };
  }
  return { stopped: false };
}

// ---------------------------------------------------------------------------
// P6 allow/deny 规则层（2026-09 批2）：管理员级规则（settings access_rules，由 index.js 读入 ctx.__accessRules）
// 语义：deny 命中 → 无条件拦截；allow 命中 → 短路跳过后续纪律钩子并标记 allowed（调用方免 guard 审批）。
// 规则顺序=数组序，先匹配先生效；无规则命中 → 走常规纪律/审批。规则格式：
//   { id, pattern: 工具名正则, argPattern?: 参数 JSON 正则(可空), action: 'allow'|'deny', why }
// 本钩子最先注册（registry 序），deny 在 allow 前判定——管理员 deny 永远优先于 allow。
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
}, { builtin: true, failClosed: false });

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
}, { builtin: true, failClosed: true });

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
  }, { builtin: true, failClosed: true });
}

// ---------------------------------------------------------------------------
// P2 纪律统一层（2026-09 批2）：从 execTool 内联门禁迁入的纪律钩子——
// 纪律集中一处（listHooks 可审计、可动态调整），execTool 只保留权限层（checkPerm/limitPath/审批）与安全网（占位符检疫/快照）。
// 说明：内置纪律钩子 fail-open（返回 stop 才拦，抛错 warn 不阻断）——纪律是引导，安全网（danger/system_write）才 fail-closed。
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
}, { builtin: true, failClosed: false });

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
}, { builtin: true, failClosed: false });

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
  }, { builtin: true, failClosed: false });
}
// P24(O-21/O-23)：MCP 外部工具（动态命名）同样受只读意图约束——管理员信任 ≠ 只读轮可执行外部副作用
registerHook('before', '*', 'readonly_mcp_guard', ({ args, ctx }) => {
  const name = ctx?.__toolName;
  if (ctx?.__readonlyIntent && name && name.startsWith('mcp_')) {
    return { stop: true, reason: '只读规划意图（本轮）：MCP 外部工具 ' + name + ' 已被禁用。规划阶段只用只读工具；把方案作为回答展示，等用户批准后再执行。' };
  }
  return {};
}, { builtin: true, failClosed: false });

// 6. 命令纪律：run_command 读型命令引导用专门工具（原 execTool 内联；审计 58% shell 调用本可用专门工具）
registerHook('before', 'run_command', 'shell_readonly_guard', ({ args }) => {
  const cmdline = String((args && (args.cmd ?? args.command)) || '').trim();
  const first = cmdline.split(/\s+/)[0];
  const isEditSed = first === 'sed' && /\s-i\b/.test(cmdline);
  if (!isEditSed && /^(cat|ls|grep|find|sed|head|cd|echo)$/.test(first || '')) {
    return { stop: true, reason: `run_command 命令纪律：${first} 有专门工具（读文件=read_file/read_file_range；列目录=list_dir；搜内容=grep_search；找文件=find_file；查看片段=read_file_range）。请改用专门工具完成；确需系统操作请把命令拆开执行。` };
  }
  return {};
}, { builtin: true, failClosed: false });

// ---------------------------------------------------------------------------
// G 域质量钩子（2026-09 批4）：after 型（观察/留痕，不阻断已执行）——
//   7. code_syntax_check（after write_file/edit_file）：改 .js/.mjs/.cjs 后自动 node --check，语法错误写入 result.hookNote
//   8. finish_selfcheck_note（after finish_task）：校验 summary 长度与 selfCheck 提示（留痕引导提测质量）
// ---------------------------------------------------------------------------
const CODE_EXT = /\.(js|mjs|cjs)$/;
const syntaxNote = ({ args, result }) => {
  try {
    const p = String((args && args.path) || '');
    if (!CODE_EXT.test(p)) return {};
    execFileSync('node', ['--check', p], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result && typeof result === 'object' && !Array.isArray(result)) result.hookNote = '语法检查通过（node --check）';
  } catch (e) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const msg = String((e && e.stderr) || (e && e.message) || e || '').split('\n').filter(Boolean).slice(0, 2).join(' | ').slice(0, 260);
      result.hookNote = '⚠️ 语法检查失败：' + msg + '（请修复后再提交）';
    }
  }
  return {};
};
registerHook('after', 'write_file', 'code_syntax_check', syntaxNote, { builtin: true, failClosed: false });
registerHook('after', 'edit_file', 'code_syntax_check', syntaxNote, { builtin: true, failClosed: false });

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
}, { builtin: true, failClosed: false });