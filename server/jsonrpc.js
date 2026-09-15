// server/jsonrpc.js - **通用 JSON-RPC 2.0 门面**的协议核心（v0.3 §0.4 三级形态的第三级、§7.1 ⑳，P3，依赖 ⑬）
//
// 为什么要有它（与 MCP 门面分开的理由）：
//   · v0.3 §0.4 把对外形态排成 **headless → MCP server → JSON-RPC** 三级递进。我们已经停在第二级：
//     `server/mcp-server.js` 就是 stdio 上的 newline-delimited JSON-RPC 2.0，但它**绑死 MCP 的方法名
//     （`initialize`/`tools/list`/`tools/call`）与结果形状（`content[].text`）**——那是 MCP 规范定的，
//     不是我们定的，而且它已经有真实第三方消费者（官方 MCP Inspector，见 RA-41），**不能改**。
//   · 于是第三级缺的不是"再来一份 JSON-RPC"，而是**一份方法名与结果形状由我们自己定的通用门面**：
//     调用方（客户内网里的普通程序）能直接 `{"method":"session.chat","params":{"message":"..."}}`
//     拿到**结构化结果**，不必先把 MCP 的 `content[0].text` 再解一遍 JSON，也不必为了调一个方法去读 MCP 规范。
//
// 照 DSH 怎么做（先问，再写）：DSH 的对外服务端是 `dsh-sdk-jsonrpc-server` ——
//   · **协议层薄**：`dsh-sdk-protocol` 的 `JsonRpcLineTransport` 只做四件事——按行拼帧、按 id/带不带 method
//     分派、未知方法回 -32601、处理器抛错回 -32603；**一行业务判断都没有**（它甚至不知道什么叫会话）；
//   · **业务在核**：`HarnessSdkJsonRpcServer.handleRequest` 一个 switch 把方法名交给真实现，
//     `initialize`/`session/prompt`/`shutdown` 三个方法，其余全在引擎内核里。
//   · 本文件就是那个"薄协议层"：**注册表 + 一次 dispatch + 一个 stdio 分帧**，除此之外什么都不做。
//
// 口径（两处刻意与既有实现保持一致，避免同一平台有两种说法）：
//   1. **分帧与错误码**沿用 `server/mcp-server.js` 的 `serveStdio` 思路（粘包/半行/坏 JSON 都要活下来），
//      但**不改那个文件**——它是 MCP 的，动它会破坏既有夹具（`test/mcp-server.test.mjs`）。
//   2. **业务失败走结果里的 `isError`，不走 JSON-RPC error**。理由与 MCP 门面逐字相同：
//      **调用方要能区分"你不会说协议"与"这次没干成"**——前者是调用方要改代码（-32601 方法名错、
//      -32602 参数错、-32700 根本不是 JSON），后者是这次没成、重试或换参数**可能**就成了。
//      合成一个通道，调用方就只能靠解析 message 里的人话（而那是中文散文）来分流。
//
// **不新造对外能力**（v0.3 §7.1 ⑳ + 04-接口规范"契约只增不改"）：`METHODS` 里每个方法都指向
// `docs/会话API契约-v1.md` §3 端点表里**已冻结**的端点，逐条写在 `contract` 字段里；
// `test/jsonrpc.test.mjs` 会去解析那份文档的端点表逐条核对 ⇒ **孤儿映射（指向不存在的端点）会报红**。
// 要加新能力，先改契约，不在这儿现造。
import { StringDecoder } from 'node:string_decoder';
import { RW_VERSION } from './env.js';

export const SERVER_NAME = 'rw-platform-jsonrpc';
// 这份门面的线协议版本。与 MCP 的 `server/mcp-version.js`（那是 MCP 规范版本）**不是同一个东西**，
// 故不共用常量：一个是"我按 MCP 规范哪一版说话"，一个是"我这份自家方法的形状是第几版"。
export const JSONRPC_VERSION = '2.0';
export const PROTOCOL_VERSION = 1;
// **实现方软件版本**（v0.3 §4.1 运行面"有版本号"）：单一出处＝`package.json`（经 env.js 的 RW_VERSION）。
// 调用方接上这门面时要能问出"对面这一版是什么"——否则排障只能靠猜（与 `/api/health` 不报版本同一个缺口）。
export const SOFTWARE_VERSION = RW_VERSION;

