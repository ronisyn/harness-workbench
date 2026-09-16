// test/connectors-reload.test.mjs - 连接器热加载（2026-09-17 闭"改完 settings.connectors 必须重启"的缺口）
//
// 被验的入口只有一条：`server/connectors.js` 的 `reloadDeclaredSources(dbc)` —— `POST /api/mcp/reload` 的唯一实现
// （端点本身只做鉴权与转呈，见本文件最后一条源码级锁）。它同时管**两份声明**：
//   · `settings.mcp_servers` → 既有 `connectConfiguredMcps`；
//   · `settings.connectors`  → `connectConfiguredConnectors`（MCP 路并进同一客户端池；HTTP 路注册/替换 `connector:<id>`）。
//
// 本夹具锁四条（每条都是"用户做不到 → 做得到"的那一步，且**同进程内不重启**）：
//   ① 加/改/删三种变化一次跑通：新增连接器 → 工具面出现；HTTP 动作改了 → 新动作立即出现（声明即 schema）；
//      声明里删掉 → 源与工具立即消失；
//   ② **不在声明里的 `connector:*` 源一律撤掉**（G2 同一条纪律）——声明里只留另一个连接器时，前一个必须消失；
//   ③ **失败如实报、且不留半态**：连接器声明非法 ⇒ 连接器那半边**冻结**（上一代工具面保持、一个源都不撤）、
//      错误原文进 `connectorError`；而 `mcp_servers` 那半边照常生效（一处写坏的声明不拖走另一处已好的功能）；
//   ④ **不放宽鉴权**：端点仍是 `requireAuth`，且响应只增字段（`results`/`registeredTools` 逐字不变）。
//
// 环境：真 spawn 假 MCP server（`scripts/fixtures/fake-mcp-server.mjs`，两页 tools/list）、假 fetch 不参与
// （HTTP 连接器本夹具只装配、不调用网络）；**不调模型、不连外部服务、不碰真库**（假库只认 settings 那条 SELECT）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAKE_MCP = path.join(HERE, '../scripts/fixtures/fake-mcp-server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-connreload-'));
process.env.RW_CREDENTIALS_FILE = path.join(TMP, '.credentials.yaml'); // 必须在 import 之前设（credentials.js 每次现算路径）

const { reloadDeclaredSources } = await import('../server/connectors.js');
const { setSecret } = await import('../server/credentials.js');
const { TOOLS, syncMcpTools } = await import('../server/tools/index.js');
const { dynamicSourceIds, unregisterDynamicTools } = await import('../server/tools/registry.js');
const { disconnectMcp, listMcpClients } = await import('../server/mcp.js');

const TOKEN = 'conn-reload-token-' + 'B'.repeat(20);
const NAME = 'FAKE_RELOAD_TOKEN';
const NAME2 = 'FAKE_RELOAD_TOKEN_2';
assert.ok(!process.env[NAME] && !process.env[NAME2], '夹具前提：这两个凭据名不得已存在于进程环境里');
setSecret(NAME, TOKEN);
setSecret(NAME2, TOKEN + '-2');

/** 假库：只认 settings 那一张表的 SELECT（其余一律抛错，免得夹具悄悄假装支持了什么）。
 *  与 connectors.test.mjs 的同款假库同一形状；差别只有"值可改"（热加载夹具要连改三次声明）。 */
class FakeDb {
  constructor(settings = {}) { this.rows = new Map(Object.entries(settings)); }   // 直接存对象（等价 mysql2 的 JSON 列）
  set(key, value) { this.rows.set(key, value); return this; }
  async query(sql, params) {
    if (/^SELECT svalue FROM settings WHERE skey=\?$/.test(sql)) {
      return this.rows.has(params[0]) ? [{ svalue: this.rows.get(params[0]) }] : [];
    }
    throw new Error('假库不认识的查询：' + sql);
  }
}

/** HTTP 连接器声明（正对照；`extra` 用来造"动作被改过"的第二种声明）。 */
const httpConn = (id, cred = NAME, extra = false) => ({
  id, kind: 'http', baseUrl: 'https://api.example.com/v1', credential: cred,
  actions: [
    { name: 'get_item', method: 'GET', path: '/items/{itemId}', params: { itemId: { in: 'path' } } },
    ...(extra ? [{ name: 'added_action', method: 'GET', path: '/added' }] : []),
  ],
});
/** MCP 连接器声明（kind=mcp，与 settings.mcp_servers 同形；args 可换 ⇒ 用来测"变更的源真的被换掉"）。 */
const mcpConn = (id, args = [FAKE_MCP]) => ({ id, kind: 'mcp', command: process.execPath, args });
const mcpServer = (id, args = [FAKE_MCP]) => ({ id, command: process.execPath, args });

