// server/tools/registry.js - 工具注册表（架构 §4.1 的「工具注册表」层）：清单驱动的**装载 + 校验 + 热重载**
// 装配关系：tools/manifest.js（声明式权威：档位/中文名/提示/集合/上下线） × tools/index.js（实现）
//   · 清单里声明了却不存在的实现 → **抛错**（清单不许说谎）
//   · 有实现却没进清单 → **跳过 + 告警**（默认拒绝：下线一个工具＝删/停用清单行，零代码改动）
//   · 重名 / 档位非法 / 缺 run → 抛错（装配期发现，不留到运行期）
// 热重载（RA-03 的另一半）：清单文件变更 → 动态 import（带缓存破坏参数）→ 重建派生结构**就地**更新 → 工具面即时生效，**不重启进程**。
// 本模块**不 import tools/index.js**（避免循环依赖）：实现侧通过 registerToolSource() 反向注入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOOL_MANIFEST, TOOL_TIER_CN } from './manifest.js';

const MANIFEST_PATH = fileURLToPath(new URL('./manifest.js', import.meta.url));
let reloadSeq = 0; // 模块缓存破坏参数里的序号（同一毫秒内两次重载也不能撞 URL）
const TIERS = ['core', 'pro', 'expert'];
const ENABLED = (m) => m && m.enabled !== false; // 缺省启用；enabled:false = 留痕式下线
// 能力清单规范（v0.3 §4.2/§7.1 ③⑤）新声明的取值域。**不许放宽**：非法值/缺字段一律装配期抛错。
//   execBackend  该工具干活要不要落到"可替换的执行后端"（② 的落地字段）：local=本机实现（文件/命令/进程/网络/数据库）｜none=不落后端（纯内存态/上下文编排/委托）
//   cacheImpact  该工具是否进请求前缀（§4.4.1 规则5）：tools-face=工具定义在请求 tools 数组里（改这批字节=整段前缀作废，对应 prefix-participants 的 tools-face）｜none=不进前缀
//   parallelSafe 能否与同一步的兄弟调用并发（v0.3 §2.4 CD「并行安全」/ 架构 v1.1 §4.4）：照 DSH `isConcurrencySafe` 的口径——**只有显式 true 才算可并行**，故本清单要求逐条显式声明
const EXEC_BACKENDS = ['none', 'local'];
const CACHE_IMPACTS = ['tools-face', 'none'];

// ---- 派生结构（**对象身份稳定**：热重载时就地清空重填，所有引用方自动看到新值）----
export { TOOL_TIER_CN };
export const TOOL_META = {};
export const TOOL_CN = {};
export const TOOL_POLICY = {};       // name -> {approval, timeoutMs, cacheImpact, execBackend, parallelSafe}
export const APPROVAL_REQUIRED = []; // 受控工具（guard 会话执行前需审批）：唯一出处＝清单的 approval:true
export const DEFAULT_TOOLSET = [];
export const PLATFORM_EXEMPT = [];
export const LIGHT_TOOLSET = [];
export const MANIFEST_NAMES = [];

let activeManifest = TOOL_MANIFEST;
let rawTools = [];          // 实现侧条目（由 tools/index.js 注入）
let onRebuild = null;       // 重建后回调（tools/index.js 用它就地刷新 TOOLS）
// 由清单附加过 timeoutMs 的实现条目。用途只有一个：区分"清单声明的界限"与"实现里自带的字面量"
// （后者是漂移的源头——旧实现把 8 个界限散在工具定义里，改一处忘一处没人发现）。
// 用 WeakSet 而不是普通集合：装配会重复执行（热重载/动态来源变化），附加过的条目不该被回收不掉。
const TIMEOUT_FROM_MANIFEST = new WeakSet();

/**
 * 清单字段校验（纯函数，装配期与夹具共用）。**只回答"这份清单自己合不合法"**，
 * 与实现是否对得上由 assembleStatic 负责（两层分开，报错才能指到人）。
 * @returns {string[]} 问题清单（空数组 = 合规）
 */
