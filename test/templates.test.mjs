// test/templates.test.mjs - ⑥ 模板库单测：校验 / 列表扫描 / 提示装配 / 档案片段
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate, listTemplates, getTemplate, buildLaunchPrompt, toProfileFragment, isTplKeyOk } from '../server/templates.js';

test('isTplKeyOk: 合法/非法', () => {
  assert.ok(isTplKeyOk('small-fix'));
  assert.ok(isTplKeyOk('a1'));
  assert.ok(!isTplKeyOk('Default'));
  assert.ok(!isTplKeyOk('has space'));
  assert.ok(!isTplKeyOk(''));
});

test('validateTemplate: 缺必填报错', () => {
  const v = validateTemplate({ key: 'x' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('name')));
  const ok = validateTemplate({ key: 'x', name: 'X', description: 'd' });
  assert.equal(ok.ok, true);
});

test('listTemplates: 仓库含 small-fix / feature-delivery 示例', () => {
  const list = listTemplates();
  const keys = list.map((t) => t.key);
  assert.ok(keys.includes('small-fix'), 'keys=' + keys.join(','));
  assert.ok(keys.includes('feature-delivery'));
  const sf = list.find((t) => t.key === 'small-fix');
  assert.equal(sf.profileKey, 'small-fix');
  assert.ok(Array.isArray(sf.skills) && sf.skills.length >= 1);
});

test('getTemplate: 读全量含 guide/acceptanceTemplate', () => {
  const t = getTemplate('feature-delivery');
  assert.ok(t && t.guide && Array.isArray(t.acceptanceTemplate.checks));
  assert.ok(t.acceptanceTemplate.checks.length >= 1);
  assert.equal(getTemplate('nope-nonexist'), null);
});

test('buildLaunchPrompt: 含档案/技能/验收/任务', () => {
  const t = getTemplate('small-fix');
  const p = buildLaunchPrompt(t, '修一下 xxx bug');
  assert.ok(p.includes('任务档案'));
  assert.ok(p.includes('本次任务'));
  assert.ok(p.includes('验收要点'));
  assert.ok(t.skills.length >= 1);
});

test('toProfileFragment: 转为壳档案片段', () => {
  const t = getTemplate('feature-delivery');
  const f = toProfileFragment(t);
  assert.equal(f.key, 'feature-delivery');
  assert.ok(f.modelHint && f.modelHint.defaultProvider);
});
