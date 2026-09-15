// server/settingsSchema.js - 可调设置 schema（WS4：一处声明 → API 校验/UI 渲染/默认值同源）
// 护栏哲学：所有护栏键 type=number 且允许 0=不限/关（可调可关可解释=保险丝而非高跷）；禁止登记死限式不可调键
export const LIMIT_DEFAULTS = { budgetMin: 120, roundCap: 2000, loopGuard: 6, maxParallelT: 10, fakeContinueWarn: 2, progressStallN: 10, fuseInteractive: 0, llmMaxRetries: 1 };

export const SETTINGS_SCHEMA = [
  { key: 'time_budget_min', label: '时间预算（分钟，仅无人值守）', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.budgetMin, min: 0, hint: '**只在无人值守时生效**（定时任务/契约驱动器/子代理）。人在场的会话不再被墙钟掐断（2026-09-15 拍板），改由"无进展轮数"判据停；0=不限' },
  { key: 'round_cap', label: '轮次上限（仅无人值守）', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.roundCap, min: 0, hint: '**只在无人值守时生效**。人在场的会话改用 progress_stall_n（"连续多少轮没有新进展"）；0=不限' },
  { key: 'progress_stall_n', label: '无进展轮数上限', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.progressStallN, min: 0, hint: '连续多少轮"没有任何新进展"（没改东西、没新调用、没有转成功、结果也没变）就挂起并如实说明在重复什么；对交互式与无人值守都生效；0=关闭' },
  { key: 'fuse_interactive', label: '交互式也启用轮次/时间熔断', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.fuseInteractive, min: 0, max: 1, hint: '0=关（默认，人在场时只靠无进展判据）；1=把上面两条数字熔断也套到人在场的会话上（恢复 2026-09-15 之前的行为）' },
  // 2026-09-15（对齐 DSH dsh-llm-retry）：每轮"流式请求失败后允许重试几次"。只对**可恢复**失败重试
  // （限流 429/网关 5xx/网络类）；参数、鉴权、模型不存在等 4xx 不重试（重试纯属浪费）。0=关（只保留非流式兜底）
  { key: 'llm_max_retries', label: 'LLM 每轮可重试次数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.llmMaxRetries, min: 0, hint: '每轮最多重试几次（默认 1）。只在可恢复失败时重试：限流 429、网关 5xx、网络/空闲超时；等待时长用服务端 Retry-After（没有则立刻重试）。用户点"停止"会立即中断等待。0=关' },
  { key: 'loop_guard', label: '循环检测连续次数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.loopGuard, min: 0, hint: '连续相同调用判循环；0=关闭' },
  { key: 'max_parallel_tools', label: '同一步并行工具数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.maxParallelT, min: 0, hint: '0=串行' },
  { key: 'fake_continue_warn', label: '假完成检测打回次数', group: 'runtime', type: 'number', def: LIMIT_DEFAULTS.fakeContinueWarn, min: 0, hint: '回复声称已执行但本轮无任何工具调用时打回要求真实执行；N 次后仍犯则自动加"未经验证"标注；0=关闭' },
  { key: 'task_budget_yuan', label: '单段成本提醒阈值（元，默认关）', group: 'budget', type: 'number', def: 0, min: 0, hint: '默认 0=关闭（不要中途节奏暂停）；需要时开启：任务每累计该金额暂停一次问你"继续吗"。真正上限由"任务总预算"承担' },
  { key: 'task_budget_total', label: '任务总预算（元/会话 24h）', group: 'budget', type: 'number', def: 100, min: 0, hint: '会话 24h 总账上限（含子代理，跨"继续"累计）；超限停止并提示调大；0=不限' },
  // F3 折叠阈值（2026-09 批1，0=用默认）：长任务语义折叠（maybeCollapseEarly）的触发条件参数化
  { key: 'collapse_min_gap', label: '折叠最小间隔（轮）', group: 'context', type: 'number', def: 20, min: 0, hint: '距上次折叠至少多少轮才再次折叠；0=默认20' },
  { key: 'collapse_keep_msgs', label: '折叠保留最近消息数', group: 'context', type: 'number', def: 80, min: 0, hint: '折叠时保留最近 N 条消息；0=默认80；下限 10（过小会每轮折掉工作集、会话无法收敛）' },
  { key: 'collapse_trigger_chars', label: '折叠触发字符阈值', group: 'context', type: 'number', def: 30000, min: 0, hint: '早期消息总字符超此值才折叠（防无谓 LLM 成本）；0=默认30000' },
  { key: 'collapse_input_chars', label: '折叠摘要输入截断字符', group: 'context', type: 'number', def: 18000, min: 0, hint: '送折叠 LLM 的早期文本截断上限；0=默认18000' },
  // RA-08（2026-09 步8后）：折叠阈值绑模型窗口——换小窗口模型自动收紧（比例制），未知模型回退上面的绝对阈值
  { key: 'collapse_window_ratio', label: '折叠窗口占比', group: 'context', type: 'number', def: 15, min: 0, max: 100, hint: '折叠触发阈值=模型窗口×该百分比（换算按 1.5 字符/token 的保守估算）；0=关闭比例制只用绝对阈值' },
  // F4 连续失败轮计数（2026-09 批1）：工具连续失败 N 次软提示换策略，仍失败挂起 paused（0=关闭）
  { key: 'consecutive_fail_guard', label: '连续失败保护次数', group: 'runtime', type: 'number', def: 3, min: 0, hint: '工具连续失败 N 次→软提示换策略一次；再失败→挂起 paused（现场保留可"继续任务"恢复）；0=关闭' },
  // P18 并发对话上限（2026-09 批2）：同账号同时在跑的对话数上限（默认 5；0=不限）；超限拒绝并提示队列位置
  { key: 'max_concurrent_chats', label: '并发对话上限', group: 'runtime', type: 'number', def: 5, min: 0, hint: '同账号同时在跑的对话数上限；0=不限。超限时新对话被拒并提示前面还有几轮在跑' },
  // 2026-09-11 A1（总方案 §8.10 缓存命中率目标）：观测类键——不入 runtime（PUT 不 bump policy_rev）；0 与空同义=不启用
  { key: 'cache_hit_rate_target', label: '缓存命中率目标（%）', group: 'observe', type: 'number', def: 0, min: 0, max: 100, hint: '0=不启用（留空同义）。启用后：命中率(近7/30日均值)低于目标→首页状态带横条告警+进化集生成建议；状态带同时显示当日值与均值' },
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
