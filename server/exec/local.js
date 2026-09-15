// server/exec/local.js - 本机执行后端（v0.3 §4.2「三层分离：契约 / 注册表 / 执行后端」的第三层；§5 跨平台）
//
// 语义＝改造前 server/shell.js 的那份实现，**行为逐字节不变**（本轮用户口径："第一步只抽接口、行为不变"）：
//   Linux `/bin/bash -c <命令串>`；Windows `powershell.exe -NoLogo -NoProfile -NonInteractive -Command <UTF-8 前言 + 命令串>`；
//   输出截断（头 70% + 尾 20%）；超时如实说明；后台长任务 detached 起进程；Windows 用 taskkill /T /F 收整棵树。
//
// 为什么平台事实落在实现里而不是接口里（./index.js）：接口只描述动词，实现才描述平台——
// 换平台＝换实现（DSH 的 `dsh-bash-local` / `dsh-pwsh-local` 就是这个分工），接口与调用方都不动。
//
// 选型依据（都实测过，不是推演）：
//   · DSH 的做法是每个平台各给一个 shell 工具（dsh-tool-bash / dsh-tool-pwsh，内部都是 `shell -c/-Command 脚本`）；
//     同一份代码两边跑，等价写法就是"按平台选 shell"。
//   · Windows 上选 Windows PowerShell 5.1（powershell.exe）：Server 2019/2022 自带，客户机不用额外装东西。
//   · 实测对比：`node -e "console.log(1+1)"` 经 powershell.exe -Command 得到 `2`、中文与 emoji 正常、退出码透传；
//     而经 cmd.exe /c 会因 Node 的 MSVCRT 转义被吞掉内层引号——**返回空输出且 code=0**（最坏的一类错：看起来成功）。
//   · 前置的 UTF-8 前言照抄 DSH（dsh-pwsh-local 的 ENCODING_PREAMBLE）：不设的话中文/emoji 会按控制台代码页输出成乱码。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RW_OS } from '../env.js';

// 后端自称的名字（选择点与能力上报读它；必须与 ./index.js 的实现表键一致）
export const id = 'local';

// 平台 → 本机 shell。`platform` 是测试缝（夹具要在同一台机器上把两条臂都断言掉，与 DSH 的
// workerSpawnEnv(platform = process.platform) 同一写法）。
const SHELLS = {
  win32: { file: 'powershell.exe', name: 'Windows PowerShell' },
  posix: { file: '/bin/bash', name: 'bash' },
};
export function shellFor(platform = RW_OS) { return platform === 'win32' ? SHELLS.win32 : SHELLS.posix; }

const PS_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

// ---- argv 级接缝（纯函数；照 DSH `dsh-bash-local` 的 argv(spec) / spawnSpec(spec)）----
// 命令串 → **完整 argv**（argv[0] 是可执行文件）。⑰ 沙箱将来只在这一层包：在返回值前面插 confinement
// runner（Linux bwrap/landlock-run、macOS sandbox-exec、Windows 受限令牌 runner），其余一字不改。
// 为什么是纯函数：夹具直接断言它，不真起进程；沙箱包不包得住、包成什么 argv，也都能被夹具钉住。
export function argvFor(line, platform = RW_OS) {
  const s = String(line);
  const { file } = shellFor(platform);
  return platform === 'win32'
    ? [file, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_PREAMBLE + s]
    : [file, '-c', s];
}

// 接缝的另外两半：一次执行请求 → 最终 argv + **spawn 选项**（前台走 execFile、后台走 spawn，两套选项不同，
// 所以是两个纯函数；选项字段与取值沿用改造前，不许在这里"顺手统一"）。
export function execPlan({ line, cwd, timeout = 30000, maxBuffer = 2 * 1024 * 1024, platform = RW_OS } = {}) {
  const [command, ...args] = argvFor(line, platform);
  return { command, args, options: { timeout, windowsHide: true, maxBuffer, ...(cwd ? { cwd } : {}) } };
}

export function spawnPlan({ line, cwd, detached = true, stdio = 'ignore', platform = RW_OS } = {}) {
  const [command, ...args] = argvFor(line, platform);
  return { command, args, options: { cwd, detached, stdio, windowsHide: true } };
}

// 输出截断：长输出保留头 70% + 尾 20%，中段标明丢了多少（沿用 run_command 既有口径，别处不要再写一套）。
// 为什么截断跟着"执行一条命令串"这个动词走、而不是留在门面（server/shell.js）：这个动词的返回值形状
// （{ok,code,out,err}）就是**模型可见的形状**，截断是它的既有语义；留在门面会让 interface 的调用方
// （下一轮切过来的 run_command/run_test）拿到未截断的原始输出——那是模型上下文里实打实的行为变化。
function clip(s, cap) {
  const t = String(s || '');
  if (t.length <= cap) return t;
  const head = Math.floor(cap * 0.7);
  const tail = Math.floor(cap * 0.2);
  return t.slice(0, head) + `\n…[输出超长已截断中段 ${t.length - head - tail} 字符]…\n` + t.slice(-tail);
}

