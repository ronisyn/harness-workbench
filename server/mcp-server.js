// server/mcp-server.js - 把平台暴露成 **MCP server**（JSON-RPC 2.0 over stdio），让别的 agent 把平台当工具调
//
// 为什么是这个形态（2026-09-16，D4-B）：
//   · MCP 是"别的 agent 调我们"的事实标准，协议由官方规范定义，我们照实现即可；
//   · DSH 自己没有 MCP server（它作为 server 的通道是 stdio JSON-RPC / ACP；`dsh-mcp-client` 只是客户端），
//     所以这一块**没有可抄的对象**——能抄的是它客户端的**握手与分页纪律**，我们已经在 `server/mcp.js` 里实现过；
//   · 反过来，我们**自己的 MCP 客户端**（`server/mcp.js`，已在真机连过 GitHub MCP server）就是最方便的验收器：
//     拿它连自己的 server 跑一轮，等于用"已被第三方 server 检验过的实现"当对照。
//
// 协议要点（与 `server/mcp.js` 客户端的握手逐字对齐，客户端要什么我们给什么）：
//   initialize → {protocolVersion, capabilities:{tools:{}}, serverInfo}
//   notifications/initialized → 通知，**不回**（JSON-RPC 规范：通知不期待响应）
//   tools/list → {tools:[{name, description, inputSchema}]}；本 server 只有几个工具、不分页，
//                但**收到不认识的 cursor 必须报错**（-32602）而不是忽略——"静默截断"是我们客户端
//                在别处踩过的坑（server/mcp.js:35-48），服务端也不该制造它。
//   tools/call → {content:[{type:'text', text}], isError?}——**工具执行失败走 isError，不走 JSON-RPC error**
//                （前者是"这次调用没成功"，后者是"你不会说协议"）。
//   ping → {}
//
// 工具面只放三个：跑一轮对话 / 查一次状态 / 导出会话。**不把平台内部 90+ 个模型工具搬出去**——
// 那是我们自己的 agent 的工具（含写盘、执行命令），不是给外部调用方的接口；对外只暴露"平台能力"这一层。
import { PROTOCOL_VERSION as CLIENT_PROTOCOL } from './mcp-version.js';
import { RW_VERSION } from './env.js';

// serverInfo.version = **平台版本**（v0.3 §4.1 运行面"有版本号"）。
// 为什么不是原来那个字面量 '1'：那是 MCP 协议版本的意思，可这一格是"我是哪一版平台"，
// 客户端（含官方 Inspector）据此判断对面是不是它以为的那个 build——写死一个与 package.json 无关的
// 常量，等于握手时说了个没人维护的号（`/api/health` 就一直没报版本）。此处转引 env.js 的单一出处。
export const SERVER_INFO = { name: 'rw-platform', version: RW_VERSION };
// 与客户端握手用的版本保持一致（server/mcp.js:97 发的就是它）——服务端"回声"客户端版本是规范允许的做法
export const PROTOCOL_VERSION = CLIENT_PROTOCOL;

const T = (name, description, properties, required) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

// 工具定义：每个都对应一条**已冻结的契约端点**（docs/会话API契约-v1.md），不新造能力
export function toolDefs() {
  return [
    T('rw_chat', '在 Roni Workbench 平台上跑一轮对话（平台侧 Agent 会真的用工具干活）。给 conversation_id 就是追问同一个会话；不给则新建一个会话。',
      {
        message: { type: 'string', description: '要对平台说的话（任务/问题）' },
        conversation_id: { type: 'string', description: '可选：继续某个已有会话；不传=新建' },
        wait_seconds: { type: 'number', description: '最多等多久（秒）。超时不算失败：会返回 status=running 与 conversation_id，之后用 rw_status 查或再 rw_chat 追问' },
      }, ['message']),
    T('rw_status', '查一个会话最近的状态与最后一条回复（长任务用它在 rw_chat 超时后轮询）。',
      { conversation_id: { type: 'string', description: '会话 id' }, limit: { type: 'number', description: '返回最近几条消息（默认 5）' } }, ['conversation_id']),
    T('rw_export', '导出一个会话（带格式版本的自描述包，可被 POST /api/conversations/import 导回）。',
      { conversation_id: { type: 'string', description: '会话 id' } }, ['conversation_id']),
  ];
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text: String(text).slice(0, 20000) }], ...(isError ? { isError: true } : {}) });

/**
 * 处理一条已解析的 JSON-RPC 消息。
 * @param {object} msg 解析后的消息
 * @param {object} backend 后端能力：{ health, chat, status, exportSession }
 * @returns {Promise<object|null>} 响应对象；通知返回 null（不回）
 */
export async function handleMessage(msg, backend) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(null, -32600, 'Invalid Request：只接受单个 JSON-RPC 对象');
  const { id = null, method, params } = msg;
  const isNotification = id === null || id === undefined;
  if (typeof method !== 'string') return isNotification ? null : err(id, -32600, 'Invalid Request：缺 method');
  if (method.startsWith('notifications/')) return null; // 通知一律不回

  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    case 'ping':
      return ok(id, {});
    case 'tools/list': {
      // 我们不分页（工具少），但"收到游标"说明客户端在按分页协议走而我们没给——如实报错，别装作没有
      if (params && params.cursor !== undefined && params.cursor !== null) return err(id, -32602, 'Invalid params：本 server 不返回分页游标（工具数固定），不应收到 cursor');
      return ok(id, { tools: toolDefs() });
    }
    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const tool = toolDefs().find((t) => t.name === name);
      if (!tool) return err(id, -32602, 'Unknown tool: ' + JSON.stringify(name));
      const miss = (tool.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
      if (miss.length) return err(id, -32602, '缺少必填参数: ' + miss.join(', '));
      try {
        const r = await backend[name === 'rw_chat' ? 'chat' : name === 'rw_status' ? 'status' : 'exportSession'](args);
        return ok(id, textResult(typeof r === 'string' ? r : JSON.stringify(r, null, 2)));
      } catch (e) {
        // 工具执行失败：MCP 口径是**结果里带 isError**（不是 JSON-RPC error）——客户端据此把内容当"失败的输出"看
        return ok(id, textResult('工具执行失败：' + String((e && e.message) || e), true));
      }
    }
    default:
      return err(id, -32601, 'Method not found: ' + method);
  }
}

/**
 * newline-delimited JSON-RPC 的 stdio 循环（粘包/半行/坏 JSON 都要活下来）。
 * `input`/`output` 可注入（夹具用内存流驱动，不必起子进程）。
 */
export function serveStdio({ backend, input, output, onError = (m) => console.error('[mcp-server] ' + m) }) {
  let buf = '';
  const write = (obj) => { try { output.write(JSON.stringify(obj) + '\n'); } catch (e) { onError('写响应失败：' + e.message); } };
  input.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { write(err(null, -32700, 'Parse error：不是合法 JSON')); continue; }
      try {
        const res = await handleMessage(msg, backend);
        if (res) write(res);
      } catch (e) { write(err(msg && msg.id !== undefined ? msg.id : null, -32603, 'Internal error: ' + ((e && e.message) || e))); }
    }
  });
  input.on('end', () => { if (buf.trim()) onError('stdin 结束时还剩半行：' + buf.slice(0, 120)); });
  return { handle: handleMessage };
}
