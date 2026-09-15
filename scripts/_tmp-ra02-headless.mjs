// RA-02 验收：对话编排核心脱离 HTTP 单跑（headless）——本脚本不引入任何 HTTP 服务，直接调 runAgent
import { runAgent } from 'file:///srv/harness-workbench/server/agent.js';

const t0 = Date.now();
const res = await runAgent({
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '只回答两个字：可以' }],
  permission: 'read',
  ctx: { accountId: null, conversationId: null, permission: 'read' },
});
console.log('headless 完成：耗时=' + Math.round((Date.now() - t0) / 1000) + 's');
console.log('返回正文=' + JSON.stringify(String(res.content || '').slice(0, 60)));
console.log('用量=' + JSON.stringify(res.usage || {}));
console.log('工具调用数=' + (res.toolLog || []).length);
process.exit(res.content ? 0 : 1);
