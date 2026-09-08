// test/apps.test.mjs - D9 应用形态单测：校验/扫描/草稿装配/档案片段
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateApp, listApps, getApp, buildLaunchDraft, toAppProfileFragment, isAppKeyOk } from '../server/apps.js';

test('isAppKeyOk 复用 key 规范', () => {
  assert.ok(isAppKeyOk('biz-eval'));
  assert.ok(!isAppKeyOk('Bad Key'));
});

test('validateApp: 缺必填报错 / 合法通过', () => {
  const v = validateApp({ key: 'x' });
  assert.equal(v.ok, false);
  const ok = validateApp({ key: 'x', name: 'N', description: 'd' });
  assert.equal(ok.ok, true);
});

test('listApps: 仓库含 biz-eval 示例', () => {
  const list = listApps();
  const keys = list.map((a) => a.key);
  assert.ok(keys.includes('biz-eval'), 'keys=' + keys.join(','));
  const b = list.find((a) => a.key === 'biz-eval');
  assert.equal(b.entryProfileKey, 'biz-eval');
  assert.ok(b.hasOpening);
});

test('getApp: 读全量', () => {
  const a = getApp('biz-eval');
  assert.ok(a && a.persona && Array.isArray(a.acceptance?.checks) && a.openingPrompt);
  assert.equal(getApp('none-xyz'), null);
});

test('buildLaunchDraft: 含人格/开场/约定/目标', () => {
  const a = getApp('biz-eval');
  const d = buildLaunchDraft(a, '评估我的宠物 SaaS 想法');
  assert.ok(d.includes('应用人格'));
  assert.ok(d.includes('应用开场'));
  assert.ok(d.includes('业务档案'));
  assert.ok(d.includes('验收要求'));
  assert.ok(d.includes('宠物 SaaS'));
});

test('toAppProfileFragment: 转为档案片段', () => {
  const a = getApp('biz-eval');
  const f = toAppProfileFragment(a);
  assert.equal(f.key, 'biz-eval');
  assert.ok(f.modelHint && f.modelHint.defaultModel);
});
