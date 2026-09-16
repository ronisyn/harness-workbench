// server/prefix-assemble.js - 组装侧跨轮前缀账的**唯一落账点**（三条入口共用一份实现）
//
// 依据：v0.3 §4.4.1 规则5「**失效可数**：C4 作为一等观测指标；任何进入请求前缀的组件都必须声明其
//   缓存影响，并**并入不变式检查**」＋规则1「只追加：禁止中途改写早期消息」。
//
// 为什么要把这段从 `server/index.js` 里搬出来（改前只有 `/api/chat` 一条路在落这笔账）：
//   组装侧跨轮机检（判据在 `server/history.js` 的 `detectPrefixRewrite`）此前**只挂在 `/api/chat` 上**。
//   实测（`scripts/c1c2-forensics.mjs` 只读复跑，真库 rw_test）：`prefix:assemble` 全表 15 行，
//   **全部是 09-16 04:30 之后的 web 探针会话**；另两条入口——headless（`scripts/rw-run.mjs`）与
//   渠道（`server/channels/run-turn.js`）——**一次都没落过**。也就是说真实流量里 76% 的轮次
//   「机检判不了」（指纹列缺失），而这本可以由我们自己控制的一部分：**至少让每条路径都落账**。
//   与已登记的 C-38①（"渠道绕过会话 API"）同源：三条路各拼各的前缀，机检却只长在一条上。
//
// 为什么是独立模块，而不是收进 `server/agent.js` 的每轮组装处（候选①，已否决）：
//   · `runAgent` 拿到的是**组装完成的 messages**，拿不到"组装侧历史"与"本轮车道"（lane）——
//     而跨轮判据要比的正是"上一轮发出去的前缀"vs"这一轮发出去的前缀"，那是组装侧的事实；
//   · `agent.js` 走的是 `import { db } from './db.js'`（真库），没有注入缝 ⇒ 夹具只能连真库；
//     本模块的 `db` 是**参数**，三条路径各传各的（生产传真库、夹具传假库），不调模型也能钉死；
//   · `agent.js` 是热路径且每轮都在跑，而这条判据**一次执行只该跑一次**（它是 run 之间的比较）；
//     挂进每轮循环既多做无用的活，又会让 "run 内断链"（agent.js 的 diffCore/prevCore）与
//     "跨 run 改写"（本模块）两件事混在一个计数器里 —— 那正是 C4 归因最怕的混淆。
//   · 三条路径唯一的共同点是"都调 runAgent"，但共同点不在"组装"这一步；收在 agent.js = 拿错层。
// 为什么不是"一个大一统的 runTurn"（把三条路的组装也合一）：那是另一件事（`scripts/rw-run.mjs`
//   文件头 ④ 与 `server/channels/run-turn.js` 文件头 ③ 都记着"本轮不动既有装配"），
//   本轮只收**机检**这一段，请求怎么拼一个字不改。
//
// 三条路径怎么接（`/api/chat` 的**行为逐字节不变**：同样的账、同样的字段、同样的时机）：
//   · `/api/chat`  （`server/index.js`）      lane 源件＝它原有的那一串（模型/轻量面/壳/启用集/壳 schema）
//   · headless     （`scripts/rw-run.mjs`）   lane 源件＝模型/轻量面/权限 + 它本来就读到的启用集
//   · 渠道         （`server/channels/run-turn.js`）lane 源件＝模型/全量面/权限（渠道不搬 /api/chat 的组装侧逻辑）
//
// **两条判据纪律**（写在这里，改的人必须一起读）：
//   ① 传给本模块的 `hist` 必须是**这一轮真正发出去的那串前缀**（逐字节同源），不是"库里有什么"。
//      反例：headless 送出去的是"最近 30 条"窗口，若拿 DB 全文当 hist，滑窗改写就永远判不出来
//      （库里只会越来越长，看起来永远是 append）——那等于把机检做成安慰剂。
//   ② `lost` 相对**峰值**而不是上一轮：滑窗会一轮轮往下掉，拿上一轮当基准会把最严重的那次藏起来。
//      （判据本体在 `server/history.js`，这里不重复实现，只调它。）
//
// 依赖纪律：本模块只 import 三个**无副作用**模块（`node:crypto` / history / prefix-participants），
//   `db` 一律由调用方传入。理由很实际：`scripts/rw-run.mjs` 必须保证 `--help` 与用法错**绝不碰连接池**，
//   所以它那边连 `server/db.js` 都是动态 import 的；本模块要是自己 import db/config，那条纪律当场就破了。
import { PREFIX_LEDGER } from './prefix-participants.js';
import { detectPrefixRewrite, parsePrefixRecord, formatPrefixRecord } from './history.js';
import { prefixHash } from './prefix.js';

/** 跨轮指纹的账本动作名（与 `server/history.js` 的 `PREFIX_RECORD_ACTION` 同源：都取声明表常量）。 */
export const PREFIX_ASSEMBLE_ACTION = PREFIX_LEDGER.ASSEMBLE;

/**
 * 账本行里标明**是哪条入口**落的（归因用）。
 * 为什么值里没有 `assemble` 这个词：`/api/chat` 的动作名是 `prefix:assemble`，两条信息合起来已经
 * 说清了"谁落的账"，不需要在两个字段里各说一遍（行里出现两次同样的词只会让 grep 变糊）。
 * `src=` 这个字段名是 2026-09-16 起就有的口径（`server/index.js` 原先写死 `src=assemble`），不改名。
 */
export const PREFIX_SOURCE = { WEB: 'web', HEADLESS: 'headless', CHANNEL: 'channel' };

