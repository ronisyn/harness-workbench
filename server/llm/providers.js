// server/llm/providers.js - 多厂商配置（全部 OpenAI 兼容）
// 每项：id（唯一）/ name / base（OpenAI 兼容 base URL）/ keyEnv（config.keys 里的键名）/ defaultModel / capabilities / chatModels
// capabilities：该厂商的能力**标签**（产品/菜单维度：chat / code / reasoning / tool / vision / image / video / ocr）——
//   供 /api/models 与前端菜单展示，**不是排他性的能力全集**。
//   ⚠️ 因此它**不产生"不支持"的语义**：标签里没有 'tool' 不等于不支持工具调用。实测（2026-09-17）：
//   deepseek 标签是 ['chat','code','reasoning']（无 'tool'）却一直在调工具；ark（无 'tool'）同理。
//   三维（视觉/工具/思考）的**显式否定**必须写在专用可选字段里（唯一来源，判定见 server/modelcaps.js）：
//     capabilitiesDeclared: { vision?: boolean, tool?: boolean, reasoning?: boolean }
//       · 写 false ⇒ 平台认定"该厂商显式声明不支持这一维"：网关据此**在发送前**拒发图 / 不把工具面发出去 /
//         不把思考增量透给界面（今日**无厂商**使用该字段 ⇒ 三维行为与改造前逐字相同）。
//       · 写 true / 不写 ⇒ 不产生否定（正向支持仍以 capabilities 标签为准）。
// chatModels：该厂商「主对话模型」菜单清单——以 2026-09 各厂商带 key 实测 GET /models 返回为准，
// 人工剔除 embedding/rerank/视频/图像/音频/OCR/3D/过旧版本等非纯对话模型，保留主流对话模型供模型菜单可选。
export const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', keyEnv: 'deepseek',
    defaultModel: 'deepseek-v4-flash', capabilities: ['chat', 'code', 'reasoning'],
    chatModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'glm', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'glm',
    defaultModel: 'glm-4.5', capabilities: ['chat', 'tool', 'image'],
    timeoutMs: 180000, // O-3（2026-09 批3）：GLM 5.x 是 thinking 模型，reasoning 长（曾 90s 超时）→ 放宽到 180s
    chatModels: ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash'],
  },
  {
    id: 'ark', name: '豆包/火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ark',
    defaultModel: 'doubao-seed-2-1-pro-260628', capabilities: ['chat', 'vision', 'image', 'video'],
    chatModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-mini-260428', 'doubao-seed-1-8-251228', 'doubao-seed-1-6-251015'],
  },
  {
    id: 'moonshot', name: 'Kimi', base: 'https://api.moonshot.cn/v1', keyEnv: 'moonshot',
    defaultModel: 'kimi-k3', capabilities: ['chat', 'reasoning', 'code'],
    chatModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
  },
  {
    id: 'dashscope', name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'dashscope',
    defaultModel: 'qwen3.8-flash', capabilities: ['chat', 'vision', 'code'],
    chatModels: ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-plus', 'qwen3.5-plus'],
  },
  {
    id: 'tokenhub', name: '腾讯 TokenHub', base: 'https://tokenhub.tencentmaas.com/v1', keyEnv: 'tokenhub',
    defaultModel: 'hy3', capabilities: ['chat', 'reasoning', 'tool'],
    chatModels: ['hy3', 'hy4-preview', 'hy-role', 'hunyuan-t1-vision-20250916'],
  },
  {
    id: 'qianfan', name: '百度文心', base: 'https://qianfan.baidubce.com/v2', keyEnv: 'qianfan',
    defaultModel: 'ernie-4.5-turbo-128k', capabilities: ['chat', 'vision'],
    chatModels: ['ernie-4.5-turbo-128k', 'ernie-4.5-turbo-32k', 'ernie-5.0', 'ernie-5.0-thinking-preview', 'ernie-5.1', 'ernie-x1.1', 'ernie-4.5-turbo-vl'],
  },
  {
    id: 'minimax', name: 'MiniMax', base: 'https://api.minimaxi.com/v1', keyEnv: 'minimax',
    defaultModel: 'MiniMax-M3', capabilities: ['chat'],
    chatModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  },
  {
    id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', keyEnv: 'siliconflow',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: ['chat', 'vision', 'image', 'ocr'],
    chatModels: ['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro', 'zai-org/GLM-5.3', 'zai-org/GLM-5.2', 'moonshotai/Kimi-K2.7-Code', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.6-35B-A3B', 'MiniMaxAI/MiniMax-M2.5', 'deepseek-ai/DeepSeek-V3.2', 'meituan-longcat/LongCat-2.0'],
  },
  {
    id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyEnv: 'openrouter',
    defaultModel: '', capabilities: ['chat'], chatModels: [],
  },
];