export function validateManifest(manifest) {
  const problems = [];
  for (const [name, m] of Object.entries(manifest || {})) {
    if (!ENABLED(m)) continue;
    if (!TIERS.includes(m.tier)) problems.push('档位非法（必需 core|pro|expert）：' + name + ' tier=' + m.tier);
    if (!m.cn) problems.push('缺中文名（cn）：' + name);
    if (m.approval !== undefined && typeof m.approval !== 'boolean') problems.push('approval 必须是布尔（缺省=false=不弹审批卡）：' + name + ' = ' + m.approval);
    if (m.timeoutMs !== undefined && !(Number.isFinite(Number(m.timeoutMs)) && Number(m.timeoutMs) > 0)) {
      problems.push('timeoutMs 必须是正有限数（未声明就不要写）：' + name + ' = ' + m.timeoutMs);
    }
    if (!CACHE_IMPACTS.includes(m.cacheImpact)) problems.push('cacheImpact 必须声明且取 ' + CACHE_IMPACTS.join('|') + '：' + name + ' = ' + m.cacheImpact);
    if (!EXEC_BACKENDS.includes(m.execBackend)) problems.push('execBackend 必须声明且取 ' + EXEC_BACKENDS.join('|') + '：' + name + ' = ' + m.execBackend);
    if (typeof m.parallelSafe !== 'boolean') problems.push('parallelSafe 必须显式声明布尔（只有 true 才算可并行）：' + name + ' = ' + m.parallelSafe);
  }
  return problems;
}

function refillDerived(manifest) {
  const problems = validateManifest(manifest);
  if (problems.length) throw new Error('[registry] 清单字段非法（能力清单规范，v0.3 §4.2/§7.1 ③⑤）：\n  - ' + problems.join('\n  - '));
  for (const o of [TOOL_META, TOOL_CN, TOOL_POLICY]) for (const k of Object.keys(o)) delete o[k];
  for (const a of [DEFAULT_TOOLSET, PLATFORM_EXEMPT, LIGHT_TOOLSET, MANIFEST_NAMES, APPROVAL_REQUIRED]) a.length = 0;
  for (const [name, m] of Object.entries(manifest)) {
    if (!ENABLED(m)) continue;
    MANIFEST_NAMES.push(name);
    TOOL_META[name] = { tier: m.tier, when: m.when || '', not: m.not || '', ex: m.ex || '' };
    TOOL_CN[name] = m.cn || name;
    TOOL_POLICY[name] = {
      approval: m.approval === true,
      timeoutMs: m.timeoutMs === undefined ? undefined : Number(m.timeoutMs),
      cacheImpact: m.cacheImpact,
      execBackend: m.execBackend,
      parallelSafe: m.parallelSafe === true,
    };
    if (m.defaultOn) DEFAULT_TOOLSET.push(name);
    if (m.exempt) PLATFORM_EXEMPT.push(name);
    if (m.light) LIGHT_TOOLSET.push(name);
    if (m.approval === true) APPROVAL_REQUIRED.push(name);
  }
}
// 装配期检查（怕清单本身写错）：抛出即启动失败——宁可起不来，也不要装载一张说谎的清单
refillDerived(activeManifest);

/** 实现侧注入（tools/index.js 调用一次；热重载靠它重新装配） */
export function registerToolSource(tools, rebuild) {
  rawTools = tools || [];
  onRebuild = rebuild || null;
}

// ---------------------------------------------------------------------------
// 动态来源（2026-09-15，OP-18「统一装载器」）
// 为什么要有它：MCP 等**外部**工具的名字由对方的 tools/list 决定，无法在静态清单里声明，
// 于是此前它们是"另一张表"——`MCP_EXTRA`（给模型的 function defs）+ execTool 里按名字模式**现造**的
// 伪工具 + 按壳白名单的第三处判断。同一个工具三处表述，后果是：装配期校验（重名/缺描述/缺 run/缺权限）
// 一律不覆盖它们；工具界限表看不见它们；重名只能等厂商返回 400 后再由网关**静默去重**（症状补丁）。
// DSH 的做法（`dsh-mcp-client`）是**注册进同一个 tools 注册表**：`ctx.tools.register(definition)`，
// 一个注册失败就回滚整批（不留半代）、server 列出重名工具直接抛错、tools/list 跟随 nextCursor 分页。
// 这里照做那三条；差别只有一点：动态条目**不参与静态清单校验**（清单是静态权威），但**必须过同一套
// 条目校验**——外部工具不许绕过平台契约。
const dynamicSources = new Map(); // sourceId -> entries[]

/** 条目级校验（静态与动态共用；返回问题清单，不抛） */
function entryProblems(list) {
  const problems = [];
  const seen = new Set();
  for (const t of list || []) {
    if (!t || !t.name) { problems.push('存在无名工具条目'); continue; }
    if (seen.has(t.name)) problems.push('工具重名：' + t.name);
    seen.add(t.name);
    if (typeof t.run !== 'function') problems.push('工具缺少 run 实现：' + t.name);
    if (!t.description) problems.push('工具缺少 description（模型选择依据）：' + t.name);
    if (!t.permission) problems.push('工具缺少 permission：' + t.name);
    if (t.timeoutMs !== undefined && !(Number.isFinite(Number(t.timeoutMs)) && Number(t.timeoutMs) > 0)) {
      problems.push('工具界限非法（timeoutMs 必须是正有限数，未声明就不要写）：' + t.name);
    }
  }
  return problems;
}

