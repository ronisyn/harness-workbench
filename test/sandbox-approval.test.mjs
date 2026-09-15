// test/sandbox-approval.test.mjs - v0.3 §4.6「显式降级三件套」的第三件＝**提高审批**（本轮接线）
//
// 依据：
//   · v0.3 §4.6：第 1/3/4 层能力缺失 ⇒ **显式降级**（留痕 + **提高审批** + 客户可见，禁止静默降级）。
//   · DSH 蓝本 `dsh-permission-presets`：sandbox 模式与 approval 政策是两个**正交**的旋钮，由"预设"捆在一起
//     （`workspace-write` = {sandbox:'workspace-write', approval:'ask'}，描述原文"越界时才需批准"；
//     `danger-full-access` = {…, approval:'never'}）。该文件在"执行器不能 confine"时直接**拒绝组合**
//     （抛 misconfiguration：无隔离 + 要求隔离的预设＝配置错误）——即"没有隔离"不靠把审批面铺大来兜。
//     我们的等价物是 `RW_SANDBOX_REQUIRED=1` 的严格语义（见下面 ⑦）：拿不到隔离就**拒绝执行**。
//
// 本夹具钉住的**唯一新增规则**（用户拍板，全文只有这一条）：
//   沙箱降级（enforcement 既不是 full 也不是 partial，即 none/未探到）
//   且 会话权限档不是 full（full 按设计就不沙箱）
//   且 这次调用属于**命令子系统**（SANDBOXED_TOOLS.command = run_command / run_long_task / run_test）
//   ⇒ 该会话**第一次**这类调用弹一次人工审批；同一会话内批准过一次之后，同类调用不再问（**会话级**）。
//
// 明确**不做**（这三条是设计的一部分，不是遗漏）：
//   ① 不做"每次调用都问"（审批变噪音 ⇒ 用户点穿 ⇒ 等于没有；与 DSH"预设＝一次决定"相悖）；
//   ② 不动 fs 子系统（write_file/edit_file/append_file/copy_move/mkdir/delete_file）——它们的边界由**工具层
//      路径判据**（limitPath + inside）兜住，OS 隔离对它们不是关键那一格；
//   ③ 不动 guard 档既有的 7 项受控工具审批（那是另一条正交的轴，不能和沙箱混成一条），也不动 full 档。
//
// 注入缝（**不起服务、不调模型、不真跑命令**）：
//   · 假 ctx：permission / root / conversationId / `__emit`；
//   · `ctx.sandbox` 注入 ⑰ 的合成结果（与 capabilities.js 的注入口径同名同义；探针三态都能钉住，
//     不依赖本机装没装 bwrap）；
//   · 临时把命令工具的 `run` 换成"只记录、不真执行"的壳（本夹具测的是**审批门**，不是工具本身；
//     真执行另有 test/exec-callsites.test.mjs）。TOOLS 是身份稳定的数组、条目就地可变（见
//     test/tool-deadline.test.mjs 的注入与 registry.js 的就地改 `timeoutMs`），用完必须还原。
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOLS, execTool, needsApproval, sandboxApprovedIn, markSandboxApproved, resetSandboxApproved, APPROVAL_REQUIRED,
} from '../server/tools/index.js';
import { decideApproval, listPending } from '../server/approval.js';
import { SANDBOXED_TOOLS, subsystemOf } from '../server/sandbox/policy.js';
import { composeEnforcement, fakeProbe } from '../server/sandbox/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 会话 id 用**负数哨兵**（本仓库既有口径：0/负数＝夹具与探针会话，见 scripts/failure-report.mjs）：
// 既不与真实会话的审批状态串用，也让"会话级"这条断言有干净的输入。
const CONV_A = -9101, CONV_B = -9102, CONV_C = -9103, CONV_D = -9104, CONV_E = -9105, CONV_F = -9106;

/** 命令/写类工具的 run 壳：只记录调用，不真起进程、不真写盘。 */
function stubRun(name) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, name + ' 必须在工具面里（夹具依赖它做端到端）');
  const orig = t.run;
  const calls = [];
  t.run = async (args) => { calls.push(args); return { ok: true, stub: name }; };
  return { calls, restore: () => { t.run = orig; } };
}

