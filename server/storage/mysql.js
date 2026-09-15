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
import { assertFields } from './index.js';

const IMPL = 'mysql';

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
  deliveries: {
    accountId: 'account_id', conversationId: 'conversation_id', idemKey: 'idem_key', requestHash: 'request_hash',
    state: 'state', messageId: 'message_id', runId: 'run_id', response: 'response_json',
    lastError: 'last_error', lastErrorCode: 'last_error_code', attempts: 'attempts',
  },
};
const TABLES = {
  conversations: 'conversations', messages: 'messages', toolCalls: 'tool_calls', settings: 'settings',
  agentRuns: 'agent_runs', events: 'events', deliveries: 'deliveries', accounts: 'accounts', sessions: 'sessions',
};
/** JSON 列：写时 stringify、读时 parse（MySQL 的 JSON 列在新旧驱动下有时给对象、有时给字符串）。 */
const JSON_COLS = new Set(['payload', 'args', 'tool_counts', 'response_json', 'svalue']);
/** 需要打上介质时间戳的实体（`events` 不在此列：账本是只追加的事实，时间由库给、不随 update 变）。 */
const TOUCHED = new Set(['conversations', 'agent_runs', 'deliveries']);

const enc = (col, v) => (v === undefined ? null : (JSON_COLS.has(col) ? JSON.stringify(v) : v));
const dec = (col, v) => (v === null || v === undefined ? v : (JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v));

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
    },

    toolCalls: {
      async append(fields) {
        assertFields('toolCalls', fields);
        const { sql, params } = insertOf('toolCalls', fields);
        return { id: (await r.exec(sql, params)).insertId };
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
    /** 实现名（诊断用；两个实现都有这一项，夹具比对方法面时按契约清单逐项对，不看它）。 */
    impl: IMPL,
  };

  // 事务里不再开事务（没有这样的调用方，不预造）；外层由 createMysqlStorage 覆盖
  api.tx = async () => { throw new Error('事务内不支持嵌套事务（存储实现=' + IMPL + '）'); };
  return api;
}
