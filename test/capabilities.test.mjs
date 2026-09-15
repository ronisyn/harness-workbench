// test/capabilities.test.mjs - RA-31 能力清单 + OP-16 降级语义夹具（2026-09-15）
// 依据《RW-Agent 架构 v1.1》§10（① 结束原因 ② 用量 ③ 用了哪些能力 ④ 自述不可信）与 §7.2（enforcement 三值）。
// 夹具的价值在**不许自夸**：层 1/2/4 一期确实没有，整体就必须是 partial；
// 任何一次"把没有的能力写成 full"都会让这里的断言报红。
import { test } from 'node:test';
import assert from 'node:assert';
import { enforcementReport, capabilityManifest, capabilitySummary, DEGRADE_CATALOG, ENFORCEMENT_VALUES } from '../server/capabilities.js';

test('OP-16：enforcement 三值成立，且四层逐层给出状态（不许笼统说"有隔离"）', () => {
  const r = enforcementReport({ permission: 'full', root: '/' });
  assert.ok(ENFORCEMENT_VALUES.includes(r.level), 'level 必须落在 full|partial|none');
  assert.equal(r.layers.length, 4, '§7.2 定义的是四层，少一层就是漏报');
  assert.deepEqual(r.layers.map((l) => l.id), [1, 2, 3, 4]);
  for (const l of r.layers) {
    assert.ok(ENFORCEMENT_VALUES.includes(l.state), l.id + ' 层 state 非法');
    assert.ok(l.note && l.note.length > 4, l.id + ' 层必须带一句实话（note）');
  }
});

test('OP-16 负例：一期没有沙箱 ⇒ 整体只能是 partial，绝不能报 full', () => {
  for (const perm of ['full', 'guard', 'write', 'read']) {
    const r = enforcementReport({ permission: perm, root: '/srv/rw-workspace' });
    assert.equal(r.level, 'partial', perm + ' 会话也不许报 full（层 1/2/4 未接入）');
  }
  const r = enforcementReport({ permission: 'full', root: '/' });
  assert.equal(r.layers.find((l) => l.id === 1).state, 'none', '环境隔离未接入 = none');
  assert.equal(r.layers.find((l) => l.id === 4).state, 'none', '网络出口未做白名单 = none');
});

test('OP-16：工具层围栏是唯一真在工作的一层，且 full 权限下降级为 partial 并说明原因', () => {
  const read = enforcementReport({ permission: 'read', root: '/srv/rw-workspace' });
  assert.equal(read.layers.find((l) => l.id === 3).state, 'full');
  const full = enforcementReport({ permission: 'full', root: '/' });
  assert.equal(full.layers.find((l) => l.id === 3).state, 'partial', 'full 权限下围栏的"根"是整台机器，只能说 partial');
  assert.match(full.layers.find((l) => l.id === 3).note, /整台机器/);
});

test('OP-16 降级目录：每条都必须是代码名词 + 用户可见文案 + 出口', () => {
  assert.ok(DEGRADE_CATALOG.length >= 6, '降级路径至少登记 6 条');
  const codes = new Set();
  for (const d of DEGRADE_CATALOG) {
    assert.match(d.code, /^[a-z][a-z0-9-]+$/, 'code 必须是代码名词（供 UI/日志用）: ' + d.code);
    assert.ok(!codes.has(d.code), 'code 不得重复: ' + d.code);
    codes.add(d.code);
    for (const k of ['when', 'visible', 'where']) assert.ok(d[k] && String(d[k]).length > 2, d.code + ' 缺 ' + k);
  }
  for (const must of ['spill-degraded', 'subagent-degraded', 'guard-halt']) assert.ok(codes.has(must), '已实现的降级必须登记: ' + must);
});

test('RA-31：能力清单成文暴露四件事（能力/约束/降级/诚实性前提）', () => {
  const m = capabilityManifest({ permission: 'read', preset: 'all', mode: 'chat', root: '/srv/rw-workspace' }, { guards: { roundCap: 60 }, tools: ['read_file', 'write_file', 'repo_map'] });
  assert.equal(m.version, 1);
  assert.ok(m.enforcement && m.enforcement.level === 'partial');
  assert.equal(m.session.permission, 'read');
  assert.equal(m.tools.total, 3);
  assert.equal(m.tools.tiers.core + m.tools.tiers.pro + m.tools.tiers.expert + m.tools.tiers.unknown, 3, 'tier 分档要能加总');
  assert.equal(m.guards.roundCap, 60, '护栏现值必须透出（§7.6）');
  assert.ok(m.hooks.n >= 13 && Array.isArray(m.hooks.list), 'hooks 策略摘要要在清单里（出事时是拦还是放）');
  assert.equal(m.honesty.selfReportUntrusted, true, '§10 ④：自述不可信这一前提必须随清单暴露');
  assert.ok(Array.isArray(m.degrade) && m.degrade.length >= 6);
});

test('RA-31：事件里带的是紧凑版（别把整份清单塞进每条事件）', () => {
  const s = capabilitySummary({ permission: 'full', root: '/' }, ['read_file', 'read_file', 'grep_search']);
  assert.equal(s.enforcement, 'partial');
  assert.deepEqual(s.layers, ['1:none', '2:none', '3:partial', '4:none'], '只带"没做到 full"的层');
  assert.deepEqual(s.used, ['read_file', 'grep_search'], 'used 去重且保序');
  assert.equal(JSON.stringify(s).length < 300, true, '紧凑版必须小（<300 字符）');
  assert.equal(s.tools, undefined, '紧凑版不带工具全名单');
});
