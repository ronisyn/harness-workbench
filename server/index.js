// server/index.js - Roni Workbench Express 入口 + API 路由
// P1 核心：登录 + 会话管理 + 多模型流式对话(SSE) + 能力开关 + 用量统计
import express from 'express';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { initSchema, db } from './db.js';
import { ensureAdmin, login, logout, me, requireAuth } from './auth.js';
import { activeProviders, allProviders } from './llm/providers.js';
import { chatStream } from './llm/gateway.js';
import { runAgent } from './agent.js';
import { marketList, refreshMarket, connectModels, scheduleMarketRefresh } from './llm/market.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- 鉴权 ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: '用户名和密码必填' });
    const r = await login(username, password);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await logout(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const h = req.headers.authorization || '';
  const u = await me(h.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true, user: u });
});

// ---------- 模型（已接入厂商） ----------
app.get('/api/models', requireAuth, (req, res) => {
  res.json({ ok: true, providers: activeProviders(config.keys) });
});

// ---------- 能力开关 ----------
const CAPABILITY_LIST = [
  // A 渲染
  ...['a_md_headings','a_md_bold','a_md_list','a_md_tasklist','a_md_table','a_md_link','a_md_image','a_md_code','a_md_quote','a_md_math','a_md_hr','a_md_footnote','a_md_deflist','a_md_supsub','a_md_mark','a_md_toc','a_md_mermaid','a_md_details','a_md_admonition','a_md_chart','a_md_emoji','a_md_html'].map(k => ({ key: k, group: 'A', name: k })),
  // B 工具
  ...[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29].map(n => ({ key: `b_tool_${n}`, group: 'B', name: `工具${n}` })),
  // C 平台
  ...[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19].map(n => ({ key: `c_cap_${n}`, group: 'C', name: `能力${n}` })),
];

app.get('/api/capabilities', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT cap_key, enabled FROM capabilities WHERE account_id=?', [req.user.id]);
  const state = Object.fromEntries(rows.map(r => [r.cap_key, Boolean(r.enabled)]));
  const list = CAPABILITY_LIST.map(c => ({ ...c, enabled: Boolean(state[c.key]) }));
  res.json({ ok: true, list });
});

app.put('/api/capabilities', requireAuth, async (req, res) => {
  const { updates } = req.body || {}; // {key: bool}
  for (const [k, v] of Object.entries(updates || {})) {
    await db.query('INSERT INTO capabilities (account_id, cap_key, enabled) VALUES (?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled)', [req.user.id, k, v ? 1 : 0]);
  }
  res.json({ ok: true });
});

// ---------- 会话 ----------
app.get('/api/conversations', requireAuth, async (req, res) => {
  const rows = await db.query(
    'SELECT id, channel, permission, title, created_at, updated_at FROM conversations WHERE account_id=? OR (channel != "web" AND account_id IS NULL) ORDER BY updated_at DESC', [req.user.id]);
  res.json({ ok: true, conversations: rows });
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { title, permission } = req.body || {};
  const r = await db.query('INSERT INTO conversations (account_id, title, permission) VALUES (?,?,?)',
    [req.user.id, title || '新对话', permission || 'full']);
  res.json({ ok: true, id: r.insertId });
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  const { title, permission } = req.body || {};
  const set = [], params = [];
  if (title !== undefined) { set.push('title=?'); params.push(title); }
  if (permission !== undefined) { set.push('permission=?'); params.push(permission); }
  if (!set.length) return res.json({ ok: true });
  params.push(req.params.id, req.user.id);
  await db.query(`UPDATE conversations SET ${set.join(',')}, updated_at=NOW() WHERE id=? AND account_id=?`, params);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM messages WHERE conversation_id=?', [req.params.id]);
  await db.query('DELETE FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT id, role, content, model, provider, created_at FROM messages WHERE conversation_id=? ORDER BY id', [req.params.id]);
  res.json({ ok: true, messages: rows });
});

