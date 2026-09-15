// server/sandbox/backends/index.js - 按平台选后端 + **功能性探针**（真起一次，验证隔离真的生效）
//
// 分层照 DSH（`dsh-sandbox-local/lib/index.js` 的 `PLATFORM_CHAINS` / `selectRunner` / `chainVerdict`）：
//   平台 → 候选链（按优先序）→ 逐个**功能探针**仲裁 → 第一个通过的胜出 → 一个都没有 ⇒ 不可用。
//   DSH 另有一条"唯一候选不探测"的优化（链上只有一个候选时直接选它）——**本实现不照抄**：
//   本平台 Linux 链有两个候选（探针本来就要跑），Windows 链唯一但那一个是"部署方自带的助手命令"，
//   恰恰更需要探针（"配了个命令"不等于"隔离生效"）。少一次探测换不来什么，多一次误报代价很大。
//
// ⚠️ 探针**必须异步**（2026-09-16，`test/no-sync-subprocess.test.mjs` 的红线）：
//   `execFileSync` 会冻住**整个 Node 进程**（所有会话的 SSE、心跳、别的用户一起停摆），
//   而探针是在**启动链**上跑的——那正是"平台起不来"的一种形态。同步写法曾在这里出现过一次，
//   被那条夹具抓住；正确写法就是本文件这样：`execFile` + promisify + `{ timeout }`。
//   探针的异步语义也因此更好：启动时 `await guard()`，探测期间任何 `confine()` 都按"未就绪"处置（见 index.js）。
//
// 探测时长的出处（**不发明阈值**）：DSH `LocalSandboxProvider.Config.probeTimeoutMs` 默认 `5000`。
// 为什么不另设一个数：探针就是"起一个进程跑一条命令"，与 DSH 同一件事；两处取不同的数只会让
// "为什么这里 3 秒那里 5 秒"变成没人能回答的问题。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { RW_OS, RW_WORKSPACE } from '../../env.js';
import * as linux from './linux.js';
import * as windows from './windows.js';

const execFileAsync = promisify(execFile);

/** DSH `probeTimeoutMs` 的默认值（见文件头注释）。 */
export const PROBE_TIMEOUT_MS = 5000;

/** 探测后端与 runner 选择：读环境事实（平台/工作区/部署方配置），不产出任何副作用。 */
export const BACKEND_NAMES = Object.freeze(['linux', 'windows']);

/**
 * 本平台的候选链（按优先序）。
 * @param {{platform?:string, env?:object}} opts
 * @returns {Array<object>} 候选（可能为空 ⇒ 该平台没有任何受支持的 runner）
 */
export function candidateChain({ platform = RW_OS, env = process.env } = {}) {
  if (platform === 'linux') return linux.candidates();
  if (platform === 'win32') return windows.candidates(env);
  return []; // darwin 等：本平台不部署，如实返回空链（不假装有 seatbelt 支持）
}

/** 一次探针要包的内层命令（Linux 的探针脚本需要工作区/临时路径参数）。 */
function innerArgvFor(platform, workspaceRoot) {
  if (platform === 'linux') return linux.probeInnerArgv({ workspaceRoot, tmp: os.tmpdir() });
  return windows.probeInnerArgv();
}

/**
 * 跑一个候选的**功能性探针**：真的把内层命令包进该 runner 起一次，验证
 *   ① 工作区内写得进去 ② 工作区外写不进去（只读）③ 临时区可写（Linux 探针脚本内的三条判据）。
 * 探针用 `workspace-write` 模式：它同时覆盖"根只读"和"工作区可写"两条边界；
 * 用只读模式只能覆盖一半，等于把"写会话下隔离还在不在"这件事留空。
 *
 * 失败原因**结构化**返回（哪个 runner、为什么不通过、退出码、stderr 摘要），
 * 不许只回一个 false —— 部署者要拿它判断"是没装、还是装了不生效"。
 * @returns {Promise<{ok:boolean, detail:string, exitCode:number|null, argv:string[]}>}
 */
