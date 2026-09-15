// test/cmd-discipline.test.mjs - run_command 的两条规矩（2026-09-15）：
//   ① 换目录 = 参数（**改写** `cd X && 其余`，不拦不罚轮）——对齐 DSH `dsh-tool-bash` 的 workdir；
//   ② 读型别名（cat/ls/grep/find/sed/head…）**不再拦截**，只在结果里附一行提示。
//      原先的黑名单拦了它，理由是省 token；但输出层已有更好的机制（runCmd 8000 字符截断 + spill 落盘 +
//      result_bytes 遥测），再用"拦掉一整轮"做同一件事是拿更差的手段重复实现；DSH 也没有这种预拦。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { emitHooks, listHooks } from '../server/tools/hooks.js';
import { execTool } from '../server/tools/index.js';

const before = (args) => emitHooks('before', 'run_command', { args, ctx: {} });
const CTX = () => ({ permission: 'full', root: process.cwd(), conversationId: 0, accountId: 0, __signal: new AbortController().signal });

test('改写：`cd <目录> && 其余` → {cwd, cmd}（不再白花一轮），且改动前后都留痕', async () => {
  const r = await before({ cmd: 'cd /tmp && npm test --silent', timeout: 60 });
  assert.equal(r.stopped, false);
  assert.equal(r.rewrites.length, 1, '改写必须被记录（审计要能回答"模型原本要执行什么"）');
  assert.equal(r.rewrites[0].by, 'shell_cd_normalizer');
  assert.equal(r.rewrites[0].asked.cmd, 'cd /tmp && npm test --silent');
  assert.equal(r.rewrites[0].used.cmd, 'npm test --silent');
  assert.equal(r.rewrites[0].used.cwd, '/tmp');
  assert.equal(r.rewrites[0].used.timeout, 60, '其它参数必须原样保留');
});

test('改写必须声明 rewritesArgs（否则留痕机制不会认它）', () => {
  const h = listHooks().find((x) => x.name === 'shell_cd_normalizer');
  assert.ok(h, '换目录规范化钩子必须在注册表里');
  assert.equal(h.rewritesArgs, true, '会改写参数的钩子必须声明 rewritesArgs:true');
  assert.equal(h.failure, 'open', '它是引导/规范化，不是安全网，按设计 fail-open');
});

test('读型别名不再被拦（拦截已删除，且不许悄悄复活）', async () => {
  for (const cmd of ['ls -la', 'grep -rn x .', 'cat README.md', 'find . -name "*.js"', 'sed -i s/a/b/ f.txt', 'cd /tmp && grep -rn x .']) {
    const r = await before({ cmd });
    assert.equal(r.stopped, false, '不该拦：' + cmd);
  }
  // cd 前缀仍然只改写，不改写错的形态
  const ok = await before({ cmd: 'cd /tmp && grep -rn x .' });
  assert.equal(ok.rewrites[0].used.cmd, 'grep -rn x .');
});

test('猜不准的 cd 形态一律不改写（宁可原样执行，也不改错语义）', async () => {
  for (const cmd of ['cd $HOME && ls', 'cd "$(pwd)" && ls', 'cd a && cd b && npm test', 'echo hi && cd /tmp && ls', 'cd /tmp; ls']) {
    const r = await before({ cmd });
    assert.equal(r.rewrites.length, 0, '不该改写：' + cmd);
    assert.equal(r.stopped, false, '也不该拦（黑名单已删）：' + cmd);
  }
});

test('模型已给 cwd 时不再改写它写的 cd（不猜它想用哪个）', async () => {
  const r = await before({ cmd: 'cd sub && npm test', cwd: '/tmp' });
  assert.equal(r.rewrites.length, 0);
  assert.equal(r.stopped, false);
});

test('cwd 参数真的生效（不是只写进了 schema）', async () => {
  // 命令给 `process.cwd()` 加引号：bash 与 Windows PowerShell 都会剥掉引号再交给 node（2026-09-16 实测）。
  // 不加引号时 PowerShell 会把 `()` 当自己的语法解析而报错——那是"两种 shell 的语言差异"，不是本工具的问题；
  // 模型侧靠系统提示词里的"本机 shell 是哪一种"来规避（agent.js ENV_DISCIPLINE）。
  const r = await execTool('run_command', { cmd: 'node -p "process.cwd()"', cwd: 'server' }, CTX());
  const got = String(r.stdout || '').trim().split('\n').pop().replace(/\\/g, '/').toLowerCase();
  assert.equal(got, path.join(process.cwd(), 'server').replace(/\\/g, '/').toLowerCase(), 'cwd 必须传给子进程：' + JSON.stringify(r).slice(0, 160));
});

test('读型别名照常执行，但结果里带一行提示（提示不占常驻前缀）', async () => {
  const r = await execTool('run_command', { cmd: 'ls server' }, CTX());
  assert.notEqual(r.code, 'TOOL_HOOK_BLOCKED', '不得再被纪律拦截：' + JSON.stringify(r).slice(0, 160));
  // 提示按**命令首词**挂，与本次执行成败无关（Windows 上 ls 是 PowerShell 的内建别名，跑得通；提示照样要给）
  assert.match(String(r.hint || ''), /专门工具/, '应附提示：' + JSON.stringify(r).slice(0, 160));
  const plain = await execTool('run_command', { cmd: 'node -p 1+1' }, CTX());
  assert.equal(plain.hint, undefined, '非读型命令不该附提示');
});

test('cwd 越界在工具内部被拒（注：该分支只在 limitPath 为真时可达，见下方说明）', async () => {
  const { TOOLS } = await import('../server/tools/index.js');
  const tool = TOOLS.find((t) => t.name === 'run_command');
  // 说明（如实记）：execTool 只对 read/write 会话置 limitPath=true，而那两类会话又会在 checkPerm 处
  // 被 'full' 级要求拦下 —— 所以这条边界在主路径上其实**到不了**（与工具里既有的 write 级命令白名单同况）。
  // 直接调 run() 验证它本身是有效的，免得它悄悄烂掉；"这条分支到不了"作为现状登记，不在本轮顺手改。
  await assert.rejects(() => tool.run({ cmd: 'pwd', cwd: '..' }, { root: process.cwd(), limitPath: true }), /cwd 超出工作区/);
  await assert.rejects(() => tool.run({ cmd: 'pwd', cwd: path.join(process.cwd(), '..') }, { root: process.cwd(), limitPath: true }), /cwd 超出工作区/);
});
