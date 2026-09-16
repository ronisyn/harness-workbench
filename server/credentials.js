// server/credentials.js - 凭据的**唯一访问路径**（C-18，2026-09-15）
//
// 为什么要有它（C-18 的事实）：`settings.mcp_servers[].env` 里**明文**存着 GitHub PAT。
// 出站虽有两层脱敏（`/api/settings` 的 redactMcpServers、审计的 redactSecrets），但脱敏只挡住
// 我们想得到的出口；`db_query` 是通用 SELECT，模型能绕开所有出口把明文读走 —— 只要明文在业务表里，
// 脱敏就永远差一层。所以真正的修法不是"再加一层过滤"，而是**让明文不落在业务表里**。
//
// 照 DSH 的做法（出处：`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-credentials-local`）：
//   · 单一访问路径：所有凭据读写都过这一个模块，业务侧配置里只留**引用**（名字），不留值；
//   · 单一存储：一份只装凭据的文档（DSH 放 `$DSH_HOME/.credentials.yaml`，README 明确
//     "The document holds nothing but credentials"——它不是 .env 的替身）；
//   · 只属主可读：文件按 0600 建，且**读到别人可读的文件就拒绝**（DSH `assertOwnerOnly`：
//     宁可报错让人 chmod，也不从一个全世界可读的文件里发凭据）；
//   · 每次操作现取、不跨操作缓存（DSH："Consumers resolve per operation… that read is the
//     hot-update mechanism"）——换钥匙下一轮就生效，不必重启；
//   · 空值等于没配：空串绝不冒充"已配置的密钥"（DSH："a blank never masquerades as a configured secret"）；
//   · 轮换＝往同一个文档里写新值（原子替换、旧值随即不可见）：DSH 口径是"下一次现取就拿到新值，不必重启、
//     不动配置文件"，写入本身是 `dsh-atomic-write` 的原子替换（"Atomic, not crash-durable"）——
//     所以不造版本链，见下方 `rotateSecret`（v0.3 §4.6 的"存放、引用、**轮换**"三件里最后那件）。
//
// 我们**不照搬**的三样（DSH 有、我们没有消费者，理由写在报告）：跨进程文件锁（单机 systemd 单进程）、
// 文件监视热重载（现取即可）、`records`（`<owner>/<id>` 授权凭据那一半）。
//
// 文档格式：一行一条 `NAME: 值`（NAME = POSIX 标识符，与 DSH 的 `CredentialRef` 文法相同）。
// 不引 YAML 依赖：我们的值就是 token/URL 这类不含换行的标量，行式格式更少依赖也更好排障。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { storage } from './storage/index.js'; // v0.3 §4.6「预算与审计：本地兜底」：审计写口走接口

/** 凭据文档位置：部署用 `RW_CREDENTIALS_FILE` 指定；默认放**平台目录**（`.env` 的同一层）。
 *  为什么是平台目录而不是 `$DSH_HOME`：我们的部署事实是"单机 Linux 服务 + systemd + `.env` 在平台目录"，
 *  凭据与它替代的那些配置同处一地，备份/权限/排障才是同一件事。 */
export function credentialsFile() {
  return process.env.RW_CREDENTIALS_FILE || path.join(config.root, '.credentials.yaml');
}

/** 凭据引用文法（= POSIX shell 标识符），与 DSH `credentialRef` 同一条正则。 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** settings 里显式引用记法：`__CRED__:NAME`。为什么不用裸名字：一个值形如 `TOKEN` 的**普通配置**与
 *  "引用名为 TOKEN 的凭据"在字符串上完全同形，只有显式前缀才让这件事没有歧义。
 *  （`__REDACTED__` 是 /api/settings 给前端看的占位符；`__CRED__:` 是我们给解析器看的，两者互不冒充。） */
export const CRED_PREFIX = '__CRED__:';
/** env 键名像密钥的判据（与 /api/settings 那条脱敏规则同形）。它在这里**不承担脱敏**——
 *  脱敏的根修是"明文不进业务表"；这条只回答一件事：老配置里这个键的值要不要当明文看待。 */
export const SENSITIVE_KEY_RE = /(token|secret|key|password|passwd|apikey)/i;
/** 构造 settings 里应存的引用值。 */
export const credRef = (name) => CRED_PREFIX + name;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/;
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
/** 组/其他权限位——0600 之外的任何一位都算越权。DSH 同一条判据（`mode & 63`，八进制即 077）。 */
const GROUP_OTHER_BITS = 0o077;

