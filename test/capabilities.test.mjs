// test/capabilities.test.mjs - RA-31 能力清单 + OP-16 降级语义夹具（2026-09-15）
// 依据《RW-Agent 架构 v1.1》§10（① 结束原因 ② 用量 ③ 用了哪些能力 ④ 自述不可信）与 §7.2（enforcement 三值）。
// 夹具的价值在**不许自夸**：层 1/2/4 一期确实没有，整体就必须是 partial；
// 任何一次"把没有的能力写成 full"都会让这里的断言报红。
// 2026-09-16 增补：候选 D（提示注入如实声明）——同一立场的第二个对象，见文件末尾三段。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforcementReport, capabilityManifest, capabilitySummary, DEGRADE_CATALOG, ENFORCEMENT_VALUES, PROMPT_INJECTION } from '../server/capabilities.js';

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
  assert.equal(s.promptInjection, 'none', '候选 D：run_end 紧凑版同样要带诚实性取值');
  assert.deepEqual(s.layers, ['1:none', '2:none', '3:partial', '4:none'], '只带"没做到 full"的层');
  assert.deepEqual(s.used, ['read_file', 'grep_search'], 'used 去重且保序');
  assert.equal(JSON.stringify(s).length < 300, true, '紧凑版必须小（<300 字符）');
  assert.equal(s.tools, undefined, '紧凑版不带工具全名单');
});

// ---------------------------------------------------------------------------
// 候选 D（2026-09-16 拍板）：提示注入必须**如实声明**，且不得溜进模型上下文
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('候选 D：诚实字段在位、取值落在三值语义、必带一句实话', () => {
  const m = capabilityManifest({ permission: 'write', preset: 'all', mode: 'chat', root: '/srv/rw-workspace' });
  const pi = m.promptInjection;
  assert.ok(pi && typeof pi === 'object', 'promptInjection 必须是一等字段（不许塞进 enforcement.layers：那是 §7.2 的四层）');
  assert.equal(m.enforcement.layers.length, 4, '四层仍是四层——新增字段不得混进 layers');
  assert.ok(ENFORCEMENT_VALUES.includes(pi.level), 'level 必须落在 full|partial|none：' + pi.level);
  assert.ok(pi.note && pi.note.length > 4, '必须带一句实话（note），不许只给个取值');
  assert.match(pi.note, /外部内容/, '实话要说清"什么进得来"（外部内容与用户输入同权）');
});

test('候选 D 负例：一条防线都没有 ⇒ 只能报 none；报 partial/full 必须先有真机制', () => {
  // 为什么锁 none：今天平台侧没有任何"按来源判定能否当指令"的机制（方案 §4-2 不按来源加门禁、
  // §4-3 不做注入词扫描、§4-1 不给所有结果加标记）。真要改成 partial/full，就得先有机制 + 新夹具。
  assert.equal(PROMPT_INJECTION.level, 'none', '提示注入仍无防线：把它写成 partial/full 就是自夸（§3-D 负例）');
  assert.notEqual(PROMPT_INJECTION.level, 'full');
  // 也不许"顺手"塞进四层冒充隔离层
  assert.equal(enforcementReport({ permission: 'full' }).layers.some((l) => /注入/.test(l.name)), false);
});

test('候选 D：两个用户可见出口都带它，且它**不进模型上下文**（HTTP/事件专用）', async () => {
  // ① 出口一：HTTP manifest（/api/agent/capabilities 的响应体就是 capabilityManifest 的产物）
  const idx = read('server/index.js');
  assert.match(idx, /manifest: capabilityManifest\(ctx, \{ guards, tools \}\)/, 'HTTP manifest 出口必须原样吐 capabilityManifest');
  // ② 出口二：run_end（saved / stopped / error 三条路径各一次）
  assert.ok((idx.match(/capabilities: capabilitySummary\(/g) || []).length >= 3, 'run_end 三条路径都要带能力摘要');

  // ③ 负例：这句实话**不得**出现在任何"给模型的文本"里。
  //    · 系统提示的单一拼装出口是 buildEnvFor（server/agent.js），逐权限核一遍；
  const { buildEnvFor } = await import('../server/agent.js');
  for (const perm of ['full', 'guard', 'write', 'read']) {
    assert.equal(buildEnvFor(perm).includes('提示注入未防住'), false, '诚实性字段溜进了系统提示（' + perm + '）——那是提示词，不是声明');
  }
  //    · 结构锁：这句实话在整个 server/ 里只许出现在 capabilities.js（有第二处 = 有人把它当提示词/工具结果用了）
  const hits = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'server'), { recursive: true })) {
    const rel = path.join('server', String(f));
    if (!/\.(js|mjs)$/.test(rel)) continue;
    if (rel.endsWith(path.join('capabilities.js'))) continue;
    if (read(rel).includes('提示注入未防住')) hits.push(rel);
  }
  assert.deepEqual(hits, [], '这句实话只属于 capabilities.js（给人看的清单），出现在别处就意味着它进了模型上下文：' + hits.join(', '));
  //    · 反向锁：能力清单模块不得被系统提示/agent 侧引用（省前缀那件事要有结构保证，不只靠约定）
  assert.equal(/capabilities\.js/.test(read('server/agent.js')), false, 'server/agent.js（系统提示的拼装处）不得引用能力清单');
});
