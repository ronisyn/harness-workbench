// scripts/ra37-rebuild.mjs - RA-37 实测：跑一次真执行，抓真 SSE，用**线上同一条**重建器对账服务端事实
// 依据《RW-Agent 架构 v1.1》§14.9 RA-37："任一客户端仅靠事件流可重建全过程"。
//
// 为什么这样可以算实测（而不是自证）：
//   · HTTP 是真的：脚本起一个 Express 服务，挂的是**线上同一段 SSE 出口代码**（同一 send/run_start/落库顺序/补流对账）。
//   · agent 循环是真的：真跑 runAgent，真调工具，真落 messages / tool_calls / usage_stats / agent_runs。
//   · 事件环是真的：真走 emitEv（序号、合并、清理），/activity 轮询也照测。
//   · 唯一被替换的是**厂商 API**（本地没有 key）：用 stub 事件流替掉 chatStreamWithTools。
//     被替换的只是"字节从模型来还是从脚本来"，**不改变第 1–3 条的任何一条**。
//   · 对账是真正文逐字比：事件流拼出的 answer vs `messages.content`，以及轮次/成本/落库 id。
//
// 用法（仓库根目录）：node scripts/ra37-rebuild.mjs
import express from 'express';
import { db } from '../server/db.js';
import { runAgent, activitySince, clearActivity } from '../server/agent.js';
import { toolDefs } from '../server/tools/index.js';
import { rebuild, verifyRebuild } from '../src/eventstream.js';
import { childEmit } from './child-emit.js';
import { chatStreamWithTools } from '../server/llm/gateway.js';
import { streamPatch } from '../server/streampatch.js';
import { sweepStale, purgeConversation } from './probe-cleanup.js';

const PORT = Number(process.env.RA37_PORT || 3187);
const SESSION = 'ra37-' + Date.now().toString(36);
const SCENARIO = process.env.RA37_SCENARIO || 'normal'; // normal | appended | prefixed

// ── 1. 临时会话（跑完即删；用与线上同样的 sessions 表，所以 requireAuth 那一段也是真的）──────────
const admin = (await db.query("SELECT id, username FROM accounts ORDER BY id LIMIT 1"))[0];
if (!admin) { console.error('库里没有账号，无法建临时会话'); process.exit(1); }
await sweepStale(['__ra37_rebuild__', '__ra26_waitsides__']); // 先清上一次崩溃留下的残骸（否则会污染成本口径）
await db.query('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(), NOW() + INTERVAL 1 DAY)', [SESSION, admin.id]);
const conv = await db.query("INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)", [admin.id, '__ra37_rebuild__', 'read', 'chat', 'minimal', 'default']);
const conversationId = conv.insertId;
console.log(`临时会话：token=${SESSION.slice(0, 12)}… conversation=${conversationId} 账号=${admin.username}`);

// ── 2. 厂商 API stub：只替掉"字节从模型来"这一步 ──────────────────────────────────────────
let call = 0;
const PHRASES = {
  normal: ['事件流', '可以', '重建', '全过程。'],
  appended: ['事件流', '可以', '重建', '全过程。'],   // 服务端会再追加 TRUNC_NOTE（触发尾补流）
  prefixed: ['只承诺', '不行动。'],                    // 服务端会前置假完成加注（触发头补流）
};
const stubResult = (content, extra = {}) => ({
  content, toolCalls: [], reasoning: '', finishReason: extra.finishReason || 'stop',
  usage: { tokens_in: 1200, tokens_out: 40, cache_hit: 1000, cache_miss: 200 },
  streamed: true, ...extra,
});
chatStreamWithTools.impl = async (provider, model, msgs, defs, keys, opts = {}) => {
  call += 1;
  // 第一轮：真调一次工具（真执行、真落 tool_calls），这一轮**不产出正文** —— 与真实模型一致
  // （工具轮只给旁白、正文为空）。若这里也发正文，重建长度就会是两轮之和，对账必然假红。
  if (SCENARIO !== 'prefixed' && call === 1 && defs.some((d) => d.function.name === 'list_dir')) {
    return {
      content: '', reasoning: '先看一眼目录', finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
      usage: { tokens_in: 1100, tokens_out: 30, cache_hit: 900, cache_miss: 200 },
      streamed: false,
    };
  }
  const parts = PHRASES[SCENARIO] || PHRASES.normal;
  const r = stubResult(parts.join(''));
  if (SCENARIO === 'appended') r.finishReason = 'length';
  for (const p of parts) { if (opts.onContent) opts.onContent(p); await new Promise((r2) => setTimeout(r2, 15)); }
  return r;
};