/**
 * 假 emit：记事件；approval 事件当场判定（默认 approve），并顺手核对"createApproval 真的建了待办项"——
 * 事件里的 id 只可能来自 createApproval（`ap-<seq>-<base36>`），查得到就是"它被调用过"的可判定证据。
 */
function collector(decision = 'approve') {
  const events = [];
  const pendingSeen = [];
  const emit = (ev) => {
    events.push(ev);
    if (ev.type !== 'approval') return;
    pendingSeen.push(listPending().some((p) => p.id === ev.id));
    decideApproval(ev.id, decision);
  };
  return { emit, events, pendingSeen, approvals: () => events.filter((e) => e.type === 'approval') };
}

/** 假 ctx（`sandbox` 省略＝走生产那条"自己去读 ⑰"的路）。 */
const ctxOf = (convId, permission, sandbox, emit) => ({
  permission, root: ROOT, conversationId: convId, accountId: 0,
  __signal: new AbortController().signal, __emit: emit,
  ...(sandbox ? { sandbox } : {}),
});
const DEGRADED = { enforcement: 'none', reason: '夹具：本机没有 bwrap' };
// partial＝本平台的**正常上限**（第 1 层未接入）：runner 在工作 ⇒ 视为"有沙箱"，不额外提高审批
const RUNNER_OK = composeEnforcement({ permission: 'write', root: ROOT }, fakeProbe({ ok: true, runner: 'bwrap' }));

// ---------- ① 判据层：设计点名的那一条（无 runner + write 档 + run_command） ----------
test('① 判据：无 runner + write 档 + run_command ⇒ 要一次审批（且理由写清"为什么"）', () => {
  const j = needsApproval('run_command', { permission: 'write' }, { sandbox: DEGRADED, approved: false });
  assert.equal(j.required, true, '沙箱降级 + 非 full 档 + 命令子系统 ⇒ 需要一次人工审批');
  assert.equal(j.kind, 'sandbox', '命中的必须是**沙箱**那一轴（不是 guard 轴）');
  assert.match(j.why, /没有 OS 隔离/, '卡上要写明"本会话没有 OS 隔离"');
  assert.match(j.why, /enforcement=none/, '要带上逐次上报值');
  assert.match(j.why, /本机没有 bwrap/, '要带上**原因**（光报 none 等于没说）');
  assert.match(j.why, /未隔离方式执行/, '要写明这条命令会以未隔离方式执行');
  assert.match(j.why, /批准一次后[\s\S]*不再询问/, '要写明"批准一次后本会话同类命令不再询问"');
  // 未探到（没有 enforcement 值）同样按"没有隔离"处置：审批面 fail-closed，不静默放行
  assert.equal(needsApproval('run_command', { permission: 'write' }, { sandbox: {}, approved: false }).required, true,
    'enforcement 未探到 ⇒ 按 none 处置（§4.6：未探到不等于有沙箱）');
  // 命令子系统三件：一个都不能漏（表本身是 ⑰ 的唯一出处，这里只用它做输入）
  for (const n of SANDBOXED_TOOLS.command) {
    assert.equal(subsystemOf(n), 'command', n + ' 必须归命令子系统');
    assert.equal(needsApproval(n, { permission: 'write' }, { sandbox: DEGRADED, approved: false }).required, true, n + ' 应需要审批');
  }
});

// ---------- ② execTool 端到端：第一次弹一次（emit + createApproval），之后不再弹 ----------
test('② execTool：第一次弹一次（emit({type:approval}) 恰好一次 + createApproval 真的建了待办），批准后工具照常执行', async () => {
  resetSandboxApproved();
  const s = stubRun('run_test');
  const c = collector('approve');
  try {
    const r = await execTool('run_test', { dir: ROOT }, ctxOf(CONV_A, 'write', DEGRADED, c.emit));
    const ap = c.approvals();
    assert.equal(ap.length, 1, '恰好一张卡（实为 ' + ap.length + '）：' + JSON.stringify(c.events.map((e) => e.type)));
    assert.deepEqual(c.pendingSeen, [true], 'createApproval 必须真的建了待办项（卡上的 id 要能在 /api/approvals 里查到）');
    assert.match(String(ap[0].desc), /没有 OS 隔离/, '卡上必须写清为什么：' + String(ap[0].desc).slice(0, 200));
    assert.equal(s.calls.length, 1, '批准之后工具必须真的被执行（弹卡不是拦死）');
    assert.equal(r.error, undefined, '批准后不该是失败结果：' + JSON.stringify(r));
    assert.deepEqual(Object.keys(r).sort(), ['ok', 'stub'], '审批/降级不许往工具结果里加字段（形状不变是硬约束）：' + JSON.stringify(r));
    assert.equal(sandboxApprovedIn(CONV_A), true, '批准过之后本会话必须被记账');
  } finally { s.restore(); }
});

