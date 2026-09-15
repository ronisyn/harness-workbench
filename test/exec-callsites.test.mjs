// test/exec-callsites.test.mjs - ⑯（双平台执行后端）的**调用点**夹具：每个真正起进程的调用点都必须走执行后端
//
// 为什么要有这份夹具：⑯ 的实质不是"把接口抽出来"，而是**每个起进程的调用点都改成走它**——抽象再漂亮，
// 只要有一个调用点绕过它直呼 execFile，换平台/加 argv 级包装（⑰ 沙箱）就在那一处失效，而且失效是**静默**的：
// 本机（开发机）一切正常，只有客户机或沙箱生效时才现形。所以这里要的不是"源码里有 execLine 这个字符串"
// （把调用点改回 execFile 直呼，字符串还在），而是**注入缝**：用 module.register 的 load 钩子把
// `server/exec/index.js`、`server/sandbox/index.js`（以及驱动夹具要用的 db/agent）换成"可计数、可替换"的壳
// ——调用点若真的走那条路，它的行为就必须跟着 stub 变；绕过去的调用点，stub 对它没有任何影响。
//
// 五组：
//   ① 注入缝：run_command(full) → execShell、kill_process → killTree、run_long_task → spawnShell 跟着 stub 变；
//   ② 真实命令串（引号/空格 + Windows 上 npm/npx 只有 .cmd 形式）经调用点跑通，且与**改造前那份实现**
//      （金标字面量写在本文件里，不从新代码读）逐字一致，结果键名/形状也不变；
//   ③ ⑰ 沙箱接线三件事：(a) 模型可影响的那几路真的经 `confine()`（换 stub，执行的命令就换）、
//      (b) `enforcement:'none'` 时照常执行且不谎报、(c) `RW_SANDBOX_REQUIRED=1` 且拿不到 runner 时**如实拒绝**；
//   ④ 清单不变量：server/ 下能直接起进程的文件只剩执行后端与沙箱后端；沙箱例外（q1）逐条列名并写清理由；
//   ⑤ 驱动器那条验收路径（driver.js）：经 db/agent 注入缝驱动一轮契约，证明它也走后端 argv 接缝；
//      另钉住 q2：MCP 的"要不要 shell 透传"由后端按平台决定，引擎层不再有平台判据；
//   ⑥ 驱动器那条**组装路径**（driver.js 的历史读取）按 v0.3 §4.4.1 规则1 必须"全量、原样、升序"进请求
//      （复用 ⑤ 的 db/agent 注入缝：驱动器没有可直测的导出，它这一轮的 messages 只在 runAgent 处看得见）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RW_JOBS_DIR, RW_WORKSPACE } from '../server/env.js'; // 只依赖"环境事实"：env.js 不 import 执行后端，不会把注入缝提前用掉

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const url = (rel) => pathToFileURL(path.join(ROOT, 'server', rel)).href;

// ---- 注入缝本体 ----
// 内嵌源码用**字符串数组**拼，不用模板字面量：本仓库被"嵌套模板/反引号"咬过一次。
const REAL_EXEC = url('exec/index.js');
const REAL_SANDBOX = url('sandbox/index.js');
// 执行后端接口的动词表（⑯ 拍板＝甲后新增四个 argv 级动词；夹具跟着接口一起长）
const VERBS = ['shellFor', 'argvFor', 'execPlan', 'spawnPlan', 'execLine', 'spawnLine', 'killTree', 'probe',
  'execArgv', 'spawnArgv', 'execShell', 'spawnShell'];

const EXEC_SHIM = [
  'import * as real from ' + JSON.stringify(REAL_EXEC + '?real') + ';',
  // 真模块用带查询串的 URL 再取一次：带查询串的 URL 不被钩子拦截（否则壳会 import 自己，无限递归）
  'export * from ' + JSON.stringify(REAL_EXEC + '?real') + ';',
  'function wrap(name) {',
  '  return function (...args) {',
  '    const hits = globalThis.__rwExecCalls;',
  '    hits[name] = (hits[name] || 0) + 1;',
  '    const s = globalThis.__rwExecStub || {};',
  '    if (s[name]) return s[name](...args);',
  '    return real[name](...args);',
  '  };',
  '}',
  ...VERBS.map((n) => 'export const ' + n + " = wrap('" + n + "');"),
].join('\n');

