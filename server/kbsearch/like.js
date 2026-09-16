// server/kbsearch/like.js —— 检索后端实现之二：**纯 JS 子串匹配**（在**已读出的记录**上匹配与排序）
//
// 为什么要有第二个实现（v0.3 §0.2 G1「干净机器 + 一份配置 → 跑通一次对话 + 一次工具调用」的收口）：
//   `fts.js` 依赖 MySQL 8 的 FULLTEXT + ngram 索引。**没有 MySQL 的机器上，整条检索路径不可用** ——
//   `kb_search` 与错题召回都拿不到结果。所以补第二个实现：不碰 SQL，在内存里对记录做匹配与排序。
//   它与 fts 的关系是**并列的两个实现**，不是 fts 的兜底：选哪个由部署方在 `RW_KB_SEARCH` 上决定
//   （`server/kbsearch/index.js` 的唯一选择点），**`fts.js` 的行为一个字节都不改**。
//
// 数据从哪来（与 fts 唯一的实质差别，如实写在这里）：
//   · fts   ：收 `opts.db`（`{query}`），自己把 SQL 发给介质；
//   · 本实现：收 `opts.storage`（`server/storage/index.js` 的接口对象，`storage.knowledge.all(accountId)`），
//             **记录已经读出来了**，本实现只负责"在这批行里怎么搜、怎么排"。
//   为什么不让本实现也收 `db`：那它就得会发 SQL —— 而"介质可能是 JSON 文件/别的什么"正是它存在的理由。
//   `opts.rows` 是夹具缝（直接给一批记录，不经过存储层），与 fts 夹具注入假 db 同一用法。
//
// 可见范围与状态守卫**不重写**：调用方（`kb_search` / 管理面）传进来的 `opts.where` + `opts.params`
//   就是 `server/knowledge.js` 的 `kbVisibleWhere()` 产出的那一份（全仓唯一的可见性口径）。本实现把它
//   当作**一小段谓词**在 JS 里求值 —— 支持的形态就是这两个调用方真正会产生的那几种（见下面 CONDITIONS_SUPPORTED），
//   遇到不认识的形态**如实抛错**，绝不"看不懂就当没有条件"（那会把别人的私有条目搜出来）。
//   同一份口径两种方言（SQL / JS 谓词）是"两个介质"的必然代价；判据只有一份，在这里没有第二个出处。
//
// `mode` / `degraded` 如实标记（照 fts 的两条路同一条纪律）：
//   · 本实现**永远** `mode:'like'`、`degraded:true` —— 它没有索引、没有介质给的相关度，
//     它就是"改造前那条 LIKE 子串检索"在内存里的等价物。标成 fts 或标成不降级都是假话。
//   · 排序：命中次数降序（标题命中与正文命中**同权**，不发明字段权重 —— MySQL 的 FULLTEXT 也没有），
//     同分按 `id DESC`（沿用改造前 LIKE 兜底那条"新的在前"的口径）。
import { toLikePattern, scopeClause } from './fts.js';

export const id = 'like';

/** 本后端支持的可见范围谓词形态（写在这儿是为了让"看不懂就抛"这句话可核对，不是为了声明能力边界）。 */
export const CONDITIONS_SUPPORTED = ['col=?', 'col="字面量"', "col='字面量'", 'col<=>?', 'AND', 'OR', '(...)'];

/**
 * 条件里的**列名 → 记录字段名**对照（全仓唯一一份两份命名法之间的翻译）。
 *
 * 为什么需要它：`opts.where` 是 SQL 形状的（列名 `account_id`，由 `kbVisibleWhere()` 产出、直接发给 MySQL），
 * 而记录是**中性字段名**的（`accountId` —— `server/storage/index.js` 的 FIELDS 定的，`mysql.js` 的 COLS
 * 就是干这个映射的）。本后端不碰 SQL，所以只能在这一层把两份命名法对上：**只映射这两个调用方真正会用到的列**
 * （`kbVisibleWhere` 与 `GET /api/knowledge`），**别的列一律抛**（见 colKey）—— 悄悄按同名去比，
 * 结果是"条件恒不成立 ⇒ 一条都搜不到"，那比报错难查得多。
 * 管理面的条件带表别名（`k.account_id=?`），别名在编译时先被剥掉，所以这里不用列 `k.` 前缀。
 */
const COL_ALIAS = { account_id: 'accountId', shell_id: 'shellId', conversation_id: 'conversationId', scope: 'scope', status: 'status', kind: 'kind' };

function colKey(col, where) {
  const raw = String(col).includes('.') ? String(col).split('.').pop() : String(col);
  const key = COL_ALIAS[raw];
  if (!key) throw unsupported('列名 ' + JSON.stringify(raw) + '（没有"列名→记录字段名"的映射）', where);
  return key;
}

function unsupported(what, where) {
  const e = new Error('kbsearch/like 不支持的可见范围形态：' + what + '（在 ' + where + ' 里）——本后端不做 SQL 解析，'
    + '支持的形态只有 ' + CONDITIONS_SUPPORTED.join(' ') + '；看不懂就当没有条件会把别人的私有条目搜出来，所以如实抛错');
  e.code = 'KB_LIKE_UNSUPPORTED_CONDITION';
  return e;
}

