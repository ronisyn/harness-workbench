// server/connectors.js - 连接器：带凭证的执行后端（v0.3 §4.2「连接器=带凭证的执行后端」；附录术语表：
// 「连接器 = 带客户凭证的业务系统后端（ERP/电商/数据库）；MCP 或插件是其实现方式」）
//
// **有且只有两条路**（照成熟 agent 的通行做法：MCP 优先，没有 MCP 的外部系统才用 HTTP API + 凭证）：
//   ① MCP 连接器：声明一个 MCP server（命令/参数 + 凭证引用）→ 走**既有** `server/mcp.js` 的客户端
//      （`connectMcp`）与**既有** `server/tools/index.js` 的 `syncMcpTools` → `registerDynamicTools`——
//      与 `settings.mcp_servers` **同一套口径、同一张工具表**，本模块不另造连接与注册路径；
//   ② HTTP API 连接器：对方没有 MCP 时，声明 `baseUrl` + 凭证引用 + 一组**允许的动作**（method/path/参数映射）
//      → 动作经**既有** `registerDynamicTools` 注册进同一张工具表（来源 id 各自一条 `connector:<id>`）。
//
// ── 声明面放哪（唯一出处）──────────────────────────────────────────────────────────────
// 放 **`settings.connectors`**（JSON 数组）：与 `settings.mcp_servers` 同一张表、同一读取口径
// （`SELECT svalue FROM settings WHERE skey=?`，见 credentials.js 的 `readMcpConfig`）、同一写入 API（`PUT /api/settings`）。
//   为什么不放 `server/tools/manifest.js` 那样的**代码清单**：manifest 是"平台有哪些能力"的声明，随代码进 VCS；
//   而连接器声明里带 **baseUrl / 凭证引用**，是"这个部署连的是谁的哪个系统"——换客户、换环境就换一份，属运营配置。
//   放代码清单等于把每个部署的地址与引用名写进仓库。
//   为什么不放 `server/settingsSchema.js`：那张表是**标量可调键**的注册表（`type:'number'` + min/max，
//   `validateSetting` 只认数字），表达不了"一组对象"；登记进去只会得到一条永远走不到校验的行
//   （`validateSetting` 对非登记键原样放行）。⇒ 声明在 settings，**合法形状的唯一出处**是本模块的
//   `validateConnectors`（纯函数，装配期非法当场抛）。
//
// ── 凭证（§9 凭证存放规则：不进 DB 明文、不入对话上下文、只存引用）────────────────────
// 声明里只写**凭据名**（POSIX 标识符，与 `credentials.js` 的 `CREDENTIAL_REF_RE` 同一条文法）；真值只有
// `server/credentials.js` 的 `getSecret` 一条路能取到，且**每次调用现取**（不跨操作缓存 ⇒ 轮换下一轮生效，
// 与 credentials.js 的口径一致）。缺凭证一律**报错**，不静默降级：
//   · 装配期：记 `ok:false` 且不注册该连接器的工具（与 MCP 路"缺密钥就不连、也不假装连上"同一口径）；
//   · 调用期：抛错（不发 `Authorization: Bearer undefined`、不塞空串）。
import { db } from './db.js';
import { CREDENTIAL_REF_RE, credentialsFile, describeSecret, getSecret, resolveEnv, redactSecretValues } from './credentials.js';
import { connectMcp, listMcpClients } from './mcp.js';
import { dynamicSourceIds, registerDynamicTools, unregisterDynamicTools } from './tools/registry.js';

/** 声明取值域：kind 必须显式写（不猜——"猜一个"会让写错的 kind 静默落到某条路上跑起来）。 */
export const CONNECTOR_KINDS = ['mcp', 'http'];
/** HTTP 动作工具名的前缀（`conn_<连接器 id>_<动作名>`）。为什么不是 `mcp_`：它不是 MCP，
 *  工具的账本/遥测里必须一眼看得出归属；代价是"外部来源"的几处判据要认这个前缀（见 hooks.js / tools/index.js 的同一处注释）。 */
