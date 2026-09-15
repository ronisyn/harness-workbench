// server/session-export.js —— 会话的**自描述导出物**与"版本不认识就显式拒绝"的导入
//
// 为什么要它：DB 侧的结构版本化已在 server/migrations.js 完成，**会话侧没有**。一个会话的数据散在
// conversations / messages / tool_calls / events / usage_stats 五张表里，没有任何自描述、可搬家的
// 导出物：把会话交出去（换机、备份、给别人复现）只剩 mysqldump 整库搬——而整库搬不带版本，对面拿到
// 一份文件回答不了"这是什么、什么版本、我读不读得了"。
//
// 参考 DSH（`dsh-session-format` + `dsh-session-format-catalog`，结论见交付报告），只照搬**语义**四条：
//   ① 导出物自带格式版本字段，版本是整数、只向前（DSH: header.version / 我们: formatVersion）；
//   ② 迁移按**相邻步**注册（v0→v1、v1→v2…），缺一步在装配时就显式报错，不拖到运行时；
//   ③ 版本不认识就**显式拒绝**（DSH 的 SessionFormatUnsupportedMigrationError）："更新的版本"与
//      "没有迁移的旧版本"分开报，**绝不静默跳过、绝不部分导入**；
//   ④ 当前版本的数据不走迁移（DSH 的 current 直接走 codec）。
//   不照搬它的物理形态（JSONL 一行一记录 + 文件名带 `.vN`）：我们的对象是关系表快照，
//   一个自描述 JSON 对象可直接 JSON.parse、可 diff、可整份传阅。
//
// 与既有 `GET /api/conversations/:id/export`（server/index.js 的 P26，一行一条 jsonl）的关系：
//   那个面向回放、没有版本字段也没有导入路径；本模块面向**搬家**（带版本 + 可导入）。两者并存是
//   **留给人的决策**（见交付报告），本模块不碰那个端点。
//
// 截断策略（大字段）：**不截断**。导出物要能原样导入，截断即失真；而且写入侧本来就截过，现实上界
//   远小于列类型上界——messages.reasoning ≤20000 字符（server/index.js:1187）、tool_calls 的
//   args/result_summary ≤2000 字符（server/tools/index.js:1480）。**没有**写入侧截断的只有
//   messages.content（MEDIUMTEXT）与 events.payload（实测全库最大 5637 / 516 字符）。
//   要"限长导出"就是新增能力（得带截断标记 + 原始长度），需要时再提。
import { pool as defaultPool } from './db.js';

export const SESSION_FORMAT = 'rw-session';
export const SESSION_FORMAT_VERSION = 1;
// v1 是**首个发布版本**：导出物从第一版起就写 formatVersion=1，从来没有 v0 的文件（v0.3 §4.9「会话与存储格式
// 带版本号与迁移链」）。这个常量只用来给**链校验**一个底盘：链的起点就是它 ⇒ "当前只有 v1 ⇒ 链为空"是
// **合法状态**（首版、无迁移步），不是"缺一步"；链里若有更早的步（夹具合成的 v0→v1），底盘以链为准。
// 至于某份更旧的文件读不读得了，判据统一是**链里有没有那一步**（见 planSessionMigration）——不另设特例。
export const SESSION_FORMAT_FIRST_VERSION = 1;

/**
 * 版本不被支持时抛这个（语义照 DSH `SessionFormatUnsupportedMigrationError`）：文件**读得懂**，
 * 但本版本没有读它的路径——调用方必须整份拒绝，不许跳过、不许降级、不许"能读多少读多少"。
 * 单独一个类是为了让调用方（CLI / 路由）能把它与"文件本身坏了"区分开：前者是"你的版本太旧/太新"。
 */
export class SessionFormatUnsupportedMigrationError extends Error {
  constructor(message) { super(message); this.name = 'SessionFormatUnsupportedMigrationError'; }
}