export async function runProbe(candidate, { platform = RW_OS, workspaceRoot = RW_WORKSPACE, timeoutMs = PROBE_TIMEOUT_MS, tempRoot = os.tmpdir() } = {}) {
  if (candidate.configError) return { ok: false, detail: '配置错误：' + candidate.configError, exitCode: null, argv: [] };
  const policy = { mode: 'workspace-write', workspaceRoot, tempRoot };
  const inner = innerArgvFor(platform, workspaceRoot);
  let argv;
  try { argv = candidate.build(policy, inner); } catch (e) { return { ok: false, detail: 'argv 组装失败：' + ((e && e.message) || e), exitCode: null, argv: [] }; }
  const [file, ...args] = argv;
  if (!file) return { ok: false, detail: 'runner argv 为空（配置错误）', exitCode: null, argv };
  // 解析得到可执行文件才算"起得来"；解析不到就直接给原因（省一次 spawn，也给更准的话）
  const exe = (candidate.kind === 'bwrap' || candidate.kind === 'unshare') ? linux.resolveExe(file) : windows.resolveExe(file);
  if (!exe) return { ok: false, detail: '本机解析不到 ' + file + '（PATH 与绝对路径都没找到）', exitCode: null, argv };
  try {
    const r = await execFileAsync(file, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
    const text = String((r && r.stdout) || '').trim();
    return { ok: true, detail: '探针通过：' + (text || 'no-output'), exitCode: 0, argv };
  } catch (e) {
    const isTimeout = e && (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT');
    const out = String((e && e.stdout) || '').trim();
    const err = String((e && e.stderr) || '').trim();
    const bits = [isTimeout ? ('超时 ' + timeoutMs + 'ms') : ('退出码 ' + (e && e.code !== undefined ? e.code : '无')),
      out ? ('stdout=' + out.slice(0, 200)) : '', err ? ('stderr=' + err.slice(0, 200)) : ''].filter(Boolean);
    return { ok: false, detail: bits.join('；'), exitCode: typeof (e && e.code) === 'number' ? e.code : null, argv };
  }
}

/**
 * 逐个探测候选，返回完整报告（**不做选择**：选择是服务层的事，报告只陈述事实）。
 * Linux 额外做一次**宿主侧交叉核对**（探针说"根写不进去"，就在宿主上确认那个文件真的没出现）——
 * 这是防"沙箱没生效但探针脚本自己写错"的第二道；不通过则把该候选判不可用。
 * @returns {Promise<{platform:string, candidates:Array, runner:object|null, unavailableReason:string|null}>}
 */
export async function probeCandidates({ platform = RW_OS, env = process.env, workspaceRoot = RW_WORKSPACE, timeoutMs = PROBE_TIMEOUT_MS, runProbeFn = runProbe, crossCheckFn = null } = {}) {
  const chain = candidateChain({ platform, env });
  const out = { platform, candidates: [], runner: null, unavailableReason: null };
  if (!chain.length) {
    out.unavailableReason = platform === 'win32'
      ? '本平台没有受支持的 Windows runner（DSH 的 ACL 受限令牌 runner 不在本仓库；未配置 RW_SANDBOX_RUNNER）'
      : '平台 ' + platform + ' 没有受支持的沙箱 runner';
    return out;
  }
  for (const c of chain) {
    const r = await runProbeFn(c, { platform, workspaceRoot, timeoutMs });
    let ok = r.ok;
    let detail = r.detail;
    // 宿主侧交叉核对：**链上每个候选都要过**（不是只给 bwrap）。踩过一次真坑（夹具当场抓到）：
    // 只给 bwrap 做核对时，一个"探针自称通过、其实没隔离"的 bwrap 会被链上的 unshare 顶掉，
    // 于是整体照样报"可用"——那正是最坏的一类误报（清单里写着有隔离，实际上前面那个 runner 根本没拦住）。
    // 判据与 runner 无关（都去宿主上看那个"工作区外"的文件在不在），所以这里对每个候选一视同仁。
    if (ok && platform === 'linux') {
      const cross = await (crossCheckFn || linux.hostCrossCheck)();
      if (cross.leaked) { ok = false; detail = '宿主侧交叉核对不通过：' + cross.detail; }
      else detail = detail + '；' + cross.detail;
    }
    const rec = { id: c.id, kind: c.kind, enforcement: c.enforcement, ok, detail, exitCode: r.exitCode, argv: r.argv };
    out.candidates.push(rec);
    if (ok && !out.runner) out.runner = rec;
  }
  if (!out.runner) out.unavailableReason = out.candidates.map((c) => c.id + '：' + c.detail).join('；');
  return out;
}

/** 平台是否为"本平台支持的双平台之一"（如实回答；darwin 等既非支持也非错误，只是未接入）。 */
export function platformSupported(platform = RW_OS) { return platform === 'linux' || platform === 'win32'; }

/** 探针用的默认工作区（诊断报告里要写清"探的是哪个工作区"）。 */
export const defaultWorkspace = RW_WORKSPACE;
