// server/index.js - Roni Workbench Express 入口 + API 路由
// P1 核心：登录 + 会话管理 + 多模型流式对话(SSE) + 能力开关 + 用量统计
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT } from './config.js';
import { initSchema, db } from './db.js';
import { ensureAdmin, login, logout, me, requireAuth } from './auth.js';
import { activeProviders, allProviders, findProvider } from './llm/providers.js';
import { chatStream } from './llm/gateway.js';
import { runAgent } from './agent.js';
import { SKILLS_ROOT } from './tools/index.js';
import { marketList, refreshMarket, connectModels, scheduleMarketRefresh } from './llm/market.js';
import { startWechatChannel } from './channels/wechat.js';
import { registerFeishuWebhook } from './channels/feishu-webhook.js';
import { startScheduler } from './scheduler.js';
import { decideApproval, listPending } from './approval.js';
import { takeRestart, isRestartScheduled, markRestartScheduled } from './restart.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 运行中 Agent 的中止表（前端"停止生成"→ POST /api/chat/stop 取消当前轮）
const abortMap = new Map(); // key = accountId:conversationId → AbortController
// 每账号并发对话计数（能力"并发限制"：默认同账号最多 3 条对话同时在跑）
const inflight = new Map(); // accountId → count

// reload_platform 协作：当前对话回复结束后自动重启服务（Agent 自我开发闭环，避免手动 restart 中断自己）
async function maybeSelfRestart() {
  const reason = takeRestart();
  if (!reason) return;
  if (isRestartScheduled()) return;
  markRestartScheduled();
  console.log('[rw] 自我重启请求:', reason, '—— 2 秒后执行（等当前回复落库）');
  setTimeout(async () => {
    try {
      const { execFile } = await import('node:child_process');
      const svc = process.env.RW_SERVICE || 'rw-test';
      const ch = execFile('systemctl', ['restart', svc], { detached: true, stdio: 'ignore' });
      ch.unref();
      console.log('[rw] 已触发 systemctl restart ' + svc);
    } catch (e) { console.error('[rw] 自动重启失败:', e.message); }
  }, 2000);
}

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
const A_NAMES = ['标题','粗体/斜体','列表','任务列表','表格','链接','图片','代码高亮','引用','数学公式','分隔线','脚注','定义列表','上下标','高亮标记','目录TOC','Mermaid图表','折叠块','警告块','数据图表','emoji','HTML渲染'];
const B_NAMES = ['读取文件','写入文件','追加修改','列出目录','建删目录','复制移动','删除文件','查找文件','代码搜索','大文件分段','执行命令','后台长任务','终止进程','联网搜索','读网页','PDF解析','Word解析','Excel解析','PPT解析','图片OCR','数据库查询','数据库写入','Git状态','Git提交','Git分支','Git拉取推送','语法检查','运行测试','上传文件'];
const C_NAMES = ['多厂商切换','自动路由','流式输出','多会话','会话持久化','长上下文压缩','系统提示词','高级参数','工具调用','技能系统','子代理','定时任务','多模态看图','操作留痕','用量统计','并发限制','对话导出','终止生成','快捷键'];
const CAPABILITY_LIST = [
  // A 渲染
  ...A_NAMES.map((name, i) => ({ key: `a_md_${['headings','bold','list','tasklist','table','link','image','code','quote','math','hr','footnote','deflist','supsub','mark','toc','mermaid','details','admonition','chart','emoji','html'][i]}`, group: 'A', name })),
  // B 工具
  ...B_NAMES.map((name, i) => ({ key: `b_tool_${i + 1}`, group: 'B', name })),
  // C 平台
  ...C_NAMES.map((name, i) => ({ key: `c_cap_${i + 1}`, group: 'C', name })),
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
  const rows = await db.query('SELECT id, role, content, reasoning, model, provider, created_at FROM messages WHERE conversation_id=? ORDER BY id', [req.params.id]);
  res.json({ ok: true, messages: rows });
});

