// server/eventlog.js —— 事件账本（append-only，落库）：会话事件除 SSE 与内存环之外，再留一份**可回放**的账。
//
// 为什么要它（2026-09-15 摸底发现）：
//   · 事件流此前只活在内存环里（agent.js 的 `activity`，最多 300 条、**进程重启即忘**）——断线重连只能
//     回放当前进程里还留着的部分，"那段时间到底发生了什么"没有证据；
//   · 下一步要做的**确定性投影**（对齐 DSH `sessionProjections`：把运行态当成事件流的投影）**没有源**：
//     投影的前提是一份只追加、有顺序、可回放的日志。DSH 的会话本身就是这样一份日志，投影与重放都读它。
//   本模块只做"写入 + 读回"，投影（reducer）是下一增量的事。
//
// 口径（三条，都有既有做法可依）：
//   ① **唯一写入点**：只有本模块向 `events` 表写入，由夹具锁住（与"节点 0 只有一个写入点"同款机检）；
//   ② **只追加**：账本不改写。保留策略沿用审计账本那一条（`audit_log` 的 90 天归档口径，
//      见 migrations 里 A9 的注释）；**归档器 = 本模块的 archiveOldEvents**（未闭环项 RA-47 于 2026-09-15 补上）——
//      它是代码里**唯一**允许删 events 的地方，且只在"同一批行已进 events_archive"之后删（见该函数注释）。
//   ③ 落库失败**出声但不阻断**：事件属观测面，丢了要能看见，但不能因为账本写不进去就让整轮失败。
//
// 与存储的关系（v0.3 §7.1 ⑦「存储抽象」/ §4.1「存储走接口」）：本模块**不再 import db**。
//   · 追加与回放走命名方法 `storage.events.append/read` —— 这两条是"引擎跑起来必需"的路径，
//     所以两个实现都得有（JSON 实现也落得了账），调用方从此不认识表名/列名；
//   · 输入校验（原文必须能 JSON 序列化）**仍留在本模块**：它是账本自己的纪律（见 persistEvent 注释），
//     搬进实现层就变成异步拒绝，调用点那个 try/catch 兜不住，等于把这条纪律弄丢；
//   · **归档仍用原生动词**（`query`/`run`，SQL 留在本文件）：它是 MySQL 侧的保留策略
//     （`events_archive` 表 + `NOW() - INTERVAL`），不在"引擎必需"范围内，本轮不动它 ——
//     动它要连带改既有归档夹具的假库注入点，收益不成比例。`RW_STORAGE=jsonfile` 时它会
//     **显式抛"该实现不支持 原生 SQL 查询"**（不静默跳过归档）。
import { storage } from './storage/index.js';

// 纯流式增量（think 思考块 / delta 正文增量）**不进账本**：它们是 UI 的实时糖，且最终文本已在
// messages.reasoning / messages.content 里（§7.3 双投影：原文始终可在 DB 查）。记账本的是**状态事件**。
// 这份名单是"刻意跳过"的唯一出处，夹具会锁住它——防止哪天顺手把状态事件也跳过了。
export const TRANSIENT_TYPES = new Set(['think', 'delta']);

let okCount = 0;
let failCount = 0;
let lastError = null;

// ── 追加观察点（v0.3 §4.5「定义触发器接口…事件」，2026-09-16 补"事件"那一档）──────────────────────
// 事件触发器的**事件源就是这里**：账本的追加点。为什么只做"此刻把这条事件告诉订阅者"，不做游标/补投/重放：
// 照 DSH `dsh-webhook` 的边界——该包 README 的 Known Limitations 原文「Process-local fire-and-forget only…
// **there is no queue, replay, or retry**」；要回放历史就读 `readEvents()`（账本本来就是可回放的源）。
// 为什么订阅者出错**不许**冒泡回来：账本是观测面、订阅者是使用方代码——观测面的写入不能被使用方拖垮，
// 这与"落库失败不阻断执行"是同一条纪律，只是方向相反。逐个隔离还顺带满足 DSH 那条
// 「one throw or rejection is logged without **starving siblings**」。
const appendedListeners = new Set();

