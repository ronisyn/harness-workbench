// server/subtools.js - RA-12 子代理工具面收窄（纯函数，不碰 DB／不碰 HTTP）
// 依据《RW-Agent 架构 v1.1》§14.4：
//   RA-12 查库存的子代理，工具清单里**只有** `inventory.query`（其他**根本不出现**）
// 口径（为什么是"收窄"而不是"换一套"）：
//   · 父级已有两道既有裁剪——会话 preset 档位（core/pro/exp 分级）与账号启用集（`ctx.__enabledTools`）。
//     子代理**继承**这两道，再叠加自己的白名单 → **只能更窄**（与 RA-17「子代理视窗只能比父级更窄」同构）。
//   · 白名单是"必选集"：名字不在名单里的工具**不出现在 schema、执行层也拒绝**——两处同口径，
//     否则模型看不见却仍能调（等价于没收窄，只是变隐蔽）。
//   · 取名/查重的校验放在这里（纯函数），装配处（subagent.js / tools/index.js）只负责传参 —— 因为
//     "名单里写了不存在的工具"是**调用方错误**，必须当场抛错，而不是静默给一个更宽的面（清单不许说谎）。
import { MANIFEST_NAMES, PLATFORM_EXEMPT } from './tools/registry.js';

/**
 * 解析调用方给的 tools 白名单。
 * @param {string|string[]|null|undefined} tools 逗号分隔字符串或数组；空/缺省 = 不限（继承父级面）
 * @returns {Set<string>|null} null = 不限；Set = 白名单（非空）
 */
export function parseToolWhitelist(tools) {
  if (tools == null) return null;
  const list = (Array.isArray(tools) ? tools : String(tools).split(/[,，\s]+/))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!list.length) return null;
  const bad = list.filter((n) => !MANIFEST_NAMES.includes(n));
  if (bad.length) throw new Error('子代理 tools 白名单里有未装载的工具：' + bad.join(', ') + '（按清单 tools/manifest.js 为准；可先用 list_tools 查）');
  return new Set(list);
}

/**
 * 叠加白名单：父级启用集 ∩ 名单 → 新的启用集。
 * @param {Set<string>|null} parentEnabled 父级启用集（null=全部启用）
 * @param {Set<string>|null} whitelist parseToolWhitelist 的结果
 * @returns {Set<string>|null} null=不限
 */
export function narrowEnabled(parentEnabled, whitelist) {
  if (!whitelist) return parentEnabled || null;
  if (!parentEnabled) return whitelist;
  return new Set([...whitelist].filter((n) => parentEnabled.has(n)));
}

/**
 * 执行层门禁：白名单存在且名字不在其中 → 返回拒绝文案；否则 null（放行）。
 * 平台豁免工具（清单里标 `exempt`，见 tools/manifest.js）**照旧在**：它们是平台安全/取证底座
 * （`set_limits` / `reload_platform` / `undo_checkpoint` / `hooks_list` / `fetch_spill` / `intake_submit`），
 * 不是"模型可自由选的业务能力"，收窄业务工具面时把它们一并切掉只会让子代理失去回滚与取证手段。
 * 这条同时保证 **schema 层与执行层同口径**——toolDefs 里靠 PLATFORM_EXEMPT 保留，这里就必须同样保留，
 * 否则会出现"看得见却调不动"的假清单。
 * @param {Set<string>|null} whitelist
 * @param {string} name
 */
export function subtoolRefusal(whitelist, name) {
  if (!whitelist) return null;
  const n = String(name);
  if (whitelist.has(n) || PLATFORM_EXEMPT.includes(n)) return null;
  return '工具 ' + n + ' 不在本子代理的工具清单内（派发时用 tools 收窄过）。请改用清单内的工具完成任务；若确实需要该工具，把需求回报给父代理。';
}
