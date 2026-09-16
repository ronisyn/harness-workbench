// test/g2-toolface-unload.test.mjs - v0.3 §0.2 **G2「可装配」** 的端到端出口读数
//
// 出口判据原话（v0.3 §0.2）：**「装一个新工具 + 一个外部 MCP 后工具面正确；卸载后立即消失」**。
// 现状（本轮开头）：声明式装载、清单热重载、MCP 同一注册表、`registerDynamicTools`/`unregisterDynamicTools`
// 都在位，但**只有机制级用例**（`manifest-reload.test.mjs` 验清单热重载、`mcp-registry.test.mjs` 验注册表纪律），
// 没有一条"装 → 工具面出现 → 卸载 → 工具面立即少一条"的**整面读数**。本夹具就是那条读数。
//
// 一次跑完四步，**同一进程内、不重启**（输出里带 pid，作为"没换进程"的证据）：
//   ① 读数：装载前的工具面（条数 + 名单）
//   ② 装：一个**新工具**（声明式：临时清单副本 +1 行，经 `reloadManifest(path)` 注入缝热装载）
//        + 一个**外部 MCP**（`scripts/fixtures/fake-mcp-server.mjs`，真 spawn 的假 server，两页 tools/list）
//   ③ 读数：工具面必须正确（多出的正是那三条）
//   ④ 卸：清单行去掉 → 重载；MCP 断开 → 同步工具面 ⇒ 工具面**立即**少三条，回到 ①
//
// 边界（如实登记）：
//   · **不调模型**（只读工具面 defs：`toolDefs()` 就是发给厂商的 tools 数组的出处）；
//   · **不连外部服务**（MCP 是本机的假 server 子进程，命令＝`process.execPath`）；
//   · 一次性环境：临时清单副本写在 `os.tmpdir()` 下的一次性目录里，退出即删；**不碰** `server/tools/manifest.js` 本体
//     （收尾会逐字节核对本体没被改过——与 `manifest-reload.test.mjs` 同一条纪律）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_MANIFEST = path.join(ROOT, 'server', 'tools', 'manifest.js');
// 假 MCP server 在 scripts/fixtures（不能放 test/ 下：`node --test` 会把 test/**/*.mjs 当测试跑，
// 那个"等 stdin 说话"的进程会让整套测试永久挂住——见该文件头的实测记录）。
const FAKE_MCP = path.join(ROOT, 'scripts', 'fixtures', 'fake-mcp-server.mjs');
const REAL_SRC = fs.readFileSync(REAL_MANIFEST, 'utf8');

const { TOOLS, toolDefs, execTool, syncMcpTools } = await import('../server/tools/index.js');
const { reloadManifest, registerToolSource, dynamicSourceIds, MANIFEST_NAMES, TOOL_POLICY } = await import('../server/tools/registry.js');
const { connectMcp, disconnectMcp, listMcpClients } = await import('../server/mcp.js');

// 本进程刚导入 tools/index.js：动态来源表还是空的（MCP 由本夹具在后面自己接），
// 所以此刻的 TOOLS 就是**静态实现表**（清单 × 实现）。装新工具要往这份实现表里追加一条。
const STATIC_IMPLS = [...TOOLS];
const MCP_ID = 'g2mcp';
const DEMO = 'g2_demo_tool';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-g2-toolface-'));

/** 工具面读数：**给模型看的那一份**（toolDefs 就是请求里 tools 数组的出处），按装载顺序原样列出。 */
function readFace() {
  const names = toolDefs('all', null, null).map((d) => d.function.name);
  return { count: names.length, names };
}

/** 一次性清单副本：把真清单源码 +1 行工具声明、+1 行权限声明，写到临时目录（绝不改本体）。 */
function writeManifestCopy(file, { withDemo }) {
  let src = REAL_SRC;
  if (withDemo) {
    const row = "  " + DEMO + ": { tier: 'pro', cn: 'G2 读数演示工具', when: 'G2 出口读数', not: '—', "
      + "ex: '" + DEMO + " {}', cacheImpact: 'tools-face', execBackend: 'none', parallelSafe: true },\n";
    const perm = "  " + DEMO + ": 'read',\n";
    const withRow = src.replace('export const TOOL_MANIFEST = {', 'export const TOOL_MANIFEST = {\n' + row);
    assert.notEqual(withRow, src, '夹具前提：工具声明那一行必须插进副本（否则这条读数什么都没验）');
    src = withRow.replace('export const TOOL_PERMISSIONS = {', 'export const TOOL_PERMISSIONS = {\n' + perm);
    assert.match(src, new RegExp(DEMO + ": 'read'"), '夹具前提：权限声明也必须插进副本（清单是权限的唯一出处）');
  }
  fs.writeFileSync(file, src, 'utf8');
  return file;
}

