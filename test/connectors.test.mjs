// test/connectors.test.mjs - 连接器＝带凭证的执行后端（v0.3 §4.2 那条半句话的落地）
//
// 本夹具锁五件事：
//   ① **声明校验是唯一出处**：字段缺/取值非法/声明自相矛盾（path 占位符与参数对不上、GET 带 body…）一律报出来；
//   ② **HTTP 路**在**假 fetch + 假凭据**下真跑通一次：URL 拼接、GET/POST、凭证注入、参数映射、结果回灌逐项断言，
//      并断言"配置里只有引用名、没有明文"；
//   ③ **MCP 路走既有连接与注册路径**（机制性断言：进同一个客户端池、同一个 `mcp` 动态来源、同一张工具表）；
//   ④ **缺凭据的错误形状**：装配期明确报错且工具不上工具面、调用期抛错（不发空 Bearer、不静默降级成空串）；
//      非 2xx 如实报出对方响应体；
//   ⑤ **卸载即消失**（v0.3 §4.2 验收 G2）与外部来源纪律（不可信声明 / 启用集豁免 / 只读意图约束）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 假 MCP server 放 scripts/fixtures（与 mcp-registry 夹具共用同一个）：`node --test` 会把 test/**/*.mjs 全当
// 测试文件，把它放 test/ 下会让整套测试永久挂住（那个进程在等 stdin）。
const FAKE_MCP = path.join(HERE, '../scripts/fixtures/fake-mcp-server.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-conn-'));
process.env.RW_CREDENTIALS_FILE = path.join(TMP, '.credentials.yaml'); // 必须在 import 之前设（credentials.js 每次现算路径）

const { validateConnectors, connectConfiguredConnectors, httpActionEntries, HTTP_TOOL_PREFIX } =
  await import('../server/connectors.js');
const { setSecret, unsetSecret, CRED_PREFIX } = await import('../server/credentials.js');
const { TOOLS, toolDefs, execTool, syncMcpTools } = await import('../server/tools/index.js');
const { dynamicSourceIds, unregisterDynamicTools } = await import('../server/tools/registry.js');
const { disconnectMcp } = await import('../server/mcp.js');

const TOKEN = 'conn-token-' + 'A'.repeat(20);
const NAME = 'FAKE_CONNECTOR_TOKEN';
assert.ok(!process.env[NAME], '夹具前提：' + NAME + ' 不得已存在于进程环境里');
const CTX = (extra = {}) => ({
  permission: 'full', root: process.cwd(), conversationId: 0, accountId: 0,
  __signal: new AbortController().signal, ...extra,
});

/** 夹具假库：只认 settings 那一张表的 SELECT（其余一律抛错，免得夹具悄悄假装支持了什么）。
 *  形状与 credentials.test.mjs 的同款假库一致——连接器声明与 mcp_servers 读的是同一条语句。 */
class FakeDb {
  constructor(settings = {}) { this.rows = new Map(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)])); }
  async query(sql, params) {
    if (/^SELECT svalue FROM settings WHERE skey=\?$/.test(sql)) {
      return this.rows.has(params[0]) ? [{ svalue: JSON.parse(this.rows.get(params[0])) }] : [];
    }
    throw new Error('假库不认识的查询：' + sql);
  }
}

/** 一次合法的 HTTP 连接器声明（正对照；负例都是它的单点破坏）。 */
const goodHttp = () => ({
  id: 'demo',
  kind: 'http',
  baseUrl: 'https://api.example.com/v1',
  credential: NAME,
  actions: [
    {
      name: 'get_item', method: 'GET', path: '/items/{itemId}', description: '取一条明细',
      params: { itemId: { in: 'path' }, keyword: { in: 'query' }, limit: { in: 'query', required: true } },
    },
    { name: 'create_note', method: 'POST', path: '/notes', params: { title: { in: 'body', required: true }, body: { in: 'body' } } },
  ],
});

