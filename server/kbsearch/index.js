// server/kbsearch/index.js —— 知识检索后端层：**接口 + 单一选择点**（v0.3 §4.3「记忆」行：
// 「全文检索（FTS5）打底 + 分层召回 + 受限自动沉淀；**向量留接口位置后补**」）。
//
// 本文件负责的那一句：**全文检索打底 + 向量留接口位置**。分层召回已在位（`server/kbgate.js` 三档注入 +
// `server/knowledge.js` 的 `kbVisibleWhere` 三层可见范围 + `server/lessonrecall.js`），本层**不动可见范围**：
// 调用方（`kb_search`）把 `kbVisibleWhere()` 的条件与参数传进来，本层只负责"在这批行里怎么搜、怎么排"。
//
// 分层照 DSH（先问规矩），与本仓另两个先例同形：
//   · `server/storage/index.js` —— 接口 + `createStorage()` 唯一选择点 + 未知名字抛错；
//   · `server/exec/index.js`    —— 实现表 + `assertBackend()` 装配期校验 + `selectBackend()` 唯一选择点。
//   · 本目录：`fts.js` ＝MySQL 8 FULLTEXT + ngram（中文必须用 ngram，见 `tmp/fts-probe.mjs` 实测：
//     本机 8.0.46、ngram 插件 ACTIVE、ngram_token_size=2）；
//     `like.js` ＝**纯 JS 子串匹配**（在已读出的记录上匹配与排序，零 SQL、零索引）——
//     2026-09-17 补（G1 收口）：原先只有 fts 一个实现，**没有 MySQL 的机器上整条检索不可用**
//     （`kb_search` 与错题召回都拿不到结果）。它是 fts 的**并列实现**，不是 fts 的兜底：
//     选哪个由部署方在 `RW_KB_SEARCH` 上决定，`fts.js` 的行为一个字节都不改。
//     DSH 的介质是 SQLite FTS5（`dsh-session-query-sqlite`）；**照它的口径、用我们自己的介质**：
//     同一件事（倒排索引 + 相关度排序），介质换成 MySQL 的 FULLTEXT。不是把 FTS5 搬过来。
//
// **加一个实现＝写一个实现模块 + 在下面 BACKENDS 表里加一行**（照 exec 的原话）。这正是"向量留位置"：
//   · 模块实现两个动词 `available(opts)` / `search(q, opts)`，形状见下；
//   · 在 BACKENDS 加一行 `vector: vectorImpl`；
//   · 选择点 `RW_KB_SEARCH`（server/env.js）指过去即生效——调用方（kb_search）**一行都不用改**。
// **本仓现在不写向量实现**（v0.3 §0.6 明确不做的范围 + 蓝图 P12 的否决：语义检索远期，且 harness 自身
// 不靠 RAG）。留的是**位置**，不是空壳文件：接缝就是这份接口 + 选择点。
//
// 两个实现的输入面**不完全一样**（如实写在这里，不假装一致）：fts 收 `opts.db`（自己去问介质），
// like 收 `opts.storage`（记录已经读出来，它只做匹配与排序）。这不是接口不统一，是介质不同：
// 一个会发 SQL、一个不碰 SQL。两个动词的名字、返回形状、`limit`/`snippet`/`includeHistorical` 的同名同义
// 全部一致 —— 调用方（`kb_search`）两个都传，各取所需即可（`search()` 的注释里逐条写明）。
//
// 接口动词**只有两个**，都是"现在真正要用的"（不预造）：
//   `search(q, opts)`    搜索 → `{ items, mode, backend }`。`mode` 是**如实**标记这次走的是哪条路：
//                        `'fts'`（真走全文索引）/ `'like'`（索引不可用，回落子串匹配）/ `'empty'`（空查询没落库）。
//                        调用方与用户都必须能看出**这次到底是不是全文检索**——静默假装是最坏的一类错
//                        （与 v0.3 §4.6「禁止静默降级」同一条纪律）。
//   `available(opts)`    本后端在当前介质上就绪吗 → `{ available, backend, detail, ... }`。
//                        它是 **probe**（只查元数据，不冒充功能性探针）——照 `exec/local.js` 的 probe 口径。
//
// 接口面上**不设阈值**：返回几条由调用方给 `opts.limit`（缺省＝kb_search 既有口径 8），
// 分数阈值不设（"多少分算相关"没有依据，不发明）。本层只保证"按分数从高到低"。
//
// 介质事实（实测，写在这里免得下一个人以为"标题命中一定排在正文命中前面"）：
//   MySQL 8 InnoDB 全文索引**没有字段权重**，`MATCH(title, body)` 的分数只与"命中了几次"线性相关，
//   与命中在 title 还是 body 无关、也不做字段长度归一。所以本层**不承诺**"标题命中优先"，只承诺
//   "按介质给的分数降序"（同分时按 id 升序，让顺序是确定的、可复现的）。证据：`test/kbsearch.test.mjs`
//   第 ③ 组 + 交付报告里的一次性库实测输出。
import { RW_KB_SEARCH } from '../env.js';
import * as fts from './fts.js';
import * as like from './like.js';

