// server/tools/registry.js - 工具注册表（架构 §4.1 的「工具注册表」层）：清单驱动的**一次性装载 + 校验**
// 装配关系：tools/manifest.js（声明式权威：档位/中文名/提示/集合/上下线） × tools/index.js（实现）
//   · 清单里声明了却不存在的实现 → **抛错**（清单不许说谎）
//   · 有实现却没进清单 → **跳过 + 告警**（默认拒绝：下线一个工具＝删/停用清单行，零代码改动）
//   · 重名 / 档位非法 / 缺 run → 抛错（装配期发现，不留到运行期）
// 本模块**不 import tools/index.js**（避免循环依赖）：元数据与集合只由清单派生，任何模块都可直接引用。
import { TOOL_MANIFEST, TOOL_TIER_CN } from './manifest.js';

const TIERS = ['core', 'pro', 'expert'];
const ENABLED = (m) => m && m.enabled !== false; // 缺省启用；enabled:false = 留痕式下线

// ---- 清单派生（与实现无关，避免循环依赖）----
export { TOOL_TIER_CN };
export const TOOL_META = {};
export const TOOL_CN = {};
export const DEFAULT_TOOLSET = [];
export const PLATFORM_EXEMPT = [];
export const LIGHT_TOOLSET = [];
export const MANIFEST_NAMES = [];
for (const [name, m] of Object.entries(TOOL_MANIFEST)) {
  if (!ENABLED(m)) continue;
  if (!TIERS.includes(m.tier)) throw new Error('[registry] 清单档位非法：' + name + ' tier=' + m.tier);
  MANIFEST_NAMES.push(name);
  TOOL_META[name] = { tier: m.tier, when: m.when || '', not: m.not || '', ex: m.ex || '' };
  TOOL_CN[name] = m.cn || name;
  if (m.defaultOn) DEFAULT_TOOLSET.push(name);
  if (m.exempt) PLATFORM_EXEMPT.push(name);
  if (m.light) LIGHT_TOOLSET.push(name);
}

/**
 * 装载实现：清单 × 实现 → 运行时工具表（顺序沿用实现声明顺序）。
 * @param {Array} rawTools 实现侧工具条目（name/description/params/permission/run）
 * @returns {Array} 通过校验、且**在清单里的**工具
 */
export function assembleTools(rawTools) {
  const problems = [];
  const seen = new Set();
  for (const t of rawTools || []) {
    if (!t || !t.name) { problems.push('存在无名工具条目'); continue; }
    if (seen.has(t.name)) problems.push('工具重名：' + t.name);
    seen.add(t.name);
    if (typeof t.run !== 'function') problems.push('工具缺少 run 实现：' + t.name);
    if (!t.description) problems.push('工具缺少 description（模型选择依据）：' + t.name);
    if (!t.permission) problems.push('工具缺少 permission：' + t.name);
  }
  const missingImpl = MANIFEST_NAMES.filter((n) => !seen.has(n));
  for (const n of missingImpl) problems.push('清单声明了不存在的工具（无实现）：' + n);
  if (problems.length) throw new Error('[registry] 工具装载失败（清单与实现不一致）：\n  - ' + problems.join('\n  - '));

  const disabled = Object.entries(TOOL_MANIFEST).filter(([, m]) => !ENABLED(m)).map(([n]) => n);
  const unlisted = (rawTools || []).map((t) => t.name).filter((n) => !MANIFEST_NAMES.includes(n));
  if (unlisted.length) console.warn('[registry] 未进清单，已按默认拒绝不装载：' + unlisted.join(', ') + '（要启用请在 tools/manifest.js 补一行）');
  if (disabled.length) console.log('[registry] 清单标注 enabled:false，未装载：' + disabled.join(', '));

  const out = [];
  for (const t of rawTools || []) if (MANIFEST_NAMES.includes(t.name)) out.push(t);
  return out;
}