test('② 同一会话的第二次（含 run_long_task / 换回 run_test）⇒ 不再弹', async () => {
  resetSandboxApproved();
  markSandboxApproved(CONV_A); // 直接置成"本会话已确认过"（上一条已证明它由"批准"写入）
  const s1 = stubRun('run_test'), s2 = stubRun('run_long_task');
  const c = collector('approve');
  try {
    const r1 = await execTool('run_test', { dir: ROOT }, ctxOf(CONV_A, 'write', DEGRADED, c.emit));
    const r2 = await execTool('run_long_task', { cmd: 'echo 夹具' }, ctxOf(CONV_A, 'guard', DEGRADED, c.emit));
    const r3 = await execTool('run_test', { dir: ROOT }, ctxOf(CONV_A, 'guard', DEGRADED, c.emit));
    assert.deepEqual(c.approvals(), [], '同一会话已确认过 ⇒ 同类命令调用不再弹卡');
    assert.equal(s1.calls.length + s2.calls.length, 3, '不弹卡 ≠ 不执行：三次调用都必须真的走到工具里');
    for (const r of [r1, r2, r3]) assert.equal(r.error, undefined, '结果不该是失败：' + JSON.stringify(r));
    // 判据层同一条（含 run_command：guard 档的 run_command 由**另一条轴**管，见「轴正交」那条）
    for (const n of SANDBOXED_TOOLS.command) {
      assert.equal(needsApproval(n, { permission: 'write' }, { sandbox: DEGRADED, approved: true }).required, false,
        n + '：本会话已确认过 ⇒ 不再问');
    }
  } finally { s1.restore(); s2.restore(); }
});

// ---------- ③ 会话级：换一个会话必须重新确认（不是进程级、不是全局） ----------
test('③ 换一个会话 ⇒ 再弹一次（证明粒度是会话级）', async () => {
  resetSandboxApproved();
  markSandboxApproved(CONV_A); // 会话 A 已确认；会话 B 没有
  const s = stubRun('run_test');
  const c = collector('approve');
  try {
    await execTool('run_test', { dir: ROOT }, ctxOf(CONV_A, 'write', DEGRADED, c.emit));
    assert.deepEqual(c.approvals(), [], 'A 已确认过：不该弹');
    await execTool('run_test', { dir: ROOT }, ctxOf(CONV_B, 'write', DEGRADED, c.emit));
    assert.equal(c.approvals().length, 1, 'B 是另一个会话：必须重新确认一次');
    assert.equal(sandboxApprovedIn(CONV_B), true, 'B 批准后各自记账，互不串用');
    assert.equal(sandboxApprovedIn(CONV_A), true, 'A 的记账不受影响');
  } finally { s.restore(); }
});

// ---------- ④ full 档：按设计就不沙箱 ⇒ 不弹 ----------
test('④ permission=full ⇒ 不弹（仍如实上报 enforcement，但那是"上报"不是"审批"）', async () => {
  resetSandboxApproved();
  const j = needsApproval('run_test', { permission: 'full' }, { sandbox: DEGRADED, approved: false });
  assert.equal(j.required, false, 'full 档按设计不沙箱 ⇒ 不因沙箱降级而提高审批');
  assert.match(j.why, /full/, '理由要能读出来：' + j.why);
  const s = stubRun('run_test');
  const c = collector('approve');
  try {
    const r = await execTool('run_test', { dir: ROOT }, ctxOf(CONV_C, 'full', DEGRADED, c.emit));
    assert.deepEqual(c.approvals(), [], 'full 档的 run_test 不许弹卡（否则默认会话每一步都要点一次）');
    assert.equal(r.error, undefined);
  } finally { s.restore(); }
});

