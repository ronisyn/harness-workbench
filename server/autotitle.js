// server/autotitle.js
import { db } from './db.js';
import { storage } from './storage/index.js'; // v0.3 §4.1「存储走接口」：会话/消息读走接口
import { findProvider } from './llm/providers.js';
import { calcCost } from './llm/gateway.js';
import { config } from './config.js';
export async function autoTitle(id, acc, force) {
  const c = await storage.conversations.findOwned(id, acc);
  if (!c) return { ok: false };
  if (c.title && c.title !== '新对话' && !force) return { ok: true, skipped: true };
  // 取最近 12 条非工具消息并按时间正序拼 prompt（截断单条防超长内容撑爆上下文/烧钱）
  const rows = await storage.messages.recent(id, { limit: 12, roles: ['user', 'assistant'] });
  const lines = rows.map((r) => (r.role === 'user' ? '用户：' : '助手：') + String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 300)).reverse();
  const prov = c.provider && c.provider !== 'auto' ? c.provider : 'deepseek';
  const p = findProvider(prov);
  const key = config.keys[p && p.keyEnv];
  if (!p || !key) return { ok: false, message: '厂商未配置 Key' };
  let t = '';
  try {
    const r = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: p.defaultModel, messages: [
        { role: 'system', content: '你是标题专家：给对话提炼简短贴切的中文标题(4-16字)，只输出标题本身，不要引号标点解释。' },
        { role: 'user', content: lines.join('\n') + '\n标题：' }
      ], max_tokens: 40, temperature: 0.3 })
    });
    const j = await r.json();
    t = String(j?.choices?.[0]?.message?.content || '').replace(/[""'']/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    // P25(O-27)：自动标题属旁路 LLM 消耗，入账（kind=title），此前绕过 usage_stats 钱包偏低
    try {
      const u = (j && j.usage) || {};
      const miss = Math.max(0, (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0));
      const cost = calcCost(prov, { hit: u.prompt_cache_hit_tokens || 0, miss, out: u.completion_tokens || 0 });
      await storage.usage.append({
        accountId: acc, conversationId: id, providerId: prov, modelId: p.defaultModel,
        tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0,
        cacheHit: u.prompt_cache_hit_tokens || 0, cacheMiss: miss,
        cost, durationMs: 0, kind: 'title',
      });
    } catch { /* 计量失败不影响 */ }
  } catch (e) { console.error('[autotitle] 失败:', e.message); }
  // P25(O-24)：LLM 失败 → 首条用户消息朴素截断兜底（标题不再卡在「新对话」）
  if (!t) {
    const first = rows[rows.length - 1];
    t = String(first && first.role === 'user' ? first.content : lines.join(' ')).replace(/\s+/g, ' ').trim().slice(0, 24);
  }
  if (!t) return { ok: false, message: '无内容可命名' };
  await storage.conversations.updateOwned(id, acc, { title: t });
  return { ok: true, title: t };
}
