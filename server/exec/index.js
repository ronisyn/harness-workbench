// server/exec/index.js - 执行后端层：**接口 + 单一选择点**（v0.3 §4.2「三层分离：契约 / 注册表 / 执行后端」的第三层；
// §5「引擎现在把 Linux/bash//srv 写死在提示层与工具层 → 执行后端抽象 + 双平台支持」）。
//
// 分层照 DSH（先问规矩）：
//   · DSH 是"接口包 + 实现包"两层：`dsh-subprocess`（接口）/`dsh-subprocess-local`（实现）、
//     `dsh-shell`（接口）/`dsh-bash-local` · `dsh-pwsh-local`（每平台一个实现）；一个 host 只装一个实现，
//     装两个直接抛错（不静默挑一个）。本目录同形：index.js ＝接口 + 选择点，local.js ＝实现。
//   · DSH 给"confine 钩子"留的接缝是 **argv 级**：`dsh-bash-local` 的 `argv(spec)` / `spawnSpec(spec)` 是两个纯函数
//     （给定一次执行请求 → 最终 argv + spawn 选项），`dsh-bash-sandbox` 就是在这一层把 argv 换成
//     "confinement runner + 原 argv"，超时/输出/终止一概不动。
//     ⇒ 我们的 ⑰ 沙箱（§7.1 ⑰，依赖 ⑯）将来**只在这一层包**：argvFor / execPlan / spawnPlan。
//       这是本轮把接缝单独摆出来的唯一理由：⑰ 无处挂，是因为 ⑯ 原先没有这个位置。
//
// 动词为什么收"命令串"而不是 argv：这些入口收的都是模型按 shell 语法写的**命令串**（引号、管道、重定向、
//   变量、内建命令），而 execFile 不过 shell；按空格拆 argv 在 Linux 上破坏引号，在 Windows 上更彻底
//   （npm/npx 只有 .cmd 形式，execFile 直呼 ENOENT，显式 .cmd 在 Node 22 上 EINVAL）。argv 由实现按平台拼。
//
// 本轮口径（"第一步只抽接口、行为逐字节不变"）：
//   · 动词只覆盖**现在真正用到**的四件事：执行一条命令串 / 后台按 argv 起进程 / 杀进程树 / 探测可用性；
//     不预造容器、远端后端（v0.3 §0.6 明确不做）。
//   · 唯一实现是 local（＝改造前的行为）；选择点按 RW_EXEC_BACKEND 选，**未知名字如实抛错**，绝不静默回落——
//     与 v0.3 §4.6「禁止静默降级」同一条纪律：拿不准就说拿不准，不许假装用了另一个后端。
import { RW_EXEC_BACKEND } from '../env.js';
import * as local from './local.js';

// 一个后端必须提供的动词（装配期校验；照 §7.1 ③④「清单装配期校验、默认拒绝」的做法）。
// 加一个后端＝写一个实现模块并在实现表里加一行；少动词在**装配期**就抛，不等到第一次调用才发现。
const VERBS = ['shellFor', 'argvFor', 'execPlan', 'spawnPlan', 'execLine', 'spawnLine', 'killTree', 'probe'];

// 实现表 —— **唯一选择点**。不加"自动探测/回落"：选择是显式的，选错就在启动时炸掉（CI 也能钉住）。
const BACKENDS = { local };
export const BACKEND_NAMES = Object.freeze(Object.keys(BACKENDS)); // "有哪些后端"只有这一个出处

// 校验一个实现是否满足接口（导出是为了可夹具：装配期校验本身也要能被机检，而不是只写在注释里）
export function assertBackend(name, impl) {
  const missing = VERBS.filter((v) => typeof impl?.[v] !== 'function');
  if (!impl || typeof impl.id !== 'string' || missing.length) {
    throw new Error('执行后端 ' + name + ' 不满足接口：' + (missing.length ? '缺动词 ' + missing.join('、') : '缺 id'));
  }
  return impl;
}

export function selectBackend(name = RW_EXEC_BACKEND) {
  const key = String(name);
  const impl = BACKENDS[key];
  if (!impl) throw new Error('未知执行后端：' + key + '（RW_EXEC_BACKEND 可选：' + BACKEND_NAMES.join(' / ') + '）');
  return assertBackend(key, impl);
}

// 进程启动时选定一次（与 DSH 在装配期选实现同一取向）。后端**不许**在运行中途换：同一条命令在不同时刻
// 落到不同执行世界，账本、沙箱模式与"本机是哪一种系统"的提示层会对不上，而且没人看得出来。
export const EXEC_BACKEND = selectBackend();
export const EXEC_BACKEND_NAME = EXEC_BACKEND.id;

// ---- 接口动词（转发给当前后端；语义以本文件的注释为准，实现见 ./local.js）----
// 转发而不是解构：动词在**调用时**从当前后端取，后端将来若是有状态对象（连接池/远程会话）也不会丢 this。

/** 平台 → 本机 shell 事实 { file, name }。platform 是测试缝（夹具在任一台机器上断言两条臂）。 */
export const shellFor = (platform) => EXEC_BACKEND.shellFor(platform);

/** argv 级接缝①：命令串 → 完整 argv（argv[0] 是可执行文件）。纯函数，不真起进程。 */
export const argvFor = (line, platform) => EXEC_BACKEND.argvFor(line, platform);

/** argv 级接缝②：一次前台执行请求 → { command, args, options }（execFile 的选项）。纯函数。 */
export const execPlan = (request) => EXEC_BACKEND.execPlan(request);

/** argv 级接缝③：一次后台执行请求 → { command, args, options }（spawn 的选项）。纯函数。 */
export const spawnPlan = (request) => EXEC_BACKEND.spawnPlan(request);

/** 执行一条命令串 → { ok, code, out, err }（输出已按既有口径截断，形状即模型可见形状）。 */
export const execLine = (line, options) => EXEC_BACKEND.execLine(line, options);

/** 后台按 argv 起进程（detached 长任务）→ ChildProcess（stdio 由调用方给，通常是日志文件 fd）。 */
export const spawnLine = (line, options) => EXEC_BACKEND.spawnLine(line, options);

/** 杀进程树（Windows 上 taskkill /T /F，POSIX 上 SIGTERM）→ { killed, gone, detail }；真失败抛错。 */
export const killTree = (pid, options) => EXEC_BACKEND.killTree(pid, options);

/** 探测后端可用性 → { available, shellFile, ... }（只做可解析性检查，不真起进程）。 */
export const probe = (options) => EXEC_BACKEND.probe(options);