// 对话导出（Markdown，含思考/轨迹；前端亦可用本地 Blob 导出）
app.get('/api/conversations/:id/export', requireAuth, async (req, res) => {
  try {
    const conv = (await db.query('SELECT title FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]))[0];
    if (!conv) return res.status(404).json({ ok: false, message: '会话不存在' });
    const ms = await db.query('SELECT id, role, content, reasoning, created_at FROM messages WHERE conversation_id=? ORDER BY id', [req.params.id]);
    const tc = await db.query('SELECT message_id, tool_name, args, result_summary, status FROM tool_calls WHERE conversation_id=? ORDER BY id', [req.params.id]);
    const byMsg = {};
    for (const t of tc) if (t.message_id) (byMsg[t.message_id] = byMsg[t.message_id] || []).push(t);
    const lines = [];
    for (const m of ms) {
      lines.push('## ' + (m.role === 'user' ? '我' : 'AI') + '  \n');
      if (m.role === 'assistant') {
        if (m.reasoning) lines.push(m.reasoning.split('\n').filter(Boolean).map((l) => '> 🧠 ' + l).join('\n') + '  \n');
        const ts = byMsg[m.id] || [];
        for (const t of ts) lines.push(`> 🔧 ${t.tool_name}${t.status === 'fail' ? ' ✕' : ''}${t.result_summary ? '\n> ' + String(t.result_summary).slice(0, 200) : ''}  `);
        if (ts.length) lines.push('');
      }
      lines.push(String(m.content || '') + '\n\n---\n');
    }
    res.json({ ok: true, filename: (conv.title || '对话') + '.md', content: '# ' + (conv.title || '对话') + '\n\n' + lines.join('\n') });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// 会话轨迹（工具调用记录）
app.get('/api/conversations/:id/toolcalls', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT id, tool_name, args, result_summary, duration_ms, status, message_id, created_at FROM tool_calls WHERE conversation_id=? ORDER BY id DESC LIMIT 100', [req.params.id]);
  res.json({ ok: true, toolcalls: rows });
});

// 已接入厂商 + 模型（设置页展示）
app.get('/api/providers', requireAuth, async (req, res) => {
  const providers = await db.query('SELECT id, provider_key, name, base_url, enabled FROM providers ORDER BY sort_order, id');
  const models = await db.query('SELECT id, provider_id, model_id, name, capabilities, enabled FROM models ORDER BY provider_id, model_id');
  const byProvider = {};
  for (const m of models) (byProvider[m.provider_id] = byProvider[m.provider_id] || []).push(m);
  res.json({ ok: true, providers: providers.map((p) => ({ ...p, models: byProvider[p.id] || [] })) });
});

// ---------- 对话（双路径） ----------
// 普通对话不带 tools（模型自然回答，保持出厂自我认知）；检测到工具意图时走 Agent（function calling）
const TOOL_INTENT_RE = /(查|读|写|改|找|搜|看|打开|列出|创建|删除|复制|移动|执行|运行|命令|终端|数据库|sql|git|提交|推送|拉取|测试|语法|上传|下载|文件|目录|文件夹|路径|pdf|word|excel|ppt|ocr|图片|识别|飞书|文档|网址|http|网页|搜索|代码|编码|编程|脚本|优化|重构|修复|调试|部署|配置|接入|厂商|模型|安装|升级|维护|统计|用量|分析|检查|调研|了解|探索)/i;

function needsTools(content) {
  return TOOL_INTENT_RE.test(content);
}

// P1-F8 长对话摘要生成（懒加载：后台调 LLM 压缩早期消息）
async function generateSummary(provider, earlyText, conversationId) {
  try {
    const key = config.keys[findProvider(provider)?.keyEnv];
    const base = findProvider(provider)?.base;
    if (!key || !base) return;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: findProvider(provider)?.defaultModel,
        messages: [
          { role: 'system', content: '请把以下早期对话压缩成简明中文摘要（保留：主题、关键决定、用户需求、文件路径、重要结论；200 字内）' },
          { role: 'user', content: earlyText.slice(0, 30000) },
        ],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    const summary = j.choices?.[0]?.message?.content || '';
    if (summary) {
      await db.query('INSERT INTO conv_summaries (conversation_id, summary, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE summary=VALUES(summary), updated_at=NOW()', [conversationId, summary]);
      console.log('[summary] 会话 ' + conversationId + ' 摘要已生成');
    }
  } catch (e) { console.error('[summary] 会话 ' + conversationId + ' 摘要失败:', e.message); }
}

// ---------- 设置读写（settings 表） ----------
async function getSetting(key, def) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', [key]);
    if (!r[0]) return def;
    try { return JSON.parse(r[0].svalue); } catch { return r[0].svalue; } // 兼容已 JSON 序列化与裸文本
  } catch { return def; }
}
async function setSetting(key, val) {
  await db.query('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()', [key, JSON.stringify(val)]);
}

// ---------- 模型路由（F11 自动路由） ----------
const VISION_RE = /(图片|看图|照片|截图|识别.*图|vision|image)/i;
function resolveRoute(content, provider, model) {
  if (provider !== 'auto' && model !== '__auto__') return { provider, model };
  // 自动路由：视觉需求 → 豆包视觉；含工具意图且需要执行 → 默认主力（deepseek 已支持工具）
  let route;
  if (VISION_RE.test(content)) route = { provider: 'ark', model: 'doubao-seed-2-0-mini-260428', note: '视觉任务→豆包视觉' };
  else route = { provider: 'deepseek', model: 'deepseek-v4-flash', note: '自动→DeepSeek V4 Flash' };
  // 目标厂商未配 Key 时回落主力（防自动路由把对话带到不可用厂商）
  try {
    const p = findProvider(route.provider);
    if (!config.keys[p?.keyEnv]) route = { provider: 'deepseek', model: 'deepseek-v4-flash', note: '自动→' + route.provider + ' 未配置 Key，回落 DeepSeek' };
  } catch { /* 保持原路由 */ }
  return route;
}

// ---------- 费用单价（元/百万 token，近似；F13 费用统计） ----------
const PRICE_IN = { deepseek: 1, glm: 2, ark: 0.3, moonshot: 4, dashscope: 0.5, tokenhub: 2, qianfan: 8, minimax: 5, siliconflow: 2 };
const PRICE_OUT = { deepseek: 2, glm: 5, ark: 0.8, moonshot: 16, dashscope: 2, tokenhub: 5, qianfan: 20, minimax: 12, siliconflow: 5 };
function estCost(providerId, tin, tout) {
  return ((tin / 1e6) * (PRICE_IN[providerId] ?? 2) + (tout / 1e6) * (PRICE_OUT[providerId] ?? 6)).toFixed(4);
}

app.post('/api/chat', requireAuth, async (req, res) => {
  let { conversationId, content, provider, model } = req.body || {};
  if (!conversationId || !content) return res.status(400).json({ ok: false, message: '参数缺失' });
  // F11 自动路由：provider/model 为 auto 时按内容路由
  const route = resolveRoute(content, provider || 'deepseek', model);
  provider = route.provider;
  model = route.model;
  // F12 高级参数：读全局温度设置（settings 表，默认 1.0）
  const temperature = await getSetting('temperature', 1.0);
  // 并发限制：同账号同时在跑的对话超过上限(3)则直接拒绝（先于写库）
  const curInflight = inflight.get(req.user.id) || 0;
  if (curInflight >= 3) {
    return res.status(429).json({ ok: false, message: '并发对话已达上限(3)，请等当前对话结束或点停止后再发' });
  }
  inflight.set(req.user.id, curInflight + 1);
  const convs = await db.query('SELECT id, permission FROM conversations WHERE id=? AND account_id=?', [conversationId, req.user.id]);
  if (!convs.length) { inflight.set(req.user.id, Math.max(0, (inflight.get(req.user.id) || 1) - 1)); return res.status(404).json({ ok: false, message: '会话不存在' }); }
  const permission = convs[0].permission || 'full';

  // 存用户消息
  await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'user', content]);
  await db.query('UPDATE conversations SET updated_at=NOW() WHERE id=?', [conversationId]);

  // 组装历史（长对话压缩 P1-F8：>40 条用摘要 + 最近 30 条；摘要异步懒生成不阻塞对话）
  let hist = await db.query('SELECT id, role, content FROM messages WHERE conversation_id=? ORDER BY id', [conversationId]);
  let earlySummary = null;
  if (hist.length > 40) {
    const s = (await db.query('SELECT summary FROM conv_summaries WHERE conversation_id=?', [conversationId]))[0];
    earlySummary = s?.summary || null;
    if (!earlySummary) {
      const early = hist.slice(0, -30).map((m) => `${m.role}: ${String(m.content || '').slice(0, 400)}`).join('\n---\n');
      generateSummary(provider, early, conversationId).catch(() => {});
    }
    hist = hist.slice(-30);
  }
  const messages = [];
  if (earlySummary) messages.push({ role: 'system', content: '【早期对话摘要，无需回复】\n' + earlySummary });
  for (const m of hist) messages.push({ role: m.role, content: m.content });
  // F10 目标注入：会话存在 active 目标时提醒持续推进（目标由 set_goal 工具创建；表缺失等异常不阻断对话）
  try {
    const gl = (await db.query('SELECT objective FROM goals WHERE conversation_id=? AND status="active" ORDER BY id DESC LIMIT 1', [conversationId]))[0];
    if (gl) messages.push({ role: 'system', content: '【当前会话目标】' + gl.objective + '\n（持续围绕该目标工作直至完成；完成时调用 update_goal 标记为 completed）' });
  } catch { /* goals 表不可用时静默跳过 */ }
  // F15 技能注入：会话已载入技能（conv_skills 记录名字，内容每次实时读 SKILL.md → 文件改动即生效）
  try {
    const skRows = await db.query('SELECT skill_name FROM conv_skills WHERE conversation_id=?', [conversationId]);
    for (const sk of skRows) {
      const sp = path.join(SKILLS_ROOT, sk.skill_name, 'SKILL.md');
      if (fs.existsSync(sp)) {
        const sfull = fs.readFileSync(sp, 'utf8').slice(0, 16000);
        const body = sfull.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        messages.push({ role: 'system', content: '【已载入技能: ' + sk.skill_name + '】\n' + body });
      }
    }
  } catch { /* 技能目录不可用时静默跳过 */ }
  // F19 知识注入：会话+全局知识条目（前 5 条带 300 字正文摘要；其余仅标题），主题相关可用 kb_search 取全
  try {
    const kb = await db.query('SELECT id, scope, title, body FROM knowledge WHERE account_id=? AND (scope="global" OR (scope="conv" AND conversation_id=?)) ORDER BY id DESC LIMIT 12', [req.user.id, conversationId]);
    if (kb.length) {
      const lines = kb.map((k, i) => {
        const tag = k.scope === 'global' ? '全局' : '会话';
        const snip = i < 5 && k.body ? '\n  ' + String(k.body).replace(/\n+/g, ' ').slice(0, 300) : '';
        return '- [' + tag + '] ' + k.title + snip;
      });
      messages.push({ role: 'system', content: '【知识库条目(记忆；主题相关可引用，或 agent 路径用 kb_search 检索)】\n' + lines.join('\n') });
    }
  } catch { /* 知识表不可用时静默跳过 */ }
  // 用户自定义系统提示词（能力"系统提示词"：settings.systemPrompt，注入每条消息的模型上下文）
  try {
    const sp = await getSetting('systemPrompt', '');
    if (String(sp).trim()) messages.push({ role: 'system', content: '【用户自定义指令】\n' + String(sp) });
  } catch { /* 忽略 */ }

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const t0 = Date.now();
  let firstTokenMs = 0;
  const akey = req.user.id + ':' + conversationId;
  const actrl = new AbortController();
  abortMap.set(akey, actrl);
  try {
    const useTools = needsTools(content);
    let answer = '';
    let usage = {};
    let thinkBuf = ''; // 本轮的思考过程（reasoning）累积，落库供历史回看
    if (useTools) {
      // Agent 路径：带工具（function calling）；full 权限开放整个服务器，write/read 限定工作区
      // 实时流式：agent 每轮 emit 事件（思考中/工具开始/工具完成）即时转发给前端
      const ws = process.env.RW_WORKSPACE || '/srv/rw-workspace';
      const agentCtx = { permission, accountId: req.user.id, conversationId, root: permission === 'full' ? '/' : ws, __signal: actrl.signal };
      const result = await runAgent({
        provider, model, messages, permission, ctx: agentCtx, keys: config.keys, temperature,
        emit: (ev) => {
          if (ev.type === 'agent_thinking') {
            send({ type: 'thinking', round: ev.round });
          } else if (ev.type === 'think') {
            thinkBuf += ev.text;
            send({ type: 'think', text: ev.text });
          } else if (ev.type === 'tool_start') {
            send({ type: 'tool_start', tool: ev.tool });
          } else if (ev.type === 'tool_done') {
            send({ type: 'tool_done', tool: ev.tool });
          } else if (ev.type === 'plan') {
            send({ type: 'plan', plan: ev.plan });
          } else if (ev.type === 'approval') {
            send({ type: 'approval', id: ev.id, desc: ev.desc });
          }
        },
      });
      if (result.stopped) { send({ type: 'stopped' }); return; } // 用户点击停止：不落 assistant/统计
      answer = result.content || '（无输出）';
      usage = result.usage || {};
      // Agent 路径分块模拟流式
      const chunkSize = 8;
      for (let i = 0; i < answer.length; i += chunkSize) {
        if (!firstTokenMs) firstTokenMs = Date.now() - t0;
        send({ type: 'delta', delta: answer.slice(i, i + chunkSize) });
      }
    } else {
      // 普通对话路径：不带 tools，真实流式（模型自然回答，保持出厂认知）；思考过程实时透出
      const ctx = { usage: null, onThink: (txt) => { thinkBuf += txt; send({ type: 'think', text: txt }); } };
      for await (const delta of chatStream(provider, messages, { model, temperature }, config.keys, ctx)) {
        if (actrl.signal.aborted) break; // 服务端停止：普通路径也支持中断（保留已生成部分）
        if (!firstTokenMs) firstTokenMs = Date.now() - t0;
        answer += delta;
        send({ type: 'delta', delta });
      }
      usage = ctx.usage || {};
    }
    send({ type: 'done', usage });
    // 存 assistant 消息（reasoning=思考过程，历史回看可见）
    const r = await db.query('INSERT INTO messages (conversation_id, role, content, reasoning, model, provider, tokens_in, tokens_out) VALUES (?,?,?,?,?,?,?,?)',
      [conversationId, 'assistant', answer, thinkBuf ? String(thinkBuf).slice(0, 20000) : null, model || provider, provider, usage.tokens_in || 0, usage.tokens_out || 0]);
    // 轨迹回填：本轮执行产生的未关联工具调用归属到该 assistant 消息（历史回看用）
    await db.query('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [r.insertId, conversationId]);
    // 用量统计（含费用估算 F13）
    const tin = usage.tokens_in || 0;
    const tout = usage.tokens_out || 0;
    await db.query('INSERT INTO usage_stats (account_id, conversation_id, message_id, provider_id, model_id, tokens_in, tokens_out, cost, duration_ms, first_token_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NOW())',
      [req.user.id, conversationId, r.insertId, provider, model || provider, tin, tout, estCost(provider, tin, tout), Date.now() - t0, firstTokenMs]);
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  if (abortMap.get(akey) === actrl) abortMap.delete(akey);
  // 释放并发槽位
  inflight.set(req.user.id, Math.max(0, (inflight.get(req.user.id) || 1) - 1));
  res.end();
  // 自我重启协作：本回复已完整发出/落库，处理 reload_platform 请求
  maybeSelfRestart().catch(() => {});
});

// ---------- 用量统计（统计条） ----------
app.get('/api/usage/stats', requireAuth, async (req, res) => {
  const { conversationId } = req.query;
  const convId = conversationId ? Number(conversationId) : null;
  const p = convId ? [req.user.id, convId] : [req.user.id];
  const where = convId ? 'WHERE account_id=? AND conversation_id=?' : 'WHERE account_id=?';
  const u = (await db.query(`SELECT COUNT(*) rounds, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(duration_ms) dur, SUM(cost) cost FROM usage_stats ${where}`, p))[0] || {};
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
      cost: Number(u.cost || 0),
    },
  });
});

