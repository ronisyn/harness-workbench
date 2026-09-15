// server/triggers.js —— 触发器接口（v0.3 §4.5 编排面：「定义触发器接口（手动/定时/外部调用/事件），**实现归使用方**」）
//
// 这一档要解决的事（2026-09-16 补）：编排面的入口原先各长各的——手动＝index.js 的 `POST /api/chat`、
// 定时＝scheduler.js 的 cron 循环、外部调用＝HTTP 契约 + MCP server，**事件那一档全仓零命中**。
// 形状不同、各自演化，就没人能回答"这个平台一共有几种方式能启动一次执行"。本模块把四档收敛成**一个接口**：
//   · `register(kind, handler, opts)` —— 使用方声明"这一类触发来的时候跑这个"，返回退订函数；
//   · `fire(kind, payload, meta)`     —— 触发面把一次触发交给接口（内部 fire-and-forget，不同步等 handler）。
// 本模块**只定义接口 + 只实现事件档的事件源**：手动/定时/外部调用三档的**源**留在原处不动
// （index.js / scheduler.js / MCP server），它们要接进来就是在自己的触发点调一次 `fire(...)` —— 这就是"实现归使用方"。
//
// 为什么照 DSH `dsh-webhook` 这条边界做（不造队列 / 不重试 / 不去重）：
//   · 该包 README 的 Known Limitations 原文：「**Process-local fire-and-forget only** — a crash loses rule
//     calls that have not admitted a prompt; **there is no queue, replay, or retry**」；
//     「**No built-in deduplication** — repeated provider deliveries may create repeated Sessions;
//     rules that need idempotency own it」；`dispatch` 的语义是「Start every currently matching rule and
//     **return before any callback settles**」，且「one throw or rejection is logged without **starving siblings**」。
//   · v0.3 §7.1 ㉒㉓㉔（自进化三源采集 / 提案流水线 / 优先级判据）才是"作业、重试、门禁"的归属，
//     本档只做"把一次触发交给使用方的 handler"，不越界。
//   · **频率限制 / 去重窗口一律不设**：v0.3 全文与既有 settings（settingsSchema.js）里都没有任何一条触发面参数，
//     凭空定一个阈值就是发明口径；需要幂等的使用方自己判（同 DSH）。
//   · 不落库、不做持久化调度：本模块没有任何存储——触发是**此刻**的事，"跑成什么样"是使用方 handler 的事。
import { onEventAppended } from './eventlog.js';
// 日志出口的纪律：handler 是使用方代码，它抛出的错误消息有可能带上刚处理过的明文，
// 所以凡是要打出去的一行都先过 `redactSecretValues`（C-18 定的唯一出口）。
import { redactSecretValues } from './credentials.js';

/** 四档触发器（出处＝v0.3 §4.5 的括号内顺序：手动/定时/外部调用/事件）。顺序即对外口径，不要随手改。 */
export const TRIGGER_KINDS = ['manual', 'schedule', 'external', 'event'];

/** 已注册的 handler：id → {id, kind, handler}。**进程内、内存态**（同 DSH：注册即 effect，进程没了就没了）。 */
const handlers = new Map();
let autoIdSeq = 0;

/**
 * 注册一个 handler。**默认一个都没有**——本模块装载后不会替任何人注册（"实现归使用方"）。
 * @param {'manual'|'schedule'|'external'|'event'} kind 四档之一；不在其中**抛错**（不静默忽略：写错档位的
 *   handler 永远不会被触发，静默吞掉就成了一条查不出来的哑线）
 * @param {(payload:object, meta:object) => any} handler 收到的是**深冻结的 JSON 快照**（见 snapshot）
 * @param {{id?:string}} [opts] id 是这一个 handler 的稳定名字（登记/退订/排障用；不给就自动编号）
 * @returns {() => void} 退订（同 DSH：注册本身是 effect，退回的 disposer 一调即摘掉这一条）
 */
export function register(kind, handler, opts = {}) {
  if (!TRIGGER_KINDS.includes(kind)) throw new Error('未知的触发器档位：' + kind + '（只认 ' + TRIGGER_KINDS.join('/') + '）');
  if (typeof handler !== 'function') throw new TypeError('触发器 ' + kind + ' 的 handler 必须是函数');
  const id = opts && opts.id ? String(opts.id) : kind + '#' + (++autoIdSeq);
  if (handlers.has(id)) throw new Error('触发器 id 已被占用：' + id + '（id 必须唯一，否则退订会摘错一条）');
  handlers.set(id, { id, kind, handler });
  return () => handlers.delete(id);
}