/** 假 fetch：按顺序吐预设响应，并记下每次请求（含 URL/方法/头/体）。 */
function stubFetch(replies) {
  const real = globalThis.fetch;
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    const r = replies[Math.min(i++, replies.length - 1)];
    return {
      ok: r.ok !== false, status: r.status || 200, statusText: r.statusText || '',
      text: async () => r.text,
    };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test.after(() => {
  disconnectMcp('connmcp');
  syncMcpTools([]);
  for (const sid of dynamicSourceIds()) if (sid.startsWith('connector:')) unregisterDynamicTools(sid);
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** 每个用例从**干净的工具面**开始：动态来源是进程级状态（'mcp' 由 MCP 用例注册、'connector:*' 由 HTTP 用例注册），
 *  不清干净就会让"上一条用例的残留"变成下一条用例的断言依据（实测踩过：卸载断言里混进了 'mcp'）。 */
test.beforeEach(() => {
  syncMcpTools([]);
  for (const sid of dynamicSourceIds()) unregisterDynamicTools(sid);
});

// ── ① 声明校验（唯一出处：非法当场报，且报到位）─────────────────────────────────────────
test('声明校验：合法声明零问题（正对照——没有它，下面的负例可能因为"永远报错"而假通过）', () => {
  assert.deepEqual(validateConnectors([goodHttp()]), []);
  assert.deepEqual(validateConnectors([{ id: 'gh', kind: 'mcp', command: 'npx', args: ['-y', 'x'], env: { GITHUB_TOKEN: CRED_PREFIX + NAME } }]), []);
  assert.deepEqual(validateConnectors([]), []);
});

test('声明校验负例：缺字段 / 取值非法 / 自相矛盾，逐条都有明确报错', () => {
  const bad = (c, re, why) => {
    const problems = validateConnectors([c]);
    assert.ok(problems.length, '必须报错：' + why);
    assert.match(problems.join('\n'), re, why + ' → 实际：' + problems.join('；'));
  };
  const http = (patch) => ({ ...goodHttp(), ...patch });

  // 顶层
  bad(null, /必须是对象/, '条目不是对象');
  assert.match(validateConnectors({ id: 'x' })[0], /必须是数组/, '声明不是数组');
  bad(http({ id: 'Demo' }), /id 非法/, 'id 含大写（要拼进工具名）');
  bad(http({ id: 'a.b' }), /id 非法/, 'id 含点');
  assert.match(validateConnectors([goodHttp(), goodHttp()]).join('\n'), /id 重复/, 'id 重复＝工具名命名空间撞车');
  bad(http({ kind: undefined }), /kind 必须显式声明/, 'kind 缺失（不许猜）');
  bad(http({ kind: 'graphql' }), /kind 必须显式声明/, 'kind 自造第三条路');

  // MCP 路：与 settings.mcp_servers 同形
  bad({ id: 'm', kind: 'mcp' }, /缺 command/, 'mcp 缺 command');
  bad({ id: 'm', kind: 'mcp', command: 'npx', args: '-y' }, /args 必须是字符串数组/, 'mcp args 不是数组');
  bad({ id: 'm', kind: 'mcp', command: 'npx', env: { X: 1 } }, /env\.X 必须是字符串/, 'mcp env 值非字符串');

  // HTTP 路：baseUrl / 凭证引用 / 动作
  bad(http({ baseUrl: 'api.example.com' }), /baseUrl 非法/, 'baseUrl 不是绝对 URL');
  bad(http({ baseUrl: 'file:///etc/passwd' }), /baseUrl 非法/, 'baseUrl 协议不是 http(s)');
  bad(http({ credential: '有中文' }), /必须是\*\*凭据名\*\*/, '凭据名含非标识符字符');
  bad(http({ credential: CRED_PREFIX + NAME }), /必须是\*\*凭据名\*\*/, '写成 __CRED__: 记法——本字段只收裸凭据名（字段名已经说明了它是引用，两种写法＝两条路）');
  bad(http({ credential: undefined }), /credential 必须是/, '缺凭证引用');
  bad(http({ actions: [] }), /actions 必须是非空数组/, '动作清单为空＝没有能力（缺省不是"全部允许"）');
  bad(http({ actions: [{ name: 'x', method: 'DELETE', path: '/a' }] }), /method 必须显式声明/, 'method 非法');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: 'a' }] }), /path 非法/, 'path 不以 / 开头');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '//evil.com/a' }] }), /path 非法/, 'path 带自己的 host（会顶掉 baseUrl）');
  bad(http({ actions: [{ name: 'X', method: 'GET', path: '/a' }] }), /name 非法/, '动作名含大写');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a' }, { name: 'x', method: 'GET', path: '/b' }] }), /动作名重复/, '动作重名');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a', params: { p: { in: 'path' } } }] }), /没有 \{p\} 占位符/, 'in:path 但 path 里没有它');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a/{id}' }] }), /没有对应的 params\.id/, 'path 里有占位符但没声明参数');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a', params: { q: { in: 'body' } } }] }), /GET 动作/, 'GET 声明 body 参数');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a/{id}', params: { id: { in: 'path', required: false } } }] }), /不可能可选/, '路径参数声明为可选');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a', params: { q: { in: 'header' } } }] }), /in 必须是/, '参数去向非法');
  bad(http({ actions: [{ name: 'x', method: 'GET', path: '/a', params: { 'a-b': { in: 'query' } } }] }), /参数名非法/, '参数名不是标识符');

  // 一次报多条（收集式，不是"撞到第一条就停"）
  const multi = validateConnectors([{ id: 'BAD', kind: 'http', baseUrl: 'nope', actions: [{ name: 'x', method: 'PUT', path: 'x' }] }]).join('\n');
  for (const re of [/id 非法/, /baseUrl 非法/, /credential 必须是/, /method 必须显式声明/, /path 非法/]) assert.match(multi, re, '同一次校验必须把问题报全：' + re);
});