// 沙箱服务的壳：`confine()` 逐个记录（入参 + 真实返回值），`__rwConfineStub` 有值时改走它——
// 这是"命令真的经 confine()"的唯一可判定证据（看源码里有没有调用只是一种说法）。
const SANDBOX_SHIM = [
  'import * as real from ' + JSON.stringify(REAL_SANDBOX + '?real') + ';',
  'export * from ' + JSON.stringify(REAL_SANDBOX + '?real') + ';',
  'export function confine(argv, policy) {',
  '  const rec = globalThis.__rwConfine;',
  '  const stub = globalThis.__rwConfineStub;',
  '  if (stub) { rec.calls.push({ argv, policy, stubbed: true }); return stub(argv, policy); }',
  '  const c = real.confine(argv, policy);',
  '  rec.calls.push({ argv, policy, result: c });',
  '  return c;',
  '}',
  // 降级留痕（q3：reason 只走 ⑰ 的降级账 + capabilities 上报，不进工具结果）——这里记录"有没有落账"这一步
  'export function noteDegrade(ctx, extra) {',
  '  globalThis.__rwConfine.degrades.push({ ctx, extra });',
  '  return real.noteDegrade(ctx, extra);',
  '}',
].join('\n');

// db / agent 的壳：只在这两条上做"可替换"，其余一律转发真实现（夹具要能驱动 driver.js 的验收路径）
const DB_SHIM = [
  'import * as real from ' + JSON.stringify(url('db.js') + '?real') + ';',
  'export * from ' + JSON.stringify(url('db.js') + '?real') + ';',
  'const pick = () => globalThis.__rwFakeDb || real.db;',
  'export const db = new Proxy({}, {',
  '  get: (_, k) => { const t = pick(); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; },',
  '});',
].join('\n');
const AGENT_SHIM = [
  'import * as real from ' + JSON.stringify(url('agent.js') + '?real') + ';',
  'export * from ' + JSON.stringify(url('agent.js') + '?real') + ';',
  'export function runAgent(...a) {',
  '  const f = globalThis.__rwFakeAgent;',
  '  if (f) return f.runAgent(...a);',
  '  return real.runAgent(...a);',
  '}',
].join('\n');

const HOOK = [
  'const TABLE = [',
  '  [' + JSON.stringify(REAL_EXEC.toLowerCase()) + ', ' + JSON.stringify(EXEC_SHIM) + '],',
  '  [' + JSON.stringify(REAL_SANDBOX.toLowerCase()) + ', ' + JSON.stringify(SANDBOX_SHIM) + '],',
  '  [' + JSON.stringify(url('db.js').toLowerCase()) + ', ' + JSON.stringify(DB_SHIM) + '],',
  '  [' + JSON.stringify(url('agent.js').toLowerCase()) + ', ' + JSON.stringify(AGENT_SHIM) + '],',
  '];',
  'export async function load(u, context, nextLoad) {',
  '  const s = String(u);',
  '  if (s.indexOf("?") < 0) {',
  '    const hit = TABLE.find((x) => x[0] === s.toLowerCase());',
  '    if (hit) return { format: "module", shortCircuit: true, source: hit[1] };',
  '  }',
  '  return nextLoad(u, context);',
  '}',
].join('\n');

globalThis.__rwExecCalls = {};
globalThis.__rwExecStub = {};
globalThis.__rwConfine = { calls: [] };
globalThis.__rwConfineStub = null;
globalThis.__rwFakeDb = null;
globalThis.__rwFakeAgent = null;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