// ── 会话格式迁移链的**注册点**（v0.3 §4.9 / §7.1 ⑪「会话与存储版本化 + 迁移链」的会话侧那一半）──────────
// 为什么要有它：文件头 ③ 原来只有"版本不认识就拒绝"，**没有任何地方能写"v0 怎么变成 v1"**——于是
// "带迁移链"在会话侧只是半句话：升级只能靠"拒绝 + 人工转换"。这里补上另外半句。
//
// 参考 DSH（`dsh-session-format` + `dsh-session-format-catalog` + 每步一个包 `dsh-session-format-v0-to-v1`…），
// 只取三条语义（不照搬它的包结构与 JSONL 流式编解码器——我们的对象是一个自描述 JSON 对象，一步就是一个纯函数）：
//   ① **每步只允许相邻**（to === from + 1），且**在注册时**校验（DSH `defineSessionFormatMigration`）：
//      跳步在这里就炸，不拖到"某天真的来了个旧文件"才炸；
//   ② 整条链必须**连续、无缺口、无重复、不越过当前版本**，校验口径照 `server/migrations.js` 的 `validateChain`
//      （同一份纪律：坏链在读任何文件之前就抛，不带半条链跑）；
//   ③ **当前版本的数据不走迁移**（DSH 的 current 直接走 codec）。
//
// **当前状态：链为空是合法状态。** 只有 v1，而 v1 是首版 ⇒ 没有任何"旧版本"存在过 ⇒ **没有迁移步可写**，
// 这次启动校验因此通过（不是"缺一步"）。将来真要 v2 时：把 SESSION_FORMAT_VERSION 改成 2，**并且**注册
// v1→v2 那一步；只改版本号不写步 ⇒ 启动即报缺口（这正是要拦住的那种"改了版本却忘了迁移"）。
const MIGRATIONS = new Map(); // fromVersion → 冻结的 {fromVersion, toVersion, name, fn}

/** 版本号必须是"非负整数"（注册与链校验两处共用一份口径，免得两处判得不一样） */
function assertFormatVersion(v, label) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(label + ' 必须是非负整数（实际 ' + JSON.stringify(v) + '）');
  return v;
}

/**
 * 注册一个**相邻**迁移步。注册即校验（照 DSH）：跳步、重复起点、版本号不合法、没给函数，都在这里炸。
 * @param {number} fromVersion 这一步只能读的旧版本
 * @param {number} toVersion   迁移后的版本，必须 === fromVersion + 1
 * @param {(obj:object)=>(object)} fn 纯函数：v(fromVersion) 的导出物 → v(toVersion) 的导出物。
 *   **不要**自己改 `formatVersion`（链负责盖，见 migrateSessionExport）；**不要**改入参对象（导出物可能还被调用方持有）。
 * @returns {() => void} 注销函数（夹具造合成链后还原用；产品路径用不到）
 */
export function registerSessionMigration(fromVersion, toVersion, fn, { name } = {}) {
  const from = assertFormatVersion(fromVersion, 'fromVersion');
  const to = assertFormatVersion(toVersion, 'toVersion');
  if (to !== from + 1) throw new Error('会话迁移步必须相邻：v' + from + '→v' + to + ' 不是相邻步（只允许 v' + from + '→v' + (from + 1) + '）');
  if (typeof fn !== 'function') throw new Error('会话迁移步 v' + from + '→v' + to + ' 缺少迁移函数');
  const dup = MIGRATIONS.get(from);
  if (dup) throw new Error('会话迁移步 v' + from + ' 重复注册（已有 ' + dup.name + '）');
  const step = Object.freeze({
    fromVersion: from,
    toVersion: to,
    name: typeof name === 'string' && name ? name : 'v' + from + '-to-v' + to,
    fn,
  });
  MIGRATIONS.set(from, step);
  return () => { if (MIGRATIONS.get(from) === step) MIGRATIONS.delete(from); };
}

/** 已注册的迁移步（按 fromVersion 升序的快照）。夹具用它证明"首版、无迁移步"这个状态。 */
export function sessionMigrations() {
  return [...MIGRATIONS.values()].sort((a, b) => a.fromVersion - b.fromVersion);
}

/** 链的**底盘** = 最早存在过的版本：默认 v1（首版）；链里有更早的步（夹具合成的 v0→v1）时以链为准 */
function chainBase(steps) {
  return steps.reduce((min, s) => Math.min(min, s.fromVersion), SESSION_FORMAT_FIRST_VERSION);
}

/**
 * 校验一条会话格式迁移链（**纯函数**，口径照 `migrations.js` 的 `validateChain`）：相邻 + 连续无缺口 +
 * 无重复起点 + 没有越过当前版本的多余步。坏链抛错——**在迁移任何一份文件之前**先校验。
 * @param {Array} steps 迁移步（默认=已注册的链）
 * @param {{base?:number, head?:number}} range base=链的底盘（默认见 chainBase）；head=当前版本
 * @returns {true}
 */