export const HTTP_TOOL_PREFIX = 'conn_';
/** HTTP 动作的界限：**照抄** `tools/index.js` 的 `MCP_TIMEOUT_MS`（外部调用同一个界限，不新拍一个数字）。 */
export const HTTP_TIMEOUT_MS = 15000;
/** 连接器 id 文法。为什么这么窄（不是"随便一个字符串"）：id 会拼进工具名 `conn_<id>_<动作>`，
 *  而厂商对 function name 的取值域是 `[a-zA-Z0-9_-]`（MCP 的 `mcp_<id>_<tool>` 同理）。 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ACTION_RE = /^[a-z][a-z0-9_]{0,47}$/;
const METHODS = ['GET', 'POST'];
/** 参数去向：query=查询串（GET/POST 都可）｜body=JSON 请求体（只对 POST）｜path=路径模板占位符 `{名}`。 */
const PARAM_IN = ['query', 'body', 'path'];
const PATH_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 连接器声明的**校验**（纯函数，装配期与夹具共用；照 `tools/registry.js` 的 `validateManifest` 风格）。
 * 只回答"这份声明自己合不合法"——"这个部署配没配那把钥匙"是运行期事实，由 `describeSecret` 在装配步骤回答。
 * **不放宽**：字段缺失/取值非法一律报问题（由调用方一次性抛出，报错指到具体条目）。
 * @param {unknown} list settings.connectors 的值
 * @returns {string[]} 问题清单（空数组 = 合规）
 */
export function validateConnectors(list) {
  const problems = [];
  if (!Array.isArray(list)) return ['连接器声明必须是数组（settings.connectors = [ {...}, ... ]）：收到 ' + JSON.stringify(list)];
  const ids = new Set();
  for (const [i, c] of list.entries()) {
    const at = 'connectors[' + i + ']';
    if (!c || typeof c !== 'object' || Array.isArray(c)) { problems.push(at + ' 必须是对象'); continue; }
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      problems.push(at + ' id 非法（须为 2-32 位小写字母/数字/下划线/连字符且以字母或数字开头）：' + JSON.stringify(c.id)
        + '——它要拼进工具名 ' + HTTP_TOOL_PREFIX + '<id>_<动作>，厂商对工具名的取值域是 [a-zA-Z0-9_-]');
    } else if (ids.has(c.id)) {
      problems.push(at + ' 连接器 id 重复：' + c.id + '（id 是工具名的命名空间，必须唯一）');
    } else ids.add(c.id);
    if (!CONNECTOR_KINDS.includes(c.kind)) {
      problems.push(at + ' kind 必须显式声明且取 ' + CONNECTOR_KINDS.join('|') + '：' + JSON.stringify(c.kind) + '（不自造第三条路）');
      continue; // kind 不明就无从校验后面的字段，报一条足够（同一件事报两次只是噪音）
    }
    if (c.kind === 'mcp') { problems.push(...mcpProblems(c, at)); continue; }
    problems.push(...httpProblems(c, at));
  }
  return problems;
}

/** MCP 路的字段（与 `settings.mcp_servers` 的条目**同形**：id/command/args/env）。 */
function mcpProblems(c, at) {
  const problems = [];
  if (typeof c.command !== 'string' || !c.command) problems.push(at + '（kind=mcp）缺 command（要与 mcp_servers 同形：{ id, command, args?, env? }）');
  if (c.args !== undefined && !(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string'))) {
    problems.push(at + '（kind=mcp）args 必须是字符串数组（未声明就不要写）');
  }
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== 'object' || Array.isArray(c.env)) problems.push(at + '（kind=mcp）env 必须是对象');
    else for (const [k, v] of Object.entries(c.env)) {
      if (typeof v !== 'string') problems.push(at + '（kind=mcp）env.' + k + ' 必须是字符串（凭据引用写成 __CRED__:名字）');
    }
  }
  return problems;
}