/**
 * 把一次触发交给接口：**把这一档现在匹配到的 handler 全部启动，然后在任何一个 handler 结束之前就返回**。
 * （DSH `dispatch` 的同一句话：Start every currently matching rule and return before any callback settles。）
 * @param {'manual'|'schedule'|'external'|'event'} kind
 * @param {object} [payload] 触发内容，必须是**无损 JSON**（活对象/函数/循环引用一律抛错，不悄悄塞给 handler）
 * @param {object} [meta] 这次触发**从哪来**：约定填 `{source}`（'eventlog' / 'http' / 'cron' / 'mcp' …）；
 *   其余字段各档自定（事件档给 `at`）。与 payload 一样会被快照 + 深冻结。
 * @returns {{kind:string, matched:number}} matched＝本次匹配到的 handler 数（0＝没有任何使用方在听，这是正常状态）
 */
export function fire(kind, payload = {}, meta = {}) {
  if (!TRIGGER_KINDS.includes(kind)) throw new TypeError('未知的触发器档位：' + kind);
  const matched = [];
  for (const h of handlers.values()) if (h.kind === kind) matched.push(h);
  // 没有使用方在听 ⇒ 立刻返回（连快照都不做）：这就是"默认不启用任何 handler"零成本的实现，
  // 而不是一句承诺——事件档的事件源每次都走这里，所以这条早退同时也是它的日常开销上限。
  if (!matched.length) return { kind, matched: 0 };
  const p = deepFreeze(snapshot(payload, 'payload'));
  const m = deepFreeze(snapshot(meta, 'meta'));
  for (const h of matched) {
    // 隔离：每个 handler 各自一条 promise 链，谁抛错/谁拒绝都只记一行日志，既不冒泡给触发面，
    // 也不拖住同一档的其它 handler（DSH：logged without starving siblings）。
    Promise.resolve().then(() => h.handler(p, m)).catch((e) => logFailure(h, e));
  }
  return { kind, matched: matched.length };
}

/**
 * 触发面的**安全投递口**：给"源"用（使用方的触发点：调度器每轮、外部调用的请求入口、手动跑一次）。
 *
 * 与 `fire` 的分工（这是本次接线补上的那一段，语义与 `fire` 完全一致，**没有放宽任何判据**）：
 *   · `fire(...)`　　＝接口本身：**如实**返回 `{kind, matched}`；档位写错 / payload 不是无损 JSON
 *     一律**当场抛错**（那两条既有口径一个字没动，`test/triggers.test.mjs` 照旧锁着）。
 *   · `fireSafely(...)` ＝源用的那一层：**本函数永不抛错、永不等待**——它把 `fire` 调用推到
 *     微任务队列（`queueMicrotask`）里执行，所有同步异常只记一行日志。
 *
 * 为什么源必须走它（"接线坏一次不许打断主流程"）：触发的 payload 来自使用方自己的现场
 * （任务行、请求参数、会话 id），其中出现不可无损 JSON 的字段是完全可能的；若让 `fire` 的
 * 同步抛错原样冒泡，`scheduler.js` 的 tick 循环会**当场中断本轮扫描**、
 * `scripts/rw-jsonrpc.mjs` / `scripts/rw-mcp-server.mjs` 的请求入口会**把一次正常调用变成一次失败**
 * ——那是"编排面的一个小功能坏掉，把平台的定时任务和对外调用一起带走"，与 §4.5 的
 * "只加接口、不接管主循环"正好相反。延到微任务还有一个作用：**连调用栈都不占用**
 * （tick 与请求处理都不会因为触发面而多等一帧）。
 *
 * 代价如实记：这样投出去以后**拿不到 `matched`**（返回值恒为 `undefined`）——源只需要知道
 * "这次触发已经交出去了"，而"有几个 handler 在听"是接口层的观测面，不是源的事。
 *
 * @param {'manual'|'schedule'|'external'|'event'} kind 四档之一；写错不抛错，只记一行日志
 * @param {object} [payload] 触发内容（口径同 `fire`：无损 JSON）
 * @param {object} [meta] 这次触发从哪来（口径同 `fire`：约定 `{source}`）
 * @param {(fn:() => void) => void} [enqueue] 延迟机制（默认 `queueMicrotask`；夹具注入同步执行以便断言）
 */
export function fireSafely(kind, payload = {}, meta = {}, enqueue = queueMicrotask) {
  // 外层 try 兜的是 `enqueue` **自己**抛错（注入同步执行的夹具就会走到这里）：本函数的承诺是
  // "调用方永远看不到异常"，那这条承诺就必须对这一层也成立——否则接线的保证会漏在调度机制上。
  // 真实路径（`queueMicrotask`）同步部分不会抛，这里是为"任何延迟机制"兜底。
  try {
    enqueue(() => {
      try { fire(kind, payload, meta); }
      catch (e) { logUnsafeDelivery(kind, e); }
    });
  } catch (e) { logUnsafeDelivery(kind, e); }
}

