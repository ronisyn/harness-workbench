// test/sandbox.test.mjs - v0.3 §7.1 ⑰「沙箱服务与分级」夹具（2026-09-16）
//
// 依据：v0.3 §4.6（沙箱：服务 + 按平台后端；失败语义 + `enforcement: full/partial/none` 逐次上报）、
//      §0.2 G1（沙箱可替换）、§7.1 ⑰（依赖 ⑯）；
//      《v0.3-符合性核对-20260916》§2.3 的"六件"（策略 / 服务与后端 / 功能探针 + 启动门禁 / 降级目录与上报 /
//      提高审批 / 持久账本行）。
//
// 本夹具的立场（与 capabilities.test.mjs 同一条）：**不许自夸**。
//   拿不到隔离就必须报 none，且要**留痕 + 提高审批**；任何"把没有的能力报成 partial/full"都会被这里钉住。
//
// 全部断言**不依赖本机装没装 bwrap**：探针三态用注入的假探测结果驱动（`runProbeFn`/`crossCheckFn`/`probeResult`），
//   真起进程的那一条（`runProbe` 的端到端）用**假 runner 脚本**（一个 node 进程）验证"编排真的会起进程并读退出码"，
//   这样在 Windows 开发机上也能把 Linux 侧的驱动逻辑跑完（真隔离强度只能在目标机上验，见交付说明第 ④ 条）。
//
// 探针是**异步**的（红线：`test/no-sync-subprocess.test.mjs`——同步子进程会冻住整个 Node 进程，
//   而探针跑在启动链上）。所以本夹具里凡"真探"的调用点一律 `await`；纯读缓存的 `compose()` 仍是同步的。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SANDBOX_MODES, modeForPermission, policyFor, subsystemOf, SANDBOXED_TOOLS,
  confine, lineToArgv, probe, readProbe, probeCacheState, probePending, resetProbeCache, available, compose,
  candidateChain, runProbe, composeEnforcement, fakeProbe, policy as sandboxPolicy,
  approvalRequired, sandboxRequired, startupGuard, SandboxUnavailableError, PROBE_SCRIPT,
} from '../server/sandbox/index.js';
import * as linux from '../server/sandbox/backends/linux.js';
import * as win from '../server/sandbox/backends/windows.js';
import { enforcementReport, capabilityManifest, capabilitySummary } from '../server/capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 探针注入：三个 runner 状态各一份（可用 / 不可用 / 探针通过但宿主侧发现泄漏）
// ⚠️ 必须**按候选**给答案：夹具里两个 runner 都"通过"是不现实的，那会让 bwrap 的失败被 unshare 顶上，
//   于是"交叉核对不通过就必须判不可用"这条断言会被掩盖（踩过：unshare 顶上来，探针照样报可用）。
const probeRunnerOk = (okIds = ['bwrap']) => (c) => (okIds.includes(c.id)
  ? { ok: true, detail: '探针通过（夹具）', exitCode: 0, argv: [] }
  : { ok: false, detail: c.id + ' 探针不通过（夹具）', exitCode: 7, argv: [] });
const probeBad = () => ({ ok: false, detail: '夹具：探针不通过', exitCode: 7, argv: [] });

