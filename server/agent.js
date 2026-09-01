// server/agent.js - Agent 执行循环（思考→工具→观察→修正）
// 用 LLM function calling：模型决定调用工具 → 执行 → 结果回填 → 继续，直到模型给出最终回答
import { chatOnceWithTools } from './llm/gateway.js';
import { toolDefs, execTool } from './tools/index.js';

export async function runAgent({ provider, model, messages, permission = 'full', ctx = {}, maxRounds = 8, keys }) {
  const msgs = [...messages];
  const toolLog = [];
  for (let round = 0; round < maxRounds; round++) {
    const res = await chatOnceWithTools(provider, model, msgs, toolDefs(), keys);
    const calls = res.toolCalls || [];
    if (!calls.length) {
      return { content: res.content || '', toolLog, usage: res.usage };
    }
    // 工具调用轮
    msgs.push({ role: 'assistant', content: res.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数解析失败用空 */ }
      const result = await execTool(call.function.name, args, ctx);
      toolLog.push({ name: call.function.name, args, result: result.error ? '错误: ' + result.error : (result.content || result.stdout || result.result || JSON.stringify(result).slice(0, 500)) });
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return { content: '（达到最大工具调用轮次，任务可能未完成）', toolLog, usage: {} };
}