/**
 * 订阅"账本接收了一条事件"。返回退订函数。
 * 订阅者**同步**被调用（在 INSERT 发出之前），必须自己保证不阻塞、不抛错——抛错只会被本模块记一行日志。
 * @param {(ev:{conversationId:number|null, seq:number, type:string, payload:object, at:any}) => void} fn
 * @returns {() => void} 退订
 */
export function onEventAppended(fn) {
  if (typeof fn !== 'function') throw new TypeError('onEventAppended 需要一个订阅函数');
  appendedListeners.add(fn);
  return () => appendedListeners.delete(fn);
}

/** 通知全部订阅者：逐个隔离，谁抛错都不影响其它订阅者，也不影响本次落账。 */
function notifyAppended(ev) {
  for (const fn of [...appendedListeners]) {
    try { fn(ev); } catch (e) { console.error('[eventlog] 事件订阅者出错（不影响落账）：' + String((e && e.message) || e)); }
  }
}

/** 事件 → 行（纯函数，可测；payload 存**除序号/时间戳/类型之外**的原文——那三样各有一列，不重复存） */
export function eventRow(conversationId, ev) {
  const { seq, at, type, ...payload } = ev || {};
  return { conversation_id: conversationId || null, seq: Number(seq) || 0, type: String(type || 'unknown'), payload };
}

/**
 * 追加一条事件（fire-and-forget：不 await、不阻断调用方）。
 *
 * 两个出口的先后（2026-09-16，事件触发器需要）：先**通知订阅者**、再发 INSERT，两者互不等待。
 * 为什么不是"等 INSERT 成功再通知"：那会把触发面绑在观测面上——库抖一下，触发就全哑；而本模块自己
 * 对落库失败的立场就是"出声但不阻断"（事件丢的是**回放**，不是事实）。所以通知的语义是
 * "账本接收了这条事件"，与库那一侧的成败无关。
 * @param {number|string} conversationId
 * @param {object} ev 事件原文（seq/at/type 之外的字段进 payload）
 * @param {{events:{append:Function}}} [dbc] **夹具缝**（默认真存储，与 archiveOldEvents 的 dbc 同款）：
 *   给假存储就不再碰真连接，夹具从而能断言"这条账确实追加了"。
 *   v0.3 §7.1 ⑦ 之前它是"假库"（`{query}`）；SQL 收进实现层之后，缝的位置随之抬到 `storage.events.append`。
 * @returns {boolean} 是否**尝试**写入（transient 类型返回 false —— 明确没写，不是失败）
 */
export function persistEvent(conversationId, ev, dbc = storage) {
  if (!conversationId || !ev || !ev.type) return false;
  if (TRANSIENT_TYPES.has(ev.type)) return false;
  const row = eventRow(conversationId, ev);
  // 账本自己的输入校验：原文无法无损 JSON（BigInt 之类）时**同步抛**，由调用点兜住（index.js 的 send
  // 就是 try/catch）。为什么不让实现层去抛：实现层是 async，抛出来是**拒绝的 promise** ——
  // 调用点的 try/catch 看不见，它会掉进本模块的 .catch 里被记成"落账失败"，从"当场暴露的编程错"
  // 变成"看起来像库抖了一下"。序列化在实现层还会再做一次（那份是介质的事，不是校验）。
  JSON.stringify(row.payload);
  notifyAppended({
    conversationId: row.conversation_id, seq: row.seq, type: row.type, payload: row.payload,
    at: ev.at === undefined ? null : ev.at,
  });
  dbc.events.append({ conversationId: row.conversation_id, seq: row.seq, type: row.type, payload: row.payload })
    .then(() => { okCount++; })
    .catch((e) => {
      failCount++;
      lastError = String((e && e.message) || e);
      // 只在出错时出声（正常路径零日志，避免刷屏）；计数供自检读
      if (failCount === 1 || failCount % 100 === 0) console.error('[eventlog] 事件落账失败 ' + failCount + ' 次（事件是观测面，不影响执行）：' + lastError);
    });
  return true;
}

/** 写入统计（自检/报告用） */
export function eventLogStats() { return { ok: okCount, fail: failCount, lastError }; }

