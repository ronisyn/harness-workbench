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
import { db } from './db.js';

// 纯流式增量（think 思考块 / delta 正文增量）**不进账本**：它们是 UI 的实时糖，且最终文本已在
// messages.reasoning / messages.content 里（§7.3 双投影：原文始终可在 DB 查）。记账本的是**状态事件**。
// 这份名单是"刻意跳过"的唯一出处，夹具会锁住它——防止哪天顺手把状态事件也跳过了。
export const TRANSIENT_TYPES = new Set(['think', 'delta']);

let okCount = 0;
let failCount = 0;
let lastError = null;

/** 事件 → 行（纯函数，可测；payload 存**除序号/时间戳/类型之外**的原文——那三样各有一列，不重复存） */
export function eventRow(conversationId, ev) {
  const { seq, at, type, ...payload } = ev || {};
  return { conversation_id: conversationId || null, seq: Number(seq) || 0, type: String(type || 'unknown'), payload };
}

/**
 * 追加一条事件（fire-and-forget：不 await、不阻断调用方）。
 * @returns {boolean} 是否**尝试**写入（transient 类型返回 false —— 明确没写，不是失败）
 */
export function persistEvent(conversationId, ev) {
  if (!conversationId || !ev || !ev.type) return false;
  if (TRANSIENT_TYPES.has(ev.type)) return false;
  const row = eventRow(conversationId, ev);
  db.query('INSERT INTO events (conversation_id, seq, type, payload) VALUES (?,?,?,?)',
    [row.conversation_id, row.seq, row.type, JSON.stringify(row.payload)])
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

/** 按会话回放事件（升序）。afterId 用于增量读。 */
export async function readEvents(conversationId, { afterId = 0, limit = 2000 } = {}) {
  const rows = await db.query(
    'SELECT id, conversation_id, seq, type, payload, created_at FROM events WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?',
    [conversationId, Number(afterId) || 0, Math.min(20000, Math.max(1, Number(limit) || 2000))]);
  return rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, at: r.created_at, payload: typeof r.payload === 'string' ? JSON.parse(r.payload || '{}') : (r.payload || {}) }));
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
 * @param {{days?:number, limit?:number, dbc?:object}} opts dbc 仅夹具用（默认真库）
 * @returns {Promise<{archived:number, deleted:number}>}
 */
export async function archiveOldEvents({ days = EVENT_ARCHIVE_DAYS, limit = EVENT_ARCHIVE_LIMIT, dbc = db } = {}) {
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
