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
//   ＋**登录链**（2026-09-16 再扩）：`accounts`/`sessions` 原本不在清单里，但"干净机器跑通一次对话"的**第一步
//   就是登录**，而登录要这两张表 ⇒ 不补它们，`RW_STORAGE=jsonfile` 仍然进不了门。同批补上会话/消息/设置
//   那几条**按账号**的读法（`findOwned`/`listByAccount`/`updateOwned`/`recent`/`count`/`all`/`getMany`）。
// 仍然**显式抛"该实现不支持"**的：三个原生 SQL 动词（`query`/`one`/`run`）以及走它们的**事件归档**
//   （`events_archive` 表 + `NOW() - INTERVAL` 是 MySQL 侧的保留策略）—— 缺能力必须报错，不许静默返回空
//   （v0.3 §4.6 同一精神）。将来往 CONTRACT 里加实体，落点就在这里：要么实现、要么显式抛；
//   漏了会被 test/storage.test.mjs 的方法面用例当场判红。
//
// 与 MySQL 实现**已知的两处介质差异**（如实写在这里，不假装一模一样）：
//   ① **时钟源**：会话到期时间由介质算 —— MySQL 用库的 `NOW()`，这里用进程时钟（`new Date()`）。
//      两边机器时钟不一致时，"同一个 token 什么时候过期"会有偏差 —— 这是介质属性，不是接口能抹平的。
//   ② **用户名匹配**：MySQL 的 `username=?` 走库的排序规则（本仓 utf8mb4 默认**不区分大小写**），
//      这里按 `toLowerCase()` 比较来对齐这个可判定子集；重音/全角等更细的排序规则差异不在覆盖范围。
//
// 这个实现**不是**给生产负载用的，如实写在前面（免得读代码的人误判它的定位）：
//   · 每次写都整文件落盘（含 `persistEvent` 这种每帧一次的调用）⇒ 量一大就慢；落盘已**串行化**（见 createJsonFileStorage）
//   · 单进程内内存态（Node 单线程），**不做跨进程文件锁**（引擎现在是单进程，v0.3 §4.1）；
//   · 真跑量要的是 sqlite 实现（下一个增量），不是把它优化成数据库。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RW_WORKSPACE } from '../env.js';
import { assertFields, unsupported, FIELDS, STORAGE_INVALID_FIELD, PATCHABLE } from './index.js';
// 注：`PATCHABLE.knowledge` 在**函数体里**读（不在顶层读成常量）：本文件与 storage/index.js 是环，
// 顶层读会踩 TDZ（"Cannot access 'PATCHABLE' before initialization"，与 mysql.js 那条同因）。

const IMPL = 'jsonfile';
// 文件格式的身份与版本（v0.3 §4.9：存储格式带版本号与迁移链）。**导出**：夹具要断言"文件里写的就是当前版本"，
// 而迁移链的底盘与顶端也都取自这里（链的 head 必须等于它，见 validateStoreMigrationChain）。
export const STORE_FORMAT = 'rw-store-json';
export const STORE_FORMAT_VERSION = 1;
// v1 是**首个发布版本**（与 `server/session-export.js` 的 SESSION_FORMAT_FIRST_VERSION 同一口径）：文件从第一版
// 起就写 version=1，从来没有 v0 的存储文件 ⇒ "当前只有 v1 ⇒ 链为空"是**合法状态**（首版、无迁移步），
// 不是"缺一步"。这个常量只用来给**链校验**一个底盘：链里若有更早的步（夹具合成的 v0→v1），底盘以链为准。
export const STORE_FORMAT_FIRST_VERSION = 1;
/** 本实现**支持的表**；不在这张表里的实体一律显式抛错（"加实体"的落点见文件头注释）。 */
// `knowledge`（2026-09-17 加）：不在存储契约的"必需实体"里，加它只有一个原因 —— **第二个检索实现**
// （`server/kbsearch/like.js`，`RW_KB_SEARCH=like`）不碰 SQL，它的记录只能从这套接口读。
// 有它在表里，夹具/嵌入方才能把条目放进这份 JSON 文件并被 `storage.knowledge.all()` 读到；
// 不在这张表里的话，`loadDoc` 会把 `tables.knowledge` 当成未知表丢掉（而"丢了却不报错"最坏）。
const TABLES = ['conversations', 'messages', 'toolCalls', 'settings', 'agentRuns', 'events', 'deliveries', 'accounts', 'sessions', 'knowledge', 'usage', 'audit'];

// 默认落点：工作区下的 storage/（与 spill/、.rw-checkpoints/ 同属"运行期产物"，不进仓库）。
// 要挪位置得在 server/env.js 加一个 RW_STORAGE_FILE（env.js 是环境事实的唯一出处，本轮由协调方维护，
// 故实现不自己读 process.env）；夹具通过构造参数把文件指到临时目录。
export const DEFAULT_FILE = path.join(RW_WORKSPACE, 'storage', 'rw-store.json');

// ── 存储文件格式迁移链的**注册点**（v0.3 §4.9「会话与存储格式带版本号与迁移链」的存储侧那一半）─────────
// 为什么要有它：这个文件一直有 `format`/`version` 两个字段，但**没有任何地方能写"v1 怎么变成 v2"**——
// 于是"带迁移链"在存储侧只是半句话：版本号涨上去以后，老文件只剩"拒绝"一条路（人工转换）。
// 形状**照 `server/session-export.js`（会话侧先做的那一半）**，不另发明一套：
//   ① 每步只允许**相邻**（to === from + 1），且**在注册时**校验：跳步/倒步在这里就炸，
//      不拖到"某天真的来了个老文件"才炸；
//   ② 整条链必须**连续、无缺口、无重复起点、不越过当前版本**，口径照 `server/migrations.js` 的 `validateChain`
//      （同一份纪律：坏链在读任何文件之前就抛，不带半条链跑）；
//   ③ **当前版本的文件不走迁移**（照 DSH 的 current 直接走 codec）；
//   ④ 版本不认识就**显式拒绝**：比当前版本新的一律拒绝（不降级硬读），缺步的旧版本也一样
//      （不跳过、不许"能读多少读多少"）。
//
// **当前状态：链为空是合法状态。** 只有 v1，而 v1 是首版 ⇒ 没有任何更旧的版本存在过 ⇒ **没有迁移步可写**，
// 这次启动校验因此通过（不是"缺一步"）。将来真要 v2：把 STORE_FORMAT_VERSION 改成 2，**并且**注册
// v1→v2 那一步；只改版本号不写步 ⇒ 启动即报缺口（这正是要拦住的"改了版本却忘了迁移"）。
const MIGRATIONS = new Map(); // fromVersion → 冻结的 {fromVersion, toVersion, name, fn}

/** 版本号必须是"非负整数"（注册与链校验两处共用一份口径，免得两处判得不一样） */
function assertFormatVersion(v, label) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(label + ' 必须是非负整数（实际 ' + JSON.stringify(v) + '）');
  return v;
}

/**
 * 版本不被支持时抛这个（语义照 `session-export.js` 的 SessionFormatUnsupportedMigrationError）：文件**读得懂**，
 * 但本版本没有读它的路径——调用方必须整份拒绝，不许跳过、不许降级、不许"能读多少读多少"。
 * 单独一个类是为了让调用方能把它与"文件本身坏了"区分开：前者是"你的版本太旧/太新"。
 */
export class StoreFormatUnsupportedMigrationError extends Error {
  constructor(message) { super(message); this.name = 'StoreFormatUnsupportedMigrationError'; }
}