/**
 * 拒绝"属主之外也能读"的凭据文档：**在读内容之前**先查权限。
 * 只读不报错，等于把"0600"这个承诺作废——DSH 的口径是报错让人去 chmod，而不是照读。
 * Windows 没有 POSIX 模式可查（ACL 不是 mode）——照 DSH **跳过而不是伪造**。
 */
function assertOwnerOnly(file) {
  let st;
  // 2026-09-16（服务器 Linux 上跑出来的可移植性缺陷）：路径上挡着一个**非目录**的同名文件时，
  // `statSync` 抛的是 `ENOTDIR` 而不是 `ENOENT` —— 只认 ENOENT 就会让"凭据文档不存在"这条正常路径
  // 变成抛错，于是"写文档失败 ⇒ settings 一个字都不改"这条契约在 Linux 上被破坏（Windows 上恰好不抛）。
  // 两个 errno 都表示"这个文件现在读不到"，按同一个语义处理（后面写入时若真的写不了，会如实抛给调用方）。
  try { st = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
  if (process.platform === 'win32') return;
  if ((st.mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error('凭据文件 ' + file + ' 属主之外可读（mode ' + (st.mode & 0o777).toString(8) + '）；请先 chmod 600 ' + file);
  }
}

/**
 * 读凭据文档。不存在＝空 store（还没配过是正常状态，不是错误）；格式错**必须报错**而不是跳过那一行——
 * 静默跳过会把"我存了却没生效"变成查不出来的事（DSH 同口径：一切拒绝，不跳过）。
 * **本函数不导出**：它是唯一会一次性交出全部明文的地方，导出它等于在"单一访问路径"上开一个后门。
 */
function readStore() {
  const file = credentialsFile();
  assertOwnerOnly(file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return {}; throw e; }
  const out = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = ASSIGN_RE.exec(line);
    if (!m) throw new Error('凭据文件 ' + file + ' 第 ' + (i + 1) + ' 行格式非法（应形如 NAME: 值）');
    out[m[1]] = unescape(m[2]);
  }
  return out;
}

/**
 * 原子写：同目录临时文件 + rename（同文件系统内 rename 是原子的，"读到写了一半的文件"不存在）。
 * 权限在**创建时**就给 0600，不靠事后 chmod——事后 chmod 中间有一个窗口是宽权限。
 */
function writeStore(next) {
  const file = credentialsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = '# 平台凭据（C-18）。唯一访问路径 server/credentials.js。勿提交、勿手工扩散明文。\n'
    + Object.keys(next).sort().map((k) => k + ': ' + escape(next[k])).join('\n') + '\n';
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* 清理失败不得遮盖原错 */ } throw e; }
}

/** 项目 `.env` 的取值。保留这一层是承认事实：本机 `.env` 已在用，且平台的 DB_PASS/SESSION_SECRET
 *  就在里面——凭据查询不能对它视而不见（DSH 同样把 `.env` 作为最低一层回退）。 */