// 装了壳之后才能动态 import 被测模块（静态 import 会把真模块先装载进缓存，钩子就再也拦不到它了）
let toolsPromise = null;
function loadTools() {
  if (!toolsPromise) toolsPromise = import(url('tools/index.js')).then((m) => m.TOOLS);
  return toolsPromise;
}
const tool = async (name) => (await loadTools()).find((x) => x.name === name);
const CTX = { permission: 'full', root: ROOT, conversationId: 0, accountId: 0 };
const stub = (s) => { globalThis.__rwExecCalls = {}; globalThis.__rwExecStub = s || {}; };
const confineCalls = () => { globalThis.__rwConfine = { calls: [], degrades: [] }; return globalThis.__rwConfine; };
// 源码级判据一律**先去掉注释**再匹配（本仓库的既有写法，见 portability.test.mjs）：
// 注释里"提到"某个字符串（比如解释"为什么不再写 RW_OS === 'win32'"）不是"代码里有"，否则判据只会逼人不敢写注释。
const stripComments = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// 改造前那份实现（2026-09-16 之前 server/shell.js 的字面量）：**回归金标**。
// 写死在这里是刻意的——金标若从新代码里取，就成了拿新代码校验新代码（与 exec-backend.test.mjs 同一取向）。
const PS_PREAMBLE_GOLD = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const legacyArgv = (line) => (WIN
  ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PS_PREAMBLE_GOLD + line]
  : ['/bin/bash', '-c', line]);
const legacyRun = (line) => new Promise((resolve) => {
  const [file, ...args] = legacyArgv(String(line));
  execFile(file, args, { cwd: ROOT, timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || ''), err: String(stderr || '') }));
});

// ---- ① 注入缝：调用点跟着后端动词的 stub 变 ----

test('注入缝：run_command（full 档）把命令串交给后端 execShell —— 换成 stub，调用点跟着变', async () => {
  const t = await tool('run_command');
  stub({ execShell: async () => ({ ok: true, code: 7, out: 'STUB-OUT', err: '' }) });
  const r = await t.run({ cmd: 'echo 这句话根本不会被执行' }, CTX);
  assert.equal(r.stdout, 'STUB-OUT', 'full 档的命令串必须交给后端执行（stub 换了它就换）：' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.code, 7, '退出码如实透传');
  assert.equal(globalThis.__rwExecCalls.execShell, 1, '恰好经后端执行一次');
  assert.equal(globalThis.__rwExecCalls.execLine, undefined, '不再走未受沙箱包装的旧动词');

  stub(); // 还原成真后端：必须真的起进程并拿到输出
  const real = await t.run({ cmd: 'node -e "console.log(1+1)"' }, CTX);
  assert.equal(real.ok, true);
  assert.equal(real.stdout.trim(), '2', '还原后走真后端：' + JSON.stringify(real).slice(0, 200));
  assert.equal(globalThis.__rwExecCalls.execShell, 1);
});

test('注入缝：kill_process 走后端 killTree 动词（工具层不再按平台分叉、不再自己拼 taskkill）', async () => {
  const t = await tool('kill_process');
  stub({ killTree: async (pid) => ({ killed: true, gone: false, detail: 'stub ' + pid }) });
  const k = await t.run({ pid: 987654321 }, CTX);
  assert.deepEqual(k, { killed: true }, '收掉了就返回 {killed:true}（与改造前同形状）');
  assert.equal(globalThis.__rwExecCalls.killTree, 1, '必须调用后端的 killTree 动词');
  assert.equal(globalThis.__rwExecCalls.execLine, undefined, '不许自己拼 taskkill 命令行绕过 killTree（那是后端动词的活）');

  stub({ killTree: async () => ({ killed: false, gone: true, detail: '' }) });
  const gone = await t.run({ pid: 424242 }, CTX);
  assert.equal(gone.killed, false, '"已不存在"不许报成收掉了');
  assert.match(String(gone.note), /已不存在/, '要如实说已不存在：' + JSON.stringify(gone).slice(0, 160));
  assert.match(String(gone.note), /日志仍在/, '提示里要留日志去向（改造前就是这样）');
  assert.equal(globalThis.__rwExecCalls.killTree, 1);
});

test('注入缝：run_long_task 走后端 spawnShell（受沙箱），且 detached / stdio（日志 fd）形状不变', async () => {
  const t = await tool('run_long_task');
  const fake = new EventEmitter();
  fake.pid = 4242;
  fake.unref = () => {};
  let seen = null;
  stub({ spawnShell: (line, opts) => { seen = { line, opts }; return fake; } });
  const r = await t.run({ cmd: 'node -e "setTimeout(function(){}, 30000)"' }, CTX);
  assert.equal(r.jobId, '4242', 'jobId＝子进程 pid（stub 的 pid 必须被采纳）');
  assert.equal(globalThis.__rwExecCalls.spawnShell, 1);
  assert.equal(seen.line, 'node -e "setTimeout(function(){}, 30000)"', '命令串原样交给后端，不在工具层自己拼 argv');
  assert.equal(seen.opts.detached, true, '后台任务必须 detached（改造前沿用）');
  assert.equal(seen.opts.stdio[0], 'ignore');
  assert.deepEqual(seen.opts.stdio.slice(1).map((x) => typeof x), ['number', 'number'],
    'stdout/stderr 必须是打开的日志文件 fd——换成管道就再也拿不到 job_output 的日志了');
  assert.ok(fs.existsSync(r.log), '日志文件必须真的建出来：' + r.log);
  assert.ok(String(r.log).startsWith(RW_JOBS_DIR), '日志必须落在 RW_JOBS_DIR：' + r.log);
  stub();
});

