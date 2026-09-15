// RA-36 升级演练：升级前后取同一组"数据指纹"（行数 + 老数据可读性），用于证明升级不丢数据
import { db } from 'file:///srv/harness-workbench/server/db.js';
const TABLES = ['accounts', 'conversations', 'messages', 'usage_stats', 'tool_calls', 'audit_log', 'knowledge', 'agent_runs', 'shells', 'settings'];
const out = {};
for (const t of TABLES) {
  try { out[t] = (await db.query('SELECT COUNT(*) n FROM ' + t))[0].n; } catch (e) { out[t] = 'ERR:' + e.message.slice(0, 40); }
}
const oldest = (await db.query('SELECT id, title FROM conversations ORDER BY id LIMIT 1'))[0] || null;
const newest = (await db.query('SELECT id, title FROM conversations ORDER BY id DESC LIMIT 1'))[0] || null;
console.log(JSON.stringify({ tables: out, oldest, newest }));
process.exit(0);