// 已配置 key 的厂商（=已接入）
export function activeProviders(keys) {
  return PROVIDERS
    .filter((p) => keys[p.keyEnv])
    .map((p) => ({ id: p.id, name: p.name, defaultModel: p.defaultModel, capabilities: p.capabilities }));
}

// 所有厂商（模型市场用，标注是否已接）
export function allProviders(keys) {
  return PROVIDERS.map((p) => ({ ...p, connected: Boolean(keys[p.keyEnv]) }));
}

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 自注册厂商（v0.3 §4.3「**可切云端/客户网关/内网推理**」的注册入口，2026-09-17）
//
// 改造前：厂商**只能**来自上面那份代码清单 ⇒ 客户要接自己的网关/内网推理**必须改代码**。
// 现在：库里（`providers` 表）的自注册行在启动时载入 PROVIDERS，并参与路由（网关 `resolve` → `findProvider`
// 是唯一判据；`/api/models`、`server/autotitle.js`、`server/channels/run-turn.js` 都读同一个注册表）。
//
// **权威划分（唯一判据＝"id 在不在代码清单里"；契约文档 docs/模型接入与厂商自注册-v1.md）**：
//   · 代码清单（本文件 PROVIDERS）＝**内置厂商**的唯一权威：它们的 id 被保留（API 不许改写/删除）；
//     启动时按 id **补齐缺行**（含默认模型），已有行则一个字都不改（人工的 enabled/名称不被启动覆盖）。
//   · `providers` 表＝**自注册厂商**的唯一权威：`provider_key` 不在清单里的行就是部署方注册的，
//     启动时载入内存注册表；本模块的增/改/删只作用于这一层。⇒ 两处各管各的 id 空间，不会互相覆盖。
//
// 凭证：**沿用既有唯一绑定**——条目声明 `keyEnv`，所有读取点都是 `keys[keyEnv]`（gateway 的 resolve、
//   index.js 的 `/api/models` 与 auto 路由回落、autotitle、channels…）。**不新增第二条凭证路径**：
//   既不收明文密钥（§9 凭证不进 DB 明文、不入响应），也不走 credentials.js 那一套（那是连接器的路）。
//   内置 10 个槽位在 server/config.js 里已按 `env('DEEPSEEK_API_KEY')` 等显式绑定；自注册厂商的新槽位
//   由 `bindKeySlot` 按**既有命名约定**（`<KEYENV 大写>_API_KEY`）懒解析，取值仍只经 process.env/.env 这条既有通道。
// ─────────────────────────────────────────────────────────────────────────────

/** 内置厂商 id（**模块加载期快照**）：API 不许占用/改写/删除这些 id。 */
const MANIFEST_IDS = new Set(PROVIDERS.map((p) => p.id));
/** 自注册条目的允许字段（＝清单同形字段的子集）：多一个字段就报错——拼错的字段不会生效，静默忽略最坑人。 */
const REGISTERED_FIELDS = ['id', 'name', 'base', 'keyEnv', 'defaultModel', 'capabilities', 'chatModels', 'timeoutMs', 'capabilitiesDeclared'];
/** `capabilitiesDeclared` 的三维（唯一出处见 server/modelcaps.js；这里只做形状校验，不重定义语义）。 */
const CAP_DECL_KEYS = ['vision', 'tool', 'reasoning'];
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const KEY_ENV_RE = /^[a-z][a-z0-9_]{0,47}$/;
/** 自注册厂商在 `providers.sort_order` 上的取值：内置是 0/10，注册的排在它们后面（菜单顺序，不影响路由）。 */
const REGISTERED_SORT_ORDER = 20;