// ---------- 停止生成（服务端取消运行中的 Agent 轮） ----------
app.post('/api/chat/stop', requireAuth, (req, res) => {
  const { conversationId } = req.body || {};
  const c = conversationId ? abortMap.get(req.user.id + ':' + conversationId) : null;
  if (c) c.abort();
  res.json({ ok: true, stopped: Boolean(c) });
});

// ---------- 审批（F20：guard 会话高风险工具需用户确认） ----------
app.get('/api/approvals', requireAuth, (req, res) => res.json({ ok: true, pending: listPending() }));
app.post('/api/approvals/:id', requireAuth, async (req, res) => {
  const { decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ ok: false, message: 'decision=approve|reject' });
  const decided = decideApproval(req.params.id, decision);
  // 审计：审批裁决留痕（谁、批什么、结果）
  try {
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)',
      [req.user.id, 'approval:' + decision, JSON.stringify({ id: req.params.id, decided })]);
  } catch { /* 审计失败不影响 */ }
  res.json({ ok: true, decided });
});

// ---------- 设置 API（F12 温度等高级参数） ----------
app.get('/api/settings', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT skey, svalue FROM settings');
  const out = {};
  for (const r of rows) { try { out[r.skey] = JSON.parse(r.svalue); } catch { out[r.skey] = r.svalue; } }
  res.json({ ok: true, settings: out });
});
app.put('/api/settings', requireAuth, async (req, res) => {
  const { updates } = req.body || {};
  for (const [k, v] of Object.entries(updates || {})) await setSetting(k, v);
  res.json({ ok: true });
});

