// server/tools/hooks.js - P1-1 hooks 事件系统（借鉴 Claude Code PreToolUse / PostToolUse 事件钩子）
// 目的：把"工具使用纪律/安全网"从平台静态门禁（preset/启用集/权限）升级为可动态注册的钩子——
//   - before：工具执行【前】触发。钩子可拦截（返回 {stop:true, reason}）或改写参数（返回 {args:{...patch}}，浅合并进执行参数）
//   - after：工具执行【后】触发（观察/审计用；返回 stop 仅记录在 result，不撤销已完成执行）
// 任何钩子抛错：内置安全钩子（builtin+failClosed）保守拦截（fail-closed），其余 warn 后忽略——钩子永不拖垮主流程
// 内置钩子（模块加载即注册，平台级强制纪律）：
//   1. danger_command_guard（before run_command）—— 破坏性命令（删根/fork bomb/写盘/关机等）fail-closed 拦截
//   2. system_write_guard（before 全部带 path 的写工具）—— 写系统关键区（/etc /boot /usr/bin 等）fail-closed 拦截
// 平台扩展：server/index.js 等可 import { registerHook } 追加纪律钩子；模型侧用 hooks_list 工具查看（只读）。
import path from 'node:path';

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
// 返回 { stopped:boolean, reason?, by? }——某钩子 stop 后不再执行后续钩子。
export async function emitHooks(side, tool, payload) {
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
    if (r.stop) return { stopped: true, reason: r.reason || h.name, by: h.name };
    if (r.args && typeof r.args === 'object') payload.args = { ...(payload.args || {}), ...r.args };
  }
  return { stopped: false };
}

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
  const cmd = String((args && args.command) || '');
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(cmd)) {
      return { stop: true, reason: p.why + '（命中危险模式 ' + p.re + '）。请改用精确/受限目标重试；确需执行须 ask_user 请平台管理员确认' };
    }
  }
  return {};
}, { builtin: true, failClosed: true });

const SYSTEM_WRITE_RE = /^\/(etc|boot|bin|sbin|dev|proc|sys|root)(\/|$)|^\/usr\/(bin|sbin|lib(64)?)(\/|$)/;
registerHook('before', '*', 'system_write_guard', ({ args }) => {
  const p = args && typeof args.path === 'string' ? args.path : '';
  if (!p) return {};
  const abs = path.resolve(p);
  if (SYSTEM_WRITE_RE.test(abs)) {
    return { stop: true, reason: '写入系统关键区被纪律钩子拦截：' + abs + '（平台代码/工作区文件可正常写；确需写系统文件请改用 run_command 并明确经用户确认）' };
  }
  return {};
}, { builtin: true, failClosed: true });
