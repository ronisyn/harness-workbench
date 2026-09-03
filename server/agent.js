// server/agent.js - Agent 执行循环（目标完成度判断：干完就停，没干完继续）
// 不设预设轮次：模型每轮评估"目标完成没"——完成直接回答即停；未完成继续调工具
// 运行护栏（仅防失控，非预设限制）：时间预算/循环检测/绝对兜底 —— 全部可在 settings 表调整或关闭（0=不限），
// 用 set_limits 工具或 设置→能力→高级参数 修改即生效（无需重启），默认已大幅放宽以支持长任务
import { chatOnceWithTools } from './llm/gateway.js';
import { toolDefs, execTool, plans } from './tools/index.js';
import { db } from './db.js';

// 护栏配置（5 秒缓存）：settings 键 time_budget_min(分钟,0=不限)/round_cap(轮次,0=不限)/loop_guard(连续相同次数,0=关闭)
let limitsCache = null;
let limitsCacheAt = 0;
const DEFAULT_LIMITS = { budgetMin: 120, roundCap: 2000, loopGuard: 6 };
async function agentLimits() {
  if (limitsCache && Date.now() - limitsCacheAt < 5000) return limitsCache;
  const def = { ...DEFAULT_LIMITS };
  try {
    const rows = await db.query('SELECT skey, svalue FROM settings WHERE skey IN (?,?,?)', ['time_budget_min', 'round_cap', 'loop_guard']);
    const pick = (k, d) => {
      const r = rows.find((x) => x.skey === k);
      if (!r) return d;
      try { const n = Number(JSON.parse(r.svalue)); return Number.isFinite(n) && n >= 0 ? n : d; } catch { return d; }
    };
    limitsCache = { budgetMin: pick('time_budget_min', def.budgetMin), roundCap: pick('round_cap', def.roundCap), loopGuard: pick('loop_guard', def.loopGuard) };
  } catch { limitsCache = def; }
  limitsCacheAt = Date.now();
  return limitsCache;
}

