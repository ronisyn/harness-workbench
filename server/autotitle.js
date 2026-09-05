// server/autotitle.js
import { db } from './db.js';
import { findProvider } from './llm/providers.js';
import { config } from './config.js';
export async function autoTitle(id, acc, force) {
  const c = (await db.query('SELECT title,provider,model FROM conversations WHERE id=? AND account_id=?', [id, acc]))[0];
  if (!c) return { ok: false };
  if (c.title && c.title !== '新对话' && !force) return { ok: true, skipped: true };
  // 取最近 12 条非工具消息并按时间正序拼 prompt（截断单条防超长内容撑爆上下文/烧钱）
  const rows = await db.query('SELECT role,content FROM messages WHERE conversation_id=? AND role IN ("user","assistant") ORDER BY id DESC LIMIT 12', [id]);
  const lines = rows.map((r) => (r.role === 'user' ? '用户：' : '助手：') + String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 300)).reverse();
  const p = findProvider(c.provider && c.provider !== 'auto' ? c.provider : 'deepseek');
  const key = config.keys[p && p.keyEnv];
  if (!p || !key) return { ok: false, message: '厂商未配置 Key' };
  const r = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: p.defaultModel, messages: [
      { role: 'system', content: '你是标题专家：给对话提炼简短贴切的中文标题(4-16字)，只输出标题本身，不要引号标点解释。' },
      { role: 'user', content: lines.join('\n') + '\n标题：' }
    ], max_tokens: 40, temperature: 0.3 })
  });
  const j = await r.json();
  let t = String(j?.choices?.[0]?.message?.content || '').replace(/[""'']/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!t) return { ok: false, message: '生成失败' };
  await db.query('UPDATE conversations SET title=?, updated_at=NOW() WHERE id=? AND account_id=?', [t, id, acc]);
  return { ok: true, title: t };
}
