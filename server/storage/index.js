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
//
// 2026-09-16 扩到**登录链**（`accounts`/`sessions` + 会话/消息/设置的按账号读法）：M1 出口是
// "干净机器 + 一份配置 → 跑通一次对话 + 一次工具调用"，而在此之前**登录本身**就要 `accounts`/`sessions`
// 两张表 ⇒ 一台没有 MySQL 的机器连门都进不去，`RW_STORAGE` 这个开关等于形同虚设。
// 这次加的方法**全部**来自"调用方真的在用的查询"（`server/auth.js` 的 6 条 + `server/index.js` 的会话/消息/设置
// 那几条，逐条写在方法注释里），不是照着"一张表该有什么动词"想出来的；也**没有**改动任何既有方法的签名
// （`events`/`deliveries`/`conversations.get` 等一字未动，新动词一律新名字）。
//
// 2026-09-16 第二批（同一件事的续）：把**登录→会话→消息→历史→设置**这条链的调用点真的迁过来时，发现
// 有 5 处现有动词表达不了（不是"想要更多动词"，是逐条对不上）：
//   · `conversations.exists(id)` —— `/api/chat` 的孤儿守卫（原 `SELECT 1 FROM conversations WHERE id=?`）；
//     会话的**归属判据**没有另造方法：`conversations.get(id)` 已经回 `accountId`/`channel`，
//     调用方按原 SQL 的同一套条件在 JS 里比（`WHERE id=? AND account_id=?` 与带 `(channel!="web" AND account_id IS NULL)`
//     那条都逐字保留），接口面因此不多两个几乎同义的动词；
//   · `conversations.getAs(id, keys)` —— Web 只读会话的**列子集**（八列，读全行是另一种行为）；
//   · `messages.history(id)` —— 上下文口径的历史读法（只要 id/role/content，升序、全量）；
//   · `messages.guardAppend(fields)` —— `INSERT … SELECT … FROM conversations WHERE id=?` 的孤儿守卫
//     （介质原语：MySQL 一条语句、JSON 先查后写，语义都是"会话不在就一行都不写"）；
//   · `messages.countByTool(id, {tools, days})` —— kb 注入判定那条 `COUNT(*) … tool_name IN (…) AND created_at > NOW()-INTERVAL ? DAY`；
//   · `messages.count(id, {role})` 已在契约里，本次只是终于接上调用方。
// 一条既有签名都没动（`contractMethods()` 只多不少），两个实现同步补齐 —— 漏一个会被 test/storage.test.mjs 的
// 方法面用例当场判红。
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
    // conversations/messages/settings 上带 Owned/ByAccount 后缀的那几个是**按账号收口**的读法：
    // 它们对应 `server/index.js` 里本来就带 `account_id=?` 的查询（:321/:373/:762），不是新发明的边界
    // —— 接口上不留"不带账号"的读法，就不会有人把 D3/OP-01 那条边界漏掉（上一轮的 `/api/deliveries` 就是这么漏的）。
    conversations: ['create', 'get', 'update', 'findOwned', 'listByAccount', 'updateOwned', 'touch', 'exists', 'remove'],
    messages: ['append', 'list', 'recent', 'count', 'history', 'guardAppend', 'countByTool', 'removeByConversation'],
    toolCalls: ['append', 'list', 'recent', 'attachToMessage', 'removeByConversation'],
    settings: ['get', 'set', 'all', 'getMany'],
    agentRuns: ['create', 'getLatest', 'update'],
    events: ['append', 'read'],
    // 用量记账（2026-09-17 加**写口**）：v0.3 §4.6「预算与审计：**本地兜底**——无外网/无平台侧时自落账并支持
    // 离线导出（默认开启）」。迁移前只有直连 SQL 一条路 ⇒ 干净机器上成本计量是空的（"省钱"这条主线在客户机
    // 上没有数）。本轮只迁**写口**：读法（C1–C5 报表 / 仪表 / 遥测 / 会话导出）仍走 SQL，如实登记。
    usage: ['append'],
    // 登录链（G1 出口"干净机器 + 一份配置 → 跑通一次对话"的前置）：账号与会话
    accounts: ['findByUsername', 'create'],
    sessions: ['create', 'findValid', 'remove'],
    // 知识库（2026-09-17 加）：**先**为"第二个检索实现"加（`server/kbsearch/like.js` 不碰 SQL，
    // 它的记录必须从这套接口读出来），**再**为"干净机器上要能攒记忆"加写口（v0.3 §4.3「记忆」行：
    // FTS 打底 + 分层召回 + 受限自动沉淀）——在此之前只有读：检索跑得起来、条目却攒不下来。
    // 口子只开到"模型侧记忆真正用到的形状"：`kb_add`（同名去重 → 覆盖/新增）、`kb_del`（可见范围内删）。
    // **管理面（`GET /api/knowledge` 的展示列视图、`PATCH` 的状态治理）仍走 SQL，未迁移**——那是管理视图口径，
    // 不是引擎跑起来必需的那条链（见收口表第九节的"仍未闭合"）。
    // `removeVisible` 收的是**安全边界**（照 `conversations.getAs` 那条"接口上不留不带账号的读法"的先例）：
    // 会话可见范围＝本账号的 (global ∪ 本壳 shell ∪ 本会话 conv) 且 status=active，两个实现都要保证同一条。
    knowledge: ['all', 'append', 'update', 'remove', 'removeVisible', 'findByTitle'],
    // 非必需：本轮示范迁移的第七个实体（`jsonfile.js` 对它显式抛"不支持"）
    // `list` 另接受**可选**的 `accountId` 过滤（`{state?, limit?, accountId?}`）：路由按调用者账号收口时用它，
    // 不传＝不筛（既有"无账号维度"的默认行为不变）。过滤条件必须**下推到介质**（SQL 的 WHERE / 先筛后截窗口），
    // 不能取回来再在内存里筛 —— 那样别人的行会先把 LIMIT 窗口占满。
    deliveries: ['insert', 'findByKey', 'claimRetry', 'finish', 'list'],
  },
};