/**
 * 车道（lane）的源件：**同一份代码在不同 (模型/工具面/权限/壳) 下是不同的前缀**，
 * 换了车道就该跳过比较（缓存本来就要重建，已由 agent.js 的 `prefix:exempt` 记过一次，
 * 这里再记一次就是把同一件事数两遍 —— 见 `server/history.js` 文件头的"判据"第 2 条）。
 *
 * 为什么单独一个函数：三条路径各拼一串字符串时，少一个字段就是**静默漏判**（lane 恒不同 → 永远
 * 判不了），而那种错在账本上看不出来（每轮照样落一行 `prefix:assemble`）。收在一处才有可能被夹具钉住。
 *
 * @param {object} o
 * @param {string|null} o.provider    本轮厂商
 * @param {string|null} o.model       本轮模型
 * @param {boolean}     o.light       轻量面（工具面宽度的一半；与真正发出去的 schema 同源）
 * @param {string|null} o.preset      预设档
 * @param {string|null} o.mode        会话模式
 * @param {string|null} o.permission  权限档
 * @param {string|null} [o.shellKey]  壳 key（非 default 才有）
 * @param {Iterable|null} [o.enabledTools] 工具启用集（Set 或数组；排序后进指纹，顺序不影响语义）
 * @param {object|null} [o.shellSchema]    壳 schema 裁剪（非 default 壳才有）
 * @returns {string} 车道指纹（12 位十六进制，落账本 lane= 字段）
 */
export function prefixLane({
  provider = null, model = null, light = false, preset = null, mode = null, permission = null,
  shellKey = null, enabledTools = null, shellSchema = null,
} = {}) {
  const sorted = (set) => (set ? [...set].sort() : null);
  return prefixHash(JSON.stringify([
    provider, model, !!light, preset, mode, permission, shellKey,
    sorted(enabledTools),
    shellSchema ? [
      shellSchema.presetBase,
      sorted(shellSchema.forceOn),
      sorted(shellSchema.forceOff),
      shellSchema.mcpAllow,
    ] : null,
  ]));
}

/**
 * 落一次组装侧跨轮账：**先判改写、再记本轮指纹**（顺序即语义，别调换）。
 *
 * @param {object} o
 * @param {object} o.store           存储接口（**唯一注入缝**，理由见文件头"依赖纪律"：本模块不许自己
 *                                   import storage/db —— 那会让 `rw-run.mjs --help` 这条"绝不碰连接池"的路
 *                                   静态地把库模块拖进来）。对照读（上一行的 detail）与两处写都走它。
 * @param {number|string} o.conversationId 会话 id（跨轮对照的键）
 * @param {number|null} o.accountId  归属账号（渠道/headless 可能为 null —— 如实记 null，不编一个）
 * @param {number|null} [o.shellId]  壳 id（非 default 壳才有；没有就是 null）
 * @param {Array<{role:string,content:any}>} o.hist 本轮**真正发出去**的那串前缀（纪律①）
 * @param {string} o.lane             本轮车道（由 `prefixLane` 算；判定见 `server/history.js`）
 * @param {'web'|'headless'|'channel'} o.source 哪条入口落的账（PREFIX_SOURCE）
 * @returns {Promise<{state:string,cnt:number,fp:string,lane:string,peak:number,lost:number,prevCnt:number|null}>}
 *   `detectPrefixRewrite` 的判定结果 + `prevCnt`（上一轮记的条数，没有对照时为 null）。
 *   为什么把 `prevCnt` 也带出来：日志要说"cnt 31→30"这种**人读**的归因，而 `lost` 是相对峰值的
 *   （滑窗一轮轮往下掉时 prevCnt ≠ peak − lost），从返回值里反推会算错 —— 让"读到的那一行"直接传出来。
 *
 * 抛错语义：**不吞异常**。真库写不进去是事实，吞掉就是"账本静默少一行"（正是这一系列缺陷的成因）。
 * 调用方按各自既有口径处置：`/api/chat` 出声但**不阻断对话**（它的既有行为，一个字不改）。
 */
export async function recordPrefixAssemble({ store, conversationId, accountId = null, shellId = null, hist, lane, source }) {
  // 对照读走存储接口（`audit.lastDetail`，形状＝原来那条 `ORDER BY id DESC LIMIT 1`）：
  // 2026-09-17 之前这处读是直连 SQL —— 写口迁了而它没迁时，干净机器上"先读后写"整段失败（被调用方 catch 吞掉）。
  const prevDetail = await store.audit.lastDetail({ conversationId, action: PREFIX_ASSEMBLE_ACTION });
  const prev = parsePrefixRecord(prevDetail);
  const d = detectPrefixRewrite(prev, hist, lane);
  if (d.state === 'rewrite') {
    // C4 非预期失效：这是一等观测指标，不是日志噪音 —— 必须能被 SQL 数出来（agent.js 的 run 内断链
    // 落的是 `first-diff-idx=…`，本条落的是 `src=` + 指纹字段，两种失效在账本上分得开）。
    await store.audit.append({ accountId: accountId, action: PREFIX_LEDGER.INVALIDATE, detail: formatPrefixRecord(d) + ' src=' + source, shellId: shellId, conversationId: conversationId });
  }
  await store.audit.append({ accountId: accountId, action: PREFIX_ASSEMBLE_ACTION, detail: formatPrefixRecord(d), shellId: shellId, conversationId: conversationId });
  return { ...d, prevCnt: prev ? Number(prev.cnt) : null };
}
