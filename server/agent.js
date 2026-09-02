// server/agent.js - Agent 执行循环（目标完成度判断：干完就停，没干完继续）
// 不设预设轮次：模型每轮评估"目标完成没"——完成直接回答即停；未完成继续调工具
// 保留运行时护栏（非预设轮次）：时间预算 / 循环检测 / 绝对兜底
import { chatOnceWithTools } from './llm/gateway.js';
import { toolDefs, execTool } from './tools/index.js';

export const ENV_MAP = [
  '环境信息（真实资源位置，可直接访问，不要臆测数据不存在或能力不具备）：',
  '- 平台代码目录：/srv/harness-workbench（你可以用 write_file/append_file 修改其中代码，用 run_command 执行 node/npm，用 git_commit 提交——你能修改并部署自己的工作台）',
  '- Agent 工作区：/srv/rw-workspace（含用户上传文件 uploads/）',
  '- 数据存储：MySQL（用 db_query/db_write 访问，可查全部库）',
  '  关键表：conversations(会话) / messages(消息) / usage_stats(用量统计) / tool_calls(工具调用) / models(模型) / providers(厂商) / capabilities(能力开关)',
  '- 联网搜索：web_search 工具（SearXNG）；网页抓取 fetch_url',
  '- 权限：full=整个服务器文件系统可读写（含平台代码与数据库）；write/read=限于工作区',
  '- 你有 write_file/append_file/run_command/git_commit 等工具，可以真实读写服务器文件、运行命令、管理 Git——用户问你是否能改代码/优化工作台时，如实说明你能（当前 full 权限）。',
  '提示：查询用量/数据/项目文件时，直接用工具访问上述真实位置（如 db_query 查 usage_stats 表）；修改代码用 write_file 改 /srv/harness-workbench 下文件。',
].join('\n');

// 每轮工具结果后的"目标完成度评估"提示（引导模型干完才停，避免过早收手）
const COMPLETION_HINT = [
  '以上是工具执行结果。请评估用户目标是否已真正完成：',
  '- 若已完成：直接给出最终总结回答（本轮不要再调用工具）。',
  '- 若未完成或还需验证（如：写码后未测试、查询后未给结论、任务只做了一部分）：继续调用工具把任务做完，直到目标真正完成再总结。',
].join('\n');

export async function runAgent({ provider, model, messages, permission = 'full', ctx = {}, keys }) {
  const msgs = [{ role: 'system', content: ENV_MAP }, ...messages];
  const toolLog = [];
  const callHistory = []; // 循环检测：记录 (工具名, 参数摘要)
  const t0 = Date.now();
  const TIME_BUDGET_MS = 10 * 60 * 1000; // 运行时护栏：总时间预算 10 分钟
  const ABSOLUTE_CAP = 200; // 运行时护栏：绝对兜底轮次（非预设限制，仅防失控）

  for (let round = 0; round < ABSOLUTE_CAP; round++) {
    // 时间预算护栏
    if (Date.now() - t0 > TIME_BUDGET_MS) {
      return { content: '（达到 10 分钟时间预算，已停止。可让我继续或缩小任务范围）', toolLog, usage: {} };
    }
    const res = await chatOnceWithTools(provider, model, msgs, toolDefs(), keys);
    const calls = res.toolCalls || [];
    if (!calls.length) {
      // 目标完成度判断：模型选择直接回答 = 认为任务已完成
      return { content: res.content || '', toolLog, usage: res.usage };
    }
    // 循环检测护栏：连续 3 次重复相同 (工具+参数) → 判定卡死
    const sig = calls.map((c) => c.function.name + ':' + String(c.function.arguments || '').slice(0, 80)).join('|');
    callHistory.push(sig);
    const tail = callHistory.slice(-3);
    if (tail.length === 3 && tail[0] === tail[1] && tail[1] === tail[2]) {
      return { content: '（检测到重复工具调用无进展，已停止。可尝试换一种方式/补充信息）', toolLog, usage: res.usage };
    }
    // 工具调用轮
    msgs.push({ role: 'assistant', content: res.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数解析失败用空 */ }
      const t0 = Date.now();
      const result = await execTool(call.function.name, args, ctx);
      const status = result.error ? 'fail' : 'done';
      const resultText = result.error ? ('错误: ' + result.error) : (result.content || result.stdout || result.result || JSON.stringify(result).slice(0, 500));
      toolLog.push({ name: call.function.name, args, result: resultText, status, durationMs: Date.now() - t0, seq: toolLog.length + 1 });
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    // 目标完成度评估提示：让模型判断"干完没"，未完成则继续
    msgs.push({ role: 'system', content: COMPLETION_HINT });
  }
  return { content: '（达到绝对兜底轮次，异常终止）', toolLog, usage: {} };
}
