// server/storage/mysql.js —— 现行实现（本仓的 `dsh-storage-sqlite` 那一层的位置）：包在既有 `server/db.js` 之上
//
// 为什么是"包"而不是"重写"（v0.3 §7.1 ⑦ 的落地口径）：
//   `db.js` 里的连接池与那个 `{query, run}` 最小面是**成本已经付过**的东西 —— 池子参数、
//   死连接检测（keepAliveInitialDelay=120000 那一段）、可中断取连接（signal 中止时销毁连接）
//   全都是踩过坑写下来的。存储抽象要做的是"把调用方与介质解耦"，不是"再写一遍连库"。
//   所以本文件只做三件事：① 中性字段名 ↔ 列名的映射；② 命名方法的 SQL；
//   ③ 事务（借一条连接 + BEGIN/COMMIT/ROLLBACK）。连接与语句执行仍走 `db.query/db.run`。
//
// 为什么把这些 SQL 从调用方搬进来（`eventlog.js` 的 INSERT、`deliveries.js` 的那几条）：
//   SQL 是**介质的方言**。留在调用方，换实现时调用方就得跟着改 —— 那样的"抽象"是假的。
//   搬进来之后，调用方只认识 `storage.events.append(...)` 这样的中性方法（v0.3 §4.1「存储走接口」）。
//
// 本实现**没有**"不支持"的方法：契约里的每一项 MySQL 都能服务（对照 `jsonfile.js` 的显式抛错）。
import { db, pool } from '../db.js';
import { assertFields, STORAGE_INVALID_FIELD, PATCHABLE } from './index.js';
import { kbVisibleWhere } from '../knowledge.js';

const IMPL = 'mysql';
// 注：`PATCHABLE.knowledge` **不要**在模块顶层读成常量——本文件与 `storage/index.js` 是环（index → mysql → index），
// 顶层读会踩 TDZ（"Cannot access 'PATCHABLE' before initialization"）。用到时在函数体里读（那时两边都已求值完）。

/** 中性字段名 → 列名。表名也在这里（接口层因此完全不含表/列名）。 */
const COLS = {
  // 登录链（2026-09-16 扩）：列名与 `server/auth.js` 那几条查询逐字对应
  accounts: { username: 'username', passHash: 'pass_hash', role: 'role' },
  sessions: { token: 'token', accountId: 'account_id', expiresAt: 'expires_at' },
  conversations: {
    accountId: 'account_id', channel: 'channel', permission: 'permission', preset: 'preset', mode: 'mode',
    project: 'project', title: 'title', provider: 'provider', model: 'model', shellId: 'shell_id',
    faceFull: 'face_full',
  },
  messages: {
    conversationId: 'conversation_id', role: 'role', content: 'content', reasoning: 'reasoning',
    model: 'model', provider: 'provider', tokensIn: 'tokens_in', tokensOut: 'tokens_out',
  },
  toolCalls: {
    conversationId: 'conversation_id', messageId: 'message_id', toolName: 'tool_name', args: 'args',
    resultSummary: 'result_summary', resultBytes: 'result_bytes', durationMs: 'duration_ms',
    status: 'status', errorCode: 'error_code', shellId: 'shell_id',
  },
  agentRuns: {
    conversationId: 'conversation_id', accountId: 'account_id', goal: 'goal', status: 'status',
    reason: 'reason', rounds: 'rounds', lastStep: 'last_step', toolCounts: 'tool_counts',
  },
  events: { conversationId: 'conversation_id', seq: 'seq', type: 'type', payload: 'payload' },
  // 用量记账（2026-09-17 加写口）：列名与 `usage_stats` 的建表逐字对应。
  // `created_at` 不在映射里 —— 建表给的是 `DEFAULT NOW()`，介质自己盖时间戳（调用方不该伪造时间）。
  usage: {
    accountId: 'account_id', conversationId: 'conversation_id', agentRunId: 'agent_run_id', messageId: 'message_id',
    providerId: 'provider_id', modelId: 'model_id', tokensIn: 'tokens_in', tokensOut: 'tokens_out', cost: 'cost',
    durationMs: 'duration_ms', firstTokenMs: 'first_token_ms', cacheHit: 'cache_hit_tokens', cacheMiss: 'cache_miss_tokens',
    prefixSysHash: 'prefix_sys_hash', prefixToolsHash: 'prefix_tools_hash', shellId: 'shell_id', kind: 'kind',
  },
  // 审计账（2026-09-17 加写口）：列名与 `audit_log` 建表逐字对应；`created_at` 由库的 `DEFAULT NOW()` 盖。
  // `audit_log_archive`（90 天归档表）**不在**这里：归档是维护作业的读法+搬表，本轮只迁写口（如实登记）。
  audit: { accountId: 'account_id', action: 'action', detail: 'detail', shellId: 'shell_id', conversationId: 'conversation_id' },
  // 知识库（2026-09-17 加，**只读**：给 `kbsearch/like.js` 取记录用）。
  // 只映射检索层真正要用的列：`related_component` 是管理面的展示列，不在列里（同接口层的字段清单）。
  knowledge: {
    accountId: 'account_id', scope: 'scope', conversationId: 'conversation_id', shellId: 'shell_id',
    kind: 'kind', title: 'title', body: 'body', status: 'status', relatedComponent: 'related_component',
  },
  deliveries: {
    accountId: 'account_id', conversationId: 'conversation_id', idemKey: 'idem_key', requestHash: 'request_hash',
    state: 'state', messageId: 'message_id', runId: 'run_id', response: 'response_json',
    lastError: 'last_error', lastErrorCode: 'last_error_code', attempts: 'attempts',
  },
};
const TABLES = {
  conversations: 'conversations', messages: 'messages', toolCalls: 'tool_calls', settings: 'settings',
  agentRuns: 'agent_runs', events: 'events', deliveries: 'deliveries', accounts: 'accounts', sessions: 'sessions',
  knowledge: 'knowledge', usage: 'usage_stats', audit: 'audit_log',
};
/** JSON 列：写时 stringify、读时 parse（MySQL 的 JSON 列在新旧驱动下有时给对象、有时给字符串）。 */
const JSON_COLS = new Set(['payload', 'args', 'tool_counts', 'response_json', 'svalue']);
/** 需要打上介质时间戳的实体（`events` 不在此列：账本是只追加的事实，时间由库给、不随 update 变）。 */
const TOUCHED = new Set(['conversations', 'agent_runs', 'deliveries']);