// ---- ② 真实命令串：经调用点跑通，且与改造前逐字一致 ----

test('真实命令串（引号/空格 + npx 的 .cmd 形式）经调用点跑通，输出与改造前那份实现逐字一致', async () => {
  const t = await tool('run_command');
  stub(); // 真后端

  // 引号 + 空格：命令串按 shell 语法解析（不是按空格拆 argv——那会在引号处碎掉）
  const quoted = 'node -p "\'a b\'.length"';
  const q = await t.run({ cmd: quoted }, CTX);
  assert.equal(q.ok, true, '带引号与空格的命令必须跑通：' + JSON.stringify(q).slice(0, 240));
  assert.equal(q.stdout.trim(), '3');

  // npm/npx 在 Windows 上只有 .cmd 形式：execFile 直呼必 ENOENT，显式 .cmd 在 Node 22 上 EINVAL
  // ⇒ 必须经本机 shell 由 PATHEXT 解析（这正是"命令串"这一层存在的理由）
  const npx = await t.run({ cmd: 'npx --version' }, CTX);
  assert.equal(npx.ok, true, 'npx 必须跑得起来（Windows 上是 npx.cmd）：' + JSON.stringify(npx).slice(0, 240));
  assert.match(npx.stdout.trim(), /^\d+\.\d+\.\d+/, 'npx --version 要打印版本号：' + JSON.stringify(npx.stdout));

  // 结果形状（键名）不变：调用方按这些键读（agent.js 取 stdout/stderr、账本记 ok/code）
  assert.deepEqual(Object.keys(npx).sort(), ['code', 'cwd', 'ok', 'stderr', 'stdout'], '结果键名与改造前一致');

  // 金标对照：同一条命令串，走改造前那份实现（execFile + 写死的 shell argv）
  const gNpx = await legacyRun('npx --version');
  assert.equal(npx.stdout, gNpx.out, 'stdout 与改造前逐字一致');
  assert.equal(npx.code, gNpx.code, '退出码与改造前一致');
  const gQ = await legacyRun(quoted);
  assert.equal(q.stdout, gQ.out, '带引号那条也与改造前逐字一致');
});

// ---- ③ ⑰ 沙箱接线：真的经 confine()、降级不谎报、严格模式如实拒绝 ----

test('接线(a)：模型可影响的两条路（命令串 / argv 直呼）都真的经 confine()——换掉 confine，执行的命令就换', async () => {
  const t = await tool('run_command');
  const rec = confineCalls();
  // 把 confine 换成 stub：它返回什么 argv，就执行什么命令（这是"真的经这条接缝"的可判定证据）
  globalThis.__rwConfineStub = () => ({
    argv: [process.execPath, '-e', 'console.log("CONFINED-ARGV")'], confined: true, mode: 'workspace-write',
    enforcement: 'partial', runner: 'stub', denialSignatures: [], reason: 'stub',
  });
  try {
    const viaShell = await t.run({ cmd: 'echo 这句话不会被执行' }, CTX); // full 档 → execShell
    assert.equal(viaShell.stdout.trim(), 'CONFINED-ARGV', '命令串那一臂必须经 confine()：stub 换了 argv，执行的命令就换了');
    assert.equal(rec.calls.length, 1, '恰好进沙箱一次');
    assert.equal(rec.calls[0].argv[0], WIN ? 'powershell.exe' : '/bin/bash', '进 confine 的是**内层 argv**（本机 shell），不是命令串本身');

    const rec2 = confineCalls();
    const viaArgv = await t.run({ cmd: 'node --check server/env.js' }, { ...CTX, permission: 'write', limitPath: true }); // read/write 档 → execArgv
    assert.equal(viaArgv.stdout.trim(), 'CONFINED-ARGV', 'argv 直呼那一臂也必须经同一个接缝');
    assert.equal(rec2.calls.length, 1);
    assert.deepEqual(rec2.calls[0].argv, ['node', '--check', 'server/env.js'], 'argv 直呼那路进 confine 的是原始 argv（不过 shell）');
    assert.equal(rec2.calls[0].policy.permission, 'write', '沙箱模式按**会话权限档**定：write 档必须如实传下去');
  } finally {
    globalThis.__rwConfineStub = null;
  }
});