export const ENV_MAP = [
  '环境信息（真实资源位置，可直接访问，不要臆测数据不存在或能力不具备）：',
  '- 平台代码目录：/srv/harness-workbench（你可以用 write_file/append_file 修改其中代码，用 run_command 执行 node/npm，用 git_commit 提交——你能修改并部署自己的工作台）',
  '- Agent 工作区：/srv/rw-workspace（含用户上传文件 uploads/）',
  '- 数据存储：MySQL（用 db_query/db_write 访问，可查全部库）',
  '  关键表：conversations(会话) / messages(消息) / usage_stats(用量统计) / tool_calls(工具调用) / models(模型) / providers(厂商) / capabilities(能力开关)',
  '- 联网搜索：web_search 工具（SearXNG）；网页抓取 fetch_url',
  '- 权限：full=整个服务器文件系统可读写（含平台代码与数据库）；write/read=限于工作区',
  '- 你有 write_file/append_file/run_command/git_commit 等工具，可以真实读写服务器文件、运行命令、管理 Git——用户问你是否能改代码/优化工作台时，如实说明你能（当前 full 权限）。',
  '行动原则（务必遵守）：',
  '- 用户让你开发/写代码/建页面/渲染/部署/修复 等任务时，你【必须实际动手用工具完成】（Linux 环境：bash/ls/cat/node/npm/python3/git 都可用），不要只给文字建议或代码片段。',
  '- **小步快跑**：把大任务切成一连串小的工具调用（一次一个动作：读→改→验证→下一处），每步依据结果决定下一步，像人在终端里逐步推进；不要试图一次做完，也不要一个命令包办所有步骤。',
  '- **优先使用专门工具，不用 shell 命令替代**：读文件用 read_file（不要 cat）、列目录用 list_dir（不要 ls）、搜索用 grep_search（不要 grep）、查找用 find_file、语法检查用 syntax_check、跑测试用 run_test。run_command 仅在无专门工具时用（npm install/起服务/系统管理），避免 shell 引号管道坑。',
  '- 复杂任务拆步骤：① 规划（建目录/项目结构）② write_file 写代码 ③ run_command 运行/构建/测试（必要时 npm install）④ 验证结果 ⑤ 向用户报告产物与访问方式。',
  '- 某步失败不要放弃：读错误信息→修复→重试；同一工具同参数失败 2 次后换思路（改路径/换命令/查环境）。',
  '- 本机是 Linux 服务器，命令用 Linux 语法；用户电脑是 Windows，但你在服务器上工作，两者隔离。',
  '- 运行护栏（时间预算/轮次上限/循环检测）是可调整可关闭的配置：用户要求取消/放宽时，直接用 set_limits 工具改（0=不限），或说明原因后调大；改完下一轮立即生效，无需改代码。',
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
  const t0 = Date.now();
  // 护栏动态读取（settings，可调可关，0=不限）：默认 120 分钟 / 2000 轮 / 连续 6 次判循环
  const lim = await agentLimits();
  const budgetMs = lim.budgetMin > 0 ? lim.budgetMin * 60000 : Infinity;
  const roundCap = lim.roundCap > 0 ? lim.roundCap : 1e9;
  const loopGuardN = lim.loopGuard > 0 ? lim.loopGuard : 0;

  for (let round = 0; round < roundCap; round++) {
    refreshSys();
    // 服务端停止：用户点"停止生成"（POST /api/chat/stop）后本轮不再继续
    if (ctx.__signal && ctx.__signal.aborted) {
      return { content: '', stopped: true, toolLog, usage: {} };
    }
    // 时间预算护栏（可关闭/可调）
    if (Date.now() - t0 > budgetMs) {
      return { content: `（达到 ${lim.budgetMin} 分钟时间预算，已停止。可让我继续，或用 set_limits 调大/关闭预算）`, toolLog, usage: {} };
    }
    // 流式实时：模型思考/调用 LLM 中 → 通知前端"AI 处理中"
    if (emit) emit({ type: 'agent_thinking', round: round + 1 });
    const res = await chatOnceWithTools(provider, model, msgs, toolDefs(), keys, temperature);
    // 模型推理过程（reasoning）实时透出 → 前端 think 区
    if (res.reasoning && emit) emit({ type: 'think', text: res.reasoning });
    const calls = res.toolCalls || [];
    if (!calls.length) {
      // 目标完成度判断：模型选择直接回答 = 认为任务已完成
      let final = res.content || '';
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
    // 循环检测护栏（可关闭/可调）：连续 N 次 (工具+参数+结果前段相同) 才判定卡死
    const sig = calls.map((c) => {
      let argsStr = '';
      try { argsStr = JSON.stringify(JSON.parse(c.function.arguments || '{}')).slice(0, 60); } catch { argsStr = String(c.function.arguments || '').slice(0, 60); }
      return c.function.name + ':' + argsStr;
    }).join('|');
    callHistory.push(sig);
    if (loopGuardN > 0) {
      const tail = callHistory.slice(-loopGuardN);
      if (tail.length === loopGuardN && tail.every((s) => s === tail[0])) {
        return { content: `（检测到连续 ${loopGuardN} 次重复工具调用且无进展，已停止。可尝试换一种方式，或用 set_limits 调整/关闭循环检测）`, toolLog, usage: res.usage };
      }
    }
    // 工具调用轮（实时流式：工具开始→执行→完成 均即时上报）
    msgs.push({ role: 'assistant', content: res.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数解析失败用空 */ }
      const seq = toolLog.length + 1;
      if (emit) emit({ type: 'tool_start', tool: { name: call.function.name, args, seq, status: 'running' } });
      const tStart = Date.now();
      const result = await execTool(call.function.name, args, { ...ctx, __keys: keys, __emit: emit, __provider: provider, __model: model, __temperature: temperature });
      const status = result.error ? 'fail' : 'done';
      const resultText = result.error ? ('错误: ' + result.error) : (result.content || result.stdout || result.result || JSON.stringify(result).slice(0, 500));
      const toolItem = { name: call.function.name, args, result: resultText, status, durationMs: Date.now() - tStart, seq };
      toolLog.push(toolItem);
      if (emit) emit({ type: 'tool_done', tool: toolItem });
      // F9：任务清单工具调用后实时同步进度
      if (emit && (call.function.name === 'plan_tasks' || call.function.name === 'plan_done')) {
        const p = plans.get(String(ctx.conversationId || 'g'));
        if (p) emit({ type: 'plan', plan: p.steps.map((s, i) => ({ index: i + 1, text: s.text, done: s.done })) });
      }
      const msgCap = call.function.name.startsWith('subagent') ? 12000 : 4000;
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, msgCap) });
    }
    // 目标完成度评估提示：让模型判断"干完没"，未完成则继续
    msgs.push({ role: 'system', content: COMPLETION_HINT });
  }
  return { content: '（达到轮次上限或异常终止。可让用户调大/关闭轮次上限后继续）', toolLog, usage: {} };
}