/**
 * 注册一个**相邻**迁移步。注册即校验：跳步、倒步、版本号不合法、没给函数，都在这里炸。
 * @param {number} fromVersion 这一步只能读的旧版本
 * @param {number} toVersion   迁移后的版本，必须 === fromVersion + 1
 * @param {(doc:object)=>(object)} fn 纯函数：v(fromVersion) 的存储文件对象 → v(toVersion) 的存储文件对象。
 *   **不要**自己改 `version`（链负责盖，见 migrateStoreDoc）；**不要**改入参对象（调用方可能还持有它）。
 * @returns {() => void} 注销函数（夹具造合成链后还原用；产品路径用不到）
 */
export function registerStoreMigration(fromVersion, toVersion, fn, { name } = {}) {
  const from = assertFormatVersion(fromVersion, 'fromVersion');
  const to = assertFormatVersion(toVersion, 'toVersion');
  if (to !== from + 1) throw new Error('存储格式迁移步必须相邻：v' + from + '→v' + to + ' 不是相邻步（只允许 v' + from + '→v' + (from + 1) + '）');
  if (typeof fn !== 'function') throw new Error('存储格式迁移步 v' + from + '→v' + to + ' 缺少迁移函数');
  const dup = MIGRATIONS.get(from);
  if (dup) throw new Error('存储格式迁移步 v' + from + ' 重复注册（已有 ' + dup.name + '）');
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
export function storeMigrations() {
  return [...MIGRATIONS.values()].sort((a, b) => a.fromVersion - b.fromVersion);
}

/** 链的**底盘** = 最早存在过的版本：默认 v1（首版）；链里有更早的步（夹具合成的 v0→v1）时以链为准 */
function chainBase(steps) {
  return steps.reduce((min, s) => Math.min(min, s.fromVersion), STORE_FORMAT_FIRST_VERSION);
}

/**
 * 校验一条存储格式迁移链（**纯函数**，口径照 `migrations.js` 的 `validateChain`）：相邻 + 连续无缺口 +
 * 无重复起点 + 没有越过当前版本的多余步。坏链抛错——**在迁移任何一份文件之前**先校验。
 * @param {Array} steps 迁移步（默认=已注册的链）
 * @param {{base?:number, head?:number}} range base=链的底盘（默认见 chainBase）；head=当前版本
 * @returns {true}
 */
export function validateStoreMigrationChain(steps = storeMigrations(), { base, head = STORE_FORMAT_VERSION } = {}) {
  if (!Array.isArray(steps)) throw new Error('存储格式迁移链必须是数组');
  // base 在**数组校验之后**才解析（否则链参数传错时抛的是 reduce 的 TypeError，看不出是哪儿错了）
  const lo = base === undefined ? chainBase(steps) : assertFormatVersion(base, 'base');
  assertFormatVersion(head, 'head');
  const byFrom = new Map();
  for (const s of steps) {
    const from = assertFormatVersion(s && s.fromVersion, '迁移步 fromVersion');
    const to = assertFormatVersion(s && s.toVersion, '迁移步 toVersion');
    if (to !== from + 1) throw new Error('存储格式迁移步必须相邻：v' + from + '→v' + to + ' 不是相邻步（只允许 v' + from + '→v' + (from + 1) + '）');
    if (typeof (s && s.fn) !== 'function') throw new Error('存储格式迁移步 v' + from + '→v' + to + ' 缺少迁移函数');
    if (byFrom.has(from)) throw new Error('存储格式迁移步 v' + from + ' 重复（同一起点不能有两步）');
    byFrom.set(from, s);
  }
  for (let v = lo; v < head; v++) {
    if (!byFrom.has(v)) throw new Error('存储格式迁移链有缺口：缺 v' + v + '→v' + (v + 1) + '（不跳过、不按当前版本硬读）');
  }
  // 越过当前版本的步 = 链指向的不是当前版本（改了版本号却忘了写步，或写了步却忘了改版本号）
  const extra = [...byFrom.keys()].filter((v) => v >= head);
  if (extra.length) throw new Error('存储格式迁移链有多余步（不指向当前版本 v' + head + '）：v' + extra.join(', v'));
  return true;
}

/**
 * "这个版本的文件要依次走哪些步"。纯函数；当前版本返回空数组（照 DSH ③）。
 * 判据只有一条：**链里有没有从 v 到 HEAD 的每一步**。缺任何一步都显式拒绝（说清缺哪一步），
 * 绝不"按当前版本硬读"；比当前版本新的一律拒绝（不降级读取）。
 */
export function planStoreMigration(fromVersion, { steps = storeMigrations(), head = STORE_FORMAT_VERSION } = {}) {
  const v = assertFormatVersion(fromVersion, 'version');
  if (v > head) throw new StoreFormatUnsupportedMigrationError('存储文件是更新的 v' + v + '；本实现只读写 v' + head + '（先升级本代码，不降级硬读）');
  if (v === head) return [];
  const byFrom = new Map(steps.map((s) => [s.fromVersion, s]));
  const plan = [];
  for (let cur = v; cur < head; cur++) {
    const s = byFrom.get(cur);
    // 当前只有 v1 时，v0 的文件走到这里 —— 消息与"缺步"这一档一致（不跳过、不部分读）
    if (!s) throw new StoreFormatUnsupportedMigrationError('存储文件是 v' + v + '，本实现没有 v' + v + '→v' + head + ' 的迁移（迁移链缺这一步：v' + cur + '→v' + (cur + 1) + '；不跳过、不按当前版本硬读）');
    plan.push(s);
  }
  return plan;
}

/**
 * 信封检查（**纯函数**，`loadDoc` 与 `migrateStoreDoc` 共用一份）。顺序是**故意**的：先"这文件是不是我们的"，
 * 再"版本号本身合不合法"，最后才谈"读不读得了"——否则一个 format 都不对的文件会收到"版本太旧"的错，排障就跑偏了。
 * `file` 只用于把路径带进报错文本（纯函数调用方不传）。
 * @returns {number} 校验通过的 version
 */
function assertStoreEnvelope(obj, file) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('存储文件必须是 JSON 对象（实际是 ' + (Array.isArray(obj) ? 'array' : typeof obj) + '）' + (file ? '：' + file : ''));
  }
  if (obj.format !== STORE_FORMAT) throw new Error('存储文件格式不认识：' + obj.format + '（期望 ' + STORE_FORMAT + (file ? '，' + file : '') + '）');
  const v = obj.version;
  // 先判"是不是个合法版本号"（malformed），再分"更新"与"缺迁移"两种拒绝（unsupported）——与 rw-session 的分档一致
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('存储文件版本号不合法：' + JSON.stringify(v) + '（必须是非负整数' + (file ? '，' + file : '') + '）');
  return v;
}

/**
 * 把一份存储文件对象沿迁移链**逐步**升到当前版本（**纯函数、不碰盘、不改入参**）。当前版本原样返回（同一引用）。
 * 链缺步 / 版本更新 ⇒ 抛 StoreFormatUnsupportedMigrationError；迁移步自己抛错 ⇒ 包一层说清"哪一步拒绝了
 * 哪个版本"，否则一个纯函数里的 TypeError 看起来会像"文件坏了"。
 */
export function migrateStoreDoc(doc) {
  const v = assertStoreEnvelope(doc);
  let cur = doc;
  for (const step of planStoreMigration(v)) {
    let next;
    try {
      next = step.fn(cur);
    } catch (e) {
      if (e instanceof StoreFormatUnsupportedMigrationError) throw e;
      throw new StoreFormatUnsupportedMigrationError('迁移步 ' + step.name + ' 拒绝了这份 v' + step.fromVersion + ' 存储文件：' + ((e && e.message) || e));
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('迁移步 ' + step.name + ' 必须返回存储文件对象（实际是 ' + (Array.isArray(next) ? 'array' : typeof next) + '）');
    }
    // 版本号由**链**来盖：步自己写错 version 也不会让链错位（否则"走到哪一版"就有两个出处）
    cur = { ...next, version: step.toVersion };
  }
  return cur;
}

