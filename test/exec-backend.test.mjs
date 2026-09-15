// test/exec-backend.test.mjs - 执行后端层（v0.3 §4.2 三层分离的第三层「执行后端」+ §5 跨平台）
//
// 为什么要有这份夹具：⑯（双平台执行后端）此前**没有抽象**——`server/shell.js` 只有"按平台选 shell"的实现，
// 没有接口、也没有"换一个后端"的位置，于是 ⑰（沙箱服务与分级，依赖 ⑯）无处可挂；⑰ 要做的是**argv 级**的
// confinement runner 包装（照 DSH `dsh-bash-sandbox` 包 `dsh-bash-local` 的 argv(spec)），所以本轮把那个
// 接缝单独摆出来，并且**必须有机检**：接缝包不包得住、包成什么 argv，不能靠"设计上应该没问题"。
//
// 三件事：
//   ① argv 级接缝：给定一次执行请求 → 最终 argv + spawn 选项（**纯函数**，夹具不真起进程；Linux/Windows
//      两条臂在任一台机器上都能断言，靠的是 platform 测试缝）；
//   ② 选择点：RW_EXEC_BACKEND 默认 local；未知名字**如实抛错**，绝不静默回落（§4.6「禁止静默降级」同一条纪律）；
//   ③ 回归：`server/shell.js` 的对外行为与改造前**逐字相同**——金标是改造前那份实现的字面量（写死在本文件里，
//      不从新代码读出来，否则就成了拿新代码校验新代码）。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RW_OS, RW_EXEC_BACKEND } from '../server/env.js';
import { shellFileFor, shellArgs, SHELL_FILE, SHELL_CN, runShellLine, spawnShellLine } from '../server/shell.js';
import {
  EXEC_BACKEND, EXEC_BACKEND_NAME, BACKEND_NAMES, selectBackend, assertBackend,
  argvFor, execPlan, spawnPlan, execLine, killTree, probe,
} from '../server/exec/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

// 改造前（2026-09-16 之前 server/shell.js:18,22-32）的字面量：**回归金标**。
// 写死在这里是刻意的：本文件的第 ③ 组断言要证明"改造前后逐字相同"，金标若从新代码里取就同义反复了。
const PS_PREAMBLE_GOLD = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const WIN_SHELL_ARGV_GOLD = (s) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_PREAMBLE_GOLD + s];

// ---- ① argv 级接缝（纯函数；沙箱将来只在这一层包）----

test('argv 接缝① Linux 臂：/bin/bash -c + 命令串原样（任一台机器上都能断言）', () => {
  const line = 'cd /srv/x && grep -n "中文" a.txt | wc -l';
  assert.deepEqual(argvFor(line, 'linux'), ['/bin/bash', '-c', line], '命令串必须是**一个**参数原样带过去（引号/管道/重定向/变量都归 shell 解析）');
  assert.deepEqual(argvFor('echo 1', 'darwin'), ['/bin/bash', '-c', 'echo 1'], '非 win32 一律 bash -c（与改造前 shellFileFor 的判据一致）');

  const p = execPlan({ line, platform: 'linux', cwd: '/srv/x', timeout: 1234 });
  assert.equal(p.command, '/bin/bash');
  assert.deepEqual(p.args, ['-c', line]);
  assert.deepEqual(p.options, { timeout: 1234, windowsHide: true, maxBuffer: 2 * 1024 * 1024, cwd: '/srv/x' });

  const noCwd = execPlan({ line: 'echo 1', platform: 'linux' });
  assert.equal('cwd' in noCwd.options, false, '没给 cwd 就不该带这个键（改造前就是 ...(cwd ? { cwd } : {})）');
  assert.equal(noCwd.options.timeout, 30000, '超时缺省沿用既有值 30s，不新造一个数');
});