export function validateSessionMigrationChain(steps = sessionMigrations(), { base, head = SESSION_FORMAT_VERSION } = {}) {
  if (!Array.isArray(steps)) throw new Error('会话迁移链必须是数组');
  // base 在**数组校验之后**才解析（否则链参数传错时抛的是 reduce 的 TypeError，看不出是哪儿错了）
  const lo = base === undefined ? chainBase(steps) : assertFormatVersion(base, 'base');
  assertFormatVersion(head, 'head');
  const byFrom = new Map();
  for (const s of steps) {
    const from = assertFormatVersion(s && s.fromVersion, '迁移步 fromVersion');
    const to = assertFormatVersion(s && s.toVersion, '迁移步 toVersion');
    if (to !== from + 1) throw new Error('会话迁移步必须相邻：v' + from + '→v' + to + ' 不是相邻步（只允许 v' + from + '→v' + (from + 1) + '）');
    if (typeof (s && s.fn) !== 'function') throw new Error('会话迁移步 v' + from + '→v' + to + ' 缺少迁移函数');
    if (byFrom.has(from)) throw new Error('会话迁移步 v' + from + ' 重复（同一起点不能有两步）');
    byFrom.set(from, s);
  }
  for (let v = lo; v < head; v++) {
    if (!byFrom.has(v)) throw new Error('会话迁移链有缺口：缺 v' + v + '→v' + (v + 1) + '（不跳过、不按当前版本硬读）');
  }
  // 越过当前版本的步 = 链指向的不是当前版本（改了版本号却忘了写步，或写了步却忘了改版本号）
  const extra = [...byFrom.keys()].filter((v) => v >= head);
  if (extra.length) throw new Error('会话迁移链有多余步（不指向当前版本 v' + head + '）：v' + extra.join(', v'));
  return true;
}

/**
 * "这个版本的导出物要依次走哪些步"。纯函数；当前版本返回空数组（照 DSH ③）。
 * 判据只有一条：**链里有没有从 v 到 HEAD 的每一步**。缺任何一步都显式拒绝（说清缺哪一步），
 * 绝不"按当前版本硬读"；比当前版本新的一律拒绝（不降级读取）。
 */
export function planSessionMigration(fromVersion, { steps = sessionMigrations(), head = SESSION_FORMAT_VERSION } = {}) {
  const v = assertFormatVersion(fromVersion, 'formatVersion');
  if (v > head) throw new SessionFormatUnsupportedMigrationError('导出物是更新的格式 v' + v + '；本版本只读写 v' + head + '（先升级再导入，不降级读取）');
  if (v === head) return [];
  const byFrom = new Map(steps.map((s) => [s.fromVersion, s]));
  const plan = [];
  for (let cur = v; cur < head; cur++) {
    const s = byFrom.get(cur);
    // 当前只有 v1 时，v0 的文件走到这里 —— 消息与过去逐字一致（既有夹具锁着"没有 v0→v1 的迁移"）
    if (!s) throw new SessionFormatUnsupportedMigrationError('导出物是 v' + v + '，本版本没有 v' + v + '→v' + head + ' 的迁移（迁移链缺这一步：v' + cur + '→v' + (cur + 1) + '；不跳过、不部分导入）');
    plan.push(s);
  }
  return plan;
}

/**
 * 信封检查（纯函数，`validateSessionExport` 与 `migrateSessionExport` 共用一份）。
 * 顺序是**故意**的：先"这文件是不是我们的"，再"版本号本身合不合法"，最后才谈"读不读得了"——
 * 否则一个 format 都不对的文件会收到"版本太旧"的错，排障就跑偏了。
 * @returns {number} 校验通过的 formatVersion
 */
function assertSessionEnvelope(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('导出物必须是 JSON 对象（实际是 ' + (Array.isArray(obj) ? 'array' : typeof obj) + '）；给的是文件内容时请先 JSON.parse');
  }
  if (obj.format !== SESSION_FORMAT) throw new Error('不是 ' + SESSION_FORMAT + ' 导出物（format=' + JSON.stringify(obj.format) + '）');
  const v = obj.formatVersion;
  // 先判"是不是个合法版本号"（malformed），再分"更新"与"缺迁移"两种拒绝（unsupported）——与 DSH 的分档一致
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('formatVersion 必须是非负整数（实际 ' + JSON.stringify(v) + '）');
  return v;
}

/**
 * 把一份导出物沿迁移链**逐步**升到当前版本（**不碰库、不改入参**）。当前版本原样返回（同一引用）。
 * 链缺步 / 版本更新 / 版本从未发布 ⇒ 抛 SessionFormatUnsupportedMigrationError；
 * 迁移步自己抛错 ⇒ 包一层说清"哪一步拒绝了哪个版本"（照 DSH 的 throwUnsupportedRefusal），
 * 否则一个纯函数里的 TypeError 看起来会像"文件坏了"。
 */
