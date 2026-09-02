// server/agent.js - Agent 执行循环（思考→工具→观察→修正）
// 工具路径注入"环境地图"（资源位置说明，非身份设定）——让 AI 访问真实系统而非局限于空工作区
import { chatOnceWithTools } from './llm/gateway.js';
import { toolDefs, execTool } from './tools/index.js';

export const ENV_MAP = [
  '环境信息（真实资源位置，可直接访问，不要臆测数据不存在）：',
  '- 平台代码目录：/srv/harness-workbench',
  '- Agent 工作区：/srv/rw-workspace（含用户上传文件 uploads/）',
  '- 数据存储：MySQL（用 db_query/db_write 访问，可查全部库）',
  '  关键表：conversations(会话) / messages(消息) / usage_stats(用量统计) / tool_calls(工具调用) / models(模型) / providers(厂商) / capabilities(能力开关)',
  '- 联网搜索：web_search 工具（SearXNG）',
  '- 权限：full=整个服务器文件系统可访问；write/read=限于工作区',
  '提示：查询用量/数据/项目文件时，直接用工具访问上述真实位置（如 db_query 查 usage_stats 表）。',
].join('\n');

export async function runAgent({ provider, model, messages, permission = 'full', ctx = {}, maxRounds = 8, keys }) {
  // 工具路径：消息前注入环境地图（普通对话路径不经此函数，保持模型自然认知）
  const msgs = [{ role: 'system', content: ENV_MAP }, ...messages];
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