// JSON-RPC 2.0 规范 §5.1 的标准错误码。**只在"你不会说协议"时使用**（业务失败见文件头口径 2）。
export const ERR = {
  PARSE_ERROR: -32700,      // 不是合法 JSON（连 id 都读不出来）
  INVALID_REQUEST: -32600,  // 是 JSON，但不是合法的 JSON-RPC 请求
  METHOD_NOT_FOUND: -32601, // 合法的请求，但我们没有这个方法
  INVALID_PARAMS: -32602,   // 方法在，参数不合法（缺必填/类型错/多余的键）
  INTERNAL_ERROR: -32603,   // 我们这边崩了（缺陷，不是调用方的问题）
};

/**
 * 方法注册表：一个 Map + 一次查表。
 * 刻意**不做**插件框架/中间件/生命周期/双向流——v0.3 §6.1"简单优先"：没有第二个使用者之前不造抽象。
 */
export class Registry {
  constructor() { this.methods = new Map(); }

  /**
   * 注册一个方法。
   * @param {string} name 方法名（`资源.动作`，见 METHODS 的命名说明）
   * @param {(args:object, ctx?:object)=>any} handler 处理器；**抛错 = 业务失败**（见文件头口径 2）
   * @param {{description:string, contract:string|string[], params?:object}} def 对外声明：给人/给调用方看的说明 + 契约端点 + 参数表
   */
  register(name, handler, def) {
    if (this.methods.has(name)) throw new Error('方法重复注册：' + name);
    if (typeof handler !== 'function') throw new Error('handler 必须是函数：' + name);
    if (!def || !def.contract) throw new Error('方法必须声明它对应的契约端点（contract）：' + name);
    if (!def.params || def.params.type !== 'object') throw new Error('方法必须声明 object 类型的参数表（params）：' + name);
    this.methods.set(name, {
      name, handler, description: def.description || '', contract: def.contract, params: def.params,
      // 实现方软件版本（v0.3 §4.1 运行面"有版本号"）：METHODS 逐条声明（单一出处＝package.json），
      // 缺省或显式空 ⇒ 退回本门面自己的版本，**不留 undefined**（对外形态里一格 undefined 会被
      // JSON.stringify 直接丢掉，调用方看到的就是"这一格不存在"，与"没声明"分不开）。
      version: def.version || RW_VERSION,
    });
    return this;
  }

  get(name) { return this.methods.get(name); }
  has(name) { return this.methods.has(name); }
  /** 已注册方法的只读清单（夹具/内省用；含 handler，**不是**给线上传的） */
  list() { return [...this.methods.values()]; }
  /**
   * 对外面的方法清单：只有名字/说明/契约/参数表，**没有 handler**（能进 JSON）。
   * 握手用它 ⇒ 调用方在编码阶段就能发现方法名写错，而不是等一条 -32601；
   * 也是"映射表给调用方看"的落点（v0.3 §7.1 ⑳：每个方法逐条注明对应契约端点）。
   */
  face() {
    return this.list().map((m) => ({
      name: m.name, description: m.description, contract: m.contract, params: m.params,
      // 逐条带上门面的软件版本（v0.3 §4.1 运行面"有版本号"）：握手块（`system.capabilities` 的后端）
      // 就是把它摊平进响应里的，调用方据此对账"对面跑的是哪一版"——不额外改后端、不多一处手抄。
      version: m.version,
    }));
  }
}

/** 参数表：对象 + 每个参数的类型/必填/说明（对外自描述，也是校验的唯一依据） */
const P = (props, required) => ({ type: 'object', properties: props, required });

/**
 * 门面的方法表与**契约端点映射**。
 *
 * 方法名为什么这么定（`资源.动作`，点号）：
 *   · 资源名取契约里的词——契约把这条链叫"会话 API"，数据结构是 `conversations`，故资源 = `session`：
 *     与 `rw_chat`/`rw_status` 那种"为了给模型看而起的短名"区分开，这是给程序调的名字；
 *   · 分隔符用**点号**而不是 DSH 的斜杠（`session/prompt`）：我们的方法名会出现在
 *     `scripts/rw-jsonrpc.mjs` 的命令行与日志里，斜杠在 shell 里要转义、也容易被误当成路径；
 *   · 参数名 `conversationId`/`message` 与契约请求体**逐字一致**（`{conversationId, content}` 里的
 *     `content` 在门面这层用 `message`：MCP 工具面已用 `message`，同一平台两种叫法更糟）。
 */