function dotenvValue(name) {
  let text;
  try { text = fs.readFileSync(path.join(config.root, '.env'), 'utf8'); } catch { return undefined; }
  const m = new RegExp('^' + name + '\\s*=\\s*(.*)$', 'm').exec(text);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/**
 * 取值。分层照 DSH：`env`（进程环境，**赢过**文件——`NAME=… node server` 是启动者的明确意图，
 * 而且从进程内部改不了它，所以只能"可见地只读"）> `file`（我们的托管存储）> `dotenv`（`.env` 回退）。
 * 空串一律等于没配（DSH："an empty stored value is absent everywhere"）。
 */
export function getSecret(name) {
  if (!CREDENTIAL_REF_RE.test(String(name))) throw new Error('凭据名非法（须为 POSIX 标识符）：' + name);
  if (process.env[name]) return process.env[name];
  const stored = readStore()[name];
  if (stored) return stored;
  return dotenvValue(name) || undefined;
}

/** 一个引用当前的状态——**永远不含值**（DSH `describe()` 的契约：配置界面靠它显示徽标）。 */
export function describeSecret(name) {
  if (process.env[name]) return { name, configured: true, source: 'env', writable: false };
  if (readStore()[name]) return { name, configured: true, source: 'file', writable: true };
  if (dotenvValue(name)) return { name, configured: true, source: 'dotenv', writable: true };
  return { name, configured: false, source: null, writable: true };
}

/** 只列名，不列值。DSH 的引用半边没有枚举（名单由 settings schema 提供）；我们的名单就是文档里的键。 */
export function listSecretNames() {
  return Object.keys(readStore()).sort();
}

/** 写入（唯一写路径）。**空值拒绝**：空串不是"已配置的密钥"，要撤就删那一行——
 *  否则 `describe` 会把空串报成已配置，`resolveEnv` 也会把空串当钥匙发出去。 */
export function setSecret(name, value) {
  if (!CREDENTIAL_REF_RE.test(String(name))) throw new Error('凭据名非法（须为 POSIX 标识符）：' + name);
  if (typeof value !== 'string' || value.length === 0) throw new Error('凭据 ' + name + ' 的值不得为空（要撤销请删除该行）');
  if (process.env[name]) {
    throw new Error('凭据 ' + name + ' 由启动环境提供（只读），写入会被它遮蔽；请先在启动它的 shell 里取消该变量');
  }
  writeStore({ ...readStore(), [name]: value });
  return { name, source: 'file' };
}

/** 删除一行。本来就没有＝无事发生。 */
export function unsetSecret(name) {
  const store = readStore();
  if (!(name in store)) return { name, removed: false };
  delete store[name];
  writeStore(store);
  return { name, removed: true };
}

/**
 * 值的短指纹：`sha256(值)` 的前 8 位十六进制。**它不是校验和，也不是加密**——只回答一件事：
 * "这次换的钥匙与上次是不是同一把"。轮换之后想核对"到底换没换"，手上不会有旧值，只会有上一次的指纹。
 * 为什么是 8 位：够短才便于人眼对账（账本 detail 里一行就能放下），而它的用途只有比对，不参与任何鉴权。
 * 已知边界（如实记）：对**低熵**的值（人手设的口令）8 位十六进制的哈希可被离线穷举；所以它只随轮换返回值
 * 与审计账本出现，不进配置、不进提示词、不进会话。
 */
export function secretFingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

/**
 * 轮换（v0.3 §4.6 保障面「客户系统凭证的存放、引用、**轮换**」——存放/引用见上文，2026-09-16 补的就是这一档）。
 *
 * 为什么轮换只有"写新值"这一步（不造密钥版本链、不接 KMS、不排生效期）：照 DSH `dsh-credentials` 的口径——
 * README：「A rotated stored key applies to the next request **without a restart or configuration edit**」
 * 「rotating a secret **touches no configuration file**」；写入走 `dsh-atomic-write`，该包 README 的
 * Known Limitations 明写「**Atomic, not crash-durable**」。这三句落到我们这边正好三条：
 *   ① **单一路径**：本函数就是 `setSecret`（同一写入路径）——名字文法、空值拒绝、env 遮蔽只读、原子写
 *      全部复用，没有第二套轮换专属规则（两条路径就会有两套边界，边界一多必有一条是错的）；
 *   ② **原子替换**：`writeStore` 是同目录临时文件 + rename，"读到写了一半的文件"不存在，
 *      所以"先写新值成功、旧值才不可见"是**构造保证**的——不需要一个"作废旧值"的中间步骤，
 *      "中间态不可用"这个窗口在 rename 语义下压根不存在（夹具 `credentials-rotate` 锁住"写失败时旧值仍可用"）；
 *   ③ **旧值不再可见**：`getSecret` 每次现取、不跨操作缓存（同上 README：「Consumers resolve per operation…
 *      that read is the hot-update mechanism」）⇒ 换完下一轮就是新值，没有缓存要作废，
 *      也就没有"旧值还可能被谁拿着"的清单要维护。
 * 为什么不做"版本链"：DSH 没有，我们也没有第二个使用者——回滚需求（"换错了要换回去"）由**再轮换一次**满足，
 * 而保留历史值等于把明文多留几份，与 C-18"明文不进业务表、只留一份托管存储"的方向相反。
 *
 * 失败语义（顺序即安全性）：
 *   · 写不进去 → **原样抛错**，旧值仍在、仍可用（`.credentials.yaml` 一个字没动）；此时**不落账**
 *     （"没换成功"不该在审计里留下换过的痕迹）；
 *   · 落账失败 → **不改判轮换结果**（钥匙确实已经换了；报失败会让人以为没换而复跑一次），但必须出声。
 *
 * @param {string} name 凭据名（须为 POSIX 标识符）
 * @param {string} newValue 新值（空值拒绝；与 setSecret 同口径）
 * @param {{db?:object, accountId?:number|null}} [opts] 传 db 才落账（沿用 `migrateMcpSecrets(db)` 的同款注入缝：
 *   本模块不 import db.js —— 凭据文档的读写不该依赖"库连得上"，夹具也就能用假库）
 * @returns {Promise<{name:string, updatedAt:string, fingerprint:string}>} 描述里**永远不含值**
 */
export async function rotateSecret(name, newValue, { db = null, store = null, accountId = null } = {}) {
  const fingerprint = secretFingerprint(newValue); // 先算：值随后只进文档，本函数不再引用它
  setSecret(name, newValue);                       // 唯一写路径；抛错＝没换成功，旧值一个字没动
  const updatedAt = new Date().toISOString();
  if (db) {
    try {
      // 写口走存储接口（v0.3 §4.1/§4.6）：`store` 与 `db` 一样是**注入缝**——夹具靠它挡在真库之外
      // （2026-09-17 教训：只把 `db` 当缝、写口却用模块级 storage ⇒ 夹具的假库挡不住，真库被写了 12 行）。
      await (store || storage).audit.append({ accountId: accountId, action: 'cred:rotate', detail: 'name=' + name + ' fingerprint=' + fingerprint });
    } catch (e) {
      let msg = String((e && e.message) || e);
      // 兜底脱敏（日志出口的纪律）；脱敏本身失败不得盖住原错，更不得让"已经换好了"变成抛错
      try { msg = redactSecretValues(msg); } catch { /* 脱敏不可用＝保持原样 */ }
      console.error('[cred] 轮换落账失败（轮换本身已生效，勿复跑）：' + msg);
    }
  }
  return { name, updatedAt, fingerprint };
}

/**
 * 防泄漏兜底：把**当前所有已知凭据值**从一段文本里替换掉。
 * 它不替代"明文不进业务表"（那是根修），只是承认日志是我们控制不了内容的出口。
 * 取值门槛 8 字符：比这更短的值替换起来只会把正常文本打得千疮百孔，而 8 位以下的"密钥"本身也无意义。
 */
export function redactSecretValues(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [name, value] of Object.entries(readStore())) {
    if (value && value.length >= 8) out = out.split(value).join('[REDACTED:' + name + ']');
  }
  return out;
}

