// server/storage/jsonfile.js —— 不依赖 MySQL 的实现（本仓的 `dsh-storage-json`）：单文件 JSON 存储
//
// 为什么要有第二个实现（v0.3 §2.1 第 2 条 + §0.2 G1）：
//   "不依赖我们的数据库"这句话只有在**真的换掉实现**时才成立。接口写完了却只有 MySQL 一种实现，
//   G1 就还是纸面的。所以先做最轻的一个：一个 JSON 文件，零依赖（只用 `node:fs`），
//   干净机器上只需要一个可写目录 —— 这就是 G1 出口（跑通一次对话 + 一次工具调用）需要的最小介质。
//
// 为什么不是 sqlite：本的 `package.json` 声明 `engines.node >= 18`，而 `node:sqlite` 要 22.5+ 且是
//   experimental（本机 22.23 上试过，会打 ExperimentalWarning）；为它把引擎的最低 Node 版本抬上去，
//   代价大于收益（客户机是 Windows Server，装什么版本 Node 不由我们定）。JSON 文件在任何 Node ≥18 上都一样。
//
// 覆盖范围＝**引擎跑起来必需的实体**（会话/消息/工具调用/设置/运行现场/事件，v0.3 符合性核对 §2.1 第 2 条）
//   ＋**外部投递记录**（deliveries）。deliveries 原本不在必需清单里，是 2026-09-16 端到端实测把它拉进来的：
//   带 `Idempotency-Key` 的 `POST /api/chat` 会走 `beginDelivery` ⇒ 缺了它这一轮直接 500（原文见交付说明）。
//   "⑦ 存储后端可替换"的判据是**换上去跑得通**，而不是"接口在、能力缺一半"，所以这里补上，且**语义与
//   mysql 实现逐条对齐**（唯一键冲突、失败可抢重发、收尾、死信列表）—— 不许为跑通另造一条语义不同的旁路。
// 仍然**显式抛"该实现不支持"**的：三个原生 SQL 动词（`query`/`one`/`run`）以及走它们的**事件归档**
//   （`events_archive` 表 + `NOW() - INTERVAL` 是 MySQL 侧的保留策略）—— 缺能力必须报错，不许静默返回空
//   （v0.3 §4.6 同一精神）。将来往 CONTRACT 里加实体，落点就在这里：要么实现、要么显式抛；
//   漏了会被 test/storage.test.mjs 的方法面用例当场判红。
//
// 这个实现**不是**给生产负载用的，如实写在前面（免得读代码的人误判它的定位）：
//   · 每次写都整文件落盘（含 `persistEvent` 这种每帧一次的调用）⇒ 量一大就慢；落盘已**串行化**（见 createJsonFileStorage）
//   · 单进程内内存态（Node 单线程），**不做跨进程文件锁**（引擎现在是单进程，v0.3 §4.1）；
//   · 真跑量要的是 sqlite 实现（下一个增量），不是把它优化成数据库。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RW_WORKSPACE } from '../env.js';
import { assertFields, unsupported } from './index.js';

const IMPL = 'jsonfile';
const FORMAT = 'rw-store-json';   // 文件格式的身份（v0.3 §4.9：存储格式带版本号与迁移链）
const VERSION = 1;
/** 本实现**支持的表**；不在这张表里的实体一律显式抛错（"加实体"的落点见文件头注释）。 */
const TABLES = ['conversations', 'messages', 'toolCalls', 'settings', 'agentRuns', 'events', 'deliveries'];

// 默认落点：工作区下的 storage/（与 spill/、.rw-checkpoints/ 同属"运行期产物"，不进仓库）。
// 要挪位置得在 server/env.js 加一个 RW_STORAGE_FILE（env.js 是环境事实的唯一出处，本轮由协调方维护，
// 故实现不自己读 process.env）；夹具通过构造参数把文件指到临时目录。
export const DEFAULT_FILE = path.join(RW_WORKSPACE, 'storage', 'rw-store.json');

const nowIso = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));   // 记录按契约就是可 JSON 序列化的：文件即格式

function emptyDoc() {
  return { format: FORMAT, version: VERSION, counters: {}, tables: Object.fromEntries(TABLES.map((t) => [t, {}])) };
}