test('argv 接缝① Windows 臂：powershell.exe -Command + UTF-8 前言（命令串是最后一个参数）', () => {
  const line = 'node -p "process.cwd()"';
  const argv = argvFor(line, 'win32');
  assert.equal(argv.length, 6);
  assert.equal(argv[0], 'powershell.exe');
  assert.deepEqual(argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(argv[5], PS_PREAMBLE_GOLD + line);
  assert.ok(argv[5].startsWith(PS_PREAMBLE_GOLD), '先设 UTF-8：不设的话中文/emoji 按控制台代码页输出成乱码（照抄 DSH ENCODING_PREAMBLE）');
  assert.ok(argv[5].endsWith(line), '命令串原样结尾，中间不许再套一层转义（PowerShell 自己解析这段文本）');

  const sp = spawnPlan({ line, platform: 'win32', cwd: 'C:\\x', stdio: ['ignore', 1, 1] });
  assert.equal(sp.command, 'powershell.exe');
  assert.deepEqual(sp.args, argv.slice(1));
  assert.equal(sp.options.cwd, 'C:\\x');
  assert.equal(sp.options.detached, true, '后台长任务默认 detached（改造前沿用）');
  assert.deepEqual(sp.options.stdio, ['ignore', 1, 1]);
  assert.equal(sp.options.windowsHide, true);
});

test('argv 接缝在**真实执行路径**上生效（不是摆设）：把前端指到本机不存在的 shell，报错必须来自那条臂', async () => {
  // 这条是"沙箱只包这一层"的前提：如果 execLine 自己另拼一份 argv，接缝就是装饰品。
  // 实测（tmp/exec-diff.mjs 的 Linux 臂，本机是 Windows）：起不来时 execFile 把错交给**回调**
  // （code='ENOENT'、err 为空串），`ch.on('error')` 那句"shell 启动失败"在这条路上根本到不了——
  // 改造前后都是这样（差分 12/12 逐字相同），所以夹具按**现状**钉，不按注释里的设想钉；落差只报告不顺手改。
  const r = WIN ? await execLine('echo 1', { platform: 'linux' }) : await execLine('echo 1', { platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ENOENT', '必须真的走了那条臂的可执行文件（本机没有它 ⇒ ENOENT）：' + JSON.stringify(r));
  assert.equal(r.out, '');
});

// ---- ② 选择点（单一出处；未知名字如实抛错）----

test('选择点：默认 local；未知后端**如实抛错**，不静默回落', () => {
  assert.equal(String(RW_EXEC_BACKEND).length > 0, true);
  assert.deepEqual([...BACKEND_NAMES], ['local'], '"有哪些后端"只有一个出处（实现表）');
  assert.equal(selectBackend().id, 'local', '缺省＝RW_EXEC_BACKEND，而它的缺省是 local');
  assert.equal(EXEC_BACKEND.id, 'local');
  assert.equal(EXEC_BACKEND_NAME, EXEC_BACKEND.id);
  for (const bad of ['docker', 'remote', 'LOCAL', 'local ', '']) {
    assert.throws(() => selectBackend(bad), /未知执行后端/, '未知名字必须如实抛错（静默回落成 local 是最坏的一类错：以为换了后端，其实没换）：' + JSON.stringify(bad));
  }
  assert.throws(() => selectBackend('docker'), /RW_EXEC_BACKEND 可选：local/, '错误信息要说清可选值，否则运维只能读代码');
});

test('后端不满足接口时在**装配期**就抛（缺动词/缺 id，不等到第一次调用）', () => {
  assert.throws(() => assertBackend('x', { id: 'x', argvFor() {} }), /缺动词 .*execLine/, '少一个动词也不许装起来');
  // 2026-09-16（⑯ 拍板＝甲）：接口新增四个 argv 级动词（execArgv/spawnArgv/execShell/spawnShell，⑰ 沙箱的
  // 接线点）。它们同样是接口的一部分——少一个也不许装起来（断言没放宽，只是跟着接口一起长）。
  const ARGV_VERBS = { execArgv() {}, spawnArgv() {}, execShell() {}, spawnShell() {} };
  const impl8 = { id: 'x', shellFor() {}, argvFor() {}, execPlan() {}, spawnPlan() {}, execLine() {}, spawnLine() {}, killTree() {}, probe() {} };
  assert.throws(() => assertBackend('x', impl8), /缺动词 .*execArgv/, '新增的 argv 级动词少一个也不许装起来');
  const { id: _omit, ...noId } = { ...impl8, ...ARGV_VERBS };
  assert.throws(() => assertBackend('x', noId), /缺 id/);
  assert.equal(assertBackend('x', { id: 'x', ...impl8, ...ARGV_VERBS }).id, 'x', '满足接口的实现要能装起来');
});

test('RW_EXEC_BACKEND 指到不存在的后端时**进程起不来**（启动即失败，不是运行到一半才发现）', async () => {
  const url = pathToFileURL(path.join(ROOT, 'server', 'exec', 'index.js')).href;
  const load = (backend) => new Promise((resolve) => {
    execFile(process.execPath, ['-e', 'import(' + JSON.stringify(url) + ')'],
      { env: { ...process.env, RW_EXEC_BACKEND: backend } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stderr }));
  });
  const good = await load('local');
  assert.equal(good.ok, true, 'local 必须能装载（这条同时是下面那条的对照，证明不是"怎么都失败"）：' + good.stderr);
  const bad = await load('docker');
  assert.equal(bad.ok, false, '未知后端必须让进程起不来');
  assert.match(bad.stderr, /未知执行后端/, '错误要说明白：' + bad.stderr.slice(0, 300));
});

// ---- ③ 回归：shell.js 的对外行为与改造前逐字相同 ----

test('回归：shell.js 的对外 argv 与改造前**逐字相同**（金标写死在上面）', () => {
  assert.equal(shellFileFor('win32'), 'powershell.exe');
  assert.equal(shellFileFor('linux'), '/bin/bash');
  assert.equal(shellFileFor(), SHELL_FILE, '缺省＝本机');
  assert.equal(SHELL_FILE, WIN ? 'powershell.exe' : '/bin/bash');
  assert.equal(SHELL_CN, WIN ? 'Windows PowerShell' : 'bash');

  assert.deepEqual(shellArgs('echo 1', 'linux'), ['-c', 'echo 1']);
  assert.deepEqual(shellArgs('echo 1', 'win32'), WIN_SHELL_ARGV_GOLD('echo 1'));
  assert.deepEqual(shellArgs('echo 1'), WIN ? WIN_SHELL_ARGV_GOLD('echo 1') : ['-c', 'echo 1'], '缺省＝本机');
  // 非字符串输入按 String() 处理（改造前也是 String(line)，模型偶尔会传数字）
  assert.deepEqual(shellArgs(123, 'linux'), ['-c', '123']);
  // shellArgs 就是 argv 接缝去掉 argv[0]：两者不许各算一份
  assert.deepEqual(shellArgs('x | y', 'win32'), argvFor('x | y', 'win32').slice(1));
});

test('回归：门面真跑一条命令串（门面→后端→真进程），输出/退出码/截断口径都不变', async () => {
  const ok = await runShellLine('node -e "console.log(1+1)"');
  assert.equal(ok.ok, true);
  assert.equal(ok.code, 0);
  assert.equal(ok.out.trim(), '2');
  assert.equal(ok.err, '');

  const bad = await runShellLine('node -e "process.exit(3)"');
  assert.equal(bad.ok, false, '非零退出必须如实报成失败');
  assert.notEqual(Number(bad.code), 0, '退出码要如实透传（实测：Windows PowerShell 5.1 把任何非零退出都报成 1，'
    + 'POSIX 上 bash 给的是真实码 3——这是平台既有的差异，不是本次改造引入的，差分脚本两边逐字相同）：' + JSON.stringify(bad));

  // 截断口径（头 70% + 尾 20% + 中段提示）：这条是"下一次把四个调用点切过来时模型可见字节不变"的底线
  const big = await runShellLine('node -e "console.log(String(1).repeat(12000))"');
  assert.equal(big.ok, true);
  assert.ok(big.out.length < 12000, '超长输出必须被截断（cap 8000，既有口径）：实际 ' + big.out.length);
  assert.match(big.out, /输出超长已截断中段 \d+ 字符/);
  assert.ok(big.out.startsWith('1'.repeat(5600)), '保留头 70%（5600）');
  // 尾窗口是**最后 1600 个字符**，而 stdout 末尾那个换行已经吃掉了窗口里的一个位置（POSIX 是 \n，Windows 是 \r\n），
  // 所以这里判"窗口里几乎全是 1"而不是逐字相等——窗口大小与中段计数才是本轮的回归对象。
  assert.ok(/^1{1500,}\s*$/.test(big.out.slice(-1600)), '保留尾 20%（1600 字符窗口）：' + JSON.stringify(big.out.slice(-1600).slice(0, 40)));

  // 门面 == 接口（转发不是"再实现一份"）
  const viaFacade = await runShellLine('node -e "console.log(42)"');
  const viaInterface = await execLine('node -e "console.log(42)"');
  assert.deepEqual(viaFacade, viaInterface);
});

test('回归：spawnShellLine 仍按 argv 起 detached 进程（run_long_task 那条路），且能被 killTree 收掉', async () => {
  const child = spawnShellLine('node -e "setTimeout(function(){}, 30000)"');
  try {
    assert.ok(Number(child.pid) > 0, '要拿到真实 pid（run_long_task 就是拿它当 jobId）');
    const r = await killTree(child.pid);
    assert.ok(r.killed === true || r.gone === true, '自己起的进程必须收得掉：' + JSON.stringify(r));
  } finally {
    try { child.kill(); } catch { /* 已经收掉了 */ }
  }
});

test('killTree：真的收掉进程；已退出的进程如实说"已不存在"（不假装成功）', async () => {
  const live = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 30000)'], { stdio: 'ignore', windowsHide: true });
  // 先挂 exit 监听再杀：杀完才挂会漏掉已经发生过的事件（夹具自己的竞态，不是产品的问题）
  const liveExit = new Promise((res) => live.on('exit', res));
  const killed = await killTree(live.pid);
  assert.equal(killed.killed, true, '活着的进程要真收掉（Windows 走 taskkill /T /F，POSIX 走 SIGTERM）：' + JSON.stringify(killed));
  assert.equal(killed.gone, false);
  await liveExit;

  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  const deadExit = new Promise((res) => dead.on('exit', res));
  await deadExit;
  const gone = await killTree(dead.pid);
  assert.equal(gone.killed, false, '已经不在了就是没收到，不许报 killed=true');
  assert.equal(gone.gone, true, '要如实区分"已不存在"（常态）与"终止失败"（抛错）：' + JSON.stringify(gone));
});

test('probe：本机后端自认可用，平台臂给出各自的可执行文件名（只做可解析性检查，不冒充功能性探针）', () => {
  const p = probe();
  assert.equal(p.id, 'local');
  assert.equal(p.platform, RW_OS);
  assert.equal(p.shellFile, SHELL_FILE);
  assert.equal(p.available, true, '本机连夹具都在跑子进程，后端必须自认可用：' + JSON.stringify(p));
  assert.equal(p.functional, false, '功能性探针（真起一次进程）属 ⑰，这里不许冒充');
  assert.match(p.detail, /可解析到/);

  assert.equal(probe({ platform: 'win32' }).shellFile, 'powershell.exe');
  assert.equal(probe({ platform: 'linux' }).shellFile, '/bin/bash');
  assert.equal(probe({ platform: WIN ? 'win32' : 'linux' }).available, true, '本机平台那一条臂必须可解析到（Windows Server 2019/2022 自带 powershell.exe）');
});