export const METHODS = [
  {
    name: 'system.capabilities',
    description: '握手：报服务身份/线协议版本/已注册方法表，并探一次平台存活（调用方启动时先调它）。',
    // 契约端点：存活探测（唯一一条无需认证的端点）。握手必须**如实反映"平台在不在"**——
    // 进程活着不代表平台活着（后者要连库），所以不自己编一个 ready:true。
    contract: 'GET /api/health',
    // 平台版本（v0.3 §4.1 运行面"有版本号"）：调用方要能问出"对面这一版是什么"。
    // 单一出处＝package.json（经 env.js 的 RW_VERSION），**不在这里另写一份字面量**；
    // 与上面那个 PROTOCOL_VERSION（自家方法形状的版本）是两件事，故并列两格、不互相顶替。
    // （其余方法不逐条写：声明表末尾统一归一成同一个 SOFTWARE_VERSION，见 METHODS 之后那段。）
    version: SOFTWARE_VERSION,
    params: P({}, []),
  },
  {
    name: 'session.chat',
    description: '跑一轮对话（平台侧 Agent 会真的用工具干活）。给 conversationId 即追问同一会话，不给则新建。',
    // 两条：不给 conversationId 时要先建会话（契约 #5），因为执行入口只有 POST /api/chat（契约 #6）。
    contract: ['POST /api/conversations', 'POST /api/chat'],
    params: P({
      message: { type: 'string', description: '要对平台说的话（任务/问题）' },
      conversationId: { type: 'string', description: '可选：继续某个已有会话；不传=新建' },
      waitSeconds: { type: 'number', description: '最多等多久（秒）。超时不算失败：返回 status=timeout 与 conversationId，之后用 session.status 查或再 session.chat 追问' },
      idempotencyKey: { type: 'string', description: '可选：幂等键（走 Idempotency-Key 请求头，契约 §5.1）。同一键重发不会重复执行' },
      // 契约 §3.2 的请求体里还有可选 `provider`/`model`（本轮指定厂商与模型）。**这里刻意不暴露**：
      // 报文里声明了就必须真的转发，否则"传了 model 却按默认跑"是静默说谎；
      // 要加是"改适配器 + 加夹具"的一件事，不是加一行字段声明。
    }, ['message']),
  },
  {
    name: 'session.stop',
    description: '中止某个会话正在跑的那一轮（没有在跑的轮次时 stopped=false，仍是成功）。',
    contract: 'POST /api/chat/stop',
    params: P({ conversationId: { type: 'string', description: '会话 id' } }, ['conversationId']),
  },
  {
    name: 'session.status',
    description: '读一个会话已落库的消息（长任务在 session.chat 超时后用它轮询）。',
    contract: 'GET /api/conversations/:id/messages',
    params: P({
      conversationId: { type: 'string', description: '会话 id' },
      limit: { type: 'number', description: '返回最近几条消息（默认 5，上限 20）' },
    }, ['conversationId']),
  },
  {
    name: 'session.export',
    description: '导出一个会话（带格式版本的自描述包，可被 POST /api/conversations/import 导回）。',
    contract: 'GET /api/conversations/:id/export-full',
    params: P({ conversationId: { type: 'string', description: '会话 id' } }, ['conversationId']),
  },
  {
    name: 'session.activity',
    description: '按 seq 增量取一个会话的事件（轮询用；活动事件环只留最近若干条，见契约 §3.7 与 §4）。',
    contract: 'GET /api/conversations/:id/activity',
    params: P({
      conversationId: { type: 'string', description: '会话 id' },
      after: { type: 'number', description: '只要 seq 大于它的条目（默认 0=从最早还在环里的开始）' },
    }, ['conversationId']),
  },
];

