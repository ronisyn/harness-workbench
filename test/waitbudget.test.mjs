// test/waitbudget.test.mjs - RA-26 四面④ 的算入口径夹具：等待确认的时长不进"执行用时"，也就不烧时间预算
// 依据《RW-Agent 架构 v1.1》§14.7 RA-26："等待人工确认"与"执行中"在 接口/监控/计费/超时 上被当作两个状态。
// 本夹具只测"超时面"里最容易被写错的一处算式（纯函数 server/agent.js 的 budgetElapsedMs）：
// 用墙钟直接当执行用时，会让"用户思考 5 分钟"变成"任务超时挂起"——保险丝接到了用户身上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetElapsedMs } from '../server/agent.js';

const MIN = 60 * 1000;

test('RA-26 超时面：等待时长从执行用时里扣除', () => {
  assert.equal(budgetElapsedMs(10 * MIN, 4 * MIN), 6 * MIN, '墙钟 10 分钟、其中等待 4 分钟 → 执行 6 分钟');
  assert.equal(budgetElapsedMs(10 * MIN, 0), 10 * MIN, '没有等待 → 与墙钟一致（行为不变）');
  assert.equal(budgetElapsedMs(3 * MIN, 3 * MIN), 0, '全在等待 → 执行用时为 0');
});

test('RA-26 超时面：负值与脏输入不得把执行用时算成负数', () => {
  assert.equal(budgetElapsedMs(1 * MIN, 5 * MIN), 0, '等待比墙钟还大（时钟回拨/重复计）→ 夹到 0');
  assert.equal(budgetElapsedMs(1000, null), 1000);
  assert.equal(budgetElapsedMs(1000, undefined), 1000);
  assert.equal(budgetElapsedMs(1000, 'abc'), 1000, '非数字等待值不参与计算');
  assert.equal(budgetElapsedMs(null, 1000), 0);
});

test('RA-26 超时面：判据可复现 —— 同一个墙钟下，等得久的任务不该先触发预算', () => {
  const wall = 30 * MIN, budget = 20 * MIN;
  const quickAnswer = budgetElapsedMs(wall, 1 * MIN);   // 用户秒回，模型跑了 29 分钟
  const slowAnswer = budgetElapsedMs(wall, 25 * MIN);   // 用户想了 25 分钟，模型只跑了 5 分钟
  assert.ok(quickAnswer > budget, '秒回但真跑了很久 → 该挂起（防失控保险丝生效）');
  assert.ok(slowAnswer < budget, '用户思考占大头 → 不该挂起（等待不是执行）');
});