/**
 * 各实体的**中性字段名**（不含任何列名/表名）：写入时按它校验，
 * 免得"传了个拼错的字段 → 谁都不报错 → 数据静默丢了"。
 * 这也是两个实现的共同语言：`mysql.js` 自己把中性名映射到列名，`jsonfile.js` 直接按它存。
 */
export const FIELDS = {
  conversations: ['accountId', 'channel', 'permission', 'preset', 'mode', 'project', 'title', 'provider', 'model', 'shellId', 'faceFull'],
  messages: ['conversationId', 'role', 'content', 'reasoning', 'model', 'provider', 'tokensIn', 'tokensOut'],
  toolCalls: ['conversationId', 'messageId', 'toolName', 'args', 'resultSummary', 'resultBytes', 'durationMs', 'status', 'errorCode', 'shellId'],
  agentRuns: ['conversationId', 'accountId', 'goal', 'status', 'reason', 'rounds', 'lastStep', 'toolCounts'],
  events: ['conversationId', 'seq', 'type', 'payload'],
  // accounts.create 收具名字段（用 assertFields 校验）；这里同时是**记录形状**（findByUsername 回来的那几列）
  accounts: ['username', 'passHash', 'role'],
  // sessions 的方法也收具名参数（`create({token, accountId, days})`），这里列的是**记录形状**
  // （`days` 是 TTL、不是记录字段：绝对到期时间由介质自己算 —— MySQL 用库的 NOW()、JSON 用进程时钟，
  //  这一点两边不同，已在 `jsonfile.js` 里写明；契约里放 TTL 而不是绝对时间，是为了别把时钟源也搬到应用层）。
  sessions: ['token', 'accountId', 'expiresAt'],
  // knowledge 的方法收的是具名参数（`all(accountId)`），这里列的是**记录形状**（读回来的行按它映射）：
  // 字段名与 `server/db.js` 的 `knowledge` 表一一对应；`relatedComponent` 不在列里——
  // 检索层用不到它（它是管理面的展示列），按"只收现在真正要用的"那条纪律不加。
  // `createdAt` 也不在列里：它是**所有实体共有的介质时间戳**（`toRecord()` 按 `created_at` 统一带出），
  // 不是 knowledge 特有的字段 —— 写进这张表反而会造成"有的实体登记了、有的没登记"的错觉。
  knowledge: ['accountId', 'scope', 'conversationId', 'shellId', 'kind', 'title', 'body', 'status'],
  // 用量记账的中性字段名（列名与 `usage_stats` 的建表逐字对应；`createdAt` 不在这里——那是**所有实体共有的
  // 介质时间戳**，由建表的 `DEFAULT NOW()` / JSON 侧 `nowIso()` 盖，不是调用方能填的字段）
  usage: ['accountId', 'conversationId', 'agentRunId', 'messageId', 'providerId', 'modelId', 'tokensIn', 'tokensOut',
    'cost', 'durationMs', 'firstTokenMs', 'cacheHit', 'cacheMiss', 'prefixSysHash', 'prefixToolsHash', 'shellId', 'kind'],
  // deliveries 的方法收的是具名参数（不是整条记录），这里列的是它的**记录形状**：
  // `finish(id, patch)` 的 patch 按它校验，`findByKey`/`list` 回来的记录也按它映射。
  deliveries: ['accountId', 'conversationId', 'idemKey', 'requestHash', 'state', 'messageId', 'runId', 'response', 'lastError', 'lastErrorCode', 'attempts'],
};