// ── 假 runner：一个真会起的 node 进程，用来验证"探针编排真的起进程 + 真读退出码"，又不需要目标机装 bwrap ──
// 它**不假装隔离**（那不是它能做的）；它只把内层 argv 原样跑一遍，并按退出码如实返回。
const FAKE_RUNNER = `import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const i = argv.indexOf('--');
const inner = i >= 0 ? argv.slice(i + 1) : argv;
const r = spawnSync(inner[0], inner.slice(1), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;
// 模拟 bwrap 的假 runner：把"工作区外的写"如实拦掉，其余原样跑。
// 这样在任意平台上都能把**真探针脚本**（PROBE_SCRIPT）跑通一次，验证"三条判据得出的就是通过/失败"。
const FAKE_BWRAP = `import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
const i = argv.indexOf('--');
const inner = i >= 0 ? argv.slice(i + 1) : argv;
if (String(inner[1] || '').includes('rw-sandbox-probe-ro')) inner[1] = String(inner[1]).replace(/rw-sandbox-probe-ro/g, 'rw-sandbox-probe-denied');
const r = spawnSync(inner[0], inner.slice(1), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;

test('⑰-1 策略：权限档 → 沙箱模式（read→read-only / write→workspace-write / full→不沙箱但如实降级）', () => {
  assert.deepEqual(SANDBOX_MODES.slice(0, 2), ['read-only', 'workspace-write'], '模式词汇照 DSH 的两档');
  assert.equal(modeForPermission('read'), 'read-only');
  assert.equal(modeForPermission('write'), 'workspace-write');
  assert.equal(modeForPermission('guard'), 'workspace-write', 'guard 的额外约束在审批层，不在沙箱层');
  assert.equal(modeForPermission('full'), 'full-access', 'full 档按 §4.6 不沙箱');
  assert.equal(modeForPermission('unknown-档'), 'read-only', '未知档一律收紧，与 fail-closed 同一条纪律');
  const p = policyFor({ permission: 'full', root: '/' });
  assert.equal(p.sandboxed, false);
  assert.match(p.why, /如实降级上报/, 'full 档必须写明"要如实降级上报"，不能因为"是设计"就不报');
});

test('⑰-2 "哪些工具走沙箱"的口径：命令子系统 + 文件子系统两条，其余不默认归类', () => {
  assert.deepEqual([...SANDBOXED_TOOLS.command].sort(), ['run_command', 'run_long_task', 'run_test']);
  for (const t of SANDBOXED_TOOLS.fs) assert.equal(subsystemOf(t), 'fs', t + ' 应归文件子系统');
  assert.equal(subsystemOf('run_command'), 'command');
  assert.equal(subsystemOf('read_file'), null, '不在表里的工具如实返回 null（不默认归类）');
  assert.equal(subsystemOf('db_write'), null);
});

test('⑰-3 confine() 的 argv 形状（纯断言，不真起进程）：bwrap 首选 / unshare 兜底 / full 档不沙箱', () => {
  const okBwrap = fakeProbe({ ok: true, runner: 'bwrap' });
  const a = confine(['/bin/bash', '-c', 'echo hi'], { permission: 'write', workspaceRoot: '/srv/ws', probeResult: okBwrap });
  assert.equal(a.confined, true);
  assert.equal(a.runner, 'bwrap');
  assert.equal(a.enforcement, 'partial', '本平台第 1 层未接入 ⇒ 即使探针通过也只报 partial');
  assert.equal(a.argv[0], 'bwrap');
  assert.ok(a.argv.includes('--ro-bind') && a.argv.includes('--unshare-pid') && a.argv.includes('--die-with-parent'),
    'bwrap profile 照 DSH 口径：ro-bind/unshare-pid/die-with-parent');
  assert.deepEqual(a.argv.slice(-3), ['/bin/bash', '-c', 'echo hi'], '内层命令原样跟在 -- 之后');
  assert.equal(a.argv[a.argv.length - 4], '--');
  assert.deepEqual(a.argv.slice(a.argv.indexOf('--bind'), a.argv.indexOf('--bind') + 3), ['--bind', '/srv/ws', '/srv/ws'], 'workspace-write 必须有 --bind 工作区');

  // read-only：没有 --bind / --tmpfs（一个字节都不许落盘）
  const ro = confine(['/bin/bash', '-c', 'cat x'], { permission: 'read', workspaceRoot: '/srv/ws', probeResult: okBwrap });
  assert.equal(ro.mode, 'read-only');
  assert.equal(ro.argv.includes('--bind'), false);

  // unshare 兜底：内层是 bash -c <包装脚本>，脚本里必须能看到 remount,ro 与 bind 工作区
  const okU = fakeProbe({ ok: true, runner: 'unshare' });
  const b = confine(['/bin/bash', '-c', 'echo hi'], { permission: 'write', workspaceRoot: '/srv/ws', probeResult: okU });
  assert.equal(b.argv[0], 'unshare');
  assert.deepEqual(b.argv.slice(1, 3), ['-m', '--']);
  const script = b.argv[b.argv.indexOf('-c') + 1];
  assert.match(script, /mount -o remount,ro \/ \|\| exit 3/, '根只读失败必须让整条命令失败（否则是假隔离）');
  assert.match(script, /mount --bind '\/srv\/ws' '\/srv\/ws'/, '工作区必须 bind 回可写');
  assert.deepEqual(b.argv.slice(-3), ['/bin/bash', '-c', 'echo hi']);

  // full 档：不沙箱，但**不许**报 full（enforcement 一律 none）
  const f = confine(['/bin/bash', '-c', 'echo hi'], { permission: 'full', probeResult: okBwrap });
  assert.equal(f.confined, false);
  assert.equal(f.enforcement, 'none');
  assert.match(f.reason, /按 §4\.6 不沙箱/);
});

test('⑰-4 confine() 用调用方给的 ⑯ 纯函数把命令串变成 argv（不抄第二份 shell 口径）', () => {
  const c = confine('echo hi && pwd', {
    permission: 'write', workspaceRoot: '/srv/ws', probeResult: fakeProbe({ ok: true, runner: 'bwrap' }),
    cmdline: (line) => ({ command: '/bin/bash', args: ['-c', line], options: {} }),
  });
  assert.deepEqual(c.argv.slice(-3), ['/bin/bash', '-c', 'echo hi && pwd']);
  // 兜底口径（没给 cmdline）也要与 ⑯ 的 argvFor 同形
  assert.deepEqual(lineToArgv('x', 'linux'), ['/bin/bash', '-c', 'x']);
  assert.deepEqual(lineToArgv('x', 'win32').slice(0, 2), ['powershell.exe', '-NoLogo']);
});

test('⑰-5 探针三态驱动四层 state：可用→2 层 partial / 不可用→none / 探针失败→不可用（不等同于"没装"）', async () => {
  // ① 可用：候选链里 bwrap 探针通过 ⇒ 第 2 层 partial，enforcement=partial
  const okProbe = await probe({
    force: true, platform: 'linux', source: 'fixture-ok', workspaceRoot: '/srv/ws',
    runProbeFn: probeRunnerOk(['bwrap']),
    crossCheckFn: async () => ({ leaked: false, detail: '宿主侧确认不存在（夹具）' }),
  });
  assert.equal(okProbe.ok, true);
  assert.equal(okProbe.runner.id, 'bwrap');
  const okComposed = composeEnforcement({ permission: 'write', root: '/srv/ws' }, okProbe);
  assert.equal(okComposed.enforcement, 'partial');
  assert.equal(okComposed.layers.find((l) => l.id === 2).state, 'partial');
  assert.equal(okComposed.layers.length, 4);
  assert.equal(okComposed.level, 'partial', '第 1/4 层未接入 ⇒ 整体永远不可能是 full');

  // ② 不可用：两个 runner 都不过 ⇒ 第 2 层 none、enforcement=none（**不许**报 partial 蒙混）
  const badProbe = await probe({
    force: true, platform: 'linux', source: 'fixture-bad', workspaceRoot: '/srv/ws',
    runProbeFn: (c) => ({ ok: false, detail: c.id + ' 探针不通过（夹具）', exitCode: 7, argv: [] }),
  });
  assert.equal(badProbe.ok, false);
  assert.match(badProbe.unavailableReason, /bwrap|unshare/, '不可用原因必须结构化点名（哪个 runner、为什么）');
  const badComposed = composeEnforcement({ permission: 'write', root: '/srv/ws' }, badProbe);
  assert.equal(badComposed.enforcement, 'none');
  assert.equal(badComposed.layers.find((l) => l.id === 2).state, 'none');
  assert.match(badComposed.layers.find((l) => l.id === 2).note, /bwrap|unshare/);

  // ③ 探针"起得来但不隔离"：两个候选的探针都自称通过，但宿主侧发现工作区外真被写进去了。
  //    期望：**两个候选都判死**（交叉核对是链上每个候选都要过的），一个都不许当可用。
  const leakProbe = await probe({
    force: true, platform: 'linux', source: 'fixture-leak', workspaceRoot: '/srv/ws',
    runProbeFn: probeRunnerOk(['bwrap', 'unshare']),
    crossCheckFn: async () => ({ leaked: true, detail: '宿主侧存在 /.rw-sandbox-probe-ro' }),
  });
  assert.equal(leakProbe.ok, false, '宿主侧发现真被写进去了 ⇒ 不许当成可用（这正是"只看 which/退出码"会漏的那类）');
  assert.equal(leakProbe.runner, null);
  assert.equal(leakProbe.candidates[0].ok, false);
  assert.match(leakProbe.candidates[0].detail, /交叉核对不通过/, 'bwrap 那一条必须留下"为什么不可用"');
  //    另一面：交叉核对说"没有泄漏"时，**同一个探针结果**必须保持可用（判据不是恒假）
  const noLeak = await probe({
    force: true, platform: 'linux', source: 'fixture-noleak', workspaceRoot: '/srv/ws',
    runProbeFn: probeRunnerOk(['bwrap']),
    crossCheckFn: async () => ({ leaked: false, detail: '宿主侧确认不存在（夹具）' }),
  });
  assert.equal(noLeak.ok, true);
  assert.equal(noLeak.candidates[0].ok, true);
  assert.match(noLeak.candidates[0].detail, /宿主侧确认不存在/);
  // 两个候选都不过（含交叉核对）⇒ 才真的不可用
  const allFail = await probe({
    force: true, platform: 'linux', source: 'fixture-all-fail', workspaceRoot: '/srv/ws',
    runProbeFn: probeRunnerOk([]),
    crossCheckFn: async () => ({ leaked: true, detail: '宿主侧存在 /.rw-sandbox-probe-ro' }),
  });
  assert.equal(allFail.ok, false, '没有候选通过 ⇒ 不许当成可用');
});

test('⑰-6 真起进程的那一条：runProbe 会真的起一个进程、按退出码判定、超时能打断', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-sandbox-fixture-'));
  const runnerPath = path.join(dir, 'fake-runner.mjs');
  fs.writeFileSync(runnerPath, FAKE_RUNNER, 'utf8');
  try {
    // ① 真起一个进程、内层退出码 0 ⇒ 探针判通过（覆盖 execFile 编排 + 退出码读取）
    const good = await runProbe({ id: 'fake-ok', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, '-e', 'process.exit(0)'] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 15000 });
    assert.equal(good.ok, true, '起得来、退出码 0 ⇒ 探针通过：' + good.detail);

    // ② 假 runner 真的把内层 argv 转起来了（多一层子进程，退出码透传）；内层用 `node -e` 而不是系统 shell：
    //    本夹具在 Windows 开发机上也要能跑（真探针脚本跑的是 /bin/bash，那属于目标机的事，见交付说明 ④）。
    const fakeInner = [process.execPath, '-e', 'process.exit(7)'];
    const wrapped = await runProbe({ id: 'fake-wrap', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, runnerPath, '--', ...fakeInner] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 15000 });
    assert.equal(wrapped.exitCode, 7, '假 runner 必须把内层退出码如实透传（这里是 7）：' + wrapped.detail);

    // ③ **真探针脚本**（PROBE_SCRIPT）跑一遍：本机有 /bin/bash 时，判据必须给出明确结论（通过=0 / 失败=7，
    //    失败时 stdout 带 `reason=…`）；没有 bash（Windows 开发机）时，如实报"起不来"，**不许**当通过。
    const realInner = linux.probeInnerArgv({ workspaceRoot: dir, tmp: os.tmpdir() });
    const rawProbe = await runProbe({ id: 'real-script', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, runnerPath, '--', ...realInner] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 15000 });
    if (rawProbe.exitCode === 0) assert.match(rawProbe.detail, /probe-ok/, '通过时必须带 probe-ok');
    else if (rawProbe.exitCode === 7) assert.match(rawProbe.detail, /reason=/, '失败时必须带结构化原因');
    else assert.equal(rawProbe.ok, false, '起不来就是不可用（退出码 ' + rawProbe.exitCode + '）：' + rawProbe.detail);
    assert.equal(rawProbe.ok, rawProbe.exitCode === 0, 'ok 只跟着退出码 0 走（别把"跑完了"当"隔离生效"）');

    // ④ 让一个"假 bwrap"把工作区外的写如实拦掉 ⇒ 同一份探针脚本必须给出**通过**（判据可判定，不是恒假）
    const fakeBwrapPath = path.join(dir, 'fake-bwrap.mjs');
    fs.writeFileSync(fakeBwrapPath, FAKE_BWRAP, 'utf8');
    const confined = await runProbe({ id: 'fake-bwrap', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, fakeBwrapPath, '--', ...realInner] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 15000 });
    if (confined.exitCode === 127 || confined.exitCode === 1) {
      assert.equal(confined.ok, false, '本机没有 /bin/bash ⇒ 只能如实报不可用（' + confined.detail + '）');
    } else {
      assert.equal(confined.exitCode, 0, '工作区外被拦、工作区可写 ⇒ 探针必须判通过：' + confined.detail);
      assert.equal(confined.ok, true);
    }

    // ⑤ 内层命令以非 0 结束 ⇒ **不能**把"跑完了"当"隔离生效"
    const bad = await runProbe({ id: 'fake-bad', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, '-e', 'process.exit(7)'] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 15000 });
    assert.equal(bad.ok, false);
    assert.equal(bad.exitCode, 7, '退出码必须如实带出来（部署者据此判断"装了但不生效"）');

    // ⑥ 解析不到的可执行文件 ⇒ 直接给原因，不抛
    const missing = await runProbe({ id: 'ghost', kind: 'ghost', enforcement: 'partial', build: () => ['rw-no-such-runner-xyz', '--'] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 5000 });
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /解析不到/);

    // ⑦ 挂住不返回 ⇒ 必须被超时打断（否则启动链会被一个坏 runner 拖死）
    const hang = await runProbe({ id: 'fake-hang', kind: 'fake', enforcement: 'partial', build: () => [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'] },
      { platform: 'linux', workspaceRoot: dir, timeoutMs: 800 });
    assert.equal(hang.ok, false);
    assert.match(hang.detail, /超时/, '超时必须如实报出来（含配置的毫秒数）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑰-7 Windows 后端如实实现：没有受支持的 runner 就报不可用（不假装有 ACL 沙箱）', async () => {
  // 默认（没配 RW_SANDBOX_RUNNER）：空链 ⇒ 不可用，且原因说得清"为什么没有"
  const empty = await probe({ force: true, platform: 'win32', env: {}, source: 'fixture-win', workspaceRoot: 'C:/rw-ws' });
  assert.equal(empty.ok, false);
  assert.equal(empty.candidates.length, 0);
  assert.match(empty.unavailableReason, /没有受支持的 Windows runner/);
  const c = composeEnforcement({ permission: 'write', root: 'C:/rw-ws' }, empty);
  assert.equal(c.enforcement, 'none');
  assert.equal(c.layers.find((l) => l.id === 2).state, 'none');

  // 助手命令的校验口径（数组优先；含换行/空元素一律拒绝并说明）
  assert.deepEqual(win.normalizeRunnerArgv(undefined), { argv: null, error: null });
  assert.deepEqual(win.normalizeRunnerArgv('C:/tools/r.exe,--mode-guard'), { argv: ['C:/tools/r.exe', '--mode-guard'], error: null });
  assert.deepEqual(win.normalizeRunnerArgv('["C:/Program Files/r.exe"]'), { argv: ['C:/Program Files/r.exe'], error: null });
  assert.match(win.normalizeRunnerArgv('["C:/x/r.exe"').error, /JSON/);
  assert.match(win.normalizeRunnerArgv('[]').error, /空数组/);
  assert.match(win.normalizeRunnerArgv(['']).error, /空元素/);
  assert.match(win.normalizeRunnerArgv(['ok', 'bad\nline']).error, /换行/);
  assert.match(win.RUNNER_CONTRACT, /--mode/, '助手命令的 argv 契约要成文（部署方照着写）');

  // 配了但**解析不到**：如实报配置错误（不是"没配"，也不是"可用"）
  const configured = await probe({ force: true, platform: 'win32', env: { RW_SANDBOX_RUNNER: 'rw-no-such-runner-xyz' }, workspaceRoot: 'C:/rw-ws' });
  assert.equal(configured.ok, false);
  assert.equal(configured.candidates.length, 1);
  assert.match(configured.candidates[0].detail, /解析不到/);
});

test('⑰-8 降级必须落账 + 逐次上报 none/partial（禁止静默降级）', () => {
  // 账本行内容：缺失层 + 原因 + enforcement（detail 是可查的 JSON）
  const composed = composeEnforcement({ permission: 'write', root: '/srv/ws' }, fakeProbe({ ok: false, reason: '夹具：本机没有 bwrap' }));
  assert.equal(composed.enforcement, 'none');
  const missing = composed.layers.filter((l) => l.state !== 'full').map((l) => l.id + ':' + l.state);
  assert.deepEqual(missing, ['1:none', '2:none', '4:none']);

  // 降级目录与清单出口：capabilities 里必须有 sandbox 一等字段 + 降级目录含沙箱两条
  const m = capabilityManifest({ permission: 'write', preset: 'all', mode: 'chat', root: '/srv/ws', sandbox: composed }, { tools: ['run_command'] });
  assert.equal(m.sandbox.enforcement, 'none');
  assert.equal(m.sandbox.runner, null);
  assert.equal(m.sandbox.probed, true);
  const codes = m.degrade.map((d) => d.code);
  assert.ok(codes.includes('sandbox-degraded'), '沙箱降级必须进 DEGRADE_CATALOG（客户可见的出口）');
  assert.ok(codes.includes('sandbox-refused-startup'), '严格模式的拒绝启动也要登记');

  // 逐次上报：capabilitySummary 的 enforcement 就是沙箱这一维，拿不到 ⇒ none
  const s = capabilitySummary({ permission: 'write', root: '/srv/ws', sandbox: composed }, ['run_command']);
  assert.equal(s.enforcement, 'partial', '整体档仍是 partial（四层合成口径未变）');
  assert.deepEqual(s.layers, ['1:none', '2:none', '4:none'], '只带"没做到 full"的层，逐次上报');
  const sFull = capabilitySummary({ permission: 'write', root: '/srv/ws', sandbox: composeEnforcement({ permission: 'write', root: '/srv/ws' }, fakeProbe({ ok: true, runner: 'bwrap' })) }, []);
  assert.equal(sFull.enforcement, 'partial', '有 runner 时整体仍是 partial（第 1/4 层未接入）');
});

test('⑰-9 降级要能提高审批：触发条件是纯函数，且不搞连坐（full 档不因沙箱而卡死）', () => {
  const degraded = { enforcement: 'none' };
  // partial 是本平台的**正常上限**（第 1 层未接入）——runner 在工作就该视为"有沙箱"，不额外提高审批
  assert.equal(approvalRequired({ enforcement: 'partial' }, { mode: 'workspace-write', subsystem: 'command' }).required, false, 'runner 在工作 ⇒ 不额外提高');
  assert.equal(approvalRequired({ enforcement: 'full' }, { mode: 'read-only', subsystem: 'fs' }).required, false);
  const d1 = approvalRequired(degraded, { mode: 'workspace-write', subsystem: 'command' });
  assert.equal(d1.required, true);
  assert.match(d1.why, /command/);
  assert.equal(approvalRequired(degraded, { mode: 'read-only', subsystem: 'fs' }).required, true);
  const full = approvalRequired(degraded, { mode: 'full-access', subsystem: 'fs' });
  assert.equal(full.required, false, 'full 档按设计不沙箱：不因为沙箱而提高审批（否则默认会话每一步都要点一次）');
  assert.match(full.why, /如实上报/, '但"不提高审批"不等于"不上报"——理由里必须写明仍如实上报');
});

test('⑰-10 RW_SANDBOX_REQUIRED 严格路径：拿不到模式就拒绝执行 / 拒绝启动（v0.3 字面语义）', async () => {
  assert.equal(sandboxRequired({ RW_SANDBOX_REQUIRED: '1' }), true);
  assert.equal(sandboxRequired({ RW_SANDBOX_REQUIRED: 'true' }), true);
  assert.equal(sandboxRequired({ RW_SANDBOX_REQUIRED: '0' }), false);
  assert.equal(sandboxRequired({}), false, '默认关闭（迁移期：默认走显式降级，见交付说明）');

  // 严格：confine() 抛 SandboxUnavailableError（与 DSH 同名同义：绝不静默裸奔）
  const unavailable = fakeProbe({ ok: false, reason: '夹具：本机没有 bwrap' });
  assert.throws(
    () => confine(['/bin/bash', '-c', 'echo hi'], { permission: 'write', workspaceRoot: '/srv/ws', probeResult: unavailable, required: true }),
    (e) => e instanceof SandboxUnavailableError && e.code === 'SANDBOX_UNAVAILABLE' && /拒绝执行|拒绝启动/.test(e.message),
  );
  // 非严格：同一条输入必须放行且**如实标注**未隔离
  const soft = confine(['/bin/bash', '-c', 'echo hi'], { permission: 'write', workspaceRoot: '/srv/ws', probeResult: unavailable, required: false });
  assert.equal(soft.confined, false);
  assert.equal(soft.enforcement, 'none');
  assert.match(soft.reason, /未隔离执行/);

  // 启动门禁：严格 ⇒ ok:false + 结构化错误；默认 ⇒ ok:true 但 degraded（并落账）
  const strict = await startupGuard({ probe: unavailable, composed: composeEnforcement({ permission: 'read' }, unavailable), required: true });
  assert.equal(strict.ok, false);
  assert.ok(strict.error instanceof SandboxUnavailableError);
  assert.match(strict.message, /拒绝启动/);
  // 可用时：严格与否都放行，且不报 degraded
  const good = fakeProbe({ ok: true, runner: 'bwrap' });
  const okRes = await startupGuard({ probe: good, composed: composeEnforcement({ permission: 'read' }, good), required: true });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.degraded, false);
  assert.equal(okRes.runner, 'bwrap');
});

test('⑰-11 capabilities 的第 2 层由探测结果驱动（不再是从头到尾的常量）', () => {
  const withRunner = enforcementReport({ permission: 'read', root: '/srv/ws', sandbox: composeEnforcement({ permission: 'read', root: '/srv/ws' }, fakeProbe({ ok: true, runner: 'bwrap' })) });
  assert.equal(withRunner.layers.find((l) => l.id === 2).state, 'partial');
  assert.equal(withRunner.layers.find((l) => l.id === 2).note.includes('bwrap'), true, '第 2 层的 note 要点名 runner');
  assert.equal(withRunner.sandbox.runner, 'bwrap');
  assert.equal(withRunner.sandbox.probed, true);
  const without = enforcementReport({ permission: 'read', root: '/srv/ws', sandbox: composeEnforcement({ permission: 'read', root: '/srv/ws' }, fakeProbe({ ok: false, reason: '夹具：没有 runner' })) });
  assert.equal(without.layers.find((l) => l.id === 2).state, 'none');
  assert.equal(without.sandbox.enforcement, 'none');
  // 注入缝之外：真实进程里第 2 层的 state 也必须来自探测（而不是写死的 'none'）
  const src = read('server/capabilities.js');
  assert.equal(/id: 2, name: '引擎自带沙箱'/.test(src), false, '第 2 层不得再是写死的常量对象');
  assert.match(src, /sandboxCompose/, '第 2 层必须经沙箱合成结果');
  // 声明面不得把执行后端拖进依赖（动态 import 缝的结构保证）
  assert.equal(/from '\.\/exec\//.test(src), false, 'capabilities 不得静态依赖 ⑯ 的执行后端');
  assert.equal(/from '\.\/sandbox\//.test(src), false, 'capabilities 不得静态依赖 sandbox（要动态 import，见注释）');
  // ⑰ 不反向依赖 ⑯：沙箱模块不 import 执行后端（接缝方向＝⑯ 调 ⑰）
  assert.equal(/from '\.\.\/exec\//.test(read('server/sandbox/index.js')), false);
  // 探针不得用同步子进程（冻住整个进程；探针在启动链上）
  for (const f of ['server/sandbox/index.js', 'server/sandbox/probe-state.js', 'server/sandbox/backends/index.js', 'server/sandbox/backends/linux.js', 'server/sandbox/backends/windows.js']) {
    assert.equal(/\b(execSync|execFileSync|spawnSync)\s*\(/.test(read(f)), false, f + ' 不得出现同步子进程调用');
  }
});

test('⑰-12 探针脚本的判据本身不许退化成"只看 which"（三条真隔离判据 + 根只读失败即失败）', () => {
  assert.match(PROBE_SCRIPT, /workspace-not-writable/, '① 工作区必须写得进去（否则是把活儿拦死了）');
  assert.match(PROBE_SCRIPT, /outside-writable/, '② 工作区外写不进去才是隔离的真凭据');
  assert.match(PROBE_SCRIPT, /case "\$code" in 1\|2\|13\|30\)/, '② 必须按 errno 判"被拒"（1=EACCES/13、2=ENOENT、30=EROFS）');
  assert.match(PROBE_SCRIPT, /outside-denied-errno-\$code/, '② 其它 errno 要如实带出来（不是"非 0 就算隔离"）');
  assert.match(PROBE_SCRIPT, /tmp-not-writable/, '③ 临时区可写（否则工具链会莫名崩）');
  assert.match(PROBE_SCRIPT, /trap cleanup EXIT/, '探针留下的临时文件要清掉（不许污染工作区）');
  const linuxSrc = read('server/sandbox/backends/linux.js');
  assert.match(linuxSrc, /hostCrossCheck/, '宿主侧交叉核对必须在（防探针自己骗自己）');
  assert.match(linuxSrc, /remount,ro \/ \|\| exit 3/, 'unshare 兜底的根只读失败必须让整条命令失败');
  assert.match(linuxSrc, /code=\$\?/, '探针必须看 errno（$?）而不是只看"命令非 0 退出"');
});

test('⑰-13 有界缓存：探针一个进程只跑一次，且缓存可复位（夹具/运维重探）', async () => {
  resetProbeCache(); // 从"没探过"开始，才能断言 in-flight 与缓存命中
  let calls = 0;
  // 用 linux 链（两个候选）来数调用次数：win32 的空链根本不会调用 runProbeFn（那也是对的，见 ⑰-7）
  const inflight = probe({ force: true, platform: 'linux', env: {}, workspaceRoot: '/srv/ws', source: 'fixture-cache', runProbeFn: () => { calls++; return probeBad(); } });
  assert.equal(probePending(), inflight, '探测进行中要能被查到（confine 据此不猜）');
  const first = await inflight;
  assert.equal(calls, 2, 'linux 链两个候选都探过（bwrap → unshare，逐个仲裁）');
  const second = await probe({ platform: 'linux', env: {}, workspaceRoot: '/srv/ws' });
  assert.equal(calls, 2, '第二次必须吃缓存（事件路径上不许再起进程）');
  assert.equal(second, first, '缓存命中返回同一个对象');
  assert.equal(probeCacheState().cached, true);
  assert.equal(probeCacheState().firstProbeSource, 'fixture-cache');
  assert.equal(probeCacheState().pending, false);
  resetProbeCache();
  assert.equal(probeCacheState().cached, false);
  // available() 只读缓存：不因为被问到就起进程
  const before = calls;
  assert.equal(available(), false, '没探过 ⇒ 没有可用沙箱（不假装）');
  assert.equal(calls, before, 'available() 不得触发探测');
  await probe({ force: true, platform: 'linux', env: {}, workspaceRoot: '/srv/ws', runProbeFn: () => probeBad() });
});

test('⑰-14 服务动词与策略导出齐备（清单/调用方要的都在这儿）', () => {
  const p = sandboxPolicy({ permission: 'write', root: '/srv/ws' });
  assert.equal(p.mode, 'workspace-write');
  assert.equal(typeof confine, 'function');
  assert.equal(typeof probe, 'function');
  assert.equal(typeof readProbe, 'function');
  assert.equal(typeof compose, 'function');
  assert.equal(typeof available, 'function');
  assert.equal(typeof runProbe, 'function');
  assert.equal(typeof candidateChain, 'function');
  assert.equal(candidateChain({ platform: 'linux' }).map((c) => c.id).join(','), 'bwrap,unshare', 'Linux 链的顺序是 bwrap → unshare');
  assert.equal(candidateChain({ platform: 'darwin' }).length, 0, '未接入的平台如实返回空链（不假装有 seatbelt）');
  assert.equal(linux.supported || process.platform !== 'linux', true);
});