/** 读文件；不存在＝全新库；**版本不认识就显式拒绝**（照 `server/session-export.js` 的 rw-session 口径）。 */
function loadDoc(file) {
  if (!fs.existsSync(file)) return emptyDoc();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyDoc();
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`存储文件不是合法 JSON（${file}）：${e.message}`); }
  if (doc.format !== FORMAT) throw new Error(`存储文件格式不认识：${doc.format}（期望 ${FORMAT}，${file}）`);
  if (Number(doc.version) !== VERSION) throw new Error(`存储文件版本不认识：${doc.version}（本实现只认 ${VERSION}，${file}）`);
  if (!doc.tables) doc.tables = {};
  for (const t of TABLES) if (!doc.tables[t]) doc.tables[t] = {};
  if (!doc.counters) doc.counters = {};
  return doc;
}

let tmpSeq = 0;   // 临时文件名里的序号（同一进程内唯一；跨进程由 pid 区分）

async function saveDoc(file, doc) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // 先写临时文件再 rename：rename 是原子的 ⇒ 中途崩了也不会留下半截文件（"要么旧的、要么新的"）。
  // 临时名**必须每次不同**（pid+序号）：共用 `<file>.tmp` 时，两次并发写里先 rename 的那个会把临时文件
  // 搬走，后一个 rename 就 ENOENT —— 2026-09-16 真机实测（一轮对话里 persistEvent 逐帧
  // fire-and-forget，几十个并发写当场踩中，见 `[eventlog] 事件落账失败 ENOENT ... rename`）。
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 构造一个 JSON 文件存储。
 * @param {{file?:string}} [opts] file 仅供夹具/嵌入方指定落点（默认 `DEFAULT_FILE`）
 */
export function createJsonFileStorage({ file = DEFAULT_FILE } = {}) {
  // 惰性加载：构造时**不读盘**（`import { storage }` 的模块级构造不能有 IO，也不该因为路径还没建好就炸）
  let doc = null;
  const holder = { get doc() { if (doc === null) doc = loadDoc(file); return doc; }, set doc(v) { doc = v; } };

  // 落盘**串行化**：一条 promise 链保证"同一时刻只有一个写在飞"，顺序＝调用顺序。
  // 为什么必须串行：写的是**整份文档**，两个并发写如果各写各的临时文件再互相 rename，轻则 ENOENT，
  // 重则后写的旧快照盖掉先写的新快照（丢更新）。链上的每次写都读**执行那一刻**的 holder.doc，
  // 所以最后一个写必然包含此前全部变更。链尾吃掉 rejection（失败由本次调用的 await 抛给调用方）。
  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(() => saveDoc(file, holder.doc), () => saveDoc(file, holder.doc));
    return chain;
  };

  return makeApi(holder, persist, { persist: true });
}

/**
 * 造一份存储面。`opts.persist=false` 用于事务里的内层句柄：落盘只在事务提交那一刻发生一次。
 */
