// test/portability.test.mjs - 同一份代码在 Linux 与 Windows Server 上都能跑（D2′ 客户机交付）
//
// 为什么要有这份夹具：平台原先是照着"部署在 /srv 下的 Linux 机器"写的——平台目录、工作区、临时目录、
// 重启命令、命令执行方式都写死在代码里。换一台机器（客户机是 Windows Server）时，这些字面量不会报错，
// 只会让判断悄悄走错分支（自动提交把平台仓库当业务仓库、ralph 往盘根写、验收钩子永远 ENOENT）。
// 所以这里锁两类东西：
//   ① **推导规则**（环境事实从哪来）——断言关系，不断言具体路径，两边都成立；
//   ② **不该再出现的东西**（源码级不变量）——扫描 server/ 下所有 .js，字面量只允许出现在它该在的那一处。
// 结论出处是三处本机实测（2026-09-16，Windows 探针）：cmd.exe /c 会吞掉内层引号（返回空输出且 code=0）、
// PowerShell -Command 的引号/中文/emoji/退出码都对、path.relative 在盘根与大小写两种形态下都判得对。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RW_PLATFORM_DIR, RW_WORKSPACE, RW_FS_ROOT, RW_JOBS_DIR } from '../server/env.js';
import { shellFileFor, shellArgs, SHELL_FILE, SHELL_CN } from '../server/shell.js';
import { restartPlan, splitRestartCmd } from '../server/restart.js';
import { inside, TOOLS } from '../server/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';

test('环境事实由代码自身位置推导（换机器不用改代码）', () => {
  // 只在没被环境变量覆盖时断言"推导结果"，否则断言的是部署配置，不是推导规则
  if (!process.env.RW_PLATFORM_DIR) assert.equal(RW_PLATFORM_DIR, ROOT, '平台目录＝server/env.js 的上一级');
  if (!process.env.RW_WORKSPACE) assert.equal(RW_WORKSPACE, path.resolve(ROOT, '..', 'rw-workspace'), '工作区＝平台目录的兄弟目录（现行部署 /srv/harness-workbench + /srv/rw-workspace 正是这个关系）');
  assert.equal(RW_FS_ROOT, path.parse(RW_PLATFORM_DIR).root, '文件系统根＝平台目录所在盘的盘根（POSIX 上就是 /）');
  assert.ok(path.isAbsolute(RW_JOBS_DIR), '后台任务日志目录必须是绝对路径');
  if (!process.env.RW_JOBS_DIR) assert.equal(path.basename(RW_JOBS_DIR), 'rw-jobs');
});