/** 装新工具：实现侧注入一条 + 清单侧多一行（两步都是**既有注入缝**，不改任何 server/** 文件）。 */
function injectDemoImplementation() {
  const demo = {
    name: DEMO,
    description: 'G2 出口读数用的一次性工具（临时清单 + 实现注入，不进仓库清单）',
    params: {},
    run: async () => ({ content: 'g2-demo-ok' }),
  };
  registerToolSource([...STATIC_IMPLS, demo], (next) => { TOOLS.length = 0; TOOLS.push(...next); });
}

test.after(() => {
  disconnectMcp(MCP_ID);
  syncMcpTools([]);
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('G2 出口：装一个新工具 + 一个外部 MCP ⇒ 工具面正确；卸载 ⇒ 立即消失（同进程，无重启）', async () => {
  // ── ① 装载前 ────────────────────────────────────────────────────────────────
  const f0 = readFace();
  console.log('[G2] pid=' + process.pid + ' ① 装载前：工具面 ' + f0.count + ' 条');
  console.log('[G2] ① 名单：' + JSON.stringify(f0.names));
  assert.equal(f0.names.includes(DEMO), false, '夹具前提：装载前不该有这个工具');
  assert.equal(f0.names.some((n) => n.startsWith('mcp_' + MCP_ID + '_')), false, '夹具前提：装载前不该有这个 MCP 的工具');

  // ── ② 装：新工具（声明式热装载）+ 外部 MCP（假 server，真 spawn）────────────────
  const on = writeManifestCopy(path.join(TMP, 'manifest-with-demo.js'), { withDemo: true });
  injectDemoImplementation();
  const r = await reloadManifest(on);
  assert.equal(r.ok, true, '清单热装载必须成功：' + JSON.stringify(r));

  const info = await connectMcp(MCP_ID, process.execPath, [FAKE_MCP]);
  const mcpTools = (info.tools || []).map((t) => 'mcp_' + MCP_ID + '_' + t).sort();
  assert.deepEqual(mcpTools, ['mcp_' + MCP_ID + '_echo', 'mcp_' + MCP_ID + '_second_page_tool'], '假 server 两页 tools/list 必须全取回');
  syncMcpTools(listMcpClients());

  // ── ③ 装载后 ────────────────────────────────────────────────────────────────
  const f1 = readFace();
  const added = f1.names.filter((n) => !f0.names.includes(n));
  console.log('[G2] ② 装载：清单 +1 行（' + DEMO + '）· 外部 MCP ' + MCP_ID + '（' + mcpTools.join(',') + '）');
  console.log('[G2] ③ 装载后：工具面 ' + f1.count + ' 条（+ ' + (f1.count - f0.count) + '）');
  console.log('[G2] ③ 名单：' + JSON.stringify(f1.names));
  console.log('[G2] ③ 本步新增：' + JSON.stringify(added));
  assert.equal(f1.count, f0.count + 3, '工具面必须正好多三条（1 个新工具 + 2 个 MCP 工具）');
  assert.deepEqual(added.sort(), [DEMO, 'mcp_' + MCP_ID + '_echo', 'mcp_' + MCP_ID + '_second_page_tool'].sort(),
    '多出来的必须正好是声明的那三条，不多不少');
  assert.deepEqual(dynamicSourceIds(), ['mcp'], '外部 MCP 走既有唯一注册路径（同一个 mcp 动态来源）');
  // 工具面"正确"不只是名字在：那条新工具真的可执行（不是只挂了个 def）
  const called = await execTool(DEMO, {}, { permission: 'full', root: ROOT, conversationId: 0, accountId: 0 });
  assert.equal(called.content, 'g2-demo-ok', '新工具必须可执行：' + JSON.stringify(called).slice(0, 160));

  // ── ④ 卸载（同一进程、不重启）────────────────────────────────────────────────
  const off = writeManifestCopy(path.join(TMP, 'manifest-without-demo.js'), { withDemo: false });
  const r2 = await reloadManifest(off);
  assert.equal(r2.ok, true, '卸载（清单去掉那一行）必须成功：' + JSON.stringify(r2));
  disconnectMcp(MCP_ID);
  syncMcpTools(listMcpClients());

  // ── ⑤ 卸载后 ────────────────────────────────────────────────────────────────
  const f2 = readFace();
  const gone = f1.names.filter((n) => !f2.names.includes(n));
  console.log('[G2] ④ 卸载：清单去掉那一行 + 断开 ' + MCP_ID + ' + 同步工具面');
  console.log('[G2] ⑤ 卸载后：工具面 ' + f2.count + ' 条（- ' + (f1.count - f2.count) + '）');
  console.log('[G2] ⑤ 名单：' + JSON.stringify(f2.names));
  console.log('[G2] ⑤ 本步消失：' + JSON.stringify(gone));
  assert.equal(f2.count, f0.count, '"卸载后立即消失"：必须一条不剩地回到装载前（' + f0.count + '）');
  assert.deepEqual(gone.sort(), [DEMO, 'mcp_' + MCP_ID + '_echo', 'mcp_' + MCP_ID + '_second_page_tool'].sort(),
    '消失的必须正好是被卸载的那三条');
  assert.equal(f2.names.includes(DEMO), false, '新工具必须立即从工具面消失');
  assert.equal(f2.names.some((n) => n.startsWith('mcp_' + MCP_ID + '_')), false, 'MCP 工具必须立即从工具面消失');
  // 执行面（同一张 TOOLS）也必须立即看不到它们——工具面少了不等于执行面少了
  assert.equal(TOOLS.some((t) => t.name === DEMO), false, '卸载后执行面不得残留该工具');
  assert.equal(TOOLS.some((t) => t.name.startsWith('mcp_' + MCP_ID + '_')), false, '卸载后执行面不得残留该 MCP 的工具');
  // 如实记：`syncMcpTools([])` 走的是 registerDynamicTools('mcp', []) —— 来源本身留着一个**空壳**
  // （`dynamicSourceIds()` 仍有 'mcp'，条目数 0），撤掉来源本体的是 `unregisterDynamicTools`。
  // 这里判"工具面/执行面有没有它"，不判壳子在不在（壳子不影响任何读数：空来源产不出条目）。
  assert.deepEqual(dynamicSourceIds(), ['mcp'], '空壳语义如实登记（与 mcp-registry 夹具的清理口径一致）');
});

test('回归锁：清单热重载**能加**（新增一行工具声明 + 对应权限声明 ⇒ 装载成功且工具面多一条），也能减', async () => {
  // 这条锁是 2026-09-17 实测撞出的既有缺陷的**病根锁**（详见 registry.js 里 validatePermissions 调用处的注释）：
  // `reloadManifest` 把新权限表存进 `activePermissions`（"不能退回模块常量"），而装配期的权限交叉核对当时吃的是
  // `validatePermissions` 的缺省值——**模块导入期那张常量表** ⇒ 条目贴的是新表、核对读的是旧表 ⇒
  // 热重载**新增**一条工具（或一条权限声明）必被拒并整体回滚。**"减"那一侧不受影响**（M1 验收正是走减），
  // 所以这条分叉此前一直没暴露。下面两半必须同时在位：只测减会让病根回来时夹具照样绿。
  injectDemoImplementation();

  const on = writeManifestCopy(path.join(TMP, 'lock-manifest-with-demo.js'), { withDemo: true });
  const add = await reloadManifest(on);
  assert.equal(add.ok, true, '热重载**加**必须成功（这是病根锁，红了就是那处分叉回来了）：' + JSON.stringify(add));
  assert.equal(add.after, add.before + 1, '工具面必须多一条');
  assert.ok(MANIFEST_NAMES.includes(DEMO), '新工具必须进当前生效清单');
  assert.ok(TOOLS.some((t) => t.name === DEMO), '新工具必须真的装载进同一张 TOOLS');
  assert.equal(TOOL_POLICY[DEMO]?.permission, 'read', '权限档必须来自**新**那一张权限表（两侧不同源时这里会是 undefined）');
  assert.equal(readFace().names.includes(DEMO), true, '工具面（给模型那一份）必须看得见它');

  const off = writeManifestCopy(path.join(TMP, 'lock-manifest-without-demo.js'), { withDemo: false });
  const rem = await reloadManifest(off);
  assert.equal(rem.ok, true, '热重载**减**必须照旧成立（M1 读数不许退化）：' + JSON.stringify(rem));
  assert.equal(rem.after, rem.before - 1, '工具面必须少一条');
  assert.equal(MANIFEST_NAMES.includes(DEMO), false);
  assert.equal(TOOLS.some((t) => t.name === DEMO), false);
  assert.equal(readFace().names.includes(DEMO), false);
});

test('收尾：本夹具只碰一次性副本，server/tools/manifest.js 逐字节未改', () => {
  assert.equal(fs.readFileSync(REAL_MANIFEST, 'utf8'), REAL_SRC, 'G2 读数不许改动清单本体');
  // 卸载路径走完，工具面回到真实清单那一代（静态部分完整）
  const names = readFace().names;
  assert.ok(names.includes('repo_map') && names.includes('read_file'), '真实清单的工具必须都还在');
});
