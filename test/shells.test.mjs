// test/shells.test.mjs - B1 壳定义基座纯函数单测（无需服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, packToRow, toolsThreeState, shellContext, isKeyOk, SHELL_DEFAULT_KEY } from '../server/shells.js';

test('validatePack 通过合法 pack', () => {
  const r = validatePack({ shellPackVersion: 1, key: 'code', name: '代码壳' });
  assert.equal(r.ok, true);
});

test('validatePack 拒绝非法 key/preset/qualityCostBias', () => {
  assert.equal(validatePack({ shellPackVersion: 1, key: 'Code!', name: 'x' }).ok, false);
  assert.equal(validatePack({ shellPackVersion: 1, key: 'code', name: 'x', tools: { presetBase: 'zzz' } }).ok, false);
  assert.equal(validatePack({ shellPackVersion: 1, key: 'code', name: 'x', modelPolicy: { qualityCostBias: 99 } }).ok, false);
});

test('validatePack 收容未知字段（向前兼容）且给出 warning', () => {
  const r = validatePack({ shellPackVersion: 1, key: 'code', name: 'x', futureField: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('futureField')));
});

test('packToRow 映射与三态提取', () => {
  const row = packToRow({
    shellPackVersion: 1, key: 'code', name: '代码壳',
    identity: { persona: 'p' }, modelPolicy: { budgetYuan: 5, qualityCostBias: 3 },
    tools: { presetBase: 'standard', forceOn: [], forceOff: ['run_command'] },
    knowledge: { scopes: ['global', 'shell'] },
  });
  assert.equal(row.skey, 'code');
  assert.equal(row.tools_preset, 'standard');
  const three = toolsThreeState(row);
  assert.deepEqual(three.forceOff, ['run_command']);
  assert.equal(shellContext({ skey: 'code', persona: '"p"', domain_text: 'd' }).persona, 'p');
});

test('中性壳 persona 为 null；空字符串→null', () => {
  assert.equal(shellContext({ skey: 'default', persona: null, domain_text: '' }).persona, null);
  const row = packToRow({ shellPackVersion: 1, key: 'code', name: 'x', identity: { persona: '' } });
  assert.equal(row.persona, null);
});

test('默认壳 key 常量', () => {
  assert.equal(SHELL_DEFAULT_KEY, 'default');
  assert.equal(isKeyOk('default'), true);
  assert.equal(isKeyOk('ab'), true);
  assert.equal(isKeyOk('A b'), false);
});
