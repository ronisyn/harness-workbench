// server/modelwindow.js - RA-08 比例制折叠阈值：把"折叠触发字符数"绑到**模型窗口**上，换小窗口模型自动收紧。
// 单位说明（不得含糊）：窗口按 **tokens**、折叠阈值按 **字符**，换算靠 CHARS_PER_TOKEN —— 这是**启发式**：
// 中文 ≈1.5 字符/token、英文/JSON ≈4 字符/token，这里取保守的 1.5 并**如实标注为估算**（§5.3 计量口径：启发式只驱动决策，不作上报口径）。
// 未知模型的窗口 → **回退绝对值**并说明原因（不猜、不静默）。
export const CHARS_PER_TOKEN = 1.5; // 保守估算（中文为主场景）

// 已知模型窗口（tokens）。键按**子串**匹配（模型名常带版本后缀）；未列出的模型回退绝对值。
export const WINDOW_DEFAULTS = {
  'deepseek-v4': 131072,
  'deepseek-v3': 65536,
  'deepseek': 65536,
  'glm-4': 131072,
  'glm': 131072,
  'gpt-4o': 131072,
  'claude': 204800,
  'qwen': 131072,
};

/** 取模型窗口（tokens）：优先设置里的覆盖表，其次内置默认表，都没有 → null（未知） */
export function windowOf(model, overrides) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  const ov = overrides && typeof overrides === 'object' ? overrides : null;
  for (const [k, v] of Object.entries(ov || {})) {
    if (m.includes(String(k).toLowerCase())) { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; }
  }
  for (const [k, v] of Object.entries(WINDOW_DEFAULTS)) if (m.includes(k)) return v;
  return null;
}

/**
 * 折叠触发字符数的**有效值**：min(绝对阈值, 窗口 × 比例 × 字符/token)。
 * @returns {{chars:number, source:'absolute'|'ratio', windowTokens:number|null, note:string}}
 */
export function effectiveCollapseChars(model, absoluteChars, ratio, overrides) {
  const abs = Number.isFinite(absoluteChars) && absoluteChars > 0 ? absoluteChars : 30000;
  // ratio === 0 ＝**显式关闭比例制**（settings `collapse_window_ratio` 的 0 语义，schema 已如此声明）：
  // 只用绝对阈值。必须与"脏值回退默认比例"分开——负数/NaN 是配置错误，按默认 0.15 处理；
  // 0 是明确意图，必须照办（否则界面上写"0=关闭"，实际仍按 15% 收紧，是静默说谎）。
  // 只认严格 0：null/undefined（没传）走下面的默认分支，不当成"关闭"。
  if (ratio === 0) return { chars: abs, source: 'absolute', windowTokens: windowOf(model, overrides), note: '比例制已关闭（collapse_window_ratio=0），只用绝对阈值 ' + abs + ' 字符' };
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.15;
  const w = windowOf(model, overrides);
  if (!w) return { chars: abs, source: 'absolute', windowTokens: null, note: '模型窗口未知，按绝对阈值（' + abs + ' 字符）' };
  const byRatio = Math.floor(w * r * CHARS_PER_TOKEN);
  if (byRatio >= abs) return { chars: abs, source: 'absolute', windowTokens: w, note: '窗口 ' + w + ' tokens → 比例阈值 ' + byRatio + ' ≥ 绝对阈值，取绝对阈值' };
  return { chars: byRatio, source: 'ratio', windowTokens: w, note: '窗口 ' + w + ' tokens × 比例 ' + r + ' × ' + CHARS_PER_TOKEN + ' 字符/token（启发式）→ ' + byRatio + ' 字符' };
}
