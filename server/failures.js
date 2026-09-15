// server/failures.js —— 失败分类的**唯一出处**（架构项：统一失败分类）
//
// 为什么要它：在这之前，"失败"在很多地方是一句自由中文（`{ error: '...' }`），于是
//   · 无法路由：哪些该重试、哪些该换法子、哪些必须问人，只能靠临时写 if；
//   · 无法统计：账本里只有 status=fail，回答不了"最常见的是哪种失败"；
//   · 无法机检：同一类失败在十处各写一句话，改名/漏改没人发现。
// DSH 的做法是全线路结构化错误（工具结果是 `{isError:true, error:{info:{code}}}`，重试策略读
// `failure.code`）。这里照做其中最小可用的一份：**码表 + 分类函数**，并且用一个硬约束防止它腐烂——
// 用未登记的码直接抛错（`fail()` 里），夹具再交叉核对"代码里出现的码都在表里"。
//
// 口径（与《缓存追平DSH方案》里"只报数不设线"一致）：码表只回答"这是什么失败、能不能重试"，
// **不携带任何阈值**；具体重试几次、等多久，仍由 settings 与服务端 Retry-After 决定。

/** 失败码表。retryable=同一动作原地重试是否有意义；note=给人看的处置说明。 */
export const FAIL = {
  // ---------- 工具侧 ----------
  TOOL_TIMEOUT: { retryable: false, note: '超出工具声明的界限；工具已不再等待（可改小粒度重试）' },
  TOOL_UNKNOWN: { retryable: false, note: '模型调用了不存在的工具名' },
  TOOL_SCOPE_DENIED: { retryable: false, note: '子代理工具面收窄，该工具不在其范围内' },
  TOOL_SHELL_DENIED: { retryable: false, note: '当前壳未装载该工具，或已按壳强制下线' },
  TOOL_PERMISSION_DENIED: { retryable: false, note: '会话权限低于工具要求（用别的工具或让用户提权）' },
  TOOL_APPROVAL_DENIED: { retryable: false, note: '用户未批准该操作（含明确拒绝）' },
  TOOL_APPROVAL_TIMEOUT: { retryable: false, note: '审批等待超时' },
  TOOL_QUEUED_UNATTENDED: { retryable: false, note: '无人值守下该操作需授权 → 已排队，应停下做阶段总结' },
  TOOL_HOOK_BLOCKED: { retryable: false, note: '被纪律钩子拦截（preset/启用集/只读意图/命令纪律）' },
  TOOL_ARGS_INVALID: { retryable: false, note: '参数不满足工具契约（缺必填/类型错/取值越界）' },
  // 2026-09-15 按真实失败分布加的一条（近 14 天：db_query「Unknown column」22 次、edit_file「old 不匹配」6 次、
  // list_dir/read_file ENOENT 9 次）：**输入与现实不符**。它与 TOOL_ERROR 必须分开——一个要工程师看
  // （平台坏了），一个要模型改参数（平台没坏，是猜错了表名/路径/原文）。混在一起，失败报告读不出该修谁。
  TOOL_INPUT_REJECTED: { retryable: false, note: '输入与实际不符（表名/列名/路径不存在、原文不匹配）——模型改参数即可，不是平台故障' },
  TOOL_ARGS_PLACEHOLDER: { retryable: false, note: '参数含平台瘦身占位符，拒绝执行防静默写坏文件' },
  TOOL_PATH_DENIED: { retryable: false, note: '路径超出会话工作区' },
  UPSTREAM_UNAVAILABLE: { retryable: true, note: '外部依赖不可用（未连接/网络类）；等它恢复再试才有意义' },
  ABORTED: { retryable: false, note: '用户停止或会话结束' },
  TOOL_ERROR: { retryable: false, note: '工具自身失败（未分类兜底）' },
  // ---------- LLM 侧（与 server/llm/gateway.js 的 llmRetryDecision 同表） ----------
  LLM_ABORTED: { retryable: false, note: '用户已停止（绝不能重试——等于把停止键按回去）' },
  LLM_RATE_LIMITED: { retryable: true, note: '厂商限流；等待时长优先用服务端 Retry-After' },
  LLM_HTTP_RETRYABLE: { retryable: true, note: '厂商侧可恢复的 HTTP 状态（408/409/425/5xx）' },
  LLM_HTTP_FATAL: { retryable: false, note: '请求被拒（参数/鉴权/模型不存在），重试无效' },
  LLM_NETWORK: { retryable: true, note: '网络/空闲超时类失败' },
  LLM_STREAM_BROKEN: { retryable: false, note: '流式帧损坏 → 走非流式兜底（那是另一种机制，不是重试）' },
  LLM_UNKNOWN: { retryable: false, note: '未分类失败（按不可重试处理）' },
  // ---------- HTTP 对外接口侧（2026-09-16，D4/RA-42） ----------
  // 这几条是**响应体里的机器可读码**（`{ok:false, code}`），不走工具失败分类，但同表登记——理由与上面一样：
  // 码表是唯一出处，夹具的"源码里出现的码都在表里"交叉核对才拦得住改名/漏登记。
  // retryable 在这里的含义是"调用方原样重试是否有意义"（与工具侧同义）。
  PARAM_MISSING: { retryable: false, note: '请求参数缺失（调用方改参数，重试无效）' },
  CONV_NOT_FOUND: { retryable: false, note: '会话不存在或不属于本账号' },
  CONCURRENCY_LIMIT: { retryable: true, note: '同账号并发对话已达上限；槽位何时释放取决于别人的对话，故服务端**不给** Retry-After，调用方按指数退避重试' },
  IDEMPOTENT_IN_PROGRESS: { retryable: true, note: '同一幂等键的上一次请求仍在进行中；稍后用同一个键重试即可（不会重复执行）' },
  IDEMPOTENT_KEY_REUSED: { retryable: false, note: '同一幂等键对应的请求体与上次不同；换键或原样重发上次的请求' },
  STOPPED_BY_USER: { retryable: false, note: '用户点了停止（投递记为 failed，同一个键可重发）' },
  CLIENT_DISCONNECTED: { retryable: true, note: '调用方在收到 done 之前断连 ⇒ 服务端已中止本轮；同一个键重发即重做' },
  EXPORT_FAILED: { retryable: false, note: '会话导出失败（看 message）' },
  IMPORT_FAILED: { retryable: false, note: '会话导入失败（格式版本/校验/事务回滚，看 message）' },
  INTERNAL: { retryable: true, note: '服务端未预期异常；已记堆栈，调用方可退避重试' },
};

