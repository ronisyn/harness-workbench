// test/progress.test.mjs - 进展判据夹具（2026-09-15）
//
// 背景：原先用"轮次上限 2000 / 时间预算 120 分钟"两条数字当缰绳，粒度不对 ——
//   正常长任务会被墙钟误杀（保险丝接到用户身上），真正的原地打转它又抓不住。
//   改成"连续 K 轮没有任何新进展"判据（见 server/progress.js 头注）。
// 本夹具的价值在**两侧都要挡住**：既不能漏掉打转（否则白烧钱），也不能误杀正常长任务。
import { test } from 'node:test';
import assert from 'node:assert';
import { newProgressState, judgeRound, callSignature, fuseDecision, stallMessage, STATE_CHANGING_TOOLS } from '../server/progress.js';

const T = (name, args, status = 'done', result = 'ok') => ({ name, args, status, result });

test('负例（该抓的）：同一调用、同一参数、同一结果反复 —— 逐轮累积，到 K 就停', () => {
  const st = newProgressState();
  const same = [T('job_output', { jobId: 'j1' }, 'done', 'still running')];
  const first = judgeRound(st, same);
  assert.equal(first.progress, true, '第一次调这个组合算"新调用"=新信息（设计如此，不是漏判）');
  assert.equal(first.stalled, 0);
  let last = null;
  for (let i = 0; i < 4; i++) last = judgeRound(st, same);
  assert.equal(last.progress, false);
  assert.equal(last.stalled, 4, '从第二次起，同样的调用+同样的结果逐轮累积');
  assert.ok(last.repeats.some((r) => r.startsWith('job_output')), '要能说清在重复什么（带重复次数，如 job_output×5）');
  assert.match(last.repeats.join(','), /×5/, '重复次数要能报出来，用户才知道该不该让继续');
});

test('负例：变着法换参数不能靠"每次都算新调用"逃掉 —— 参数不同就是不同签名（这点如实说明，靠 loop_guard 与成本可见兜底）', () => {
  const st = newProgressState();
  for (let i = 0; i < 5; i++) judgeRound(st, [T('read_file', { path: '/a/same.js', offset: i })]);
  assert.equal(st.stalled, 0, '偏移不同=签名不同，本判据不判它打转（这是有意的：换参数往往是有效探索）');
});

test('正例（不能误杀）：读一个新文件算进展 —— 正常探索 50 轮也不会被判打转', () => {
  const st = newProgressState();
  let stall = 0;
  for (let i = 0; i < 50; i++) {
    const r = judgeRound(st, [T('read_file', { path: '/a/f' + i + '.js' })]);
    if (!r.progress) stall++;
  }
  assert.equal(stall, 0, '每个新路径都是"新调用" ⇒ 全部算进展');
  assert.equal(st.stalled, 0);
});

test('正例：改东西就是进展（状态变更）', () => {
  const st = newProgressState();
  const r = judgeRound(st, [T('write_file', { path: '/a/x.js', content: 'hi' })]);
  assert.equal(r.progress, true);
  assert.ok(r.why.some((w) => w.startsWith('状态变更')));
  assert.ok(STATE_CHANGING_TOOLS.has('plan_done'), '勾掉计划步骤也算推进任务');
});

test('正例：同一个调用但结果变了 = 进展（poll 长任务属这一类，不该被误杀）', () => {
  const st = newProgressState();
  judgeRound(st, [T('job_output', { jobId: 'j2' }, 'done', 'step 1/3')]);
  const r = judgeRound(st, [T('job_output', { jobId: 'j2' }, 'done', 'step 2/3')]);
  assert.equal(r.progress, true);
  assert.ok(r.why.some((w) => w.startsWith('结果变了')));
  assert.equal(r.stalled, 0, '结果在变 ⇒ 计数清零');
});

test('正例：以前失败的调用这次成功 = 进展（说明思路/环境变了）', () => {
  const st = newProgressState();
  judgeRound(st, [T('run_command', { cmd: 'npm test' }, 'fail', 'boom')]);
  const r = judgeRound(st, [T('run_command', { cmd: 'npm test' }, 'done', 'ok')]);
  assert.equal(r.progress, true);
  assert.ok(r.why.some((w) => w.startsWith('转成功')));
});

test('正例：一直失败也不算"打转清零" —— 失败轮同样计入无进展（连败另有专门护栏）', () => {
  const st = newProgressState();
  const fail = [T('run_command', { cmd: 'x' }, 'fail', 'same error')];
  const first = judgeRound(st, fail);
  assert.equal(first.progress, true, '第一次尝试这个命令 = 新调用（拿到"这条路不通"也是信息）');
  const r = judgeRound(st, fail);
  assert.equal(r.progress, false);
  assert.equal(r.stalled, 1, '第二次起，同样的失败逐轮累积');
});

test('边界：一轮里没有工具调用不计入无进展（模型没动手 ≠ 打转）', () => {
  const st = newProgressState();
  judgeRound(st, []);
  assert.equal(st.stalled, 0, '空轮不该累积（纯文字轮是循环的正常终点）');
});

test('签名稳定：参数键顺序不影响签名（否则每次调用都像"新调用"，判据失效）', () => {
  assert.equal(callSignature('read_file', { a: 1, b: 2 }), callSignature('read_file', { b: 2, a: 1 }));
  assert.notEqual(callSignature('read_file', { a: 1 }), callSignature('read_file', { a: 2 }));
});

test('停下时的说明必须说清"在重复什么"且给出恢复路径', () => {
  const st = newProgressState();
  const same = [T('job_output', { jobId: 'j9' })];
  for (let i = 0; i < 3; i++) judgeRound(st, same);
  const msg = stallMessage(st, 12, {}, ['job_output×3']);
  assert.match(msg, /没有任何新进展/);
  assert.match(msg, /job_output/);
  assert.match(msg, /继续/, '要给恢复路径（回一句"继续"）');
});

// ── 熔断作用域（2026-09-15 用户拍板：交互式默认关掉轮次/时间熔断）────────────────────────
test('熔断作用域：交互式（人在场）默认两条数字都不生效', () => {
  const o = { unattended: false, interactiveFuse: false, budgetMin: 1, roundCap: 1, round: 99, elapsedMs: 9e9 };
  assert.equal(fuseDecision(o), null, '人在场的会话不该被墙钟/轮数掐断');
});

test('熔断作用域：无人值守仍然生效（定时任务/驱动器/子代理）', () => {
  assert.deepEqual(fuseDecision({ unattended: true, interactiveFuse: false, budgetMin: 1, roundCap: 0, round: 0, elapsedMs: 61e3 }).guard, 'budget');
  assert.deepEqual(fuseDecision({ unattended: true, interactiveFuse: false, budgetMin: 0, roundCap: 10, round: 10, elapsedMs: 0 }).guard, 'cap');
});

test('熔断作用域：交互式想恢复老行为，把 fuse_interactive 设 1 即可（不必改代码）', () => {
  assert.deepEqual(fuseDecision({ unattended: false, interactiveFuse: true, budgetMin: 0, roundCap: 5, round: 5, elapsedMs: 0 }).guard, 'cap');
});

test('熔断作用域：0=不限仍然生效（设成 0 的那条不该触发）', () => {
  assert.equal(fuseDecision({ unattended: true, interactiveFuse: true, budgetMin: 0, roundCap: 0, round: 999, elapsedMs: 9e9 }), null);
});