/** 比较用的归一：类型不同（数字 vs 数字串）时按字面量比会得出假结论。 */
const num = (v) => Number(v);
const isNum = (v) => v !== null && v !== '' && Number.isFinite(num(v));
function eq(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (isNum(a) && isNum(b)) return num(a) === num(b);
  return String(a) === String(b);
}
/** `<=>`：NULL 安全等（MySQL 的 `shell_id<=>?` —— 两边都 NULL 才算命中，照它的语义来）。 */
function nullSafeEq(a, b) {
  const an = a === undefined ? null : a;
  const bn = b === undefined ? null : b;
  if (an === null || bn === null) return an === null && bn === null;
  return eq(an, bn);
}

// 词法：把 where 串切成 token。只认两种 token —— 标识符（含 . 前缀）与结构字符。
// 值位置上的 `"…"` / `'…'` 由标识符规则一并吞掉（引号内允许空格，例如 status="active"）。
const RE_TOKEN = /([A-Za-z_][A-Za-z0-9_.]*<=>)|([A-Za-z_][A-Za-z0-9_.]*=)|([()])|([A-Za-z_][A-Za-z0-9_.]*)|("[^"]*")|('[^']*')|(\?)|(\s+)|(.)/g;

function tokenize(s) {
  const out = [];
  RE_TOKEN.lastIndex = 0;
  let m;
  while ((m = RE_TOKEN.exec(s)) !== null) {
    if (m[0].trim() === '') continue;                       // 空白
    if (m[1]) { out.push({ t: 'op', op: '<=>', col: m[1].slice(0, -3) }); continue; }
    if (m[2]) { out.push({ t: 'op', op: '=', col: m[2].slice(0, -1) }); continue; }
    if (m[3]) { out.push({ t: m[3] }); continue; }
    if (m[4]) { out.push({ t: 'ident', v: m[4] }); continue; }
    if (m[5] || m[6]) { out.push({ t: 'lit', v: (m[5] || m[6]).slice(1, -1) }); continue; }
    if (m[7]) { out.push({ t: 'ph' }); continue; }
    throw unsupported(JSON.stringify(m[8]), s);
  }
  return out;
}

/**
 * 把 where 串编译成一个谓词 `(row, params) => boolean`。
 *
 * 文法（只有这么多，多一种都不认）：
 *   expr   := term (OR term)*
 *   term   := factor (AND factor)*
 *   factor := '(' expr ')' | cond
 *   cond   := col ('=' | '<=>') ( '?' | '字面量' )
 *
 * `?` 按出现顺序从 `params` 里取（与 MySQL 的位置绑定同一个顺序）。
 */
export function compileWhereFn(where, params = []) {
  const src = scopeClause(where);
  if (!src) return () => true;                              // 空条件＝不加限制（照 fts 的 scopeClause 口径）
  const toks = tokenize(src);
  let i = 0;
  let paramIdx = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];

  function parseExpr() {
    let node = parseTerm();
    while (peek() && peek().t === 'ident' && /^or$/i.test(peek().v)) { take(); const r = parseTerm(); const l = node; node = (row, p) => l(row, p) || r(row, p); }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek() && peek().t === 'ident' && /^and$/i.test(peek().v)) { take(); const r = parseFactor(); const l = node; node = (row, p) => l(row, p) && r(row, p); }
    return node;
  }
  function parseFactor() {
    const tk = peek();
    if (!tk) throw unsupported('表达式意外结束', where);
    if (tk.t === '(') { take(); const node = parseExpr(); const close = take(); if (!close || close.t !== ')') throw unsupported('括号没有闭合', where); return node; }
    return parseCond();
  }
  function parseCond() {
    const t = take();
    if (!t || t.t !== 'op') throw unsupported('这里应当是 `列=值`（实际是 ' + JSON.stringify(t && (t.v || t.t)) + '）', where);
    const { op, col } = t;
    const rhs = take();
    let want;
    if (!rhs) throw unsupported('`' + col + op + '` 后面缺值', where);
    if (rhs.t === 'ph') {
      const v = paramIdx < params.length ? params[paramIdx] : undefined;
      paramIdx += 1;
      want = v;
    } else if (rhs.t === 'lit' || rhs.t === 'ident') {
      want = rhs.v;
    } else {
      throw unsupported('`' + col + op + '` 右边的值形态', where);
    }
    const key = colKey(col, where);
    if (op === '<=>') return (row) => nullSafeEq(row && row[key], want);
    return (row) => eq(row && row[key], want);
  }

  const fn = parseExpr();
  if (i < toks.length) throw unsupported('多余的记号 ' + JSON.stringify((peek() || {}).v) + '（本后端不做任意 SQL 解析）', where);
  return fn;
}