// ── ② HTTP 路：假 fetch + 假凭据，跑通一次 ────────────────────────────────────────────
test('HTTP 连接器：装配注册 + GET/POST 真跑（URL 拼接/参数映射/凭证注入/结果回灌逐项断言）', async () => {
  setSecret(NAME, TOKEN);
  const cfg = goodHttp();
  const db = new FakeDb({ connectors: [cfg] });
  const fake = stubFetch([{ text: '{"ok":true,"item":{"id":7}}' }, { text: '{"noteId":9}' }]);
  try {
    const r = await connectConfiguredConnectors(db);
    assert.deepEqual(r.results, [{ id: 'demo', kind: 'http', ok: true, tools: 2 }], '两个动作＝两个工具：' + JSON.stringify(r.results));
    assert.deepEqual(dynamicSourceIds(), ['connector:demo']);
    assert.ok(TOOLS.some((t) => t.name === HTTP_TOOL_PREFIX + 'demo_get_item'), '必须进同一张工具表 TOOLS');

    // 配置里只放引用：声明原样落库，且**不含**明文（这是"只存引用"的可机检形态）
    assert.equal(db.rows.get('connectors').includes(TOKEN), false, '声明里不得出现明文');
    assert.ok(db.rows.get('connectors').includes(NAME), '声明里存的是凭据名');

    // 模型看到的 schema 由声明派生（声明即 schema）：路径参数+必填参数
    const def = toolDefs('all', null, null).find((d) => d.function.name === HTTP_TOOL_PREFIX + 'demo_get_item');
    assert.ok(def, 'toolDefs 必须含它（MCP 之外的第二条路也走同一条工具面）');
    assert.deepEqual(def.function.parameters, { type: 'object', properties: { itemId: { type: 'string' }, keyword: { type: 'string' }, limit: { type: 'string' } }, required: ['itemId', 'limit'] });
    assert.match(def.function.description, /^\[连接器:demo\] 取一条明细/);

    // GET：路径参数替换 + 查询串；凭证在 Authorization 头里
    const g = await execTool(HTTP_TOOL_PREFIX + 'demo_get_item', { itemId: 'a b', keyword: '中文', limit: 5 }, CTX());
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, 'https://api.example.com/v1/items/a%20b?keyword=%E4%B8%AD%E6%96%87&limit=5', 'baseUrl 的路径段必须保住（/v1 不能被 path 顶掉）');
    assert.equal(fake.calls[0].init.method, 'GET');
    assert.equal(fake.calls[0].init.headers.Authorization, 'Bearer ' + TOKEN, '凭证注入：真值只从 credentials.js 现取');
    assert.equal(fake.calls[0].init.body, undefined, 'GET 不带请求体');
    assert.match(String(g.content || ''), /不可信数据/, '外部来源结果必须带"不可信数据"声明（conn_ 与 mcp_ 同一条纪律）');
    assert.match(String(g.content || ''), /"noteId"|"item"/, '真实响应体必须在声明之后回灌给模型');

    // POST：body 参数进 JSON 体 + Content-Type
    const p = await execTool(HTTP_TOOL_PREFIX + 'demo_create_note', { title: 't', body: 'b' }, CTX());
    assert.equal(fake.calls[1].url, 'https://api.example.com/v1/notes');
    assert.equal(fake.calls[1].init.method, 'POST');
    assert.equal(fake.calls[1].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(fake.calls[1].init.body), { title: 't', body: 'b' });
    assert.match(String(p.content || ''), /noteId/, '结果回灌');
  } finally { fake.restore(); }
});

