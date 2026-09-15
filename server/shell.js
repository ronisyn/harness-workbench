// server/shell.js - "把一条命令串交给本机 shell 执行"的唯一出处
// 使用者：run_command / run_test / run_long_task（tools/index.js）、任务契约验收钩子（driver.js）。
//
// 为什么需要这一层：这些入口收的都是**命令串**（模型按 shell 语法写：引号、管道、重定向、变量），
// 而 execFile 不过 shell。按空格拆 argv 在 Linux 上就会破坏引号，在 Windows 上更彻底——npm/npx 只有
// .cmd 形式（execFile 直呼 ENOENT，显式 .cmd 在 Node 22 上 EINVAL），管道、重定向、内建命令全不存在。
//
// 选型依据（都实测过，不是推演）：
//   · DSH 的做法是每个平台各给一个 shell 工具（dsh-tool-bash / dsh-tool-pwsh，内部都是 `shell -c/-Command 脚本`）；
//     同一份代码两边跑，等价写法就是"按平台选 shell"。
//   · Windows 上选 Windows PowerShell 5.1（powershell.exe）：Server 2019/2022 自带，客户机不用额外装东西。
//   · 实测对比：`node -e "console.log(1+1)"` 经 powershell.exe -Command 得到 `2`、中文与 emoji 正常、退出码透传；
//     而经 cmd.exe /c 会因 Node 的 MSVCRT 转义被吞掉内层引号——**返回空输出且 code=0**（最坏的一类错：看起来成功）。
//   · 前置的 UTF-8 前言照抄 DSH（dsh-pwsh-local 的 ENCODING_PREAMBLE）：不设的话中文/emoji 会按控制台代码页输出成乱码。
import { execFile, spawn } from 'node:child_process';
import { RW_OS } from './env.js';

const PS_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';

// 本机是哪种 shell。`platform` 是测试缝（夹具要在同一台机器上把两条臂都断言掉，与 DSH 的
// workerSpawnEnv(platform = process.platform) 同一写法）。
export const shellFileFor = (platform = RW_OS) => (platform === 'win32' ? 'powershell.exe' : '/bin/bash');
export const SHELL_FILE = shellFileFor();
export const SHELL_CN = RW_OS === 'win32' ? 'Windows PowerShell' : 'bash';

// 一条命令串 → 交给本机 shell 的完整 argv（纯函数，夹具直接断言这一层，不依赖真的起进程）
export function shellArgs(line, platform = RW_OS) {
  const s = String(line);
  return platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_PREAMBLE + s]
    : ['-c', s];
}

// 输出截断：长输出保留头 70% + 尾 20%，中段标明丢了多少（沿用 run_command 既有口径，别处不要再写一套）
function clip(s, cap) {
  const t = String(s || '');
  if (t.length <= cap) return t;
  const head = Math.floor(cap * 0.7);
  const tail = Math.floor(cap * 0.2);
  return t.slice(0, head) + `\n…[输出超长已截断中段 ${t.length - head - tail} 字符]…\n` + t.slice(-tail);
}

// 跑一条命令串，返回 { ok, code, out, err }（与旧 runCmd 同形状，调用方不用改）
export function runShellLine(line, { cwd, timeout = 30000, maxBuffer = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const done = (r) => resolve(r);
    const ch = execFile(
      SHELL_FILE,
      shellArgs(line),
      { timeout, windowsHide: true, maxBuffer, ...(cwd ? { cwd } : {}) },
      (err, stdout, stderr) => done({ ok: !err, code: err?.code ?? 0, out: clip(stdout, 8000), err: clip(stderr, 2000) }),
    );
    // shell 本身起不来（缺可执行文件等）时 execFile 发的是异步 error 事件，没有监听器会带走整个进程。
    ch.on('error', (e) => done({ ok: false, code: e.code ?? 1, out: '', err: 'shell 启动失败（' + SHELL_CN + '）: ' + e.message }));
  });
}

// 后台长任务：detached 起一条命令串（stdio 由调用方给，通常是日志文件 fd）
export function spawnShellLine(line, { cwd, detached = true, stdio = 'ignore' } = {}) {
  return spawn(SHELL_FILE, shellArgs(line), { cwd, detached, stdio, windowsHide: true });
}
