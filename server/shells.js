// server/shells.js - 壳定义（Shell-pack）B1 基座：schema 校验 + pack→壳行映射（纯函数，可单测）
// 依据：proposals/RW-Agent平台化改造总方案-v2.6 §3（v1 字段集；扩展只增不改，向后兼容）
// 说明：本模块不含任何密钥/敏感值处理；凭证规则见 §8（credentials v1.2 仅存引用）。

export const SHELL_DEFAULT_KEY = 'default';

// pack.json 顶层允许的键（v1 + 标注的可选扩展；未知键→校验警告/忽略，保证向前兼容）
export const PACK_ALLOWED_KEYS = [
  'shellPackVersion', 'key', 'name', 'description',
  'identity', 'domain', 'modelPolicy', 'tools', 'knowledge',
  'skills', 'guardrails', 'channels', 'uiBrand', 'eval',
  'intentRules', 'taskProfiles', 'credentials',
];

// JSON 列兼容读取：mysql2 对 JSON 列已自动反序列化为对象/数组/字符串，
// 旧库/手写值可能是 JSON 文本——统一"已是对象直接用，是文本才尝试 parse，parse 失败按原文"。
function jsafe(v, def) {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function isKeyOk(key) {
  return typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(key);
}

export function validatePack(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['pack 必须为对象'] };
  }
  const v = Number(raw.shellPackVersion);
  if (!Number.isFinite(v) || v < 1) errors.push('shellPackVersion 缺失或非法');
  if (!isKeyOk(raw.key)) errors.push('key 需为 2-32 位小写字母/数字/连字符');
  if (typeof raw.name !== 'string' || !raw.name) errors.push('name 缺失');
  // 未知键警告（不阻断：向前兼容，可选扩展先收容）
  const unknown = Object.keys(raw).filter((k) => !PACK_ALLOWED_KEYS.includes(k));
  const warnings = unknown.map((k) => `未知字段(收容): ${k}`);
  // 类型与枚举的轻校验（只做最必要约束；细部在 B 系列实施期校验器扩展）
  const num = (p, name) => { const x = p && p[name]; if (x !== undefined && x !== null && (typeof x !== 'number' || !Number.isFinite(x) || x < 0)) errors.push(`${name} 需为 ≥0 的数字或空`); };
  const arr = (p, name, what) => { const x = p && p[name]; if (x !== undefined && !Array.isArray(x)) errors.push(`${name} 需为数组（${what}）`); };
  const m = raw.modelPolicy || {};
  num(m, 'budgetYuan'); num(m, 'qualityCostBias');
  if (m.qualityCostBias != null && (typeof m.qualityCostBias !== 'number' || m.qualityCostBias < 0 || m.qualityCostBias > 10)) errors.push('qualityCostBias 需为 0-10 的数字或空');
  const t = raw.tools || {};
  if (t.presetBase !== undefined && !['minimal', 'standard', 'all'].includes(t.presetBase)) errors.push('tools.presetBase 需为 minimal|standard|all');
  arr(t, 'forceOn', '工具名'); arr(t, 'forceOff', '工具名');
  arr(t, 'mcps', 'MCP 引用'); arr(t, 'connectors', '连接器引用');
  const k = raw.knowledge || {};
  arr(k, 'scopes', "global|shell|project"); arr(k, 'importRefs', '导入清单');
  const id = raw.identity || {};
  if (id.persona !== undefined && id.persona !== null && typeof id.persona !== 'string') errors.push('identity.persona 需为字符串或空');
  return { ok: errors.length === 0, errors, warnings };
}