const enc = (col, v) => (v === undefined ? null : (JSON_COLS.has(col) ? JSON.stringify(v) : v));
// 读时 parse，但**解析失败就原样返回**：`settings.svalue` 里有历史遗留的**纯字符串**（不是 JSON），
// 老代码路径本来就是把它们原样给出去的；这里若直接抛，整张设置页会 500（真机部署时实测到：
// `GET /api/settings` → SyntaxError: Unexpected non-whitespace character after JSON at position 4）。
const dec = (col, v) => {
  if (v === null || v === undefined) return v;
  if (!JSON_COLS.has(col) || typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** 行 → 中性记录（只映射契约里声明过的字段；调用方不该认识列名）。 */
function toRecord(entity, row, { at = false } = {}) {
  if (!row) return null;
  const out = {};
  // `sessions` 的主键是 token（没有 id 列）—— 所以 id 只在这一列真的存在时才带上
  if (Object.prototype.hasOwnProperty.call(row, 'id')) out.id = row.id;
  for (const [key, col] of Object.entries(COLS[entity])) {
    if (Object.prototype.hasOwnProperty.call(row, col)) out[key] = dec(col, row[col]);
  }
  if (at && Object.prototype.hasOwnProperty.call(row, 'created_at')) out.at = row.created_at;
  else if (Object.prototype.hasOwnProperty.call(row, 'created_at')) out.createdAt = row.created_at;
  if (Object.prototype.hasOwnProperty.call(row, 'updated_at')) out.updatedAt = row.updated_at;
  return out;
}

function insertOf(entity, fields) {
  const map = COLS[entity];
  const keys = Object.keys(fields);
  const cols = keys.map((k) => map[k]);
  return {
    sql: `INSERT INTO ${TABLES[entity]} (${cols.join(', ')}) VALUES (${keys.map(() => '?').join(',')})`,
    params: keys.map((k) => enc(map[k], fields[k])),
  };
}

function patchOf(entity, patch) {
  const map = COLS[entity];
  const keys = Object.keys(patch);
  const sets = keys.map((k) => `${map[k]}=?`);
  if (TOUCHED.has(TABLES[entity])) sets.push('updated_at=NOW()');
  return { sql: sets.join(', '), params: keys.map((k) => enc(map[k], patch[k])) };
}

/** LIMIT 只能内联（`execute` 不接受把 LIMIT 当占位符传字符串），所以先把它收敛成正整数。 */
function limitClause(limit) {
  const n = Number(limit);
  return Number.isInteger(n) && n > 0 ? ` LIMIT ${n}` : '';
}

/**
 * 造一份 MySQL 存储面。
 * @param {{db?:object, pool?:object}} [deps] 仅供夹具注入假对象（**不连真库**）；
 *        默认就是 `db.js` 的那两样 —— 夹具注入的正是同一层，所以测的是这份实现，不是另一个替身。
 */
export function createMysqlStorage(deps = {}) {
  const dbc = deps.db || db;
  const poolc = deps.pool || pool;

  const runnerOfPool = {
    many: (sql, params, opts) => dbc.query(sql, params, opts),
    one: async (sql, params, opts) => (await dbc.query(sql, params, opts))[0] || null,
    exec: (sql, params, opts) => dbc.run(sql, params, opts),
  };
  // 事务里的语句必须落在**同一条连接**上（否则 COMMIT 管不到它们）；语句形态与池子那份一一对应
  const runnerOfConn = (conn) => ({
    many: async (sql, params) => (await conn.query(sql, params))[0],
    one: async (sql, params) => ((await conn.query(sql, params))[0] || [])[0] || null,
    exec: async (sql, params) => (await conn.execute(sql, params))[0],
  });

  const api = makeApi(runnerOfPool);

  api.tx = async (fn) => {
    const conn = await poolc.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(makeApi(runnerOfConn(conn)));
      await conn.commit();
      return out;
    } catch (e) {
      // 回滚失败不掩盖真因：抛出去的必须是触发回滚的那个错误（否则排障时看到的是假现场）
      try { await conn.rollback(); } catch { /* ignore */ }
      throw e;
    } finally {
      try { conn.release(); } catch { /* ignore */ }
    }
  };

  return api;
}

function makeApi(r) {
  const api = {
    // ── 四类动词里的三个原生动词：给尚未迁移的调用方过渡用（SQL 留在调用方，import 先断掉 db）──
    query: (sql, params, opts) => r.many(sql, params, opts),
    one: (sql, params, opts) => r.one(sql, params, opts),
    run: (sql, params, opts) => r.exec(sql, params, opts),

    conversations: {
      async create(fields) {
        assertFields('conversations', fields);
        const { sql, params } = insertOf('conversations', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      async get(id) {
        return toRecord('conversations', await r.one('SELECT * FROM conversations WHERE id=? LIMIT 1', [id]));
      },
      async update(id, patch) {
        assertFields('conversations', patch, { partial: true });
        if (!Object.keys(patch).length) return;
        const { sql, params } = patchOf('conversations', patch);
        await r.exec(`UPDATE conversations SET ${sql} WHERE id=?`, [...params, id]);
      },
      /** 按 id **且按账号**取（`server/index.js:762` 那条：会话归属是边界，不是过滤偏好）。 */
      async findOwned(id, accountId) {
        return toRecord('conversations', await r.one('SELECT * FROM conversations WHERE id=? AND account_id=? LIMIT 1', [id, accountId]));
      },
      /**
       * 会话列表：`server/index.js:321` 那条，逐字保留它的条件 ——
       * "我的会话" ∪ "渠道侧无主会话（`channel != 'web' AND account_id IS NULL`，飞书/微信那些共享会话）"。
       * 注意：原查询还 `LEFT JOIN shells` 取 shell_key/shell_name（列表页的展示字段）；`shells` 不在本次
       * 接口范围内，这里不含它 —— 阶段 2 接线时那两个字段要么单独补读，要么把 shells 也纳入接口。
       */
      async listByAccount(accountId) {
        const rows = await r.many(
          'SELECT * FROM conversations WHERE account_id=? OR (channel != "web" AND account_id IS NULL) ORDER BY updated_at DESC',
          [accountId]);
        return rows.map((row) => toRecord('conversations', row));
      },
      /** 账号范围内的更新（`server/index.js:373`/`autotitle.js:44` 都是 `WHERE id=? AND account_id=?`）。 */
      async updateOwned(id, accountId, patch) {
        assertFields('conversations', patch, { partial: true });
        if (!Object.keys(patch).length) return;
        const { sql, params } = patchOf('conversations', patch);
        await r.exec(`UPDATE conversations SET ${sql} WHERE id=? AND account_id=?`, [...params, id, accountId]);
      },
      /** 只推进 updated_at（`server/index.js:889` 那条：落了一条消息之后"这个会话刚动过"）。 */
      async touch(id) {
        await r.exec('UPDATE conversations SET updated_at=NOW() WHERE id=?', [id]);
      },
      /** 会话在不在（`server/index.js:1147` 的孤儿守卫 `SELECT 1 FROM conversations WHERE id=?`）。 */
      async exists(id) {
        const row = await r.one('SELECT 1 AS ok FROM conversations WHERE id=? LIMIT 1', [id]);
        return Boolean(row);
      },
      /** 删会话（`DELETE /api/conversations/:id` 里那句 `DELETE FROM conversations WHERE id=?`，归属已在路由里判过）。 */
      async remove(id) {
        const res = await r.exec('DELETE FROM conversations WHERE id=?', [id]);
        return Number((res && res.affectedRows) || 0);
      },
      /**
       * 读**指定的那几列**（`server/index.js:779` 的 Web 只读会话读八列：`id, permission, mode, preset,
       * project, provider, model, shell_id, face_full`）。为什么不直接用 `get`：那会多读 content 之外的一堆列，
       * "读哪些列"是调用方的行为，接口不该替它改成另一种。未知键**当场抛**（拼错列名不许静默少一个字段）。
       */
      async getAs(id, keys) {
        const wanted = Array.isArray(keys) ? keys : [];
        const map = COLS.conversations;
        for (const k of wanted) if (!map[k]) throw new Error(`conversations 没有字段 ${k}（可选：${Object.keys(map).join(', ')}）`);
        if (!wanted.length) return null;
        const row = await r.one(`SELECT id, ${wanted.map((k) => map[k]).join(', ')} FROM conversations WHERE id=? LIMIT 1`, [id]);
        return toRecord('conversations', row);
      },
    },

    messages: {
      async append(fields) {
        assertFields('messages', fields);
        const { sql, params } = insertOf('messages', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      async list(conversationId, limit) {
        const rows = await r.many(`SELECT * FROM messages WHERE conversation_id=? ORDER BY id${limitClause(limit)}`, [conversationId]);
        return rows.map((row) => toRecord('messages', row));
      },
      /**
       * 最近 N 条（**倒序**，与调用点的 SQL 一致）：`autotitle.js:11`（只要 user/assistant，12 条）、
       * `server/tools/index.js:1327`（不过滤角色，300 条）。`roles` 给了就下推成 `role IN (...)`。
       */
      async recent(conversationId, { limit, roles = null } = {}) {
        const params = [conversationId];
        let where = 'conversation_id=?';
        if (Array.isArray(roles) && roles.length) {
          where += ` AND role IN (${roles.map(() => '?').join(',')})`;
          params.push(...roles);
        }
        const rows = await r.many(`SELECT * FROM messages WHERE ${where} ORDER BY id DESC${limitClause(limit)}`, params);
        return rows.map((row) => toRecord('messages', row));
      },
      /** 条数（`server/index.js:1460` 数用户轮次、`server/tools/index.js:1329` 数整会话）。role 可选。 */
      async count(conversationId, { role = null } = {}) {
        const where = role ? 'conversation_id=? AND role=?' : 'conversation_id=?';
        const params = role ? [conversationId, role] : [conversationId];
        const row = await r.one(`SELECT COUNT(*) c FROM messages WHERE ${where}`, params);
        return Number((row && row.c) || 0);
      },
      /**
       * **上下文口径**的历史读法（`server/index.js:928` 的 `/api/chat` 组装处、以及 HEADLESS/渠道两条入口）：
       * 只要 `id, role, content` 三个字段、按 id 升序、**全量不裁剪**（v0.3 §4.4.1 规则1：只追加 ⇒ 读全量）。
       * `content` 用 `?? ''` 与调用方那句 `String(m.content || '')` 同义（NULL 与 undefined 都成空串）——
       * 否则两个实现下（MySQL 的 NULL vs JSON 缺字段）模型看到的历史会差一点字节，前缀逐字节比对当场分叉。
       */
      async history(conversationId) {
        const rows = await r.many('SELECT id, role, content FROM messages WHERE conversation_id=? ORDER BY id', [conversationId]);
        return rows.map((row) => ({ id: row.id, role: row.role, content: row.content ?? '' }));
      },
      /**
       * 带**孤儿守卫**的追加（介质原语）：`INSERT … SELECT …,? FROM conversations WHERE id=?` ——
       * 会话不在就一行都不写、返回 `{ id: 0 }`（`insertId` 恒为 0，调用方据此跳过后续回填）。
       * 这是 `server/index.js:1370/1446` 与 `server/channels/run-turn.js:255` 三条语句的**逐字搬家**；
       * 为什么不让调用方"先查后写"：那不是同一条语句，删会话与落库并发时的行为会变（守卫当场作废）。
       */
      async guardAppend(fields) {
        assertFields('messages', fields);
        const map = COLS.messages;
        // 只写调用方真的给了的字段：`undefined` 一律不带（照它原来那句列少几个就是少几个）
        const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
        const cols = keys.map((k) => map[k]);
        const res = await r.exec(
          `INSERT INTO messages (${cols.join(', ')}) SELECT ${keys.map(() => '?').join(',')} FROM conversations WHERE id=?`,
          [...keys.map((k) => enc(map[k], fields[k])), fields.conversationId]);
        return { id: Number(res.insertId) || 0 };
      },
      /**
       * 按工具名数调用次数（`server/index.js:1005` 的 kb 注入判定：`COUNT(*) … tool_name IN ("kb_search","kb_add","kb_del")
       * AND created_at > NOW() - INTERVAL 7 DAY`）。窗口下推到 SQL；`tools` 空数组＝不查（`IN ()` 是非法 SQL）。
       * 只回一个数：这条查的用途是"够不够触发注入档位"，把明细带回来是另一种行为（老代码也只取 `c`）。
       */
      async countByTool(conversationId, { tools = [], days } = {}) {
        const list = (Array.isArray(tools) ? tools : []).filter((t) => t !== undefined && t !== null);
        if (!list.length) return 0;
        const params = [conversationId, ...list];
        let where = `conversation_id=? AND tool_name IN (${list.map(() => '?').join(',')})`;
        const d = Number(days);
        if (Number.isInteger(d) && d > 0) { where += ' AND created_at > NOW() - INTERVAL ? DAY'; params.push(d); }
        const row = await r.one(`SELECT COUNT(*) c FROM tool_calls WHERE ${where}`, params);
        return Number((row && row.c) || 0);
      },
      /** 清掉某会话的全部消息（`DELETE /api/conversations/:id` 的级联里那句 `DELETE FROM messages WHERE conversation_id=?`）。 */
      async removeByConversation(conversationId) {
        const res = await r.exec('DELETE FROM messages WHERE conversation_id=?', [conversationId]);
        return Number((res && res.affectedRows) || 0);
      },
    },

    toolCalls: {
      async append(fields) {
        assertFields('toolCalls', fields);
        const { sql, params } = insertOf('toolCalls', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      /**
       * 按会话升序读回（`server/index.js:441` 的导出那条：`SELECT … FROM tool_calls WHERE conversation_id=? ORDER BY id`）。
       */
      async list(conversationId, limit) {
        const rows = await r.many(`SELECT * FROM tool_calls WHERE conversation_id=? ORDER BY id${limitClause(limit)}`, [conversationId]);
        return rows.map((row) => toRecord('toolCalls', row));
      },
      /** 最近 N 条（**倒序**，与调用点 SQL 一致）：`/api/conversations/:id/toolcalls` 那条 `ORDER BY id DESC LIMIT 100`。 */
      async recent(conversationId, { limit } = {}) {
        const rows = await r.many(`SELECT * FROM tool_calls WHERE conversation_id=? ORDER BY id DESC${limitClause(limit)}`, [conversationId]);
        return rows.map((row) => toRecord('toolCalls', row));
      },
      /** 展示列形状（`/trace` 用；与那条既有 SQL 的列名逐字一致：`tool_name`/`duration_ms`/`created_at`）。 */
      async traceByConversation({ conversationId, limit = 200 } = {}) {
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? ` LIMIT ${n}` : ' LIMIT 200';
        return r.many('SELECT id, tool_name, status, duration_ms, created_at FROM tool_calls WHERE conversation_id=? ORDER BY id DESC' + lim, [conversationId]);
      },
      /**
       * 把本会话**尚未归属**的工具调用挂到刚落的这条 assistant 消息上（`server/index.js:1410` 的轨迹回填：
       * `UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL`）。
       * `message_id IS NULL` 是并发闸门的一部分（只认领没人认领过的），逐字保留。
       */
      async attachToMessage(conversationId, messageId) {
        const res = await r.exec('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [messageId, conversationId]);
        return Number((res && res.affectedRows) || 0);
      },
      /** 清掉某会话的全部工具调用（`DELETE /api/conversations/:id` 的级联里那句）。 */
      async removeByConversation(conversationId) {
        const res = await r.exec('DELETE FROM tool_calls WHERE conversation_id=?', [conversationId]);
        return Number((res && res.affectedRows) || 0);
      },
      /**
       * 失败率的**总数**（口径＝`scripts/failure-report.mjs`，2026-09-18 从 `selfeval/collect.js` 迁来）。
       * 边界（"什么算真实会话"）留在介质里：`conversation_id > 0` ＝ 真实会话；探针/孤儿（<=0 或 NULL）
       * 单独报数、**不混进分母**。两个实现必须给出同一条判据（契约用例同跑）。
       * 键名与迁移前**逐字一致**（`calls/fails/probe_calls/probe_fails`）：快照是给人看/给 M3 判据读的，
       * 换实现不该改报告的形状。
       */
      async failureTotals({ days = 7 } = {}) {
        const d = Number(days) > 0 ? Number(days) : 7;
        const row = await r.one(
          `SELECT COUNT(*) calls, COALESCE(SUM(status='fail'),0) fails,
                  (SELECT COUNT(*) FROM tool_calls WHERE conversation_id<=0 AND created_at > NOW() - INTERVAL ? DAY) probe_calls,
                  (SELECT COUNT(*) FROM tool_calls WHERE conversation_id<=0 AND status='fail' AND created_at > NOW() - INTERVAL ? DAY) probe_fails
             FROM tool_calls WHERE conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY`, [d, d, d]);
        const g = (k) => Number((row && row[k]) || 0);
        return { calls: g('calls'), fails: g('fails'), probe_calls: g('probe_calls'), probe_fails: g('probe_fails') };
      },
      /** 失败按 `error_code` 汇总（`{code, n, tools}`；无码/存量行归到一个显式档，不静默丢）。 */
      async failByCode({ days = 7 } = {}) {
        const d = Number(days) > 0 ? Number(days) : 7;
        const rows = await r.many(
          `SELECT COALESCE(error_code,'(无码/存量行)') code, COUNT(*) n, COUNT(DISTINCT tool_name) tools
             FROM tool_calls WHERE status='fail' AND conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY
            GROUP BY code ORDER BY n DESC`, [d]);
        return rows.map((row) => ({ code: row.code, n: Number(row.n || 0), tools: Number(row.tools || 0) }));
      },
      /** 失败按"工具 × 错误码"汇总（前 N 条）。 */
      async failByTool({ days = 7, limit = 20 } = {}) {
        const d = Number(days) > 0 ? Number(days) : 7;
        const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
        const rows = await r.many(
          `SELECT tool_name tool, COALESCE(error_code,'(无码)') code, COUNT(*) n
             FROM tool_calls WHERE status='fail' AND conversation_id > 0 AND created_at > NOW() - INTERVAL ? DAY
            GROUP BY tool_name, code ORDER BY n DESC LIMIT ${n}`, [d]);
        return rows.map((row) => ({ tool: row.tool, code: row.code, n: Number(row.n || 0) }));
      },
    },

    settings: {
      async get(key) {
        const row = await r.one('SELECT svalue FROM settings WHERE skey=? LIMIT 1', [key]);
        if (!row) return null;
        return dec('svalue', row.svalue);
      },
      async set(key, value) {
        await r.exec(
          'INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()',
          [key, JSON.stringify(value)],
        );
      },
      /** 全量设置（`server/index.js:1745` 的设置页读取）→ `{skey: value}`（值按 JSON 解析回来）。 */
      async all() {
        const rows = await r.many('SELECT skey, svalue FROM settings');
        return Object.fromEntries(rows.map((row) => [row.skey, dec('svalue', row.svalue)]));
      },
      /**
       * 按键批量读（`server/agent.js:173` 一次取 17 个护栏键、`server/tools/hooks.js:465` 取策略键）
       * —— 存在的键才出现在返回对象里，缺的**不补 null**（调用方本来就按"没这个键"兜默认值）。
       * 空数组＝不查（`IN ()` 是非法 SQL；也不需要为了空集合跑一趟）。
       */
      async getMany(keys) {
        const list = Array.isArray(keys) ? keys.filter((k) => k !== undefined && k !== null) : [];
        if (!list.length) return {};
        const rows = await r.many(`SELECT skey, svalue FROM settings WHERE skey IN (${list.map(() => '?').join(',')})`, list);
        return Object.fromEntries(rows.map((row) => [row.skey, dec('svalue', row.svalue)]));
      },
    },

    // ── 登录链：账号（`server/auth.js:15/17/23/57/59` 五条查询）──────────────────────────────────
    accounts: {
      /** `SELECT … FROM accounts WHERE username=?`：login / ensureAdmin / 注册查重都用它（username 有唯一键）。 */
      async findByUsername(username) {
        return toRecord('accounts', await r.one('SELECT * FROM accounts WHERE username=? LIMIT 1', [username]));
      },
      /** 建账号（`auth.js:17` 管理员、`auth.js:59` 普通账号）：username 唯一键冲突即抛（照 MySQL 的形状）。 */
      async create(fields) {
        assertFields('accounts', fields);
        // role 显式补默认值（与建表那句 `role VARCHAR(16) DEFAULT 'user'` 同值）：不靠库默认值，
        // 两个实现才可能逐字一致（jsonfile 没有"表默认值"这种东西）
        const { sql, params } = insertOf('accounts', { role: 'user', ...fields });
        return { id: (await r.exec(sql, params)).insertId };
      },
    },

    // ── 登录链：会话（`server/auth.js:29/38/45` 三条查询）────────────────────────────────────────
    sessions: {
      /**
       * 建会话（与 `auth.js:29` 逐字同形）：**到期时间由介质算** —— MySQL 用库的 `NOW()`（应用与库的时钟
       * 可能不一致，这一点是本仓既有取舍，见 eventlog 归档那条"阈值用库的 NOW() 比较"）。
       */
      async create({ token, accountId, days }) {
        await r.exec('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(),DATE_ADD(NOW(), INTERVAL ? DAY))',
          [token, accountId, days]);
      },
      /**
       * 校验并取回账号（`auth.js:38` 那条 JOIN，逐字同形）：**过期条件在 SQL 里**（`expires_at > NOW()`），
       * 所以"过期"这个判据只有一处、且用的是库的时钟。查不到/已过期都返回 null（调用方据此回 401 TOKEN_EXPIRED）。
       */
      async findValid(token) {
        const row = await r.one(
          'SELECT a.id, a.username, a.role FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at > NOW() LIMIT 1',
          [token]);
        return row ? { id: row.id, username: row.username, role: row.role } : null;
      },
      /** 退出登录（`auth.js:45`）。幂等：token 不存在＝什么都不做（DELETE 影响 0 行）。 */
      async remove(token) {
        await r.exec('DELETE FROM sessions WHERE token=?', [token]);
      },
    },

    agentRuns: {
      async create(fields) {
        assertFields('agentRuns', fields);
        const { sql, params } = insertOf('agentRuns', { status: 'running', ...fields });
        return { id: (await r.exec(sql, params)).insertId };
      },
      async getLatest(conversationId) {
        return toRecord('agentRuns', await r.one('SELECT * FROM agent_runs WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversationId]));
      },
      async update(id, patch) {
        assertFields('agentRuns', patch, { partial: true });
        if (!Object.keys(patch).length) return;
        const { sql, params } = patchOf('agentRuns', patch);
        await r.exec(`UPDATE agent_runs SET ${sql} WHERE id=?`, [...params, id]);
      },
    },

    events: {
      // 账本只追加（`eventlog.js` 的三条口径之一）：这里只有 append/read，没有 update/delete。
      // 语句与迁移前**逐字一致**（原来是 eventlog.js 里的那条），避免"搬家顺手改了行为"。
      async append(fields) {
        assertFields('events', fields);
        const { conversationId = null, seq = 0, type, payload } = fields;
        return { id: (await r.exec('INSERT INTO events (conversation_id, seq, type, payload) VALUES (?,?,?,?)',
          [conversationId, seq, type, JSON.stringify(payload ?? {})])).insertId };
      },
      async read(conversationId, { afterId = 0, limit } = {}) {
        const rows = await r.many(
          `SELECT id, conversation_id, seq, type, payload, created_at FROM events WHERE conversation_id=? AND id>? ORDER BY id${limitClause(limit)}`,
          [conversationId, Number(afterId) || 0]);
        return rows.map((row) => toRecord('events', row, { at: true }));
      },
      /**
       * 把早于 `before` 天的事件搬进 `events_archive`（2026-09-16 从 `eventlog.js` 搬到这里：
       * 这是**介质机制**，不是领域策略 —— 天数/批量上限/要不要跑，仍由 `eventlog.js` 定）。
       * 三条硬约束（顺序即安全性，逐字沿用原实现）：
       *   ① **先插入归档表、插入成功才删原表** —— 删之前那批行必须已经躺在 `events_archive` 里；
       *   ② 失败**宁可少归档也不许先删**：任何一步出错就原样抛出，events 一行不动；
       *   ③ 只删**刚才搬过的那批 id**（不是"再按时间条件删一遍"——条件式删法在插入失败时会删掉没搬走的行）。
       * @returns {Promise<{archived:number, deleted:number}>} 幂等：重复跑不会再搬同一批（第二次 0/0）
       */
      async archiveBatch({ before, limit = 5000 } = {}) {
        const d = Number(before) > 0 ? Number(before) : 90;
        const n = Math.min(20000, Math.max(1, Number(limit) || 5000));
        const rows = await r.many('SELECT id FROM events WHERE created_at < NOW() - INTERVAL ? DAY ORDER BY id LIMIT ?', [d, n]);
        if (!rows.length) return { archived: 0, deleted: 0 };
        const ids = rows.map((row) => row.id);
        const ph = ids.map(() => '?').join(',');
        await r.many(`INSERT INTO events_archive (id, conversation_id, seq, type, payload, created_at) SELECT id, conversation_id, seq, type, payload, created_at FROM events WHERE id IN (${ph})`, ids);
        const res = await r.exec(`DELETE FROM events WHERE id IN (${ph})`, ids);
        return { archived: ids.length, deleted: Number((res && res.affectedRows) || 0) };
      },
    },

    deliveries: (() => {
      const F = 'deliveries';
      const pick = (row) => toRecord(F, row);
      return {
        /** 占位一行。有幂等键时走六列形态（键+指纹），没有时走四列形态 —— 与迁移前逐字一致。 */
        async insert({ accountId = null, conversationId = null, idemKey = null, hash = null } = {}) {
          if (!idemKey) {
            const r2 = await r.exec('INSERT INTO deliveries (account_id, conversation_id, state, attempts) VALUES (?,?,?,?)',
              [accountId, conversationId, 'running', 1]);
            return { id: r2.insertId };
          }
          const r1 = await r.exec('INSERT INTO deliveries (account_id, conversation_id, idem_key, request_hash, state, attempts) VALUES (?,?,?,?,?,?)',
            [accountId, conversationId, idemKey, hash, 'running', 1]);
          return { id: r1.insertId };
        },
        async findByKey(accountId, idemKey) {
          return pick(await r.one('SELECT * FROM deliveries WHERE account_id <=> ? AND idem_key = ? LIMIT 1', [accountId, idemKey]));
        },
        /** 上次失败 ⇒ 抢回 running（attempts+1）。`WHERE state='failed'` 是并发闸门：同一刻两个重发只有一个能进来。 */
        async claimRetry(id, hash) {
          const res = await r.exec(
            'UPDATE deliveries SET state=?, attempts=attempts+1, request_hash=COALESCE(?, request_hash), updated_at=NOW() WHERE id=? AND state=?',
            ['running', hash, id, 'failed']);
          return Number(res && res.affectedRows) === 1;
        },
        async finish(id, patch) {
          assertFields(F, patch, { partial: true });
          if (!Object.keys(patch).length) return;
          const { sql, params } = patchOf(F, patch);
          await r.exec(`UPDATE deliveries SET ${sql} WHERE id=?`, [...params, id]);
        },
        async list({ state = null, limit = 20, accountId } = {}) {
          // 默认 20 不是这里新造的值：调用方 `deliveries.js` 的默认就是它（与《接口规范》§六 的列表上限一致）。
          // `state`/`accountId` 都是**可选**过滤：给了就下推到 SQL 的 WHERE（而不是取回来再在内存里筛 ——
          // 那样 LIMIT 会先把别人的行占满窗口，调用方反而看不到自己最近的行）。
          const where = [];
          const params = [];
          if (state) { where.push('state=?'); params.push(state); }
          if (accountId !== undefined && accountId !== null) { where.push('account_id=?'); params.push(accountId); }
          const sql = `SELECT * FROM deliveries${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC${limitClause(limit)}`;
          const rows = await r.many(sql, params);
          return rows.map(pick);
        },
      };
    })(),
    /**
     * 知识库：给"第二个检索实现"（`server/kbsearch/like.js`）取记录用，**本实现只读**（没有写动词）。
     * 为什么把过滤下推到 SQL：`kb_search` 的可见范围与状态守卫由检索层判（`kbVisibleWhere`），
     * 这里只按账号收口——**不替调用方发明可见性口径**（那是同一件事的第二份出处）。
     * 排序 `id ASC` 是"确定性"而不是"排序口径"：`like.js` 自己会重排（命中次数 → id DESC），
     * 而这里给一个稳定顺序，免得"同一次查询两次结果不同"这种事出现在账本/夹具里。
     */
    knowledge: {
      async all(accountId) {
        const rows = await r.many('SELECT * FROM knowledge WHERE account_id=? ORDER BY id ASC', [accountId]);
        return rows.map((row) => toRecord('knowledge', row));
      },
      /** 追加一条知识（`kb_add` 的新增分支 / 沉淀写点）。 */
      async append(fields) {
        assertFields('knowledge', fields);
        const { sql, params } = insertOf('knowledge', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      /**
       * 修订一条（`kb_add` 的覆盖分支、管理面的状态修订）：**只认白名单里的字段**，别的当场报错
       * （`accountId/scope/...` 是这条记忆的身份，从"修订"这条路改它们等于换条目）。
       * `touch:true` ⇒ 同时把 `created_at` 刷成介质当前时间：这是 `kb_add` 覆盖时那句
       * `created_at=NOW()` 的逐字语义（A6：覆盖视为"最新当前事实"）。
       */
      async update(id, patch = {}) {
        const keys = Object.keys(patch).filter((k) => k !== 'touch');
        for (const k of keys) {
          if (!PATCHABLE.knowledge.includes(k)) {
            const e = new Error(`未知字段 knowledge.${k}（可修订的只有：${PATCHABLE.knowledge.join(', ')}）`);
            e.code = STORAGE_INVALID_FIELD;
            throw e;
          }
        }
        const sets = keys.map((k) => `${COLS.knowledge[k]}=?`);
        const params = keys.map((k) => enc(COLS.knowledge[k], patch[k]));
        if (patch.touch) sets.push('created_at=NOW()');
        if (!sets.length) return { updated: false };
        const res = await r.exec(`UPDATE knowledge SET ${sets.join(', ')} WHERE id=?`, [...params, id]);
        return { updated: res.affectedRows > 0 };
      },
      /**
       * 同名条目（`kb_add` 的去重口径，逐字）：同账号 + 同 scope + 同壳 + 同会话 + 同 kind + 同 title，
       * 取最新一条。`<=>` 是 NULL 安全等（global 条目的 `conversation_id`/`shell_id` 就是 NULL）。
       */
      async findByTitle({ accountId, scope, conversationId = null, shellId = null, kind = null, title } = {}) {
        const row = await r.one(
          'SELECT * FROM knowledge WHERE account_id=? AND scope=? AND shell_id<=>? AND conversation_id<=>? AND kind=? AND title=? ORDER BY id DESC LIMIT 1',
          [accountId, scope, shellId, conversationId, kind, title]);
        return toRecord('knowledge', row);
      },
      /** 按 id + 账号删（管理面的删除口径：至少保证"不许删到别人的"）。 */
      async remove(id, { accountId } = {}) {
        const res = await r.exec('DELETE FROM knowledge WHERE id=? AND account_id=?', [Number(id) || 0, accountId]);
        return { removed: res.affectedRows > 0 };
      },
      /**
       * 按**会话可见范围**删（`kb_del` 的口径）：账号 + (global ∪ 本壳 shell ∪ 本会话 conv) + 仅 active。
       * 可见范围的 SQL 片段只有一份出处（`server/knowledge.js` 的 `kbVisibleWhere`，注入/检索/删除共用），
       * 所以这里**不重写条件**，直接引用它。
       */
      async removeVisible(id, { accountId, shellId = null, conversationId = null } = {}) {
        const v = kbVisibleWhere({ accountId, shellId, conversationId, includeConv: true });
        const res = await r.exec(`DELETE FROM knowledge WHERE id=? AND ${v.where}`, [Number(id) || 0, ...v.params]);
        return { removed: res.affectedRows > 0 };
      },
      /**
       * **管理视图的展示列**（`GET /api/knowledge` 的两个分支共用）：返回的行**逐字沿用改造前那条 SQL 的
       * 列名**（`shell_key` / `body_preview` / `related_component` / `created_at`）——前端 `web/dist`
       * 读的就是这些名字，"换实现不改调用方"在这里也意味着**不改前端**。
       * `shell_key` 由介质自己 join（MySQL 有 shells 表；JSON 侧没有 ⇒ 如实 null，见那里的注释）。
       * `ids` 给了就按 id 取（带 `q` 的分支：检索层判完命中，这里只补展示列）。`limit` 内联（与既有路线一致）。
       */
      async adminList({ accountId, scope = null, shellId = null, kind = null, status = null, ids = null, limit = 500 } = {}) {
        const conds = ['k.account_id=?']; const params = [accountId];
        if (scope) { conds.push('k.scope=?'); params.push(scope); }
        if (scope === 'shell' && shellId) { conds.push('k.shell_id=?'); params.push(shellId); }
        if (kind) { conds.push('k.kind=?'); params.push(kind); }
        if (status) { conds.push('k.status=?'); params.push(status); }
        if (Array.isArray(ids)) {
          if (!ids.length) return [];
          conds.push(`k.id IN (${ids.map(() => '?').join(',')})`);
          params.push(...ids.map(Number));
        }
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? ` LIMIT ${n}` : '';
        return r.many(
          `SELECT k.id, k.scope, k.shell_id, s.skey AS shell_key, k.conversation_id, k.kind, k.status, k.related_component, k.title, LEFT(k.body, 200) AS body_preview, k.created_at
           FROM knowledge k LEFT JOIN shells s ON s.id = k.shell_id
           WHERE ${conds.join(' AND ')} ORDER BY k.id DESC${lim}`, params);
      },
      /**
       * **会话可见范围**下的条目（`/api/chat` 每轮的知识注入读法）：账号 + (global ∪ 本壳 shell ∪ 本会话 conv)
       * + 仅 active，`id DESC LIMIT n`。可见范围的 SQL 片段只有一份出处（`kbVisibleWhere`），这里直接引用它 ——
       * 与 `removeVisible` 同源；不迁这一处的话，干净机器上"记得的东西"永远不会被注入（失败还被 catch 吞掉）。
       */
      async visibleList({ accountId, shellId = null, conversationId = null, limit = 12 } = {}) {
        const v = kbVisibleWhere({ accountId, shellId, conversationId, includeConv: true });
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? ` LIMIT ${n}` : '';
        return r.many(`SELECT id, scope, title, body FROM knowledge WHERE ${v.where} ORDER BY id DESC${lim}`, v.params);
      },
      /** 账号边界内的修订（管理面 `PATCH /api/knowledge/:id`）：白名单＝`knowledgeOwned`，改不到别人的行。 */      async updateOwned(id, accountId, patch = {}) {
        const keys = Object.keys(patch).filter((k) => k !== 'touch');
        for (const k of keys) {
          if (!PATCHABLE.knowledgeOwned.includes(k)) {
            const e = new Error(`未知字段 knowledge.${k}（管理面可改的只有：${PATCHABLE.knowledgeOwned.join(', ')}）`);
            e.code = STORAGE_INVALID_FIELD;
            throw e;
          }
        }
        if (!keys.length) return { updated: false };
        const sets = keys.map((k) => `${COLS.knowledge[k]}=?`);
        const params = keys.map((k) => enc(COLS.knowledge[k], patch[k]));
        const res = await r.exec(`UPDATE knowledge SET ${sets.join(', ')} WHERE id=? AND account_id=?`, [...params, Number(id) || 0, accountId]);
        return { updated: res.affectedRows > 0 };
      },
    },

    /**
     * 用量记账（v0.3 §4.6「预算与审计：本地兜底」的写口）：逐轮 / 折叠 / 标题 / 摘要 / 预热五处共用。
     * `created_at` 由建表的 `DEFAULT NOW()` 盖（调用方不给时间）；`kind` 是必需字段（见接口层的理由）。
     */
    usage: {
      async append(fields) {
        assertFields('usage', fields);
        const { sql, params } = insertOf('usage', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      /** 某会话的用量合计（`/trace` 的 usage 段）：形状与调用点原来那条聚合查询逐字一致。 */
      async summaryByConversation(conversationId) {
        const row = await r.one('SELECT COUNT(*) n, COALESCE(SUM(cost),0) cost, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout FROM usage_stats WHERE conversation_id=?', [conversationId]);
        const u = row || {};
        return { calls: Number(u.n || 0), cost: Number(u.cost || 0), tokensIn: Number(u.tin || 0), tokensOut: Number(u.tout || 0) };
      },
      /** 某账号的**成本口径三件套**（C3 仪表）：总花费 + 去重后的执行次数与会话数。形状与既有那条聚合逐字一致。 */
      async summaryByAccount(accountId) {
        const row = await r.one('SELECT COALESCE(SUM(cost),0) total, COUNT(DISTINCT agent_run_id) runs, COUNT(DISTINCT conversation_id) convs FROM usage_stats WHERE account_id=?', [accountId]);
        const u = row || {};
        return { total: Number(u.total || 0), runs: Number(u.runs || 0), convs: Number(u.convs || 0) };
      },
      /**
       * **逐轮读数**（C1/C2 的来源；裁定 A 的第二次读法）：本账号近 N 天、`kind='round'`、且落在
       * `conversationIds` 这批会话里的行，只要 `{h, m, cid}` 三列（命中/未命中/会话）。
       * `conversationIds` 是**归属解析的结果**（`cohort.realConversationIds`）——介质不负责判归属，
       * 只按 id 列表过滤；给了空数组 ⇒ 空结果（不是"没有条件"）。
       */
      async roundRowsByAccount({ accountId, days = 7, conversationIds = null } = {}) {
        const params = [accountId, Number(days) || 7];
        let extra = '';
        if (Array.isArray(conversationIds)) {
          if (!conversationIds.length) return [];
          extra = ` AND u.conversation_id IN (${conversationIds.map(() => '?').join(',')})`;
          params.push(...conversationIds.map(Number));
        }
        return r.many(`SELECT u.cache_hit_tokens h, u.cache_miss_tokens m, u.conversation_id cid
             FROM usage_stats u
            WHERE u.account_id=? AND u.kind='round' AND u.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)${extra}`,
        params);
      },
      /**
       * **按天**的逐轮读数（仪表那条 30 天线）：`[{d, hit, miss, n}]`，`d` 是 `YYYY-MM-DD`。
       * 形状与调用点原来那条 `GROUP BY DATE(created_at)` 逐字一致；日期口径＝**介质自己的本地日期**
       * （MySQL 是会话时区、JSON 是进程时区）——这一点沿用改造前的口径，不改判据。
       */
      async dailyByAccount({ accountId, days = 30 } = {}) {
        // `DATE_FORMAT(...)` 而不是 `DATE(...)`：后者的返回值经 mysql2 是 **Date 对象**，序列化出去是
        //   "Mon Sep 14 2026 00:00:00 GMT+0800"，而调用方（仪表）按 `YYYY-MM-DD` 找"今天那一行" ⇒ 永远找不到
        //   （实测：`daily` 里明明有今天的数据，而 `todayHit/todayMiss` 恒为 0）。接口的契约写的就是
        //   "`d` 是 `YYYY-MM-DD`"，这里让 MySQL 侧真的按契约给 —— 两个介质形状一致，那条对账也才成立。
        return r.many(`SELECT DATE_FORMAT(created_at, '%Y-%m-%d') d, COALESCE(SUM(cache_hit_tokens),0) hit, COALESCE(SUM(cache_miss_tokens),0) miss, COUNT(*) n
             FROM usage_stats u WHERE u.account_id=? AND u.kind='round' AND u.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') ORDER BY d`, [accountId, Number(days) || 30]);
      },
    },

    /**
     * 审计账（v0.3 §4.6「预算与审计：本地兜底」的写口）：全仓 62 处写口共用这一条。
     * 只写调用方给了的列（三列 / 五列两种形状各自保持原样）；`created_at` 由建表的 `DEFAULT NOW()` 盖。
     */
    audit: {
      async append(fields) {
        assertFields('audit', fields);
        const { sql, params } = insertOf('audit', fields);
        return { id: (await r.exec(sql, params)).insertId };
      },
      /**
       * 某一会话某动作的**最后一行说明**（跨轮前缀账的对照读法，每一轮都要读）。
       * 形状逐字沿用调用点原来那条 SQL（`ORDER BY id DESC LIMIT 1`）——换实现不改调用方。
       */
      async lastDetail({ conversationId, action } = {}) {
        const row = await r.one('SELECT detail FROM audit_log WHERE conversation_id=? AND action=? ORDER BY id DESC LIMIT 1',
          [conversationId, action]);
        return row ? row.detail : null;
      },
      /**
       * 某动作的**最后一行**（`{createdAt, detail}`；没有则 null）—— C4 仪表要报"最近一次非预期失效是什么时候、
       * 什么原因"（`/api/agent/capabilities`）。与 `lastDetail` 分开是因为那条带会话维（跨轮前缀账专用）。
       */
      async lastByAction(action) {
        const row = await r.one('SELECT created_at, detail FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1', [action]);
        return row ? { createdAt: row.created_at, detail: row.detail } : null;
      },
      /**
       * 各动作的条数（C4/C5 仪表）：`actions` 给了就只数这几个（`IN (...)`），不给数全部。
       * 返回 `[{action, n}]`——形状与调用点原来那条 `GROUP BY` 查询逐字一致。
       */
      async countByAction({ actions = null } = {}) {
        if (Array.isArray(actions) && !actions.length) return [];
        const where = Array.isArray(actions) ? ` WHERE action IN (${actions.map(() => '?').join(',')})` : '';
        const rows = await r.many(`SELECT action, COUNT(*) n FROM audit_log${where} GROUP BY action`, actions || []);
        return rows.map((row) => ({ action: row.action, n: Number(row.n || 0) }));
      },
      /**
       * 某动作的**首词分布**（C5 豁免原因：`prefix:exempt` 的 detail 形如 `first-round …`）：
       * `SUBSTRING_INDEX(detail,' ',1)` 是 MySQL 的"取第一个空格前那段"，返回 `[{reason, n}]`（多的在前）。
       * 2026-09-18：加**可选**时间窗（遥测采集要 7 天窗；不传＝全量，既有调用方一个字不用改）。
       */
      async countByFirstToken(action, { days = null } = {}) {
        const d = Number(days) > 0 ? Number(days) : null;
        const win = d ? ' AND created_at > NOW() - INTERVAL ? DAY' : '';
        const rows = await r.many(`SELECT SUBSTRING_INDEX(detail, ' ', 1) r, COUNT(*) n FROM audit_log WHERE action=?${win} GROUP BY r ORDER BY n DESC`,
          d ? [action, d] : [action]);
        return rows.map((row) => ({ reason: row.r, n: Number(row.n || 0) }));
      },
      /**
       * **按会话回溯**（`GET /api/conversations/:id/trace`）：挂在该会话上的行 **＋** detail 里带 `conv=<id>`
       * 的行（后者是那些"没有会话归属、但在说明里点了会话"的动作——口径逐字沿用改造前那条 SQL）。
       */
      async traceByConversation({ conversationId, limit = 200 } = {}) {
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? ` LIMIT ${n}` : ' LIMIT 200';
        return r.many('SELECT id, action, detail, shell_id, created_at FROM audit_log WHERE conversation_id=? OR detail LIKE ? ORDER BY id DESC' + lim,
          [conversationId, '%conv=' + conversationId + '%']);
      },
      /**
       * **审计管理视图**（`GET /api/audit`，`archived=0` 那条活表分支）：条件串与列名逐字沿用改造前那条 SQL
       * （`conds` 由调用方按既有口径拼好传进来：`1=1` 起头 + q/天数/会话/壳/分类）。返回**未脱敏**的行，
       * 脱敏留给路由（它原来就在出口做 `redactSecrets`——那是展示层口径，不属介质）。
       * 归档表那半边**不在本方法里**（`archived=1|all` 要两表合并，等 `events/audit` 归档口径拍板后一起做）。
       */
      async adminList({ conds = ['1=1'], params = [], limit = 100 } = {}) {
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? n : 100;
        return r.many(`SELECT id, account_id, action, detail, conversation_id, shell_id, created_at FROM audit_log WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`, [...params, lim]);
      },
      /**
       * 某动作前缀涉及过哪些会话（`prefix:%` ⇒ 落过前缀账的会话）——**裁定 A 的两次读法**里那一半：
       * 归属判据仍只有 `cohort.js` 一份，这里只回答"账本里出现过哪些会话 id"。
       * `conversation_id IS NOT NULL`：无主行（孤儿）不是会话，不能进候选名单。
       */
      async conversationIdsByActionPrefix(prefix) {
        const rows = await r.many('SELECT DISTINCT conversation_id cid FROM audit_log WHERE action LIKE ? AND conversation_id IS NOT NULL', [String(prefix) + '%']);
        return rows.map((row) => Number(row.cid));
      },
      /**
       * 把早于 `before` 天的审计搬进 `audit_log_archive`（2026-09-16 从 `index.js` 的 `archiveAudit` 搬来：
       * 这是介质机制；天数/批量/要不要跑由调用方定）。顺序与事件归档同一条口径：
       * **先插入归档表、插入成功才删原表**；只删刚搬过的那批 id；任一步失败原样抛出（宁可少归档也不先删）。
       * @returns {Promise<{moved:number}>} 幂等：重复跑不会再搬同一批（第二次 0）
       */
      async archiveBatch({ before, limit = 5000 } = {}) {
        const d = Number(before) > 0 ? Number(before) : 90;
        const n = Math.min(20000, Math.max(1, Number(limit) || 5000));
        const rows = await r.many('SELECT id FROM audit_log WHERE created_at < NOW() - INTERVAL ? DAY LIMIT ?', [d, n]);
        if (!rows.length) return { moved: 0 };
        const ids = rows.map((row) => row.id);
        const ph = ids.map(() => '?').join(',');
        await r.many(`INSERT INTO audit_log_archive (account_id, action, detail, conversation_id, shell_id, created_at)
    SELECT account_id, action, detail, conversation_id, shell_id, created_at FROM audit_log WHERE id IN (${ph})`, ids);
        await r.exec(`DELETE FROM audit_log WHERE id IN (${ph})`, ids);
        return { moved: ids.length };
      },
      /**
       * 归档前后各有多少行、最早一行是什么时候（`GET /api/audit/archive-stats`）：两表各一条聚合，
       * 形状逐字沿用调用点原来那两条 SQL。**只报事实**——"归档表里有 0 行"在有归档能力的介质上
       * 就是"还没归档"，在没有归档能力的介质上由 `capabilities().archive=false` 说明，两者不混淆。
       */
      async archiveStats() {
        const [cur] = await r.many('SELECT COUNT(*) c, MIN(created_at) oldest FROM audit_log');
        const [arc] = await r.many('SELECT COUNT(*) c, MIN(created_at) oldest FROM audit_log_archive');
        const rec = (row) => ({ rows: Number((row && row.c) || 0), oldest: (row && row.oldest) || null });
        return { current: rec(cur), archived: rec(arc) };
      },
      /**
       * **按动作前缀**计数（遥测采集那一档：`action LIKE 'prefix:%'`，可带时间窗）——
       * 2026-09-18 从 `selfeval/collect.js` 的 `collectLedger` 迁来；`actions` 的形状与那条 SQL 逐字一致
       * （`[{action, n}]`，多的在前由调用方决定，这里不排序——原来那条也没排序）。
       */
      async countByActionPrefix(prefix, { days = null } = {}) {
        const d = Number(days) > 0 ? Number(days) : null;
        const win = d ? ' AND created_at > NOW() - INTERVAL ? DAY' : '';
        const rows = await r.many(`SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE ?${win} GROUP BY action`,
          d ? [String(prefix) + '%', d] : [String(prefix) + '%']);
        return rows.map((row) => ({ action: row.action, n: Number(row.n || 0) }));
      },
      /**
       * **最近若干条**（可限定"前缀 + 指定动作集合"）：列名别名 `cid`/`at` **逐字沿用**调用点原来那条 SQL
       * （`conversation_id cid, created_at at`）——换实现不改快照的形状。
       */
      async recentByActions({ prefix = null, actions = [], days = null, limit = 20 } = {}) {
        const conds = [];
        const params = [];
        if (prefix) { conds.push('action LIKE ?'); params.push(String(prefix) + '%'); }
        if (Array.isArray(actions) && actions.length) { conds.push(`action IN (${actions.map(() => '?').join(',')})`); params.push(...actions); }
        if (!conds.length) conds.push('1=1');
        const d = Number(days) > 0 ? Number(days) : null;
        if (d) { conds.push('created_at > NOW() - INTERVAL ? DAY'); params.push(d); }
        const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
        return r.many(`SELECT id, action, detail, conversation_id cid, created_at at FROM audit_log WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ${n}`, params);
      },
      /** 时间范围（`{at, at2}` ＝ MIN/MAX(created_at)；可限定前缀与时间窗）。 */
      async timeRange({ prefix = null, days = null } = {}) {
        const conds = [];
        const params = [];
        if (prefix) { conds.push('action LIKE ?'); params.push(String(prefix) + '%'); }
        if (!conds.length) conds.push('1=1');
        const d = Number(days) > 0 ? Number(days) : null;
        if (d) { conds.push('created_at > NOW() - INTERVAL ? DAY'); params.push(d); }
        const row = await r.one(`SELECT MIN(created_at) at, MAX(created_at) at2 FROM audit_log WHERE ${conds.join(' AND ')}`, params);
        return row ? { at: row.at ?? null, at2: row.at2 ?? null } : null;
      },
    },

    /**
     * 介质自报能力（裁定 C）：MySQL 有 `events_archive` / `audit_log_archive` 两张归档表，
     * 也有原生动词（`one/run/query`，`db.js` 就是 SQL）。调用方据此决定归档做不做。
     */
    capabilities() {
      return { medium: IMPL, archive: true, rawSql: true };
    },

    /** 实现名（诊断用；两个实现都有这一项，夹具比对方法面时按契约清单逐项对，不看它）。 */
    impl: IMPL,
  };

  // 事务里不再开事务（没有这样的调用方，不预造）；外层由 createMysqlStorage 覆盖
  api.tx = async () => { throw new Error('事务内不支持嵌套事务（存储实现=' + IMPL + '）'); };
  return api;
}