/** 已注册的实现名（`RW_KB_SEARCH` 的取值域）。 */
export const BACKEND_NAMES = Object.freeze(['fts', 'like']);

/** 实现表 —— **唯一选择点**。不加"自动探测/回落"：选错就在启动时炸掉（CI 也能钉住）。 */
const BACKENDS = { fts, like };

/**
 * 一个检索后端必须提供的动词（装配期校验；少一个在**装配期**就抛，不等到第一次检索才发现）。
 * 照 `server/exec/index.js` 的 `assertBackend`。
 */
const VERBS = ['search', 'available'];

export function assertBackend(name, impl) {
  const missing = VERBS.filter((v) => typeof impl?.[v] !== 'function');
  if (!impl || typeof impl.id !== 'string' || missing.length) {
    throw new Error('检索后端 ' + name + ' 不满足接口：' + (missing.length ? '缺动词 ' + missing.join('、') : '缺 id'));
  }
  return impl;
}

/**
 * 按名字选实现。未知名字**如实抛错**，不静默回落到 fts ——
 * 配置写错却照跑，是最难查的一类"看起来正常"（同一个理由见 storage/exec 两个选择点）。
 */
export function selectBackend(name = RW_KB_SEARCH) {
  const key = String(name);
  const impl = BACKENDS[key];
  if (!impl) throw new Error('未知检索后端：' + key + '（RW_KB_SEARCH 可选：' + BACKEND_NAMES.join(' / ') + '）；不静默回落到默认实现');
  return assertBackend(key, impl);
}

// 进程启动时选定一次（与 storage/exec 同取向）。后端**不许**在运行中途换：同一句查询在不同时刻
// 落到不同检索世界，分数与顺序都对不上，而且没人看得出来。
export const KB_SEARCH_BACKEND = selectBackend();
export const KB_SEARCH_BACKEND_NAME = KB_SEARCH_BACKEND.id;

/**
 * 检索知识（调用方给的可见范围条件 + 关键词）→ `{ items, mode, backend, degraded, detail? }`。
 *
 * 两个实现对输入面各有要求（"要什么"由实现自己说话，本层不替它猜）：`fts` 要 `db`，`like` 要 `storage`/`rows`。
 * 缺了自己要的那样时它**如实抛错**（`fts` 的"需要 opts.db"、`like` 的"需要 opts.storage"），
 * 不静默返回空数组 —— 调用方把两样都传上，选哪个后端都成立。
 *
 * @param {string} q 关键词（空白分词；空查询**不落库**，直接如实返回空数组）
 * @param {object} opts
 *   · `db`        —— `fts` 要：MySQL 句柄（`{ query(sql, params) }`）。收参数而不是本模块直接 import
 *                    `server/db.js`：夹具要能在**不连库**的情况下钉住 SQL 含 `MATCH … AGAINST`、
 *                    以及"MATCH 报错 ⇒ 回落 LIKE 且 mode 如实变 like"这条判据。
 *   · `storage`   —— `like` 要：`server/storage/index.js` 的接口对象（`storage.knowledge.all(accountId)`）。
 *                    记录由它读出，`like` 只在内存里匹配与排序（它不碰 SQL）。
 *   · `rows`      —— `like` 的夹具缝：直接给一批记录（给了就不走 storage）。
 *   · `accountId` —— `like` 取记录用（`fts` 不需要：可见范围已经在 `where` 里）。
 *   · `where` / `params` —— 可见范围条件与参数（**由 `server/knowledge.js` 的 `kbVisibleWhere()` 产出**，
 *                    本层不另写一份可见性口径——同一事实两份必然长歪）。调用方传的 where 若像一句
 *                    SQL 片段，`fts` 把它整体括起来、`like` 按 `like.js` 的文法求值（看不懂就抛，不静默放行）。
 *   · `limit`     —— 返回几条（缺省 8＝kb_search 既有口径）。**不设分数阈值**：见文件头。
 *   · `snippet`   —— body 截断到几个字符（缺省 1200＝kb_search 既有口径；0/负数＝不截断）。
 *   · `includeScore` —— 是否在每条里带 `score`（默认带；`fts` 的 LIKE 兜底与 `like` 都只有"命中次数"这类
 *                    非介质分数，`like` 如实把它标成 `score`＝命中次数并在 detail 里说明）。
 */
export async function searchKnowledge(q, opts = {}) {
  return KB_SEARCH_BACKEND.search(q, opts);
}

/** 当前后端在当前介质上就绪吗（probe：只查元数据，不起查询）。 */
export async function searchAvailable(opts = {}) {
  return KB_SEARCH_BACKEND.available(opts);
}