function makeApi(holder, save, { persist }) {
  const idOf = (v) => (typeof v === 'string' ? Number(v) : v);
  const nextId = (table) => {
    const d = holder.doc;
    const n = Number(d.counters[table] || 0) + 1;
    d.counters[table] = n;
    return n;
  };
  // 记录一律存成 { id, ...中性字段, createdAt, updatedAt }：id 是主键、时间是介质自己打的
  const put = (table, rec) => { holder.doc.tables[table][String(rec.id)] = rec; return rec; };
  const byId = (table, id) => holder.doc.tables[table][String(idOf(id))] || null;
  const rowsOf = (table) => Object.values(holder.doc.tables[table] || {}).sort((a, b) => a.id - b.id);
  // 读出去的一律是**快照**（clone）：直接给内存里的那条记录，调用方改一下返回值就等于"改了库但没落盘"，
  // 内存与文件从此不一致。MySQL 那边返回的本来就是新对象，两个实现必须一样。
  const snap = (x) => (x === null || x === undefined ? x : clone(x));
  const commit = async () => { if (persist) await save(); };

  const api = {
    /** 实现名（诊断用；两个实现都有这一项，夹具比对方法面时按契约清单逐项对，不看它）。 */
    impl: IMPL,

    // ── 四类动词里的三个"原生动词"：JSON 实现没有 SQL 面 ⇒ 显式抛错（调用方必须走命名方法）──
    // 这不是缺陷而是设计：SQL 是 MySQL 的方言，把它当通用接口才是假装抽象。
    one: async () => { throw unsupported(IMPL, '原生 SQL 读一条（`one`）——本实现只提供命名实体方法'); },
    run: async () => { throw unsupported(IMPL, '原生 SQL 写（`run`）——本实现只提供命名实体方法'); },
    query: async () => { throw unsupported(IMPL, '原生 SQL 查询（`query`）——本实现只提供命名实体方法'); },

    conversations: {
      async create(fields) {
        assertFields('conversations', fields);
        const at = nowIso();
        const rec = { id: nextId('conversations'), ...fields, createdAt: at, updatedAt: at };
        put('conversations', rec);
        await commit();
        return { id: rec.id };
      },
      async get(id) { return snap(byId('conversations', id)); },
      async update(id, patch) {
        assertFields('conversations', patch, { partial: true });
        const rec = byId('conversations', id);
        if (!rec) return;                       // 幂等：改不存在的行＝什么都不做（与 MySQL 的 affectedRows=0 同义）
        Object.assign(rec, patch, { updatedAt: nowIso() });
        await commit();
      },
    },

    messages: {
      async append(fields) {
        assertFields('messages', fields);
        const rec = { id: nextId('messages'), ...fields, createdAt: nowIso() };
        put('messages', rec);
        await commit();
        return { id: rec.id };
      },
      /**
       * 按会话升序读回（不发明默认条数：`limit` 由调用方给，不给＝全量 —— 默认值是业务口径，属于调用方）。
       */
      async list(conversationId, limit) {
        const rows = rowsOf('messages').filter((r) => Number(r.conversationId) === Number(conversationId));
        return snap(Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows);
      },
    },

    toolCalls: {
      async append(fields) {
        assertFields('toolCalls', fields);
        const rec = { id: nextId('toolCalls'), ...fields, createdAt: nowIso() };
        put('toolCalls', rec);
        await commit();
        return { id: rec.id };
      },
    },

    settings: {
      async get(key) {
        const rec = holder.doc.tables.settings[String(key)];
        return rec ? clone(rec.value) : null;
      },
      async set(key, value) {
        const at = nowIso();
        const prev = holder.doc.tables.settings[String(key)];
        holder.doc.tables.settings[String(key)] = { id: String(key), value: clone(value), updatedAt: at, createdAt: (prev && prev.createdAt) || at };
        await commit();
      },
    },

    agentRuns: {
      async create(fields) {
        assertFields('agentRuns', fields);
        const at = nowIso();
        const rec = { id: nextId('agentRuns'), status: 'running', ...fields, createdAt: at, updatedAt: at };
        put('agentRuns', rec);
        await commit();
        return { id: rec.id };
      },
      async getLatest(conversationId) {
        const rows = rowsOf('agentRuns').filter((r) => Number(r.conversationId) === Number(conversationId));
        return snap(rows.length ? rows[rows.length - 1] : null);
      },
      async update(id, patch) {
        assertFields('agentRuns', patch, { partial: true });
        const rec = byId('agentRuns', id);
        if (!rec) return;
        Object.assign(rec, patch, { updatedAt: nowIso() });
        await commit();
      },
    },

    events: {
      async append(fields) {
        assertFields('events', fields);
        const rec = { id: nextId('events'), ...fields, at: nowIso() };   // 账本只追加：没有 update/delete
        put('events', rec);
        await commit();
        return { id: rec.id };
      },
      async read(conversationId, { afterId = 0, limit } = {}) {
        const rows = rowsOf('events')
          .filter((r) => Number(r.conversationId) === Number(conversationId) && Number(r.id) > Number(afterId));
        return snap(Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows);
      },
    },

    // ── 外部投递记录（幂等键 + 死信落点）：语义与 mysql 实现逐条对齐 ──────────────────────────
    // 为什么它必须在第二个实现里也有：带 `Idempotency-Key` 的 `POST /api/chat` 第一件事就是 `beginDelivery`，
    // 缺了这一块整轮直接 500（2026-09-16 真机复现）。业务判定（回放/冲突/重发）仍在 `server/deliveries.js`，
    // 这里只负责介质语义 —— 尤其是**唯一键**：同一个（账号 + 幂等键）只能有一行，第二次插入必须抛错
    // （MySQL 靠 uk_deliveries_idem 唯一索引，这里靠同一判据），调用方据此把并发重发判成"进行中"，
    // 而不是新开一条把活干两遍。
    deliveries: {
      async insert({ accountId = null, conversationId = null, idemKey = null, hash = null } = {}) {
        if (idemKey !== null && rowsOf('deliveries').some((r) => (r.accountId ?? null) === (accountId ?? null) && r.idemKey === idemKey)) {
          // 与 MySQL 唯一索引冲突同形：code 用 mysql2 的 ER_DUP_ENTRY，消息文本照它写 ——
          // deliveries.js 两个判据都认，于是"同一刻两个重发只进一个"在两个实现下都成立
          const e = new Error(`Duplicate entry '${idemKey}' for key 'uk_deliveries_idem'`);
          e.code = 'ER_DUP_ENTRY';
          throw e;
        }
        const at = nowIso();
        const rec = {
          id: nextId('deliveries'), accountId, conversationId, idemKey, requestHash: hash, state: 'running',
          attempts: 1, messageId: null, runId: null, response: null, lastError: null, lastErrorCode: null,
          createdAt: at, updatedAt: at,
        };
        put('deliveries', rec);
        await commit();
        return { id: rec.id };
      },
      /** 幂等键查询。`account_id <=> ?` 是 NULL 安全等（照 MySQL 侧那条 SQL）：账号为 NULL 也要命中自己那条。 */
      async findByKey(accountId, idemKey) {
        const hit = rowsOf('deliveries').find((r) => (r.accountId ?? null) === (accountId ?? null) && r.idemKey === idemKey) || null;
        return snap(hit);
      },
      /** 上次失败 ⇒ 抢回 running（attempts+1）；`state !== 'failed'` 就是并发闸门（对应 WHERE id=? AND state=?）。 */
      async claimRetry(id, hash) {
        const rec = byId('deliveries', id);
        if (!rec || rec.state !== 'failed') return false;
        rec.state = 'running';
        rec.attempts = Number(rec.attempts || 0) + 1;
        if (hash !== null && hash !== undefined) rec.requestHash = hash;   // COALESCE(?, request_hash)：NULL 保留原值
        rec.updatedAt = nowIso();
        await commit();
        return true;
      },
      async finish(id, patch) {
        assertFields('deliveries', patch, { partial: true });
        const rec = byId('deliveries', id);
        if (!rec) return;
        Object.assign(rec, patch, { updatedAt: nowIso() });
        await commit();
      },
      /**
       * 死信列表：按 id 倒序（最新在前），可选按 state / accountId 过滤；
       * limit 不合法＝不设上限（与 mysql 的 limitClause 同规则）。
       * `accountId` 与 mysql 侧一样是**过滤条件**（不是取回来再筛）：先按账号过滤、再截窗口，
       * 否则别人的行会先把窗口占满，调用方看不到自己最近的那几条。
       */
      async list({ state = null, limit = 20, accountId } = {}) {
        let rows = rowsOf('deliveries').filter((r) => (state ? r.state === state : true)
          && (accountId === undefined || accountId === null ? true : (r.accountId ?? null) === (accountId ?? null)));
        rows = rows.sort((a, b) => b.id - a.id);
        const n = Number(limit);
        if (Number.isInteger(n) && n > 0) rows = rows.slice(0, n);
        return snap(rows);
      },
    },
  };
  // 注：**事件归档**（`events_archive` 表 + `NOW() - INTERVAL`）是 MySQL 侧的保留策略，不在本实现范围。
  // `eventlog.js` 的 `archiveOldEvents` 走原生动词（`query`/`run`），在这里会显式抛"该实现不支持"。

  /**
   * 事务：把内存态整份克隆出来给 `fn` 用，**全部成功才落盘**。
   * 回滚＝丢掉克隆（一个字节都不写文件）——这是真回滚，不是"补偿写回去"。
   */
  api.tx = async (fn) => {
    const draft = { doc: clone(holder.doc) };
    const inner = makeApi(draft, save, { persist: false });
    inner.tx = async () => { throw unsupported(IMPL, '嵌套事务'); };   // 不预造：没有这样的调用方
    const out = await fn(inner);
    holder.doc = draft.doc;     // 提交：只有到这里，内存态才换成新版本
    await save();
    return out;
  };

  return api;
}
