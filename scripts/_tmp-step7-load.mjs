// 步7 系统级验证：清单驱动装载 —— 工具面 / 实现面 / 执行面三处一致，且"下线一个工具"只需改清单
import { TOOLS, toolDefs, execTool } from 'file:///srv/harness-workbench/server/tools/index.js';
import { MANIFEST_NAMES } from 'file:///srv/harness-workbench/server/tools/registry.js';
import { TOOL_MANIFEST } from 'file:///srv/harness-workbench/server/tools/manifest.js';
import { db } from 'file:///srv/harness-workbench/server/db.js';

const TARGET = process.argv[2] || 'repo_map';
const local = toolDefs('all', null, null).filter((d) => !/^mcp_/.test(d.function.name));
console.log('工具面(toolDefs 本地)=' + local.length + ' 实现面(TOOLS)=' + TOOLS.length
  + ' 清单启用=' + MANIFEST_NAMES.length + ' 清单条目=' + Object.keys(TOOL_MANIFEST).length);
console.log('目标 ' + TARGET + '：工具面=' + local.some((d) => d.function.name === TARGET)
  + ' 实现面=' + TOOLS.some((t) => t.name === TARGET) + ' 清单=' + (TARGET in TOOL_MANIFEST));

const ctx = { conversationId: -1, accountId: null, permission: 'full' };
try {
  const r = await execTool(TARGET, { dir: '/srv/rw-workspace' }, ctx);
  console.log('执行面：可执行 → ' + String(JSON.stringify(r)).slice(0, 100));
} catch (e) {
  console.log('执行面：拒绝 → ' + e.message);
}
await db.query('DELETE FROM tool_calls WHERE conversation_id=-1');
await db.query('DELETE FROM audit_log WHERE conversation_id=-1');
console.log('探针留痕已清理');
process.exit(0);