/**
 * 检索（在**已读出的记录**上做匹配与排序）。
 *
 * @param {string} q 关键词（空白分词；空查询**不读介质**、直接如实返回空）
 * @param {object} opts
 *   · `storage` —— `server/storage/index.js` 的接口对象（用 `storage.knowledge.all(accountId)` 取记录）
 *   · `rows`    —— 夹具缝：直接给一批记录（给了就不走 storage）
 *   · `accountId` —— 取记录用（`kb_search` 侧＝`ctx.accountId`；管理面同理）
 *   · `where` / `params` —— 可见范围谓词（**由 `kbVisibleWhere()` 产出**，本实现按上面的文法求值）
 *   · `limit`（缺省 8）/ `snippet`（缺省 1200；0/负数＝不截断）—— 与 fts 同口径
 *   · `includeHistorical` —— 与 fts 同名同义：缺省只认 `status='active'`
 * @returns {Promise<{items:Array, mode:'like'|'empty', backend:string, degraded:boolean, detail:string}>}
 */
export async function search(q, opts = {}) {
  const like = toLikePattern(q);
  if (like === '%%') {                                      // 与 fts 的空查询判据同一条（toBooleanQuery 为空）
    return { items: [], mode: 'empty', backend: id, degraded: true, detail: '空查询：未执行检索' };
  }
  const rows = await loadRows(opts);
  const where = scopeClause(opts.where);
  const scopeFn = compileWhereFn(opts.where, Array.isArray(opts.params) ? opts.params : []);
  const statusGuardFn = (opts.includeHistorical || /(^|[\s(])status\s*=/.test(where)) ? null : (row) => eq(row && row.status, 'active');
  const needle = like.slice(1, -1);                          // 与 toLikePattern 的同一形态：词间 `%` 连接的那一串

  const scored = [];
  for (const row of rows) {
    if (!scopeFn(row, opts.params)) continue;
    if (statusGuardFn && !statusGuardFn(row)) continue;
    const title = String((row && row.title) || '');
    const body = String((row && row.body) || '');
    const hits = countOf(title, needle) + countOf(body, needle);
    if (hits > 0) scored.push({ row, hits });
    else if (title.includes(needle) || body.includes(needle)) scored.push({ row, hits: 1 });
  }
  scored.sort((a, b) => (b.hits - a.hits) || (Number(b.row.id) - Number(a.row.id)));

  const limit = limitOf(opts);
  const items = scored.slice(0, limit).map(({ row, hits }) => toItem(row, opts, hits));
  return {
    items, mode: 'like', backend: id, degraded: true,
    detail: '纯 JS 子串匹配（本机没有 FULLTEXT 索引，或部署方显式选了本实现）：词间 % 连接后整串子串匹配，'
      + '按命中次数降序（标题与正文同权，没有介质给的相关度）',
  };
}

/**
 * 本后端就绪吗：不需要索引、不需要库 —— 只需要一个**记录来源**（storage 或夹具给的 rows）。
 * 照 fts 的 probe 口径：报事实、**不抛**。
 */
export async function available(opts = {}) {
  const out = { available: false, backend: id, engine: 'js-in-memory', index: null, indexType: null, detail: '' };
  const hasStorage = !!(opts.storage && opts.storage.knowledge && typeof opts.storage.knowledge.all === 'function');
  const hasRows = Array.isArray(opts.rows);
  out.available = hasStorage || hasRows;
  out.detail = out.available
    ? '按需从存储接口读记录、在内存里子串匹配（无索引；mode 恒为 like、degraded 恒为 true）'
    : '既没有 opts.storage（存储接口）也没有 opts.rows（夹具缝）⇒ 拿不到任何记录，检索不可用';
  return out;
}

/** 取记录：给了 rows 就用 rows（夹具缝），否则走存储接口；都没有＝**编程错误**，如实抛。 */
async function loadRows(opts) {
  if (Array.isArray(opts.rows)) return opts.rows;
  const st = opts.storage;
  if (!st || !st.knowledge || typeof st.knowledge.all !== 'function') {
    throw new Error('kbsearch/like.search 需要 opts.storage（存储接口的 knowledge.all）或 opts.rows（夹具缝）——'
      + '本后端不碰 SQL，拿不到记录就没法检索；不静默返回空数组（空结果与"没搜"在调用方那里长得一样）');
  }
  const all = await st.knowledge.all(opts.accountId);
  return Array.isArray(all) ? all : [];
}

/** 出现次数（非重叠；`needle` 为空时按 0 处理，避免死循环）。 */
function countOf(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i < 0) return n;
    n += 1;
    at = i + needle.length;
  }
}

function limitOf(opts) {
  const n = Number(opts.limit === undefined ? 8 : opts.limit);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
}

/** 行 → 对外条目。形状与 fts 的 toItem **逐字段相同**（多一个 `score`＝命中次数，标成 score 而不是假装相关度）。 */
function toItem(r, opts, hits) {
  const snip = opts.snippet === undefined ? 1200 : Number(opts.snippet);
  const body = String(r.body || '');
  return {
    id: r.id,
    scope: r.scope,
    title: r.title,
    body: (Number.isFinite(snip) && snip > 0 && body.length > snip) ? body.slice(0, snip) : body,
    createdAt: r.createdAt,
    score: hits,
  };
}