test('接线(b)：本机没有 runner 时 enforcement 如实报 none、命令照常执行（不谎报、也不假装隔离）', async () => {
  const t = await tool('run_command');
  const rec = confineCalls();
  const r = await t.run({ cmd: 'node --check server/env.js' }, { ...CTX, permission: 'write', limitPath: true });
  assert.equal(r.ok, true, '迁移期口径＝带原因放行：命令必须照常执行：' + JSON.stringify(r).slice(0, 200));
  const c = rec.calls.at(-1).result;
  assert.equal(c.enforcement, 'none', '本机没有 runner ⇒ enforcement 必须如实报 none（不许因为"跑成功了"就报 full/partial）');
  assert.equal(c.confined, false);
  assert.deepEqual(c.argv, ['node', '--check', 'server/env.js'], '拿不到 runner 时 argv 原样（迁移期不允许偷偷换一种执行方式）');
  assert.match(String(c.reason), /没有可用 runner|未就绪/, '要给出可读的原因（不静默降级）：' + c.reason);
  // full 档是"按权限设计就不沙箱"，不是能力缺失——同样如实报 none，只是理由不同
  const recFull = confineCalls();
  const rf = await t.run({ cmd: 'node -e "console.log(1)"' }, CTX);
  assert.equal(rf.ok, true);
  assert.equal(recFull.calls.at(-1).result.mode, 'full-access');
  assert.equal(recFull.calls.at(-1).result.enforcement, 'none', 'full 会话也要报 none（§4.6：不许因为"是设计"就报 full）');
  assert.equal(recFull.degrades.length, 0, '"权限档使然"不是降级：不许往降级账里写（那会把账本刷成噪音）');

  // q3：真降级必须**留痕**（⑰ 的降级账，每进程去重），且**不进工具结果**（模型可见形状一个字段都不许多）
  assert.equal(rec.degrades.length, 1, '拿不到 runner 的一次执行必须落一次降级留痕：' + JSON.stringify(rec.degrades));
  assert.match(String(rec.degrades[0].extra.reason), /没有可用 runner|未就绪/, '留痕里要带可读原因：' + JSON.stringify(rec.degrades[0].extra).slice(0, 200));
  assert.deepEqual(Object.keys(r).sort(), ['code', 'cwd', 'ok', 'stderr', 'stdout'], '降级不许改工具结果的形状（q3）');
});

test('接线(c)：RW_SANDBOX_REQUIRED=1 且拿不到 runner 时**如实拒绝**（SandboxUnavailableError），不静默放行', async () => {
  const t = await tool('run_command');
  const before = process.env.RW_SANDBOX_REQUIRED;
  process.env.RW_SANDBOX_REQUIRED = '1';
  try {
    await assert.rejects(
      () => t.run({ cmd: 'node --check server/env.js' }, { ...CTX, permission: 'write', limitPath: true }),
      (e) => e && e.code === 'SANDBOX_UNAVAILABLE' && e.name === 'SandboxUnavailableError',
      '严格模式下拿不到沙箱必须抛 SandboxUnavailableError（静默放行＝这条夹具存在的理由）',
    );
    // 严格语义只对"需要沙箱的档"生效：full 档按 §4.6 是"按设计不沙箱"，不该被这条开关拦死
    const full = await t.run({ cmd: 'node -e "console.log(1)"' }, CTX);
    assert.equal(full.ok, true, 'full 档不是"拿不到沙箱"，不受 RW_SANDBOX_REQUIRED 影响');
  } finally {
    if (before === undefined) delete process.env.RW_SANDBOX_REQUIRED;
    else process.env.RW_SANDBOX_REQUIRED = before;
  }
});

