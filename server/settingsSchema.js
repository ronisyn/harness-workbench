// server/settingsSchema.js - 可调设置 schema（WS4：一处声明 → API 校验/UI 渲染/默认值同源）
// 护栏哲学：所有护栏键 type=number 且允许 0=不限/关（可调可关可解释=保险丝而非高跷）；禁止登记死限式不可调键
export const LIMIT_DEFAULTS = { budgetMin: 120, roundCap: 2000, loopGuard: 6, maxParallelT: 10, fakeContinueWarn: 2 };

export const SETTINGS_SCHEMA = [
  { key: 'time_budget_min', label: '时间预算（分钟）', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.budgetMin, min: 0, hint: '单任务时间预算；0=不限。防失控保险丝，非能力上限，可 set_limits 调' },
  { key: 'round_cap', label: '轮次上限', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.roundCap, min: 0, hint: '单任务最大工具轮次；0=不限' },
  { key: 'loop_guard', label: '循环检测连续次数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.loopGuard, min: 0, hint: '连续相同调用判循环；0=关闭' },
  { key: 'max_parallel_tools', label: '同一步并行工具数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.maxParallelT, min: 0, hint: '0=串行' },
  { key: 'fake_continue_warn', label: '假完成检测打回次数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.fakeContinueWarn, min: 0, hint: '回复声称已执行但本轮无任何工具调用时打回要求真实执行；N 次后仍犯则自动加"未经验证"标注；0=关闭' },
  { key: 'task_budget_yuan', label: '单段成本提醒阈值（元，默认关）', group: 'budget', type: 'number', def: 0, min: 0, hint: '默认 0=关闭（不要中途节奏暂停）；需要时开启：任务每累计该金额暂停一次问你"继续吗"。真正上限由"任务总预算"承担' },
  { key: 'task_budget_total', label: '任务总预算（元/会话 24h）', group: 'budget', type: 'number', def: 100, min: 0, hint: '会话 24h 总账上限（含子代理，跨"继续"累计）；超限停止并提示调大；0=不限' },
  { key: 'selfchange_budget_yuan', label: '自改任务成本知情阈值（元）', group: 'budget', type: 'number', def: 20, min: 0, hint: '阶段2 自改平台代码时同语义阈值；0=关闭' },
  // F3 折叠阈值（2026-09 批1，0=用默认）：长任务语义折叠（maybeCollapseEarly）的触发条件参数化
  { key: 'collapse_min_gap', label: '折叠最小间隔（轮）', group: 'context', type: 'number', def: 20, min: 0, hint: '距上次折叠至少多少轮才再次折叠；0=默认20' },
  { key: 'collapse_keep_msgs', label: '折叠保留最近消息数', group: 'context', type: 'number', def: 80, min: 0, hint: '折叠时保留最近 N 条消息；0=默认80' },
  { key: 'collapse_trigger_chars', label: '折叠触发字符阈值', group: 'context', type: 'number', def: 30000, min: 0, hint: '早期消息总字符超此值才折叠（防无谓 LLM 成本）；0=默认30000' },
  { key: 'collapse_input_chars', label: '折叠摘要输入截断字符', group: 'context', type: 'number', def: 18000, min: 0, hint: '送折叠 LLM 的早期文本截断上限；0=默认18000' },
  // F4 连续失败轮计数（2026-09 批1）：工具连续失败 N 次软提示换策略，仍失败挂起 paused（0=关闭）
  { key: 'consecutive_fail_guard', label: '连续失败保护次数', group: 'runtime', type: 'number', def: 3, min: 0, hint: '工具连续失败 N 次→软提示换策略一次；再失败→挂起 paused（现场保留可"继续任务"恢复）；0=关闭' },
];

export function schemaByKey(key) {
  return SETTINGS_SCHEMA.find((s) => s.key === key) || null;
}
// 校验（返回 {ok, value|error}）：number 类型 + min 边界
export function validateSetting(key, val) {
  const s = schemaByKey(key);
  if (!s) return { ok: true, value: val }; // 非登记键：放行（兼容存量键，如 systemPrompt/temperature）
  if (s.type === 'number') {
    const n = Number(val);
    if (!Number.isFinite(n) || n < s.min) return { ok: false, error: `${key} 需为 ≥${s.min} 的数字` };
    return { ok: true, value: n };
  }
  return { ok: true, value: val };
}