/** HTTP 路的字段（baseUrl + 凭证引用 + 允许的动作）。 */
function httpProblems(c, at) {
  const problems = [];
  if (typeof c.baseUrl !== 'string' || !isHttpUrl(c.baseUrl)) {
    problems.push(at + '（kind=http）baseUrl 非法（须为 http/https 绝对 URL）：' + JSON.stringify(c.baseUrl));
  }
  // 凭证：**只放引用名**。写成明文 token 时它不是 POSIX 标识符 ⇒ 当场报错，而不是"以为配了钥匙、其实发了个乱码"。
  if (typeof c.credential !== 'string' || !CREDENTIAL_REF_RE.test(c.credential)) {
    problems.push(at + '（kind=http）credential 必须是**凭据名**（POSIX 标识符，如 FEISHU_TENANT_TOKEN），不放明文：'
      + JSON.stringify(c.credential) + '（真值只经 server/credentials.js）');
  }
  if (!Array.isArray(c.actions) || c.actions.length === 0) {
    problems.push(at + '（kind=http）actions 必须是非空数组（允许的动作＝能力边界，缺省不是"全部允许"）');
    return problems;
  }
  const names = new Set();
  for (const [j, a] of c.actions.entries()) {
    const aat = at + '.actions[' + j + ']';
    if (!a || typeof a !== 'object' || Array.isArray(a)) { problems.push(aat + ' 必须是对象'); continue; }
    if (typeof a.name !== 'string' || !ACTION_RE.test(a.name)) {
      problems.push(aat + ' name 非法（须为小写字母开头的 1-48 位小写字母/数字/下划线）：' + JSON.stringify(a.name));
    } else if (names.has(a.name)) {
      problems.push(aat + ' 动作名重复：' + a.name + '（同一连接器内动作名是工具名的一部分，必须唯一）');
    } else names.add(a.name);
    if (!METHODS.includes(a.method)) problems.push(aat + ' method 必须显式声明且取 ' + METHODS.join('|') + '：' + JSON.stringify(a.method));
    // path 必须**相对**且不带自己的 host：baseUrl 是这个后端的唯一出处，`//evil.com/x` 会把它整段顶掉
    // （`new URL('//evil.com/x', base)` 的 host 是 evil.com）——那不是"参数写错"，是静默换了个后端。
    if (typeof a.path !== 'string' || !/^\/(?!\/)\S*$/.test(a.path)) {
      problems.push(aat + ' path 非法（须以单个 / 开头的相对路径，不得带自己的 host/协议/空白）：' + JSON.stringify(a.path));
    }
    if (a.description !== undefined && typeof a.description !== 'string') problems.push(aat + ' description 必须是字符串（未声明就用 method + path 兜底）');
    if (a.params !== undefined && (!a.params || typeof a.params !== 'object' || Array.isArray(a.params))) {
      problems.push(aat + ' params 必须是对象 { 参数名: { in, required? } }');
      continue;
    }
    const pathNames = new Set([...String(a.path || '').matchAll(PATH_PLACEHOLDER_RE)].map((m) => m[1]));
    for (const [k, p] of Object.entries(a.params || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { problems.push(aat + ' 参数名非法（须为标识符）：' + JSON.stringify(k)); continue; }
      if (!p || typeof p !== 'object' || Array.isArray(p)) { problems.push(aat + '.' + k + ' 必须是对象 { in, required? }'); continue; }
      if (!PARAM_IN.includes(p.in)) { problems.push(aat + '.' + k + ' in 必须是 ' + PARAM_IN.join('|') + '：' + JSON.stringify(p.in)); continue; }
      if (p.required !== undefined && typeof p.required !== 'boolean') problems.push(aat + '.' + k + ' required 必须是布尔');
      if (p.in === 'body' && a.method === 'GET') problems.push(aat + '.' + k + ' 声明了 in:"body"，但这是 GET 动作（我们不会给 GET 带请求体）');
      if (p.in === 'path') {
        if (!pathNames.has(k)) problems.push(aat + '.' + k + ' 声明 in:"path"，但 path 里没有 {' + k + '} 占位符（声明与事实不一致）');
        if (p.required === false) problems.push(aat + '.' + k + ' 是路径参数，不可能可选（required 不得为 false）');
      }
    }
    // 反向：path 里的每个占位符都必须有对应的 path 参数，否则请求会带着字面量 {名} 发出去
    for (const n of pathNames) {
      const p = (a.params || {})[n];
      if (!p || p.in !== 'path') problems.push(aat + ' path 里的 {' + n + '} 没有对应的 params.' + n + '（in:"path"）');
    }
  }
  return problems;
}

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/** 读声明（`settings.connectors`）。行不存在＝空数组（还没配是正常状态）。**行存在但形状不对不在这里兜**：
 *  原样返回给 `validateConnectors` ⇒ 装配期抛错。为什么不吞异常：静默返回空数组会把"我配了却没生效"变成查不出来的事
 *  （credentials.js 的同一句：一切拒绝，不跳过）。 */
export async function readConnectorConfig(dbc = db) {
  const r = await dbc.query('SELECT svalue FROM settings WHERE skey=?', ['connectors']);
  if (!r || !r[0]) return [];
  const raw = r[0].svalue;
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'string') return raw;            // mysql2 对 JSON 列已解析成对象；夹具可能给字符串
  try { return JSON.parse(raw); } catch { return raw; } // 文本列：能 parse 就 parse，parse 不了交给校验报错
}

