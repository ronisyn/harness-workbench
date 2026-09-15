// scripts/ra26-waitsides.mjs - RA-26 实测：把"等待人工确认/答复"在**四面**上与"执行中"对齐验证
// 依据《RW-Agent 架构 v1.1》§14.7 RA-26：
//   "等待人工确认"与"执行中"在**接口 / 监控 / 计费 / 超时**上被当作两个状态。
//
// 实测方式：真 Express 服务 + 真 agent 循环 + 真工具执行 + 真审批/问询端点 + 真 SSE，
// 只把厂商 API 换成桩（本地无 key）。客户端侧用一个定时器扮演"人"：看到卡片后等 N 秒再答复，
// 于是"等待"是真实发生的，四个面都能量出来。
//
// 四个面各测什么：
//   ① 接口：SSE 有 wait_start/wait_end；REST 待办端点能独立查到它（不是"还在跑"）
//   ② 监控：等待期间 agent_runs 不含"已执行轮次"的推进；事件环能独立看到 wait 事件
//   ③ 计费：等待期间没有 LLM 调用 → 成本不涨（只按真实调用计费）
//   ④ 超时：等待时长从"执行用时"里扣除（totals.waitedMs 与实测等待对得上），时间预算不为等待买单
//
// 用法：node scripts/ra26-waitsides.mjs
import express from 'express';
import { db } from '../server/db.js';
import { runAgent, activitySince, clearActivity } from '../server/agent.js';
import { decideAsk, listPendingAsks, createAsk } from '../server/asks.js';
import { decideApproval, listPending, createApproval } from '../server/approval.js';
import { rebuild } from '../src/eventstream.js';
import { chatStreamWithTools } from '../server/llm/gateway.js';
import { sweepStale, purgeConversation } from './probe-cleanup.js';

const PORT = Number(process.env.RA26_PORT || 3188);
const SESSION = 'ra26-' + Date.now().toString(36);
const WAIT_MS = Number(process.env.RA26_WAIT_MS || 4000); // 扮演"人"的思考时间

const admin = (await db.query('SELECT id, username FROM accounts ORDER BY id LIMIT 1'))[0];
await sweepStale(['__ra26_waitsides__', '__ra37_rebuild__']); // 先清上一次崩溃留下的残骸（否则会污染成本口径）
await db.query('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(), NOW() + INTERVAL 1 DAY)', [SESSION, admin.id]);
const conv = await db.query('INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)', [admin.id, '__ra26_waitsides__', 'full', 'chat', 'minimal', 'default']);
const conversationId = conv.insertId;
console.log(`临时会话 conversation=${conversationId}；扮演者等待 ${WAIT_MS}ms 后答复`);

// ── 厂商桩：第 1 轮问用户（ask_user），第 2 轮做一次 guard 高危工具（run_command→审批），第 3 轮收尾
let call = 0;
const log = [];
chatStreamWithTools.impl = async (provider, model, msgs, defs, keys, opts = {}) => {
  call += 1;
  log.push({ at: Date.now(), call, kind: 'llm' });
  const has = (n) => defs.some((d) => d.function.name === n);
  if (call === 1 && has('ask_user')) {
    return { content: '', reasoning: '', finishReason: 'tool_calls', streamed: false,
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '（RA-26 实测）选哪个？', options: JSON.stringify([{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]) }) } }],
      usage: { tokens_in: 800, tokens_out: 20, cache_hit: 700, cache_miss: 100 } };
  }
  if (call === 2 && has('run_command')) {
    // 用 run_command 当审批样本（GUARDED_TOOLS 成员）。注意两点：
    //   · 命令本身要能过"命令纪律" hook —— `echo` 之类会被要求改用专门工具，改用 `node --version` 才到得了审批；
    //   · run_command 是 **expert 档**，minimal/standard 档下根本不在工具面里，审批路径在窄档位下不可达
    //     （属既有设计，非本次改动引入）。本脚本因此把 preset 设为 all，专门测审批这一条路。
    return { content: '', reasoning: '', finishReason: 'tool_calls', streamed: false,
      toolCalls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ cmd: 'node --version' }) } }],
      usage: { tokens_in: 900, tokens_out: 20, cache_hit: 800, cache_miss: 100 } };
  }
  const parts = ['等待面', '已测完。'];
  for (const p of parts) { if (opts.onContent) opts.onContent(p); await new Promise((r) => setTimeout(r, 10)); }
  return { content: parts.join(''), reasoning: '', finishReason: 'stop', streamed: true,
    usage: { tokens_in: 1000, tokens_out: 30, cache_hit: 900, cache_miss: 100 } };
};