/** 当前全部动态条目（按来源 id 排序，保证工具面顺序稳定——顺序变了就是前缀变了） */
export function dynamicEntries() {
  const out = [];
  for (const id of [...dynamicSources.keys()].sort()) out.push(...dynamicSources.get(id));
  return out;
}

/** 动态来源 id 列表（审计/自检用） */
export function dynamicSourceIds() { return [...dynamicSources.keys()].sort(); }

/**
 * 注册/替换一个动态来源（全有或全无）。
 * 校验不通过**不替换**上一代（保留现有工具面），并返回原因——与热重载失败即回滚同口径。
 * @returns {{ok: boolean, count?: number, error?: string}}
 */
export function registerDynamicTools(sourceId, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const problems = entryProblems(list);
  // 与静态工具、其它动态来源交叉查重：重名会让厂商直接 400（"Tool names must be unique"），
  // 必须在装配期拦下——而不是等网关静默去重、模型看不见其中一个却不知为什么。
  const taken = new Map();
  // 静态侧只算**真正装载**的名字（在清单里的），与 assembleStatic 的返回一致——但不再重复校验/打日志
  for (const t of rawTools || []) if (t && t.name && MANIFEST_NAMES.includes(t.name)) taken.set(t.name, '内置工具');
  for (const [id, arr] of dynamicSources) {
    if (id === sourceId) continue;
    for (const t of arr) taken.set(t.name, '动态来源 ' + id);
  }
  for (const t of list) if (t && t.name && taken.has(t.name)) problems.push('工具重名：' + t.name + '（已由' + taken.get(t.name) + '占用）');
  if (problems.length) {
    console.warn('[registry] 动态来源 ' + sourceId + ' 注册被拒绝（保留上一代工具面）：\n  - ' + problems.join('\n  - '));
    return { ok: false, error: problems.join('；') };
  }
  dynamicSources.set(sourceId, list);
  rebuild();
  return { ok: true, count: list.length };
}

/** 移除一个动态来源（其工具立刻从工具面消失） */
export function unregisterDynamicTools(sourceId) {
  if (!dynamicSources.delete(sourceId)) return false;
  rebuild();
  return true;
}

function rebuild() {
  if (onRebuild) onRebuild(combine());
}

/** 静态（清单内）× 动态（外部来源）→ 最终工具面 */
export function combine() {
  return assembleStatic(rawTools).concat(dynamicEntries());
}

/** 静态部分：清单 × 实现（默认拒绝未进清单者） */
export function assembleStatic(tools, manifest = activeManifest) {
  const list = tools || rawTools;
  const enabledNames = Object.entries(manifest || {}).filter(([, m]) => ENABLED(m)).map(([n]) => n);
  const problems = entryProblems(list);
  const seen = new Set((list || []).map((t) => t && t.name).filter(Boolean));
  for (const n of enabledNames) if (!seen.has(n)) problems.push('清单声明了不存在的工具（无实现）：' + n);
  // 清单声明 × 实现事实的两条交叉核对（v0.3 §4.4.1 规则5 + §7.1 ⑤）——"声明"与"实现"不一致必须当场报错：
  //   ① cacheImpact:'none' = 声称不进前缀，可它就在装载列表里（必然进 tools 数组）⇒ 说谎；
  //   ② timeoutMs 只允许在清单声明：实现条目上自带一个界限字面量 = 两处声明，早晚漂移（旧实现正是散在 8 处）。
  for (const t of list || []) {
    const m = t && manifest[t.name];
    if (!m || !ENABLED(m)) continue;
    if (m.cacheImpact === 'none') {
      problems.push('cacheImpact 声明不进前缀，但实现会进工具面（请求的 tools 数组）：' + t.name + '（要么把声明改成 tools-face，要么别装载它）');
    }
    if (t.timeoutMs !== undefined && !TIMEOUT_FROM_MANIFEST.has(t)) {
      problems.push('工具界限两处声明（timeoutMs 只允许在 tools/manifest.js 声明，实现里不要写）：' + t.name);
    }
  }
  if (problems.length) throw new Error('[registry] 工具装载失败（清单与实现不一致）：\n  - ' + problems.join('\n  - '));

  // 清单是 timeoutMs 的**唯一出处**：装配时把它附加到工具定义上（execTool / scripts/tool-bounds.mjs 读的就是它）。
  // 就地改属性而不是复制对象：TOOLS 里的条目身份必须稳定（热重载/引用方都按同一个对象读）。
  for (const t of list || []) {
    const m = manifest[t.name];
    if (!m || !ENABLED(m)) continue;
    if (m.timeoutMs === undefined) {
      if (TIMEOUT_FROM_MANIFEST.has(t)) delete t.timeoutMs;
    } else {
      t.timeoutMs = Number(m.timeoutMs);
      TIMEOUT_FROM_MANIFEST.add(t);
    }
  }

  const disabled = Object.entries(manifest || {}).filter(([, m]) => !ENABLED(m)).map(([n]) => n);
  const unlisted = (list || []).map((t) => t.name).filter((n) => !enabledNames.includes(n));
  if (unlisted.length) console.warn('[registry] 未进清单，已按默认拒绝不装载：' + unlisted.join(', ') + '（要启用请在 tools/manifest.js 补一行）');
  if (disabled.length) console.log('[registry] 清单标注 enabled:false，未装载：' + disabled.join(', '));

  return (list || []).filter((t) => enabledNames.includes(t.name));
}