export function migrateSessionExport(obj) {
  const v = assertSessionEnvelope(obj);
  let cur = obj;
  for (const step of planSessionMigration(v)) {
    let next;
    try {
      next = step.fn(cur);
    } catch (e) {
      if (e instanceof SessionFormatUnsupportedMigrationError) throw e;
      throw new SessionFormatUnsupportedMigrationError('迁移步 ' + step.name + ' 拒绝了这份 v' + step.fromVersion + ' 导出物：' + ((e && e.message) || e));
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('迁移步 ' + step.name + ' 必须返回导出物对象（实际是 ' + (Array.isArray(next) ? 'array' : typeof next) + '）');
    }
    // 版本号由**链**来盖：步自己写错 formatVersion 也不会让链错位（否则"走到哪一版"就有两个出处）
    cur = { ...next, formatVersion: step.toVersion };
  }
  return cur;
}

// **启动校验**（模块加载即服务器启动的一部分；照 migrations.js「在应用任何一条之前先校验」）。
// 链有缺口/重复/多余步 ⇒ 立刻抛：带着半条链跑比启动失败更糟。当前只有 v1 ⇒ 链为空，这次校验通过。
validateSessionMigrationChain();

// conversations 参与搬家的列（导出 SELECT 与导入 INSERT 共用这一份，避免将来加了列只改一边而悄悄丢字段）。
// id 在列里：它是**来源标识**（导出物要能自述"我原本是哪个会话"），导入时**不沿用**（见 importConversation）。
const CONV_COLS = ['id', 'account_id', 'channel', 'external_id', 'permission', 'preset', 'mode', 'project', 'title', 'provider', 'model', 'shell_id', 'face_full', 'created_at', 'updated_at'];

// 四张"一个会话多行"的表：key = 在导出物里的位置，json = 该表的 JSON 列，cols 同上（一份两用）。
// 只有 messages 的 id 留在导出物里——它是**引用键**（tool_calls.message_id / usage_stats.message_id 指它），
// 导入时要重建映射；其余表的自增 id 没有任何人引用，进了导出物也只是噪声（导入后必然变）。
const PARTS = [
  { key: 'messages', table: 'messages', json: [], cols: ['id', 'role', 'content', 'reasoning', 'model', 'provider', 'tokens_in', 'tokens_out', 'created_at'] },
  { key: 'toolCalls', table: 'tool_calls', json: ['args'], cols: ['message_id', 'tool_name', 'args', 'result_summary', 'result_bytes', 'duration_ms', 'status', 'error_code', 'shell_id', 'created_at'] },
  { key: 'events', table: 'events', json: ['payload'], cols: ['seq', 'type', 'payload', 'created_at'] },
  { key: 'usage', table: 'usage_stats', json: [], cols: ['account_id', 'message_id', 'agent_run_id', 'shell_id', 'provider_id', 'model_id', 'tokens_in', 'tokens_out', 'cost', 'duration_ms', 'first_token_ms', 'cache_hit_tokens', 'cache_miss_tokens', 'prefix_sys_hash', 'prefix_tools_hash', 'kind', 'created_at'] },
];

// 五张表里的时间列只有这两个名字（按真库 information_schema 核对，不是照抄 db.js 的建表语句）。
// 导出物里它们是 ISO 字符串；导入必须还原成 Date 交给驱动按连接时区格式化，否则带 'Z' 的 ISO 会被
// MySQL 当字面量存进去（墙钟错位）——与导出时驱动的读出口径对称。
const DATE_COLS = new Set(['created_at', 'updated_at']);

/** JSON 列的读出口径：MySQL 的 JSON 列一定是合法 JSON 或 NULL，但驱动给对象还是字符串随版本而异，两边都收 */
function jsonValue(v) { return typeof v === 'string' ? JSON.parse(v) : v; }

/**
 * 导出一个会话（**只读**）。`pool` 可注入：夹具必须用假库（不碰真库），路由侧照旧只传会话 id。
 * @returns {Promise<object>} 自描述导出物：{format, formatVersion, exportedAt, conversation, messages, toolCalls, events, usage:{rows}}
 */
