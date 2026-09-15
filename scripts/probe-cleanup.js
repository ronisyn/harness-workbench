// scripts/probe-cleanup.js - 探针脚本的收尾与开场清扫（被 scripts/ra37-rebuild.mjs、scripts/ra26-waitsides.mjs 共用）
// 为什么需要它（不是洁癖）：这些脚本会**真的**写 conversations/messages/usage_stats。
//   · 残留的 usage 行会污染 C1/C2 成本口径（RA-35 的"真实流量"分档靠 conversations 是否在册来判断）；
//   · 脚本崩溃/被中断时收尾代码根本跑不到，于是必然留下垃圾。
// 所以：①收尾走同一函数（幂等）；②**开场先扫一遍**上次崩溃留下的残骸，别指望每次都能优雅退出。
import { db } from '../server/db.js';

/** 删除某个临时会话的全部关联行（幂等；顺序无所谓，都是按 conversation_id 删） */
export async function purgeConversation(conversationId, token = null) {
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs', 'contract_events']) {
    try { await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [conversationId]); } catch { /* 表可能不存在于该库 */ }
  }
  try { await db.query('DELETE FROM conversations WHERE id=?', [conversationId]); } catch { /* ignore */ }
  try { await db.query('DELETE FROM audit_log WHERE conversation_id=?', [conversationId]); } catch { /* ignore */ }
  if (token) { try { await db.query('DELETE FROM sessions WHERE token=?', [token]); } catch { /* ignore */ } }
}

/** 开场清扫：按标题前缀找回上次崩溃留下的探针会话 + 过期临时会话，一并清掉 */
export async function sweepStale(titlePrefixes = []) {
  let convs = 0, sessions = 0, orphans = 0;
  for (const p of titlePrefixes) {
    const rows = await db.query('SELECT id FROM conversations WHERE title LIKE ?', [p + '%']).catch(() => []);
    for (const r of rows) { await purgeConversation(r.id); convs++; }
    const ss = await db.query('SELECT token FROM sessions WHERE token LIKE ?', [p.replace(/^__|_$/g, '') + '%']).catch(() => []);
    for (const s of ss) { await db.query('DELETE FROM sessions WHERE token=?', [s.token]).catch(() => {}); sessions++; }
  }
  // 孤儿用量行（会话已不存在）：它们会让成本口径永远对不上，且不属任何在册会话
  const orph = await db.query('SELECT DISTINCT conversation_id FROM usage_stats WHERE conversation_id IS NOT NULL AND conversation_id NOT IN (SELECT id FROM conversations)').catch(() => []);
  for (const r of orph) { await db.query('DELETE FROM usage_stats WHERE conversation_id=?', [r.conversation_id]).catch(() => {}); orphans++; }
  if (convs || sessions || orphans) console.log(`[probe-cleanup] 清理上一次残留：会话 ${convs} · 临时会话 ${sessions} · 孤儿用量会话 ${orphans}`);
  return { convs, sessions, orphans };
}