test('HTTP 连接器：外部来源纪律与既有守卫同口径（启用集豁免、只读意图约束、参数必填）', async () => {
  setSecret(NAME, TOKEN);
  await connectConfiguredConnectors(new FakeDb({ connectors: [goodHttp()] }));
  const fake = stubFetch([{ text: '{"ok":1}' }]);
  try {
    const name = HTTP_TOOL_PREFIX + 'demo_get_item';
    // 启用集门禁（hooks.js enabled_tools_guard）：动态命名的外部工具本来进不了静态启用集 ⇒ 必须同 mcp_ 一样豁免，
    // 否则"管理员声明了连接器却一条也调不动"（本夹具当场锁住这条）
    const ok = await execTool(name, { itemId: '1', limit: 1 }, CTX({ __enabledTools: new Set(['read_file']) }));
    assert.equal(ok.error, undefined, '外部工具不应被启用集门禁拦住：' + JSON.stringify(ok).slice(0, 160));
    // 只读规划轮必须拦住外部副作用（hooks.js readonly_mcp_guard 同口径）
    const blocked = await execTool(name, { itemId: '1', limit: 1 }, CTX({ __readonlyIntent: true }));
    assert.match(String(blocked.error || ''), /只读规划意图/, '只读轮不得执行外部连接器调用');
    // 必填由本模块在执行时判（内部 params 契约留空，schema 只给模型）
    const missing = await execTool(name, { itemId: '1' }, CTX());
    assert.match(String(missing.error || ''), /参数 limit 必填/, '必填参数缺了要如实报错');
  } finally { fake.restore(); }
});

test('HTTP 连接器：非 2xx 如实报错（带上对方响应体，便于排障）', async () => {
  setSecret(NAME, TOKEN);
  await connectConfiguredConnectors(new FakeDb({ connectors: [goodHttp()] }));
  const fake = stubFetch([{ ok: false, status: 403, text: '{"code":99991672,"msg":"no permission"}' }]);
  try {
    const r = await execTool(HTTP_TOOL_PREFIX + 'demo_get_item', { itemId: '1', limit: 1 }, CTX());
    assert.match(String(r.error || ''), /HTTP 403/, '状态码必须报出来');
    assert.match(String(r.error || ''), /no permission/, '对方响应体必须带上（否则排障只能靠猜）');
  } finally { fake.restore(); }
});

// ── ③ MCP 路：既有连接 + 既有注册路径（机制性断言）────────────────────────────────────
test('MCP 连接器：接进既有客户端池与既有 mcp 动态来源（不新造第二条注册路径）', async () => {
  const decl = { id: 'connmcp', kind: 'mcp', command: process.execPath, args: [FAKE_MCP] };
  const r = await connectConfiguredConnectors(new FakeDb({ connectors: [decl] }));
  assert.deepEqual(r.results, [{ id: 'connmcp', kind: 'mcp', ok: true, tools: 2 }], JSON.stringify(r.results));
  // 机制性断言：没有为它造第二个来源——工具体现在**既有的** 'mcp' 动态来源里（= syncMcpTools 那条路）
  assert.deepEqual(dynamicSourceIds(), ['mcp'], 'MCP 连接器必须走既有注册路径');
  assert.ok(TOOLS.some((t) => t.name === 'mcp_connmcp_echo'), '工具名沿用既有 mcp_<serverId>_<tool> 命名');
  const out = await execTool('mcp_connmcp_echo', { text: 'ok' }, CTX());
  assert.match(String(out.content || ''), /echo:ok$/, '端到端可调用');
});

test('MCP 连接器：凭据引用缺失 ⇒ ok:false 且**不 spawn**（先解析凭据再起进程）', async () => {
  const decl = { id: 'connmiss', kind: 'mcp', command: 'definitely-not-a-real-command-xyz', args: [], env: { SOME_TOKEN: CRED_PREFIX + 'NOT_CONFIGURED_CONNECTOR' } };
  const r = await connectConfiguredConnectors(new FakeDb({ connectors: [decl] }));
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /缺少凭据 NOT_CONFIGURED_CONNECTOR/, '缺哪把钥匙必须一眼看出：' + r.results[0].error);
  assert.deepEqual(dynamicSourceIds(), [], '没连上就不该留下任何来源');
});