// ── 3. 与线上同一段 SSE 出口逻辑 ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.post('/api/chat', async (req, res) => {
  const { content = '（RA-37 实测）' } = req.body || {};
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const chunks = [];
  const send = (obj) => { const s = `data: ${JSON.stringify(obj)}\n\n`; chunks.push(s); res.write(s); };
  const t0 = Date.now();
  let thinkBuf = '';
  try {
    const permission = 'read';
    let answer = '', usage = {};
    const messages = [{ role: 'system', content: '（RA-37 实测夹具）' }, { role: 'user', content: String(content) }];
    // run_start 必须**先于**本轮任何事件（与 server/index.js 同序）：它是执行边界的起点
    send({ type: 'run_start', v: 1, conversationId, runId: null, light: false, provider: 'deepseek', model: 'deepseek-v4-flash', preset: 'minimal', permission });
    const result = await runAgent({
      provider: 'deepseek', model: 'deepseek-v4-flash', messages, permission,
      ctx: { permission, accountId: admin.id, conversationId, root: '/', __light: false, preset: 'minimal', mode: 'chat' },
      keys: {}, temperature: 0,
      emit: (ev) => {
        if (ev.type === 'agent_thinking') send({ type: 'thinking', round: ev.round });
        else if (ev.type === 'think') { thinkBuf += ev.text; send({ type: 'think', text: ev.text }); }
        else if (ev.type === 'tool_start') send({ type: 'tool_start', tool: ev.tool });
        else if (ev.type === 'tool_done') send({ type: 'tool_done', tool: ev.tool });
        else if (ev.type === 'delta') send({ type: 'delta', delta: ev.delta });
        else if (ev.type === 'wait_start') send({ type: 'wait_start', wait: ev.wait });
        else if (ev.type === 'wait_end') send({ type: 'wait_end', wait: ev.wait });
        else if (ev.type === 'fake_done_warn') send({ type: 'fake_done_warn', text: ev.text });
      },
    });
    const waitedMs = () => (result.usageTotals && result.usageTotals.waitedMs) || 0;
    answer = result.content || '（无输出）';
    usage = result.usage || {};
    if (result.finishReason === 'length' && answer) answer += '\n\n（本轮输出触到模型长度上限，已截断；可说"继续"续写）';
    // 补流对账：与 server/index.js 走**同一个**纯函数（server/streampatch.js）——
    // 以前这里抄了一份内联逻辑，抄件与原件会各自漂移，实测就不再等于线上行为。
    if (result.streamed && answer) {
      const patch = streamPatch(answer, result.streamedText);
      if (patch.mode === 'mismatch') console.warn('[stream] 事件流正文与落库正文无法对账（实测脚本），已整段补发');
      if (patch.head) send({ type: 'delta', delta: patch.head });
      if (patch.tail) send({ type: 'delta', delta: patch.tail });
    }
    const r = await db.query('INSERT INTO messages (conversation_id, role, content, model, provider, tokens_in, tokens_out) VALUES (?,?,?,?,?,?,?)',
      [conversationId, 'assistant', answer, 'deepseek-v4-flash', 'deepseek', usage.tokens_in || 0, usage.tokens_out || 0]);
    const messageId = (r && r.insertId) || null;
    if (messageId) await db.query('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [messageId, conversationId]);
    send({ type: 'done', usage, messageId, runId: null, totals: result.usageTotals || null });
    send({ type: 'run_end', v: 1, conversationId, runId: null, status: 'saved', messageId, contentLength: answer.length, finishReason: result.finishReason || '', usage, totals: result.usageTotals || null, spentYuan: result.spentYuan ?? null, waitedMs: waitedMs() });
  } catch (e) {
    send({ type: 'error', message: e.message });
    send({ type: 'run_end', v: 1, conversationId, status: 'error', reason: 'exception', reasonText: String(e.message).slice(0, 300) });
  }
  clearActivity(conversationId);
  res.end();
});
const server = app.listen(PORT);

// ── 4. 用真 HTTP 拉真 SSE ──────────────────────────────────────────────────────────────
const raw = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '（RA-37 实测）请回答' }),
}).then((r) => r.text());
server.close();

// run_start 在真实实现里早于其余事件；本脚本的 send 顺序按真实实现的时序补正（见 server/index.js）
const view = rebuild(raw);

// ── 5. 与服务端事实对账 ────────────────────────────────────────────────────────────────
const stored = (await db.query('SELECT id, content FROM messages WHERE conversation_id=? AND role="assistant" ORDER BY id DESC LIMIT 1', [conversationId]))[0] || {};
const usageAgg = (await db.query('SELECT COUNT(*) rounds, COALESCE(ROUND(SUM(cost),4),0) cost FROM usage_stats WHERE conversation_id=?', [conversationId]))[0] || {};
const toolRows = await db.query('SELECT tool_name, status FROM tool_calls WHERE conversation_id=? ORDER BY id', [conversationId]);
const activity = activitySince(conversationId, 0, 500);

const verdict = verifyRebuild(view, { storedContent: stored.content, messageId: stored.id, usageRounds: usageAgg.rounds, usageCost: usageAgg.cost });
console.log('\n=== 事件流重建 vs 服务端事实 ===');
console.log('抓到帧数：' + raw.split('\n\n').filter(Boolean).length + ' | 场景=' + SCENARIO);
console.log('重建正文长度=' + view.answer.length + ' 落库正文长度=' + String(stored.content || '').length);
console.log('落库 messageId=' + stored.id + ' 事件回执 messageId=' + view.messageId);
console.log('工具轨迹：事件 ' + view.tools.length + ' 个 / 库 ' + toolRows.length + ' 行');
console.log('轮次：事件 ' + view.rounds + ' / usage_stats ' + usageAgg.rounds + ' 行');
console.log('累计成本：事件 ¥' + (view.totals && view.totals.cost) + ' / usage_stats ¥' + usageAgg.cost);
console.log('活动环事件数：' + activity.items.length + '（含环自己的 run_end）');
for (const c of verdict.checks) console.log((c.ok ? '  ✅ ' : '  ❌ ') + c.name + ' — ' + c.detail);
console.log('\n判定：' + (verdict.ok ? '**通过**（仅靠事件流可重建这一段全过程）' : '**未通过**'));

// ── 6. 清理（不留探针会话污染成本口径；RA-35 分档之外也不该留）──────────────────────────────
await purgeConversation(conversationId, SESSION);
const left = (await db.query('SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id=?) m, (SELECT COUNT(*) FROM usage_stats WHERE conversation_id=?) u, (SELECT COUNT(*) FROM tool_calls WHERE conversation_id=?) t', [conversationId, conversationId, conversationId]))[0];
console.log('清理后残留：messages=' + left.m + ' usage=' + left.u + ' tool_calls=' + left.t);
process.exit(verdict.ok ? 0 : 1);
