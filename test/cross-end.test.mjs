// test/cross-end.test.mjs - v0.3 §4.7 第四要素「跨端一致（GUI/飞书/API 同一套语义）」的收口夹具（2026-09-16）
//
// 契约 `docs/会话API契约-v1.md` §7 当时逐条写着四件**没做**的事，本夹具钉的正是它们做完之后可机检的那一半：
//   ① **停止入口唯一**：`POST /api/chat/stop` 停得了**渠道**轮次（不再是"只有进程内函数够得着"）；
//   ② **卡片带路由**：渠道会话的审批/问询在 `GET /api/approvals`、`GET /api/asks` 里带得出会话与渠道标识；
//   ③ **回答同一条路**：人在渠道里的回答 → 被挂住的那一轮接着跑完，与 GUI 走的是**同一批裁决函数**
//      （`decideAsk` / `decideApproval`），渠道不另造问答 API；
//   ④ **无 SSE 也能重建现场**：按会话回放事件账本（`readEvents` 的第一个对外调用方）。
// 另有一条反向钉子（⑤）：没在跑 / 已结束 / 不属于你 / 已经在停 —— `stopped` 一律如实为 false，不假装。
//
// 纪律：**不连真库、不调模型、不真开飞书/微信**（依赖全部注入，与 `test/channel-turn.test.mjs`、
// `test/feishu-webhook.test.mjs` 同一套做法）。飞书那条走**真的 Express 路由**，只有出口/依赖是假的；
// 微信那条走 `handleWechatMessage`（iLink 客户端是假的：真机链路本轮没有条件验证，如实写在契约 §7）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { runChannelTurn, activeChannelTurns } from '../server/channels/run-turn.js';
import { registerTurn, releaseTurn, stopTurn, activeTurns } from '../server/turns.js';
import { createAsk, listPendingAsks, decideAsk } from '../server/asks.js';
import { createApproval, listPending, decideApproval } from '../server/approval.js';
import { pendingCards, answerCard, answerAckText, cardText, attachCardRoutes, channelAnswerable } from '../server/cards.js';
import { replayConversation } from '../server/replay.js';
import { persistEvent, readEvents } from '../server/eventlog.js';
import { execTool } from '../server/tools/index.js';
import { db } from '../server/db.js';
import { registerFeishuWebhook } from '../server/channels/feishu-webhook.js';
import { handleWechatMessage } from '../server/channels/wechat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// execTool 的留痕（audit_log / tool_calls）走真库对象上的 db.query —— 夹具**只替换它**，不碰真库
// （与 test/injection-trust.test.mjs 同一做法：本夹具断言的是语义，往生产表里添行对结论没有增益）。
const realQuery = db.query;
db.query = async () => ({ affectedRows: 1, insertId: 1 });
test.after(() => { db.query = realQuery; });

// ── 夹具件（窄：只认被调用到的那几条语句，宽了就变成自欺）────────────────────────────────────────

/** 假渠道库：同时服务 `findOrCreateConv`（按渠道+对端 id 查会话）与 `runChannelTurn`（按会话 id 读） */
function channelDb({ convId, channel = 'feishu', externalId = 'oc_chat_1', permission = 'read', provider = null, model = null } = {}) {
  const d = {
    hist: [], messages: [], sqls: [],
    conv: { id: convId, account_id: null, permission, provider, model },
    async query(sql, params = []) {
      d.sqls.push(sql.replace(/\s+/g, ' ').trim());
      // 顺序敏感：assistant 落库那条 `INSERT INTO messages (...) SELECT ... FROM conversations WHERE id=?`
      // 同时命中两条规则，先判 INSERT（channel-turn.test.mjs 在这里踩过一次）
      if (/INSERT INTO messages/.test(sql)) {
        const id = 1000 + d.messages.length;
        d.messages.push({ id, params });
        d.hist.push({ id, role: params[1], content: params[2], created_at: null });
        return { insertId: id };
      }
      if (/FROM conversations WHERE channel=/.test(sql)) return [{ id: convId, permission }];
      if (/FROM conversations WHERE id=\?/.test(sql)) return [d.conv];
      if (/FROM settings WHERE skey=\?/.test(sql)) return [];
      if (/FROM messages WHERE conversation_id=\?/.test(sql)) return d.hist;
      if (/UPDATE tool_calls/.test(sql)) return { affectedRows: 1 };
      return [];
    },
  };
  return d;
}