// ── 与 settings/MCP 配置的接缝 ──────────────────────────────────────────────────────
// `settings.mcp_servers[].env` 的一个值有三种可能，判定顺序是**显式记法 > 键名同名凭据 > 字面值**：
//   ① `__CRED__:NAME`          → 引用（迁移后 settings 里就长这样）
//   ② 键名像密钥 + 凭据文档里有同名凭据 → 用凭据的值，**忽略老配置里的明文**（迁移没跑也照样能用新钥匙）
//   ③ 其余                      → 字面值（普通配置，如 `GITHUB_API_URL: https://…`）
// ②是向后兼容的关键一步：老部署不迁移也能启动，且一旦凭据里配了同名项，明文就不再是生效来源。
// ③为什么不能猜"值长得像名字就是引用"：一个恰好叫 `TOKEN` 的字面值会被误判成"引用名为 TOKEN 的凭据"
// ——那是猜，不是读。所以只有显式记法与键名同名这两条可判定的路。

/** 读 MCP 配置（`settings.mcp_servers`）。**这一读为什么在这而不是在 mcp.js**：迁移要能"先在内存里改、
 *  全部搬完才落库"，而"搬成了没有"取决于凭据文档的现状——一次读、同一份值贯穿全过程，才判得准。
 *  `svalue` 是 JSON 列：mysql2 会解析成对象，夹具则可能给字符串，两样都认。 */
export async function readMcpConfig(db) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', ['mcp_servers']);
    if (!r[0]) return [];
    const raw = r[0].svalue;
    if (raw === null || raw === undefined) return [];
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch { return []; }
}

/** MCP env 的单键解析（规则见本节顶部三条）。缺凭据**抛错**：缺哪一把钥匙必须一眼看出，
 *  不塞空串、不静默跳过——任务口径：缺密钥如实报错，不静默降级。 */
export function resolveEnvValue(key, value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith(CRED_PREFIX)) {
    const name = value.slice(CRED_PREFIX.length);
    const val = getSecret(name);
    if (val === undefined) throw new Error('缺少凭据 ' + name + '（应配在 ' + credentialsFile() + ' 或环境变量里）');
    return val;
  }
  if (SENSITIVE_KEY_RE.test(key)) {
    const name = key;
    if (CREDENTIAL_REF_RE.test(name)) {
      const val = getSecret(name);
      if (val !== undefined) return val;   // 凭据里有同名项 ⇒ 它才是生效来源，老配置里的明文不算
    }
  }
  return value;                             // 普通配置值 / 还没搬的明文：原样
}

/** 解析一个 MCP server 的 env：引用换真值，普通配置原样。 */
export function resolveEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = resolveEnvValue(k, v);
  return out;
}