const hasTool = (n) => TOOLS.some((t) => t.name === n);
const faceHas = (n) => hasTool(n);

test.beforeEach(() => {
  // 动态来源与客户端池是**进程级状态**：不清干净，上一条用例的残留会变成下一条的断言依据
  for (const c of listMcpClients()) disconnectMcp(c.id);
  syncMcpTools([]);
  for (const sid of dynamicSourceIds()) unregisterDynamicTools(sid);
});

test.after(() => {
  for (const c of listMcpClients()) disconnectMcp(c.id);
  syncMcpTools([]);
  for (const sid of dynamicSourceIds()) unregisterDynamicTools(sid);
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── ① 加 / 改 / 删 三种变化，同一进程内跑完（不重启）────────────────────────────────────
test('热加载：加连接器 → 工具面出现；改动作 → 新动作立即出现；删声明 → 源与工具立即消失', async () => {
  const db = new FakeDb({
    mcp_servers: [mcpServer('rela')],
    connectors: [httpConn('demo'), mcpConn('relb')],
  });

  // 装载（= 一次 reload，不改任何配置文件、不重启）
  const r1 = await reloadDeclaredSources(db);
  assert.equal(r1.ok, true, '首次装载必须成功：' + JSON.stringify(r1.failures));
  assert.deepEqual(r1.mcp, [{ id: 'rela', ok: true, tools: 2 }], 'mcp_servers 那半边走既有实现：' + JSON.stringify(r1.mcp));
  assert.deepEqual(r1.connectors, [
    // 顺序＝`connectConfiguredConnectors` 自己的记录顺序（MCP 路先跑完、HTTP 路后跑）——照抄事实，不另立一套序
    { id: 'relb', kind: 'mcp', ok: true, tools: 2 },
    { id: 'demo', kind: 'http', ok: true, tools: 1 },
  ], '连接器那半边逐条如实：' + JSON.stringify(r1.connectors));
  assert.equal(r1.registeredTools, 4, 'MCP 工具 4 条（rela 2 + relb 2）——两份声明的 MCP 进的是同一张工具表');
  assert.deepEqual(r1.sources, ['connector:demo', 'mcp'], 'HTTP 连接器各自一条 connector:<id> 来源，MCP 共用 mcp 来源');
  for (const n of ['conn_demo_get_item', 'mcp_rela_echo', 'mcp_rela_second_page_tool', 'mcp_relb_echo', 'mcp_relb_second_page_tool']) {
    assert.ok(faceHas(n), '装载后工具面必须有 ' + n);
  }

  // 改①：HTTP 动作清单里多了一个动作（声明即 schema ⇒ 同一次 reload 后新动作必须已经可调用）
  db.set('connectors', [httpConn('demo', NAME, true), mcpConn('relb')]);
  const r2 = await reloadDeclaredSources(db);
  assert.equal(r2.ok, true);
  assert.ok(faceHas('conn_demo_added_action'), '改过的声明必须立即生效（新动作出现在同一张工具表里）');
  assert.deepEqual(r2.connectors.find((x) => x.id === 'demo'), { id: 'demo', kind: 'http', ok: true, tools: 2 });

  // 改②：MCP-kind 连接器的命令被改成坏的（重复游标）⇒ **变更真的被换掉了**（旧客户端不换就永远发现不了）
  db.set('connectors', [httpConn('demo', NAME, true), mcpConn('relb', [FAKE_MCP, '--bad-cursor'])]);
  const r3 = await reloadDeclaredSources(db);
  assert.equal(r3.ok, false, '坏掉的源必须让 ok 变 false（不静默）');
  assert.equal(r3.connectors.find((x) => x.id === 'relb').ok, false);
  assert.match(r3.failures.join('\n'), /connectors relb（mcp）：.*重复返回 tools\/list 游标/, '失败要指名道姓：' + r3.failures.join('；'));
  assert.equal(faceHas('mcp_relb_echo'), false, '变更后连不上的源，其工具必须立即从工具面消失');

  // 删：两份声明都清空 ⇒ 一个源都不留
  db.set('connectors', []).set('mcp_servers', []);
  const r4 = await reloadDeclaredSources(db);
  assert.equal(r4.ok, true, '空声明是合法声明：' + JSON.stringify(r4.failures));
  assert.deepEqual(r4.sources.filter((s) => s.startsWith('connector:')), [], '声明面是唯一出处：一条 connector:* 都不该留下');
  // 如实记：MCP 来源以**空壳**留下（`syncMcpTools([])` → `registerDynamicTools('mcp', [])` 把整源换成空，
  // 不删壳；删壳的是 `unregisterDynamicTools`）——条目数由下面的 registeredTools=0 证明，壳子本身不产条目。
  assert.deepEqual(r4.sources, ['mcp'], '空壳语义如实登记，与 mcp-registry 夹具的清理口径一致');
  assert.equal(r4.registeredTools, 0);
  for (const n of ['conn_demo_get_item', 'conn_demo_added_action', 'mcp_rela_echo', 'mcp_relb_echo']) {
    assert.equal(faceHas(n), false, '卸载后 ' + n + ' 必须立即消失');
  }
  assert.ok(r4.disconnected.length >= 2, '断开的是上一代池子里的客户端：' + JSON.stringify(r4.disconnected));
});

// ── ② 不在声明里的 connector:* 源一律撤掉（G2 同一条纪律）──────────────────────────────
test('声明里的唯一出处：只留一个连接器时，前一个 connector:* 源与其工具必须被撤掉', async () => {
  const db = new FakeDb({ connectors: [httpConn('demo'), httpConn('other', NAME2)] });
  const r1 = await reloadDeclaredSources(db);
  assert.deepEqual(r1.sources, ['connector:demo', 'connector:other', 'mcp'], '两个 HTTP 连接器 = 两条来源：' + JSON.stringify(r1.sources));
  assert.ok(faceHas('conn_demo_get_item') && faceHas('conn_other_get_item'));

  db.set('connectors', [httpConn('other', NAME2)]);   // demo 从声明里消失（不是"配置为空"，而是"没写它"）
  const r2 = await reloadDeclaredSources(db);
  assert.deepEqual(r2.sources, ['connector:other', 'mcp'], '不在声明里的 connector:demo 必须被撤掉：' + JSON.stringify(r2.sources));
  assert.equal(faceHas('conn_demo_get_item'), false, '撤源必须连带撤掉它的工具（卸载后立即消失）');
  assert.ok(faceHas('conn_other_get_item'), '仍在声明里的连接器不受影响');
});

// ── ③ 非法声明：冻结 + 如实报，另一份声明照常生效 ──────────────────────────────────────
test('失败如实报且不留半态：连接器声明非法 ⇒ 那半边冻结（上一代保持），mcp_servers 那半边照常生效', async () => {
  const db = new FakeDb({ mcp_servers: [mcpServer('rela')], connectors: [httpConn('demo')] });
  const r1 = await reloadDeclaredSources(db);
  assert.equal(r1.ok, true);
  assert.ok(faceHas('conn_demo_get_item'));

  // 声明写坏（缺 baseUrl / credential / actions）+ 另一份声明里新增一个 server
  db.set('connectors', [{ id: 'broken', kind: 'http' }]);
  db.set('mcp_servers', [mcpServer('rela'), mcpServer('relc')]);
  const r2 = await reloadDeclaredSources(db);
  assert.equal(r2.ok, false, '非法声明必须让 ok 变 false');
  assert.match(r2.connectorError, /连接器声明非法/, '错误原文必须给出来：' + r2.connectorError);
  assert.match(r2.notes.join('\n'), /冻结/, '必须写明"这半边没动"（否则读的人会以为已经按新声明生效了）');
  assert.equal(r2.connectors, null, '冻结时不给连接器结果（没跑就没有结果，不编）');
  assert.equal(faceHas('conn_demo_get_item'), true, '冻结＝上一代工具面保持（不是"撤光"、也不是"半撤"）');
  assert.deepEqual(r2.sources, ['connector:demo', 'mcp'], '冻结时一个源都不撤');
  assert.ok(faceHas('mcp_relc_echo'), 'mcp_servers 那半边必须照常生效（一处写坏的声明不拖走另一处已好的功能）');
});

// ── ④ 不放宽鉴权 + 响应只增字段（源码级锁：本端点没有第二份判断）────────────────────────
test('端点：仍是既有 requireAuth，且只做转呈（不在这里写第二份"谁该撤/谁该连"的判断）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(idx, /app\.post\('\/api\/mcp\/reload', requireAuth, async \(req, res\) => \{/, '热加载端点必须沿用既有鉴权（不新增权限面、也不放宽）');
  assert.match(idx, /await import\('\.\/connectors\.js'\);\s*\n\s*const r = await reloadDeclaredSources\(\);/, '端点必须是薄壳：唯一实现是 connectors.reloadDeclaredSources');
  assert.equal(/disconnectMcp|listMcpClients/.test(idx.split("app.post('/api/mcp/reload'")[1].split('});')[0]), false,
    '端点里不许再各写一份"断开谁/连谁"（那是第二处口径）');
  // 只增不改：老字段逐字保留（前端 src/console/McpManager.jsx 读的正是这两个）
  assert.match(idx, /ok: r\.ok, results: r\.mcp, registeredTools: r\.registeredTools,/);
});