// ---------- ⑤ enforcement=partial / full：runner 在工作 ⇒ 不弹 ----------
test('⑤ enforcement=partial（假 runner 通过）/ full ⇒ 不弹', async () => {
  resetSandboxApproved();
  assert.equal(RUNNER_OK.enforcement, 'partial', '假探测结果经 composeEnforcement 应得 partial（本平台的正常上限）');
  const jp = needsApproval('run_test', { permission: 'write' }, { sandbox: RUNNER_OK, approved: false });
  assert.equal(jp.required, false, 'runner 在工作 ⇒ 不额外提高审批');
  assert.match(jp.why, /partial/, '理由要带上实际 enforcement：' + jp.why);
  // 本平台够不到 full（report.js 写明：第 1 层未接入 ⇒ 有 runner 也只报 partial）——直接注入 full 值，
  // 钉住"full 也不提高审批"这一条判据（与 degrade.js 的 ⑰-9 同口径）。
  const jf = needsApproval('run_test', { permission: 'write' }, { sandbox: { enforcement: 'full' }, approved: false });
  assert.equal(jf.required, false, 'enforcement=full ⇒ 不提高审批');

  const s = stubRun('run_test');
  const c = collector('approve');
  try {
    await execTool('run_test', { dir: ROOT }, ctxOf(CONV_D, 'write', RUNNER_OK, c.emit));
    await execTool('run_test', { dir: ROOT }, ctxOf(CONV_E, 'write', { enforcement: 'full' }, c.emit));
    assert.deepEqual(c.approvals(), [], '有隔离（或有 runner）时不弹卡');
  } finally { s.restore(); }
});

// ---------- ⑥ fs 子系统：不动（边界由工具层路径判据兜住） ----------
test('⑥ fs 子系统的 6 件 ⇒ 不弹（工具层路径判据始终在位，OS 隔离对它们不是关键那一格）', async () => {
  resetSandboxApproved();
  for (const n of SANDBOXED_TOOLS.fs) {
    assert.equal(subsystemOf(n), 'fs', n + ' 必须归 fs 子系统');
    const j = needsApproval(n, { permission: 'write' }, { sandbox: DEGRADED, approved: false });
    assert.equal(j.required, false, n + ' 属 fs 子系统：§4.6 那一轴不动它');
    assert.match(j.why, /不在命令子系统/, '理由要写明是"不在命令子系统"：' + j.why);
  }
  const s = stubRun('write_file'); // 端到端再来一遍（run 换成壳，不真写盘）
  const c = collector('approve');
  try {
    const r = await execTool('write_file', { path: path.join(ROOT, 'tmp', 'sandbox-approval-fixture.txt'), content: '夹具' }, ctxOf(CONV_F, 'write', DEGRADED, c.emit));
    assert.deepEqual(c.approvals(), [], 'write_file 不许因为沙箱降级而弹卡');
    assert.equal(r.error, undefined);
  } finally { s.restore(); }
});

// ---------- ⑦ 严格语义（RW_SANDBOX_REQUIRED=1）：仍走"拒绝执行"，不改成弹卡 ----------
test('⑦ RW_SANDBOX_REQUIRED=1 ⇒ 不弹卡，仍由执行路径如实拒绝（SandboxUnavailableError）', async () => {
  resetSandboxApproved();
  const before = process.env.RW_SANDBOX_REQUIRED;
  process.env.RW_SANDBOX_REQUIRED = '1';
  try {
    // 判据层：严格语义下不会发生"未隔离执行"，弹卡既没用、文案还是假话
    const j = needsApproval('run_test', { permission: 'write' }, { sandbox: DEGRADED, approved: false });
    assert.equal(j.required, false, '严格语义 ⇒ 不弹卡（拒绝执行那条路保持原样）');
    assert.match(j.why, /拒绝执行/, '理由要写明改走拒绝执行：' + j.why);

    // 端到端：**真 run**（run_test 不换壳）——它必须抛 SandboxUnavailableError 而不是弹卡、也不是静默放行。
    // 安全保证：confine() 在起进程**之前**就抛（execShell 先 confine 再 execFile），所以这里不会真的跑起 npm test。
    const c = collector('approve');
    const r = await execTool('run_test', { dir: ROOT }, ctxOf(CONV_F, 'write', DEGRADED, c.emit));
    assert.deepEqual(c.approvals(), [], '严格语义下绝不弹卡');
    assert.match(String(r.error || ''), /拿不到|拒绝启动/, '必须如实拒绝（不是静默放行、也不是审批拒绝）：' + JSON.stringify(r).slice(0, 300));
    assert.equal(/未批准/.test(String(r.error || '')), false, '拒绝原因不许被写成"用户未批准"（那是把两件事混成一件）');
    assert.equal(sandboxApprovedIn(CONV_F), false, '没弹卡就不该有"已确认"的记账');
  } finally {
    if (before === undefined) delete process.env.RW_SANDBOX_REQUIRED;
    else process.env.RW_SANDBOX_REQUIRED = before;
  }
});

