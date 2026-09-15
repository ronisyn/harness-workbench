// server/deliveries.js - 外部投递记录：幂等键的落点 + 死信落点（D4/RA-42，2026-09-16）
//
// 它防的**真实故障**（不是假想）：调用方发出 `POST /api/chat` 后、在收到 `done` 之前连接断掉，
// 于是它无法判断"活有没有派出去"，只能重发 —— 而重发在从前会**再落一条 user 消息、再跑一轮 agent**，
// 重复花钱，有副作用的工具（写文件/提交/部署）还会被执行两遍。
//
// 语义（照 DSH 的 prompt `requestId`：已记录的重复请求**返回原始接受结果**，不再插一条消息）：
//   · 同一（账号 + Idempotency-Key）再次到达：
//       - 上次已成功 → **回放**上次的接受结果（不执行）；
//       - 上次还在跑 → 409 IDEMPOTENT_IN_PROGRESS（不排队、不阻塞）；
//       - 上次失败   → **允许重发**（attempts+1）——这就是死信的人工重放路径；
//       - 键相同但请求体不同 → 409 IDEMPOTENT_KEY_REUSED（防"换个参数还拿旧结果"）。
//   · **不设时间窗口**：键随会话寿命存在（对外部调用重试间隔本仓没有任何数据，拍一个天数就是莫须有的值）。
//     行清理等出现真实增长再定（与事件归档同一套"不预设参数"的处理）。
//
// 它**防不了**什么（契约里必须写清，别被当成"断线不丢"的银弹）：浏览器在 done 前断开时，服务端本来就会
// 中止本轮（server/index.js 的 req.on('close')），这种情况**没有可重放的结果**；进程崩溃同理（各有既有机制：
// 现场保留 + ensureRun/resumeHint）。
//
// 为什么是独立一张表、而不是复用 events / task_contracts：
//   · `events` 是**只追加的事实账本**，值钱的地方正是"唯一写入点 / 只追加 / 投影源"三条口径 —— 塞进状态机会污染它，
//     而且它没有"谁调用的、试了几次、怎么重放"这三样；
//   · `task_contracts` 是**任务契约**语义（同一条任务反复修），与"一次外部调用"的寿命和归属都不同。
import crypto from 'node:crypto';
import { db } from './db.js';

export const IDEM_KEY_MAX = 200;   // 与 deliveries.idem_key VARCHAR(200) 对齐
export const MAX_LIST = 100;       // 与《接口规范》§六 的列表上限一致（默认 20）

// 请求指纹：同一个幂等键必须对应同一个请求体，否则拒绝（而不是拿旧结果糊弄过去）
export function requestHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 64);
}

const rowOf = async (accountId, idemKey) => (await db.query(
  'SELECT * FROM deliveries WHERE account_id <=> ? AND idem_key = ? LIMIT 1', [accountId, idemKey],
))[0] || null;

// 开始一次投递。返回 { id, fresh } 或 { replay } 或 { conflict }
export async function beginDelivery({ accountId = null, conversationId = null, idemKey = null, hash = null } = {}) {
  if (!idemKey) {
    const r = await db.query(
      'INSERT INTO deliveries (account_id, conversation_id, state, attempts) VALUES (?,?,?,?)',
      [accountId, conversationId, 'running', 1],
    );
    return { id: r.insertId, fresh: true };
  }
  const decide = (row) => {
    if (row.state === 'succeeded') {
      const resp = (() => { try { return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json; } catch { return null; } })();
      return { replay: resp || { messageId: row.message_id, runId: row.run_id } };
    }
    if (row.state === 'failed') return { retry: true, id: row.id, attempts: Number(row.attempts || 1) };
    return { conflict: 'in_progress' };
  };
  const hit = await rowOf(accountId, idemKey);
  if (hit) {
    if (hash && hit.request_hash && hit.request_hash !== hash) return { conflict: 'key_reused' };
    const d = decide(hit);
    if (d.conflict) return d;
    if (d.replay) return d;
    // 上次失败 ⇒ 重发：占住它（attempts+1 并回到 running），这样"同一刻两个重发"只有一个能进来
    const upd = await db.query(
      'UPDATE deliveries SET state=?, attempts=attempts+1, request_hash=COALESCE(?, request_hash), updated_at=NOW() WHERE id=? AND state=?',
      ['running', hash, hit.id, 'failed'],
    );
    if (upd.affectedRows === 1) return { id: hit.id, fresh: true, retry: true };
    return { conflict: 'in_progress' };
  }
  try {
    const r = await db.query(
      'INSERT INTO deliveries (account_id, conversation_id, idem_key, request_hash, state, attempts) VALUES (?,?,?,?,?,?)',
      [accountId, conversationId, idemKey, hash, 'running', 1],
    );
    return { id: r.insertId, fresh: true };
  } catch (e) {
    // 并发：两个请求同时带着同一个新键进来 —— 唯一索引会让一个失败，那个就按"上一个还在跑"处理
    if (/Duplicate entry/i.test(String(e && e.message))) return { conflict: 'in_progress' };
    throw e;
  }
}

// 收尾：成功时把**接受结果**存下来（供回放），失败时留下错误（供人看与重放）
export async function finishDelivery(id, { state, messageId = null, runId = null, response = null, error = null, errorCode = null } = {}) {
  if (!id) return;
  try {
    await db.query(
      'UPDATE deliveries SET state=?, message_id=?, run_id=?, response_json=?, last_error=?, last_error_code=?, updated_at=NOW() WHERE id=?',
      [state, messageId, runId, response ? JSON.stringify(response) : null, error ? String(error).slice(0, 500) : null, errorCode, id],
    );
  } catch (e) {
    // 投递记录写失败不能反过来弄坏本轮对话：出声即可（这条路径没有更好的兜底）
    console.error('[deliveries] 收尾写入失败 id=' + id + '：' + (e && e.message));
  }
}

// 死信落点：`state=failed` 的那些就是"没做完的外部调用"，由人看列表决定要不要用同一个键重发
export async function listDeliveries({ state = null, limit = 20 } = {}) {
  const lim = Math.min(MAX_LIST, Math.max(1, Number(limit) || 20));
  const rows = state
    ? await db.query('SELECT * FROM deliveries WHERE state=? ORDER BY id DESC LIMIT ?', [state, lim])
    : await db.query('SELECT * FROM deliveries ORDER BY id DESC LIMIT ?', [lim]);
  return rows.map((r) => ({
    id: String(r.id), conversationId: r.conversation_id, idemKey: r.idem_key, state: r.state,
    attempts: Number(r.attempts || 0), messageId: r.message_id, runId: r.run_id,
    lastError: r.last_error, lastErrorCode: r.last_error_code,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}