/**
 * HTTP 动作 → 动态工具条目（与 MCP 条目**同形**：同一张注册表、同一套条目校验）。
 * 参数 schema：动作声明的 `params` → `rawParameters`（MCP 的路子是"对方自带 schema 原样透传"，
 * 这里是"声明即 schema"）；内部契约 `params` 留空 ⇒ execTool 跳过通用参数校验（与 MCP 条目一致，
 * 避免同一件事写两份：schema 只给模型，必填由本模块在执行时判）。
 */
export function httpActionEntries(conn) {
  return (conn.actions || []).map((a) => {
    const properties = {};
    const required = [];
    for (const [k, p] of Object.entries(a.params || {})) {
      properties[k] = { type: 'string' };
      if (p.required === true || p.in === 'path') required.push(k);
    }
    return {
      name: HTTP_TOOL_PREFIX + conn.id + '_' + a.name,
      description: '[连接器:' + conn.id + '] ' + (a.description || (a.method + ' ' + a.path)),
      permission: 'write',        // 外部后端一律按 write 级评估（与 MCP 条目同一判据：外部副作用不可只看动词）
      timeoutMs: HTTP_TIMEOUT_MS,
      connector: conn.id,         // 归属标记（审计/排障用；与 MCP 条目的 mcpServer 同性质）
      rawParameters: { type: 'object', properties, required },
      params: {},                 // 内部契约留空：schema 只给模型，必填在执行时判（见上）
      run: async (args, ctx) => callHttpAction(conn, a, args || {}, ctx),
    };
  });
}

/**
 * 执行一次 HTTP 动作：GET/POST + 凭证注入（`Authorization: Bearer <凭据值>`）+ 结果回灌。
 *   · 凭证**每次现取**（轮换下一轮生效）；缺凭证**抛错**（不发空 Bearer）；
 *   · 出站口径照本仓既有调用：`fetch` + 调用级 `ctx.__signal`（由 execTool 按 `timeoutMs` 派生，
 *     见 `server/tools/deadline.js`——一个界限只有一个出处，且用户"停止"能真正打断在飞的请求；
 *     `Authorization: Bearer ` 的写法与 `server/tools/feishu.js:29`、`server/llm/gateway.js:414` 同一口径）；
 *   · 结果回灌：响应体原文进 `{ content }`（与 `callMcpTool` 同形状）。**不在这里截断**：进上下文的体积由
 *     输出层（spill/截断）统一决定，工具自己再拍一个阈值就是第二个出处。
 * @returns {Promise<{content: string}>}
 */
export async function callHttpAction(conn, action, args, ctx) {
  const token = getSecret(conn.credential);
  if (token === undefined) {
    throw new Error('连接器 ' + conn.id + ' 缺少凭据 ' + conn.credential + '（应配在 ' + credentialsFile() + ' 或环境变量里）');
  }
  // baseUrl 与 path 用**字符串拼接**而不是 `new URL(path, baseUrl)`：后者在 path 以 '/' 开头时会丢掉 baseUrl 的路径段
  // （`new URL('/wiki/v2/spaces','https://open.feishu.cn/open-apis')` ⇒ `https://open.feishu.cn/wiki/v2/spaces`），
  // 也就是把 `/open-apis` 这个前缀静默吃掉——本模块的 baseUrl 语义是"这段前缀属于后端"。
  // 路径占位符必须在**拼 URL 之前**替换：URL 构造器会把 `{`/`}` 百分号转义，事后再 replace 就永远找不到占位符。
  let pathStr = action.path;
  const body = {};
  const query = [];
  for (const [k, p] of Object.entries(action.params || {})) {
    const v = args[k];
    if (v === undefined || v === null || v === '') {
      if (p.required === true || p.in === 'path') throw new Error('连接器 ' + conn.id + ' 动作 ' + action.name + ' 参数 ' + k + ' 必填');
      continue;
    }
    if (p.in === 'path') pathStr = pathStr.split('{' + k + '}').join(encodeURIComponent(String(v)));
    else if (p.in === 'query') query.push([k, String(v)]);
    else if (p.in === 'body') body[k] = v;
  }
  const url = new URL(String(conn.baseUrl).replace(/\/+$/, '') + pathStr);
  for (const [k, v] of query) url.searchParams.set(k, v);
  const hasBody = Object.keys(body).length > 0;
  const headers = { Authorization: 'Bearer ' + token };
  if (hasBody) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: action.method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    signal: ctx && ctx.__signal,
  });
  const text = await res.text();
  if (!res.ok) {
    // 失败如实报出对方的响应体（排障就靠它）；出口过一遍凭据脱敏——外部系统完全可能把我们发过去的
    // 那把钥匙原样回显在错误里（mcp.js 的 stderr 出口同一处理）。
    throw new Error(redactSecretValues('连接器 ' + conn.id + ' 动作 ' + action.name + ' 返回 HTTP ' + res.status + '：' + text));
  }
  return { content: text };
}

