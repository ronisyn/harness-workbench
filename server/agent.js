// server/agent.js - Agent 执行循环（目标完成度判断：干完就停，没干完继续）
// 不设预设轮次：模型每轮评估"目标完成没"——完成直接回答即停；未完成继续调工具
// 运行护栏（WS2 v1.0 语义=防失控保险丝，非能力上限）：时间预算/轮次/循环检测 —— 全部可在 settings 表调整或关闭（0=不限），
// 护栏现值每轮读取（5s 缓存仅防 DB 风暴），并随【运行时快照】每轮注入上下文：模型看得见钱包与规则版本，中途变更最快 5s 内可见生效
import { chatOnceWithTools, chatOnce, calcCost } from './llm/gateway.js';
import { toolDefs, execTool, plans, jobs } from './tools/index.js';
import { db } from './db.js';
import { checkpoint } from './runtrack.js';
import { LIMIT_DEFAULTS } from './settingsSchema.js';

// 会话活动事件环（旁观/断连页面实时性修复）：runAgent 的 emit 事件同时写入内存环，
// 前端轮询 /api/conversations/:id/activity 拿增量（SSE 直达时零影响，断连/旁观时兜底）
const activity = new Map(); // convId -> { items: [{seq,at,type,...}] }
let actSeq = 0;
const ACT_MAX = 300;
function emitEv(conversationId, emit, ev) {
  try { if (emit) emit(ev); } catch { /* 外部 emit 失败不影响执行 */ }
  if (!conversationId) return;
  try {
    const key = String(conversationId);
    let rec = activity.get(key);
    if (!rec) { rec = { items: [] }; activity.set(key, rec); }
    let item = { seq: ++actSeq, at: Date.now(), ...ev };
    // think 增量合并（同轮 3s 内拼接，避免环被思考文本灌满）
    if (ev.type === 'think') {
      const last = rec.items[rec.items.length - 1];
      if (last && last.type === 'think' && item.at - last.at < 3000 && last.text.length < 1800) {
        last.text += String(ev.text || '');
        last.seq = item.seq; last.at = item.at;
        return;
      }
      item.text = String(ev.text || '').slice(0, 2000);
    }
    if (ev.type === 'tool_start' || ev.type === 'tool_done') item.tool = ev.tool;
    rec.items.push(item);
    if (rec.items.length > ACT_MAX) rec.items.splice(0, rec.items.length - ACT_MAX);
  } catch { /* 环写入失败忽略 */ }
}
export function clearActivity(conversationId) {
  if (!conversationId) return;
  try {
    const key = String(conversationId);
    const rec = activity.get(key);
    if (rec) {
      rec.items.push({ seq: ++actSeq, at: Date.now(), type: 'run_end' });
      if (rec.items.length > ACT_MAX) rec.items.splice(0, rec.items.length - ACT_MAX);
    }
    // 延迟回收（run_end 供轮询消费后清理）
    setTimeout(() => activity.delete(key), 60000).unref?.();
  } catch { /* 忽略 */ }
}
export function activitySince(conversationId, after = 0, limit = 200) {
  const rec = activity.get(String(conversationId));
  if (!rec || !rec.items.length) return { items: [], seq: Number(after) || 0 };
  const items = rec.items.filter((x) => x.seq > (Number(after) || 0)).slice(-limit);
  return { items, seq: items.length ? items[items.length - 1].seq : (Number(after) || 0) };
}

// 护栏配置（5 秒缓存）：settings 键 time_budget_min(分钟,0=不限)/round_cap(轮次,0=不限)/loop_guard(连续相同次数,0=关闭)/task_budget_yuan(成本知情阈值,0=关)
let limitsCache = null;
let limitsCacheAt = 0;

// 工具结果入上下文前的修剪策略（对齐 3080 tool-result-pruner：保留头+尾，中段截断并注明）
function contextResultPrune(text, cap) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.6);
  const tail = Math.floor(cap * 0.3);
  const cut = s.length - head - tail;
  return s.slice(0, head) + `\n…[上下文已裁剪中段 ${cut} 字符；需要全文可用 job_output/read_file/查询工具]…\n` + s.slice(-tail);
}