/** 按会话回放事件（升序）。afterId 用于增量读。`dbc` 是夹具缝（与 persistEvent 的同一个）。 */
export async function readEvents(conversationId, { afterId = 0, limit = 2000, dbc = storage } = {}) {
  // 默认值与上下限（2000 / 20000）留在**这里**，不进接口：那是业务口径，不是介质的事
  // （接口也不替调用方发明默认值）。实现层只按给到的 afterId/limit 如实读。
  const rows = await dbc.events.read(conversationId, {
    afterId: Number(afterId) || 0,
    limit: Math.min(20000, Math.max(1, Number(limit) || 2000)),
  });
  return rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, at: r.at, payload: r.payload || {} }));
}

// ── 契约域事实：`contract_events` 是 `events` 的**投影**（v0.3 §0.5「不留两套」过账判定 C-39 第 ② 条）──────
// 裁决原文（`proposals/架构文档冲突登记-20260915.md` 的 C-39 行）：事件四处里，内存环＝跟播缓存、
// `events`＝唯一账本、`audit_log`＝审计动作账，而 **`contract_events`＝改造/迁移：与 `events` 同源**，
// 否则"同一事实两种投影"永远对不上账。
// 改造前：契约状态由 `driver.js` 自己 `INSERT INTO contract_events` —— 同一件"契约发生了什么"，账本里没有、
// `projection.js` 也折不出来。现在的口径是**一个事实、一个写入者**：契约事实先落 `events`（唯一账本，
// 走 `storage.events.append`，与其余账本写入同一条路），拿到账本行 id 后由**同一次调用**写
// `contract_events` 一行作为它的投影。三条判断写在这里，免得下一个人再猜：
//   ① **顺序必须"先账本、后投影"**：投影可重算、账本不可（只追加）。反过来写就会留下"投影里有、账本里没有"
//      的行 —— 那正是这次要治的病，顺序反了等于没治。
//   ② **投影行必须带 `event_id`**：可追溯要能**机检**（`test/contract-events-source.test.mjs` 锁这条）。
//      "同 contract_id + 同 kind"分不出两行同 kind 的事实，指回账本行 id 才是硬链接；它同时就是去重键：
//      唯一索引落在 `event_id` 上 ⇒ 重放同一条账本行不会再产生第二行，去重口径**照抄 `projection.js`
//      的"按账本行 id 去重"**（没有发明新规则）。
//   ③ **没会话就不写**（与 `persistEvent` 同一条口径：拿不到归属的账没有意义）—— 账本按会话归属，
//      契约事实归属它自己的任务会话（`task_contracts.conv_id`）。

/**
 * 落一条契约事实：账本一行（`events`）＋它的投影一行（`contract_events`），**一次调用写完**。
 *
 * 为什么账本的 `type` 与投影的 `kind` 用**同一个值**（不做前缀/改名）：可追溯的判据就该是等式
 * （`events.type = contract_events.kind` 且 `events.payload.contractId = contract_events.contract_id`），
 * 而投影那一列是**对外读数**（`GET /api/contracts/:id/events` 原样返回），改名等于改接口。
 * @param {number|string} contractId 契约 id（投影行的 `contract_id`、账本 payload 的 `contractId`）
 * @param {string} kind 契约事件类型（账本的 `type`；与投影的 `kind` 同值）
 * @param {string} detail 人读细节（截断 2000，与改造前 driver.js 的口径一致）
 * @param {{conversationId:number, dbc?:object}} opts `conversationId` 必填：账本按会话归属
 *   （`dbc` 是夹具缝，与 `persistEvent` 的同一个：给假存储就不再碰真连接）
 * @returns {Promise<number|false>} 账本行 id（＝投影行的 `event_id`）；`false`＝**明确没写**
 *   （缺契约 id / kind / 归属会话）——不是失败。写失败**如实抛**：契约事实不是流式糖，
 *   调用方（driver）自己决定怎么兜（它与改造前一样吞掉，但那是调用方的选择，不是本函数的）
 */