// ---- ④ 清单不变量：直接起进程的文件只剩后端与沙箱后端 ----

test('清单不变量：server/ 下能直接起进程的文件＝执行后端 + 沙箱后端（新增一个就报红，防 ⑯ 漏掉调用点）', () => {
  // "漏了一个调用点"的表现是静默的：本机一切正常，换机器/上沙箱时才现形。所以清单要被机器看着。
  // 判据覆盖三种写法：静态 import、require、以及**动态 import**（⑯ 收口前 server/index.js 里就藏着两处
  // `await import('node:child_process')`，只扫静态 import 会漏掉它们）。
  const IMPORT = /(?:from\s*|require\(|import\()\s*'node:child_process'/;
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      if (IMPORT.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(path.join(ROOT, 'server'), p).replace(/\\/g, '/'));
    }
  };
  walk(path.join(ROOT, 'server'));
  found.sort();

  // ① 执行后端实现本身：唯一该真起进程的地方（换平台＝换这个文件）
  // ② 沙箱后端（⑰）：探针要起进程；方向是"⑯ 调 ⑰"，它不 import 执行后端（它自己有一条反向断言）
  const SPAWN_IMPORTERS = new Set(['exec/local.js', 'sandbox/backends/index.js']);
  assert.deepEqual(found.filter((f) => !SPAWN_IMPORTERS.has(f)), [],
    '新增的直接起进程点必须先走执行后端（server/exec 的动词）；确有理由的例外要登记到下面的 SANDBOX_EXEMPT：\n' + found.join('\n'));
  for (const f of SPAWN_IMPORTERS) assert.ok(found.includes(f), f + ' 已不再直接起进程 → 从白名单里删掉（清单不许留过期条目）');

  // ③ 沙箱例外（q1）：argv 来自部署配置、模型碰不到的基础设施进程——不进 confine，但必须**写明理由**。
  //    判据：这些文件里要出现 `sandbox: 'off'`；且**别的文件一个都不许出现**（例外不能悄悄扩散）。
  const SANDBOX_EXEMPT = new Map([
    ['index.js', '自我重启（argv 来自部署配置 restart.js）＋ 模板库 git 同步（平台自己的模板仓库）'],
    ['mcp.js', 'MCP 子进程：命令来自 settings（管理员配置），模型碰不到'],
    ['runtrack.js', 'runtrack 的 git 例行：平台自己发起的维护（恢复现场时取一次状态）'],
  ]);
  const OFFLINE = /sandbox:\s*'off'/;
  const exemptFound = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p); continue; }
      if (!p.endsWith('.js')) continue;
      if (OFFLINE.test(stripComments(fs.readFileSync(p, 'utf8')))) exemptFound.push(path.relative(path.join(ROOT, 'server'), p).replace(/\\/g, '/'));
    }
  };
  scan(path.join(ROOT, 'server'));
  assert.deepEqual(exemptFound.sort(), [...SANDBOX_EXEMPT.keys()].sort(),
    '沙箱例外只有这几处，且每一处都要写清理由（q1）：' + [...SANDBOX_EXEMPT].map(([f, why]) => f + '＝' + why).join('；'));
});

// ---- ⑤ 驱动器（driver.js）那条验收路径 + q2 平台意图 ----