// 软件版本**只声明一次**（=METHODS 里那一格），随后逐条归一：门面里每个方法对外都说同一个版本。
// 为什么在这里补而不是在每条 def 里手抄一遍：手抄 6 份就是 6 处会漂移的事实源，
// 而"这一版是哪一版"本来就只有一个答案（package.json）。声明过的不覆盖（留给将来真需要逐方法区分时用）。
for (const m of METHODS) if (!m.version) m.version = SOFTWARE_VERSION;

/** 类型的对外人话（错误信息里要说清楚"你要的是数字、给的是字符串"，而不是回一个 42） */
const TYPE_CN = (t) => {
  const names = { string: '字符串', number: '数字', boolean: '布尔', object: '对象', array: '数组' };
  return names[t] || String(t);
};

/** 按声明的参数表校验并归一参数。返回 {args} 或 {error}（error 由 dispatch 翻成 -32602）。 */
function applyParams(def, raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const props = def.properties || {};
  const args = {};
  const missing = [];
  const bad = [];
  for (const [k, spec] of Object.entries(props)) {
    const v = src[k];
    if (v === undefined || v === null || v === '') { // 空串按"没给"处理：命令行/HTTP 转手时 'x=' 会变成空串，不该被当成合法值
      if ((def.required || []).includes(k)) missing.push(k);
      continue;
    }
    if (typeof v !== spec.type) { bad.push(k + ' 应为' + TYPE_CN(spec.type) + '，实为 ' + typeof v); continue; }
    args[k] = v;
  }
  // 不认识的参数**如实报错**，不静默忽略：写错一个参数名却"成功返回"是最坏的一种骗人
  // （与 MCP 门面拒绝 `cursor` 同一条纪律：别装作没看见）。
  const unknown = Object.keys(src).filter((k) => !(k in props));
  if (missing.length) return { error: '缺少必填参数: ' + missing.join(', ') + '（本方法参数：' + Object.keys(props).join(', ') + '）' };
  if (bad.length) return { error: '参数类型不对：' + bad.join('；') };
  if (unknown.length) return { error: '不认识的参数: ' + unknown.join(', ') + '（本方法参数：' + Object.keys(props).join(', ') + '）' };
  return { args };
}

const ok = (id, result) => ({ jsonrpc: JSONRPC_VERSION, id, result });
const err = (id, code, message) => ({ jsonrpc: JSONRPC_VERSION, id, error: { code, message } });

/**
 * 唯一的分派入口：一条已解析的 JSON-RPC 消息 → 一条响应，或 null（通知不回）。
 * @param {object} msg 解析后的消息（可能是任何 JSON 值，本函数负责判断它是不是合法请求）
 * @param {Registry} registry 方法注册表
 * @param {object} [ctx] 可选上下文，原样传给处理器；`serveStdio` 会放一份 `{ registry }` 进去
 *   （握手要把方法表报给调用方 ⇒ 处理器得能读到注册表；这是唯一的注入点，不另造服务容器）
 * @returns {Promise<object|null>}
 */