// ---------- 对话（Agent 模式：工具调用 + SSE 流式输出） ----------
app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversationId, content, provider, model } = req.body || {};
  if (!conversationId || !content) return res.status(400).json({ ok: false, message: '参数缺失' });
  const convs = await db.query('SELECT id, permission FROM conversations WHERE id=? AND account_id=?', [conversationId, req.user.id]);
  if (!convs.length) return res.status(404).json({ ok: false, message: '会话不存在' });
  const permission = convs[0].permission || 'full';

  // 存用户消息
  await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'user', content]);
  await db.query('UPDATE conversations SET updated_at=NOW() WHERE id=?', [conversationId]);

  // 组装历史
  const hist = await db.query('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id', [conversationId]);
  const messages = hist.map((m) => ({ role: m.role, content: m.content }));

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const t0 = Date.now();
  let firstTokenMs = 0;
  try {
    // Agent 执行（内部可能多轮工具调用）
    const agentCtx = { permission, accountId: req.user.id, conversationId, root: process.env.RW_WORKSPACE || '/srv/rw-workspace' };
    const result = await runAgent({ provider, model, messages, permission, ctx: agentCtx, keys: config.keys });
    for (const tl of result.toolLog) {
      send({ type: 'tool', name: tl.name, result: tl.result });
    }
    const answer = result.content || '（无输出）';
    // 流式输出最终回答（分块模拟）
    const chunkSize = 8;
    for (let i = 0; i < answer.length; i += chunkSize) {
      if (!firstTokenMs) firstTokenMs = Date.now() - t0;
      send({ type: 'delta', delta: answer.slice(i, i + chunkSize) });
    }
    const usage = result.usage || {};
    send({ type: 'done', usage });
    // 存 assistant 消息
    const r = await db.query('INSERT INTO messages (conversation_id, role, content, model, provider, tokens_in, tokens_out) VALUES (?,?,?,?,?,?,?)',
      [conversationId, 'assistant', answer, model || provider, provider, usage.tokens_in || 0, usage.tokens_out || 0]);
    // 用量统计
    await db.query('INSERT INTO usage_stats (account_id, conversation_id, message_id, provider_id, model_id, tokens_in, tokens_out, duration_ms, first_token_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,NOW())',
      [req.user.id, conversationId, r.insertId, provider, model || provider, usage.tokens_in || 0, usage.tokens_out || 0, Date.now() - t0, firstTokenMs]);
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

// ---------- 用量统计（统计条） ----------
app.get('/api/usage/stats', requireAuth, async (req, res) => {
  const { conversationId } = req.query;
  const convId = conversationId ? Number(conversationId) : null;
  const p = convId ? [req.user.id, convId] : [req.user.id];
  const where = convId ? 'WHERE account_id=? AND conversation_id=?' : 'WHERE account_id=?';
  const u = (await db.query(`SELECT COUNT(*) rounds, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(duration_ms) dur FROM usage_stats ${where}`, p))[0] || {};
  const t = await db.query('SELECT COUNT(*) steps FROM tool_calls WHERE conversation_id=?', [convId || 0]);
  const rounds = await db.query('SELECT COUNT(*) c FROM messages WHERE role="user" AND conversation_id=?', [convId || 0]);
  res.json({
    ok: true,
    stats: {
      rounds: convId ? (rounds[0]?.c || 0) : (u.rounds || 0),
      steps: convId ? (t[0]?.steps || 0) : 0,
      llmMs: u.dur || 0,
      tokensIn: u.tin || 0,
      tokensOut: u.tout || 0,
    },
  });
});

// ---------- 模型市场（P3） ----------
app.get('/api/market/list', requireAuth, async (req, res) => {
  try { res.json({ ok: true, sources: await marketList() }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/market/refresh', requireAuth, async (req, res) => {
  try { res.json({ ok: true, results: await refreshMarket() }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/market/connect', requireAuth, async (req, res) => {
  try {
    const { source, modelIds } = req.body || {};
    if (!source || !Array.isArray(modelIds) || !modelIds.length) return res.status(400).json({ ok: false, message: '参数缺失' });
    res.json({ ok: true, ...(await connectModels(source, modelIds)) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ---------- 静态前端 ----------
const webDist = path.join(ROOT, 'web', 'dist');
app.use(express.static(webDist));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});

// ---------- 启动 ----------
async function main() {
  await initSchema();
  await ensureAdmin();
  // 初始化 providers 表（同步硬编码 9 家）+ 每日市场刷新
  try {
    const pCount = await db.query('SELECT COUNT(*) c FROM providers');
    if (!pCount[0]?.c) {
      for (const p of allProviders(config.keys)) {
        await db.query('INSERT INTO providers (provider_key, name, base_url, api_key_env, enabled, sort_order) VALUES (?,?,?,?,1,?)', [p.id, p.name, p.base, p.keyEnv, p.id === 'deepseek' ? 0 : 10]);
      }
    }
  } catch { /* 初始化失败不阻塞 */ }
  scheduleMarketRefresh();
  app.listen(config.port, () => {
    console.log(`[RW] Roni Workbench 启动: http://localhost:${config.port} (env=${process.env.NODE_ENV || 'dev'})`);
  });
}

main().catch((e) => {
  console.error('[RW] 启动失败:', e.message);
  process.exit(1);
});