export async function exportConversation(conversationId, { pool = defaultPool } = {}) {
  const id = Number(conversationId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('会话 id 非法：' + conversationId);
  const [convRows] = await pool.query(`SELECT ${CONV_COLS.join(', ')} FROM conversations WHERE id=?`, [id]);
  const conv = convRows[0];
  if (!conv) throw new Error('会话不存在：#' + id);
  const out = {
    format: SESSION_FORMAT,
    formatVersion: SESSION_FORMAT_VERSION,
    exportedAt: new Date().toISOString(), // 导出动作的时间；数据自己的时间在各行的 created_at
    conversation: conv,
    messages: [],
    toolCalls: [],
    events: [],
    usage: { rows: [] }, // 任务书定的形状是 usage:{...}，而 usage_stats 一个会话多行，故是 { rows: [...] }
  };
  for (const part of PARTS) {
    const [rows] = await pool.query(`SELECT ${part.cols.join(', ')} FROM ${part.table} WHERE conversation_id=? ORDER BY id`, [id]);
    for (const r of rows) for (const c of part.json) r[c] = jsonValue(r[c]);
    if (part.key === 'usage') out.usage.rows = rows; else out[part.key] = rows;
  }
  return out;
}

/**
 * 校验导出物（**纯函数，不碰库**）。importConversation 的 dryRun 就是"它 + 计数"。
 * 失败一律抛错（消息里说清"哪一条、为什么"），不做"能读多少读多少"：
 *   · format / formatVersion 必须认识（见文件头 ③）——**只认当前版本**，旧版本请先 migrateSessionExport；
 *   · 必填字段齐：真库里 NOT NULL 且无默认值的只有 conversations.account_id、messages.role、
 *     events.type（外加由导入方自己填的 conversation_id）——缺了根本写不进去，所以提前报；
 *   · 引用一致：messages[].id 必须是非重复整数（它是引用键），tool_calls/usage 的 message_id 必须指得到它。
 * @returns {{sourceId:?number, counts:{messages:number,toolCalls:number,events:number,usage:number}}}
 */
export function validateSessionExport(obj) {
  const v = assertSessionEnvelope(obj);
  // 本函数只认**当前版本**的形状（旧版本先走 migrateSessionExport，见 importConversation）。两条拒绝照旧：
  // 它们是"版本不认识"这一档的唯一出口，不许放宽，也不许"能读多少读多少"。
  if (v > SESSION_FORMAT_VERSION) throw new SessionFormatUnsupportedMigrationError('导出物是更新的格式 v' + v + '；本版本只读写 v' + SESSION_FORMAT_VERSION + '（先升级再导入，不降级读取）');
  if (v < SESSION_FORMAT_VERSION) throw new SessionFormatUnsupportedMigrationError('导出物是 v' + v + '，本版本没有 v' + v + '→v' + SESSION_FORMAT_VERSION + ' 的迁移（迁移链缺这一步：不跳过、不部分导入）');

  const conv = obj.conversation;
  if (conv === null || typeof conv !== 'object' || Array.isArray(conv)) throw new Error('缺少 conversation 对象');
  if (!Number.isInteger(conv.account_id)) throw new Error('conversation.account_id 必须是整数（真库该列 NOT NULL 且无默认值）');
  for (const part of PARTS) {
    const rows = part.key === 'usage' ? (obj.usage && obj.usage.rows) : obj[part.key];
    if (!Array.isArray(rows)) throw new Error(part.key === 'usage' ? 'usage.rows 必须是数组' : part.key + ' 必须是数组');
  }

  const msgIds = new Set();
  obj.messages.forEach((m, i) => {
    if (!Number.isInteger(m && m.id)) throw new Error('messages[' + i + '].id 必须是整数（它是引用键，tool_calls/usage 指向它）');
    if (msgIds.has(m.id)) throw new Error('messages[' + i + '].id 重复：' + m.id);
    msgIds.add(m.id);
    if (typeof m.role !== 'string' || !m.role) throw new Error('messages[' + i + '].role 必填（真库该列 NOT NULL）');
  });
  obj.events.forEach((e, i) => {
    if (typeof (e && e.type) !== 'string' || !e.type) throw new Error('events[' + i + '].type 必填（真库该列 NOT NULL）');
  });
  for (const key of ['toolCalls', 'usage']) {
    const rows = key === 'usage' ? obj.usage.rows : obj[key];
    rows.forEach((r, i) => {
      if (r && r.message_id != null && !msgIds.has(r.message_id)) {
        throw new Error(key + '[' + i + '].message_id=' + JSON.stringify(r.message_id) + ' 在 messages 里不存在（引用不一致）');
      }
    });
  }
  return {
    sourceId: Number.isInteger(conv.id) ? conv.id : null,
    counts: { messages: obj.messages.length, toolCalls: obj.toolCalls.length, events: obj.events.length, usage: obj.usage.rows.length },
  };
}

/** 一列的值 → 可绑定参数。三处必须转换，否则 MySQL/驱动给出的**不是我们想要的东西**（原因见函数内注释） */
function bind(col, value, isJson) {
  if (value === undefined || value === null) return null; // 文件里没写这一列（可选列）按 NULL 走，不该让整份导入失败
  if (isJson) return JSON.stringify(value); // 直接绑对象会被驱动当成 `key = value` 片段，必须先序列化
  if (DATE_COLS.has(col)) return new Date(value); // ISO 字符串直接绑会被当字面量（墙钟错位），还原成 Date
  return value;
}

/** `INSERT INTO t (a, b) VALUES (?, ?)[, (?, ?)…]`（n 行；占位符与列清单必然同长） */
function insertSql(table, cols, n) {
  const one = '(' + cols.map(() => '?').join(', ') + ')';
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES ` + Array.from({ length: n }, () => one).join(', ');
}

/**
 * 导入一个会话。**默认 dryRun**：只校验 + 计数，一行不写。
 * dryRun=false 时整份写在一个事务里：要么全落地、要么一行不留（不留半截会话）。
 * 新会话 id 由导入方分配（自增列），**绝不沿用导出物里的 id**、**绝不覆盖已有会话**：见下方注释。
 * @returns {Promise<{ok:true, dryRun:boolean, newId:?number, sourceId:?number, counts:object}>}
 */
export async function importConversation(obj, { dryRun = true, pool = defaultPool } = {}) {
  // v0.3 §7.1 ⑪：**先按链逐步迁移，再导入**。顺序有意如此——迁移在读连接之前完成，所以"链缺步 ⇒ 显式报错"
  // 与"一行不写"是同一条路径保证的（旧版本绝不会被当成当前版本硬读）。当前版本原样通过（零开销）。
  const pack = migrateSessionExport(obj);
  const stats = validateSessionExport(pack); // 任何校验失败都在写库之前抛出
  if (dryRun) return { ok: true, dryRun: true, newId: null, ...stats };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // 新会话 id 由**数据库自增**分配：不沿用源 id（沿用就等于"往已有会话里灌数据"，那是覆盖不是导入），
    // 也不用 INSERT IGNORE / ON DUPLICATE KEY UPDATE——普通 INSERT 让任何意外的重复键原样报错，绝不覆盖。
    const convCols = CONV_COLS.filter((c) => c !== 'id');
    const [ins] = await conn.query(insertSql('conversations', convCols, 1), convCols.map((c) => bind(c, pack.conversation[c], false)));
    const newId = ins.insertId;
    if (!newId) throw new Error('新会话 id 没拿到（insertId=0）：中止导入，不写孤儿行');

    const idMap = new Map(); // 老 message id → 新 message id（tool_calls/usage 的 message_id 靠它重指向）
    for (const part of PARTS) {
      const src = part.key === 'usage' ? pack.usage.rows : pack[part.key];
      if (!src.length) continue;
      const cols = ['conversation_id', ...part.cols.filter((c) => c !== 'id')];
      const valuesOf = (r) => cols.map((c) => {
        if (c === 'conversation_id') return newId;
        if (c === 'message_id') return r.message_id == null ? null : idMap.get(r.message_id); // 一致性已校验，必定命中
        return bind(c, r[c], part.json.includes(c));
      });
      // messages 必须逐行插：要拿到每一行的 insertId 才能重建引用映射
      if (part.key === 'messages') {
        for (const m of src) {
          const [r] = await conn.query(insertSql(part.table, cols, 1), valuesOf(m));
          idMap.set(m.id, r.insertId);
        }
        continue;
      }
      // 其余表成批插（一次 500 行）：一个会话的 tool_calls/events 可上千条，逐行插在 SSH 隧道上是几千次往返
      for (let i = 0; i < src.length; i += 500) {
        const chunk = src.slice(i, i + 500);
        await conn.query(insertSql(part.table, cols, chunk.length), chunk.flatMap(valuesOf));
      }
    }
    await conn.commit();
    return { ok: true, dryRun: false, newId, ...stats };
  } catch (e) {
    try { await conn.rollback(); } catch { /* 回滚失败也要把原始错误抛出去（它才是线索） */ }
    throw e;
  } finally {
    conn.release();
  }
}
