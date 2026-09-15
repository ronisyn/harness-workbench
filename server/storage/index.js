// server/storage/index.js —— 存储接口（本仓的 `dsh-storage`）：契约 + **单一选择点**
//
// 为什么要有这个目录（v0.3 §7.1 ⑦「存储抽象」，依赖 ①；§4.1「存储走接口」；验收 G1）：
//   G1 的出口是"干净机器 + 一份配置 → 跑通一次对话 + 一次工具调用"，而现在的引擎有 379 处直接
//   `db.query`、且只有 MySQL 一种实现 —— 换台没有我们那个库的机器就跑不起来。
//   所以先把"调用方依赖什么"从"MySQL 长什么样"里剥出来；改成什么样是**分批**的（v0.3 符合性核对 §2.1
//   第 1 条明说"不是一次改 379 处"），本文件只提供收口的目标面。
//
// 分层与"靠配置选实现"照 DSH 的做法（先问 DSH 是硬规矩）：
//   · 接口包    `dsh-storage`            → 本文件（只写"有哪些方法、语义是什么"，不含 SQL、不 import 驱动）
//   · 实现包    `dsh-storage-json`/`-sqlite` → `mysql.js`（包在既有 `db.js` 上）/ `jsonfile.js`（零依赖）
//   · 领域层    `dsh-storage-domain`     → 留在各模块里（如 `eventlog.js` 的"跳过流式增量"、`deliveries.js`
//                                          的幂等判定）—— **语义不进存储层**，存储层只答"介质怎么读写"
//   · 选择      DSH 是插件按名注册后端；我们没有容器，等价物就是本文件的 `createStorage()`：
//               **全仓唯一**读 `RW_STORAGE`（`server/env.js`）的地方，默认 `mysql`＝现行行为不变。
//               DSH 的"后端服务不了某类数据就省略该 facet、解析失败即显式报错"这条也照搬：能力缺失
//               **抛错**，不静默降级（与 v0.3 §4.6「禁止静默降级」同一精神）。
//
// 接口面上有**四类动词**（v0.3 符合性核对 §2.1 第 1 条的原话）+ 引擎必需实体的**命名方法**：
//   读   `one(sql, params)`    —— 读一行（`row | null`）
//   写   `run(sql, params)`    —— 单条写语句，返回 `{ insertId, affectedRows }`
//   查询 `query(sql, params)`  —— 读多行（列表/聚合）
//   事务 `tx(fn)`              —— 一组写要么全成、要么全不动（`fn` 拿到一个同为完整存储面的句柄）
//   ↑ 四类动词是**过渡面**：尚未迁移的调用方（本轮之后还有 360 多处）把 SQL 留在原地、只换 import，
//     就能先断掉"直接用 db"；已迁移的调用方（`eventlog.js`/`deliveries.js`）走下面的命名方法。
//     为什么两者都要：只给原生动词 ⇒ 换实现时调用方全废（等于没抽象）；只给命名方法 ⇒ 一轮改不完 379 处。
//
// 命名方法只覆盖**引擎跑起来必需的实体**（会话/消息/工具调用/设置/运行现场/事件，v0.3 符合性核对 §2.1 第 2 条），
// 外加本轮做示范迁移的 `deliveries`（它**不是**引擎必需 ⇒ `jsonfile.js` 对它显式抛"不支持"，
// 这就是那个"禁止静默降级"的活样本）。其余实体（市场/计量/进化集/壳……）**暂不进接口**：
// 没有第二个实现要用它们，先加进来就是预造 ORM（不做的范围见 v0.3 §0.6）。
import { RW_STORAGE } from '../env.js';
import { createMysqlStorage } from './mysql.js';
import { createJsonFileStorage } from './jsonfile.js';

/** 已注册的实现名（`RW_STORAGE` 的取值域）。 */
export const STORAGE_IMPLS = ['mysql', 'jsonfile'];

/** 能力缺失的稳定错误码：调用方可以据此区分"实现不支持"与"真的失败了"。 */
export const STORAGE_UNSUPPORTED = 'STORAGE_UNSUPPORTED';
/** 传入未知字段（写进介质就会变成静默丢数据）的稳定错误码。 */
export const STORAGE_INVALID_FIELD = 'STORAGE_INVALID_FIELD';

/**
 * 「该实现不支持 X」——**如实抛**，绝不静默降级成空结果/默认值。
 * 空结果与"不支持"在调用方那里长得一样，但一个是事实、一个是谎言（v0.3 §4.6 的同一精神）。
 */
export function unsupported(impl, what) {
  const e = new Error(`该实现不支持 ${what}（存储实现=${impl}）`);
  e.code = STORAGE_UNSUPPORTED;
  e.impl = impl;
  return e;
}

/**
 * 契约（机器可读的那一半）：夹具据此断言"两个实现的方法面完全一致"，
 * 也就是"换实现不改调用方"这件事有机检，而不只是注释里的承诺。
 */
