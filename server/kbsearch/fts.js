// server/kbsearch/fts.js —— 检索后端实现：MySQL 8 全文索引（FULLTEXT … WITH PARSER ngram）
//
// 它是 v0.3 §4.3「记忆」行里「**全文检索（FTS5）打底**」的介质落地：DSH 用 SQLite FTS5，
// 我们用自己的介质 MySQL FULLTEXT —— 同一件事（倒排索引 + `MATCH … AGAINST` 相关度排序），换介质不换行为。
// 中文**必须** `WITH PARSER ngram`：默认解析器按空格/标点切词，中文整段变一个 token，等于搜不到。
//
// 两条路，**如实标记**走的是哪条（不静默假装）：
//   · fts   ：`MATCH(title, body) AGAINST (? IN BOOLEAN MODE)` + `ORDER BY score DESC`（真·索引检索）
//   · like  ：索引不存在 / 介质不支持 ngram 时报的错被接住 ⇒ 回落 `title LIKE ? OR body LIKE ?`（沿用改造前口径），
//             返回里 `mode:'like'`、`degraded:true`、`detail` 写明为什么退回来的。
//   其它错误（连不上、权限、语法错）**一律抛**——那些不是"索引没建好"，兜住它们会变成静默降级。
//
// BOOLEAN MODE 而不是 NATURAL LANGUAGE MODE：布尔模式**不做 50% 阈值剪枝**（natural 模式会把出现在
// 半数以上文档里的词判为无意义），而我们的查询是若干关键词的**并集**而不是一句自然语言统计——
// 实测（tmp/fts-query-shape.mjs）两种模式在本介质上给的分数一致，选布尔是为了行为更可控。
// 关键词一律**逐词加引号**成短语：这样 `+`/`-`/`*`/`(`/`"` 这些布尔操作符字符进了查询串也只是普通字符，
// 构不成注入形态（实测 `-天气` / `部署)` / `a"b` 三种形态都只当普通词处理，不抛错）。
//
// 复现证据（原始输出见交付报告 ②）：一次性库 `rw_fts_test_<pid>` 跑迁移链 → 建 ngram 索引 → 插中文条目
// → `MATCH` 搜到且分数非零；`DROP INDEX` 后再 `MATCH` 报 `ER_FT_MATCHING_KEY_NOT_FOUND`（1191）⇒ 走 like 兜底。
export const id = 'fts';

/** 索引名：建库两条路径（server/db.js 的 SCHEMA / server/migrations.js 的链尾）必须用同一个名字。 */
export const INDEX_NAME = 'ft_kb_text';
/** 参与检索的两列（与建索引语句里的列顺序一致）。 */
export const INDEX_COLUMNS = ['title', 'body'];

/**
 * "索引不可用"这一类失败的**容许判据**（只有这一类才回落 LIKE）：
 *   · `ER_FT_MATCHING_KEY_NOT_FOUND`（1191）—— MySQL 原话 "Can't find FULLTEXT index matching the column list"，
 *     索引被删/迁移没跑到（存量库）就是这一条，实测拿到。
 *   · 建索引时 `WITH PARSER ngram` 不被支撑的库（无 ngram 插件）—— 报的是 "Plugin ... is not loaded" /
 *     "unknown parser" 一类；这类库索引根本建不起来，如实回落并在 detail 里写明。
 * 判据写成**导出函数**是为了可机检（夹具要能钉住"不是这一类的错必须抛"）。
 */