/** 配置里被引用到的凭据名（去重、保序）—— 只回答"引用了谁"。 */
export function referencedSecretNames(cfg) {
  const names = [];
  for (const s of Array.isArray(cfg) ? cfg : []) {
    for (const v of Object.values((s && s.env) || {})) {
      if (typeof v === 'string' && v.startsWith(CRED_PREFIX)) {
        const n = v.slice(CRED_PREFIX.length);
        if (!names.includes(n)) names.push(n);
      }
    }
  }
  return names;
}

/** 可安全打印/返回的摘要：**只有名字与状态，没有任何值**。 */
export function redactSummary(cfg) {
  const refs = referencedSecretNames(cfg).map(describeSecret);
  return {
    store: credentialsFile(),
    configured: refs.filter((r) => r.configured).map((r) => ({ name: r.name, source: r.source, writable: r.writable })),
    missing: refs.filter((r) => !r.configured).map((r) => r.name),
  };
}

// ── 迁移 ──────────────────────────────────────────────────────────────────────────
/**
 * 把 `settings.mcp_servers[].env` 里的**明文**搬进凭据文档，并把 settings 里的值改写成显式引用。
 *
 * 搬哪些：`env` 里"键名像密钥、值不是 `__CRED__:` 记法"的那些 —— 也就是当前还在 settings 里裸着的密钥。
 * 键名本身就是凭据名（`GITHUB_PERSONAL_ACCESS_TOKEN`），所以搬完 settings 里剩下的引用也读得懂。
 * 普通配置值（键名不像密钥）**一律不搬**：它们不是凭据，搬了反而把配置藏起来。
 *
 * 两条纪律：
 *   ① **可重复执行**：已是 `__CRED__:` 记法的记为"跳过"；文档里已有的**不覆盖**（现存的可能是运营刚换过的
 *      新钥匙）；每次写入都是"当前配置 + 已经搬成功的那些引用"，所以中断后重跑就是补完剩下的。
 *   ② **失败不破坏现有配置**：搬不动的那一项**原样留在 settings 里**（还是明文、还照旧生效），
 *      与它一起被搬成功的项互不影响。全程**不丢值**——最坏情况就是"部分搬完"，而这一状态是自洽的：
 *      `migrated`/`skipped`/`failed` 三个名单相加就是全部被处理的键。
 *
 * 回滚：凭据文档是纯新增物，回滚＝把 settings 里的 `__CRED__:NAME` 换回明文（值就在文档里，没丢），
 * 或直接删掉文档并让旧代码接管。**迁移本身不提供"降级脚本"**（《数据库迁移规范》：只向前）。
 *
 * @param {{query:Function, run:Function}} db 走平台的 db（夹具可注入假库）
 * @returns {Promise<{migrated:string[], skipped:string[], failed:Array<{name:string,error:string}>, applied:boolean, changed:number}>}
 */
export async function migrateMcpSecrets(db) {
  const cfg = await readMcpConfig(db);
  const empty = { migrated: [], skipped: [], failed: [], applied: false, changed: 0 };
  if (!Array.isArray(cfg)) return empty;
  const store = readStore();
  const migrated = []; const skipped = []; const failed = [];
  const next = JSON.parse(JSON.stringify(cfg));
  for (const s of next) {
    if (!s || !s.env || typeof s.env !== 'object') continue;
    for (const [k, v] of Object.entries(s.env)) {
      if (typeof v !== 'string') continue;                                 // 非字符串：不碰
      if (v.startsWith(CRED_PREFIX)) {                                     // 已是显式引用 ⇒ 幂等的那一支
        if (!skipped.includes(k)) skipped.push(k);
        continue;
      }
      if (!SENSITIVE_KEY_RE.test(k) || !CREDENTIAL_REF_RE.test(k)) continue; // 普通配置值 / 键名不可作引用名：不搬
      if (store[k] !== undefined) { s.env[k] = credRef(k); if (!skipped.includes(k)) skipped.push(k); continue; }
      try {
        setSecret(k, v);
        store[k] = v;                                                      // 让同一批里的重复键不必重写文件
        s.env[k] = credRef(k);
        if (!migrated.includes(k)) migrated.push(k);
      } catch (e) {
        failed.push({ name: k, error: String((e && e.message) || e) });
      }
    }
  }
  const changed = migrated.length + skipped.length;
  if (!changed) return { ...empty, failed };
  await db.run('UPDATE settings SET svalue=?, updated_at=NOW() WHERE skey=?', [JSON.stringify(next), 'mcp_servers']);
  return { migrated, skipped, failed, applied: true, changed };
}