// ---------- 轴正交：guard 档既有的 7 项受控工具审批不变，也不与新轴叠成两张卡 ----------
test('轴正交：guard 档的 7 项受控工具照旧要审批（kind=guard），与沙箱轴不叠加成两张卡', async () => {
  resetSandboxApproved();
  assert.equal(APPROVAL_REQUIRED.length, 7, '受控工具＝清单 approval:true 的 7 项（唯一出处）');
  for (const n of APPROVAL_REQUIRED) {
    const j = needsApproval(n, { permission: 'guard' }, { sandbox: RUNNER_OK, approved: false });
    assert.equal(j.required, true, n + ' 是 guard 档受控工具：不许被这次改动放宽');
    assert.equal(j.kind, 'guard', n + ' 必须命中 guard 那一轴');
  }
  // run_command 同时属于两条轴（它既在 7 项里、也在命令子系统里）：只能**一张卡**，且走 guard 那条既有判据
  const both = needsApproval('run_command', { permission: 'guard' }, { sandbox: DEGRADED, approved: false });
  assert.equal(both.required, true);
  assert.equal(both.kind, 'guard', '两轴同时命中 ⇒ 由既有的 guard 轴先答，不叠成两张卡');

  // 端到端：guard + delete_file（受控工具，fs 子系统）在有 runner 时照样弹一次
  const s1 = stubRun('delete_file');
  const c1 = collector('approve');
  try {
    const r = await execTool('delete_file', { path: path.join(ROOT, 'tmp', '不存在的夹具文件.txt') }, ctxOf(CONV_C, 'guard', RUNNER_OK, c1.emit));
    assert.equal(c1.approvals().length, 1, 'guard 档受控工具必须照旧弹一次卡');
    assert.equal(r.error, undefined);
    assert.equal(sandboxApprovedIn(CONV_C), false, 'guard 轴的批准只记在 guard 轴上（不写沙箱轴的账）');
  } finally { s1.restore(); }

  // 端到端：guard + run_command（两轴都命中）⇒ 恰好一张卡
  const s2 = stubRun('run_command');
  const c2 = collector('approve');
  try {
    await execTool('run_command', { cmd: 'echo 夹具' }, ctxOf(CONV_D, 'guard', DEGRADED, c2.emit));
    assert.equal(c2.approvals().length, 1, '两轴同时命中只弹一张卡（不是两张）');
  } finally { s2.restore(); }
});

// ---------- 源级：判据只有一处（防"第二份判据"悄悄长出来） ----------
test('源级：审批判据只有一处，接线点只读 judge.required（结果形状也不许被改动）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /export function needsApproval\(/, '判据必须可导出（夹具直测）');
  const start = src.indexOf('export function needsApproval(');
  const end = src.indexOf('export async function execTool(');
  assert.ok(start > 0 && end > start, '定位 needsApproval / execTool 失败（源码结构变了，请更新本夹具）');
  // 判据看**代码**：注释里"提到"某个字符串不算（与 test/portability.test.mjs 的 stripComments 同一取向）
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const outside = stripComments(src.slice(0, start) + src.slice(end));
  assert.equal(/approvalRequired\s*\(/.test(outside), false,
    'needsApproval 之外不许再出现第二处审批判据（两处判据必然漂移）');
  assert.match(src.slice(end), /!hookStop\?\.allowed && judge\.required/,
    '接线点必须只读 needsApproval 的结论（judge.required），不许再内联一份条件');
  const count = (stripComments(src.slice(start, end)).match(/approvalRequired\s*\(/g) || []).length;
  assert.equal(count, 1, 'guard 轴在 needsApproval 里只写一次（实为 ' + count + ' 次）');
});