// ── 服务：与线上同形的 SSE 出口 + 真审批/问询端点 ─────────────────────────────────────────
const app = express();
app.use(express.json());
const sessionAuth = async (req, res, next) => {
  const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = (await db.query('SELECT account_id FROM sessions WHERE token=? AND expires_at > NOW()', [t]))[0];
  if (!s) return res.status(401).json({ ok: false });
  req.user = { id: s.account_id };
  next();
};
app.get('/api/asks', sessionAuth, (req, res) => res.json({ ok: true, pending: listPendingAsks() }));
app.post('/api/asks/:id', sessionAuth, (req, res) => res.json({ ok: true, decided: decideAsk(req.params.id, String((req.body || {}).option)) }));
app.get('/api/approvals', sessionAuth, (req, res) => res.json({ ok: true, pending: listPending() }));
app.post('/api/approvals/:id', sessionAuth, (req, res) => res.json({ ok: true, decided: decideApproval(req.params.id, String((req.body || {}).decision)) }));

const facts = { waitStarts: [], waitEnds: [], pendingSeen: [], usageAt: [], ringWaitEvents: 0, budgetMin: null };
// 某时刻的"账上事实"：已计费行数 + 累计成本（用于验证等待期间**两者都不涨**）
const snapshotLedger = async () => {
  const r = (await db.query('SELECT COUNT(*) n, COALESCE(SUM(cost),0) c FROM usage_stats WHERE conversation_id=?', [conversationId]))[0] || {};
  return { n: Number(r.n || 0), cost: Number(r.c || 0) };
};
app.post('/api/chat', sessionAuth, async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  const chunks = [];
  const send = (o) => { const s = `data: ${JSON.stringify(o)}\n\n`; chunks.push(s); res.write(s); };
  let answer = '', usage = {};
  send({ type: 'run_start', v: 1, conversationId, runId: null, light: false, provider: 'deepseek', model: 'deepseek-v4-flash', preset: 'all', permission: 'guard' });
  const result = await runAgent({
    provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'guard',
    messages: [{ role: 'system', content: '（RA-26 实测）' }, { role: 'user', content: '开始' }],
    ctx: { permission: 'guard', accountId: admin.id, conversationId, root: '/', __light: false, preset: 'all', mode: 'chat' },
    keys: {}, temperature: 0,
    emit: async (ev) => {
      if (ev.type === 'delta') send({ type: 'delta', delta: ev.delta });
      else if (ev.type === 'tool_start') send({ type: 'tool_start', tool: ev.tool });
      else if (ev.type === 'tool_done') send({ type: 'tool_done', tool: ev.tool });
      else if (ev.type === 'thinking') send({ type: 'thinking', round: ev.round });
      else if (ev.type === 'ask') {
        send({ type: 'ask', id: ev.id, question: ev.question, options: ev.options });
        // 扮演"人"：等 WAIT_MS 再答复。等待期间做四面的取样。
        setTimeout(async () => {
          const pend = await fetch(`http://127.0.0.1:${PORT}/api/asks`, { headers: { Authorization: 'Bearer ' + SESSION } }).then((r) => r.json());
          facts.pendingSeen.push({ face: 'ask', pending: pend.pending.length });
          await fetch(`http://127.0.0.1:${PORT}/api/asks/${ev.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SESSION }, body: JSON.stringify({ option: 'a' }) });
        }, WAIT_MS);
      } else if (ev.type === 'approval') {
        send({ type: 'approval', id: ev.id, desc: ev.desc });
        setTimeout(async () => {
          const pend = await fetch(`http://127.0.0.1:${PORT}/api/approvals`, { headers: { Authorization: 'Bearer ' + SESSION } }).then((r) => r.json());
          facts.pendingSeen.push({ face: 'approval', pending: pend.pending.length });
          await fetch(`http://127.0.0.1:${PORT}/api/approvals/${ev.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SESSION }, body: JSON.stringify({ decision: 'approve' }) });
        }, WAIT_MS);
      } else if (ev.type === 'wait_start') {
        facts.waitStarts.push({ kind: ev.wait.kind, at: Date.now() });
        const s = await snapshotLedger();
        facts.usageAt.push({ kind: ev.wait.kind, phase: 'start', ...s });
        send({ type: 'wait_start', wait: ev.wait });
      } else if (ev.type === 'wait_end') {
        facts.waitEnds.push({ kind: ev.wait.kind, ms: ev.wait.ms, at: Date.now() });
        const s = await snapshotLedger();
        facts.usageAt.push({ kind: ev.wait.kind, phase: 'end', ...s });
        send({ type: 'wait_end', wait: ev.wait });
      }
      else if (ev.type === 'fake_done_warn') send({ type: 'fake_done_warn', text: ev.text });
    },
  });
  answer = result.content || ''; usage = result.usage || {};
  const r = await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'assistant', answer]);
  const messageId = (r && r.insertId) || null;
  send({ type: 'done', usage, messageId, totals: result.usageTotals || null });
  send({ type: 'run_end', v: 1, conversationId, status: 'saved', messageId, contentLength: answer.length, usage, totals: result.usageTotals || null, waitedMs: (result.usageTotals || {}).waitedMs || 0 });
  facts.answer = answer; facts.totals = result.usageTotals || {}; facts.guard = result.guard || null;
  facts.costEnd = Number(((await db.query('SELECT COALESCE(SUM(cost),0) c FROM usage_stats WHERE conversation_id=?', [conversationId]))[0] || {}).c || 0);
  facts.ring = activitySince(conversationId, 0, 500).items.map((x) => x.type);
  clearActivity(conversationId);
  res.end();
});
const server = app.listen(PORT);

// 用真 HTTP 拉真 SSE（同时把"人"的定时器跑起来）
const t0 = Date.now();
const raw = await fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SESSION }, body: JSON.stringify({ content: '开始' }) }).then((r) => r.text());
const wallMs = Date.now() - t0;
server.close();
const view = rebuild(raw);

// ── 四面判定 ───────────────────────────────────────────────────────────────────────────
const waitedFromEvents = facts.waitEnds.reduce((a, b) => a + (b.ms || 0), 0);
// 等待期间账本不动的判据：每一段等待的 start/end 两个取样点，计费行数与累计成本都相等
const ledgerStable = ['ask', 'approval'].every((k) => {
  const s = facts.usageAt.find((x) => x.kind === k && x.phase === 'start');
  const e = facts.usageAt.find((x) => x.kind === k && x.phase === 'end');
  return s && e && s.n === e.n && Math.abs(s.cost - e.cost) < 1e-9;
});
const rows = [];
const add = (face, name, ok, detail) => rows.push({ face, name, ok: !!ok, detail: String(detail) });

add('①接口', '等待进出有事件', facts.waitStarts.length === 2 && facts.waitEnds.length === 2, `wait_start×${facts.waitStarts.length} wait_end×${facts.waitEnds.length}（expect 各 2：一次问询 + 一次审批）`);
add('①接口', 'SSE 重建出等待状态', raw.includes('"wait_start"') && raw.includes('"wait_end"'), '事件流里含 wait_start/wait_end');
add('①接口', 'REST 待办独立可查', facts.pendingSeen.length === 2 && facts.pendingSeen.every((p) => p.pending >= 1), JSON.stringify(facts.pendingSeen));
add('②监控', '等待期间账本不动（无新计费轮次）', ledgerStable, '等待 start/end 取样：' + JSON.stringify(facts.usageAt));
add('②监控', '事件环里能看见等待', facts.ring.filter((t) => t === 'wait_start').length === 2 && facts.ring.filter((t) => t === 'wait_end').length === 2, '环事件：' + facts.ring.join(','));
add('③计费', '等待期间零成本增长', ledgerStable && facts.costEnd > 0, `等待不动、调用才计费：结束累计 ¥${facts.costEnd}`);
add('③计费', '等待不产生 LLM 调用', log.length === 3, `本次执行 LLM 调用次数=${log.length}（3 = 问询轮/审批轮/收尾轮，等待本身 0 次）`);
add('④超时', '等待时长入账且与实测吻合', Math.abs(facts.totals.waitedMs - waitedFromEvents) < 1500, `totals.waitedMs=${facts.totals.waitedMs} / 事件累计=${waitedFromEvents}`);
add('④超时', '等待确实占了墙钟时间', wallMs > WAIT_MS * 1.5, `墙钟 ${wallMs}ms（含两段各 ${WAIT_MS}ms 等待）`);
add('④超时', '两段等待互不串味（问询与审批各记各的）', facts.waitEnds.length === 2 && facts.waitEnds.every((w) => w.ms >= WAIT_MS - 200), JSON.stringify(facts.waitEnds.map((w) => ({ kind: w.kind, ms: w.ms }))));

console.log('\n=== RA-26 四面 ===');
for (const r of rows) console.log(`${r.ok ? '  ✅' : '  ❌'} [${r.face}] ${r.name} — ${r.detail}`);
const ok = rows.every((r) => r.ok);
console.log('\n重建正文=' + JSON.stringify(view.answer) + ' | 落库同长=' + (view.answer === facts.answer));
console.log('判定：' + (ok ? '**四面通过**' : '**有面未通过**'));

// 清理（不留探针会话/用量，也不留审批产生的临时文件）
await purgeConversation(conversationId, SESSION);
try { (await import('node:fs')).rmSync('.ra26-waitsides.tmp', { force: true }); } catch { /* 没生成就算了 */ }
const left = (await db.query('SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id=?) m, (SELECT COUNT(*) FROM usage_stats WHERE conversation_id=?) u', [conversationId, conversationId]))[0];
console.log('清理后残留 messages=' + left.m + ' usage=' + left.u);
process.exit(ok ? 0 : 1);
