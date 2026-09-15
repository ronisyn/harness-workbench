// test/boundary-dimensions.test.mjs - v0.3 §6.2「边界铁律」四个维度的机检
//
// 铁律原文（`proposals/RW-Agent引擎架构优化方案-v0.3.md` §6.2 :321）：
//   「**引擎里不允许出现任何平台专属的东西（路径、库名、账号、页面）。**」
// 原文括号里是**四维**。此前只有第一维有机检——`test/portability.test.mjs` 扫 `server/` 下全部 `.js`
// 的 `/srv/` / `/tmp/` / `systemctl` / `'/bin/bash'`（"只覆盖一维"就是指它）。
// 库名 / 账号 / 页面三维没有任何机检 ⇒ 这一维之外的东西坏掉了也不会有人知道。
//
// **为什么新起一份而不是塞进 portability.test.mjs**（两句）：
//   ① portability 那份管的是"同一份代码在 Linux 与 Windows Server 上都跑得通"（D2′ 客户机交付，
//      口径是**跨平台**）；本份管的是"引擎层不许混进平台专属物"（口径是**分层**）。两者判据不同、
//      白名单不同、坏掉时的处置也不同（一个是"改路径来源"，一个是"把东西搬回平台层"），混在一份里
//      会让"哪条红了该动什么"变得要靠读代码才知道。
//   ② 本份的负例夹具要在**临时目录**里合成"坏引擎"（见文末 §5/§6），portability 那份的既有夹具体量已经不小。
//
// 夹具分五段：§1–§4 对**真源码**跑四维判据；§5 用合成源码做反向核对与对照组（每一维都必须能报红，
// 且合规写法不许误伤）；§6 再走一遍**真文件 + 真目录遍历**的磁盘路径（临时目录里植入/还原）。
//
// ─── 判什么、不判什么（判据设计）─────────────────────────────────────────────
//   §1 库名维：引擎不许**写死库名**。唯一合法出处＝`config.js` 里那一句带环境变量默认值的
//              `env('DB_NAME', 'rw_dev')`（它自己就是"配置默认值"，不是"写死的库名"）；其余任何
//              地方出现 `'rw_dev'` / `'rw_prod'` / `'rw_test'` 字面量 ⇒ 红。取库名只有一条路
//              `config.db.name`（`server/db.js:11` 已经这么用），`information_schema` 侧的
//              `DATABASE()`（`db.js:657`、`kbsearch/fts.js:99`）也合规（那是"当前库"，不是写死的名字）。
//   §2 账号维：引擎不许**写死账号/用户名**。我们自己的 admin 默认值确实必须存在（首次启动要种一个
//              管理员），但它走**既有配置路径**（`config.admin.user` ← `RW_ADMIN_USER`）。所以判据是
//              "账号标识符的取值来源必须是配置"，白名单里逐条写明为什么那一条不算写死。
//              **不判** `role='admin'` / `INSERT … 'user'`：那是**角色名与 schema 默认值**（`accounts.role`
//              列定义里就有 DEFAULT 'user'），不是某个具体账号；把它也算进去只会逼着人到处写豁免。
//   §3 页面维：**只判"引擎里长出对客页面所需的逻辑/数据"**，不判"引擎自己带一个管理台入口"。
//              具体标记三类：市场页专用面（`/api/market/*`、`market_snapshot`、`llm/market.js`）、
//              页面的数据层（`price_table`——建了表却全仓无一处引用，性质是"给定价页留的位"）、
//              以及"引擎自己渲染 UI / 直接渲染页面"（`res.render` / JSX / 组件库 import）。
//   §4 定价维：**只判"对客定价与售卖呈现"**（`元/M`、`元每百万` 这类按量计价话术）。
//              **不判**成本计量的单价常量（`server/llm/gateway.js:9` 的 `PRICE`、`db.js:296` 的
//              `price_table`）：§4.6 要求引擎管预算、§4.8 要求"账本落账在引擎"，计量必需的单价是
//              引擎自己的成本口径；§6.2 那格的"定价"指的是"对客售卖呈现"（主导架构师 2026-09-16 判定）。
//
//   **两者为什么必须区别对待**（这是 §3/§4 判据的根，不是措辞问题）：
//     · 单价常量（`PRICE`）描述的是**我们付给厂商多少**——它只往账本（`usage_stats.cost`）与预算
//       护栏里走，读者是引擎自己（`calcCost`），删掉它 C1–C4 与预算护栏全部失去度量单位 ⇒ 属于
//       §4.6/§4.8 明确要求引擎承担的成本计量。
//     · 对客售卖呈现描述的是**客户要付多少 / 能买什么**（价目展示、售卖话术、下单入口）——它的读者
//       是客户，属于 §6.2 表里"产品/交付"那一行的"报价"、以及"平台"那一行的"造包/发版/可选管理"。
//     同一串数字（比如 2.3 元/M）放错读者就换了归属：**按"读者是谁"判，不按"数长什么样"判**。
//     所以 §4 的标记只看"呈现话术"，不看数字。
//
//   白名单纪律（照 `test/portability.test.mjs` 的既有风格并**收紧一格**）：**每一条放行都必须写出理由**，
//   且必须**按代码片段指名**（`snippet`）——**不许整份文件放行**（那等于给整个文件开豁免：以后往同一个
//   文件里再加一个市场接口就不会报红了）。指名之外的地方出现同样的东西一律报红。
//   用片段而不是行号，是因为引擎源码当前有多个代理在飞（`server/index.js` 在这几小时里挪过两次行）：
//   行号锚点会因为**别人的无关改动**失效，那时夹具报的是"白名单过期"，读的人得先排除"是不是判据坏了"
//   ——拿纪律换噪音不划算。片段锚点不受挪行影响，纪律一点没松：某处代码被搬走 ⇒ 该条目认领不到东西 ⇒
//   夹具报"该条划掉了"，不会留一条永远为真的豁免。reason 里写"【在案反例】"的＝**在案的欠账**，不是许可。
//
//   本份**只读不写**：不碰 `server/**`，不启服务，不调模型，不改任何既有夹具。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

