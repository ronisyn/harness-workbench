// test/cmd-discipline.test.mjs - 命令纪律：换目录**改写**而不是拦截（2026-09-15，对齐 DSH dsh-tool-bash）
//
// 为什么改：DSH 的 bash 工具带 `workdir` 参数，描述里明说 "pass `workdir` instead of using `cd`"，
// 模型因此根本不必写 cd；全量扫 DSH 也没有任何"别用 shell，去用专门工具"的预拦钩子。
// 我们此前缺这个参数，模型只能 `cd X && ...`，于是近 14 天 65 次纪律拦截里 40 次是 cd（真库实测）——每
// 次都白花一轮。现在：`cd <简单目录> && 其余` 直接改写为 {cwd, cmd}（改写要留痕），其余形态照旧拦。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { emitHooks, listHooks } from '../server/tools/hooks.js';
import { execTool } from '../server/tools/index.js';

const before = (args) => emitHooks('before', 'run_command', { args, ctx: {} });

test('改写：`cd <目录> && 其余` → {cwd, cmd}（不再白花一轮），且改动前后都留痕', async () => {
  const r = await before({ cmd: 'cd /tmp && npm test --silent', timeout: 60 });
  assert.equal(r.stopped, false);
  assert.equal(r.rewrites.length, 1, '改写必须被记录（审计要能回答"模型原本要执行什么"）');
  assert.equal(r.rewrites[0].by, 'shell_readonly_guard');
  assert.equal(r.rewrites[0].asked.cmd, 'cd /tmp && npm test --silent');
  assert.equal(r.rewrites[0].used.cmd, 'npm test --silent');
  assert.equal(r.rewrites[0].used.cwd, '/tmp');
  assert.equal(r.rewrites[0].used.timeout, 60, '其它参数必须原样保留');
});

test('改写必须声明 rewritesArgs（否则留痕机制不会认它）', () => {
  const h = listHooks().find((x) => x.name === 'shell_readonly_guard');
  assert.ok(h, '命令纪律钩子必须在注册表里');
  assert.equal(h.rewritesArgs, true, '会改写参数的钩子必须声明 rewritesArgs:true');
});

test('不给绕过口：`cd X && grep ...` 改写后仍按**改写后的**命令判纪律 → 照拦', async () => {
  const r = await before({ cmd: 'cd /tmp && grep -rn x .' });
  assert.equal(r.stopped, true, 'cd 前缀不得成为绕过纪律的口子');
  assert.match(r.reason, /grep 有专门工具/);
});

test('裸别名照旧拦；sed -i 仍走原豁免', async () => {
  assert.equal((await before({ cmd: 'ls -la' })).stopped, true);
  assert.equal((await before({ cmd: 'grep -rn x .' })).stopped, true);
  assert.equal((await before({ cmd: 'sed -i s/a/b/ f.txt' })).stopped, false, 'sed -i 是改文件，不在读型别名之列');
});

test('猜不准的 cd 形态一律不改写（宁可拦，也不改错语义）', async () => {
  for (const cmd of ['cd $HOME && ls', 'cd "$(pwd)" && ls', 'cd a && cd b && npm test', 'echo hi && cd /tmp && ls', 'cd /tmp; ls']) {
    const r = await before({ cmd });
    assert.equal(r.rewrites.length, 0, '不该改写：' + cmd);
  }
});

test('模型已给 cwd 时又写 cd：拦下并说明两者会打架（不猜它想用哪个）', async () => {
  const r = await before({ cmd: 'cd sub && npm test', cwd: '/tmp' });
  assert.equal(r.stopped, true);
  assert.match(r.reason, /会打架/);
});

test('cwd 参数真的生效（不是只写进了 schema）', async () => {
  const base = { permission: 'full', root: process.cwd(), conversationId: 0, accountId: 0, __signal: new AbortController().signal };
  const sub = path.join(process.cwd(), 'server');
  // 注意命令里不能带引号：run_command 是 execFile 直调（不过 shell），引号会被原样传给子进程（"shell 引号易出错"那条限制）
  const r = await execTool('run_command', { cmd: 'node -p process.cwd()', cwd: 'server' }, base);
  const got = String(r.stdout || '').trim().split('\n').pop();
  assert.equal(got.replace(/\\/g, '/').toLowerCase(), sub.replace(/\\/g, '/').toLowerCase(), 'cwd 必须传给子进程：' + JSON.stringify(r).slice(0, 160));
});

test('cwd 越界在工具内部被拒（注：该分支只在 limitPath 为真时可达，见下方说明）', async () => {
  const { TOOLS } = await import('../server/tools/index.js');
  const tool = TOOLS.find((t) => t.name === 'run_command');
  // 说明（如实记）：execTool 只对 read/write 会话置 limitPath=true，而那两类会话又会在 checkPerm 处
  // 被 'full' 级要求拦下 —— 所以这条边界在主路径上其实**到不了**（与工具里既有的 write 级命令白名单同况）。
  // 直接调 run() 验证它本身是有效的，免得它悄悄烂掉；"这条分支到不了"作为现状登记，不在本轮顺手改。
  // cmd 用 'pwd'：write 级的白名单（ls/cat/pwd/echo/find/grep…）先于 cwd 检查，用白名单外的命令会先被它拦下
  await assert.rejects(() => tool.run({ cmd: 'pwd', cwd: '..' }, { root: process.cwd(), limitPath: true }), /cwd 超出工作区/);
  await assert.rejects(() => tool.run({ cmd: 'pwd', cwd: path.join(process.cwd(), '..') }, { root: process.cwd(), limitPath: true }), /cwd 超出工作区/);
});