export async function dispatch(msg, registry, ctx) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    // 批量请求（数组）我们没有约定：**明确拒绝好过猜**（与 MCP 门面同一条裁决）——
    // 按规范批量请求的响应本身就是"一个数组"，我们既然只接受单个对象，就把这条如实回成
    // `id:null` 的 Invalid Request，而不是装作没收到（调用方会一直等一个永远不来的响应）。
    // 真不是对象（字符串/数字/null）连请求都算不上，只配丢掉。
    if (!msg || typeof msg !== 'object') return null;
    return err(null, ERR.INVALID_REQUEST, 'Invalid Request：只接受单个 JSON-RPC 对象（不支持批量请求）');
  }
  // 通知与请求的分野：**通知（没有 id）绝不回**，包括方法不认识、参数不合法——
  // JSON-RPC 2.0 的"通知不期待响应"是**无条件**的，回一条错帧会让对端把它当成自己没发过的请求的响应。
  const isNotification = msg.id === undefined || msg.id === null;
  if (typeof msg.method !== 'string') {
    return isNotification ? null : err(msg.id, ERR.INVALID_REQUEST, 'Invalid Request：缺 method');
  }
  const entry = registry.get(msg.method);
  if (!entry) {
    // **-32601，不是"未知方法就装作没这回事"**：调用方要能在编码阶段发现问题，而不是跑了一轮才发现没生效。
    return isNotification ? null : err(msg.id, ERR.METHOD_NOT_FOUND, 'Method not found: ' + msg.method);
  }
  const norm = applyParams(entry.params, msg.params);
  if (norm.error) return isNotification ? null : err(msg.id, ERR.INVALID_PARAMS, 'Invalid params：' + norm.error);

  if (isNotification) {
    // 已注册方法的通知：执行**不写响应**（静默忽略；JS 里连错误事件都传不出去，如实写在这里）
    try { await entry.handler(norm.args, ctx); } catch { /* 通知无出口 */ }
    return null;
  }
  try {
    return ok(msg.id, await entry.handler(norm.args, ctx));
  } catch (e) {
    // 业务失败 → **结果里带 isError**（口径见文件头 2）。协议层只包一层"这次没干成"，
    // 不改写后端给的结构（后端的字段名就是它的契约，改一层就是多一种说法）。
    const message = String((e && e.message) || e);
    const code = (e && typeof e.code === 'string') ? e.code : null;
    const info = (e && e.info && typeof e.info === 'object') ? e.info : null;
    return ok(msg.id, { isError: true, message, ...(code ? { code } : {}), ...(info ? { info } : {}) });
  }
}

/** 装一个装配好的注册表（核心门面：6 个方法 → 6 个后端能力；后端字段与 METHODS 的 `资源.动作` 同名） */
export function createRegistry(backend) {
  const registry = new Registry();
  for (const def of METHODS) {
    const handler = backend[def.name];
    if (typeof handler !== 'function') throw new Error('后端缺能力：' + def.name);
    registry.register(def.name, handler, { description: def.description, contract: def.contract, params: def.params });
  }
  return registry;
}

/**
 * newline-delimited JSON-RPC 2.0 的 stdio 循环（粘包/半行/坏 JSON/多字节字符跨 chunk 都要活下来）。
 *
 * 与 MCP 的 `serveStdio` 相同的一条纪律：**stdout 只走协议帧**，日志一律 stderr——
 * 调用方按行解析 stdout，多一行人话就是一条解析错误。
 * `input`/`output` 可注入（夹具用内存流驱动，不必起子进程），与 MCP 门面同一形状。
 * 用 `StringDecoder` 而不是 `chunk.toString()`（照 DSH `JsonRpcLineTransport`）：一个 UTF-8 字符
 * 被切成两个 chunk 时，`toString()` 会把它变成替换字符 ⇒ 中文参数会静默损坏。
 */
export function serveStdio({ registry, input, output, ctx, onError = (m) => process.stderr.write('[' + SERVER_NAME + '] ' + m + '\n') }) {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  const write = (obj) => { try { output.write(JSON.stringify(obj) + '\n'); } catch (e) { onError('写响应失败：' + ((e && e.message) || e)); } };
  input.on('data', async (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue; // 空行不是帧
      let msg;
      try { msg = JSON.parse(line); }
      catch { write(err(null, ERR.PARSE_ERROR, 'Parse error：不是合法 JSON')); continue; } // 坏 JSON 连 id 都读不出来 ⇒ id: null（规范允许）
      try {
        const res = await dispatch(msg, registry, ctx);
        if (res) write(res);
      } catch (e) {
        // dispatch 自己已经把处理器异常收成 isError 了；走到这里说明是**协议层自己的缺陷** ⇒ -32603
        write(err(msg && msg.id !== undefined ? msg.id : null, ERR.INTERNAL_ERROR, 'Internal error: ' + ((e && e.message) || e)));
      }
    }
  });
  input.on('end', () => {
    buf += decoder.end();
    if (buf.trim()) onError('stdin 结束时还剩半行（未成帧，按协议不处理）：' + buf.slice(0, 120));
  });
  return { dispatch: (msg) => dispatch(msg, registry, ctx), write };
}

/** 装配并起一个 stdio 服务端：注册表同时进 ctx ⇒ 握手的方法表有唯一来源（不手抄第二份） */
export function serveStdioWith(backend, streams) {
  const registry = createRegistry(backend);
  return serveStdio({ registry, ctx: { registry }, ...streams });
}