/** 假引擎：跑到"被中止"为止（用来证明"跑着的时候停得下来"） */
function blockingAgent() {
  const fn = async (args) => {
    fn.started = true;
    await new Promise((resolve) => { const tick = () => (args.ctx.__signal.aborted ? resolve() : setTimeout(tick, 5)); tick(); });
    return { content: '', stopped: true, usage: {}, toolLog: [] };
  };
  fn.started = false;
  return fn;
}

/** 假事件账本（真 `persistEvent` / `readEvents` 的注入缝；`dbc` 就是这一层） */
function fakeLedger() {
  const rows = [];
  let n = 0;
  return {
    rows,
    events: {
      async append(f) { const id = ++n; rows.push({ id, conversation_id: f.conversationId, seq: f.seq || 0, type: f.type, payload: f.payload || {}, at: f.at ?? null }); return { id }; },
      async read(conversationId, { afterId = 0, limit = 2000 } = {}) {
        return rows.filter((r) => Number(r.conversation_id) === Number(conversationId) && r.id > afterId).slice(0, limit);
      },
    },
  };
}

/** 渠道轮次的注入依赖（不连库、不调模型、不写账本/投递） */
const turnDeps = (over = {}) => ({
  db: channelDb({ convId: 0 }),
  runAgent: async () => ({ content: '（渠道回复）干完了。', toolLog: [], usage: {}, usageTotals: null, spentYuan: null, finishReason: 'stop' }),
  persistEvent: () => true,
  keys: {},
  RW_WORKSPACE: ROOT,
  beginDelivery: async () => ({ id: 1 }),
  finishDelivery: async () => {},
  ensureRun: async () => ({ id: 7001 }),
  markRun: async () => {},
  resumeHint: async () => null,
  ...over,
});

/** 轮询等待（渠道与 SSE 不同：结果不在一个响应里，只能等它出现） */
async function waitFor(fn, what = '条件', ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时：' + what);
}