/** 这个 id 是不是内置厂商（代码清单占用）。 */
export function isManifestProvider(id) { return MANIFEST_IDS.has(String(id)); }

/** base 的判据：http/https 绝对 URL，且**不带查询串/片段**（base 是要拼 `/chat/completions` 的前缀）。 */
function isHttpBase(s) {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.search && !u.hash;
  } catch { return false; }
}

/**
 * 自注册厂商条目的**校验**（纯函数；API 与启动载入共用）。**不放宽**：缺字段/取值非法/未知字段一律报问题。
 * 长度上限照 DB 列宽（name VARCHAR(64) / base_url VARCHAR(255) / api_key_env VARCHAR(64)）——超了会被
 * MySQL 截断或报错，属于"装配期就该拦下"的事，不留到入库那一刻。
 * @param {unknown} def 请求体（或库里那一行映射出来的条目）
 * @returns {string[]} 问题清单（空数组＝合规）
 */
export function validateProvider(def) {
  const problems = [];
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    return ['厂商声明必须是对象（清单同形字段：{ id, name, base, keyEnv, … }）：收到 ' + JSON.stringify(def)];
  }
  for (const k of Object.keys(def)) {
    if (!REGISTERED_FIELDS.includes(k)) {
      problems.push('未知字段 ' + k + '（清单同形字段只有 ' + REGISTERED_FIELDS.join('/') + '）——写错的字段不会生效，所以直接拒绝而不是忽略');
    }
  }
  if (typeof def.id !== 'string' || !PROVIDER_ID_RE.test(def.id)) {
    problems.push('id 非法（须为 2-32 位小写字母/数字/下划线/连字符且以字母开头）：' + JSON.stringify(def.id));
  } else if (MANIFEST_IDS.has(def.id)) {
    problems.push('id 与内置厂商冲突：' + def.id + '（内置厂商来自代码清单 server/llm/providers.js，其 id 被保留；换一个 id）');
  }
  if (typeof def.name !== 'string' || !def.name.trim()) problems.push('缺 name（显示名，非空字符串）');
  else if (def.name.length > 64) problems.push('name 过长（providers.name 是 VARCHAR(64)）：' + def.name.length + ' 字');
  if (typeof def.base !== 'string' || !isHttpBase(def.base)) {
    problems.push('base 非法（须为 http/https 绝对 URL，不带查询串/片段；如 http://10.0.0.5:8000/v1）：' + JSON.stringify(def.base));
  } else if (def.base.length > 255) problems.push('base 过长（providers.base_url 是 VARCHAR(255)）：' + def.base.length + ' 字');
  if (typeof def.keyEnv !== 'string' || !KEY_ENV_RE.test(def.keyEnv)) {
    problems.push('keyEnv 非法（须为小写标识符，如 acme；它是 config.keys 的槽位名，密钥真值只经既有 env 通道，不在请求体里）：' + JSON.stringify(def.keyEnv));
  } else if (def.keyEnv.length > 64) problems.push('keyEnv 过长（providers.api_key_env 是 VARCHAR(64)）：' + def.keyEnv.length + ' 字');
  if (def.defaultModel !== undefined && typeof def.defaultModel !== 'string') problems.push('defaultModel 必须是字符串（没有默认模型就写空串/不写）');
  if (def.capabilities !== undefined && !(Array.isArray(def.capabilities) && def.capabilities.every((c) => typeof c === 'string' && c))) {
    problems.push('capabilities 必须是非空字符串数组（缺省＝["chat"]）');
  }
  if (def.chatModels !== undefined && !(Array.isArray(def.chatModels) && def.chatModels.every((m) => typeof m === 'string' && m))) {
    problems.push('chatModels 必须是字符串数组（缺省＝不登记模型目录）');
  }
  if (def.timeoutMs !== undefined && !(Number.isFinite(Number(def.timeoutMs)) && Number(def.timeoutMs) > 0)) {
    problems.push('timeoutMs 必须是正有限数（未声明就不要写）');
  }
  if (def.capabilitiesDeclared !== undefined) {
    if (!def.capabilitiesDeclared || typeof def.capabilitiesDeclared !== 'object' || Array.isArray(def.capabilitiesDeclared)) {
      problems.push('capabilitiesDeclared 必须是对象 { vision?, tool?, reasoning? }');
    } else {
      for (const [k, v] of Object.entries(def.capabilitiesDeclared)) {
        if (!CAP_DECL_KEYS.includes(k)) problems.push('capabilitiesDeclared.' + k + ' 不是既有三维（' + CAP_DECL_KEYS.join('/') + '）');
        else if (typeof v !== 'boolean') problems.push('capabilitiesDeclared.' + k + ' 必须是布尔');
      }
    }
  }
  return problems;
}

