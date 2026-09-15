// server/sandbox/backends/linux.js - Linux runner 链：`bwrap`（首选）→ `unshare` 兜底 → 不可用
//
// 分层照 DSH（先问规矩，源码 `dsh-sandbox-local/lib/index.js`）：
//   · DSH 的 Linux 链是 `bwrap` → `landlock`（addon），**每个 runner 都做功能性探针**（真起一次 `true`），
//     "链上多于一个候选才探测"（探测用来仲裁，不是给唯一候选盖章）；全部不可用 ⇒ 拒绝执行。
//   · 本文件照它的**形状**（候选链 + 功能探针 + 拒绝语义），**不照搬它的形态**（我们没有 landlock addon
//     这种自带二进制；`unshare` 是 util-linux 自带、目标机上已经有的，用它做兜底不用新增依赖）。
//
// 本机事实（用户实测，2026-09-16；设计按它来，不猜）：
//   Ubuntu 24.04 / 内核 6.8，服务以 **root** 跑；**没有 bwrap、没有 nsjail/firejail**；有 `/usr/bin/unshare`；
//   `unprivileged_userns_clone=1` 但 `apparmor_restrict_unprivileged_userns=1`（**root 不受该限制**）。
//   ⇒ 顺序必须是 `bwrap`（装上就叫用）→ `unshare`（root 下可用），而不是反过来。
//
// ── 探测口径：为什么不能只看 `which` ───────────────────────────────────────────────
// §4.6/§2.3 要求"功能性探针"：**真起一次并验证隔离真的生效**。一个二进制在 PATH 上，完全可能
// 因为内核开关/未授权 userns/只读挂载点而**起得来但不隔离**——那种误报是最坏的一类（清单里写着隔离，
// 实际上没有）。所以两个 runner 的探针都做同一件事（见 PROBE_SCRIPT）：
//   ① 工作区内必须写得进去（否则是"把活儿拦死了"，不是隔离）；
//   ② **工作区外（根 /）必须写不进去，且必须是只读文件系统(EROFS/EACCES)那类失败**（这是隔离的真凭据）；
//   ③ 探针文件在宿主机上必须确实不存在（交叉核对 ②，防"沙箱其实没生效、只是探测脚本写错了"）。
// 三条全过才算 runner 可用；任何一条不过，**如实记下失败原因**（结构化报给 probeSandbox 的 candidates）。
import fs from 'node:fs';
import path from 'node:path';
import { RW_OS } from '../../env.js';
import { SANDBOX_MODES } from '../policy.js';

/** 探针用的"工作区外"目标：根目录下一个固定名字（不写工作区、不碰任何真实文件）。 */
export const PROBE_OUTSIDE = '/.rw-sandbox-probe-ro';

/**
 * 探针脚本（两个 runner 共用同一份**判据**——两套判据一定会漂移，那是"同一个事实两种说法"的老毛病）。
 * 退出码即结论：0=隔离生效；非 0=不可用（`echo reason=…` 留在 stdout，原样进报告的 detail）。
 * 为什么用 bash 而不是 sh：目标机是 Ubuntu，`$?`/`errno` 判定需要同一套 shell（与 `exec/local.js` 的
 * `/bin/bash -c` 同源）；DSH 的探针只跑 `true`，我们多做两条"真隔离"判定——§4.6 明确不许只看 which。
 */
export const PROBE_SCRIPT = [
  'set -u',
  'ws="$1"',
  'outside="$2"',
  'tmp="${3:-/tmp}"',
  'reason=""',
  'cleanup() { rm -f "$ws/.rw-sandbox-probe-rw" "$tmp/.rw-sandbox-probe-tmp" 2>/dev/null || true; }',
  'trap cleanup EXIT',
  'if ! printf rw > "$ws/.rw-sandbox-probe-rw" 2>/dev/null; then reason="workspace-not-writable"; fi',
  'if [ -z "$reason" ] && [ ! -f "$ws/.rw-sandbox-probe-rw" ]; then reason="workspace-write-not-durable"; fi',
  'if [ -z "$reason" ]; then',
  '  if printf ro > "$outside" 2>/dev/null; then reason="outside-writable"; else',
  '    code=$?',
  '    case "$code" in 1|2|13|30) ;; *) reason="outside-denied-errno-$code";; esac',
  '  fi',
  'fi',
  'if [ -z "$reason" ]; then printf tmp > "$tmp/.rw-sandbox-probe-tmp" 2>/dev/null || reason="tmp-not-writable"; fi',
  'if [ -z "$reason" ]; then echo "probe-ok"; exit 0; fi',
  'echo "reason=$reason"; exit 7',
].join('\n');