// **启动校验**（模块加载即服务器启动的一部分：`server/storage/index.js` 在启动时就 import 本模块；
// 照 migrations.js「在应用任何一条之前先校验」）。链有缺口/重复/多余步 ⇒ 立刻抛：带着半条链跑比启动失败更糟。
// 当前只有 v1 ⇒ 链为空，这次校验通过。
validateStoreMigrationChain();

const nowIso = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));   // 记录按契约就是可 JSON 序列化的：文件即格式

function emptyDoc() {
  return { format: STORE_FORMAT, version: STORE_FORMAT_VERSION, counters: {}, tables: Object.fromEntries(TABLES.map((t) => [t, {}])) };
}

/**
 * 读文件；不存在＝全新库；**旧版本沿链逐步迁移并写回**；**版本不认识就显式拒绝**
 * （照 `server/session-export.js` 的 rw-session 口径：更新的版本不硬读；缺步的旧版本不跳过）。
 */
function loadDoc(file) {
  if (!fs.existsSync(file)) return emptyDoc();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyDoc();
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(`存储文件不是合法 JSON（${file}）：${e.message}`); }
  const version = assertStoreEnvelope(doc, file);
  // 比本代码新的版本：**显式拒绝**。判据与 planStoreMigration 里那条是同一条（v > head），这里另写一份只为
  // 把**文件路径**一并报出来——排障第一眼要看到"哪份文件、什么版本、本代码只认到哪一版"。
  if (version > STORE_FORMAT_VERSION) {
    throw new StoreFormatUnsupportedMigrationError(
      `存储文件版本不认识：这份文件是 v${version}，本实现只认到 v${STORE_FORMAT_VERSION}（${file}）——更新的版本不硬读、不降级（先升级本代码再打开它）`);
  }
  const stale = version < STORE_FORMAT_VERSION;
  if (stale) doc = migrateStoreDoc(doc);   // 逐步迁移：链缺步 / 步自己抛错都在这里显式报出来
  // 归一化默认值放在**迁移之后**：迁移步看到的是文件的原样（旧形状该长什么样由那一步说了算）
  if (!doc.tables) doc.tables = {};
  for (const t of TABLES) if (!doc.tables[t]) doc.tables[t] = {};
  if (!doc.counters) doc.counters = {};
  // **迁移即写回**：只读打开也要把文件升到当前版本，而不是等"下一次有人写"。当前版本的文件一个字节都不重写。
  if (stale) saveDocSync(file, doc);
  return doc;
}

let tmpSeq = 0;   // 临时文件名里的序号（同一进程内唯一；跨进程由 pid 区分）

/**
 * 临时文件名：**必须每次不同**（pid+序号）。共用 `<file>.tmp` 时，两次并发写里先 rename 的那个会把临时文件
 * 搬走，后一个 rename 就 ENOENT —— 2026-09-16 真机实测（一轮对话里 persistEvent 逐帧 fire-and-forget，
 * 几十个并发写当场踩中，见 `[eventlog] 事件落账失败 ENOENT ... rename`）。异步写与"打开旧文件时的迁移写回"
 * 共用这一个出处，所以两边的名字不可能撞。
 */
const tmpPath = (file) => `${file}.${process.pid}.${++tmpSeq}.tmp`;

/** 落盘的字节形状（两处写盘共用一份：文件的序列化口径只能有一个出处） */
const serialize = (doc) => JSON.stringify(doc, null, 2);

