// test/manifest.test.mjs - 步7 声明式工具清单与装载器：
//   ① 清单 × 实现装配零漂移（与改造前快照逐字段比对）
//   ② 校验会在装配期拦下"清单说谎 / 实现重名 / 缺实现要件"
//   ③ 默认拒绝：没进清单的实现不装载（= 删一行即下线）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOL_MANIFEST, TOOL_TIER_CN } from '../server/tools/manifest.js';
import { assembleTools, TOOL_META, TOOL_CN, DEFAULT_TOOLSET, PLATFORM_EXEMPT, LIGHT_TOOLSET, MANIFEST_NAMES } from '../server/tools/registry.js';
import { TOOLS, toolDefs } from '../server/tools/index.js';

const SNAP = JSON.parse(fs.readFileSync(new URL('./fixtures/tools-snapshot.json', import.meta.url), 'utf8'));
const byName = (arr) => Object.fromEntries(arr.map((x) => [x.name, x]));
// 快照是 JSON（undefined 值在序列化时被丢弃），比对前把运行期对象也过一遍 JSON，避免"假漂移"
const J = (x) => JSON.parse(JSON.stringify(x));
const localDefs = toolDefs('all', null, null).filter((d) => !/^mcp_/.test(d.function.name));

test('清单条目本身合法：档位合法、中文名齐备、与实现一一对应', () => {
  assert.equal(MANIFEST_NAMES.length, Object.keys(TOOL_MANIFEST).length, '启用条目数应等于清单条目数（本测试不覆盖 enabled:false 的下线态）');
  for (const [name, m] of Object.entries(TOOL_MANIFEST)) {
    assert.ok(['core', 'pro', 'expert'].includes(m.tier), name + ' 档位非法');
    assert.ok(m.cn && m.cn.length, name + ' 缺中文名');
    if (TOOL_META[name]) assert.ok(TOOL_META[name].when, name + ' 缺 when（模型选择提示）');
  }
  for (const n of Object.keys(TOOL_META)) assert.equal(TOOL_META[n].tier, TOOL_MANIFEST[n].tier);
});

test('装配零漂移：工具契约与改造前快照逐字段一致', () => {
  const live = byName(localDefs.map((d) => d.function));
  const snap = byName(SNAP.defs);
  assert.deepEqual(Object.keys(live).sort(), Object.keys(snap).sort(), '工具名集合必须与快照一致');
  for (const n of Object.keys(snap)) {
    assert.equal(live[n].description, snap[n].description, n + ' description 漂移');
    assert.deepEqual(J(live[n].parameters), snap[n].parameters, n + ' 参数 schema 漂移');
  }
  const liveTools = byName(TOOLS.map((t) => ({ name: t.name, permission: t.permission, params: t.params })));
  const snapTools = byName(SNAP.tools);
  for (const n of Object.keys(snapTools)) {
    assert.equal(liveTools[n].permission, snapTools[n].permission, n + ' permission 漂移');
    assert.deepEqual(J(liveTools[n].params), snapTools[n].params, n + ' params 漂移');
  }
});

test('元数据与四个集合与快照一致（集合由清单派生，不再各写一份）', () => {
  assert.deepEqual(TOOL_META, SNAP.meta);
  // 快照里多出的两个键是已退役工具的残留（plan_mode/exit_plan_mode）——清单化后不再保留幽灵键
  const ghosts = Object.keys(SNAP.cn).filter((n) => !SNAP.tools.some((t) => t.name === n));
  assert.deepEqual(ghosts.sort(), ['exit_plan_mode', 'plan_mode']);
  for (const n of Object.keys(SNAP.cn)) {
    if (ghosts.includes(n)) continue;
    assert.equal(TOOL_CN[n], SNAP.cn[n], n + ' 中文名漂移');
  }
  assert.deepEqual(Object.keys(TOOL_CN).filter((n) => ghosts.includes(n)), []);
  assert.deepEqual([...DEFAULT_TOOLSET].sort(), SNAP.defaultToolset);
  assert.deepEqual([...PLATFORM_EXEMPT].sort(), SNAP.platformExempt);
  assert.deepEqual([...LIGHT_TOOLSET].sort(), SNAP.lightToolset);
  assert.deepEqual(TOOL_TIER_CN, SNAP.tierCn);
});

test('默认拒绝：没进清单的实现不装载（等价于"删掉清单行即下线"）', () => {
  const ghost = { name: 'ghost_tool', description: '没进清单的工具', permission: 'read', params: {}, run: async () => ({}) };
  const out = assembleTools([...TOOLS, ghost]);
  assert.equal(out.some((t) => t.name === 'ghost_tool'), false, '未进清单的工具必须被拒绝装载');
  assert.equal(out.length, TOOLS.length);
});

test('装配期拦错：清单声明了不存在的实现 → 抛错（清单不许说谎）', () => {
  assert.throws(() => assembleTools(TOOLS.filter((t) => t.name !== 'repo_map')), /清单声明了不存在的工具（无实现）：repo_map/);
});

test('装配期拦错：实现重名 / 缺 run / 缺 description / 缺 permission', () => {
  const dup = [...TOOLS, { ...TOOLS[0] }];
  assert.throws(() => assembleTools(dup), /工具重名：/);
  assert.throws(() => assembleTools(TOOLS.map((t) => (t.name === 'repo_map' ? { ...t, run: undefined } : t))), /工具缺少 run 实现：repo_map/);
  assert.throws(() => assembleTools(TOOLS.map((t) => (t.name === 'repo_map' ? { ...t, description: '' } : t))), /工具缺少 description/);
  assert.throws(() => assembleTools(TOOLS.map((t) => (t.name === 'repo_map' ? { ...t, permission: '' } : t))), /工具缺少 permission/);
});