/** 源那一层的失败出口：出声（不许静默）、不冒泡、不留明文（与 handler 失败同一套脱敏口径）。 */
function logUnsafeDelivery(kind, e) {
  let msg = String((e && e.message) || e);
  try { msg = redactSecretValues(msg); } catch { /* 脱敏不可用＝保持原样，绝不因此吞掉这条日志 */ }
  console.error('[trigger] ' + kind + ' 档投递失败（触发面自己兜住，不影响触发点）：' + msg);
}

/**
 * 快照：只接受**无损 JSON**，交给 handler 的是这份快照（而不是调用方那个活对象）。
 * 为什么必须这样（DSH `snapshotDelivery` 的同一条）：同一份 payload 会被多个 handler 看到，
 * 不先固定下来的话，先跑的那个改一下字段，后面的就看到另一种数据；而"此刻就能序列化"也保证
 * 触发内容跨会话/跨进程交代得清楚。
 * 为什么"函数/undefined/symbol"也要报错，而不是照 `JSON.stringify` 的默认行为丢掉：`{fn(){}}` 会**悄悄变成 `{}`**，
 * handler 收到的就不是使用方以为的那份数据——触发面上"少了个字段"是最难查的一类错，宁可当场报出来。
 */
function snapshot(value, what) {
  if (value === undefined || value === null) return {};
  let text;
  try {
    text = JSON.stringify(value, (k, v) => {
      const t = typeof v;
      if (t === 'function' || t === 'symbol' || t === 'undefined' || t === 'bigint') {
        throw new TypeError((k === '' ? '整个值' : '字段 ' + k) + ' 的类型是 ' + t);
      }
      return v;
    });
  } catch (e) {
    // 循环引用等原生报错也归到同一条口径上（调用方只需要认"无损 JSON"这一句）
    throw new TypeError('触发器 ' + what + ' 必须是无损 JSON：' + String((e && e.message) || e));
  }
  if (typeof text !== 'string') throw new TypeError('触发器 ' + what + ' 必须是无损 JSON');
  return JSON.parse(text);
}

/** 深冻结快照：handler 只能读（ESM 是严格模式，写它会当场抛错，而不是"看起来没生效"）。 */
function deepFreeze(v) {
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) deepFreeze(v[k]); Object.freeze(v); }
  return v;
}

/** handler 失败的日志出口：出声（失败不许静默）、不冒泡、不留明文。 */
function logFailure(h, e) {
  let msg = String((e && e.message) || e);
  try { msg = redactSecretValues(msg); } catch { /* 脱敏不可用＝保持原样，绝不因此吞掉这条日志 */ }
  console.error('[trigger] ' + h.id + '（kind=' + h.kind + '）失败：' + msg);
}

// ── 事件档：事件源＝事件账本的追加点（本模块唯一自己实现的一档）──────────────────────────────────
// 订阅点就是 `server/eventlog.js` 的 `onEventAppended`（账本唯一写入点上的观察点，2026-09-16 随之补上）。
// 为什么不做轮询/不做"从库里读增量"：那等于自造一个持久化调度 + 游标，超出 §4.5 的"一个接口 + 一个事件源实现"，
// 也与 DSH 的进程内边界不符（重启后没跑成的触发就是不跑，理由同上：重放/补投是 ㉒㉓㉔ 的地盘）。
// 为什么订阅者要自己兜住：`fire` 对"档位写错 / payload 无法无损 JSON"是**如实抛错**的（同 DSH 的 dispatch）。
// 事件原文来自使用方（agent/index 发出的帧），其中有不可序列化的值是完全可能的，所以这里必须自己兜住——
// 触发面坏一次不许变成"账本也写不进去"（账本那边另有一层隔离，两层的职责不同：那边是账本的，这边是订阅者的）。
onEventAppended((e) => {
  try {
    fire('event',
      { conversationId: e.conversationId, type: e.type, seq: e.seq, at: e.at, payload: e.payload },
      { source: 'eventlog', conversationId: e.conversationId, type: e.type, seq: e.seq });
  } catch (err) {
    console.error('[trigger] 事件档派发失败（账本不受影响）：' + String((err && err.message) || err));
  }
});

/**
 * 自测 handler（夹具/冒烟用，**不是**默认启用项）：把每一次收到的触发记进调用方给的数组，返回累计条数。
 * 它存在的唯一理由是"接口要能被夹具确证"——使用方真正的 handler 在各自的模块里。
 * @param {Array<{payload:object, meta:object}>} sink 调用方持有的收集数组
 */
export function makeProbeHandler(sink = []) {
  return (payload, meta) => { sink.push({ payload, meta }); return sink.length; };
}