/** 合规声明 → 注册表条目（清单同形；base 去尾斜杠，因为既有拼接口径是 `base + '/chat/completions'`）。 */
export function normalizeProvider(def) {
  const entry = {
    id: def.id,
    name: String(def.name).trim(),
    base: String(def.base).trim().replace(/\/+$/, ''),
    keyEnv: def.keyEnv,
    defaultModel: def.defaultModel === undefined ? '' : String(def.defaultModel),
    capabilities: Array.isArray(def.capabilities) ? [...def.capabilities] : ['chat'],
    chatModels: Array.isArray(def.chatModels) ? [...def.chatModels] : [],
  };
  if (def.timeoutMs !== undefined) entry.timeoutMs = Number(def.timeoutMs);
  if (def.capabilitiesDeclared !== undefined) entry.capabilitiesDeclared = { ...def.capabilitiesDeclared };
  return entry;
}

/** 自注册槽位对应的环境变量名（既有命名约定的唯一出处：9/10 个内置槽位正是 `<大写>_API_KEY`）。 */
export function keySlotEnvName(keyEnv) {
  return String(keyEnv).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
}

/**
 * 把声明的 `keyEnv` 绑到 `keys`（＝生产里的 `config.keys`）上——**这是自注册厂商唯一的凭证落点**。
 * 已存在的槽位（内置 10 个 / 上一次注册已绑过的）**一律不动**：内置绑定由 server/config.js 显式给出。
 * 新槽位用 getter **懒解析**（每次现取 ⇒ 环境变量轮换下一轮生效），取值只经 process.env（.env 已在
 * server/config.js 导入时并入 process.env，与既有 `env()` 同一通道、同一优先级）。
 * @returns {string|null} 新建绑定时返回环境变量名；已有槽位返回 null
 */
export function bindKeySlot(keys, keyEnv) {
  if (!keys || typeof keyEnv !== 'string' || !keyEnv) return null;
  if (Object.prototype.hasOwnProperty.call(keys, keyEnv)) return null;
  const envName = keySlotEnvName(keyEnv);
  Object.defineProperty(keys, keyEnv, {
    enumerable: true, configurable: true,
    get() { return process.env[envName] ?? ''; },
  });
  return envName;
}

/**
 * 注册/替换一个**自注册**厂商（内存注册表 + key 槽位绑定）。校验不过 ⇒ 不改任何东西。
 * 落库不在这里（见 `saveRegisteredProvider` 的"先库后内存"顺序说明）。
 * @returns {{ok:boolean, entry?:object, error?:string, problems?:string[]}}
 */
export function registerProvider(def, keys) {
  const problems = validateProvider(def);
  if (problems.length) return { ok: false, error: problems.join('；'), problems };
  const entry = normalizeProvider(def);
  const i = PROVIDERS.findIndex((p) => p.id === entry.id);
  if (i >= 0) PROVIDERS[i] = entry; else PROVIDERS.push(entry);
  bindKeySlot(keys, entry.keyEnv);
  return { ok: true, entry };
}

