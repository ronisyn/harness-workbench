// server/turns.js - 运行中轮次的**唯一登记处**（v0.3 §4.7 G5「跨端一致」里「可控制」那一半的收口）
//
// 为什么必须收成一处（这是契约 `docs/会话API契约-v1.md` §7 记的缺口之一）：
//   改前有两份**互相看不见**的登记：
//     · `server/index.js` 的私有 `abortMap`，键 = `accountId:conversationId`；
//     · `server/channels/run-turn.js` 的私有 `activeTurns`，键 = `conversationId`。
//   于是 `POST /api/chat/stop` 只认前者：渠道会话在 HTTP 面**停不了**——渠道那一份只有进程内函数
//   `abortChannelTurn()`，HTTP 面够不着（"飞书里跑飞了一轮，登录 GUI 也停不下来"）。
//   现在 GUI（`/api/chat`）与渠道（`runChannelTurn`）**都登记在这里**：一个轮次只有一个登记处，
//   停止入口自然只有一条（`stopTurn`）。
//
// 改这个文件之前先读这两条设计约束：
//   ① 键**只能**是 conversationId。渠道会话的 `conversations.account_id` 是 NULL
//      （见 `server/channels/feishu-webhook.js` 的 findOrCreateConv），任何含账号的键都盖不住它；
//      归属（"谁能停"）是**查到轮次之后**再判的事，不是键的一部分。
//   ② 它**不是**现场登记。现场（可恢复、跨重启）是 `server/runtrack.js` 的 `agent_runs`（落库）；
//      这里只记"此刻谁在跑"，进程重启即空 —— 与 DSH 的 fire-and-forget 同寿命，**不假装能跨重启停**。
const turns = new Map(); // String(conversationId) → { conversationId, controller, accountId, channel, kind, startedAt }

// 键归一：调用方给数字（会话行）还是字符串（HTTP 参数）都要落到同一个键上，
// 否则 `stopTurn` 会查不到刚登记的那一轮——那正是"看着有入口，其实停不了"的老毛病换了个位置。
const keyOf = (conversationId) => String(conversationId);

/**
 * 登记一轮开始跑（`/api/chat` 与渠道轮次都走这里）。
 * @param {object} o
 * @param {number|string} o.conversationId 会话 id（**唯一的键**）
 * @param {AbortController} o.controller   中止这一轮用的控制器
 * @param {number|null} [o.accountId]      归属账号；渠道轮次为 null（会话行本来就是 NULL）
 * @param {string|null} [o.channel]        端：'web'（GUI）/ 'feishu' / 'wechat'
 * @param {string} [o.kind]                轮次种类（诊断用：'chat' / 'channel'）
 * @param {number} [o.startedAt]           开始时刻（缺省取调用时刻）
 * @returns {object} 登记项（只读用；调用方不必保存）
 */
export function registerTurn({ conversationId, controller, accountId = null, channel = null, kind = 'chat', startedAt = Date.now() }) {
  if (!conversationId || !controller) throw new TypeError('registerTurn 需要 conversationId 与 controller');
  const entry = { conversationId, controller, accountId: accountId == null ? null : accountId, channel: channel || null, kind, startedAt };
  turns.set(keyOf(conversationId), entry);
  return entry;
}

/**
 * 注销一轮。**只在"还是自己那一轮"时清理**：同一会话并发两轮时，收尾的那一轮不该把对方的登记抹掉
 * （与 run-turn 改前的 `cur.controller === controller` 同一条判据，没有放宽）。
 * @returns {boolean} 是否真的注销了（false＝这里已经没有那一轮，或已经不是它了）
 */
export function releaseTurn(conversationId, controller) {
  const k = keyOf(conversationId);
  const cur = turns.get(k);
  if (cur && (!controller || cur.controller === controller)) { turns.delete(k); return true; }
  return false;
}

/** 此刻在跑的轮次（只读快照；诊断/自检用。**不许拿它当中止入口**——中止走 stopTurn） */
export function activeTurns() {
  return [...turns.values()].map((t) => ({ conversationId: t.conversationId, accountId: t.accountId, channel: t.channel, kind: t.kind, startedAt: t.startedAt }));
}

/** 查一轮（只读；找不到返回 null）。调用方拿它判断"这会儿有没有人在跑"，不要拿快照去改东西。 */
export function turnOf(conversationId) {
  return turns.get(keyOf(conversationId)) || null;
}

/**
 * 停一轮 —— **唯一的中止入口**（`POST /api/chat/stop` 与删会话的抢占都走它，渠道会话因此停得下来）。
 *
 * 归属判据**照抄既有那一条**（`server/index.js` 的 `GET /api/conversations/:id/messages`）：
 * 「本人（account_id 相等）或 渠道共享会话（account_id 为 NULL 且不是 web）」——不新造权限规则，
 * 也不因为"键里没有账号"就把渠道会话变成谁都能停的公共资源。
 *
 * @param {object} o
 * @param {number|string} o.conversationId
 * @param {number} [o.accountId] 发起停止的账号（HTTP 面传 `req.user.id`）
 * @param {string} [o.reason]   中止原因（进 `signal.reason`，与既有 'user'/'disconnect'/'delete' 同口径）
 * @returns {boolean} 本次调用**是否真的中止了一个在跑的轮次**。以下三种都如实返回 false，不假装停成功：
 *   ① 没有这一轮（没在跑 / 已经跑完注销了）；② 不属于你；③ 已经在停（断连/删除/上一次停止已生效）。
 */
export function stopTurn({ conversationId, accountId = undefined, reason = 'user' } = {}) {
  const t = turns.get(keyOf(conversationId));
  if (!t) return false;
  const mine = t.accountId == null
    ? (!!t.channel && t.channel !== 'web') // 渠道共享会话：账号对不上是设计使然（那一列就是 NULL）
    : String(t.accountId) === String(accountId);
  if (!mine) return false;
  if (t.controller.signal && t.controller.signal.aborted) return false; // 已经在停：本次没有再中止什么
  t.controller.abort(reason);
  return true;
}
