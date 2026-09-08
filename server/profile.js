// server/profile.js - B3 任务档案解析（纯函数，可单测）
// 依据：v2.8 §6.2——档案触发 v1=用户点名/UI 选择（不自动猜）；三级路由：显式(绝对锁)>档案建议>壳默认。
export const DEFAULT_TASK_PROFILES = [
  { key: 'small-fix', name: '小修', match: ['小修', '小改', 'quick fix'], modelHint: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash', qualityCostBias: 3 } },
  { key: 'refactor-plan', name: '重构方案', match: ['重构方案', 'refactor plan'], modelHint: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro', qualityCostBias: 7 }, readonlyOnly: true },
  { key: 'feature-delivery', name: '新功能交付', match: ['新功能交付', 'feature delivery'], modelHint: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro', qualityCostBias: 6 } },
];

// profiles: [{key,name,match[],modelHint:{defaultProvider,defaultModel,qualityCostBias},readonlyOnly?}]
// content: 用户消息前 200 字；仅做"显式点名"识别（如"按 小修/refactor-plan 档案做"或含 name/match 词）。
export function resolveTaskProfile(content, profiles) {
  const list = Array.isArray(profiles) && profiles.length ? profiles : DEFAULT_TASK_PROFILES;
  const raw = String(content || '').slice(0, 200);
  const t = raw.replace(/\s+/g, ''); // 去空白，容忍"用 refactor-plan"
  for (const p of list) {
    if (!p) continue;
    const keys = [p.key, p.name, ...(Array.isArray(p.match) ? p.match : [])].filter(Boolean);
    for (const k of keys) {
      if (!k) continue;
      const kk = String(k);
      if (t.includes('按' + kk) || t.includes('用' + kk) || t.includes(kk + '模式') || t.includes(kk + '来做') || t.includes(kk + '执行')) {
        return { profile: p, via: kk };
      }
    }
  }
  return null;
}

export function profileEcho(p) {
  const h = (p && p.modelHint) || {};
  const bias = h.qualityCostBias == null ? '' : '（质量-成本偏好 ' + h.qualityCostBias + '）';
  return { type: 'route', profile: (p && p.key) || null, suggestModel: h.defaultModel || null, suggestProvider: h.defaultProvider || null, echo: '📋 任务档案：' + (p && p.name) + ' → 建议模型 ' + (h.defaultModel || '壳默认') + bias + '；你可显式换模型（显式选择始终优先）' };
}