/** 注销准入判据（**只读**，无副作用）：返回拒绝理由或 null。 */
export function providerRemovalProblem(id) {
  if (MANIFEST_IDS.has(String(id))) return '内置厂商的 id 由代码清单占用，API 不许删除：' + id;
  if (!findProvider(id)) return '未注册的厂商：' + id;
  return null;
}

/** 从内存注册表摘掉一个自注册厂商（槽位留着：它的值来自环境变量，摘了会影响别的同槽位厂商）。 */
export function unregisterProvider(id) {
  const why = providerRemovalProblem(id);
  if (why) return { ok: false, error: why };
  const i = PROVIDERS.findIndex((p) => p.id === id);
  const [entry] = PROVIDERS.splice(i, 1);
  return { ok: true, entry };
}

/**
 * 注册/更新：**先库后内存** —— 内存注册表是路由的唯一判据，库写失败时它必须还没动，
 * 否则会出现"本机能路由、重启后不能"的幽灵厂商。
 * @param {object} db 库（server/db.js 的 query；夹具可注入假库）
 * @param {object} def 请求体（清单同形字段）
 * @param {object} keys config.keys（自注册槽位绑到它上面）
 * @param {{mustExist?:boolean, mustNotExist?:boolean}} [opts] POST 传 mustNotExist，PUT 传 mustExist
 * @returns {Promise<{ok:boolean, problems?:string[], error?:string, entry?:object, id?:number, models?:number, catalogError?:string, created?:boolean, keyEnvVar?:string|null}>}
 */
export async function saveRegisteredProvider(db, def, keys, opts = {}) {
  const problems = validateProvider(def);
  if (problems.length) return { ok: false, problems, error: problems.join('；') };
  const entry = normalizeProvider(def);
  const existing = findProvider(entry.id);
  if (opts.mustExist === true && !existing) return { ok: false, error: '未注册的厂商：' + entry.id + '（新增用 POST /api/providers）' };
  if (opts.mustNotExist === true && existing) return { ok: false, error: '厂商已注册：' + entry.id + '（改它用 PUT /api/providers/' + entry.id + '）' };
  const row = (await db.query('SELECT id FROM providers WHERE provider_key=?', [entry.id]))[0];
  let pid;
  if (row) {
    pid = row.id;
    await db.query('UPDATE providers SET name=?, base_url=?, api_key_env=? WHERE id=?', [entry.name, entry.base, entry.keyEnv, pid]);
  } else {
    const r = await db.query('INSERT INTO providers (provider_key, name, base_url, api_key_env, enabled, sort_order) VALUES (?,?,?,?,1,?)',
      [entry.id, entry.name, entry.base, entry.keyEnv, REGISTERED_SORT_ORDER]);
    pid = r.insertId;
  }
  // 内存注册 + 槽位绑定（到这一步才可能对外可见）
  const reg = registerProvider(def, keys);
  if (!reg.ok) return { ok: false, problems: reg.problems, error: reg.error };
  // 改名时把"默认模型"那一行的行名一起改掉：它是启动载入时补回 defaultModel 的**唯一线索**
  // （providers 表没有 defaultModel 列，口径＝`<厂商名> 默认模型`）——不改的话，改一次名、重启后默认模型就丢了。
  try {
    if (existing && existing.name !== entry.name) {
      await db.query('UPDATE models SET name=? WHERE provider_id=? AND name=?', [entry.name + ' 默认模型', pid, existing.name + ' 默认模型']);
    }
  } catch { /* 线索行改名失败不推翻注册：载入时查不到默认模型会如实留空（不猜） */ }
  // 模型目录：默认模型 + chatModels（复用既有 syncChatModels —— 它按 provider_key 从**注册表**取目录）
  let models = 0; let catalogError = null;
  try {
    if (entry.defaultModel) {
      await db.query('INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1',
        [pid, entry.defaultModel, entry.name + ' 默认模型', JSON.stringify(entry.capabilities)]);
      models++;
    }
    models += await syncChatModels(db, { id: pid, provider_key: entry.id });
  } catch (e) { catalogError = String((e && e.message) || e); }   // 目录是菜单细节：失败如实报，不推翻已注册这件事
  return { ok: true, entry, id: pid, models, catalogError, created: !row, keyEnvVar: keySlotEnvName(entry.keyEnv) };
}

