// test/scheduler-context.test.mjs - 定时任务执行上下文的夹具
// 背景（实测真 bug，不是推测）：execTool 按 `ctx.permission` 决定是否限制路径
//   （tools/index.js: `limitPath = ctx.permission === 'read' || ctx.permission === 'write'`）。
//   scheduler 原先只把 permission 传给 runAgent 顶层参数、**没放进 ctx** →
//   所有定时任务都被当成受限会话，一律被围栏限制在 RW_WORKSPACE 内，与任务配置的 permission=full 不符。
//   实测现象：task#7 的提示里让跑 `git -C /srv/harness-workbench …`、读 `/srv/harness-workbench/scripts/...`，
//   连续 7 次被拒 "路径超出工作区（本会话权限只允许访问 /srv/rw-workspace）"。
// 本夹具把"ctx 带上权限"钉成不可回归的判据（不需要 DB，纯算子）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskExecContext } from '../server/scheduler.js';
import { RW_FS_ROOT } from '../server/env.js';

test('full 权限任务：ctx.permission=full 且 root=文件系统根（不受工作区围栏限制）', () => {
  const ctx = taskExecContext({ account_id: 1, permission: 'full' }, 42);
  assert.equal(ctx.permission, 'full');
  // "不受围栏"的判据是**推导出来的文件系统根**（Linux 上是 '/'，Windows 上是盘根）：
  // 以前这里写死 '/'，在客户机上会变成"当前盘根"以外的另一种意思，且 spawn(cwd='/') 在 Windows 上无效。
  assert.equal(ctx.root, RW_FS_ROOT);
  assert.equal(ctx.conversationId, 42);
  assert.equal(ctx.accountId, 1);
});

test('read 权限任务：ctx.permission=read，root 落在工作区（围栏生效）', () => {
  const ctx = taskExecContext({ account_id: 1, permission: 'read' }, 7);
  assert.equal(ctx.permission, 'read');
  assert.notEqual(ctx.root, RW_FS_ROOT);
  assert.ok(String(ctx.root).length > 1);
});

test('未配置权限的任务：按 full 处理（与 executor 的 `task.permission || full` 同口径）', () => {
  const ctx = taskExecContext({ account_id: 1 }, 1);
  assert.equal(ctx.permission, 'full');
  assert.equal(ctx.root, RW_FS_ROOT);
});

test('负例：ctx 里必须有 permission 键（缺了它 execTool 会把会话当受限会话）', () => {
  const ctx = taskExecContext({ account_id: 1, permission: 'full' }, 1);
  assert.ok('permission' in ctx, 'ctx 必须显式带 permission，否则 limitPath 判定会走错分支');
  assert.notEqual(ctx.permission, undefined);
});

test('会话所属壳会被带上（壳级 schema/MCP 裁剪需要它）', () => {
  const ctx = taskExecContext({ account_id: 1, permission: 'full' }, 9, { shell_id: 3 });
  assert.equal(ctx.shellId, 3);
  const ctx2 = taskExecContext({ account_id: 1, permission: 'full' }, 9, null);
  assert.equal(ctx2.shellId, null);
});