/**
 * 构造一个带码的失败结果（工具结果口径：`{error, code}`，与 toolTimeoutResult 同形）。
 * **未登记的码直接抛错**：宁可当场炸，也不要让表外的码流进账本（否则统计里会出现没人认识的分类）。
 */
export function fail(code, message, extra) {
  const spec = FAIL[code];
  if (!spec) throw new Error('未登记的失败码：' + code + '（请先在 server/failures.js 的 FAIL 里登记）');
  return { error: message, code, ...(extra || {}) };
}

/** 码表查询（给统计/报告脚本用，永不抛） */
export function failSpec(code) { return FAIL[code] || null; }

const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
// "输入与现实不符"的可靠信号：文件系统的 ENOENT + MySQL 的输入类错误码（都是标准 errno，不是文案）
const INPUT_ERRNOS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST']);
const MYSQL_INPUT_CODES = new Set(['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_PARSE_ERROR', 'ER_BAD_DB_ERROR', 'ER_NON_UNIQ_ERROR', 'ER_BAD_NULL_ERROR', 'ER_TRUNCATED_WRONG_VALUE']);

/** 工具**自己**判定"你的输入与现实不符"时用它抛错（比让上层猜文案可靠）。 */
export function inputError(message) {
  const e = new Error(message);
  e.code = 'TOOL_INPUT_REJECTED';
  return e;
}

/**
 * 把工具实现里抛出的异常分类成码（execTool 的统一兜底）。
 * 只认**可靠信号**（错误对象的字段/名字/标准 errno），不靠中文文案猜——文案会改，码不能跟着改。
 */
export function classifyToolThrow(e) {
  const msg = String((e && e.message) || e);
  if (e && e.aborted) return fail('ABORTED', msg);
  if (e && e.code === 'TOOL_TIMEOUT') return fail('TOOL_TIMEOUT', msg);
  if (NET_CODES.has(e && e.code)) return fail('UPSTREAM_UNAVAILABLE', msg);
  // 输入与现实不符：路径不存在、表/列名猜错、SQL 语法错 —— 平台没坏，是参数要与现实对齐
  if (INPUT_ERRNOS.has(e && e.code) || MYSQL_INPUT_CODES.has(e && e.code) || (e && e.code === 'TOOL_INPUT_REJECTED')) {
    return fail('TOOL_INPUT_REJECTED', msg);
  }
  // fetch 被我们自己的 signal 中止 → AbortError；到点中止 → TimeoutError（两者都归"超时/中止"这一类，
  // 因为工具已经被明确告知界限，继续等没有意义）
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return fail('TOOL_TIMEOUT', msg);
  if (/fetch failed|socket hang up|server 未连接|未连接/i.test(msg)) return fail('UPSTREAM_UNAVAILABLE', msg);
  return fail('TOOL_ERROR', msg);
}