/**
 * 装配：按 `settings.connectors` 连接/注册全部连接器。
 *   · 声明非法 ⇒ **当场抛**（v0.3 §4.2 装配期校验；宁可起不来，也不要装载一份说谎的声明面）；
 *   · MCP 路：接进既有客户端池（`connectMcp`），随后按既有唯一注册路径 `syncMcpTools(listMcpClients())` 注册；
 *   · HTTP 路：缺凭证 ⇒ 记 ok:false 且**撤掉**该连接器已注册的工具（工具面与实际可用的能力一致）；有凭证才注册；
 *   · 声明面是唯一出处：不在本次声明里的 `connector:*` 来源一律撤掉（卸载后工具立即消失——v0.3 §4.2 验收 G2）。
 *  幂等：重复调用结果一致（`connectMcp` 已连接即跳过；`registerDynamicTools` 是整源替换）。
 * @param {object} [dbc] 可注入的库（夹具用假库；真库会被连/被写，单测不能碰它——与 `connectConfiguredMcps` 同一手法）
 * @returns {Promise<{ok: boolean, results: Array<{id:string, kind:string, ok:boolean, tools?:number, error?:string}>}>}
 */
export async function connectConfiguredConnectors(dbc = db) {
  const list = await readConnectorConfig(dbc);
  const problems = validateConnectors(list);
  if (problems.length) {
    throw new Error('[connectors] 连接器声明非法（v0.3 §4.2：装配期校验，非法当场抛）：\n  - ' + problems.join('\n  - '));
  }
  const results = [];
  // ① MCP 路：与 settings.mcp_servers 走**同一条**连接实现；缺密钥时 resolveEnv 直接抛（下面记 ok:false，不静默降级）
  const mcpKind = list.filter((c) => c.kind === 'mcp');
  let mcpConnected = false;
  for (const c of mcpKind) {
    try {
      const r = await connectMcp(c.id, c.command, c.args || [], resolveEnv(c.env));
      mcpConnected = true;
      results.push({ id: c.id, kind: 'mcp', ok: true, tools: (r.tools || []).length });
    } catch (e) {
      results.push({ id: c.id, kind: 'mcp', ok: false, error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  // 一个都没连上就**不动**工具面（零副作用）：既有的 syncMcpTools 调用点（启动/看门狗/reload）负责池里其余客户端的注册
  if (mcpConnected) {
    const { syncMcpTools } = await import('./tools/index.js'); // 动态 import：避免 connectors → tools/index → … 的加载环
    syncMcpTools(listMcpClients());
  }
  // ② HTTP 路
  const ids = new Set();
  for (const c of list) {
    if (c.kind !== 'http') continue;
    ids.add('connector:' + c.id);
    const src = 'connector:' + c.id;
    if (!describeSecret(c.credential).configured) {
      // 缺凭证＝这个后端现在不可用：如实记错，并把上一代工具撤掉（与 MCP 路"缺密钥就不连"同一语义）
      unregisterDynamicTools(src);
      results.push({ id: c.id, kind: 'http', ok: false, error: '缺少凭据 ' + c.credential + '（应配在 ' + credentialsFile() + ' 或环境变量里）' });
      continue;
    }
    const entries = httpActionEntries(c);
    const r = registerDynamicTools(src, entries);
    if (!r.ok) {
      console.error('[connectors] 连接器 ' + c.id + ' 的工具注册被拒绝（工具面保持上一代）：' + r.error);
      results.push({ id: c.id, kind: 'http', ok: false, error: r.error });
    } else results.push({ id: c.id, kind: 'http', ok: true, tools: entries.length });
  }
  for (const sid of dynamicSourceIds()) {
    if (sid.startsWith('connector:') && !ids.has(sid)) unregisterDynamicTools(sid); // 声明里没有的＝已卸载
  }
  return { ok: results.every((r) => r.ok), results };
}
