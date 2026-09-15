// server/sandbox/policy.js - 沙箱**策略**：会话权限档 → 沙箱模式；"哪些工具走沙箱"的口径
//
// 分层照 DSH（先问规矩，源码 `dsh-sandbox-policy/lib/index.js`）：
//   · DSH 是「`dsh-sandbox`（服务/接口）+ `dsh-sandbox-policy`（策略：默认模式 + 每会话解析）+ 实现」三层；
//     策略是**独立的一层**，因为"这次该用哪个模式"与"用哪个 runner 去实现它"是两件事
//     （同一台机器上，read 会话与 write 会话的模式不同，但 runner 是同一个）。
//   · DSH 的模式词汇是 `read-only` / `workspace-write` / `danger-full-access`；本文件照用前两个，
//     第三个**不用它的名字**：我们的 `full` 权限语义就是"不沙箱"，叫它 danger-full-access 只是换个说法，
//     而 §4.6 要求的是**如实上报**（full 会话的 enforcement 必须落 partial/none，不能因为"没沙箱"就报 full）。
//
// 依据：v0.3 §4.6「沙箱：服务 + 按平台后端」、§0.2 G1「沙箱可替换」、§7.1 ⑰；
//      《v0.3-符合性核对-20260916》§2.3 的"六件"第 1 件（策略）。
// 纯函数、不碰进程、不碰 DB —— 策略必须能被夹具直接断言（与 `exec/local.js` 的 argv 接缝同一取向）。

/** DSH 的模式词汇（本平台用到前两个；`full-access` 是"不沙箱"的那个档，见上面注释）。 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'full-access']);

/**
 * 会话权限档 → 沙箱模式（v0.3 §4.6 / 符合性核对 §2.3 第 1 件，逐档对应关系是**要求**不是发明）：
 *   `read`  → `read-only`        （只读会话：除了工作区/临时区，一个字节都不许落盘）
 *   `write` → `workspace-write`  （写会话：只有工作区可写）
 *   `guard` → `workspace-write`  （guard = full 级能力 + **逐次审批**；沙箱这一维它按写会话处理 ——
 *                                 它的额外约束在审批层，不在沙箱层，两件事不互相替代）
 *   `full`  → `full-access`      （不沙箱。§4.6 的原文是这条要**如实降级上报**，不是"full 就免报"）
 * 未知档一律落到最紧的 `read-only`：拿不准时收紧，与 hooks.js 的 fail-closed 同一条纪律。
 * @param {string} permission 会话权限档
 * @returns {'read-only'|'workspace-write'|'full-access'}
 */
export function modeForPermission(permission) {
  switch (permission) {
    case 'read': return 'read-only';
    case 'write': return 'workspace-write';
    case 'guard': return 'workspace-write';
    case 'full': return 'full-access';
    default: return 'read-only';
  }
}

/**
 * 一次会话的完整沙箱策略：模式 + 可写根 + 一句能给用户看的理由。
 * 工作区根的取法与 `server/tools/index.js` 的既有口径一致（full 会话的 root 是 RW_FS_ROOT，其余是工作区），
 * 这里不发明第二套：`root` 由调用方传（它已经算好了），本函数只负责"模式与根的关系"。
 * @param {{permission?:string, root?:string, workspace?:string}} ctx
 * @returns {{permission:string, mode:string, workspaceRoot:string, sandboxed:boolean, why:string}}
 */
export function policyFor(ctx = {}) {
  const permission = String(ctx.permission || 'full');
  const mode = modeForPermission(permission);
  const workspaceRoot = String(ctx.root || ctx.workspace || process.cwd());
  return {
    permission,
    mode,
    workspaceRoot,
    sandboxed: mode !== 'full-access',
    why: mode === 'full-access'
      ? '本会话权限=full：按 §4.6 不沙箱，但**必须如实降级上报**（enforcement 记 partial/none，不许记 full）'
      : '权限 ' + permission + ' → 模式 ' + mode + '，可写根 ' + workspaceRoot,
  };
}

/**
 * "哪些工具走沙箱"的口径（照 DSH 的**按子系统适配器**思路：`dsh-bash-sandbox` / `dsh-fs-sandbox` /
 * `dsh-pwsh-sandbox` 各管一个子系统，而不是给每个工具单独配一个开关）。
 *
 * 本轮只覆盖 §2.3 点名的两条**子系统**（"先覆盖命令执行与文件写入两条"）：
 *   · `command` = 起进程的子系统（run_command / run_long_task / run_test）→ 包 argv 起进程（DSH 的 bash 适配器同形）
 *   · `fs`      = 平台自己写文件的子系统（write_file / append_file / edit_file / copy_move / mkdir / delete_file）→
 *                 由 `server/tools/index.js` 的 `ctx.limitPath` + `inside()` 围栏承担
 *
 * ⚠️ 如实说明（这是本节最容易被读成"已覆盖"的地方）：
 *   ① **`fs` 这一半今天由进程内围栏（第 3 层）承担，不是沙箱**。为什么不在进程内也去调 `confine()`：
 *      沙箱 runner 包的是**子进程 argv**（DSH 的 `argv(spec)` 接缝就是这个形状），而 write_file 是
 *      Node 进程内的 `fs.writeFileSync`——那一半 DSH 用的是**另一个适配器**（`dsh-fs-sandbox`，
 *      在文件操作入口判定包含关系）。我们**已经有**同一个东西：`limitPath` + `inside()`（tools/index.js）。
 *      所以这里不重造第二个，只把口径写清：**命令走 runner，文件走围栏**。
 *   ② 权柄档为 `full` 的会话，`limitPath=false`，即**连围栏也不生效**（第 3 层在清单里因此报 partial）——
 *      这一条在 `capabilities.js` 里已经写了，本模块不改它的口径，只是让沙箱模式与它一致。
 *   ③ 不在表里的工具（网络/DB/知识库等）**不走沙箱**，它们各自的风险面是另外的层（第 4 层网络出口等），
 *      别把这张表读成"工具面已全覆盖"。
 */
export const SANDBOXED_TOOLS = Object.freeze({
  command: Object.freeze(['run_command', 'run_long_task', 'run_test']),
  fs: Object.freeze(['write_file', 'append_file', 'edit_file', 'copy_move', 'mkdir', 'delete_file']),
});

/**
 * 某工具归哪个子系统（不在表里 = 不走沙箱，如实返回 null，不默认归类）。
 * @param {string} toolName
 * @returns {'command'|'fs'|null}
 */
export function subsystemOf(toolName) {
  const n = String(toolName || '');
  if (SANDBOXED_TOOLS.command.includes(n)) return 'command';
  if (SANDBOXED_TOOLS.fs.includes(n)) return 'fs';
  return null;
}