/**
 * 注销：库行 + 该厂商的模型目录行 + 内存注册表条目。**只对自注册厂商生效**（内置 id 当场拒）。
 * 不动的：历史数据（对话/账本里存的是 provider 字符串，删厂商不抹历史——那是账，不是配置）。
 */
export async function removeRegisteredProvider(db, id) {
  const why = providerRemovalProblem(id);
  if (why) return { ok: false, error: why };
  const row = (await db.query('SELECT id FROM providers WHERE provider_key=?', [id]))[0];
  let models = 0;
  if (row) {
    const d = await db.query('DELETE FROM models WHERE provider_id=?', [row.id]);
    models = Number((d && d.affectedRows) || 0);
    await db.query('DELETE FROM providers WHERE id=?', [row.id]);
  }
  const out = unregisterProvider(id);
  return { ok: true, models, removed: out.entry };
}

/**
 * 启动载入：把库里**不在代码清单里**的厂商行载入内存注册表（客户网关/内网推理）。
 * 行字段 → 清单同形条目：`provider_key`→id、`name`→name、`base_url`→base、`api_key_env`→keyEnv。
 * 校验不过 ⇒ **报错并跳过该行**（不静默当没看见，也不阻断启动：库里的脏行不该让整个平台起不来）。
 *
 * **默认模型**：`providers` 表没有 defaultModel 列，它是 `models` 表里的那一条（行名口径＝
 * `<厂商名> 默认模型`，与内置厂商播种时**逐字一致**）——所以把 models 行一并传进来就能把它补回来，
 * 不另造存储位置、也不猜"第一个模型就是默认"（查不到就留空串，如实）。
 * @param {Array} rows `SELECT id, provider_key, name, base_url, api_key_env FROM providers` 的行
 * @param {object} keys config.keys（自注册槽位绑到它上面）
 * @param {Array} [modelsRows] `SELECT provider_id, model_id, name FROM models` 的行（缺省＝不补默认模型）
 * @returns {{loaded:string[], problems:string[], skipped:string[]}}
 */
export function loadRegisteredProviders(rows, keys, modelsRows = null) {
  const loaded = []; const problems = []; const skipped = [];
  for (const row of rows || []) {
    const id = row && row.provider_key;
    if (!id || MANIFEST_IDS.has(String(id))) continue;   // 内置厂商的行不在这条路上（它们是代码清单的镜像）
    const def = { id, name: row.name, base: row.base_url, keyEnv: row.api_key_env };
    if (Array.isArray(modelsRows)) {
      const mine = modelsRows.filter((m) => m && m.provider_id === row.id);
      const d = mine.find((m) => m.name === String(row.name) + ' 默认模型');
      if (d) def.defaultModel = String(d.model_id);
    }
    const r = registerProvider(def, keys);
    if (r.ok) loaded.push(String(id));
    else { problems.push(String(id) + '：' + r.error); skipped.push(String(id)); }
  }
  return { loaded, problems, skipped };
}

// 把各厂商 chatModels 清单同步进 models 表（启动时调用）。
// 规则：目录内模型未入库则插入(enabled=1)；已存在则不改 enabled（人工关闭/开启的选择不被启动覆盖），仅补全名称与能力。
// 传入 db 实例（server/db.js 的 query），pRow = providers 表行 {id, provider_key}。
export async function syncChatModels(db, pRow) {
  const p = PROVIDERS.find((x) => x.id === pRow.provider_key);
  if (!p || !p.chatModels || !p.chatModels.length) return 0;
  let n = 0;
  for (const mid of p.chatModels) {
    await db.query(
      'INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ' +
      'ON DUPLICATE KEY UPDATE last_seen_at=NOW()',
      [pRow.id, mid, mid === p.defaultModel ? p.name + '（默认）' : mid, JSON.stringify(p.capabilities || ['chat'])]
    );
    n++;
  }
  return n;
}