// pack → shells 表行（JSON 字段序列化）；persona 空字符串视为 NULL（中性）
export function packToRow(pack) {
  const id = pack.identity || {};
  const m = pack.modelPolicy || {};
  const t = pack.tools || {};
  const k = pack.knowledge || {};
  return {
    skey: pack.key,
    name: pack.name,
    description: pack.description || '',
    persona: id.persona ? JSON.stringify(id.persona) : null,
    domain_text: (pack.domain && (pack.domain.agendsText || '')) || '',
    model_policy: JSON.stringify({ defaultProvider: m.defaultProvider || '', defaultModel: m.defaultModel || '', allowModels: m.allowModels || [], budgetYuan: m.budgetYuan || 0, qualityCostBias: m.qualityCostBias == null ? null : m.qualityCostBias }),
    tools_preset: t.presetBase || 'standard',
    tools_force_on: JSON.stringify(t.forceOn || []),
    tools_force_off: JSON.stringify(t.forceOff || []),
    knowledge_scopes: JSON.stringify(k.scopes || ['global']),
    skills_allow: JSON.stringify((pack.skills && pack.skills.allow) || []),
    guardrails: JSON.stringify((pack.guardrails && pack.guardrails.accessRules) || []),
    channels: JSON.stringify((pack.channels && pack.channels.domainHosts) || []),
    ui_brand: pack.uiBrand ? JSON.stringify(pack.uiBrand) : null,
    eval_ref: (pack.eval && pack.eval.goldenSetRef) || null,
    intent_rules: pack.intentRules ? JSON.stringify(pack.intentRules) : null,
    task_profiles: pack.taskProfiles ? JSON.stringify(pack.taskProfiles) : null,
  };
}

// 壳行 → 三态工具集（force_on/force_off 提取；供 B 系列工具解析层使用）
export function toolsThreeState(row) {
  const on = jsafe(row.tools_force_on, []);
  const off = jsafe(row.tools_force_off, []);
  return { forceOn: Array.isArray(on) ? on : [], forceOff: Array.isArray(off) ? off : [] };
}

// 壳行 → 会话注入用的 persona/domain 摘要（中性壳=null 保持现状）
export function shellContext(row) {
  if (!row) return null;
  const persona = jsafe(row.persona, null);
  return { key: row.skey, persona: (persona && typeof persona === 'string' && persona) ? persona : null, domain: row.domain_text || '' };
}

// 壳行 → pack 对象（供 clone/export；JSON 字段兼容已解析值）
export function rowToPack(row) {
  const mp = jsafe(row.model_policy, {}) || {};
  return {
    shellPackVersion: 1,
    key: row.skey,
    name: row.name,
    description: row.description || '',
    identity: { persona: jsafe(row.persona, null), tone: '', forbidden: [] },
    domain: { agendsText: row.domain_text || '', terms: [] },
    modelPolicy: { defaultProvider: mp.defaultProvider || '', defaultModel: mp.defaultModel || '', allowModels: Array.isArray(mp.allowModels) ? mp.allowModels : [], budgetYuan: mp.budgetYuan || 0, qualityCostBias: mp.qualityCostBias == null ? null : mp.qualityCostBias },
    tools: { presetBase: row.tools_preset || 'standard', forceOn: Array.isArray(jsafe(row.tools_force_on, [])) ? jsafe(row.tools_force_on, []) : [], forceOff: Array.isArray(jsafe(row.tools_force_off, [])) ? jsafe(row.tools_force_off, []) : [], mcps: [], connectors: [] },
    knowledge: { scopes: Array.isArray(jsafe(row.knowledge_scopes, ['global'])) ? jsafe(row.knowledge_scopes, ['global']) : ['global'], importRefs: [] },
    skills: { allow: Array.isArray(jsafe(row.skills_allow, [])) ? jsafe(row.skills_allow, []) : [], defaultsAutoLoad: [] },
    guardrails: { accessRules: Array.isArray(jsafe(row.guardrails, [])) ? jsafe(row.guardrails, []) : [], approvalMode: 'default', sensitiveDefaults: [] },
    channels: { domainHosts: Array.isArray(jsafe(row.channels, [])) ? jsafe(row.channels, []) : [], bindings: {} },
    eval: { goldenSetRef: row.eval_ref || null },
    intentRules: jsafe(row.intent_rules, null) || undefined,
    taskProfiles: jsafe(row.task_profiles, null) || undefined,
  };
}