/** 真 ask_user 工具跑一轮：返回工具的返回值（"那一轮"是否真的恢复执行，看的就是它） */
async function runAskTool(convId, answerFn) {
  const events = [];
  const ctx = { permission: 'read', root: ROOT, conversationId: convId, accountId: null, __signal: new AbortController().signal, __emit: (e) => events.push(e) };
  const p = execTool('ask_user', { question: '选哪个？', options: JSON.stringify([{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]) }, ctx);
  await waitFor(() => events.some((e) => e.type === 'ask'), '问询卡事件');
  const cardEvent = events.find((e) => e.type === 'ask');
  const answered = answerFn(cardEvent);
  return { out: await p, cardEvent, answered, stillPending: listPendingAsks().some((x) => x.id === cardEvent.id) };
}

// ── ① 停止入口唯一：渠道轮次停得下来 ──────────────────────────────────────────────────────────────
test('① 停止入口唯一：POST /api/chat/stop 的那一句能停渠道轮次（渠道会话 account_id 为 NULL 也停得下来）', async () => {
  const convId = 9101;
  const runAgent = blockingAgent();
  const p = runChannelTurn({ channel: 'feishu', conversationId: convId, text: '跑个长任务', deps: turnDeps({ db: channelDb({ convId }), runAgent }) });
  await waitFor(() => activeChannelTurns().some((t) => t.conversationId === convId), '渠道轮次登记');
  assert.deepEqual(activeTurns().find((t) => t.conversationId === convId), {
    conversationId: convId, accountId: null, channel: 'feishu', kind: 'channel', startedAt: activeTurns().find((t) => t.conversationId === convId).startedAt,
  }, '渠道轮次要登记在**共享**轮次表里，且账号如实为 null（键不许依赖它）：' + JSON.stringify(activeTurns()));
  // ↓ 这一句与 server/index.js 的 `/api/chat/stop` 处理器是同一个函数、同一份参数形状
  const stopped = stopTurn({ conversationId: convId, accountId: 1, reason: 'user' });
  assert.equal(stopped, true, '渠道轮次必须停得下来（改前 HTTP 面查不到它：私有表键里带账号，而渠道会话 account_id 是 NULL）');
  const res = await p;
  assert.equal(res.status, 'stopped');
  assert.equal(res.error.code, 'ABORTED');
  assert.deepEqual(activeChannelTurns(), [], '跑完必须注销登记（否则下一轮会被误停）');
});

test('① 接线（源码级）：/api/chat/stop 走共享登记表，私有 abortMap 已不存在，两处登记/注销同一张表', () => {
  const idx = read('server/index.js');
  const route = /app\.post\('\/api\/chat\/stop'[\s\S]*?\n\}\);/.exec(idx);
  assert.ok(route, '要能从 index.js 抠出 stop 路由（抠不出来说明这段正则失效了，别让夹具变摆设）');
  assert.match(route[0], /stopTurn\(\{ conversationId, accountId: req\.user\.id, reason: 'user' \}\)/, '停止必须走唯一入口 stopTurn');
  assert.equal(/const abortMap = new Map/.test(idx), false, '私有 abortMap 必须消失——两份登记正是"渠道会话停不了"的成因');
  assert.match(idx, /import \{ registerTurn, releaseTurn, stopTurn \} from '\.\/turns\.js'/, '登记表只有一处（server/turns.js）');
  assert.match(idx, /registerTurn\(\{ conversationId, controller: actrl, accountId: req\.user\.id, channel: 'web'/, '/api/chat 的轮次登记在**同一张表**里');
  assert.match(idx, /releaseTurn\(conversationId, actrl\)/, '收尾注销的也是同一张表');
  assert.match(idx, /stopTurn\(\{ conversationId: req\.params\.id, accountId: req\.user\.id, reason: 'delete' \}\)/, '删会话的抢占同样走这一条');
  // 渠道侧不许再自己留一份登记
  const rt = read('server/channels/run-turn.js');
  assert.match(rt, /registerTurn\(\{ conversationId, controller, accountId: conv\.account_id \?\? null, channel, kind: 'channel'/, '渠道轮次登记在同一张表（accountId 如实取会话行的值）');
  assert.match(rt, /releaseTurn\(conversationId, controller\)/, '渠道轮次同样在同一张表里注销');
  assert.equal(/const activeTurns = new Map/.test(rt), false, '渠道侧不许再留第二份轮次表');
  assert.equal(/controller\.abort\(/.test(rt), false, '渠道侧不许绕过 stopTurn 直接 abort（绕过就是第二条停止路）');
});

// ── ⑤ 如实 false：不假装停成功 ───────────────────────────────────────────────────────────────────
test('⑤ 如实 false：没在跑 / 已结束 / 不属于你 / 已经在停 —— 都不假装停成功', async () => {
  const convId = 9102;
  assert.equal(stopTurn({ conversationId: 999999, accountId: 1 }), false, '没有这一轮 ⇒ false');

  // 跑完的一轮：登记已注销 ⇒ 停不到（"停下来"这件事已经结束了）
  const done = await runChannelTurn({ channel: 'wechat', conversationId: convId, text: '小事一桩', deps: turnDeps({ db: channelDb({ convId, channel: 'wechat' }) }) });
  assert.equal(done.ok, true);
  assert.equal(stopTurn({ conversationId: convId, accountId: 1 }), false, '已经跑完 ⇒ false');

  // 别人账号的 GUI 轮次：归属判据与 GET /messages 同一条，没有放宽
  const other = new AbortController();
  registerTurn({ conversationId: 9103, controller: other, accountId: 7, channel: 'web', kind: 'chat' });
  assert.equal(stopTurn({ conversationId: 9103, accountId: 8 }), false, '不属于你的轮次停不了');
  assert.equal(other.signal.aborted, false, '报 false 就必须真没停（不许"嘴上说没停、手已经按下去了"）');
  assert.equal(stopTurn({ conversationId: 9103, accountId: 7 }), true, '本人的轮次停得下来');
  assert.equal(stopTurn({ conversationId: 9103, accountId: 7 }), false, '已经在停 ⇒ 本次没有再中止什么，如实 false');
  releaseTurn(9103, other);
});

// ── ② 卡片带会话与渠道标识 ───────────────────────────────────────────────────────────────────────
test('② 卡片带路由：渠道会话的审批/问询在列表里带得出会话与渠道标识；未登记的渠道如实"不支持回答"', async () => {
  const convFeishu = 7701, convWechat = 7702, convUnknown = 7703;
  const asks = [
    createAsk('选哪个？', [{ label: 'A', value: 'a' }], { conversationId: convFeishu }),
    createAsk('没有会话归属的卡', [{ label: 'A', value: 'a' }]),
  ];
  const ap = createApproval('工具 run_command 需要确认', { conversationId: convWechat });
  const apUnknown = createApproval('工具 db_write 需要确认', { conversationId: convUnknown });
  try {
    const db0 = {
      async query(sql, params) {
        assert.match(sql, /^SELECT id, channel, external_id FROM conversations WHERE id IN \(\?(?:,\?)*\)$/, '路由事实只读会话行既有的两列（不新造列/表）：' + sql);
        return [
          { id: convFeishu, channel: 'feishu', external_id: 'oc_chat_1' },
          { id: convWechat, channel: 'wechat', external_id: 'wx_user_1' },
          { id: convUnknown, channel: 'sms', external_id: '+8613800000000' },
        ].filter((r) => params.includes(r.id));
      },
    };
    const askRow = (await attachCardRoutes(listPendingAsks(), { db: db0 })).find((x) => x.id === asks[0].id);
    assert.equal(askRow.conversationId, convFeishu, '问询要带得出归属会话');
    assert.equal(askRow.channel, 'feishu');
    assert.equal(askRow.channelName, '飞书');
    assert.equal(askRow.externalId, 'oc_chat_1', '渠道对端 id 取自会话行既有列 external_id');
    assert.equal(askRow.channelAnswerable, true, '飞书有回信通道 ⇒ 能答');

    const apRow = (await attachCardRoutes(listPending(), { db: db0 })).find((x) => x.id === ap.id);
    assert.equal(apRow.conversationId, convWechat);
    assert.equal(apRow.channel, 'wechat');
    assert.equal(apRow.channelAnswerable, true);

    // 未登记的渠道：不许假装能答（v0.3 §4.6 那条"禁止静默降级"的反方向：拿不准就说不支持）
    const unknownRow = (await attachCardRoutes(listPending(), { db: db0 })).find((x) => x.id === apUnknown.id);
    assert.equal(unknownRow.channel, 'sms');
    assert.equal(unknownRow.channelAnswerable, false, '未登记回答通道的渠道必须如实 false');
    assert.equal(channelAnswerable('sms'), false);
    assert.equal(channelAnswerable(null), false);

    // 没有会话归属的卡：如实 null，不是"随便挂一个"
    const orphan = (await attachCardRoutes(listPendingAsks(), { db: db0 })).find((x) => x.id === asks[1].id);
    assert.equal(orphan.conversationId, null);
    assert.equal(orphan.channel, null);
    assert.equal(orphan.channelAnswerable, false);

    // 读不到会话行时不阻断列表（观测面坏掉不该让人连卡片都看不见），但绝不编一个渠道出来
    const broken = await attachCardRoutes(listPendingAsks(), { db: { async query() { throw new Error('库抖了一下'); } } });
    assert.equal(broken.find((x) => x.id === asks[0].id).channel, null, '查不到就说查不到');
    assert.equal(broken.find((x) => x.id === asks[0].id).channelAnswerable, false);

    // 两个列表端点确实挂上了它（否则上面这些字段到不了调用方）
    const idx = read('server/index.js');
    assert.match(idx, /app\.get\('\/api\/asks'[\s\S]*?attachCardRoutes\(listPendingAsks\(\)\)/, '/api/asks 要带路由事实');
    assert.match(idx, /app\.get\('\/api\/approvals'[\s\S]*?attachCardRoutes\(listPending\(\)\)/, '/api/approvals 要带路由事实');
    // 裁决端点只有那一条（渠道不许旁路出第二条）
    assert.equal(/app\.post\('\/api\/asks\/:id'/.test(idx), true);
    assert.equal((idx.match(/app\.post\('\/api\/asks\/:id'/g) || []).length, 1, '问询裁决入口只有一个');
    assert.equal((idx.match(/app\.post\('\/api\/approvals\/:id'/g) || []).length, 1, '审批裁决入口只有一个');
  } finally {
    // 清干净：待答项带 5/10 分钟超时定时器，留着会挂到同进程后续夹具上
    decideAsk(asks[0].id, 'a'); decideAsk(asks[1].id, 'a');
    decideApproval(ap.id, 'approve'); decideApproval(apUnknown.id, 'approve');
  }
});

// ── ③ 回答同一条路：GUI 与渠道都收敛到同一批裁决函数 ───────────────────────────────────────────────
test('③ 同一条路：人在渠道里回一句，被挂住的那一轮接着跑完，与 GUI 裁决的结果逐字段一致', async () => {
  const convGui = 9202, convCh = 9203;
  // GUI 路：`POST /api/asks/:id` 处理器做的就是这一句
  const gui = await runAskTool(convGui, (ev) => decideAsk(ev.id, 'a'));
  // 渠道路：适配器调的就是这一句（cards.js 内部同样是 decideAsk）
  const ch = await runAskTool(convCh, () => answerCard(convCh, '1')); // 渠道里回复编号 1
  assert.equal(gui.out.chosen, 'a');
  assert.equal(ch.out.chosen, 'a', '渠道里的回答要能把那一轮接着跑完：' + JSON.stringify(ch.out));
  assert.equal(ch.out.note, gui.out.note, '两条路的工具返回值同形同义（不是"看起来像"）');
  assert.equal(ch.answered.answered, true);
  assert.equal(ch.answered.kind, 'ask');
  assert.equal(ch.answered.value, 'a', '编号 1 解析成选项值 a');
  assert.equal(ch.stillPending, false, '答过之后待答项必须出队');
  assert.equal(gui.stillPending, false);
  // 反向：对不上的话**不许**把它当成裁决（宁可当普通消息），也**不许**把卡片弄没
  const convMiss = 9204;
  const miss = createAsk('选哪个？', [{ label: 'A', value: 'a' }], { conversationId: convMiss });
  try {
    const r = answerCard(convMiss, '这句不是选项');
    assert.equal(r.answered, false);
    assert.equal(r.reason, 'no-pending-match');
    assert.equal(listPendingAsks().some((x) => x.id === miss.id), true, '认不出来就必须原样留着卡片');
  } finally { decideAsk(miss.id, 'a'); }
});

test('③ 同一条路（机制级）：渠道侧只能调 GUI 端点调的那两个裁决函数，队列本身碰不得', () => {
  const cards = read('server/cards.js');
  assert.match(cards, /decideAsk\(card\.id, value\)/, '问询裁决必须走 decideAsk');
  assert.match(cards, /decideApproval\(card\.id, value\)/, '审批裁决必须走 decideApproval');
  assert.equal(/pending\.(get|set|delete)/.test(cards), false, '渠道侧不许自己动待答队列——那才是"另造一套问答 API"');
  const idx = read('server/index.js');
  assert.match(/app\.post\('\/api\/asks\/:id'[\s\S]*?\n\}\);/.exec(idx)[0], /decideAsk\(/, 'GUI 端点用的就是同一个函数');
  assert.match(/app\.post\('\/api\/approvals\/:id'[\s\S]*?\n\}\);/.exec(idx)[0], /decideApproval\(/);
  // 卡片的归属只从工具接线来（两处 create* 调用各一行）
  const tools = read('server/tools/index.js');
  assert.match(tools, /createAsk\(q, normalized, \{ conversationId: ctx && ctx\.conversationId \}\)/, 'ask 要带会话归属');
  assert.match(tools, /createApproval\(`工具 \$\{name\} 需要确认[\s\S]{0,80}\{ conversationId: eff\.conversationId \}\)/, 'approval 要带会话归属');
});

// ── ③ 端到端：飞书（真路由 + 假出口）────────────────────────────────────────────────────────────
const msgEvent = (text, token) => ({
  header: { event_type: 'im.message.receive_v1', token },
  event: { message: { chat_id: 'oc_chat_1', content: JSON.stringify({ text }) }, sender: { sender_id: { open_id: 'ou_1' } } },
});
const withEnv = async (env, fn) => {
  const saved = { FEISHU_VERIFICATION_TOKEN: process.env.FEISHU_VERIFICATION_TOKEN, FEISHU_ENCRYPT_KEY: process.env.FEISHU_ENCRYPT_KEY };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
async function startFeishu(opts) {
  const app = express();
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  registerFeishuWebhook(app, opts);
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port })); });
}
const postFeishu = (url, body) => fetch(url + '/api/feishu/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('③ 端到端（飞书真路由）：卡片发到聊天里，人在飞书里回一句，那一轮接着跑完并落账', async () => {
  await withEnv({ FEISHU_VERIFICATION_TOKEN: 'VT-cross-end', FEISHU_ENCRYPT_KEY: undefined }, async () => {
    const convId = 9201;
    const db0 = channelDb({ convId, channel: 'feishu' });
    const sent = [];
    const ledger = [];
    // 引擎缝里跑**真工具** ask_user：它 await 的就是待答卡片本身（与生产同一条路）
    const runAgent = async (args) => {
      const r = await execTool('ask_user', { question: '选哪个？', options: JSON.stringify([{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]) },
        { permission: 'read', root: ROOT, conversationId: convId, accountId: null, __signal: args.ctx.__signal, __emit: args.emit });
      return { content: '你选了 ' + r.chosen, toolLog: [], usage: {}, usageTotals: null, spentYuan: null, finishReason: 'stop' };
    };
    const d = turnDeps({
      db: db0, runAgent,
      persistEvent: (cid, ev) => { ledger.push({ cid, ...ev }); return true; },
    });
    const app = await startFeishu({ deps: d, sendText: async (to, type, text) => { sent.push(text); } });
    try {
      const r1 = await postFeishu(app.url, msgEvent('帮我选一个', 'VT-cross-end'));
      assert.equal(r1.status, 200, 'webhook 先回 200（官方要求 3 秒内确认）');
      await waitFor(() => sent.length >= 1, '卡片发到飞书');
      assert.match(sent[0], /选哪个？/, '卡片必须**发到人所在的端**（渠道没有 SSE，只落账本＝人看不到它）');
      assert.match(sent[0], /1\) A/, '渠道里只能用文字回答，选项要带编号：' + sent[0]);
      const card = pendingCards(convId)[0];
      assert.ok(card, '卡片要挂在会话上，渠道侧才找得到它');
      assert.equal(card.kind, 'ask');
      assert.equal(card.conversationId, convId);

      const r2 = await postFeishu(app.url, msgEvent('1', 'VT-cross-end'));
      assert.equal(r2.status, 200);
      await waitFor(() => sent.some((t) => t === '你选了 a'), '被唤醒的那一轮跑完并把回复发出去');
      assert.ok(sent.some((t) => /已回答/.test(t)), '渠道里的回答要有回执：' + JSON.stringify(sent));
      assert.equal(sent[sent.length - 1], '你选了 a');
      // 账本上"那一轮真的接着跑完了"：run_start → ask → run_end(saved)，且 assistant 落了库
      assert.deepEqual(ledger.map((e) => e.type), ['run_start', 'ask', 'run_end'], '账本序列：' + JSON.stringify(ledger.map((e) => e.type)));
      assert.equal(ledger.at(-1).status, 'saved');
      assert.equal(db0.messages.filter((m) => m.params[1] === 'assistant').length, 1);
      assert.deepEqual(pendingCards(convId), [], '答过之后卡片出队');
    } finally { app.srv.close(); }
  });
});

// ── ③ 端到端：微信（iLink 客户端是假的；真机未验证，如实写在契约 §7）────────────────────────────────
test('③ 端到端（微信同源）：iLink 消息同样把卡片发出去、也接得住回答', async () => {
  const convId = 9301;
  const db0 = channelDb({ convId, channel: 'wechat', externalId: 'wx_user_1' });
  const sent = [];
  const client = { sendText: async (to, text) => { sent.push({ to, text }); }, getContextToken: () => 'ct-1' };
  const runAgent = async (args) => {
    const r = await execTool('ask_user', { question: '选哪个？', options: JSON.stringify([{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]) },
      { permission: 'read', root: ROOT, conversationId: convId, accountId: null, __signal: args.ctx.__signal, __emit: args.emit });
    return { content: '你选了 ' + r.chosen, toolLog: [], usage: {}, usageTotals: null, spentYuan: null, finishReason: 'stop' };
  };
  const d = turnDeps({ db: db0, runAgent });
  const p1 = handleWechatMessage({ msg: { from_user_id: 'wx_user_1', text: '帮我选一个' }, client, deps: d });
  await waitFor(() => sent.length >= 1, '卡片发到微信');
  assert.match(sent[0].text, /选哪个？/);
  assert.equal(sent[0].to, 'wx_user_1', '发回原来那个对端');
  const r2 = await handleWechatMessage({ msg: { from_user_id: 'wx_user_1', text: 'A' }, client, deps: d }); // 用选项 label 回答
  assert.equal(r2.answered, true, 'iLink 侧的回答要能被认出来（label 也认）');
  const r1 = await p1;
  assert.equal(r1.reply, '你选了 a');
  assert.ok(sent.some((s) => s.text === '你选了 a'));
});

// ── ④ 无 SSE 的回放：按会话重建现场 ──────────────────────────────────────────────────────────────
test('④ 渠道回放能重建现场：事件序列与 events 账本逐条一致，增量游标不重放', async () => {
  const convId = 9401;
  const store = fakeLedger();      // 真 persistEvent / readEvents 的介质缝
  const db0 = channelDb({ convId, channel: 'feishu' });
  const runAgent = async (args) => {
    args.emit({ type: 'agent_thinking', round: 1 });
    args.emit({ type: 'tool_start', tool: { name: 'read_file' } });
    args.emit({ type: 'tool_done', tool: { name: 'read_file', status: 'done' } });
    return { content: '干完了。', toolLog: [], usage: { tokens_in: 1, tokens_out: 1 }, usageTotals: null, spentYuan: null, finishReason: 'stop' };
  };
  const res = await runChannelTurn({
    channel: 'feishu', conversationId: convId, text: '你好',
    deps: turnDeps({ db: db0, runAgent, persistEvent: (cid, ev) => persistEvent(cid, ev, store) }),
  });
  assert.equal(res.ok, true);
  await waitFor(async () => (await readEvents(convId, { dbc: store })).length >= 5, '事件落账（fire-and-forget）');

  const scene = await replayConversation(convId, { db: db0, dbc: store });
  assert.deepEqual(scene.events.map((e) => e.type),
    ['run_start', 'agent_thinking', 'tool_start', 'tool_done', 'run_end'],
    '回放的序列＝账本里的序列（渠道没有 SSE，"重建现场"就靠这一条）');
  assert.equal(scene.events.at(-1).payload.status, 'saved');
  assert.ok(scene.events.every((e) => e.id > 0 && e.type), '每条事件都要带账本行 id（增量游标的锚点）');
  assert.deepEqual(scene.messages.map((m) => m.role), ['user', 'assistant'], '消息与事件是同一次回放里的两笔');
  assert.equal(scene.messages[1].content, '干完了。');
  // 增量：给最后一行的 id ⇒ 没有新事件（重连不重复回放）
  const tail = await replayConversation(convId, { afterId: scene.events.at(-1).id, db: db0, dbc: store });
  assert.deepEqual(tail.events, []);
  // 只读：回放不许触发执行（没有第二轮 run_start）
  assert.equal((await replayConversation(convId, { db: db0, dbc: store })).events.filter((e) => e.type === 'run_start').length, 1);
});

test('④ 接线（源码级）：回放挂在既有 /messages 上（`?events=1`），默认响应不带 events；readEvents 不再是零调用方', () => {
  const idx = read('server/index.js');
  const route = /app\.get\('\/api\/conversations\/:id\/messages'[\s\S]*?\n\}\);/.exec(idx);
  assert.ok(route, '要能抠出 /messages 路由');
  assert.match(route[0], /replayConversation\(req\.params\.id, \{ afterId: req\.query\.afterId, db \}\)/, '带事件时就地回放（同一个会话归属判据，不另开一条端点）');
  assert.match(route[0], /const withEvents = String\(req\.query\.events/, '默认不带 events（老调用方的响应逐字节不变）');
  assert.match(idx, /MESSAGES_SQL/, '消息读的 SQL 只有一处（replay.js 导出，端点与回放共用）');
  const rp = read('server/replay.js');
  assert.match(rp, /readEvents\(cid, opts\)/, '回放读的就是账本（readEvents）');
  assert.equal(/INSERT|UPDATE|DELETE/.test(rp.replace(/\/\/.*$/gm, '')), false, '回放是只读的：它没有写路径');
});

// ── 文案协议：一处定义，两端共用（改文案不该只改一半）──────────────────────────────────────────────
test('卡片文案与回答确认只有一处实现（两个渠道共用，不许各写一份）', () => {
  assert.match(cardText({ kind: 'ask', question: '选哪个？', options: [{ label: 'A', value: 'a' }] }), /❓ 选哪个？\n1\) A/);
  assert.match(cardText({ type: 'approval', desc: '工具 run_command 需要确认' }), /回复「批准」或「拒绝」/);
  assert.equal(cardText(null), '');
  assert.match(answerAckText({ answered: true, kind: 'ask', value: 'a' }), /已回答：a/);
  assert.match(answerAckText({ answered: true, kind: 'approval', value: 'approve' }), /已批准/);
  for (const f of ['server/channels/feishu-webhook.js', 'server/channels/wechat.js']) {
    const code = read(f);
    assert.match(code, /from '\.\.\/cards\.js'/, f + ' 必须用共享的卡片层');
    assert.match(code, /cardText\(card\)/, f + ' 卡片文案不许各写一份');
  }
});
