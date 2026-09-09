// server/intent.js - B2 意图识别 v1（纯函数，可单测）
// 依据：总方案 B §7.1（旧编号 v2.7 §6.1，2026-09-10 治理改指）——输出标签：要动手·普通 / 要动手·高危 / 只读规划 / 闲聊·收尾；未判定时询问。
// 说明：本模块只做"分类与回显文案"，不改变现有 needsTools/工具面行为（回归由既有路径保证）；
// 高危→审批联动与 LLM 兜底为后续批次（默认关）。

// 默认词表（default 壳兜底；语义对齐旧 TOOL_INTENT_RE 的关键词族 + 高危/只读细分）
export const DEFAULT_INTENT = {
  highRisk: ['删除', '删库', '清空', '重置.{0,4}库', '测试库', '生产库', '线上库', 'drop\\s', '格式化', '推送', '强制', '直接改.{0,6}库', '销毁'],
  readonly: ['先别改', '只读', '方案', '设计一下', '评估', '分析', '调研', '建议', '聊聊', '讨论', '计划', '怎么看', '思考', 'review'],
  do: ['修', '改', '加', '建', '写', '删', '查', '跑', '部署', '修复', '处理', '清理', '生成', '创建', '调', '做一下', '搞定', '解决', '安装', '升级', '迁移', '重构', '测试', '验证', '拾掇', '弄一下', '试一下'],
};

function build(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return null;
  try { return new RegExp('(' + patterns.join('|') + ')'); } catch { return null; }
}

// text：用户消息（前 200 字符）；rules：壳词表 {highRisk, readonly, do}（可缺省 → DEFAULT_INTENT）
// 返回 { label: 'act-high'|'act'|'readonly'|'chat'|'ask', echo, hit }
export function classifyIntent(text, rules) {
  const t = String(text || '').slice(0, 200);
  const r = {
    highRisk: build((rules && rules.highRisk) || DEFAULT_INTENT.highRisk),
    readonly: build((rules && rules.readonly) || DEFAULT_INTENT.readonly),
    do: build((rules && rules.do) || DEFAULT_INTENT.do),
  };
  const hit = (re) => { if (!re) return false; re.lastIndex = 0; return re.test(t); };
  const isHi = hit(r.highRisk);
  const isRead = hit(r.readonly);
  const isDo = hit(r.do);
  if (isHi) return { label: 'act-high', hit: 'highRisk', echo: '👆 我理解：要我动手·高危（涉及删除/生产/推送类操作）→ 将先走审批，批准后才执行' };
  // 优先级：高危 > 只读（只读标识如"先别改/方案/分析/评估"覆盖普通动手词，防误动）
  if (isRead) return { label: 'readonly', hit: 'readonly', echo: '👆 我理解：先讨论 · 只读规划 → 只做查证与方案，不改任何文件' };
  if (isDo) return { label: 'act', hit: 'do', echo: '👆 我理解：要我动手·普通 → 将使用本壳工具链执行；若只想讨论请说明' };
  // 像任务但无命中 → 拿不准就问（杜绝假答应）
  if (t.length >= 2 && /[做搞改弄处].{0,8}(一下|下|个|了)?$|帮.{0,12}(做|弄|改|查|处理|看)/.test(t)) {
    return { label: 'ask', hit: null, echo: '👆 我没太确定你是想让我动手还是只讨论——你先说一声，我再开始' };
  }
  return { label: 'chat', hit: null, echo: null };
}