// B6 假完成检测辅助：取最近一条用户消息文本（用于判断是否"任务语境"）
function lastUserTextOf(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user') return String(m.content || '');
  }
  return '';
}

// 每轮费用=真实三档计费（calcCost：hit/miss/out，见 llm/gateway.js PRICE；与平台账单加权单价对齐）

// 单任务运行中压缩（5.1 按 harness 标准收紧）：轮次长/上下文大时，把早期 tool/assistant 内容归档为极短占位，
// 并清掉早期重复的 COMPLETION_HINT；全量细节始终在 DB tool_calls 可查
function archiveEarlyContext(msgs) {
  if (msgs.length <= 90) return;
  const keepFrom = msgs.length - 80;
  for (let i = 1; i < keepFrom; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === 'system' && m.content === COMPLETION_HINT) { msgs.splice(i, 1); i--; continue; } // 早期重复评估提示移除（最新一条在尾部）
    if (m.role === 'tool' && String(m.content || '').length > 150) m.content = '（早期步骤结果已压缩归档；需要细节可用 db_query 查 tool_calls 或 job_output 查日志）';
    else if (m.role === 'assistant' && !m.tool_calls && String(m.content || '').length > 350) m.content = '（早期过程说明已压缩归档）';
  }
}
async function agentLimits() {
  if (limitsCache && Date.now() - limitsCacheAt < 5000) return limitsCache;
  const def = { ...LIMIT_DEFAULTS };
  try {
    const rows = await db.query('SELECT skey, svalue FROM settings WHERE skey IN (?,?,?,?,?,?,?,?)', ['time_budget_min', 'round_cap', 'loop_guard', 'max_parallel_tools', '__policy_rev', 'task_budget_yuan', 'task_budget_total', 'fake_continue_warn']);
    const pick = (k, d) => {
      const r = rows.find((x) => x.skey === k);
      if (!r) return d;
      try { const n = Number(JSON.parse(r.svalue)); return Number.isFinite(n) && n >= 0 ? n : d; } catch { return d; }
    };
    limitsCache = {
      budgetMin: pick('time_budget_min', def.budgetMin), roundCap: pick('round_cap', def.roundCap),
      loopGuard: pick('loop_guard', def.loopGuard), maxParallelT: pick('max_parallel_tools', def.maxParallelT),
      budgetYuan: pick('task_budget_yuan', 20), budgetTotal: pick('task_budget_total', 100),
      fakeContinueWarn: pick('fake_continue_warn', def.fakeContinueWarn),
      rev: pick('__policy_rev', 0),
    };
  } catch { limitsCache = { ...def, budgetYuan: 20, budgetTotal: 100, rev: 0 }; }
  limitsCacheAt = Date.now();
  return limitsCache;
}

