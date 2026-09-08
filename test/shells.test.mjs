// test/shells.test.mjs - B1 壳定义基座纯函数单测（无需服务器）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack, packToRow, rowToPack, toolsThreeState, shellContext, isKeyOk, SHELL_DEFAULT_KEY } from '../server/shells.js';

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

test('qualityCostBias 允许空(null)（rowToPack/clone 用）', () => {
  assert.equal(validatePack({ shellPackVersion: 1, key: 'code', name: 'x', modelPolicy: { qualityCostBias: null } }).ok, true);
});

test('rowToPack/toolsThreeState 兼容 mysql2 已反序列化的 JSON 值（clone 三态不丢）', () => {
  const row = { skey: 'code', name: '代码壳', description: '', persona: 'p', domain_text: 'd',
    model_policy: { defaultProvider: 'deepseek', defaultModel: 'm', allowModels: [], budgetYuan: 0, qualityCostBias: 3 },
    tools_preset: 'standard', tools_force_on: [], tools_force_off: ['run_command'],
    knowledge_scopes: ['global'], skills_allow: [], guardrails: [], channels: [], eval_ref: null };
  const p = rowToPack(row);
  assert.deepEqual(p.tools.forceOff, ['run_command']);
  assert.equal(p.modelPolicy.defaultProvider, 'deepseek');
  assert.equal(toolsThreeState(row).forceOff[0], 'run_command');
  assert.equal(shellContext(row).persona, 'p');
});

test('默认壳 key 常量', () => {
  assert.equal(SHELL_DEFAULT_KEY, 'default');
  assert.equal(isKeyOk('default'), true);
  assert.equal(isKeyOk('ab'), true);
  assert.equal(isKeyOk('A b'), false);
});

test('F2 pack 往返保真：tone/terms/uiBrand/importRefs/mcps 等 export→import→export 不丢', () => {
  const pack = {
    shellPackVersion: 1, key: 'rt', name: '往返', description: 'd',
    identity: { persona: 'p', tone: '直接', forbidden: ['A'] },
    domain: { agendsText: 'x', terms: ['t1'] },
    modelPolicy: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash', allowModels: [], budgetYuan: 0, qualityCostBias: 3 },
    tools: { presetBase: 'standard', forceOn: [], forceOff: ['run_command'], mcps: [{ id: 'm1' }], connectors: [{ id: 'c1' }] },
    knowledge: { scopes: ['global'], importRefs: ['ref1.md'] },
    skills: { allow: [], defaultsAutoLoad: ['task-approach'] },
    guardrails: { accessRules: [], approvalMode: 'strict', sensitiveDefaults: ['run_command'] },
    channels: { domainHosts: [], bindings: { wechat: 'x' } },
    uiBrand: { title: '品牌' },
    credentials: { ref: 'env:XXX' },
    intentRules: { do: ['修'] }, taskProfiles: [],
  };
  // pack → row → pack（模拟 import→export 语义）
  const row = packToRow(pack);
  const back = rowToPack(row);
  assert.equal(back.identity.tone, '直接');
  assert.deepEqual(back.identity.forbidden, ['A']);
  assert.deepEqual(back.domain.terms, ['t1']);
  assert.deepEqual(back.tools.mcps, [{ id: 'm1' }]);
  assert.deepEqual(back.tools.connectors, [{ id: 'c1' }]);
  assert.deepEqual(back.knowledge.importRefs, ['ref1.md']);
  assert.deepEqual(back.skills.defaultsAutoLoad, ['task-approach']);
  assert.equal(back.guardrails.approvalMode, 'strict');
  assert.deepEqual(back.channels.bindings, { wechat: 'x' });
  assert.deepEqual(back.uiBrand, { title: '品牌' });
  assert.deepEqual(back.credentials, { ref: 'env:XXX' });
  assert.deepEqual(back.tools.forceOff, ['run_command']);
});
