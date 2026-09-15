// server/external-trigger.js —— **外部调用档**的源包装（v0.3 §4.5：触发器接口四档里的 `external`）
//
// 为什么要有这个文件（2026-09-16 补）：`server/triggers.js` 把四档接口定义好了，但**外部调用这一档
// 一直没有源**——全仓 import `triggers.js` 的只有夹具。而外部调用的入口有两个、**都在 `scripts/` 里**：
//   · `scripts/rw-jsonrpc.mjs`（普通程序把我们当 JSON-RPC 服务调）；
//   · `scripts/rw-mcp-server.mjs`（别的 agent 把我们当工具调）。
// 两个脚本的形态不同（前者自己组后端对象、后者把后端交给 MCP 循环），但"请求入口要 fire 一次 external"
// 这件事**逐字相同** ⇒ 收成一处，避免同一段 try/catch + 载荷裁剪写两遍（写两遍就会出现两种口径）。
//
// 三条纪律（都是既有口径的搬运，不是新发明的）：
//   1. **fire-and-forget，绝不等待**：走 `fireSafely`（`server/triggers.js`），触发的投递被推到微任务里，
//      调用方当场返回；handler 是使用方代码，跑多久都与这次 RPC/工具调用无关
//      （同 DSH `dispatch`：return before any callback settles）。
//   2. **接线坏一次不许影响请求处理**：`fireSafely` 本身永不抛错；本文件再把"载荷裁剪"也包进同一个
//      安全区——裁剪读的是使用方传进来的活对象，读它的字段本身就可能抛（getter/Proxy）。
//   3. **载荷只带可核对的事实，不带凭据**：
//      · 只取**显式列出**的字段（不整体 `JSON.stringify(args)`）——参数里混进不可无损 JSON 的值
//        （函数/BigInt/循环引用）时，整体搬运会当场抛错或让触发面报错，而我们要的是"触发照样发生"；
//      · **绝不带**这些键：`password`/`pass`/`token`/`authorization`/`secret`/`*_key`/幂等键。
//        幂等键尤其要留意：它是调用方给的**业务标识**，与"这次触发来没来"无关
//        （只带 `hasIdempotencyKey` 这个布尔，够排障，不值当把键本身写进日志/台账）；
//      · `message` 只带**长度**不带原文（触发是"有人调了这个入口"的事实，正文另在会话/账本里）。
import { fireSafely } from './triggers.js';

/** 触发载荷里**永远不带值**的键（小写子串匹配，见文件头纪律 3）。
 *  注意：幂等键**不在**这张表里——它由下面的 `IDEMPOTENCY_FIELDS` 单独处理成"给没给"这一格布尔，
 *  值同样一个字符都不进来（放进这张表会把那格布尔也一起丢掉）。 */
const SECRET_KEYS = ['pass', 'token', 'secret', 'authorization', 'apikey', 'api_key'];

/** 载荷里**允许直通**的字段（显式清单；其余字段一律不进触发载荷——白名单而不是黑名单）。 */
const PLAIN_FIELDS = ['conversationId', 'conversation_id', 'after', 'limit', 'waitSeconds', 'wait_seconds'];

/** `message` 只留长度：正文在会话里，触发载荷里再放一份等于多一处会过期的副本。 */
const MESSAGE_FIELDS = ['message'];

/** 幂等键只留"给没给"这一格（值本身是调用方的业务标识，不进触发载荷）。 */
const IDEMPOTENCY_FIELDS = ['idempotencyKey', 'idempotency_key'];

/**
 * 把一次外部调用裁成一份**无损、无凭据**的载荷。本函数**不会抛错**：读不动的字段如实标 `unreadable`，
 * 不把"载荷裁不动"变成"这次调用失败"。
 * @param {string} tool 入口标识（jsonrpc 的方法名 / MCP 的适配器名 / MCP 的暴露工具名）
 * @param {object} raw 调用方给的参数（活对象，只读不写）
 * @returns {object} 只含事实字段的载荷
 */
export function externalCallPayload(tool, raw) {
  const payload = { tool };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of Object.keys(raw)) {
      if (SECRET_KEYS.some((s) => k.toLowerCase().includes(s))) continue;
      let v;
      try { v = raw[k]; } catch { payload.unreadable = true; continue; } // getter 抛错：不当成"这次调用失败"
      if (v === undefined || v === null || v === '') continue;
      if (MESSAGE_FIELDS.includes(k)) { payload.messageLength = String(v).length; continue; }
      if (IDEMPOTENCY_FIELDS.includes(k)) { payload.hasIdempotencyKey = true; continue; }
      if (PLAIN_FIELDS.includes(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) payload[k] = v;
    }
  } else if (raw !== undefined && raw !== null) {
    payload.unreadable = true; // 不是对象（数组/字符串/数字）：只标一下，不搬运
  }
  return payload;
}

/**
 * 包一层"每个方法被调用时通知一次外部调用档"的后端。
 *
 * 为什么包整个后端（而不是在各方法体里各写一行）：两个门面都是"一个后端对象 + 一个按名字查表的循环"，
 * **接入点只有那一处**（`server/mcp-server.js:90`、`server/jsonrpc.js:250`）；在方法体里逐条写，
 * 等于把同一个口径抄 N 遍，且下一个新增的方法忘了抄时**不会报错**——那正是"只定义、没接线"这类缺口的老病。
 *
 * 语义（逐条写清）：
 *   · **触发发生在处理器之前**：fire 只说明"有人从这个入口调了 `tool`"，**不说明这次调用成功**
 *     （成功与否是返回值与 isError 的事）；所以超时/失败/业务报错**不影响**这次触发已经发生。
 *   · **不改变返回值/异常**：包装层原样透传（`Promise` 也原样透传，不 await、不 catch）——
 *     `server/jsonrpc.js` 的"业务失败走 isError"与 `server/mcp-server.js` 的 `isError` 分支一个字没动。
 *   · `source` 由调用方填（`jsonrpc` / `mcp`），`method` 记**入口自己的名字**。
 *
 * @param {Record<string, Function>} backend 原后端对象（不会被改动）
 * @param {{method?:(name:string) => string, source:string}} opts
 *   `method`：把后端的键映射成对外的方法名（不填＝键名本身）；`source`：这次触发从哪来（进 meta）
 * @returns {Record<string, Function>} 包好的后端（键集合与入参逐字不变）
 */
export function wrapExternalCalls(backend, { method = (name) => name, source } = {}) {
  const wrapped = {};
  for (const [name, fn] of Object.entries(backend)) {
    if (typeof fn !== 'function') { wrapped[name] = fn; continue; }
    wrapped[name] = function (...args) {
      // 纪律 2：源坏一次不许影响这次调用——裁剪与投递整段兜住，出错只记一行。
      try { fireSafely('external', externalCallPayload(method(name), args[0]), { source }); }
      catch (e) { console.error('[trigger] 外部调用档记一次触发失败（这次调用照常）：' + String((e && e.message) || e)); }
      return fn.apply(this, args);
    };
  }
  return wrapped;
}