export function isIndexUnavailable(e) {
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || e);
  if (code === 'ER_FT_MATCHING_KEY_NOT_FOUND') return true;
  if (/FULLTEXT index/i.test(msg) && /can't find|not found|cannot find/i.test(msg)) return true;
  if (/ngram/i.test(msg) && /not loaded|not supported|isn't supported|unknown parser|plugin/i.test(msg)) return true;
  // 介质/存储引擎不支持全文索引（旧引擎、表类型不支持）——索引同样建不起来，如实回落。
  // 如实记一笔：MySQL 的原话是 "The used table type doesn't support FULLTEXT indexes"——**不是** does not，
  // 所以判据按"否定词 + FULLTEXT"两条同现来写（含缩写、含 ' 的弯引号），而不是写一个我以为的原话片段。
  if (/FULLTEXT/i.test(msg) && /\b(does ?n'?t|does not|is ?n'?t|is not|not|cannot|can't)\b/i.test(msg) && /support/i.test(msg)) return true;
  return false;
}

/** 关键词 → 布尔模式查询串（逐词加引号；内部引号去掉，构不成注入形态）。 */
export function toBooleanQuery(q) {
  const terms = String(q == null ? '' : q).split(/\s+/).map((s) => s.replace(/"/g, '')).filter(Boolean);
  return terms.map((t) => '"' + t + '"').join(' ');
}

/** 关键词 → LIKE 形态（**沿用改造前 `kb_search` 的口径**：词间加 `%`，整串子串匹配）。 */
export function toLikePattern(q) {
  return '%' + String(q == null ? '' : q).split(/\s+/).filter(Boolean).join('%') + '%';
}

/** 可见范围条件 → 可直接拼进 WHERE 的片段（像 SQL 片段就整体括起来；空条件＝不加限制，交由调用方负责）。 */
export function scopeClause(where) {
  const w = String(where == null ? '' : where).trim();
  if (!w) return '';
  return /^\(.*\)$/s.test(w) ? w : '(' + w + ')';
}

/** 行 → 对外条目（body 按 opts.snippet 截断；score 只在真有分数时带）。 */
function toItem(r, opts, withScore) {
  const snip = opts.snippet === undefined ? 1200 : Number(opts.snippet);
  const body = String(r.body || '');
  const item = {
    id: r.id,
    scope: r.scope,
    title: r.title,
    body: (Number.isFinite(snip) && snip > 0 && body.length > snip) ? body.slice(0, snip) : body,
    createdAt: r.created_at,
  };
  if (withScore && r.score !== undefined && r.score !== null) item.score = Number(r.score);
  return item;
}

function limitOf(opts) {
  const n = Number(opts.limit === undefined ? 8 : opts.limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

/**
 * 本后端就绪吗：查 `information_schema.STATISTICS` 看 FULLTEXT 索引在不在（**只查元数据，不起查询**）。
 * 返回 `{ available, backend, index, engine, detail }`；查不动介质时**如实**报 available:false +
 * `error`（不假装"可用"，也不抛——probe 的语义是"报事实"，见 exec/local.js 的 probe）。
 */
export async function available(opts = {}) {
  const db = opts.db;
  if (!db || typeof db.query !== 'function') throw new Error('kbsearch/fts.available 需要 opts.db（{ query(sql, params) }）');
  const out = { available: false, backend: id, index: INDEX_NAME, engine: 'mysql-fulltext-ngram', indexType: null, detail: '' };
  try {
    const rows = await db.query(
      `SELECT INDEX_NAME, INDEX_TYPE, TABLE_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'knowledge' AND INDEX_NAME = ? LIMIT 1`,
      [INDEX_NAME]
    );
    const r = (rows && rows[0]) || null;
    out.indexType = r ? String(r.INDEX_TYPE) : null;
    out.available = !!(r && String(r.INDEX_TYPE).toUpperCase() === 'FULLTEXT');
    out.detail = out.available
      ? `knowledge.${INDEX_NAME} 已存在（FULLTEXT）`
      : `knowledge.${INDEX_NAME} 不存在（或不是 FULLTEXT）⇒ 检索走 LIKE 兜底`;
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.detail = '查不到索引元数据（介质不可用？）⇒ 不能断言全文检索可用';
  }
  return out;
}

/**
 * 检索：先走 `MATCH … AGAINST`（真·全文），索引不可用则如实回落 LIKE。
 * @returns {Promise<{items:Array, mode:'fts'|'like'|'empty', backend:string, degraded:boolean, detail?:string, error?:string}>}
 */
export async function search(q, opts = {}) {
  const db = opts.db;
  if (!db || typeof db.query !== 'function') throw new Error('kbsearch/fts.search 需要 opts.db（{ query(sql, params) }）');
  const where = scopeClause(opts.where);
  const params = Array.isArray(opts.params) ? opts.params : [];
  const limit = limitOf(opts);
  const cols = 'id, scope, title, body, created_at';
  const boolQ = toBooleanQuery(q);
  const like = toLikePattern(q);

  // 缺省只认"当前事实"（A6 条目治理 §7.3：superseded/obsolete 仅历史，不参与检索/注入）。
  // 调用方传的 `where` 若**已经**自己写了 `status=…`（例如管理面显式筛 status），这里就不再插一条——
  // 同一件事两个出处必然长歪（那条纪律见 `server/knowledge.js` 的 `kbVisibleWhere`）。
  // `includeHistorical` 的语义与 `kbVisibleWhere` 的**同一个名字同一个意思**：要历史才给 true。
  // ⚠️ 这条**必须**在这一层实现（而不是像会话侧那样由调用方自己往 where 里塞）：管理面带 `q` 时会走这个函数
  // 且自带条件串，如果只靠调用方，同一个函数就会出现"从 kb_search 调=只搜当前事实、从管理面调=连历史一起搜"
  // 这种没人看得出来的分叉。
  const statusGuard = (opts.includeHistorical || /(^|[\s(])status\s*=/.test(where)) ? '' : "status='active'";
  const allConds = [where, statusGuard].filter(Boolean).join(' AND ');

  // 空查询：不落库、不猜，如实返回空（调用方据此判断"没搜"）
  if (!boolQ) {
    return { items: [], mode: 'empty', backend: id, degraded: false, detail: '空查询：未执行检索' };
  }

  // ---- ① 全文检索（倒排索引 + 相关度）----
  // ⚠️ `MATCH … AGAINST` 必须写在 WHERE 的**最前面**（在可见范围条件之前）——这不是风格问题，是**正确性**问题。
  // 实测（MySQL 8.0.46，一次性库脚本 tmp/kb-fts-rehearsal.mjs 的诊断段）：
  //   · `WHERE (account_id=? AND …) AND MATCH(…) AGAINST (?)` —— 绑定参数与 MATCH 这样排时，优化器会选
  //     `key=idx_kb_scope`（B-tree）那条计划，同一条 SQL **返回 0 行**（把 MATCH 排在最前就正常返回 2 行）；
  //   · 换成字面量 `account_id=1` 时优化器选 `key=ft_kb_text`（fulltext）⇒ 2 行；
  //   · 加 `FORCE INDEX (ft_kb_text)` **并不能**救回来（计划显示走了全文索引，结果仍是 0 行）；
  //   · 把 MATCH 挪到最前 ⇒ 计划 `key=ft_kb_text`、结果正确（多种绑定组合都验过）。
  // 换句话说：参数化查询 + MATCH 在后的组合会让"搜得到"悄悄变成"一条都搜不到"，而 mode 仍然报 fts
  // （表面正常、实则空手而归）。所以这里把 MATCH 放最前，并留这段实测记录——下一个人想"整理一下 WHERE 顺序"
  // 的时候得先看到它。
  const matchSql = `SELECT ${cols}, MATCH(${INDEX_COLUMNS.join(', ')}) AGAINST (? IN BOOLEAN MODE) AS score
     FROM knowledge
    WHERE MATCH(${INDEX_COLUMNS.join(', ')}) AGAINST (? IN BOOLEAN MODE)${allConds ? ' AND ' + allConds : ''}
    ORDER BY score DESC, id ASC LIMIT ?`;
  try {
    // 参数顺序必须跟着上面 SQL 里的占位符顺序走：① 选择项里的 MATCH、② WHERE 里的 MATCH、③ 过滤条件参数、④ limit
    const rows = (await db.query(matchSql, [boolQ, boolQ, ...params, limit])) || [];
    return {
      items: rows.map((r) => toItem(r, opts, true)),
      mode: 'fts',
      backend: id,
      degraded: false,
      detail: 'MySQL FULLTEXT（' + INDEX_NAME + '，ngram 分词）按相关度降序',
    };
  } catch (e) {
    if (!isIndexUnavailable(e)) throw e; // 不是"索引不可用"就如实抛，绝不吞
    // ---- ② 兜底：索引不在 ⇒ 如实回落 LIKE（并**标明**走的是这条路）----
    // 过滤条件与 status 缺省守卫跟 fts 那条路**共用同一份** `allConds`（同一件事不许两个出处）；
    // 排序沿用改造前 LIKE 的口径（`id DESC`，没有分数可排）。
    const likeSql = `SELECT ${cols} FROM knowledge
      WHERE (title LIKE ? OR body LIKE ?)${allConds ? ' AND ' + allConds : ''}
      ORDER BY id DESC LIMIT ?`;
    const rows = (await db.query(likeSql, [like, like, ...params, limit])) || [];
    return {
      items: rows.map((r) => toItem(r, opts, false)),
      mode: 'like',
      backend: id,
      degraded: true,
      error: String((e && e.message) || e),
      detail: '全文索引不可用（' + ((e && e.code) || e) + '）⇒ 回落到 LIKE 子串匹配（改造前口径：按 id 降序，无相关度）',
    };
  }
}