test('注入缝：驱动器的验收命令行也走后端 argv 接缝（execPlan + execArgv）——接缝换成 stub，验收结论就跟着 stub 变', async () => {
  // 驱动器的 shell 调用点不出现在任何导出里，只能从**真实驱动路径**上证明：db / agent 也换成注入缝，
  // 驱动一轮契约。判别方式是可证伪的：验收行本身写成**必然失败**的 `node -e "process.exit(3)"`，
  // 而 stub 给的计划必然成功（exit 0）——只有"驱动器真的走这条接缝"，验收才会通过（candidate_done）。
  const contract = {
    id: 4242, account_id: null, conv_id: 7, title: '夹具契约', goal: '证明验收路径走后端',
    acceptance: JSON.stringify(['cmd:node -e "process.exit(3)"']), status: 'queued', attempts: 0,
  };
  const writes = [];
  globalThis.__rwFakeDb = {
    query: async (sql, params) => { writes.push([String(sql), params]); return String(sql).includes('FROM task_contracts') ? [contract] : []; },
    run: async () => ({}),
  };
  globalThis.__rwFakeAgent = { runAgent: async () => ({ toolLog: [{ name: 'finish_task' }], content: '本轮完成' }) };
  const seen = [];
  const driver = await import(url('driver.js'));
  try {
    stub({
      execPlan: (req) => {
        seen.push(req);
        return { command: process.execPath, args: ['-e', 'process.exit(0)'], options: { cwd: ROOT, timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 } };
      },
      // 计划随后交给 argv 动词执行（驱动器现在的形状：execPlan → execArgv），这一环同样钉住
      execArgv: (argv) => {
        seen.push({ argv });
        return { ok: true, code: 0, out: '', err: '' };
      },
    });
    await driver.driverTickNow();
    const until = Date.now() + 5000;
    while (Date.now() < until && !writes.some(([sql, p]) => String(sql).includes('SET status=?') && p && p[0] === 'candidate_done')) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    globalThis.__rwFakeDb = null;
    globalThis.__rwFakeAgent = null;
    stub();
  }
  assert.ok(seen.length > 0, '驱动器的验收命令行必须经后端 argv 接缝（没被调用＝它自己拼了 argv）');
  assert.equal(seen[0].line, 'node -e "process.exit(3)"', '交给接缝的是去掉 DSL 前缀（cmd:）后的命令串：' + JSON.stringify(seen[0].line));
  assert.equal(seen[0].cwd, RW_WORKSPACE, 'cwd＝工作区（改造前就是 WS）');
  assert.equal(seen[0].timeout, 120000, '超时沿用驱动器的既有值 120000（一个界限一个出处）');
  assert.equal(seen[0].maxBuffer, 4 * 1024 * 1024, 'maxBuffer 沿用既有值 4MB');
  assert.ok(writes.some(([sql, p]) => String(sql).includes('SET status=?') && p && p[0] === 'candidate_done'),
    '验收结论必须跟着接缝给的命令走（必然失败的验收行 + stub 的成功命令 ⇒ 通过）：' + JSON.stringify(writes.map((w) => w[1]).slice(0, 8)));
});

