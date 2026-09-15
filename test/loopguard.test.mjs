// test/loopguard.test.mjs - RA-39：同一工具同参数连续第 3/5 次「提醒但不阻止」，挂起阈值独立
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repeatReminder, shouldPauseOnRepeat } from '../server/loopguard.js';

test('第 3 次与第 5 次重复各提醒一次，其余次数不打扰', () => {
  const reminded = new Set();
  const seen = [];
  for (let n = 1; n <= 7; n++) {
    const t = repeatReminder(n, reminded);
    if (t) seen.push(n);
  }
  assert.deepEqual(seen, [3, 5], '只在第 3、5 次提醒');
  assert.equal(repeatReminder(3, new Set([3])), null, '同一档提醒过就不再重复发');
});

test('提醒措辞明确"不阻止调用"（RA-39 的语义要求）', () => {
  const t = repeatReminder(3, new Set());
  assert.match(t, /不阻止你继续调用/);
  assert.match(t, /第 3 次相同调用/);
});

test('提醒与挂起是两件事：默认阈值 6 时，第 3/5 次只提醒不挂起', () => {
  assert.equal(shouldPauseOnRepeat(3, 6), false, '第 3 次不得挂起（RA-39：提醒≠阻止）');
  assert.equal(shouldPauseOnRepeat(5, 6), false, '第 5 次不得挂起');
  assert.equal(shouldPauseOnRepeat(5, 6), false);
  assert.equal(shouldPauseOnRepeat(6, 6), true, '达到 loop_guard 阈值才挂起');
});

test('loop_guard=0 表示关闭：既不提醒也不挂起', () => {
  assert.equal(shouldPauseOnRepeat(99, 0), false);
  assert.equal(repeatReminder(4, new Set()), null);
});
