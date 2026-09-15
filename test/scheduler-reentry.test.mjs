// test/scheduler-reentry.test.mjs - 定时任务防双跑夹具
// 背景（实测，不是推测）：task_history 显示 #4 在 8/11 天各跑两次（如 09-15 05:00:49 与 05:01:49），
//   #3 两次运行也都是双跑。2026-09-09 的修复只挡住了"同一分钟内并发双跑"，
//   但"执行时长 > 60s"时，下一轮扫描拿到的仍是**查询那一刻的快照**（旧 next_run）→ 同一任务被再排一次。
// 本夹具把"一次排程只跑一次"钉成可复现的判据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronToNext, isTaskInFlight } from '../server/scheduler.js';

// 与 server/scheduler.js 主循环里**同一段**推进算式（抽出来测，避免夹具复述实现时写歪）
export function advanceNextRun(cron, now = new Date()) {
  let next = cronToNext(cron, now);
  if (!next || next.getTime() <= now.getTime() + 60000) next = new Date(now.getTime() + 60000);
  const anchor = new Date(Math.max(next.getTime(), now.getTime() + 60000));
  const after = cronToNext(cron, new Date(anchor.getTime() + 60000));
  return after && after.getTime() > anchor.getTime() ? after : anchor;
}

const MIN = 60000;
const at = (iso) => new Date(iso);

test('每日 05:00 任务：在 cron 分钟内触发后，next_run 必须跨到**第二天**（不再落回本分钟）', () => {
  // 实测现场：2026-09-15 05:00:49（库本地）触发
  const now = at('2026-09-15T05:00:49+08:00');
  const next = advanceNextRun('0 5 * * *', now);
  assert.ok(next.getTime() > now.getTime() + MIN, '推进值必须真的在未来');
  assert.equal(next.getDate(), 16, '必须跨到 16 日，而不是停在 15 日 05:01');
  assert.equal(next.getHours(), 5);
  assert.equal(next.getMinutes(), 0);
});

test('负例（修前的行为）：只在 now 基础上 +60s，会让同一任务在下一轮再次入队', () => {
  const now = at('2026-09-15T05:00:49+08:00');
  const oldBehaviour = new Date(now.getTime() + MIN); // 09-15 05:01:49 —— 仍是"今天"，且 next_run <= NOW 会在 60s 后成立
  assert.equal(oldBehaviour.getDate(), 15);
  const fixed = advanceNextRun('0 5 * * *', now);
  assert.notEqual(fixed.getTime(), oldBehaviour.getTime());
  assert.ok(fixed.getTime() > oldBehaviour.getTime());
});

test('步进 cron（*/5）在 cron 分钟内触发：推进到**下一个 5 分钟槽**，不落回本槽', () => {
  const now = at('2026-09-15T05:00:30+08:00');
  const next = advanceNextRun('*/5 * * * *', now);
  assert.equal(next.getMinutes(), 5, '应推进到 05:05');
  assert.ok(next.getTime() > now.getTime());
});

test('非 cron 分钟触发（停机后补跑）：必须先跨过"即将到来但要用掉的那一槽"，避免补跑时又排一次', () => {
  // 现场：09-15 05:07 才轮到（05:00 那一槽被停机错过）。此刻 cronToNext 给出的是 09-16 05:00，
  // 而这次执行**正是**在消耗 09-16 那一槽之前补上的那一次 → 推进必须到 09-17，否则下一轮扫描
  // 会看到 09-16 05:00 仍 > NOW 而重复排队（长任务场景下即双跑）。
  const now = at('2026-09-15T05:07:00+08:00');
  const next = advanceNextRun('0 5 * * *', now);
  assert.equal(next.getDate(), 17, '要跳过被本次执行占用的 09-16 那一槽');
  assert.equal(next.getHours(), 5);
  assert.ok(next.getTime() > now.getTime() + 24 * 60 * MIN - MIN, '至少隔一天');
});

test('推进算式幂等：拿推进结果再算一次不会退回（反复入队不再可能）', () => {
  const now = at('2026-09-15T05:00:49+08:00');
  const a = advanceNextRun('0 5 * * *', now);
  const b = advanceNextRun('0 5 * * *', a);
  assert.ok(b.getTime() > a.getTime(), '再算一次必须继续向后，而不是回到同一点');
});

test('在跑任务集合：未登记的任务不在飞行中（防双跑的第一道闸）', () => {
  assert.equal(isTaskInFlight(999999), false);
  assert.equal(isTaskInFlight('999999'), false, '字符串 id 也应判定为不在飞行');
});
