// server/replay.js - 无 SSE 调用方的**只读回放**入口：按会话重建现场（事件账本 + 落库消息）
//
// 为什么要有它（v0.3 §4.7 G5「跨端一致」的第三块：**续订**）：
//   续订在 GUI 那条链上靠 SSE（`GET /api/conversations/:id/stream`，只读、按 `seq` 补发 + 跟播）。
//   渠道（飞书 webhook / 微信长轮询）**没有长连接**，所以那条路对它们不存在——"重连不丢现场"在渠道上
//   只能是**读账本**（这正是账本从第一天起就是 append-only 的原因，见 `server/eventlog.js` 的开头）。
//   改前 `readEvents` 只有 CLI 脚本（`scripts/replay-events.mjs`、`scripts/projection-replay.mjs`）在用，
//   对外**没有**任何回放入口 ⇒ 渠道侧要重建现场只能自己拼 SQL。
//
// 为什么挂在既有的 `/messages` 语义上（而不是新开一条端上通道）：
//   · `GET /api/conversations/:id/messages` 已经有**正确的那条归属判据**（本人 或 渠道共享会话），
//     渠道会话（account_id 为 NULL）能被它读到，而 `/stream` 的判据是 `account_id=?`（渠道读不到）。
//     新开端点就得把那条件再抄一遍 —— 抄第二遍就是第二个出处。
//   · 因此本模块只把"消息 + 事件"这两笔读收在一处，端点按 `?events=1` 决定要不要带事件那一笔
//     （默认响应逐字节不变：老调用方看不到新字段）。
//
// 只读：这里没有任何写路径，也**绝不触发执行**（与 §4「续订只补发、不重跑」同一条纪律）。
import { db as realDb } from './db.js';
import { readEvents } from './eventlog.js';

// 消息读的 SQL 只此一份（`/messages` 端点与本模块的回放共用，避免两处各写一条 SELECT）：
// 字段与排序是**对外形状**（契约 §3.5），改它等于改接口。
export const MESSAGES_SQL = 'SELECT id, role, content, reasoning, model, provider, created_at FROM messages WHERE conversation_id=? ORDER BY id';

/** 落库消息（升序）。`db` 是夹具缝（默认真库）。 */
export async function readMessages(conversationId, { db = realDb } = {}) {
  return db.query(MESSAGES_SQL, [conversationId]);
}

/**
 * 按会话回放：落库消息 + 事件账本（升序）。
 * @param {number|string} conversationId
 * @param {object} [o]
 * @param {number} [o.afterId] 增量游标：只取账本行 id > afterId 的事件（默认 0＝从头）
 * @param {number} [o.limit]   事件条数上限（缺省走 `readEvents` 自己的默认值，这里不另发明一个）
 * @param {object} [o.db]      夹具缝（消息读）
 * @param {object} [o.dbc]     夹具缝（账本读，与 `persistEvent`/`readEvents` 的同一个）
 * @returns {Promise<{messages:Array, events:Array<{id:number, seq:number, type:string, at:any, payload:object}>}>}
 */
export async function replayConversation(conversationId, { afterId = 0, limit, db = realDb, dbc } = {}) {
  const cid = Number(conversationId);
  const opts = { afterId: Number(afterId) || 0 };
  if (limit != null) opts.limit = limit;   // 不传就不传：默认值与上下限是 eventlog 的口径，这里不复制
  if (dbc) opts.dbc = dbc;
  const messages = await readMessages(cid, { db });
  const events = await readEvents(cid, opts);
  return { messages, events };
}