test('server/ 下不再有平台专属路径与命令字面量（字面量只许留在它该在的那一处）', () => {
  // 允许保留的三处（各自是"某个平台的事实"的唯一落点）：
  //   env.js         —— 注释里解释"为什么不写死 /srv"
  //   restart.js     —— Linux 那一条臂就是 systemctl
  //   exec/local.js  —— POSIX 那一条臂就是 /bin/bash（2026-09-16 从 shell.js 搬来这里：实现挪进了执行后端层，
  //                     见 v0.3 §4.2「三层分离」的第三层 / §5 跨平台；shell.js 只剩门面，不再含平台字面量）
  const ALLOW = new Set(['env.js', 'restart.js']);
  // 平台层的**整个子树**都允许出现平台字面量（它们的职责就是"这一层是平台相关的"）：
  //   exec/    —— 执行后端（POSIX 那条臂就是 /bin/bash；Windows 那条是 powershell.exe / taskkill）
  //   sandbox/ —— 沙箱后端（bwrap / unshare / 将来 Windows 的 ACL runner）：v0.3 §4.6 + §7.1 ⑰
  const ALLOW_PREFIX = ['exec/', 'sandbox/'];
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const rel = path.relative(path.join(ROOT, 'server'), p);
      const relNorm = rel.replace(/\\/g, '/');
      if (ALLOW.has(relNorm) || ALLOW_PREFIX.some((p) => relNorm.startsWith(p))) continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const [re, what] of [[/\/srv\//, '/srv/'], [/\/tmp\//, '/tmp/'], [/\bsystemctl\b/, 'systemctl'], [/'\/bin\/bash'/, "'/bin/bash'"]]) {
        if (re.test(s)) bad.push(rel + ' 含 ' + what);
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  assert.deepEqual(bad, [], '这些字面量在客户机（Windows Server）上不成立，应改为从 env.js 取（平台事实一律落在 server/exec/ 的实现里）：' + bad.join('；'));
});

test('自我重启：有配置用配置，Linux 默认 systemctl，两者都没有时**如实说没有**（不假装重启过）', () => {
  const lin = restartPlan('linux', '', 'rw-test');
  assert.deepEqual(lin.argv, ['systemctl', 'restart', 'rw-test']);
  assert.equal(lin.how, 'systemctl');

  const win = restartPlan('win32', '', 'rw-test');
  assert.equal(win.argv, null, 'Windows 上没有通用重启命令，猜一个的代价是"把自己停死却没人拉起"');
  assert.equal(win.how, 'none');
  assert.match(win.hint, /RW_RESTART_CMD/);
  assert.match(win.hint, /restart!/, '要给出 WinSW 的正确填法（它的自我重启入口）');
  assert.match(win.hint, /sc stop|只停不起/, '要警告只停不起的命令（sc stop / nssm stop 会把服务停死）');

  const cfg = restartPlan('win32', '"C:\\Program Files\\WinSW\\rwtest.exe" restart!', 'rw-test');
  assert.deepEqual(cfg.argv, ['C:\\Program Files\\WinSW\\rwtest.exe', 'restart!'], '带空格的路径要按引号切开，不能按空格切');
  assert.equal(cfg.how, 'RW_RESTART_CMD');

  assert.equal(restartPlan('linux', 'nssm restart x', 'rw-test').how, 'RW_RESTART_CMD', '显式配置优先于平台默认');
  assert.equal(restartPlan('win32', '   ', 'rw-test').argv, null, '空白配置＝没配');
  assert.deepEqual(splitRestartCmd(''), []);
});

test('命令执行：按平台选 shell（两条臂都能在任一台机器上断言）', () => {
  assert.equal(shellFileFor('win32'), 'powershell.exe');
  assert.equal(shellFileFor('linux'), '/bin/bash');
  assert.equal(shellFileFor(), SHELL_FILE, '缺省＝本机');
  assert.ok(SHELL_CN.length > 0);

  assert.deepEqual(shellArgs('echo 1', 'linux'), ['-c', 'echo 1']);
  const w = shellArgs('echo 1', 'win32');
  assert.equal(w[w.length - 1].endsWith('echo 1'), true, '命令串必须是最后一个参数（-Command 的写法）');
  assert.ok(w.includes('-NoProfile') && w.includes('-NonInteractive'), '不要用户 profile、不要交互：无人值守运行的前提');
  assert.match(w[w.length - 1], /OutputEncoding/, '必须先设 UTF-8：不设则中文/emoji 按控制台代码页输出成乱码');
});

test('工作区边界判据：根自己、根下、越界、跨盘、大小写，五种形态都判对', () => {
  const root = path.join(ROOT, 'server');
  assert.equal(inside(root, root), true, '根自己算在内');
  assert.equal(inside(path.join(root, 'tools', 'index.js'), root), true);
  assert.equal(inside(path.join(root, '..', 'other'), root), false, '上跳一层必须判在外');
  // 这一条正是旧实现（拼 root + path.sep）会判错的：根是 '/' 或 'E:\\' 时拼出双分隔符，根下的任何路径都判成"在外"
  assert.equal(inside(path.join(RW_FS_ROOT, 'anywhere'), RW_FS_ROOT), true, '文件系统根之下的一切都在内');
  if (WIN) {
    // NTFS 大小写不敏感：字符串比较会把同一个目录判成"在外"
    assert.equal(inside(root.toUpperCase(), root), true, 'Windows 上大小写不同仍是同一目录');
    assert.equal(inside('C:\\Windows', RW_FS_ROOT), path.parse('C:\\Windows').root === RW_FS_ROOT, '跨盘按盘根判');
  }
});

test('write 级白名单不能被 shell 连接符绕过（单条简单命令才放行）', async () => {
  const tool = TOOLS.find((t) => t.name === 'run_command');
  const ctx = { permission: 'write', root: process.cwd(), limitPath: true };
  for (const cmd of ['ls; rm -rf x', 'cat a.txt | sh', 'pwd && rm -rf /', 'echo $(whoami)', 'ls > /tmp/x']) {
    await assert.rejects(() => tool.run({ cmd }, ctx), /单条/, '必须以白名单+单条双重判据拒绝：' + cmd);
  }
  await assert.rejects(() => tool.run({ cmd: 'curl http://x' }, ctx), /write 级/, '不在白名单里的命令仍然拒绝');
});

test('安全网在 Windows 形态下不是空网（声明 fail-closed 就必须真的拦得住）', async () => {
  const { emitHooks } = await import('../server/tools/hooks.js');
  const w = (p) => emitHooks('before', 'write_file', { args: { path: p }, ctx: {} });
  const c = (cmd) => emitHooks('before', 'run_command', { args: { cmd }, ctx: {} });
  // 系统关键区：POSIX（原有）+ Windows（本次补）
  assert.equal((await w('/etc/passwd')).stopped, true, 'POSIX 系统区仍要拦（原有行为不许退化）');
  assert.equal((await w('C:\\Windows\\System32\\drivers\\etc\\hosts')).stopped, true, 'Windows 系统区要拦');
  assert.equal((await w('C:\\Program Files\\x\\y.js')).stopped, true, 'Program Files 同样算系统区');
  // 业务目录不拦（拦的是"改坏操作系统"，不是"改平台自己的东西"）
  assert.notEqual((await w(path.join(ROOT, 'server', 'agent.js'))).stopped, true, '平台代码可正常写');
  assert.notEqual((await w('C:\\rw-test\\app\\server\\agent.js')).stopped, true, '客户机上的业务目录可正常写');
  // 危险动作：Windows 侧同类的不可逆动作
  assert.equal((await c('Stop-Computer')).stopped, true, '关机/重启要拦');
  assert.equal((await c('Format-Volume -DriveLetter D')).stopped, true, '格式化要拦');
  assert.equal((await c('rm -rf /')).stopped, true, 'POSIX 侧不许退化');
  assert.notEqual((await c('Get-ChildItem .')).stopped, true, '普通命令不拦');
});

test('run_test 走本机 shell（Windows 上 npm 只有 .cmd 形式，execFile 直呼必 ENOENT）', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server', 'tools', 'index.js'), 'utf8');
  assert.match(s, /runShellLine\('npm test'/, 'npm 必须经 shell 解析');
  assert.ok(!/runCmd\('npm'/.test(s), '不许回退成 execFile 直呼 npm');
});

test('代码里用到的 RW_* 环境事实，每个都要在本文件里 import 过（启动路径的"没引入"只能在真机上撞见）', () => {
  // 为什么要有这条：2026-09-16 我在 index.js 的启动回调里写了一句带 RW_PLATFORM_DIR 的日志，
  // **忘了它没被 import** —— 本地全量夹具全绿（没有夹具会真的去 boot index.js），一直到部署后看 journalctl
  // 才看见 `uncaughtException: ReferenceError: RW_PLATFORM_DIR is not defined`（幸好平台有全局兜底，
  // 服务没死）。这类"符号没引入"在本仓库历史上出现过两次（`result is not defined`、`hookStop is not defined`），
  // 共同点是**只在真实启动路径上出现**。所以这里做一条廉价的静态核对：把代码里的 RW_* 名字（先去掉注释，
  // 免得注释里提到某名字也误报）与"本文件 import 到的那几个"对齐。
  const ENV_EXPORTS = fs.readFileSync(path.join(ROOT, 'server', 'env.js'), 'utf8')
    .match(/export const (RW_[A-Z0-9_]+)/g).map((s) => s.replace('export const ', ''));
  // ⚠️ 先归一 CRLF 再剥注释（2026-09-16 由凭证/触发器那位同事撞出来的**夹具自身缺陷**）：
  // `/\/\/.*$/` 的 `$` 在 CRLF 文本里匹配不到行尾（行尾是 `\r`），于是"被注释掉的 RW_* 提及"会被当成真引用，
  // 报出假红（实测 `'x // RW_STORAGE y\r'.replace(/\/\/.*$/,'')` 原样返回）。工作区文件一旦被别的工具改成 CRLF
  // 就会触发——夹具自己先坏掉，比漏报更糟（会让人去改没错的代码）。
  const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js') && path.basename(p) !== 'env.js') files.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const code = strip(src);
    const imported = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*env\.js'/g)) {
      for (const name of m[1].split(',')) { const t = name.trim().split(/\s+as\s+/)[0]; if (t) imported.add(t); }
    }
    for (const name of ENV_EXPORTS) {
      const used = new RegExp('\\b' + name + '\\b').test(code);
      if (used && !imported.has(name)) bad.push(path.relative(ROOT, f) + ' 用了 ' + name + ' 但没 import');
    }
  }
  assert.deepEqual(bad, [], '这些会在真实启动/调用路径上抛 ReferenceError：' + bad.join('；'));
});

test('Windows 交付脚本必须带 UTF-8 BOM（否则 PowerShell 5.1 按 ANSI 解码，中文把脚本切坏）', () => {
  // 实测（2026-09-16，本机）：同一份 install-service.ps1，无 BOM 时 powershell.exe 的解析器报 12 个错
  // （`The string is missing the terminator`），补上 BOM 后 0 个错——Windows PowerShell 5.1 不带 BOM 就按
  // 系统 ANSI 代码页解码，中文注释变成乱码字节，字符串当场被截断。客户机上默认就是 5.1（Server 自带）。
  // 这条夹具防的是"以后有人用不带 BOM 的编辑器/工具改了脚本"——那是个不会报错、只在客户机上炸的坑。
  const dir = path.join(ROOT, 'scripts', 'windows');
  if (!fs.existsSync(dir)) return; // 还没交付 Windows 脚本时不阻塞
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ps1'))) {
    const b = fs.readFileSync(path.join(dir, f)).subarray(0, 3);
    assert.ok(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf, f + ' 必须带 UTF-8 BOM（前 3 字节 EF BB BF）');
  }
});