export const CONTRACT = {
  verbs: ['one', 'run', 'query', 'tx'],
  entities: {
    // 引擎必需（v0.3 符合性核对 §2.1 第 2 条点名的六类）
    conversations: ['create', 'get', 'update'],
    messages: ['append', 'list'],
    toolCalls: ['append'],
    settings: ['get', 'set'],
    agentRuns: ['create', 'getLatest', 'update'],
    events: ['append', 'read'],
    // 非必需：本轮示范迁移的第七个实体（`jsonfile.js` 对它显式抛"不支持"）
    deliveries: ['insert', 'findByKey', 'claimRetry', 'finish', 'list'],
  },
};

/**
 * 各实体的**中性字段名**（不含任何列名/表名）：写入时按它校验，
 * 免得"传了个拼错的字段 → 谁都不报错 → 数据静默丢了"。
 * 这也是两个实现的共同语言：`mysql.js` 自己把中性名映射到列名，`jsonfile.js` 直接按它存。
 */
export const FIELDS = {
  conversations: ['accountId', 'channel', 'permission', 'preset', 'mode', 'project', 'title', 'provider', 'model', 'shellId'],
  messages: ['conversationId', 'role', 'content', 'reasoning', 'model', 'provider', 'tokensIn', 'tokensOut'],
  toolCalls: ['conversationId', 'messageId', 'toolName', 'args', 'resultSummary', 'resultBytes', 'durationMs', 'status', 'errorCode', 'shellId'],
  agentRuns: ['conversationId', 'accountId', 'goal', 'status', 'reason', 'rounds', 'lastStep', 'toolCounts'],
  events: ['conversationId', 'seq', 'type', 'payload'],
  // deliveries 的方法收的是具名参数（不是整条记录），这里列的是它的**记录形状**：
  // `finish(id, patch)` 的 patch 按它校验，`findByKey`/`list` 回来的记录也按它映射。
  deliveries: ['accountId', 'conversationId', 'idemKey', 'requestHash', 'state', 'messageId', 'runId', 'response', 'lastError', 'lastErrorCode', 'attempts'],
};

/** 展平成 `['query', 'conversations.create', ...]`：夹具与自检用它比对两个实现的方法面。 */
export function contractMethods() {
  const out = [...CONTRACT.verbs];
  for (const [entity, verbs] of Object.entries(CONTRACT.entities)) {
    for (const v of verbs) out.push(entity + '.' + v);
  }
  return out;
}

/**
 * 各实体的**必需字段**：表定义里 NOT NULL 的那些，再加上"缺了就没有意义"的那一个
 * （工具调用没有名字、事件没有类型，落库只是垃圾）。两个实现共用同一份判据 ——
 * 判据写两份必然长歪，而"一个实现拒绝、另一个默默收下"正是最难查的一类不一致。
 */
export const REQUIRED = {
  conversations: ['accountId'],
  messages: ['conversationId', 'role'],
  toolCalls: ['toolName'],
  agentRuns: ['conversationId'],
  events: ['conversationId', 'type'],
};

/**
 * 字段白名单校验：`partial=false` 时（新建/追加）未知字段、缺必需字段都报错；
 * `partial=true` 时（更新）只校验给出的那些。
 */
export function assertFields(entity, obj, { partial = false } = {}) {
  const allowed = FIELDS[entity] || [];
  const given = Object.keys(obj || {});
  if (!partial && !given.length) {
    const e = new Error(`写入 ${entity} 时没有任何字段`); e.code = STORAGE_INVALID_FIELD; throw e;
  }
  for (const k of given) {
    if (!allowed.includes(k)) {
      const e = new Error(`未知字段 ${entity}.${k}（允许：${allowed.join(', ')}）`);
      e.code = STORAGE_INVALID_FIELD;
      throw e;
    }
  }
  if (!partial) {
    const missing = (REQUIRED[entity] || []).filter((k) => (obj || {})[k] === undefined || obj[k] === null);
    if (missing.length) {
      const e = new Error(`写入 ${entity} 缺必需字段：${missing.join(', ')}`);
      e.code = STORAGE_INVALID_FIELD;
      throw e;
    }
  }
  return obj || {};
}

/**
 * **单一选择点**：全仓只有这里读 `RW_STORAGE`（v0.3 §7.1 ⑦ 的落地开关见 `server/env.js`）。
 * 未知取值**直接抛**，不静默回退到 mysql —— 配置写错却照跑，是最难查的一类"看起来正常"。
 *
 * 注：本文件静态 import 了两个实现，于是 `mysql.js` → `db.js` 会**建一个连接池对象**；
 * 但 mysql2 的 `createPool()` 是惰性的（不连、不校验），所以 `RW_STORAGE=jsonfile` 的干净机器
 * 不会被"它还需要一个 MySQL"挡住 —— 这正是 G1 要的那个性质。
 */
export function createStorage(which = RW_STORAGE) {
  if (which === 'mysql') return createMysqlStorage();
  if (which === 'jsonfile') return createJsonFileStorage();
  throw new Error(`未知的存储实现 RW_STORAGE='${which}'（可选：${STORAGE_IMPLS.join(' / ')}）；不静默回退到默认实现`);
}

/** 进程内默认实例（照 `RW_STORAGE` 选）。调用方 `import { storage }` 即可，不关心介质。 */
export const storage = createStorage();