/**
 * **可修订字段**的白名单（`update(id, patch)` 用；没登记的实体＝按 `partial:true` 校验整份 `FIELDS`）。
 * 为什么 knowledge 要单独收窄：`accountId/scope/conversationId/shellId/kind` 是这条记忆的**身份**，
 * 从"修订"这条路改它们等于把一条记忆换成另一条（还绕过了 `kb_add` 的同名/冲突判定）；
 * 只有正文、状态、标题是"这条记忆的内容"。两个实现共用这一份清单，不许各写一份。
 */
export const PATCHABLE = {
  knowledge: ['body', 'status', 'title'],
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
  accounts: ['username', 'passHash'],
  conversations: ['accountId'],
  messages: ['conversationId', 'role'],
  toolCalls: ['toolName'],
  agentRuns: ['conversationId'],
  events: ['conversationId', 'type'],
  // knowledge：**写入用到的必需字段**（`append` 时缺了就报错）。`accountId` 是 NOT NULL；
  // `title` 与它一起构成"这条记忆是什么"（`kb_add` 里 title 也是必填、空 title 当场抛）。
  // `body` **不**登记：建表里它是可空字段，而"空正文"在现实里是合法的（标题即全部内容），
  // 把它登记成必需会把一条合法写入挡在门外——登记必需字段的判据是"缺了就没有意义"，不是"我们这条路径总是给"。
  knowledge: ['accountId', 'title'],
  // usage：**必需的是 `kind`**，不是别的。判据＝"缺了这条记录就没有意义"：`usage_stats` 的 `kind` 有默认值
  // `'request'`，可"用量的种类"（逐轮 round / 折叠 collapse / 标题 title / 摘要 summary / 预热 warmup）
  // 正是这条账**唯一的分类维度**——漏了它，一条账就退回默认值、混进"真实轮次"里，
  // 而 C1–C5 的口径全部按 kind 过滤（`cohort.js`）。其余字段各有默认值/可空，不登记。
  usage: ['kind'],
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
    // 必需字段＝**必须出现在调用里**（`undefined` 视为没给）。`null` 是"显式给了个空值"（例如渠道会话的
    // `accountId: null` —— 那正是 `channel != 'web' AND account_id IS NULL` 那类共享会话的形态），
    // 收不收它由**介质**说话：NOT NULL 的列会当场报错（MySQL 侧），这正是我们要的"出声"。
    const missing = (REQUIRED[entity] || []).filter((k) => !Object.prototype.hasOwnProperty.call(obj || {}, k) || obj[k] === undefined);
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