export async function persistContractEvent(contractId, kind, detail, { conversationId, dbc = storage } = {}) {
  const cid = Number(contractId);
  const type = String(kind == null ? '' : kind);
  if (!cid || !type || !conversationId) return false;
  const text = String(detail == null ? '' : detail).slice(0, 2000);
  const payload = { contractId: cid, detail: text };
  // 账本只有一个追加点 ⇒ 两条追加路径都得通知订阅者（§4.5 的"事件源＝账本的追加点"）：
  // 少了这一步就等于在模块内部又留一条"不广播的追加路径"，那正是本次要治的"两套"。
  // 通知语义与 persistEvent 逐字一致：账本**接收了**这条事件，与库那一侧的成败无关。
  notifyAppended({ conversationId, seq: 0, type, payload, at: null });
  // 账本行 id 是这条事实的身份（见上面 ②）：投影行靠它指回来，所以必须先拿到它再写投影。
  // `seq` 恒为 0：契约事实不是会话帧，没有序号可用；它在账本里的身份就是行 id。
  const { id: eventId } = await dbc.events.append({ conversationId, seq: 0, type, payload });
  // 同一次调用里的第二笔：投影。这里用存储面的**原生动词**（`run`）而不是再加一个命名方法 ——
  // 契约域整体还没迁到存储接口（`driver.js` 仍用 db 直接读写 `task_contracts`），为一个单一使用者
  // 发明命名方法不划算（v0.3 §0.6「不做的范围」）。
  await dbc.run(
    'INSERT INTO contract_events (contract_id, kind, detail, event_id) VALUES (?,?,?,?)'
    + ' ON DUPLICATE KEY UPDATE contract_id=VALUES(contract_id), kind=VALUES(kind), detail=VALUES(detail)',
    [cid, type, text, eventId]);
  return eventId;
}

// ── 保留与归档（RA-47 未闭环项，2026-09-15 补齐）────────────────────────────────────────────
// 账本**只追加不删除**是设计（可回放的源），但主表会无界增长。保留口径不自己发明：沿用审计账本那一条
// （`audit_log` 的 90 天归档，见 migrations 里 A9 的注释）。
// 三条硬约束（顺序即安全性）：
//   ① **先插入归档表、插入成功才删原表** —— 删之前那批行必须已经躺在 events_archive 里；
//   ② 失败**宁可少归档也不许先删**：任何一步出错就原样抛出，events 一行不动（抛错是为了让调用方出声，
//      不能把"没归档"静默报成"归档了 0 行"——那样没人会去查）；
//   ③ 分批（limit，默认 5000，与 audit 归档同量级）：一次只搬一批，避免长事务锁大表。
export const EVENT_ARCHIVE_DAYS = 90; // 与审计账本同一口径（单一出处：这里）
export const EVENT_ARCHIVE_LIMIT = 5000;

/**
 * 把早于 `days` 天的事件搬进 `events_archive`。
 * 幂等：搬完即从 events 删除，重复跑不会再搬同一批（第二次返回 0）。
 * @param {{days?:number, limit?:number, dbc?:object}} opts dbc 仅夹具用（默认真存储；归档走原生动词，
 *   所以假对象只要有 `query`/`run` 两个方法就够 —— 既有归档夹具不必改）
 * @returns {Promise<{archived:number, deleted:number}>}
 */
export async function archiveOldEvents({ days = EVENT_ARCHIVE_DAYS, limit = EVENT_ARCHIVE_LIMIT, dbc = storage } = {}) {
  const d = Number(days) > 0 ? Number(days) : EVENT_ARCHIVE_DAYS;
  const n = Math.min(20000, Math.max(1, Number(limit) || EVENT_ARCHIVE_LIMIT));
  const rows = await dbc.query('SELECT id FROM events WHERE created_at < NOW() - INTERVAL ? DAY ORDER BY id LIMIT ?', [d, n]);
  if (!rows.length) return { archived: 0, deleted: 0 };
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  // ① 先搬：搬成功（整条语句原子）之前，下面这行 DELETE 一行都不会执行
  await dbc.query(`INSERT INTO events_archive (id, conversation_id, seq, type, payload, created_at) SELECT id, conversation_id, seq, type, payload, created_at FROM events WHERE id IN (${ph})`, ids);
  // ② 再删：只删**刚才搬过的那批 id**（不是"再按时间条件删一遍"——条件式删法在插入失败时会删掉没搬走的行）
  const r = await dbc.run(`DELETE FROM events WHERE id IN (${ph})`, ids);
  return { archived: ids.length, deleted: Number((r && r.affectedRows) || 0) };
}
