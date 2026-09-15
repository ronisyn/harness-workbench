// server/sandbox/backends/windows.js - Windows runner：**如实实现为"没有受支持的 runner 就报不可用"**
//
// 为什么这里几乎什么都不做（这一节是本文件存在的理由，别读成"没写完"）：
//   · DSH 的 Windows 后端是 `dsh-sandbox-windows-acl`：一个**自带的受限令牌 runner**
//     （创建 restricted token + 写 DACL 授权 + 起子进程），它随 DSH 发布、不是这台机器上现成的东西。
//   · 本平台**没有**这个部件，也**不会**在这一轮造一个：§4.6 要的是"服务 + 按平台后端"，
//     G1 要的是"沙箱可替换"——**假装有隔离比没有隔离更坏**（清单里写着 partial，实际上一个字节都没拦）。
//   · 所以本后端的默认行为是：**没有受支持的 runner ⇒ 不可用（none）+ 显式降级上报**，
//     与 §4.6「第 1/3/4 层能力缺失 → 显式降级（留痕 + 提高审批 + 客户可见，禁止静默降级）」完全一致。
//   · 唯一的例外是**部署方自己提供的助手命令**（`RW_SANDBOX_RUNNER`）：客户机若已经装了某个受限执行器
//     （企业常见的 EDR/沙箱代理、或客户自己写的 wrap 程序），可以把它接上。助手命令**必须过功能性探针**
//     才算可用——"配了个命令"本身不是证据，与 Linux 侧同一把尺子。
//
// ⚠️ 本文件在 Windows 上访问不到任何"ACL/令牌"API（那需要 DSH 那个原生部件），所以别把
//    `RW_SANDBOX_RUNNER` 读成"我们支持 Windows ACL"：它只是"客户自带 runner"的接入点，权柄在客户侧。
import fs from 'node:fs';
import path from 'node:path';
import { RW_OS } from '../../env.js';

export const platform = 'win32';
export const supported = RW_OS === 'win32';

/**
 * 助手命令的**校验口径**（回给调用方/探测报告的那一段，也是给客户的说明）：
 *   1. 取值是一个**非空字符串数组**（如 `["C:\\tools\\sandbox-run.exe"]`），
 *      为什么是数组而不是一个字符串：带空格的路径（`C:\Program Files\...`）拆词必然出错，
 *      而"按空格拆"正是 `server/env.js` 里 `RW_RESTART_CMD` 那条注释踩过的坑。
 *   2. 每个元素必须是非空字符串，且**不含换行**（换行会让 argv 契约在被日志/环境文件往返时变形）。
 *   3. `argv[0]` 必须能在 PATH（或绝对路径）上解析到真实文件——解析不到就是**配置错误**，
 *      如实报 `unusable`（不是"不可用但可以试试"）。
 *   4. 助手命令必须接受如下 argv 契约（与 DSH 的 windows-acl runner 同形）：
 *        `<runner> --workspace <工作区根> --temp <临时根> --mode <read-only|workspace-write> -- <内层命令> [args...]`
 *      分隔符 `--` 之后是**原样**要执行的 argv；模式只有两档（`full-access` 永远不该传给它）。
 *   5. 助手命令必须能用退出码 0 表示"受限执行成功"；出错时把原因写 stderr（会原样进探测报告的 detail）。
 */
export const RUNNER_CONTRACT = '--workspace <root> --temp <tmp> --mode <read-only|workspace-write> -- <argv...>';

/**
 * 读助手命令配置。取值来源与 `server/env.js` 的既有口径一致（一切"部署时确定"的事实都从环境来）：
 * `RW_SANDBOX_RUNNER` 用 `JSON.stringify` 的数组写法或逗号分隔都收（后者只为人工临时试一次方便）。
 * @param {string|string[]|undefined} raw
 * @returns {{argv:string[]|null, error:string|null}} 配置错误如实返回 error，不抛（探测报告要带上原因）
 */
export function normalizeRunnerArgv(raw = process.env.RW_SANDBOX_RUNNER) {
  let argv = null;
  if (Array.isArray(raw)) argv = raw.map(String);
  else if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    if (s.startsWith('[')) {
      try { const v = JSON.parse(s); if (Array.isArray(v)) argv = v.map(String); } catch { return { argv: null, error: 'RW_SANDBOX_RUNNER 不是合法 JSON 数组' }; }
    } else argv = s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (argv === null) return { argv: null, error: null }; // 没配 = 正常情形（默认不可用）
  if (!argv.length) return { argv: null, error: 'RW_SANDBOX_RUNNER 为空数组（要么不配，要么给至少一个元素）' };
  for (const a of argv) {
    if (typeof a !== 'string' || !a.length) return { argv: null, error: 'RW_SANDBOX_RUNNER 含空元素' };
    if (/[\r\n]/.test(a)) return { argv: null, error: 'RW_SANDBOX_RUNNER 元素含换行' };
  }
  return { argv, error: null };
}

/** 可执行文件解析（与 `exec/local.js` 同一口径；Windows 的 PATH 元素本来就带扩展名，不另造 PATHEXT）。 */
export function resolveExe(file) {
  const dirs = /[\\/]/.test(file) ? [''] : String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = d ? path.join(d, file) : file;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
  }
  return null;
}

/**
 * 候选链：**只有**部署方提供的助手命令（没有就空链 ⇒ 上层判不可用）。
 * 为什么不像 Linux 那样给两个候选：Windows 上本平台没有任何自带的受限执行器，
 * 编一个"占位候选"只会让清单里多一个永远 unusable 的行（噪音），不增加任何真实能力。
 */
export function candidates(env = process.env) {
  const { argv, error } = normalizeRunnerArgv(env.RW_SANDBOX_RUNNER);
  if (error) return [{ id: 'deployment-runner', kind: 'deployment-runner', enforcement: 'partial', configError: error, build: null }];
  if (!argv) return [];
  return [{
    id: 'deployment-runner', kind: 'deployment-runner', enforcement: 'partial',
    command: argv,
    denialSignatures: ['access is denied', 'access to the path', 'permission denied'],
    build: (policy, innerArgv) => [
      ...argv,
      '--workspace', String(policy.workspaceRoot || process.cwd()),
      '--temp', String(policy.tempRoot || process.env.TEMP || process.env.TMP || '.'),
      '--mode', String(policy.mode),
      '--', ...innerArgv,
    ],
  }];
}

/** 探针的内层命令（Windows 上照 DSH 用 `cmd /c exit 0`：只要能起来就算受限执行成功）。 */
export function probeInnerArgv() { return ['cmd', '/c', 'exit', '0']; }