test('后台任务链路在本机真的跑得通（起进程 → 日志落在 RW_JOBS_DIR → 能按 jobId 读回 → 能终止）', async () => {
  // 这条是 D2′ 里"命令执行层 + 临时目录"两处改动的**真机端到端**：本机是 Linux 就跑 bash，是 Windows 就跑
  // PowerShell，两边的进程都要真的起来、日志真的落盘、持久化记录真的能读回。
  const CTX = { permission: 'full', root: ROOT, conversationId: 0, accountId: 0 };
  const t = (n) => TOOLS.find((x) => x.name === n);
  const r = await t('run_long_task').run({ cmd: `node -e "setTimeout(function(){}, 30000)"` }, CTX);
  try {
    assert.ok(r.jobId && Number(r.jobId) > 0, '要拿到真实 pid：' + JSON.stringify(r).slice(0, 200));
    assert.ok(String(r.log).startsWith(RW_JOBS_DIR), '日志必须落在 RW_JOBS_DIR（' + RW_JOBS_DIR + '），实际 ' + r.log);
    assert.ok(fs.existsSync(r.log), '日志文件必须真的被创建');
  } finally {
    const k = await t('kill_process').run({ pid: Number(r.jobId) }, CTX);
    assert.ok(k.killed === true || /已不存在/.test(String(k.note || '')), '进程要能被收掉（或如实说已不存在）：' + JSON.stringify(k));
  }
  const out = await t('job_output').run({ jobId: r.jobId }, CTX);
  assert.ok(out.jobId === r.jobId || out.persisted === true, '终止后仍要能按 jobId 读回（内存表或持久化记录）：' + JSON.stringify(out).slice(0, 200));
  const list = await t('job_list').run({}, CTX);
  assert.ok(Array.isArray(list.jobs) && list.jobs.length >= 1, 'job_list 要能列出它');
});
