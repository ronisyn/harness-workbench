// test/profile.test.mjs - B3 任务档案点名解析单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskProfile, profileEcho, DEFAULT_TASK_PROFILES } from '../server/profile.js';

test('点名"按 小修"命中 small-fix', () => {
  const r = resolveTaskProfile('按小修档案帮我处理这个', DEFAULT_TASK_PROFILES);
  assert.equal(r.profile.key, 'small-fix');
});
test('点名 refactor-plan（key/词）', () => {
  assert.equal(resolveTaskProfile('用 refactor-plan 模式做', DEFAULT_TASK_PROFILES).profile.key, 'refactor-plan');
  assert.equal(resolveTaskProfile('按重构方案来', DEFAULT_TASK_PROFILES).profile.key, 'refactor-plan');
});
test('未点名 → 不自动猜（null）', () => {
  assert.equal(resolveTaskProfile('帮我修一下登录超时', DEFAULT_TASK_PROFILES), null);
  assert.equal(resolveTaskProfile('今天天气怎么样', DEFAULT_TASK_PROFILES), null);
});
test('壳级档案覆盖默认；echo 携带建议', () => {
  const custom = [{ key: 'biz', name: '商业模式', match: ['商业计划'], modelHint: { defaultProvider: 'glm', defaultModel: 'glm-5.3', qualityCostBias: 6 } }];
  const r = resolveTaskProfile('按商业模式档案做分析', custom);
  assert.equal(r.profile.key, 'biz');
  const e = profileEcho(r.profile);
  assert.ok(e.echo.includes('建议模型 glm-5.3'));
});