export const ENV_MAP = [  '环境信息（真实资源位置，可直接访问，不要臆测数据不存在或能力不具备）：',
  '- 平台代码目录：/srv/harness-workbench（你可以用 write_file/append_file 修改其中代码，用 run_command 执行 node/npm，用 git_commit 提交——你能修改并部署自己的工作台）',
  '- Agent 工作区：/srv/rw-workspace（含用户上传文件 uploads/）',
  '- 数据存储：MySQL（用 db_query/db_write 访问，可查全部库）',
  '  关键表：conversations(会话) / messages(消息) / usage_stats(用量统计) / tool_calls(工具调用) / models(模型) / providers(厂商) / capabilities(能力开关)',
  '- 联网搜索：web_search 工具（SearXNG）；网页抓取 fetch_url',
  '- 权限：full=整个服务器文件系统可读写（含平台代码与数据库）；write/read=限于工作区',
  '- 你有 write_file/append_file/run_command/git_commit 等工具，可以真实读写服务器文件、运行命令、管理 Git——用户问你是否能改代码/优化工作台时，如实说明你能（当前 full 权限）。',
  '行动原则（务必遵守）：',
  '- 用户让你开发/写代码/建页面/渲染/部署/修复 等任务时，你【必须实际动手用工具完成】（Linux 环境：bash/ls/cat/node/npm/python3/git 都可用），不要只给文字建议或代码片段。',
  '- **假完成会被平台打回**：任务语境下若你直接回复"已执行/已完成/已提交"等完成声称但本轮无任何工具调用记录，平台会自动打回要求补真实执行；连续不改则你的回复会被强制加注"未经工具验证"。诚实路径：真做→展示结果；或明确声明"本轮未执行工具操作"。',
  '- **小步快跑**：把大任务切成一连串小的工具调用（一次一个动作：读→改→验证→下一处），每步依据结果决定下一步，像人在终端里逐步推进；不要试图一次做完，也不要一个命令包办所有步骤。',
  '- **优先使用专门工具，不用 shell 命令替代**：读文件用 read_file（不要 cat）、列目录用 list_dir（不要 ls）、搜索用 grep_search（不要 grep）、查找用 find_file、语法检查用 syntax_check、跑测试用 run_test。run_command 仅在无专门工具时用（npm install/起服务/系统管理/git/日志跟随），避免 shell 引号管道坑。想敲 cat/ls/grep/find/sed/head 读文件时先停——平台会拦并提示（读型命令门禁，审计显示 58% 的 shell 调用本可用专门工具）。',
  '- 复杂任务拆步骤：① 规划（建目录/项目结构）② write_file 写代码 ③ run_command 运行/构建/测试（必要时 npm install）④ 验证结果 ⑤ 向用户报告产物与访问方式。',
  '- 某步失败不要放弃：读错误信息→修复→重试；同一工具同参数失败 2 次后换思路（改路径/换命令/查环境）。',
  '- 本机是 Linux 服务器，命令用 Linux 语法；用户电脑是 Windows，但你在服务器上工作，两者隔离。',
  '- 运行护栏（时间预算/轮次上限/循环检测）是可调整可关闭的配置（0=不限），是防失控保险丝而非能力上限：用户要求取消/放宽时，直接用 set_limits 工具改（0=不限），或说明原因后调大。',
  '- 运行时快照：平台每轮自动注入【运行时快照】（轮次/用时/护栏现值/累计 token 与费用/会话属性/政策版本）。以最新快照为准；看到政策版本变化=规则已更新，请丢弃旧理解。',
  '- 行为准则：/srv/harness-workbench/docs/RW行为准则-服务器版.md 是本平台行为准则（诚实/小步/命令纪律/护栏哲学/自改纪律/验证与收尾），日常遵守，需要时 read_file 读全文。',
  '- 修改平台自身代码后如需生效：先用 syntax_check 验证，再调用 reload_platform 工具——平台会在你本轮回复结束后自动重启并加载新代码，你不需要（也不应）手动 systemctl restart（那会中断你自己）。',
  '提示：查询用量/数据/项目文件时，直接用工具访问上述真实位置（如 db_query 查 usage_stats 表）；修改代码用 write_file 改 /srv/harness-workbench 下文件。',
].join('\n');

// 每轮工具结果后的"目标完成度评估"提示（引导模型干完才停，避免过早收手）
const COMPLETION_HINT = [
  '以上是工具执行结果。请评估用户目标是否已真正完成：',
  '- 若已完成：直接给出最终总结回答（本轮不要再调用工具）。',
  '- 若未完成或还需验证（如：写码后未测试、查询后未给结论、任务只做了一部分）：继续调用工具把任务做完，直到目标真正完成再总结。',
].join('\n');