// 执行一条命令串，返回 { ok, code, out, err }（与改造前 runShellLine 同形状，调用方不用改）
export function execLine(line, opts = {}) {
  const { command, args, options } = execPlan({ line, ...opts });
  const shellName = shellFor(opts.platform).name;
  return new Promise((resolve) => {
    const done = (r) => resolve(r);
    const ch = execFile(
      command,
      args,
      options,
      (err, stdout, stderr) => {
        let e = clip(stderr, 2000);
        // 超时：execFile 终止的是**我们起的那个 shell 进程**。POSIX 上 `bash -c '<单条命令>'` 会直接 exec
        // 成那条命令（同 pid，杀得到）；PowerShell 起的是子进程，超时后子进程可能仍活着——这与 DSH 在同一
        // 平台上的行为一致（它的 pwsh 工具也是终止 pwsh 自身）。如实说出来，别让"超时了但进程还在"变成隐形状态。
        if (err && err.killed) e = (e ? e + '\n' : '') + '[超时] 命令已被终止（shell 已杀；Windows 上被它拉起的子进程可能仍在，必要时用 taskkill /IM <名> /F 清理）';
        done({ ok: !err, code: err?.code ?? 0, out: clip(stdout, 8000), err: e });
      },
    );
    // shell 本身起不来（缺可执行文件等）时 execFile 发的是异步 error 事件，没有监听器会带走整个进程。
    // 实测注记（2026-09-16，差分脚本 tmp/exec-diff.mjs 的 Linux 臂）：**带回调时**这条异步错先被回调截走
    // （code='ENOENT'、err 为空串），下面那句"shell 启动失败"到不了——改造前后一字不差，故本轮只记录、不改行为。
    ch.on('error', (e) => done({ ok: false, code: e.code ?? 1, out: '', err: 'shell 启动失败（' + shellName + '）: ' + e.message }));
  });
}

// 后台长任务：detached 起一条命令串（stdio 由调用方给，通常是日志文件 fd）
export function spawnLine(line, opts = {}) {
  const { command, args, options } = spawnPlan({ line, ...opts });
  return spawn(command, args, options);
}

// 杀进程树（现状的第二个平台分叉点：它原先写在 tools/index.js 的 kill_process 里）。
// 为什么是一个动词而不是"给 pid 发个信号"：Windows 上没有真信号——process.kill 一律强杀且**不收敛子树**，
// 而后台任务是 detached 起的一整棵树，所以 Windows 侧必须走 `taskkill /T /F`。这个差异由后端吸收，
// 调用方只说"把这个进程收掉"，不必知道自己在哪个平台。
// 返回 { killed, gone, detail }：killed＝确实收掉了；gone＝已经不在了（常态，不是错误）；真失败抛错（如实失败，不假装成功）。
// timeout 沿用 kill_process 既有值。
export async function killTree(pid, { timeout = 20000, platform = RW_OS } = {}) {
  const n = Number(pid);
  if (platform === 'win32') {
    const r = await execLine('taskkill /PID ' + n + ' /T /F', { timeout });
    if (r.ok) return { killed: true, gone: false, detail: String(r.out || '').trim() };
    if (/not found|没有找到|找不到/i.test(r.out + r.err)) return { killed: false, gone: true, detail: String(r.out || r.err || '').trim() };
    throw new Error('终止失败: ' + (r.err || r.out || ('taskkill 返回 ' + r.code)));
  }
  try {
    process.kill(n, 'SIGTERM');
    return { killed: true, gone: false, detail: '' };
  } catch (e) {
    // ESRCH=进程不存在：进程表已清理(重启/超12h TTL)或任务早已退出，属常态而非错误
    if (e.code === 'ESRCH') return { killed: false, gone: true, detail: e.message };
    throw new Error('终止失败: ' + e.message);
  }
}

// 探测本后端可用性（⑯ 依赖链上给 ⑰ 沙箱留的位置：DSH 的沙箱 runner 每个都做**功能性探针**，
// 全部不可用就拒绝执行）。本轮只做**可解析性**探测——shell 可执行文件能不能在 PATH/绝对路径上找到，
// 如实说明"没真起进程"，不冒充 DSH 的功能性探针（那是 ⑰ 的事：真跑一次 `true` 才算）。
export function probe({ platform = RW_OS } = {}) {
  const sh = shellFor(platform);
  const exe = resolveExe(sh.file);
  return {
    id,
    platform,
    shellFile: sh.file,
    shellName: sh.name,
    available: exe !== null,
    exe,
    detail: exe ? '本机可解析到 ' + exe : '本机解析不到 ' + sh.file + '（PATH 与绝对路径都没找到）',
    functional: false, // 只做可解析性检查；功能性探针（真起一次进程）属 ⑰
  };
}

// 可执行文件解析：带分隔符的按绝对/相对路径看，不带分隔符的逐个 PATH 目录找（Windows 上 PATH 里本来
// 就是带扩展名的完整文件名，所以不需要再造一套 PATHEXT 逻辑）。
function resolveExe(file) {
  const dirs = /[\\/]/.test(file) ? [''] : String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const p = d ? path.join(d, file) : file;
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不在这个目录，继续找 */ }
  }
  return null;
}