// ---------------------------------------------------------------------------
// ⑥ 驱动器那条组装路径（driver.js 的历史读取）：v0.3 §4.4.1 规则1「只追加」
// ---------------------------------------------------------------------------
// 为什么放在这份文件里：驱动器**没有**自己的导出可供直测（`driveContract` 是模块内私有），
//   而它这一轮的 messages 只有通过 `runAgent` 才看得见 —— 那正是这里已经建好的 db/agent 注入缝
//   （见本文件头 ⑤ 与 `globalThis.__rwFakeDb` / `__rwFakeAgent`）。另起一份夹具就要把整套 module.register
//   钩子再写一遍（同一份基建两份实现，正是本轮要避免的东西）。
// 判据（2026-09-16，v0.3 §4.4.1 规则1）：driver 读的是**发进模型上下文的请求前缀**，所以必须"全量、原样、
//   升序"，不许有窗口或"截断中段再拼起来"。它原有两道窗口（`DESC LIMIT 30` + `length > 26 ? …slice(-26)`），
//   越过 26 条后**每一轮**都换掉前缀头一条 —— 与 headless 那处同形（同批一起改掉）。
test('规则1（v0.3 §4.4.1）：驱动器的历史**全量、原样、升序**进请求 —— 不许有窗口/截断中段', async () => {
  // 造 40 条历史（远超旧实现的 26 条线）：内容可辨认，便于断言"最老那条还在最前面"
  const history = [];
  for (let i = 1; i <= 40; i++) history.push({ role: i % 2 ? 'user' : 'assistant', content: '第' + i + '条' });
  const contract = {
    id: 5150, account_id: null, conv_id: 808, title: '夹具契约（历史口径）', goal: '证明历史只追加',
    acceptance: '[]', status: 'queued', attempts: 0,
  };
  const sqls = [];
  globalThis.__rwFakeDb = {
    query: async (sql) => {
      const s = String(sql);
      sqls.push(s.replace(/\s+/g, ' ').trim());
      if (s.includes('FROM task_contracts')) return [contract];
      if (/FROM messages WHERE conversation_id=\?/.test(s)) return history.map((m) => ({ ...m }));
      return [];
    },
    run: async () => ({}),
  };
  let seen = null;
  globalThis.__rwFakeAgent = { runAgent: async (args) => { seen = args; return { toolLog: [{ name: 'finish_task' }], content: '本轮完成' }; } };
  try {
    const driver = await import(url('driver.js')); // 已在本文件 ⑤ 装载过；这里拿同一份（钩子仍生效）
    await driver.driverTickNow();
    const until = Date.now() + 5000;
    while (Date.now() < until && !seen) await new Promise((r) => setTimeout(r, 50));
  } finally {
    globalThis.__rwFakeDb = null;
    globalThis.__rwFakeAgent = null;
  }
  assert.ok(seen, '驱动器这一轮必须真的跑起来（否则本夹具什么都没证明）：sqls=' + JSON.stringify(sqls.slice(0, 6)));
  const msgs = seen.messages;
  assert.equal(msgs.length, 41, '40 条历史 + 1 条契约 system 全部进请求（旧实现只剩 26+1+1=28）：' + msgs.length);
  assert.equal(msgs[0].content, '第1条', '最老的那条历史必须仍在前缀最前（窗口一回来这里变成"第15条"）');
  assert.equal(msgs[39].content, '第40条', '最新那条历史紧邻契约块之前');
  assert.equal(msgs[40].role, 'system', '契约块（目标/验收/执行规则）仍在最后');
  assert.match(msgs[40].content, /【任务契约 · 你在无人值守模式下执行】/);
  // 源码面：SQL 形状直接钉住（不看注释，看代码）
  const q = sqls.find((s) => /FROM messages WHERE conversation_id=\?/.test(s));
  assert.ok(q, '必须真读了历史');
  assert.equal(/ORDER BY id DESC/.test(q), false, '不得再按 DESC 读（窗口形状）：' + q);
  assert.equal(/LIMIT/.test(q), false, '不得再有 LIMIT 窗口（一个界限一个出处：压体积走折叠/spill）：' + q);
  assert.match(q, /ORDER BY id$/, '必须按 id 升序读全量');
  // 那行"更早的执行记录见任务会话"的替代提示必须消失（它正是"把最老的换成一行提示"的产物）
  assert.equal(msgs.some((m) => m.content === '（更早的执行记录见任务会话，勿重复已完成部分）'), false,
    '旧的"早期并入一行提示"写法不得复活');
});

test('q2：MCP 的"要不要 shell 透传"是**声明的意图**，平台判据落在后端（引擎层不再有平台分叉）', async () => {
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'server', 'mcp.js'), 'utf8');
  assert.match(mcpSrc, /shell:\s*'passthrough'/, '引擎层只说"需要 shell 透传"这个意图');
  const mcpCode = stripComments(mcpSrc); // 判据看**代码**：注释里解释"为什么不再这么写"不算没改
  assert.equal(/RW_OS\s*===\s*'win32'/.test(mcpCode), false, '平台判据不许留在引擎层（v0.3 §5）');
  assert.equal(/from 'node:child_process'/.test(mcpCode), false, '起进程一律经执行后端');

  // 真的起一个进程走一遍 passthrough 那条臂（本机是 Windows 时就是 cmd 透传，POSIX 上直接 spawn）。
  // 刻意用**不含引号**的 argv：Windows 的 shell:true 走 `cmd /d /s /c`，内层引号会被 MSVCRT 转义规则吞掉
  // （server/exec/local.js 头注释实测过：返回空输出且 code=0）——这是 MCP 那条路**既有**的性质
  // （settings 里的 MCP 命令本来就是 npx/绝对路径这类无引号 argv），本轮只把它照原样搬进后端，不改语义。
  const { spawnArgv } = await import(url('exec/index.js'));
  const child = await spawnArgv([process.execPath, '-p', '1+1'],
    { shell: 'passthrough', sandbox: 'off', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = await new Promise((resolve) => {
    let s = '';
    child.stdout.on('data', (d) => { s += d.toString(); });
    child.on('exit', () => resolve(s));
  });
  assert.equal(out.trim(), '2', 'passthrough 那条臂必须真的起得来（MCP 的字节流语义就靠它）：' + JSON.stringify(out));
});