// ---------- 读文件（轨迹"打开文件"查看内容用） ----------
app.get('/api/file', requireAuth, async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ ok: false, message: '缺 path 参数' });
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return res.json({ ok: true, path: p, type: 'dir', entries: fs.readdirSync(p).slice(0, 200) });
    const isText = /\.(md|txt|js|jsx|ts|tsx|json|yaml|yml|html|css|py|sh|mjs|cjs|xml|sql|env|gitignore|conf)$/i.test(p) || p.includes('package.json');
    if (!isText) return res.json({ ok: true, path: p, type: 'binary', size: st.size });
    const content = fs.readFileSync(p, 'utf8');
    res.json({ ok: true, path: p, type: 'text', size: st.size, content: content.slice(0, 60000) });
  } catch (e) { res.status(400).json({ ok: false, message: '读取失败: ' + e.message }); }
});

// ---------- 上传文件（B29） ----------
app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ ok: false, message: '参数缺失' });
    const dir = path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(String(name).replace(/[\\/]/g, '_'));
    const file = path.join(dir, Date.now() + '-' + safe);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    res.json({ ok: true, path: file });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
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

// ---------- 定时任务 API（F14） ----------
app.get('/api/tasks', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT id, name, cron, prompt, provider, model, permission, enabled, last_run, next_run, last_result, created_at FROM scheduled_tasks WHERE account_id=? ORDER BY id DESC', [req.user.id]);
  res.json({ ok: true, tasks: rows });
});
app.post('/api/tasks', requireAuth, async (req, res) => {
  const { name, cron, prompt, provider, model, permission } = req.body || {};
  if (!name || !cron || !prompt) return res.status(400).json({ ok: false, message: '名称/cron/指令必填' });
  const { cronToNext } = await import('./scheduler.js');
  const next = cronToNext(cron);
  if (!next) return res.status(400).json({ ok: false, message: 'cron 格式错误（分 时 日 月 周）' });
  const r = await db.query('INSERT INTO scheduled_tasks (account_id, name, cron, prompt, provider, model, permission, next_run) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, name, cron, prompt, provider || 'deepseek', model || 'deepseek-v4-flash', permission || 'full', next]);
  res.json({ ok: true, id: r.insertId });
});
app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const { enabled, name, cron, prompt } = req.body || {};
  const sets = [], ps = [];
  if (enabled !== undefined) { sets.push('enabled=?'); ps.push(enabled ? 1 : 0); if (enabled) sets.push('next_run=NULL'); }
  if (name) { sets.push('name=?'); ps.push(name); }
  if (prompt) { sets.push('prompt=?'); ps.push(prompt); }
  if (cron) { sets.push('cron=?'); ps.push(cron); }
  if (!sets.length) return res.json({ ok: true });
  ps.push(req.params.id, req.user.id);
  await db.query(`UPDATE scheduled_tasks SET ${sets.join(',')} WHERE id=? AND account_id=?`, ps);
  const { cronToNext } = await import('./scheduler.js');
  if (cron) {
    const t = (await db.query('SELECT cron FROM scheduled_tasks WHERE id=? AND account_id=?', [req.params.id, req.user.id]))[0];
    if (t) await db.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [cronToNext(t.cron), req.params.id]);
  }
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM scheduled_tasks WHERE id=? AND account_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ---------- 健康检查（Agent 自开发演示产物，RW 自我开发闭环验证） ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'rw', ts: Date.now() });
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
  // 初始化 providers 表（同步硬编码 9 家）+ 默认模型 + 每日市场刷新
  try {
    const pCount = await db.query('SELECT COUNT(*) c FROM providers');
    if (!pCount[0]?.c) {
      for (const p of allProviders(config.keys)) {
        const r = await db.query('INSERT INTO providers (provider_key, name, base_url, api_key_env, enabled, sort_order) VALUES (?,?,?,?,1,?)', [p.id, p.name, p.base, p.keyEnv, p.id === 'deepseek' ? 0 : 10]);
        if (p.defaultModel) {
          await db.query('INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1',
            [r.insertId, p.defaultModel, p.name + ' 默认模型', JSON.stringify(p.capabilities || ['chat'])]);
        }
      }
    }
  } catch { /* 初始化失败不阻塞 */ }
  // 存量库修正：主默认模型统一 deepseek-v4-flash（reasoning 透传/思考可见），停用 deepseek-chat 别名
  try {
    const dpr = await db.query('SELECT id FROM providers WHERE provider_key=?', ['deepseek']);
    if (dpr[0]) {
      await db.query('INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1',
        [dpr[0].id, 'deepseek-v4-flash', 'DeepSeek V4 Flash（默认）', JSON.stringify(['chat', 'code', 'reasoning'])]);
      await db.query('UPDATE models SET enabled=0 WHERE provider_id=? AND model_id=?', [dpr[0].id, 'deepseek-chat']);
    }
  } catch { /* 修正失败不阻塞 */ }
  scheduleMarketRefresh();
  // 定时任务调度器（F14）
  try { startScheduler(); } catch (e) { console.error('[scheduler] 启动失败:', e.message); }
  // 微信渠道（W1-W6，默认启动；复用 iLink 登录态）
  if (process.env.RW_WECHAT !== '0') {
    startWechatChannel().catch((e) => console.error('[wechat] 启动异常:', e.message));
  }
  // 飞书 webhook（F1-F5，需公网 HTTPS 回调；PROD 域名阶段启用，TEST 可用隧道）
  if (process.env.RW_FEISHU_WEBHOOK === '1') {
    registerFeishuWebhook(app);
  }
  app.listen(config.port, () => {
    console.log(`[RW] Roni Workbench 启动: http://localhost:${config.port} (env=${process.env.NODE_ENV || 'dev'})`);
  });
}

main().catch((e) => {
  console.error('[RW] 启动失败:', e.message);
  process.exit(1);
});
