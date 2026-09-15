// server/shell.js - "把一条命令串交给本机 shell 执行"的**对外门面**（API 一字未改）
// 使用者：run_command / run_test / run_long_task（tools/index.js）、任务契约验收钩子（driver.js）。
//
// 2026-09-16（v0.3 §4.2 三层分离 / §5 跨平台）：执行本体已搬到 server/exec/ 的执行后端层——
// 本文件保留原样的对外 API（SHELL_FILE / SHELL_CN / shellArgs / shellFileFor / runShellLine / spawnShellLine），
// 内部只做转发。**为什么保留旧 API 而不是让调用方改用后端接口**：
//   ① 本轮的验收口径就是"对外行为逐字节不变"，调用方（tools/index.js、driver.js、agent.js、index.js）一行不改——
//      这才使得"先把接口抽出来"与"四个调用点切过去"能分成两步做、各自可验收；
//   ② 这些名字回答的是"**本机 shell 是什么**"（提示层要如实告诉模型本机是哪一种系统，driver.js 要在模块顶层
//      拿到可执行文件），那是外壳的问题；"谁来执行"才是后端的问题。两者今天一一对应，但换后端时（例如将来的
//      容器/远端后端）"本机 shell"这个名字仍要在这里回答。
// 谁能用哪一层：新增代码要执行命令请直接用执行后端接口 `import ... from './exec/index.js'`（那里有 argv 级接缝，
// ⑰ 沙箱的挂点）；本文件只为**既有调用方**留存，语义与实现见 server/exec/。
//
// 为什么需要"命令串"这一层（而不是让调用方自己 execFile）：这些入口收的都是模型按 shell 语法写的命令串，
// 而 execFile 不过 shell；按空格拆 argv 在 Linux 上就会破坏引号，在 Windows 上更彻底——npm/npx 只有 .cmd 形式。
import { RW_OS } from './env.js';
import { argvFor, execLine, shellFor, spawnLine } from './exec/index.js';

// 本机是哪种 shell（`platform` 是测试缝：夹具要在同一台机器上把两条臂都断言掉）
export const shellFileFor = (platform = RW_OS) => shellFor(platform).file;
export const SHELL_FILE = shellFileFor();
export const SHELL_CN = shellFor().name;

// 一条命令串 → 交给本机 shell 的完整 argv 里**除可执行文件以外**的那部分（纯函数，夹具直接断言这一层）
export function shellArgs(line, platform = RW_OS) { return argvFor(line, platform).slice(1); }

// 跑一条命令串，返回 { ok, code, out, err }（与旧 runCmd 同形状，调用方不用改）
export function runShellLine(line, opts = {}) { return execLine(line, opts); }

// 后台长任务：detached 起一条命令串（stdio 由调用方给，通常是日志文件 fd）
export function spawnShellLine(line, opts = {}) { return spawnLine(line, opts); }