async function saveDoc(file, doc) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // 先写临时文件再 rename：rename 是原子的 ⇒ 中途崩了也不会留下半截文件（"要么旧的、要么新的"）。
  const tmp = tmpPath(file);
  await fsp.writeFile(tmp, serialize(doc), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 同步落盘：**只在"打开旧文件并按链迁移"这一处用**（loadDoc 在 holder 的 getter 里同步跑，没法 await）。
 * 它和 saveDoc 共用同一套"唯一临时名 + 先写临时文件再 rename"的机制，且**不与串行化的写链打架**：
 * 任何一次 persist() 入队前都必然先读过 holder.doc（读即触发加载），而加载是同步跑完的
 * ⇒ 这次写必然发生在链上**第一次**写之前，两者不可能同时在飞（真绕过它去写同一个文件，才会丢更新）。
 * 唯一目的：迁移完当场把文件升到当前版本（只读打开也要落盘）。
 */
function saveDocSync(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpPath(file);
  fs.writeFileSync(tmp, serialize(doc), 'utf8');
  fs.renameSync(tmp, file);
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
    /**
     * 壳定义（只读一条，2026-09-18 为遥测采集加）：**本介质里没有壳表** ⇒ 返回空列表。
     * 这不是"不支持"、也不是"静默降级"：一份 JSON 存储文件里本来就没有壳定义，
     * "没有壳"就是事实（干净机器上没有金标可跑）。要区分"没这能力"，看 `capabilities()`。
     */
    shells: {
      async listWithEvalRef() {
        return [];
      },
    },

    /**
     * 归类用的定时任务两列：**本介质里没有 scheduled_tasks 表** ⇒ 如实给空列表
     * （一份 JSON 存储文件里没有定时任务；于是"定时任务会话"这一档在干净机器上恒为空——那是事实）。
     */
    scheduledTasks: {
      async listIdName() {
        return [];
      },
    },

    /** 遥测水位：那四张表都不在 JSON 介质里 ⇒ 计数如实为 0 / 分组为空（"没有"是事实，不是"读不到"）。 */
    evoGoals: {
      async count() {
        return 0;
      },
    },
    evoGoalTasks: {
      async count() {
        return 0;
      },
    },
    evoMemos: {
      async count() {
        return 0;
      },
    },
    extensionDemands: {
      async countByStatus() {
        return [];
      },
    },

    impl: IMPL,
    /**
     * 介质自报能力（裁定 C）：本介质**没有** `events_archive` / `audit_log_archive` 两张归档表，
     * 也不提供原生动词（`one/run/query` 一律抛"不支持"，见下）。
     * 归档作业据此**跳过并留痕**（`archive:skip`），不抛错、也不报成"归档成功 0 行"。
     */
    capabilities() {
      return { medium: IMPL, archive: false, rawSql: false };
    },

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
      /** 按 id **且按账号**取（对应 `server/index.js:762` 那条带 `account_id=?` 的查询）。 */
      async findOwned(id, accountId) {
        const rec = byId('conversations', id);
        return snap(rec && (rec.accountId ?? null) === (accountId ?? null) ? rec : null);
      },
      /**
       * 会话列表：条件是 `server/index.js:321` 那一条的逐字翻译 ——
       * "我的会话" ∪ "渠道侧无主会话（`channel != 'web' AND account_id IS NULL`）"。
       * 注意 `channel != 'web'` 在 MySQL 里遇到 NULL 是 **NULL（不成立）**，所以这里必须显式排除
       * channel 为空的行，不能图省事写 `r.channel !== 'web'`（那样会把"渠道未知"的行也带出来）。
       * 排序：`updated_at DESC`（时间在 JSON 里是 ISO 字符串，字典序＝时间序）。
       */
      async listByAccount(accountId) {
        const rows = rowsOf('conversations').filter((r) => (r.accountId ?? null) === (accountId ?? null)
          // `channel != 'web'`：字符串比较照 MySQL 默认排序规则（不区分大小写），且 NULL 不成立
          || (r.channel !== null && r.channel !== undefined && String(r.channel).toLowerCase() !== 'web' && (r.accountId ?? null) === null));
        rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return snap(rows);
      },
      /** 账号范围内的更新（对应 `server/index.js:373` / `autotitle.js:44`）。改不到＝什么都不做。 */
      async updateOwned(id, accountId, patch) {
        assertFields('conversations', patch, { partial: true });
        const rec = byId('conversations', id);
        if (!rec || (rec.accountId ?? null) !== (accountId ?? null)) return;
        Object.assign(rec, patch, { updatedAt: nowIso() });
        await commit();
      },
      /** 只推进 updatedAt（对应 `server/index.js:889`：落了一条消息之后"这个会话刚动过"）。 */
      async touch(id) {
        const rec = byId('conversations', id);
        if (!rec) return;
        rec.updatedAt = nowIso();
        await commit();
      },
      /** 会话在不在（对应 `server/index.js:1147` 的孤儿守卫 `SELECT 1 FROM conversations WHERE id=?`）。 */
      async exists(id) {
        return byId('conversations', id) !== null;
      },
      /** 删会话（对应 `DELETE /api/conversations/:id` 里那句；归属已在路由里判过）。删不到＝0（幂等）。 */
      async remove(id) {
        const key = String(idOf(id));
        if (!holder.doc.tables.conversations[key]) return 0;
        delete holder.doc.tables.conversations[key];
        await commit();
        return 1;
      },
      /**
       * 读**指定的那几列**（对应 `server/index.js:779` 的 Web 只读会话读八列）。未知键当场抛
       * （与 mysql 实现同一份判据：拼错列名不许静默少一个字段）。返回**只含这些键**的记录，
       * 外加介质一定会带的 `id`/`createdAt`/`updatedAt` 之外的列一概不给 —— 与 mysql 侧 `toRecord` 同义。
       */
      async getAs(id, keys) {
        const wanted = Array.isArray(keys) ? keys : [];
        for (const k of wanted) {
          if (!FIELDS.conversations.includes(k)) throw new Error(`conversations 没有字段 ${k}（可选：${FIELDS.conversations.join(', ')}）`);
        }
        if (!wanted.length) return null;
        const rec = byId('conversations', id);
        if (!rec) return null;
        const out = { id: rec.id };
        for (const k of wanted) out[k] = rec[k] === undefined ? null : clone(rec[k]);
        return out;
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
      /**
       * 最近 N 条：**倒序**（对应 `autotitle.js:11` 与 `server/tools/index.js:1327` 的 `ORDER BY id DESC`）。
       * `roles` 给了就只算这些角色（调用点用它取"只要 user/assistant"的干净历史）。
       */
      async recent(conversationId, { limit, roles = null } = {}) {
        let rows = rowsOf('messages').filter((r) => Number(r.conversationId) === Number(conversationId));
        if (Array.isArray(roles) && roles.length) rows = rows.filter((r) => roles.includes(r.role));
        rows = rows.slice().reverse();          // rowsOf 是升序 ⇒ 反过来就是"最新在前"
        return snap(Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows);
      },
      /** 条数（对应 `server/index.js:1460` 与 `server/tools/index.js:1329`）；`role` 给了就只数这个角色。 */
      async count(conversationId, { role = null } = {}) {
        return rowsOf('messages')
          .filter((r) => Number(r.conversationId) === Number(conversationId) && (role ? r.role === role : true))
          .length;
      },
      /**
       * **上下文口径**的历史读法（对应 `server/index.js:928` 的 `/api/chat` 组装处）：只要
       * `id, role, content`、按 id 升序、**全量不裁剪**。`content` 用 `?? ''`（与调用方那句
       * `String(m.content || '')` 同义，也与 mysql 侧 `row.content ?? ''` 对齐）。
       */
      async history(conversationId) {
        return rowsOf('messages')
          .filter((r) => Number(r.conversationId) === Number(conversationId))
          .map((r) => ({ id: r.id, role: r.role, content: r.content ?? '' }));
      },
      /**
       * 带**孤儿守卫**的追加（对应 `server/index.js:1370/1446` 的 `INSERT … SELECT … FROM conversations WHERE id=?`）：
       * 会话不在就一行都不写、返回 `{ id: 0 }`。介质不同、语义同一条（MySQL 靠一条语句原子地判，这里先查后写）。
       */
      async guardAppend(fields) {
        assertFields('messages', fields);
        if (byId('conversations', fields.conversationId) === null) return { id: 0 };
        return api.messages.append(fields);
      },
      /**
       * 按工具名数调用次数（对应 `server/index.js:1005` 的 kb 注入判定）。窗口按**记录时间**算
       * （MySQL 侧用库的 `created_at > NOW() - INTERVAL ? DAY`，这里用进程时钟 —— 与文件头"已知介质差异①"同一档）。
       * `tools` 空数组＝不查（`IN ()` 在 SQL 侧非法，两边行为必须一致）。
       */
      async countByTool(conversationId, { tools = [], days } = {}) {
        const list = (Array.isArray(tools) ? tools : []).filter((t) => t !== undefined && t !== null);
        if (!list.length) return 0;
        const d = Number(days);
        const since = Number.isInteger(d) && d > 0 ? Date.now() - d * 86400000 : null;
        return rowsOf('toolCalls')
          .filter((r) => Number(r.conversationId) === Number(conversationId) && list.includes(r.toolName)
            && (since === null || new Date(r.createdAt).getTime() > since))
          .length;
      },
      /** 清掉某会话的全部消息（对应 `DELETE /api/conversations/:id` 的级联里那句）。返回删了几条。 */
      async removeByConversation(conversationId) {
        const table = holder.doc.tables.messages;
        let n = 0;
        for (const [k, r] of Object.entries(table)) {
          if (Number(r.conversationId) === Number(conversationId)) { delete table[k]; n++; }
        }
        if (n) await commit();
        return n;
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
      /** 按会话升序读回（对应 `server/index.js:441` 的导出那条 `ORDER BY id`）。 */
      async list(conversationId, limit) {
        const rows = rowsOf('toolCalls').filter((r) => Number(r.conversationId) === Number(conversationId));
        return snap(Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows);
      },
      /** 最近 N 条（**倒序**，对应 `/api/conversations/:id/toolcalls` 那条 `ORDER BY id DESC LIMIT 100`）。 */
      async recent(conversationId, { limit } = {}) {
        const rows = rowsOf('toolCalls').filter((r) => Number(r.conversationId) === Number(conversationId)).reverse();
        return snap(Number.isFinite(Number(limit)) && Number(limit) > 0 ? rows.slice(0, Number(limit)) : rows);
      },
      /** 展示列形状（`/trace` 用；列名与 mysql 侧那条 SQL 逐字一致）。 */
      async traceByConversation({ conversationId, limit = 200 } = {}) {
        let rows = rowsOf('toolCalls').filter((r) => Number(r.conversationId) === Number(conversationId)).reverse();
        const n = Number(limit);
        rows = rows.slice(0, Number.isInteger(n) && n > 0 ? n : 200);
        return rows.map((r) => ({ id: r.id, tool_name: r.toolName ?? null, status: r.status ?? null, duration_ms: r.durationMs ?? 0, created_at: r.createdAt ?? null }));
      },
      /**
       * 把本会话**尚未归属**的工具调用挂到刚落的这条 assistant 消息上（对应 `server/index.js:1410` 的轨迹回填）。
       * `messageId` 为空的才算"没人认领过"（与 mysql 侧 `message_id IS NULL` 同一条判据）。返回认领了几条。
       */
      async attachToMessage(conversationId, messageId) {
        let n = 0;
        for (const rec of rowsOf('toolCalls')) {
          if (Number(rec.conversationId) !== Number(conversationId)) continue;
          if (rec.messageId === null || rec.messageId === undefined) { rec.messageId = messageId; n++; }
        }
        if (n) await commit();
        return n;
      },
      /** 清掉某会话的全部工具调用（对应 `DELETE /api/conversations/:id` 的级联里那句）。返回删了几条。 */
      async removeByConversation(conversationId) {
        const table = holder.doc.tables.toolCalls;
        let n = 0;
        for (const [k, r] of Object.entries(table)) {
          if (Number(r.conversationId) === Number(conversationId)) { delete table[k]; n++; }
        }
        if (n) await commit();
        return n;
      },
      /**
       * 失败率那三个读数（2026-09-18 与 mysql 侧同批迁入）：判据逐条对齐 ——
       * `conversationId > 0` ＝ 真实会话，探针/孤儿单独报数、不混进分母；时间窗按**进程本地时钟**减天数
       * （与 `usage.roundRowsByAccount` 同一套算法），无码/存量行归到显式档。键名与迁移前逐字一致。
       */
      async failureTotals({ days = 7 } = {}) {
        const floor = Date.now() - (Number(days) > 0 ? Number(days) : 7) * 86400000;
        const rows = rowsOf('toolCalls').filter((r) => new Date(r.createdAt || 0).getTime() >= floor);
        let calls = 0; let fails = 0; let probeCalls = 0; let probeFails = 0;
        for (const r of rows) {
          const real = Number(r.conversationId) > 0;
          const bad = r.status === 'fail';
          if (real) { calls++; if (bad) fails++; } else { probeCalls++; if (bad) probeFails++; }
        }
        return { calls, fails, probe_calls: probeCalls, probe_fails: probeFails };
      },
      /** 失败按错误码汇总（`{code, n, tools}`；无码归 '(无码/存量行)'，与 mysql 的 COALESCE 同义）。 */
      async failByCode({ days = 7 } = {}) {
        const floor = Date.now() - (Number(days) > 0 ? Number(days) : 7) * 86400000;
        const by = new Map();
        for (const r of rowsOf('toolCalls')) {
          if (r.status !== 'fail' || !(Number(r.conversationId) > 0)) continue;
          if (new Date(r.createdAt || 0).getTime() < floor) continue;
          const code = r.errorCode === null || r.errorCode === undefined ? '(无码/存量行)' : r.errorCode;
          const cur = by.get(code) || { code, n: 0, tools: new Set() };
          cur.n += 1; cur.tools.add(r.toolName ?? null);
          by.set(code, cur);
        }
        return [...by.values()].map((x) => ({ code: x.code, n: x.n, tools: x.tools.size })).sort((a, b) => b.n - a.n);
      },
      /** 失败按"工具 × 错误码"汇总（前 N 条；无码归 '(无码)'，与 mysql 侧同字面）。 */
      async failByTool({ days = 7, limit = 20 } = {}) {
        const floor = Date.now() - (Number(days) > 0 ? Number(days) : 7) * 86400000;
        const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
        const by = new Map();
        for (const r of rowsOf('toolCalls')) {
          if (r.status !== 'fail' || !(Number(r.conversationId) > 0)) continue;
          if (new Date(r.createdAt || 0).getTime() < floor) continue;
          const code = r.errorCode === null || r.errorCode === undefined ? '(无码)' : r.errorCode;
          const k = String(r.toolName) + '\u0000' + code;
          const cur = by.get(k) || { tool: r.toolName ?? null, code, n: 0 };
          cur.n += 1;
          by.set(k, cur);
        }
        return [...by.values()].sort((a, b) => b.n - a.n).slice(0, n);
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
      /** 全量设置（对应 `server/index.js:1745`）→ `{skey: value}`。 */
      async all() {
        return Object.fromEntries(Object.entries(holder.doc.tables.settings).map(([k, rec]) => [k, clone(rec.value)]));
      },
      /** 按键批量读（对应 `server/agent.js:173` / `server/tools/hooks.js:465`）：存在的键才在返回对象里。 */
      async getMany(keys) {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : []) {
          const rec = holder.doc.tables.settings[String(k)];
          if (rec) out[k] = clone(rec.value);
        }
        return out;
      },
    },

    // ── 登录链：账号（对应 `server/auth.js:15/17/23/57/59`）─────────────────────────────────────
    accounts: {
      /**
       * 按用户名查（login / ensureAdmin / 注册查重共用；MySQL 侧 username 有唯一键 ⇒ 至多一条）。
       * 大小写：按 `toLowerCase()` 比较，对齐 MySQL utf8mb4 默认排序规则的"不区分大小写"这一档
       * （见文件头"已知的两处介质差异"②）。
       */
      async findByUsername(username) {
        if (username === undefined || username === null) return null;
        const want = String(username).toLowerCase();
        const hit = rowsOf('accounts').find((r) => String(r.username || '').toLowerCase() === want) || null;
        return snap(hit);
      },
      /** 建账号：username 唯一键冲突即抛（形状照 MySQL 的 ER_DUP_ENTRY，调用方才能用同一套判据）。 */
      async create(fields) {
        assertFields('accounts', fields);
        const exists = rowsOf('accounts').some((r) => String(r.username || '').toLowerCase() === String(fields.username).toLowerCase());
        if (exists) {
          const e = new Error(`Duplicate entry '${fields.username}' for key 'username'`);
          e.code = 'ER_DUP_ENTRY';
          throw e;
        }
        const rec = { id: nextId('accounts'), username: fields.username, passHash: fields.passHash, role: fields.role || 'user', createdAt: nowIso() };
        put('accounts', rec);
        await commit();
        return { id: rec.id };
      },
    },

    // ── 登录链：会话（对应 `server/auth.js:29/38/45`）──────────────────────────────────────────
    sessions: {
      /**
       * 建会话：**到期时间由介质算**（这里＝进程时钟 + days 天；MySQL 用库的 `NOW()`，见文件头差异①）。
       * token 是主键 ⇒ 重复即抛（照 MySQL 的 ER_DUP_ENTRY）。
       */
      async create({ token, accountId, days }) {
        if (rowsOf('sessions').some((r) => r.token === token)) {
          const e = new Error(`Duplicate entry '${token}' for key 'PRIMARY'`);
          e.code = 'ER_DUP_ENTRY';
          throw e;
        }
        const now = Date.now();
        // 主键是 token（不是自增 id，所以不走 put：put 是按 rec.id 存的）
        holder.doc.tables.sessions[String(token)] = {
          token, accountId,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + Number(days) * 86400000).toISOString(),
        };
        await commit();
      },
      /** 校验 token 并取回账号（对应 `auth.js:38` 的 JOIN + `expires_at > NOW()`）：查不到/过期都返回 null。 */
      async findValid(token) {
        const s = rowsOf('sessions').find((r) => r.token === token) || null;
        if (!s) return null;
        if (!(new Date(s.expiresAt).getTime() > Date.now())) return null;   // 过期判据（MySQL 侧在 SQL 里比）
        const acc = byId('accounts', s.accountId);
        return acc ? { id: acc.id, username: acc.username, role: acc.role } : null;
      },
      /** 退出登录（`auth.js:45`）。幂等：token 不存在＝什么都不做。 */
      async remove(token) {
        const key = String(token);
        if (!holder.doc.tables.sessions[key]) return;
        delete holder.doc.tables.sessions[key];
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
      /** 本介质没有 `events_archive` 表：调用方先问 `capabilities().archive`（裁定 C）；真走到这里＝代码写错了。 */
      async archiveBatch() {
        throw unsupported(IMPL, '事件归档（同一份 JSON 文件里没有 events_archive 表；请先问 capabilities().archive）');
      },
    },

    /**
     * 知识库：给"第二个检索实现"（`server/kbsearch/like.js`）取记录用；**2026-09-17 起也承担写口**
     * ——干净机器（不连 MySQL）上要能**攒记忆**：`kb_add` 的同名去重/覆盖、`kb_del` 的可见范围删除。
     * 过滤口径与 mysql 实现**逐条对齐**：`all` 只按账号收口；`removeVisible` 的可见范围判据在这里用 JS
     * 写了一遍（MySQL 侧引用 `kbVisibleWhere` 那份 SQL）——两边的**同一条判据**由 `test/storage.test.mjs`
     * 的同一组契约用例盖住（"MySQL 靠 SQL / 这里靠同一判据"是本仓 `deliveries` 唯一键的既有手法）。
     * 排序 `id ASC` 同上（mysql 侧那条 ORDER BY 的理由）：给一个稳定顺序，真正的排序在 `like.js` 里。
     */
    knowledge: {
      async all(accountId) {
        const rows = rowsOf('knowledge').filter((r) => Number(r.accountId) === Number(accountId));
        return snap(rows);
      },
      async append(fields) {
        assertFields('knowledge', fields);
        const rec = { id: nextId('knowledge'), ...fields, createdAt: nowIso() };
        put('knowledge', rec);
        await commit();
        return { id: rec.id };
      },
      /** 修订：白名单的**唯一出处**在接口层（`PATCHABLE`），`touch` 刷新介质时间戳。 */
      async update(id, patch = {}) {
        // 先校验再查行：**字段非法永远是错误**（哪怕这条记录不存在）——顺序反过来时，
        // "删掉之后再改一个拼错的字段"会静默返回 updated:false，调用方永远看不到自己写错了字段名。
        for (const k of Object.keys(patch)) {
          if (k === 'touch') continue;
          if (!PATCHABLE.knowledge.includes(k)) {
            const e = new Error(`未知字段 knowledge.${k}（可修订的只有：${PATCHABLE.knowledge.join(', ')}）`);
            e.code = STORAGE_INVALID_FIELD;
            throw e;
          }
        }
        const rec = rowsOf('knowledge').find((r) => Number(r.id) === Number(id));
        if (!rec) return { updated: false };
        for (const k of Object.keys(patch)) {
          if (k === 'touch') continue;
          rec[k] = clone(patch[k]);
        }
        if (patch.touch) rec.createdAt = nowIso();
        await commit();
        return { updated: true };
      },
      /** 同名条目（`kb_add` 去重口径）：NULL 安全等（`<=>` 的 JS 等价物就是按 `?? null` 比）。 */
      async findByTitle({ accountId, scope, conversationId = null, shellId = null, kind = null, title } = {}) {
        const eq = (a, b) => (a ?? null) === (b ?? null);
        const hit = rowsOf('knowledge')
          .filter((r) => eq(r.accountId, accountId) && r.scope === scope && eq(r.shellId, shellId)
            && eq(r.conversationId, conversationId) && r.kind === kind && r.title === title)
          .pop();   // rowsOf 升序 ⇒ 最后一条即"id 最大"（对应 mysql 的 ORDER BY id DESC LIMIT 1）
        return hit ? snap(hit) : null;
      },
      async remove(id, { accountId } = {}) {
        const key = rowsOf('knowledge').find((r) => Number(r.id) === Number(id) && Number(r.accountId) === Number(accountId))?.id;
        if (key === undefined) return { removed: false };
        delete holder.doc.tables.knowledge[String(key)];
        await commit();
        return { removed: true };
      },
      /**
       * 可见范围删除：账号 + (global ∪ 本壳 shell ∪ 本会话 conv) + 仅 active，与 mysql 侧
       * `kbVisibleWhere({includeConv:true})` 同一条判据（`status` 缺省即 active，见那里的注释）。
       */
      async removeVisible(id, { accountId, shellId = null, conversationId = null } = {}) {
        const eq = (a, b) => (a ?? null) === (b ?? null);
        const key = rowsOf('knowledge').find((r) => Number(r.id) === Number(id)
          && Number(r.accountId) === Number(accountId)
          && r.status === 'active'
          && (r.scope === 'global'
            || (r.scope === 'shell' && eq(r.shellId, shellId))
            || (r.scope === 'conv' && eq(r.conversationId, conversationId ?? -1))))?.id;
        if (key === undefined) return { removed: false };
        delete holder.doc.tables.knowledge[String(key)];
        await commit();
        return { removed: true };
      },
      /**
       * 管理视图的展示列（与 mysql 实现**同一套列名**，逐字沿用改造前那条 SQL：`shell_key`/`body_preview`/
       * `related_component`/`created_at`）。
       * `shellKey` 在 JSON 介质上**如实为 null**：这份存储里没有 `shells` 表（壳定义走文件/库，不在契约里），
       * 编一个假 key 比 null 坏得多。`bodyPreview` 截断口径与 MySQL 的 `LEFT(body,200)` 一致。
       */
      async adminList({ accountId, scope = null, shellId = null, kind = null, status = null, ids = null, limit = 500 } = {}) {
        let rows = rowsOf('knowledge').filter((r) => Number(r.accountId) === Number(accountId));
        if (scope) rows = rows.filter((r) => r.scope === scope);
        if (scope === 'shell' && shellId) rows = rows.filter((r) => Number(r.shellId) === Number(shellId));
        if (kind) rows = rows.filter((r) => r.kind === kind);
        if (status) rows = rows.filter((r) => r.status === status);
        if (Array.isArray(ids)) {
          const want = new Set(ids.map(Number));
          rows = rows.filter((r) => want.has(Number(r.id)));
        }
        rows = rows.slice().reverse();   // rowsOf 升序 ⇒ 反向即 id DESC（与 mysql 的 ORDER BY k.id DESC 同向）
        const n = Number(limit);
        if (Number.isInteger(n) && n > 0) rows = rows.slice(0, n);
        return rows.map((r) => ({
          id: r.id, scope: r.scope, shell_id: r.shellId ?? null, shell_key: null,
          conversation_id: r.conversationId ?? null, kind: r.kind ?? null, status: r.status ?? null,
          related_component: r.relatedComponent ?? null, title: r.title ?? null,
          body_preview: String(r.body ?? '').slice(0, 200), created_at: r.createdAt ?? null,
        }));
      },
      /** 会话可见范围下的条目（每轮的知识注入读法）：与 mysql 侧 `kbVisibleWhere({includeConv:true})` 同一条判据。 */
      async visibleList({ accountId, shellId = null, conversationId = null, limit = 12 } = {}) {
        const eq = (a, b) => (a ?? null) === (b ?? null);
        let rows = rowsOf('knowledge').filter((r) => Number(r.accountId) === Number(accountId)
          && r.status === 'active'
          && (r.scope === 'global'
            || (r.scope === 'shell' && eq(r.shellId, shellId))
            || (r.scope === 'conv' && eq(r.conversationId, conversationId ?? -1))));
        rows = rows.slice().reverse();   // rowsOf 升序 ⇒ 反向即 id DESC
        const n = Number(limit);
        if (Number.isInteger(n) && n > 0) rows = rows.slice(0, n);
        return rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title ?? null, body: r.body ?? null }));
      },
      /** 账号边界内的修订（管理面）：白名单＝`knowledgeOwned`，改不到别人的行。 */
      async updateOwned(id, accountId, patch = {}) {
        for (const k of Object.keys(patch)) {
          if (k === 'touch') continue;
          if (!PATCHABLE.knowledgeOwned.includes(k)) {            const e = new Error(`未知字段 knowledge.${k}（管理面可改的只有：${PATCHABLE.knowledgeOwned.join(', ')}）`);
            e.code = STORAGE_INVALID_FIELD;
            throw e;
          }
        }
        const rec = rowsOf('knowledge').find((r) => Number(r.id) === Number(id) && Number(r.accountId) === Number(accountId));
        if (!rec) return { updated: false };
        for (const k of Object.keys(patch)) {
          if (k === 'touch') continue;
          rec[k] = clone(patch[k]);
        }
        await commit();
        return { updated: true };
      },
    },

    /**
     * 用量记账（v0.3 §4.6「预算与审计：本地兜底」的写口；与 mysql 实现同一套字段与语义）。
     * `createdAt` 由介质盖（mysql 侧是建表的 `DEFAULT NOW()`）；`kind` 是必需字段。
     */
    usage: {
      async append(fields) {
        assertFields('usage', fields);
        const rec = { id: nextId('usage'), ...fields, createdAt: nowIso() };
        put('usage', rec);
        await commit();
        return { id: rec.id };
      },
      /** 某会话的用量合计（`/trace` 的 usage 段）：口径与 mysql 侧那条聚合查询一致。 */
      async summaryByConversation(conversationId) {
        const rows = rowsOf('usage').filter((r) => Number(r.conversationId) === Number(conversationId));
        return {
          calls: rows.length,
          cost: rows.reduce((a, r) => a + Number(r.cost || 0), 0),
          tokensIn: rows.reduce((a, r) => a + Number(r.tokensIn || 0), 0),
          tokensOut: rows.reduce((a, r) => a + Number(r.tokensOut || 0), 0),
        };
      },
      /** 某账号的成本三件套（C3 仪表）：与 mysql 侧那条聚合同口径（去重按 agent_run_id / conversation_id）。 */
      async summaryByAccount(accountId) {
        const rows = rowsOf('usage').filter((r) => Number(r.accountId) === Number(accountId));
        const runs = new Set(rows.map((r) => r.agentRunId).filter((v) => v !== null && v !== undefined));
        const convs = new Set(rows.map((r) => r.conversationId).filter((v) => v !== null && v !== undefined));
        return { total: rows.reduce((a, r) => a + Number(r.cost || 0), 0), runs: runs.size, convs: convs.size };
      },
      /** 逐轮读数（C1/C2 的来源；裁定 A 的第二次读法）：按 `conversationIds` 过滤，空数组＝空结果。 */
      async roundRowsByAccount({ accountId, days = 7, conversationIds = null } = {}) {
        const floor = Date.now() - (Number(days) || 7) * 86400000;
        let rows = rowsOf('usage').filter((r) => Number(r.accountId) === Number(accountId)
          && r.kind === 'round' && new Date(r.createdAt || 0).getTime() >= floor);
        if (Array.isArray(conversationIds)) {
          if (!conversationIds.length) return [];
          const want = new Set(conversationIds.map(Number));
          rows = rows.filter((r) => want.has(Number(r.conversationId)));
        }
        return rows.map((r) => ({ h: Number(r.cacheHit || 0), m: Number(r.cacheMiss || 0), cid: r.conversationId ?? null }));
      },
      /** 按天的逐轮读数（仪表那条 30 天线）：`d` 用**进程本地日期**（与路由算"今天"的口径一致）。 */
      async dailyByAccount({ accountId, days = 30 } = {}) {
        const floor = Date.now() - (Number(days) || 30) * 86400000;
        const byDay = new Map();
        for (const r of rowsOf('usage')) {
          if (Number(r.accountId) !== Number(accountId) || r.kind !== 'round') continue;
          const at = new Date(r.createdAt || 0);
          if (at.getTime() < floor) continue;
          const d = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0');
          const cur = byDay.get(d) || { d, hit: 0, miss: 0, n: 0 };
          cur.hit += Number(r.cacheHit || 0);
          cur.miss += Number(r.cacheMiss || 0);
          cur.n += 1;
          byDay.set(d, cur);
        }
        return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
      },
      /** 窗口内全部逐轮读数（中性字段名；与 mysql 侧同一条口径：`kind='round'` + 时间窗 + 按 id 升序）。 */
      async roundRows({ days = 7, limit = 20001 } = {}) {
        const floor = Date.now() - (Number(days) > 0 ? Number(days) : 7) * 86400000;
        const n = Number(limit) > 0 ? Math.min(200000, Math.floor(Number(limit))) : 20001;
        const rows = rowsOf('usage')
          .filter((r) => r.kind === 'round' && new Date(r.createdAt || 0).getTime() >= floor)
          .slice(0, n);
        return rows.map((r) => ({
          accountId: r.accountId === null || r.accountId === undefined ? null : Number(r.accountId),
          conversationId: r.conversationId === null || r.conversationId === undefined ? null : Number(r.conversationId),
          agentRunId: r.agentRunId === null || r.agentRunId === undefined ? null : Number(r.agentRunId),
          cacheHit: Number(r.cacheHit || 0), cacheMiss: Number(r.cacheMiss || 0), cost: Number(r.cost || 0),
        }));
      },
    },

    /**
     * 审计账（v0.3 §4.6「预算与审计：本地兜底」的写口；与 mysql 实现同一套字段与语义）。
     * 干净机器上这才有审计：迁移前 62 处直连 SQL 全打在不存在的库上（多数被 catch 吞掉）。
     */
    audit: {
      async append(fields) {
        assertFields('audit', fields);
        const rec = { id: nextId('audit'), ...fields, createdAt: nowIso() };
        put('audit', rec);
        await commit();
        return { id: rec.id };
      },
      /**
       * 某一会话某动作的**最后一行说明**：语义与 mysql 侧那条 `ORDER BY id DESC LIMIT 1` 相同
       * （rowsOf 升序 ⇒ 反向取第一条即 id 最大的一条）。
       */
      async lastDetail({ conversationId, action } = {}) {
        const hit = rowsOf('audit')
          .filter((r) => Number(r.conversationId) === Number(conversationId) && r.action === action)
          .pop();
        return hit ? hit.detail : null;
      },
      /** 某动作的最后一行（`{createdAt, detail}`；没有则 null）：与 mysql 侧那条 `ORDER BY id DESC LIMIT 1` 同义。 */
      async lastByAction(action) {
        const hit = rowsOf('audit').filter((r) => r.action === action).pop();
        return hit ? { createdAt: hit.createdAt ?? null, detail: hit.detail ?? null } : null;
      },
      /** 各动作的条数（`[{action, n}]`）：语义与 mysql 侧那条 `GROUP BY action` 相同。 */
      async countByAction({ actions = null } = {}) {
        const want = Array.isArray(actions) ? new Set(actions) : null;
        if (want && !want.size) return [];
        const out = new Map();
        for (const r of rowsOf('audit')) {
          if (want && !want.has(r.action)) continue;
          out.set(r.action, (out.get(r.action) || 0) + 1);
        }
        return [...out.entries()].map(([action, n]) => ({ action, n }));
      },
      /** 某动作的**首词分布**（C5 豁免原因）：与 mysql 侧 `SUBSTRING_INDEX(detail,' ',1)` 同义（取第一个空格前那段）。
       *  2026-09-18：加**可选**时间窗（与 mysql 侧同批；不传＝全量）。 */
      async countByFirstToken(action, { days = null } = {}) {
        const floor = Number(days) > 0 ? Date.now() - Number(days) * 86400000 : null;
        const out = new Map();
        for (const r of rowsOf('audit')) {
          if (r.action !== action) continue;
          if (floor !== null && new Date(r.createdAt || 0).getTime() < floor) continue;
          const word = String(r.detail ?? '').split(' ')[0] || '?';
          out.set(word, (out.get(word) || 0) + 1);
        }
        return [...out.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
      },
      /** 按会话回溯（`/trace`）：挂在该会话上的 **＋** detail 里带 `conv=<id>` 的，列名与 mysql 侧逐字一致。 */
      async traceByConversation({ conversationId, limit = 200 } = {}) {
        const cid = Number(conversationId);
        const needle = 'conv=' + cid;
        let rows = rowsOf('audit').filter((r) => Number(r.conversationId) === cid || String(r.detail ?? '').includes(needle));
        rows = rows.slice().reverse();
        const n = Number(limit);
        if (Number.isInteger(n) && n > 0) rows = rows.slice(0, n);
        else rows = rows.slice(0, 200);
        return rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail ?? null, shell_id: r.shellId ?? null, created_at: r.createdAt ?? null }));
      },
      /**
       * 审计管理视图（`GET /api/audit` 的活表分支）：与 mysql 侧同一条口径——**条件串由调用方按既有口径拼好**，
       * 本实现只认那几种受限形式（`列=值` / `列 LIKE 值` / `created_at > NOW() - INTERVAL ? DAY` / 分类的
       * `action IN (…)`），看不懂就**如实抛**（绝不"当没条件"把全表放出去）。
       */
      async adminList({ conds = ['1=1'], params = [], limit = 100 } = {}) {
        const p = [...params];
        const n = Number(limit);
        const lim = Number.isInteger(n) && n > 0 ? n : 100;
        let rows = rowsOf('audit');
        for (const raw of conds) {
          const c = String(raw).trim();
          if (c === '1=1') continue;
          let m;
          if ((m = /^\(action LIKE \? OR detail LIKE \?\)$/i.exec(c))) {
            const a = String(p.shift() || '').replace(/%/g, '');
            const b = String(p.shift() || '').replace(/%/g, '');
            rows = rows.filter((r) => String(r.action || '').includes(a) || String(r.detail || '').includes(b));
            continue;
          }
          if ((m = /^created_at > NOW\(\) - INTERVAL \? DAY$/i.exec(c))) {
            const days = Number(p.shift()) || 0;
            const floor = Date.now() - days * 86400000;
            rows = rows.filter((r) => new Date(r.createdAt || 0).getTime() > floor);
            continue;
          }
          if ((m = /^action IN \(([?\s,]+)\)$/i.exec(c))) {
            const k = (m[1].match(/\?/g) || []).length;
            const want = new Set(Array.from({ length: k }, () => String(p.shift())));
            rows = rows.filter((r) => want.has(String(r.action)));
            continue;
          }
          if ((m = /^(\w+)=\?$/.exec(c))) {
            // 列名 → 记录字段名（这份介质里存的是中性字段名；调用方给的是既有 SQL 的列名）
            const COL2FIELD = { account_id: 'accountId', conversation_id: 'conversationId', shell_id: 'shellId', action: 'action' };
            const field = COL2FIELD[m[1]];
            if (!field) { const e = new Error('JSON 介质的审计管理视图不认识这一列：' + m[1]); e.code = 'STORAGE_UNSUPPORTED'; throw e; }
            const val = p.shift();
            rows = rows.filter((r) => (field === 'action' ? String(r.action) === String(val) : Number(r[field]) === Number(val)));
            continue;
          }
          const e = new Error('JSON 介质的审计管理视图不认识这个条件：' + c);
          e.code = 'STORAGE_UNSUPPORTED';
          throw e;
        }
        rows = rows.slice().reverse().slice(0, lim);
        return rows.map((r) => ({
          id: r.id, account_id: r.accountId ?? null, action: r.action ?? null, detail: r.detail ?? null,
          conversation_id: r.conversationId ?? null, shell_id: r.shellId ?? null, created_at: r.createdAt ?? null,
        }));
      },
      /** 某动作前缀涉及过哪些会话（裁定 A 的那一半）：与 mysql 侧的 `DISTINCT … IS NOT NULL` 同义。 */
      async conversationIdsByActionPrefix(prefix) {
        const p = String(prefix);
        const out = new Set();
        for (const r of rowsOf('audit')) {
          if (!String(r.action || '').startsWith(p)) continue;
          if (r.conversationId === null || r.conversationId === undefined) continue;
          out.add(Number(r.conversationId));
        }
        return [...out];
      },
      /**
       * **没有**归档表：同一份 JSON 文件里既没有 `audit_log_archive`、也没有体积压力（裁定 C）。
       * 调用方**先问能力**（`capabilities().archive === false`）就不会走到这里；真走到了＝代码写错了，
       * 所以如实抛"不支持"，绝不静默返回"搬了 0 行"（那会让"没归档"看起来像"归档成功"）。
       */
      async archiveBatch() {
        throw unsupported(IMPL, '审计归档（同一份 JSON 文件里没有 audit_log_archive 表；请先问 capabilities().archive）');
      },
      /**
       * 归档统计：能如实报的只有"当前有多少行、最早一行"，归档侧恒为 0 行/null ——
       * 这不是"编一个 0"，而是**事实**：本介质上没有归档表，归档行数就是 0。
       * 要区分"没归档"与"没这能力"，看 `capabilities().archive`。
       */
      async archiveStats() {
        const rows = rowsOf('audit');
        let oldest = null;
        for (const r of rows) {
          const at = r.createdAt ?? null;
          if (at && (oldest === null || at < oldest)) oldest = at;
        }
        return { current: { rows: rows.length, oldest }, archived: { rows: 0, oldest: null } };
      },
      /** 按动作前缀计数（可带时间窗；判据与 mysql 那条 `LIKE ?` 同义）。 */
      async countByActionPrefix(prefix, { days = null } = {}) {
        const p = String(prefix);
        const floor = Number(days) > 0 ? Date.now() - Number(days) * 86400000 : null;
        const by = new Map();
        for (const r of rowsOf('audit')) {
          if (!String(r.action || '').startsWith(p)) continue;
          if (floor !== null && new Date(r.createdAt || 0).getTime() < floor) continue;
          by.set(r.action, (by.get(r.action) || 0) + 1);
        }
        return [...by.entries()].map(([action, n]) => ({ action, n }));
      },
      /** 最近若干条（列名别名 `cid`/`at` 与 mysql 侧一致 —— 快照形状不许因介质而变）。 */
      async recentByActions({ prefix = null, actions = [], days = null, limit = 20 } = {}) {
        const list = Array.isArray(actions) ? actions.map(String) : [];
        const floor = Number(days) > 0 ? Date.now() - Number(days) * 86400000 : null;
        const n = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20;
        let rows = rowsOf('audit').filter((r) => {
          if (prefix && !String(r.action || '').startsWith(String(prefix))) return false;
          if (list.length && !list.includes(String(r.action || ''))) return false;
          if (floor !== null && new Date(r.createdAt || 0).getTime() < floor) return false;
          return true;
        });
        rows = rows.slice().reverse().slice(0, n);
        return rows.map((r) => ({
          id: r.id, action: r.action ?? null, detail: r.detail ?? null,
          cid: r.conversationId ?? null, at: r.createdAt ?? null,
        }));
      },
      /** 时间范围（`{at, at2}`）；本介质的时间戳是**进程写入的 ISO 字符串**，直接按字典序取最小/最大。 */
      async timeRange({ prefix = null, days = null } = {}) {
        const floor = Number(days) > 0 ? Date.now() - Number(days) * 86400000 : null;
        let min = null; let max = null;
        for (const r of rowsOf('audit')) {
          if (prefix && !String(r.action || '').startsWith(String(prefix))) continue;
          if (floor !== null && new Date(r.createdAt || 0).getTime() < floor) continue;
          const at = r.createdAt ?? null;
          if (!at) continue;
          if (min === null || at < min) min = at;
          if (max === null || at > max) max = at;
        }
        return { at: min, at2: max };
      },
    },

    // ── 外部投递记录（幂等键 + 死信落点）：语义与 mysql 实现逐条对齐 ──────────────────────────    // 为什么它必须在第二个实现里也有：带 `Idempotency-Key` 的 `POST /api/chat` 第一件事就是 `beginDelivery`，
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