export async function runAgent({ provider, model, messages, permission = 'full', ctx = {}, keys, emit, temperature = 1.0 }) {
  const msgs = [{ role: 'system', content: ENV_MAP }, ...messages];
  // F15 技能：本轮 runAgent 内 skill_load 载入的技能（ctx.skills）注入后续每轮系统提示
  const sysContent = () => {
    const loaded = ctx.skills ? Object.values(ctx.skills) : [];
    if (!loaded.length) return ENV_MAP;
    return [ENV_MAP, ...loaded.map((s) => '【已载入技能: ' + s.name + '】\n' + s.content)].join('\n\n');
  };
  const refreshSys = () => {
    const c = sysContent();
    if (msgs[0].content !== c) msgs[0] = { role: 'system', content: c };
  };
  const toolLog = [];
  const callHistory = []; // 循环检测：记录 (工具名, 参数摘要)
  let dispSeq = 0;        // 展示序号：全 run 唯一单调递增（子代理/并行不撞号）
  let noProgressCount = 0; // 连续"相同调用"轮数
  let loopWarned = false;  // soft 换策略提示只发一次
  let fakeWarnCount = 0;   // B6 假完成检测打回计数（回复声称完成但本轮无工具调用）
  const t0 = Date.now();
  let cumTin = 0, cumTout = 0, cumCost = 0; // WS2 本任务累计钱包（每轮计量后累加）

  // WS2 运行时快照：每轮重建注入（最新覆盖旧版语义；护栏现值与判定同源同轮读取）
  // 2026-09 token 优化（缓存友好）：快照内容每轮变化（轮次/用时/累计 token），若插在历史前（splice(1,0)）
  // 会击穿 DeepSeek 前缀缓存（缓存要求前缀完全一致 → 整段历史 100% 按 miss 全价计费，miss/hit 价差 27 倍）。
  // 改为 append 到消息末尾：前缀 = ENV_MAP + 历史保持稳定 → 历史命中 hit 价，仅尾部增量按 miss 计费。
  const pushSnapshot = async (round, lim) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'system' && String(m.content || '').startsWith('【运行时快照】')) { msgs.splice(i, 1); break; }
    }
    const mins = Math.round((Date.now() - t0) / 60000);
    const resume = ctx.__resumeStats ? ` | 恢复任务（前次已执行 ${ctx.__resumeStats.rounds || 0} 轮，费用自本次起算）` : '';
    const snap = '【运行时快照】第 ' + (round + 1) + ' 轮 | 已用 ' + mins + ' 分钟 | 护栏现值: 预算 ' + (lim.budgetMin || '不限') + ' 分钟 / 轮次 ' + (lim.roundCap || '不限') + ' / 循环检测 ' + (lim.loopGuard || '关') + ' / 并行 ' + (lim.maxParallelT || '串行')
      + '（每轮读 settings，变更最快 5s 生效；set_limits 可调，0=不限）'
      + ' | 本任务累计: token in ' + cumTin + ' / out ' + cumTout + ' ≈ ¥' + cumCost.toFixed(3)
      + ' | 会话 mode=' + (ctx.mode || 'chat') + ' permission=' + (ctx.permission || 'full') + ' preset=' + (ctx.preset || 'all')
      + ' | 政策版本 rev ' + lim.rev + resume
      + '\n以本快照为准；政策版本变化=规则已更新，丢弃旧理解。';
    msgs.push({ role: 'system', content: snap });
  };

  // 5.2 后台/子代理完成通知（事件驱动化：父代理轮间自动获知完成，无需反复轮询）
  const bgInterest = new Set();
  const bgNoted = new Set();
  const scanBg = () => {
    for (const t of toolLog) {
      if (t.status !== 'done') continue;
      try {
        const j = JSON.parse(t.result || '{}');
        if (t.name === 'run_long_task' && j.jobId) bgInterest.add('job:' + String(j.jobId));
        else if ((t.name === 'subagent' || t.name === 'subagent_fork') && j.sub_id && j.status === 'running') bgInterest.add('sub:' + String(j.sub_id));
      } catch { /* 解析失败忽略（sync/无 id 结果不注册） */ }
    }
  };
  const bgNotices = async () => {
    const out = [];
    for (const id of bgInterest) {
      if (bgNoted.has(id)) continue;
      if (id.startsWith('job:')) {
        const j = jobs.get(id.slice(4));
        if (j && j.status === 'exited') { bgNoted.add(id); out.push('【后台任务完成】job ' + id.slice(4) + '（' + String(j.cmd || '').slice(0, 60) + '）已退出' + (j.code != null ? '，exit ' + j.code : '') + '；输出用 job_output 查看。'); }
      } else if (id.startsWith('sub:')) {
        try {
          const { subs } = await import('./subagent.js');
          const s = subs.get(id.slice(4));
          if (s && s.status !== 'running') { bgNoted.add(id); out.push('【子代理完成】' + (s.name || id.slice(4)) + ' 已结束（' + s.status + (s.error ? '：' + String(s.error).slice(0, 120) : '') + '）；结论用 subagent_output 取回' + (s.status === 'error' ? '，失败请改策略重试' : '') + '。'); }
        } catch { /* ignore */ }
      }
    }
    return out;
  };

  // 5.1 语义折叠（按 harness 压缩标准）：早期已完成轮次用一次 LLM 摘要折叠成 1 条 system，
  // 防止长任务上下文涨到 10 万 token 顶格（每轮 3 万→尾段 10 万是慢与贵的根因）；
  // 折叠后保留最近 80 条；间隔 ≥20 轮可再次折叠；明细始终在 DB tool_calls 可查
  let lastCollapseRound = -99;
  const maybeCollapseEarly = async (round) => {
    if (round - lastCollapseRound < 20) return false;
    const end = msgs.length - 80;
    if (end <= 2) return false;
    let totalChars = 0;
    for (let i = 1; i < end; i++) totalChars += String(msgs[i]?.content || '').length + 60;
    if (totalChars < 30000) return false; // 上下文尚可接受，不产生无谓 LLM 成本
    const head = msgs.slice(1, end);
    const text = head
      .map((m) => (m.role === 'user' ? '用户: ' : m.role === 'tool' ? '工具结果: ' : m.role === 'assistant' && m.tool_calls ? '助手(调用工具): ' : '助手: ') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 500))
      .join('\n').slice(-18000);
    let digest = '';
    try {
      const r = await chatOnce(ctx.__provider || 'deepseek',
        [
          { role: 'system', content: '你是任务执行归档器。把下面【早期执行轮次】压缩成 ≤260 字中文摘要，必须保留：用户目标、已确认的关键事实/路径/编号、已达成的中间结论、未完成事项与线索。工具级细节省略（可在 DB 查）。只输出摘要本体。' },
          { role: 'user', content: text },
        ],
        { model: ctx.__model || 'deepseek-v4-flash', maxTokens: 500, timeoutMs: 60000 }, keys);
      digest = String(r.content || '').trim().slice(0, 1500);
    } catch { digest = ''; }
    msgs.splice(1, end - 1, {
      role: 'system',
      content: digest
        ? '【早期执行轮次已折叠（第 ' + (round + 1) + ' 轮，保留最近 80 条）】摘要：' + digest + '\n（早期明细可用 db_query 查 tool_calls）'
        : '【早期执行轮次已归档（第 ' + (round + 1) + ' 轮，保留最近 80 条）；明细在 DB tool_calls，可用 db_query 查询】',
    });
    lastCollapseRound = round;
    return true;
  };

  for (let round = 0; ; round++) {
    refreshSys();
    // 服务端停止：用户点"停止生成"（POST /api/chat/stop）后本轮不再继续
    if (ctx.__signal && ctx.__signal.aborted) {
      return { content: '', stopped: true, toolLog, usage: {} };
    }
    // 护栏每轮读取（5s 缓存防 DB 风暴）：预算/轮次用最新值判定，快照与判定同源
    const lim = await agentLimits();
    // 5.7 预算融合：段知情阈值（task_budget_yuan）× 会话 24h 剩余（task_budget_total 总账，index.js 注入 __budgetRemain）
    const effBudgetYuan = (ctx.__budgetRemain != null && ctx.__budgetRemain >= 0)
      ? (lim.budgetYuan > 0 ? Math.min(lim.budgetYuan, ctx.__budgetRemain) : ctx.__budgetRemain)
      : lim.budgetYuan;
    if (ctx.__budgetRemain === 0) {
      return { content: '（会话 24h 任务总预算已用尽：task_budget_total。可调大该值或设 0=不限后回复"继续任务"）', toolLog, usage: {}, guard: 'budget-total' };
    }
    // 5.2 后台/子代理完成通知注入
    scanBg();
    const bgNotes = await bgNotices();
    for (const n of bgNotes) msgs.push({ role: 'system', content: n });
    if (lim.budgetMin > 0 && Date.now() - t0 > lim.budgetMin * 60000) {
      return { content: `（达到 ${lim.budgetMin} 分钟时间预算，任务已挂起。可让我继续，或用 set_limits 调大/关闭预算）`, toolLog, usage: {}, guard: 'budget' };
    }
    if (lim.roundCap > 0 && round >= lim.roundCap) {
      return { content: `（达到 ${lim.roundCap} 轮护栏上限，任务已挂起。可调大/关闭轮次上限后说"继续任务"恢复）`, toolLog, usage: {}, guard: 'cap' };
    }
    await pushSnapshot(round, lim);
    // 流式实时：模型思考/调用 LLM 中 → 通知前端"AI 处理中"（带累计费用，WS2 成本透出）
    emitEv(ctx.conversationId, emit, { type: 'agent_thinking', round: round + 1, costCum: Math.round(cumCost * 100) / 100 });
    archiveEarlyContext(msgs); // 轻压缩：早期超长项置占位
    await maybeCollapseEarly(round); // 5.1 语义折叠：长任务早期轮次 LLM 摘要压缩
    const llmT0 = Date.now();
    const res = await chatOnceWithTools(provider, model, msgs, toolDefs(ctx.preset, ctx.__enabledTools), keys, temperature);
    const llmMs = Date.now() - llmT0;
    // 全量计量（账本=真实消耗，三档计费 hit/miss/out）：每一轮 LLM 调用都入 usage_stats（kind=round，WS0 起挂 agent_run_id）
    try {
      const u = res.usage || {};
      const cost = calcCost(provider, { hit: u.cache_hit || 0, miss: u.cache_miss != null ? u.cache_miss : (u.tokens_in || 0) - (u.cache_hit || 0), out: u.tokens_out || 0 });
      await db.query('INSERT INTO usage_stats (account_id, conversation_id, agent_run_id, provider_id, model_id, tokens_in, tokens_out, cache_hit_tokens, cache_miss_tokens, cost, duration_ms, created_at, kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),"round")',
        [ctx.accountId ?? null, ctx.conversationId ?? null, ctx.__runId ?? null, provider, model || provider, u.tokens_in || 0, u.tokens_out || 0, u.cache_hit || 0, u.cache_miss != null ? u.cache_miss : 0, cost, llmMs]);
      cumTin += u.tokens_in || 0; cumTout += u.tokens_out || 0; cumCost += cost;
    } catch { /* 计量失败不影响执行 */ }
    // WS7.4/5.7 成本知情阈值（先停再问，非死限）：超阈值挂起，现场保留，用户回复"继续"即放行下一段
    if (effBudgetYuan > 0 && cumCost > effBudgetYuan) {
      return { content: `（本任务累计成本 ¥${cumCost.toFixed(3)} 已超可用预算 ¥${effBudgetYuan}（段阈值 task_budget_yuan=${lim.budgetYuan} × 会话总账剩余；可调大 task_budget_total/task_budget_yuan 或 0=关）。先停再问：回复"继续"放行下一段）`, toolLog, usage: res.usage, guard: 'budget-yuan' };
    }
    // 模型推理过程（reasoning）实时透出 → 前端 think 区
    if (res.reasoning) emitEv(ctx.conversationId, emit, { type: 'think', text: res.reasoning });
    const calls = res.toolCalls || [];
    if (!calls.length) {
      // 目标完成度判断：模型选择直接回答 = 认为任务已完成
      let final = res.content || '';
      // B6 假完成检测（平台强制，非提示词）：声称"已执行/已完成"但本轮 toolLog 为空（未调用任何工具）→ 打回
      // 适用：任务语境（用户下达了执行类指令/恢复了挂起任务），模型却直接输出"完成了/提交了/改好了"等完成声称。
      // 语义：纯问答（知识性/闲聊）不带执行声称词 → 不触发；空答兜底 final 自动生成摘要 → 不触发（final 非模型声称）。
      if (lim.fakeContinueWarn > 0 && toolLog.length === 0) {
        const claimRe = /(已(完成|实现|落地|修复|写入|创建|提交|删除|修改|部署|上线|清理)|commit [0-9a-f]{7,}|✅|验收通过|测试通过|全部通过)/;
        const isClaim = claimRe.test(final);
        const taskish = /(继续任务|继续执行|开始执行|接着做|接着改|请(执行|修复|优化|实现|落地|部署|清理|提交)|帮我(修复|改|写|建|实现|优化|清理|部署)|修复|优化|实现|落地|部署|提交|执行|清理|体检|改造|推进)/.test(lastUserTextOf(msgs));
        if (isClaim && taskish) {
          if (fakeWarnCount < lim.fakeContinueWarn) {
            fakeWarnCount++;
            msgs.push({ role: 'system', content: '【平台强制检测：本轮声称完成但无工具调用】你上一条回复声称已执行完成（"' + String(final).replace(/\s+/g, ' ').slice(0, 120) + '"），但本轮没有任何工具执行记录。请立即用真实工具完成所述工作并展示结果；若你确实无法执行或本轮仅为说明，请明确说明"本轮未实际执行任何工具操作"，不要声称完成。' });
            continue; // 打回重答
          }
          // 已达打回上限：放行但强制标注"未经验证"，避免假完成直接以可信姿态收尾
          final = '⚠️【平台检测：本回复声称已执行完成，但本轮无任何工具调用记录，内容未经工具验证】\n' + final;
          emitEv(ctx.conversationId, emit, { type: 'fake_done_warn', text: '模型声称完成但无工具调用，已强制加注（连续 ' + fakeWarnCount + ' 次）' });
        }
      }
      // 兜底：干了一串工具但最终没生成任何文字（模型判定完成却空答）→ 自动产出执行摘要，避免"无反馈就停"
      if (!final.trim() && toolLog.length > 0) {
        const names = {};
        for (const t of toolLog) names[t.name] = (names[t.name] || 0) + 1;
        const listStr = Object.entries(names).map(([k, v]) => k + (v > 1 ? '×' + v : '')).join('、');
        const last = toolLog[toolLog.length - 1];
        final = '（任务执行完成）本轮共 ' + toolLog.length + ' 步工具调用：' + listStr + '。';
        if (last && last.result && last.status !== 'fail') {
          final += '\n最后一步结果摘要：' + String(last.result).replace(/\s+/g, ' ').slice(0, 250);
        }
        final += '\n需要我基于这些结果继续说明或汇总，直接说即可。';
      }
      return { content: final, toolLog, usage: res.usage, finishReason: res.finishReason || '' };
    }
    // 长任务现场：每轮工具执行后落盘心跳/步数/计数（断点恢复用；runId 由调用方注入）
    if (ctx.__runId) {
      const counts = {};
      for (const t of toolLog) counts[t.name] = (counts[t.name] || 0) + 1;
      const last = toolLog[toolLog.length - 1];
      const step = last ? last.name + (last.status === 'fail' ? '(失败)' : '') + ' → ' + String(last.result || '').replace(/\s+/g, ' ').slice(0, 100) : '';
      await checkpoint(ctx.__runId, { rounds: callHistory.length, lastStep: step, toolCounts: counts }).catch(() => {});
    }
    // 循环处理（护栏现值每轮生效；soft 提示→仍无效则挂起 paused，现场保留）
    const sig = calls.map((c) => {
      let argsStr = '';
      try { argsStr = JSON.stringify(JSON.parse(c.function.arguments || '{}')).slice(0, 60); } catch { argsStr = String(c.function.arguments || '').slice(0, 60); }
      return c.function.name + ':' + argsStr;
    }).join('|');
    const prev = callHistory[callHistory.length - 1];
    if (sig === prev) noProgressCount += 1; else noProgressCount = 0;
    callHistory.push(sig);
    const loopGuardN = lim.loopGuard > 0 ? lim.loopGuard : 0;
    const softN = Math.max(1, Math.floor(loopGuardN / 2));
    if (loopGuardN > 0 && noProgressCount === softN && !loopWarned) {
      loopWarned = true;
      msgs.push({ role: 'system', content: '⚠️ 已连续 ' + (softN + 1) + ' 次调用相同的工具与参数且无进展。请【改变策略】：换工具、换参数、先诊断环境或换实现思路，不要再次原样重试。' });
    }
    if (loopGuardN > 0 && noProgressCount >= loopGuardN - 1) {
      return {
        content: `（任务已挂起：连续 ${loopGuardN} 次重复调用且无进展。现场已保存，回复"继续任务"可恢复，或给我新指令/新思路）`,
        toolLog, usage: res.usage, paused: true, reason: '连续重复无进展',
      };
    }
    // 工具调用轮（实时流式；同一步内的多个工具调用按 maxParallel 有界并行，结果按模型顺序落上下文）
    msgs.push({ role: 'assistant', content: res.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    const maxPar = lim.maxParallelT > 0 ? lim.maxParallelT : 1; // 0=关闭并行（串行）
    const results = new Array(calls.length);
    const execOne = async (call, idx) => {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数解析失败用空 */ }
      const seq = ++dispSeq; // 全 run 唯一，避免并行/子代理交错时撞号
      emitEv(ctx.conversationId, emit, { type: 'tool_start', tool: { name: call.function.name, args, seq, status: 'running' } });
      const tStart = Date.now();
      const result = await execTool(call.function.name, args, { ...ctx, __keys: keys, __emit: emit, __provider: provider, __model: model, __temperature: temperature });
      const status = result.error ? 'fail' : 'done';
      const resultText = result.error ? ('错误: ' + result.error) : (result.content || result.stdout || result.result || JSON.stringify(result).slice(0, 500));
      const toolItem = { name: call.function.name, args, result: resultText, status, durationMs: Date.now() - tStart, seq };
      results[idx] = toolItem;
      emitEv(ctx.conversationId, emit, { type: 'tool_done', tool: toolItem });
      return result;
    };
    for (let start = 0; start < calls.length; start += maxPar) {
      const chunk = calls.slice(start, start + maxPar);
      const chunkIdx = chunk.map((c) => calls.indexOf(c)); // 原始下标
      const rawResults = await Promise.all(chunk.map((c, k) => execOne(c, chunkIdx[k])));
      // 提交顺序 = 模型顺序（顺序化 toolLog/计划事件/tool 消息）
      chunk.forEach((call, k) => {
        const idx = chunkIdx[k];
        const toolItem = results[idx];
        toolLog.push(toolItem);
        if (emit && (call.function.name === 'plan_tasks' || call.function.name === 'plan_done')) {
          const p = plans.get(String(ctx.conversationId || 'g'));
          if (p) emitEv(ctx.conversationId, emit, { type: 'plan', plan: p.steps.map((s, i) => ({ index: i + 1, text: s.text, done: s.done })) });
        }
        const msgCap = call.function.name.startsWith('subagent') ? 12000 : 4000;
        msgs.push({ role: 'tool', tool_call_id: call.id, content: contextResultPrune(JSON.stringify(rawResults[k]), msgCap) });
      });
    }
    // 目标完成度评估提示：让模型判断"干完没"，未完成则继续
    // 5.8 消息卫生：每轮只保留一条最新 COMPLETION_HINT（旧版逐轮堆积会稀释注意力并浪费 token）
    for (let i = msgs.length - 1; i >= 0; i--) {
      const mm = msgs[i];
      if (mm && mm.role === 'system' && mm.content === COMPLETION_HINT) { msgs.splice(i, 1); break; }
    }
    msgs.push({ role: 'system', content: COMPLETION_HINT });
  }
  /* 不可达兜底（轮次判定在循环头按护栏现值执行） */
  // return { content: '（护栏兜底挂起）', toolLog, usage: {}, guard: 'cap' };
}