// ---------- 判据（每个维度一组具名规则；每条规则一个"为什么") ----------
const DIMENSIONS = [
  {
    id: 'db-name',
    cn: '库名维',
    why: '§6.2：引擎里不允许出现写死的库名。库名的唯一出处＝配置（DB_NAME → config.db.name）',
    rules: [
      {
        id: 'db-name-literal',
        // 库名字面量。口径取仓库既有命名（`.env.example:8` 的"三环境隔离：DEV 本地 / TEST rw_test / PROD rw_prod"）：
        // 形态恒为 rw_<环境>，且**值里必带下划线**——这正是它跟列名/表名/角色名（`pass_hash`、`rw_app` 之外的
        // 短标识）区分得开的地方。只认**带引号的字面量**：`DB_NAME` 这个键名、`config.db.name`、`DATABASE()`
        // 都是"取配置/当前库"，不是写死。同理不认 `rw_app`（那是**用户名**，归账号维）与 `rw-jobs`（目录名）。
        res: [/'rw_(dev|prod|test|stage)'/g, /"rw_(dev|prod|test|stage)"/g],
        what: '写死的库名',
        fix: '改为从 config.db.name 取（唯一出处见 server/config.js:37）；建库/选择库是部署动作，不进引擎源码',
      },
    ],
  },
  {
    id: 'account',
    cn: '账号维',
    why: '§6.2：引擎里不允许出现写死的账号。我们自己的 admin 默认值走配置路径（RW_ADMIN_USER → config.admin.user）',
    rules: [
      {
        id: 'account-sql-literal',
        // SQL 里把账号名当字面量比。故意用**反向引用**要求两侧引号一致，免得把 `username=?` 之类误判。
        res: [/\busername\s*=\s*(['"])([^'"]+)\1/g],
        what: 'SQL 里写死的账号名',
        fix: '账号标识符必须来自配置（config.admin.user）或入参，不许把某个具体账号写进查询',
      },
      {
        id: 'account-value-literal',
        // 取值赋给 username（对象字段 / 具名参数）。两个**负向前瞻**是实测出来的（草稿里没有它们，
        // 于是把 `storage/mysql.js:23` 的列名映射 `{ username: 'username', passHash: 'pass_hash', … }`
        // 判成了"写死账号"——那是**列名**，是 schema 词汇，不是账号）：
        //   ① `(?!username\1)`：值恰好等于键名 ⇒ 列名映射；
        //   ② `(?!\w*_)`：值里带下划线 ⇒ 是 `pass_hash` 那类列名（真账号名不会长这样）。
        // 没有这两条就会逼着人给"schema 词汇"开豁免，门禁会因此变松——所以修的是判据，不是加白名单。
        res: [/\busername\s*[:=]\s*(['"])(?!username\1)(?!\w*_)([^'"]*)\1/g],
        what: '把账号名写成字面量',
        fix: '账号名从 config.admin.user 取；夹具里的账号名应来自夹具自己造的入参',
      },
      {
        id: 'account-config-default',
        // 认的是**配置那一句的形状**：`env('RW_ADMIN_USER', '…')`。
        // ⚠️ 这里不能用 `\bRW_ADMIN_USER\b` —— 草稿里那样写过，实测恒不匹配：JS 的 `\b` 只认 `\w`
        //    （字母/数字/下划线），而 `_` 本身是 `\w` ⇒ 名字以 `_` 结尾时右边没有"词边界"，正则永远为假。
        //    那种写法会得出"账号维零命中"的假绿（门禁看着在跑，其实一条都没扫到）。用非 `\w` 前瞻代替。
        res: [/\benv\(\s*['"]RW_ADMIN_USER['"]\s*,\s*['"]([^'"]+)['"]/g, /\bRW_ADMIN_USER(?![A-Za-z0-9_])['"]?\s*[,:=]\s*['"]([^'"]+)['"]/g],
        what: 'admin 账号默认值写死在配置之外',
        fix: 'admin 账号默认值只许留在 config.js 的 env() 默认值那一处，其余地方读 config.admin.user',
      },
    ],
  },
  {
    id: 'page',
    cn: '页面维',
    why: '§6.2：引擎里不允许出现对客页面所需的逻辑与数据（模型广场页是平台侧的东西）',
    rules: [
      {
        id: 'page-market',
        // 市场页的专用面：它的接口（/api/market/*）、它的数据层（market_snapshot 表）、它的实现模块。
        // 模型接入本身（providers.js / gateway.js）**不在此列**——那是引擎的模型接入面，§6.2 明列在引擎格。
        res: [/\/api\/market\//g, /\bmarket_snapshot\b/g, /llm\/market/g],
        what: '模型市场页的专用接口/数据层',
        fix: '市场发现与勾选接入是"可选管理与汇总"（§6.2 平台格），应搬到平台侧；引擎只留模型接入面',
      },
      {
        id: 'page-pricing-surface',
        // 页面的数据层：`price_table`（对客价目表）。与 §4 的成本计量分开判——这里判的是"给页面留的位置"，
        // 依据是它**全仓无一处引用**（死表）：活着的成本计量表会出现在查询里，孤零零一张建表语句只会是"页面还没做"。
        res: [/\bprice_table\b/g],
        what: '对客价目页的数据层（建表无引用）',
        fix: '价目/报价是产品面的东西；成本计量用的是 gateway.js 的 PRICE 与 usage_stats.cost，不需要对客价目表',
      },
      {
        id: 'page-render',
        // "引擎在服务端渲染 UI / 引入前端组件"。**故意不写 /.jsx/ 与 /\bjsx\b/**：草稿里那样写过，
        // 实测误报 4 处——`tools/repomap.js` 的扩展名清单（SRC_EXT / LANG_SYM 的 `.jsx`）与
        // `tools/index.js:374` 的搜索扩展名正则都是**代码检索工具在认文件类型**，跟渲染无关；
        // 判据要判的是"引擎自己把 UI 画出来"，那就只留真正的渲染信号。
        // `React.createElement` 是落点：本仓前端若被搬进引擎，最先出现的就是它（客户端插件指令也同口径）。
        res: [/res\.render\s*\(/g, /\brenderToString\b/g, /\brenderToStaticMarkup\b/g, /from\s+['"]react(-dom)?['"]/g, /require\(\s*['"]react(-dom)?['"]\s*\)/g, /\bReact\.createElement\b/g],
        what: '引擎在服务端渲染 UI / 引入前端组件',
        fix: '页面归平台壳（本仓是 src/ 下的 React 应用 + web/dist 静态产物）；引擎只出数据与事件',
      },
    ],
  },
  {
    id: 'pricing',
    cn: '定价维',
    why: '§6.2：引擎里不允许出现对客定价与售卖呈现（成本计量必需的单价保留，见文件头 §4 判据）',
    rules: [
      {
        id: 'pricing-language',
        // 只认"按量计价的呈现话术"。不认裸数字，也不认 ¥ 单符号——预算护栏对模型说的话里本来就有 `¥`
        // （agent.js:350/519/643），那是 §4.6 要求的成本护栏，判它会把合规定实现判红。
        res: [/元\s*\/\s*M/g, /元\s*每\s*百\s*万/g, /按量计费/g, /计费单价/g],
        what: '对客定价话术',
        fix: '对客价目/计价话术归平台与产品面；引擎只上报 token 与成本（v0.3 §4.8 账本在引擎、对账在平台）',
      },
    ],
  },
];

// ---------- 白名单：每一条都必须写理由；每一条都必须**指名到具体那处代码** ----------
// `snippet` 的语义：允许**含这个片段的那一行**（把这段代码搬走＝把这条划掉）。用片段而不是行号，是因为
// 引擎源码当前有多个代理在飞（`server/index.js` 这几小时里挪过两次行）：行号锚点会因为**别人的无关改动**
// 而失效，那时夹具报的是"白名单过期"，读的人得先排除"是不是我判据坏了"——那是拿纪律换噪音。
// 片段锚点不受挪行影响，而纪律一点没松：**不许用 file 级的整份放行**（那等于给整个文件开豁免，
// 以后往文件里加市场接口就不会报红了）；每一处都要单独点名 + 单独写理由。
// `until` 的语义：这条放行在什么条件下应当被划掉。写 null＝不预期消失。
// ⚠️ reason 里带"【在案反例】"的＝**在案的欠账**，不是许可：它们就是本次要报告给主导架构师的东西。
const ALLOW = {
  'db-name-literal': [
    {
      path: 'server/config.js', snippet: "env('DB_NAME', 'rw_dev')", reason: '配置默认值这一处：`env(\'DB_NAME\', \'rw_dev\')` 是"不配也能跑"的默认名，取值本身仍由 DB_NAME 决定（`.env.example:8` 写明三环境隔离 DEV/TEST rw_test/PROD rw_prod）。这正是"库名的唯一出处"，也是 §1 判据的锚点。', until: null,
    },
  ],
  'account-sql-literal': [],
  'account-value-literal': [],
  'account-config-default': [
    {
      path: 'server/config.js', snippet: "env('RW_ADMIN_USER', 'Ronisyn')", reason: 'admin 账号默认值：首次启动要种一个管理员（`auth.js:ensureAdmin`），而干净机器上还没有 `.env` ⇒ 必须有一个默认名。取值仍以 RW_ADMIN_USER 为准（现行部署 .env 里就是它）。', until: '客户机首次安装改由部署脚本注入 RW_ADMIN_USER 时，划掉这条并删掉默认值',
    },
  ],
  'page-market': [
    {
      path: 'server/index.js', snippet: "app.get('/api/market/list'", reason: '【在案反例，不是在案许可】`GET /api/market/list` —— 引擎里长出"模型广场页"的读口。已判定它属于 §6.2 平台格的"可选管理与汇总"（模型广场页在"不该出现"一列），拆分方案待主导架构师拍板，故此处只登记不搬。', until: '市场面搬去平台侧时，连同 ALLOW 里其余 market/价目条目一起划掉',
    },
    {
      path: 'server/index.js', snippet: "app.post('/api/market/refresh'", reason: '【在案反例】页面上"刷新市场"按钮就是这个口（触发对四家聚合平台的外呼）。', until: '同上',
    },
    {
      path: 'server/index.js', snippet: "app.post('/api/market/connect'", reason: '【在案反例】页面上"勾选接入"的写口（会写 providers/models 两张表）。', until: '同上',
    },
    {
      path: 'server/index.js', snippet: "from './llm/market.js'", reason: '【在案反例】入口对市场模块的 import —— 上面三个口都是从这一行牵进来的。', until: '同上',
    },
    {
      path: 'server/llm/market.js', snippet: 'INSERT INTO market_snapshot', reason: '【在案反例】市场页逻辑层的快照写入（`server/llm/market.js:42-59`）。该文件 124 行里没有一行属于引擎运行时。', until: '同上（整份文件搬走）',
    },
    {
      path: 'server/llm/market.js', snippet: 'market_snapshot ORDER BY source, model_id', reason: '【在案反例】市场页逻辑层的列表读（`marketList()`：按源分组 + 已接入标记，纯页面语义）。', until: '同上',
    },
    {
      path: 'server/llm/market.js', snippet: 'FROM market_snapshot WHERE source=? AND model_id=?', reason: '【在案反例】"勾选接入"时回读快照取名/领域（`connectModels()`）。', until: '同上',
    },
    {
      path: 'server/db.js', snippet: 'CREATE TABLE IF NOT EXISTS market_snapshot', reason: '【在案反例】市场页的数据层（表清单）。注：本条不构成改 db.js 的授权——该文件当前由别的代理在飞。', until: '同上',
    },
  ],
  'page-pricing-surface': [
    {
      path: 'server/db.js', snippet: 'CREATE TABLE IF NOT EXISTS price_table', reason: '【在案反例】对客价目页的数据层。**全仓无一处引用**（除本条建表；实测 `grep price_table server/ scripts/` 只命中 db.js 这一处）⇒ 它不是活着的成本计量表，是"页面还没做"留下的位。', until: '市场/价目面搬去平台侧时一并划掉',
    },
  ],
  'page-render': [],
  'pricing-language': [],
};

// ---------- 扫描实现 ----------
/** 全部规则（拍平），每条都带上它属于哪一维——`dim` 是**后加**的字段，不许覆盖规则自己的 `res`。 */
const ALL_RULES = DIMENSIONS.flatMap((dim) => dim.rules.map((r) => ({ ...r, dim })));
const RULE_INDEX = new Map(ALL_RULES.map((r) => [r.id, r]));
// 规则表自身的形状检查在模块加载时就做：`res` 少写一层数组的错，不许拖到"运行期 TypeError"才显形
// （那样报出来的是一行栈，看不出是哪条规则写坏了；早期草稿就踩过这一脚）。
for (const r of ALL_RULES) {
  if (!Array.isArray(r.res) || r.res.length === 0 || r.res.some((x) => !(x instanceof RegExp))) {
    throw new Error(`判据写坏了：规则 ${r.id} 的 res 必须是非空 RegExp 数组`);
  }
  if (!r.what || !r.fix) throw new Error(`判据写坏了：规则 ${r.id} 缺 what/fix`);
}

/** 剥注释（CRLF 先归一：`//` 的 `$` 在 CRLF 文本里匹配不到行尾，会把注释掉的提及算成真引用）。
 *  返回 `[[行号, 该行代码], …]` —— 页面的 `res.render` 是"行内是否出现"，按行判比按整份判更准。 */
function stripComments(src) {
  return src.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l, i) => [i + 1, l.replace(/\/\/.*$/, '')]);
}

/** 收集 `{file, rule, line, text, what, fix}`。`files` = `[[相对路径, 源码], …]`（内存扫描，夹具可合成）。
 *  `text` 是**剥注释后**的那一行：白名单按片段认领命中时用它，也就自然继承了"注释里的提及不算数"。 */
export function scanSource(files, only) {
  const out = [];
  for (const [rel, src] of files) {
    for (const rule of ALL_RULES) {
      if (only && rule.id !== only) continue;
      for (const [n, line] of stripComments(src)) {
        for (const re of rule.res) {
          re.lastIndex = 0;
          if (!re.test(line)) continue;
          out.push({ file: rel, rule: rule.id, line: n, text: line.trim(), what: rule.what, fix: rule.fix });
          break; // 同一行同一规则只记一次
        }
      }
    }
  }
  return out.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
}

/** 扫一棵目录树（只 `.js`）。排除清单只放"不是引擎源码"的东西：node_modules 与夹具自己。 */
export function scanFiles(dir, opts = {}) {
  const exclude = new Set(opts.exclude || ['node_modules']);
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!exclude.has(e.name)) walk(p); continue; }
      if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(dir);
  const base = opts.base || dir;
  return scanSource(files.map((p) => [path.relative(base, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8')]), opts.only);
}

/** 白名单判定：按 **文件 + 代码片段** 认领命中（片段锚点不受挪行影响）。
 *  返回 `{ live, used }`：`live`＝没被认领的命中；`used`＝真的认领到东西的条目（键 `规则|路径|片段`）。
 *  一条命中由**第一条**匹配的条目认领；`used` 则把所有候选条目都记上——不然片段互为子串时（实测：
 *  `FROM market_snapshot` 是 `FROM market_snapshot WHERE source=?` 的子串），后一条会因为"已经被人认领"
 *  而永远记不上账，夹具就会报"该条目没认领到东西"，把人引向错误的方向去删一条其实有效的白名单。
 *  被认领的代码搬走/改掉之后，该条目不再被记入 `used` ⇒ 夹具报"该划掉了"（不许留永远为真的豁免）。 */
export function applyAllow(findings, allow) {
  const used = new Set();
  const live = findings.filter((f) => {
    const cands = (allow[f.rule] || []).filter((a) => a.path === f.file && a.snippet && f.text.includes(a.snippet));
    for (const a of cands) used.add(`${f.rule}|${a.path}|${a.snippet}`);
    return cands.length === 0;
  });
  return { live, used };
}

// ---------- §1–§4：门禁本体（对**真源码**跑） ----------
for (const dim of DIMENSIONS) {
  test(`§6.2 ${dim.cn}：${dim.why}`, () => {
    // 判据自检：规则表被清空/正则退化的门禁会变成"永远绿的假门"，先把它挡住
    assert.ok(dim.rules.length > 0, dim.cn + ' 的规则表不许为空（空表＝假门禁）');
    for (const r of dim.rules) assert.ok(r.res.length > 0 && r.fix, dim.cn + '/' + r.id + ' 必须带正则与处置说明');

    for (const r of dim.rules) {
      for (const a of ALLOW[r.id] || []) {
        assert.ok(typeof a.reason === 'string' && a.reason.trim().length >= 10, r.id + ' 的每条白名单都必须写明理由（≥10 字）：' + a.path);
        assert.ok(typeof a.snippet === 'string' && a.snippet.trim().length >= 8, r.id + ' 的白名单必须按**代码片段**指名（不许整份文件放行）：' + a.path);
        assert.ok(fs.existsSync(path.join(ROOT, a.path)), r.id + ' 的白名单指向了不存在的文件：' + a.path);
      }
    }

    const findings = scanFiles(SERVER, { base: ROOT }).filter((f) => dim.rules.some((r) => r.id === f.rule));
    const { live, used } = applyAllow(findings, ALLOW);

    // 白名单里"点了名却没认领到"的条目也是坏味道（东西已经搬走却忘了划掉 → 下一个人以为还有债）
    for (const r of dim.rules) {
      for (const a of ALLOW[r.id] || []) {
        assert.ok(used.has(`${r.id}|${a.path}|${a.snippet}`),
          `${r.id} 的白名单条目没有认领到任何东西（已经搬走 / 片段已改）——请重新核对并划掉：${a.path} ← ${a.snippet}`);
      }
    }

    assert.deepEqual(live.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.what} ← ${f.text.slice(0, 90)}`), [],
      dim.cn + '发现 §6.2 不允许的平台专属物（处置：' + (live[0] ? live[0].fix : '') + '）');
  });
}

// ---------- §5 反向核对：合成一份"坏引擎"，每一维都必须报红 ----------
// 用**合成源码**而不是"去改真源码再改回来"：真源码目录当前有多个代理在飞（server/index.js 等），
// 就地改真文件会踩到别人。合成的源码与真源码走**同一个扫描函数**，因此考的是真判据，不是考夹具自己。
const BAD = {
  // 故意**不用** `server/config.js` 这个路径：库名默认值与 admin 默认值的合法落点就是配置那一处，
  // 合成一份假的 config.js 只会考到白名单锚点（那是"夹具在考自己"）。真 config.js 由 §1/§2 的正向用例覆盖。
  'server/llm/probe-page.js': [
    `import { db } from '../db.js';`,
    `export const DEFAULT_DB = env('DB_NAME', 'rw_dev');`,               // db-name-literal
    `export const KEEP = { market_snapshot: 'market_snapshot' };`,      // page-market（值不是列名映射，必须命中）
    `export function routes(app) { app.get('/api/market/list', (q, s) => s.json({})); }`,
    `export const price = { rw_prod: 1 };`,                              // db-name-literal
    `export const admin = env('RW_ADMIN_USER', 'Ronisyn');`,             // account-config-default（配置外那一处）
    `export const who = { username: 'Ronisyn' };`,                       // account-value-literal
    `export const sql = "SELECT id FROM accounts WHERE username='Ronisyn'";`, // account-sql-literal
    `export const tab = 'price_table';`,                                 // page-pricing-surface
    `export const txt = '按量计费：2.3 元/M tokens';`,                    // pricing-language
    `export const v2 = '元每百万 tokens';`,                              // pricing-language
  ].join('\n') + '\n',
  'server/llm/render.js': [
    `export function page(res) { res.render('index', {}); }`,            // page-render
    `import React from 'react';`,                                        // page-render
  ].join('\n') + '\n',
  'server/llm/clean.js': [
    `// 注释里提到 'rw_prod'、/api/market/list、price_table、元/M、username='Ronisyn' 都不算数（先剥注释）`,
    `import { config } from '../config.js';`,
    `export const q = (db) => db.query('SELECT id FROM accounts WHERE username=?', [config.admin.user]);`,
    `export const dbName = config.db.name;`,
    `import { calcCost, PRICE } from './gateway.js';`,                   // 成本计量：必须**不**命中
    `export const c = calcCost('deepseek', { hit: 1, miss: 2, out: 3 });`,
  ].join('\n') + '\n',
  // 干净对照组里另外几类"长得像但其实合规"的写法：列名映射（storage/mysql.js:23 那种）与
  // 代码检索工具的扩展名清单（tools/repomap.js 的 SRC_EXT）——这两处都曾把我的草稿判红过。
  'server/llm/notes.js': [
    `export const COLS = { accounts: { username: 'username', passHash: 'pass_hash', role: 'role' } };`,
    `const SRC_EXT = new Set(['.js', '.mjs', '.jsx', '.ts', '.tsx']);`,
    `const isAt = { username: req.body.username };`,
  ].join('\n') + '\n',
};

const EXPECTED_BAD = [
  'db-name-literal|server/llm/probe-page.js',
  'account-sql-literal|server/llm/probe-page.js',
  'account-value-literal|server/llm/probe-page.js',
  'account-config-default|server/llm/probe-page.js',
  'page-market|server/llm/probe-page.js',
  'page-pricing-surface|server/llm/probe-page.js',
  'page-render|server/llm/render.js',
  'pricing-language|server/llm/probe-page.js',
];

test('§5 反向核对：合成的"坏引擎"里每一维都必须报红（不许有永远绿的假门）', () => {
  const found = scanSource(Object.entries(BAD));
  const got = found.map((f) => `${f.rule}|${f.file}`);
  for (const want of EXPECTED_BAD) assert.ok(got.includes(want), '这一维没报红（门禁失灵）：' + want + '；实际命中＝' + JSON.stringify(got));

  // 每一维都至少有一条被检出（不是"某维的规则整组没生效"）
  for (const dim of DIMENSIONS) {
    assert.ok(found.some((f) => RULE_INDEX.get(f.rule).dim.id === dim.id), dim.cn + ' 没有任何一条规则生效');
  }
});

test('§5 对照：干净的合成引擎不许报红——判据考的是"源码里真有什么"，不是"提没提到"', () => {
  const clean = scanSource([['server/llm/clean.js', BAD['server/llm/clean.js']], ['server/llm/notes.js', BAD['server/llm/notes.js']]]);
  assert.deepEqual(clean.map((f) => `${f.file}:${f.line} [${f.rule}] ← ${f.text.slice(0, 70)}`), [],
    '注释里提到的东西、config.db.name / config.admin.user / 列名映射 / 代码检索工具的扩展名清单 / gateway 的 PRICE·calcCost 都不该被算成违法');
});

test('§5 控制组：**引擎里已经被判干净的那部分**不许有误伤（判据只在白名单点名处生效）', () => {
  // 做法：拿真源码逐行跑判据，再问"这一行在白名单里被点名了吗"——判据只在点名处生效，
  // 别处出现同样的东西必须报红。所以这里不是"清理以后绿不绿"，而是"判据有没有误伤/有没有漏"。
  const res = scanFiles(SERVER, { base: ROOT });
  const { live, used } = applyAllow(res, ALLOW);
  // 判据精确性：所有命中都必须**恰好**落在白名单点名的那几处代码上 ⇒ `live` 必须为空。
  // 反过来，若哪天有人把"整份文件放行"加回来，这里也会立刻显形（那种放行会让 live 变空但 used 里
  // 混进一条没有 snippet 的条目——上面的形状检查会先拦住它）。
  assert.deepEqual(live.map((f) => `${f.file}:${f.line} [${f.rule}] ← ${f.text.slice(0, 80)}`), [],
    '引擎里除白名单点名的那些处之外，不该有任何一维命中（有的话＝判据误伤，或＝新长出来的平台专属物）');
  // 顺带把"拆反例要动哪些文件"钉在夹具里：全部落点就是 used 里那几条（白名单条目数＝落点数）
  const expectedSites = Object.values(ALLOW).flat().length;
  assert.equal(used.size, expectedSites, '白名单条目数应与实际落点数一致（used=' + used.size + '，条目=' + expectedSites + '）');
});

// ---------- §6 临时目录负例：**真文件 + 真目录遍历**（内存扫描之外再走一遍磁盘路径） ----------
test('§6 临时目录负例：塞进一个写死库名的模块 ⇒ 磁盘扫描必须报红；换回合规写法 ⇒ 复绿', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-boundary-'));
  try {
    const f = path.join(dir, 'planted.js');
    const write = (s) => fs.writeFileSync(f, s, 'utf8');

    write(`import { config } from '../config.js';\nexport const dbName = config.db.name;\n`);
    assert.deepEqual(scanFiles(dir), [], '合规写法不该报红');

    write(`export const dbName = 'rw_prod';\n`);
    const hit = scanFiles(dir);
    assert.deepEqual(hit.map((x) => x.rule), ['db-name-literal'], '写死库名必须报红');
    assert.equal(hit[0].line, 1);

    write(`import { config } from '../config.js';\nexport const admin = config.admin.user;\n`);
    assert.deepEqual(scanFiles(dir), [], '还原合规写法后必须复绿');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
