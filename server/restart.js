// server/restart.js - 平台自我重启协作（供 reload_platform 工具与 /api/chat 收尾配合）
// 分工：本模块拥有两件事——**什么时候重启**（请求 → 一次性领取 → 只调度一次）与**这台机器怎么重启**（restartPlan）；
// index.js 的 maybeSelfRestart() 只负责在当前回复落库之后**执行**计划。
// 一句话流程：Agent 调 reload_platform → 这里记下请求 → 当前对话 SSE 正常结束后延迟 2s 重启（不中断当前回复）。
import { RW_RESTART_CMD, RW_SERVICE } from './env.js';

let pendingReason = null;
let scheduled = false;

export function requestRestart(reason) { pendingReason = String(reason || 'code change').slice(0, 300); }
export function takeRestart() { const r = pendingReason; pendingReason = null; return r; }
export function isRestartScheduled() { return scheduled; }
export function markRestartScheduled() { scheduled = true; }

// 重启命令的引号感知分词：Windows 上可执行文件路径几乎必然带空格（C:\Program Files\…），
// 简单 split(/\s+/) 会把一条命令拆成不存在的文件。只支持单层引号，够用且没有第二套语法。
export function splitRestartCmd(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 本机怎么重启（`platform`/`cmd`/`service` 是测试缝：夹具要同时跑 Linux 与 Windows 两条臂，与 DSH 的
// workerSpawnEnv(platform = process.platform) 同一写法）。
// 返回 { argv, how } ＝可以直接 execFile；或 { argv: null, how: 'none', hint } ＝**本机没有可用方式**。
// 为什么允许 null：客户机（Windows）上"谁来拉起服务"取决于安装方式（WinSW/NSSM/计划任务…），没有通用答案。
// 猜一个命令去执行，最坏的结局是把自己杀掉却没人拉起——服务静默消失，比"如实说做不到"糟得多。
// 反面清单（选 RW_RESTART_CMD 时务必避开）：`sc stop` / `net stop` / `nssm stop` / 光用 `schtasks /end`
// 都是"只停不起"，任何看守器都不会因为"我主动停的"而把服务拉回来——填这些等于把平台停死。
export function restartPlan(platform = process.platform, cmd = RW_RESTART_CMD, service = RW_SERVICE) {
  if (cmd && String(cmd).trim()) {
    const argv = splitRestartCmd(String(cmd).trim());
    if (argv.length) return { argv, how: 'RW_RESTART_CMD' };
  }
  if (platform === 'linux') return { argv: ['systemctl', 'restart', String(service)], how: 'systemctl' };
  return {
    argv: null,
    how: 'none',
    hint: '本机没有可用的自动重启方式（当前平台 ' + platform + '，且未设置 RW_RESTART_CMD）。请手动重启服务。'
      + 'Windows 上用 WinSW 托管时填 "<WinSW exe 全路径> restart!"（它的自我重启入口，可从子进程调用），'
      + 'NSSM 则填 "nssm restart ' + String(service) + '"；注意别填 sc stop / net stop / nssm stop 这类只停不起的命令。',
  };
}
