// test/manifest-reload.test.mjs - v0.3 §7.1 ④「声明式装载」的**热装载**夹具（补齐"零夹具"那块缺口）
//
// 为什么要有它：RA-03（改清单一行 → 工具面变化且不重启）此前只有源码关键词锚点（`startManifestWatch`）与一份
// 归档件里的手写记录，**没有行为级机检**——而"热重载失败不破坏在跑的工具面"这条纪律，恰恰是失败路径才体现的。
//
// 三条路径都要验：成功（工具面即时变化 + 派生结构同步刷新）／回滚（清单与实现不一致 ⇒ 拒绝并回到上一代）／
// 语法错误（读不进来 ⇒ 保留旧面）。
// 做法：`reloadManifest(path)` 是**测试缝**（参数注入，不动任何模块级状态），夹具只在 `tmp/` 下造临时清单副本，
// **绝不改 server/tools/manifest.js 本体**；用完删掉自己造的文件（tmp/ 已在 .gitignore 里）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reloadManifest, MANIFEST_NAMES, TOOL_META, TOOL_CN, TOOL_POLICY, LIGHT_TOOLSET, APPROVAL_REQUIRED } from '../server/tools/registry.js';
import { TOOLS } from '../server/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(ROOT, 'server', 'tools', 'manifest.js');
const TMP = path.join(ROOT, 'tmp', 'manifest-reload-' + process.pid + '-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const CLEAN = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on('exit', CLEAN);
const REAL_SRC = fs.readFileSync(REAL, 'utf8');

test('热装载成功路径：改清单一行（enabled:false）→ 工具面即时少一个，派生结构同步刷新（不重启）', async () => {
  const before = TOOLS.length;
  const p = path.join(TMP, 'manifest-disable.js');
  const patched = REAL_SRC.replace("repo_map: { tier: 'core'", "repo_map: { enabled: false, tier: 'core'");
  assert.notEqual(patched, REAL_SRC, '夹具前提：必须在副本里改到那一行（否则这条夹具什么都没验）');
  fs.writeFileSync(p, patched, 'utf8');

  const r = await reloadManifest(p);
  assert.equal(r.ok, true, '重载应成功：' + JSON.stringify(r));
  assert.equal(r.before, before);
  assert.equal(r.after, before - 1, '工具面必须少一个');
  assert.equal(MANIFEST_NAMES.length, before - 1);
  assert.equal(MANIFEST_NAMES.includes('repo_map'), false);
  assert.equal(TOOLS.length, before - 1, 'TOOLS 是身份稳定的数组：就地刷新，引用方自动看到新面');
  assert.equal(TOOLS.some((t) => t.name === 'repo_map'), false, '下线后执行面也必须看不到它（默认拒绝）');
  // 派生结构（元数据/中文名/策略/轻量集/受控集）必须跟着刷新，不许留下上一代的幽灵键
  assert.equal(TOOL_META.repo_map, undefined);
  assert.equal(TOOL_CN.repo_map, undefined);
  assert.equal(TOOL_POLICY.repo_map, undefined);
  assert.equal(LIGHT_TOOLSET.includes('repo_map'), false);
  assert.equal(APPROVAL_REQUIRED.includes('repo_map'), false);
  assert.ok(TOOL_META.read_file && TOOL_META.read_file.tier === 'core', '没被改的工具照常还在');
});

test('热装载回滚路径：新清单声明了不存在的实现 → ok:false，且工具面回到重载前那一代', async () => {
  const before = TOOLS.length;
  const names = [...MANIFEST_NAMES];
  const policies = Object.keys(TOOL_POLICY).length;
  const p = path.join(TMP, 'manifest-ghost.js');
  const ghost = "  ghost_tool: { tier: 'core', cn: '幽灵', when: '夹具', not: '—', ex: 'ghost {}', cacheImpact: 'tools-face', execBackend: 'none', parallelSafe: true },\n";
  fs.writeFileSync(p, REAL_SRC.replace('export const TOOL_MANIFEST = {', 'export const TOOL_MANIFEST = {\n' + ghost), 'utf8');

  const r = await reloadManifest(p);
  assert.equal(r.ok, false, '清单与实现不一致必须被拒绝');
  assert.match(r.error, /清单声明了不存在的工具（无实现）：ghost_tool/);
  // "重载失败不破坏在跑的工具面"：这一条是判据本体
  assert.deepEqual([...MANIFEST_NAMES], names, '派生结构必须回到重载前那一代');
  assert.equal(TOOLS.length, before, '工具面不许被失败的装载改坏');
  assert.equal(TOOLS.some((t) => t.name === 'ghost_tool'), false);
  assert.equal(Object.keys(TOOL_POLICY).length, policies);
  assert.equal(TOOL_META.repo_map, undefined, '仍是上一代（repo_map 在成功路径里被下线）——回滚不许把它带回来');
});

test('热装载语法错误路径：文件读不进来（语法坏 / 没导出 TOOL_MANIFEST）→ ok:false + 旧面保留', async () => {
  const before = TOOLS.length;
  const names = [...MANIFEST_NAMES];

  const broken = path.join(TMP, 'manifest-broken.js');
  fs.writeFileSync(broken, 'export const TOOL_MANIFEST = { oops: \n', 'utf8');
  const r1 = await reloadManifest(broken);
  assert.equal(r1.ok, false, '语法错误必须被拒绝');
  assert.ok(r1.error && r1.error.length > 0, '要如实报出错误原因');
  assert.deepEqual([...MANIFEST_NAMES], names);
  assert.equal(TOOLS.length, before);

  const nobody = path.join(TMP, 'manifest-nobody.js');
  fs.writeFileSync(nobody, 'export const SOMETHING_ELSE = {};\n', 'utf8');
  const r2 = await reloadManifest(nobody);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'TOOL_MANIFEST 缺失');
  assert.deepEqual([...MANIFEST_NAMES], names);
  assert.equal(TOOLS.length, before);
});

test('收尾：缺省参数＝真实清单路径，切回去必须成功（夹具全程只碰 tmp/ 下的副本）', async () => {
  const r = await reloadManifest(); // 缺省 = fileURLToPath(new URL('./manifest.js', import.meta.url))
  assert.equal(r.ok, true, '真实清单必须能重载：' + JSON.stringify(r));
  assert.ok(MANIFEST_NAMES.includes('repo_map'), 'repo_map 回到清单里');
  assert.ok(TOOLS.some((t) => t.name === 'repo_map'), '执行面也回来了');
  assert.equal(fs.existsSync(REAL), true, '服务器本体清单文件必须原封不动');
  // 逐字节核对：夹具没有（也不许）改动 server/tools/manifest.js
  assert.equal(fs.readFileSync(REAL, 'utf8'), REAL_SRC, '本条夹具不许改动清单本体');
});