/** shell 单引号转义（探针脚本里每个路径都要过这一道；不转义的路径里有空格就会静默走错分支）。 */
function shq(v) { return "'" + String(v).replace(/'/g, "'\\''") + "'"; }

/**
 * `unshare` 兜底 runner 的包装脚本：**mount namespace + 根只读 + 工作区 bind 回可写**。
 *
 * 强弱的如实说明（这一节请连着读，别只看"binding"三个字）：
 *   · 它给的是 **mount namespace 级**的只读根 —— 同一个内核、同一份文件系统视图的拷贝，
 *     不是独立内核（那是第 1 层 gVisor/microVM 的事，本平台未接入，清单里照旧报 none）。
 *   · `mount -o remount,ro /` 是**关键一步**：失败就必须让整条命令失败（脚本里 `|| exit 3`），
 *     否则根仍是可写、探针的"工作区外写不进"就成了假阳性——这是本 runner 最容易被误报的地方。
 *   · 与 bwrap 的差别：bwrap 用 `--ro-bind / /` 从**挂载表**上就给出只读视图（内核替它保证），
 *     我们这里是"先 remount 再 bind 回可写"，**语义等价、可信度略低**（多依赖一步命令是否成功）。
 *     所以两者的 `enforcement` 都是 `partial`（见 backends/index.js 的说明），不因谁更可信就抬到 full。
 *   · 只挂 `/tmp`（tmpfs）与工作区：其余路径一律只读。需要额外可写目录时由 `writableRoots` 传进来。
 * @param {{workspaceRoot:string, mode:string, writableRoots?:string[]}} policy
 */
export function unshareProfileScript(policy) {
  const ws = String(policy.workspaceRoot || process.cwd());
  const writable = [...new Set([ws, ...(policy.writableRoots || []), '/tmp'].map((p) => String(p)))];
  const binds = writable.filter((p) => p !== '/tmp').map((p) => 'mount --bind ' + shq(p) + ' ' + shq(p) + ' || exit 2').join('\n');
  return [
    'set -e',
    'mount --make-rprivate / 2>/dev/null || true',
    'mount -o remount,ro / || exit 3',
    'mount -t tmpfs tmpfs /tmp || true',
    binds,
    'exec "$@"',
  ].filter((l) => l !== '').join('\n');
}

/** 把一次执行请求包进 `unshare` runner。`unshare -m`（mount namespace）在 root 下可用；
 *  不加 `--map-root-user`：root 不需要 userns，而 AppArmor 的 `apparmor_restrict_unprivileged_userns=1`
 *  专管**非 root** 的 userns —— 加了反而在客户机上多一个会失败的分支。 */
export function unshareArgv(policy, innerArgv) {
  return ['unshare', '-m', '--', '/bin/bash', '-c', unshareProfileScript(policy), 'rw-sandbox-unshare', ...innerArgv];
}

/**
 * bwrap profile 参数（照 DSH `bwrapProfileArgs` 的口径写：`--ro-bind / /` + `--dev /dev` +
 * `--unshare-pid` + `--proc /proc` + `--die-with-parent`；workspace-write 时给出可写挂载）。
 * DSH 在 workspace-write 下用 `--tmpfs /tmp`；本实现照抄这一条（临时区**不落到宿主盘**，
 * 比 bind 真 /tmp 更紧，且不需要额外配置项）。
 */
export function bwrapProfileArgs(policy) {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent'];
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp');
    const roots = [...new Set([String(policy.workspaceRoot || process.cwd()), ...(policy.writableRoots || []).map(String)])];
    for (const r of roots) args.push('--bind', r, r);
  }
  return args;
}

export function bwrapArgv(policy, innerArgv) {
  return ['bwrap', ...bwrapProfileArgs(policy), '--', ...innerArgv];
}

/** 平台候选链。Linux 上两个候选 ⇒ 必须靠探针仲裁（DSH 同一取向）。 */
export function candidates() {
  return [
    {
      id: 'bwrap', kind: 'bwrap', enforcement: 'partial',
      build: bwrapArgv,
      denialSignatures: ['read-only file system'],
    },
    {
      id: 'unshare', kind: 'unshare', enforcement: 'partial',
      build: unshareArgv,
      denialSignatures: ['read-only file system', 'permission denied'],
    },
  ];
}

/** 平台事实：本模块只在 Linux 上有意义（windows.js 另行处置；darwin 本平台不部署）。 */
export const platform = 'linux';
export const supported = RW_OS === 'linux';

/** 探针内部要跑的 shell 与参数（两个 runner 共用；`rw-sandbox-probe` 是 $0 占位，便于看进程表）。 */
export function probeInnerArgv({ workspaceRoot, tmp }) {
  return ['/bin/bash', '-c', PROBE_SCRIPT, 'rw-sandbox-probe', workspaceRoot, PROBE_OUTSIDE, tmp || '/tmp'];
}

/**
 * 探针的**宿主侧交叉核对**：探针说"工作区外写不进"，这里再确认那个文件在宿主机上真的不存在。
 * 存在 ⇒ 那一次写其实成功了（沙箱没生效）⇒ 该 runner 判不可用。这是防"探针自己骗自己"的第二道。
 * ⚠️ 异步（`fs.promises.stat`）：不存在"同步版更快"这回事——探针链整体是异步的，
 *   而 `fs.statSync` 在探针路径上同样会占用事件循环（红线见 test/no-sync-subprocess.test.mjs 的同一条理由）。
 * @returns {Promise<{leaked:boolean, detail:string}>}
 */
export async function hostCrossCheck(outside = PROBE_OUTSIDE) {
  try {
    const st = await fs.promises.stat(outside);
    return { leaked: true, detail: '宿主侧存在 ' + outside + '（' + st.size + ' 字节）：那次"工作区外写入"其实成功了' };
  } catch {
    return { leaked: false, detail: '宿主侧确认 ' + outside + ' 不存在' };
  }
}

/** 可执行文件解析（与 `exec/local.js` 的探针同一口径：带分隔符按路径看，否则逐个 PATH 目录找）。 */
export function resolveExe(file) {
  const dirs = /[\\/]/.test(file) ? [''] : String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = d ? path.join(d, file) : file;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
  }
  return null;
}

/** 模式合法性（runner 只认 DSH 的两档；`full-access` 永远不该走到 runner 里）。 */
export function assertConfinableMode(mode) {
  if (!SANDBOX_MODES.includes(mode) || mode === 'full-access') {
    throw new Error('runner 不接受模式 ' + mode + '（runner 只处理 read-only / workspace-write；full-access 不经沙箱）');
  }
  return mode;
}
