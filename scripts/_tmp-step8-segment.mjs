// 步8 验证：段边界（新段提示）——同一会话内工具面变更 → 必须记 prefix:exempt + tool-face-changed 并打 [segment]
import { db } from 'file:///srv/harness-workbench/server/db.js';
const BASE = 'http://127.0.0.1:880';
const lg = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }), signal: AbortSignal.timeout(20000) })).json();
const H = { Authorization: 'Bearer ' + lg.token, 'Content-Type': 'application/json' };
const chat = async (cid, content) => {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ conversationId: cid, content }), signal: AbortSignal.timeout(180000) });
  return (await r.text()).includes('"type":"done"');
};
const c = await (await fetch(BASE + '/api/conversations', { method: 'POST', headers: H, body: JSON.stringify({ title: '__step8_segment__', permission: 'read' }) })).json();
const cid = c.id || (c.conversation && c.conversation.id);
console.log('conv=' + cid);

const cur = await (await fetch(BASE + '/api/toolset', { headers: H })).json();
const enabled = (cur.tools || []).filter((t) => t.enabled && !t.platformExempt).map((t) => t.name);
console.log('当前启用集（去掉 platformExempt）=' + enabled.length + ' 项');

console.log('第一轮（同段基线）ok=' + await chat(cid, '只回答两个字：好的'));
// 变更工具面：从启用集里去掉一个工具（写回 settings）
const shrunk = enabled.filter((n) => n !== 'repo_map');
const put = await fetch(BASE + '/api/toolset', { method: 'PUT', headers: H, body: JSON.stringify({ enabled: shrunk }) });
console.log('工具面变更（去掉 repo_map）status=' + put.status + '：' + shrunk.length + ' 项');
console.log('第二轮（应触发新段）ok=' + await chat(cid, '再回答两个字：收到'));

const rows = await db.query("SELECT action, detail FROM audit_log WHERE conversation_id=? AND action LIKE 'prefix:%' ORDER BY id", [cid]);
console.log('--- prefix 账本 ---');
for (const r of rows) console.log('   ' + r.action + ' | ' + r.detail);

// 还原启用集并清理
const back = await fetch(BASE + '/api/toolset', { method: 'PUT', headers: H, body: JSON.stringify({ enabled }) });
console.log('还原启用集 status=' + back.status);
for (const t of ['messages', 'tool_calls', 'usage_stats', 'model_telemetry', 'agent_runs', 'audit_log']) await db.query('DELETE FROM ' + t + ' WHERE conversation_id=?', [cid]);
await db.query('DELETE FROM conversations WHERE id=?', [cid]);
console.log('清理完成，残留=' + (await db.query('SELECT COUNT(*) n FROM conversations WHERE id=?', [cid]))[0].n);
process.exit(0);