/**
 * 装载实现：清单 × 实现 → 运行时工具表（顺序沿用实现声明顺序）。
 * @param {Array} [tools] 实现条目（缺省＝已注入的实现表）
 * @param {object} [manifest] 清单（缺省＝当前生效清单）。允许注入是**测试缝**：夹具要验
 *   "清单声明与实现漂移会被拦下"（例如把某条的 cacheImpact 改成 none、或给实现塞一个字面量 timeoutMs）。
 * @returns {Array} 通过校验、且**在清单里的**工具
 */
export function assembleTools(tools, manifest = activeManifest) {
  return assembleStatic(tools, manifest);
}

/**
 * 热重载（RA-03）：重新读取清单文件（动态 import + 缓存破坏参数）→ 就地更新派生结构 → 重新装配工具面。
 * 失败**不破坏现有工具面**（保留旧清单继续服务，如实报错）。
 * @param {string} manifestPath 清单路径。缺省＝本模块旁的 tools/manifest.js；
 *   允许注入是**测试缝**（与 assembleStatic(tools, manifest) 同一手法）：夹具要在临时文件上验成功/回滚/语法错误三条路径，
 *   而**绝不能去改 server/tools/manifest.js 本体**。注入只换"读哪个文件"，不动任何模块级状态。
 */
export async function reloadManifest(manifestPath = MANIFEST_PATH) {
  const before = MANIFEST_NAMES.length;
  let mod;
  try {
    // pathToFileURL 而不是拼 'file://'：Windows 上拼字符串会得到 file://E:\…（盘符与反斜杠都不是合法 file URL 形态），
    // 注入相对路径时更是直接失效。查询串用来打破 ESM 模块缓存（同一毫秒内连续两次重载也必须互不干扰 ⇒ 带序号）。
    const href = pathToFileURL(path.resolve(manifestPath)).href + '?t=' + Date.now() + '-' + (++reloadSeq);
    mod = await import(href);
  } catch (e) {
    console.warn('[registry] 热重载失败（清单语法/导入错误），保持现有工具面：' + (e && e.message ? e.message : e));
    return { ok: false, error: String((e && e.message) || e) };
  }
  const next = mod.TOOL_MANIFEST;
  if (!next || typeof next !== 'object') { console.warn('[registry] 热重载失败：清单未导出 TOOL_MANIFEST'); return { ok: false, error: 'TOOL_MANIFEST 缺失' }; }
  const prevManifest = activeManifest;
  try {
    refillDerived(next);
    activeManifest = next;
    const tools = combine(); // 静态 × 动态：热重载清单不得把动态来源（MCP）挤掉
    if (onRebuild) onRebuild(tools);
    console.warn('[registry] 热重载完成：工具面 ' + before + ' → ' + MANIFEST_NAMES.length + ' 个（无需重启）');
    return { ok: true, before, after: MANIFEST_NAMES.length };
  } catch (e) {
    // 回滚到旧清单，保证"重载失败不破坏在跑的工具面"
    activeManifest = prevManifest;
    refillDerived(prevManifest);
    if (onRebuild) onRebuild(combine());
    console.warn('[registry] 热重载被拒绝（新清单与实现不一致），已回滚旧清单：' + (e && e.message ? e.message : e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 监听清单文件变更（服务启动时调用一次）。防抖 300ms，避免编辑器多次写触发重复重载。 */
export function startManifestWatch() {
  let timer = null;
  try {
    fs.watch(MANIFEST_PATH, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { reloadManifest(); }, 300);
    });
    console.log('[registry] 清单热重载已启用：' + MANIFEST_PATH);
  } catch (e) {
    console.warn('[registry] 清单监听不可用（热重载关闭，改清单需重启）：' + (e && e.message ? e.message : e));
  }
}