// ── ④ 缺凭据的错误形状（装配期 + 调用期）────────────────────────────────────────────
test('HTTP 连接器：缺凭据 ⇒ 装配期 ok:false、工具不上工具面（与 MCP 路同语义）', async () => {
  const cfg = { ...goodHttp(), credential: 'NOT_CONFIGURED_CONNECTOR_X' };
  const r = await connectConfiguredConnectors(new FakeDb({ connectors: [cfg] }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.results, [{ id: 'demo', kind: 'http', ok: false, error: '缺少凭据 NOT_CONFIGURED_CONNECTOR_X（应配在 ' + process.env.RW_CREDENTIALS_FILE + ' 或环境变量里）' }]);
  assert.deepEqual(dynamicSourceIds(), [], '缺凭据的连接器不得注册任何工具');
  assert.equal(TOOLS.some((t) => t.name === HTTP_TOOL_PREFIX + 'demo_get_item'), false);
  // 把明文粘进 credential 的情形：`ghp_xxx` **恰好**是合法的 POSIX 标识符 ⇒ 文法校验拦不住它（这是文法的边界，如实记）。
  // 它不会被当成钥匙用（真值只从凭据文档取），结果是装配期"缺少凭据 ghp_xxx"——**响亮地失败**，而不是把明文发出去。
  // ⚠️ 已知残留：那个名字会被原样带进这条错误（与 `credentials.js:266` 的既有口径一致）——见交付报告的旁支发现。
  const paste = { ...goodHttp(), credential: 'ghp_' + 'A'.repeat(36) };
  const r2 = await connectConfiguredConnectors(new FakeDb({ connectors: [paste] }));
  assert.equal(r2.results[0].ok, false);
  assert.match(r2.results[0].error, /^缺少凭据 ghp_/, '明文粘贴＝当成一个没配过的名字，响亮失败（不是"当钥匙用"）');
});

test('HTTP 连接器：调用期凭据消失 ⇒ 抛"缺少凭据"（每次现取，绝不发空 Bearer）', async () => {
  setSecret(NAME, TOKEN);
  await connectConfiguredConnectors(new FakeDb({ connectors: [goodHttp()] }));
  const fake = stubFetch([{ text: '{"ok":1}' }]);
  try {
    unsetSecret(NAME); // 装配之后钥匙没了（轮换/撤销都长这样）
    const r = await execTool(HTTP_TOOL_PREFIX + 'demo_get_item', { itemId: '1', limit: 1 }, CTX());
    assert.match(String(r.error || ''), /缺少凭据 FAKE_CONNECTOR_TOKEN/, '调用期必须当场报错：' + JSON.stringify(r).slice(0, 200));
    assert.equal(fake.calls.length, 0, '缺凭据时不得发出任何请求（不许降级成空 Authorization）');
  } finally { fake.restore(); }
});

// ── ⑤ 卸载即消失 + 声明面是唯一出处 ────────────────────────────────────────────────
test('卸载：声明里去掉的连接器 ⇒ 工具与来源立即消失（v0.3 §4.2 验收 G2）', async () => {
  setSecret(NAME, TOKEN);
  await connectConfiguredConnectors(new FakeDb({ connectors: [goodHttp()] }));
  assert.deepEqual(dynamicSourceIds(), ['connector:demo']);
  await connectConfiguredConnectors(new FakeDb({ connectors: [] }));
  assert.deepEqual(dynamicSourceIds(), [], '声明面是唯一出处：不在声明里的连接器源必须撤掉');
  assert.equal(TOOLS.some((t) => t.name === HTTP_TOOL_PREFIX + 'demo_get_item'), false);
});

test('装配期非法声明 ⇒ 当场抛（宁可起不来，也不装载一份说谎的声明面）', async () => {
  await assert.rejects(() => connectConfiguredConnectors(new FakeDb({ connectors: [{ id: 'x', kind: 'http' }] })), /连接器声明非法/);
  // 行存在但不是数组（手改库/迁移写坏）同样当场抛，不静默当空
  await assert.rejects(() => connectConfiguredConnectors(new FakeDb({ connectors: { id: 'x' } })), /必须是数组/);
  // 行不存在＝还没配（正常状态，不是错误）
  assert.deepEqual((await connectConfiguredConnectors(new FakeDb({}))).results, []);
});

test('httpActionEntries：声明的形状 → 条目形状（权限档/界限/归属，与 MCP 条目同一套）', () => {
  const [get, post] = httpActionEntries(goodHttp());
  assert.equal(get.permission, 'write', '外部后端一律按 write 级评估（与 MCP 条目同一判据）');
  assert.equal(get.timeoutMs, 15000, '界限照 MCP_TIMEOUT_MS 同一口径');
  assert.equal(get.connector, 'demo', '归属标记（审计/排障用）');
  assert.equal(get.mcpServer, undefined, '不得冒用 mcpServer 字段（那是按壳 MCP 白名单的判据）');
  assert.deepEqual(Object.keys(get.params), [], '内部契约留空：schema 只给模型，必填在执行时判');
  assert.equal(typeof post.run, 'function');
});
