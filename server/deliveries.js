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
//
// 与存储的关系（v0.3 §7.1 ⑦ / §4.1「存储走接口」）：本模块**不再 import db**，只认识
// `storage.deliveries.*` 这五个中性方法（占位/按键查/抢重发/收尾/列死信）。SQL 已收进实现层，
// 于是"换存储实现"不再牵动这里的幂等语义；反过来，`jsonfile` 实现**没有**这条路 —— 它会显式抛
// "该实现不支持 外部投递记录"，而不是让重发悄悄变成新开一条（v0.3 §4.6 禁止静默降级）。
import crypto from 'node:crypto';
import { storage } from './storage/index.js';

export const IDEM_KEY_MAX = 200;   // 与 deliveries.idem_key VARCHAR(200) 对齐
export const MAX_LIST = 100;       // 与《接口规范》§六 的列表上限一致（默认 20）

// 请求指纹：同一个幂等键必须对应同一个请求体，否则拒绝（而不是拿旧结果糊弄过去）
export function requestHash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 64);
}

const rowOf = (store, accountId, idemKey) => store.deliveries.findByKey(accountId, idemKey);

// 开始一次投递。返回 { id, fresh } 或 { replay } 或 { conflict }
// `store` 是**夹具缝**（与 eventlog.js 的 `dbc` 同一用途）：默认就是按 RW_STORAGE 选出来的那个实现，
// 夹具塞一个别的实现进来，就能在不起服务、不连真库的情况下把"调用方 × 实现"的组合跑一遍
// （2026-09-16 的真实故障正是这个组合：带 Idempotency-Key 的一轮在 jsonfile 下直接 500）。
export async function beginDelivery({ accountId = null, conversationId = null, idemKey = null, hash = null, store = storage } = {}) {
  if (!idemKey) {
    const r = await store.deliveries.insert({ accountId, conversationId });
    return { id: r.id, fresh: true };
  }
  const decide = (row) => {
    if (row.state === 'succeeded') {
      // 回放"原始接受结果"：响应体由实现层按 JSON 列解析回来（解析不了即抛，不静默降级成空）
      return { replay: row.response || { messageId: row.messageId, runId: row.runId } };
    }
    if (row.state === 'failed') return { retry: true, id: row.id, attempts: Number(row.attempts || 1) };
    return { conflict: 'in_progress' };
  };
  const hit = await rowOf(store, accountId, idemKey);
  if (hit) {
    if (hash && hit.requestHash && hit.requestHash !== hash) return { conflict: 'key_reused' };
    const d = decide(hit);
    if (d.conflict) return d;
    if (d.replay) return d;
    // 上次失败 ⇒ 重发：占住它（attempts+1 并回到 running），这样"同一刻两个重发"只有一个能进来
    const claimed = await store.deliveries.claimRetry(hit.id, hash);
    if (claimed) return { id: hit.id, fresh: true, retry: true };
    return { conflict: 'in_progress' };
  }
  try {
    const r = await store.deliveries.insert({ accountId, conversationId, idemKey, hash });
    return { id: r.id, fresh: true };
  } catch (e) {
    // 并发：两个请求同时带着同一个新键进来 —— **唯一键**会让一个失败，那个就按"上一个还在跑"处理。
    // 判据认两个：MySQL 的 ER_DUP_ENTRY 码 / 它的消息文本（jsonfile 实现照同一形状抛，见 storage/jsonfile.js）。
    // 为什么不是只认消息文本：那等于把某个实现的措辞写进调用方；码才是契约，文本只是兼容既有写法。
    if (e && (e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(String(e.message)))) return { conflict: 'in_progress' };
    throw e;
  }
}

// 收尾：成功时把**接受结果**存下来（供回放），失败时留下错误（供人看与重放）
export async function finishDelivery(id, { state, messageId = null, runId = null, response = null, error = null, errorCode = null, store = storage } = {}) {
  if (!id) return;
  try {
    // 六个字段**每次都写全**（与迁移前那条 SET 列表逐字对应：成功时把上次的错误清空、失败时把结果置空），
    // 不做"只补差异"——部分更新在"重发后再次失败"这类场景会留下上一次的响应体，回放就会拿到过期结果。
    await store.deliveries.finish(id, {
      state, messageId, runId, response,
      lastError: error ? String(error).slice(0, 500) : null,
      lastErrorCode: errorCode,
    });
  } catch (e) {
    // 投递记录写失败不能反过来弄坏本轮对话：出声即可（这条路径没有更好的兜底）
    console.error('[deliveries] 收尾写入失败 id=' + id + '：' + (e && e.message));
  }
}

// 死信落点：`state=failed` 的那些就是"没做完的外部调用"，由人看列表决定要不要用同一个键重发
export async function listDeliveries({ state = null, limit = 20, store = storage } = {}) {
  const lim = Math.min(MAX_LIST, Math.max(1, Number(limit) || 20));
  const rows = await store.deliveries.list({ state, limit: lim });
  return rows.map((r) => ({
    id: String(r.id), conversationId: r.conversationId, idemKey: r.idemKey, state: r.state,
    attempts: Number(r.attempts || 0), messageId: r.messageId, runId: r.runId,
    lastError: r.lastError, lastErrorCode: r.lastErrorCode,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
}
