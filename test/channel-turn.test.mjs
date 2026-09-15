// test/channel-turn.test.mjs - 渠道「跑一轮并落账」共享入口的语义夹具（v0.3 §4.7 G5「跨端一致」）
//
// 这条防的是**被代码反证过的真实缺口**（`proposals/v0.3-符合性核对-20260916.md` §3.5 缺陷①）：
// 飞书与微信从前各自拼历史、**直调 runAgent 且不传 emit**（`feishu-webhook.js:110-128`、`wechat.js:54-73`），
// 于是渠道会话没有事件账、没有投递记录、不能停、失败只有一句中文散文，还各自硬编码模型。
// 夹具把共享入口（`server/channels/run-turn.js`）的这四条语义钉死——它是"跨端一致"里**唯一可机检**的那一半：
//   ① **可观测**：emit 收到的事件一条不落进事件账本（含 run_start 与终结事件）；
//   ② **可信**：投递记录随成败变化（succeeded / failed + 失败码），失败结果带 `server/failures.js` 的码；
//   ③ **跨端一致**：渠道不再硬编码模型——用会话里存的 provider/model（或平台默认），而不是写死的那一对；
//   ④ **可控制**：一轮跑起来时，进程内停止入口能真的把这一轮中止，且如实落成 stopped/ABORTED。
//
// 纪律：**不连真库、不调模型**。依赖全部注入（假 db / 假 runAgent / 假账本 / 假投递），与
// `test/headless.test.mjs` 对 `runHeadless` 的做法一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChannelTurn, abortChannelTurn, activeChannelTurns } from '../server/channels/run-turn.js';
import { PREFIX_LEDGER } from '../server/prefix-participants.js';
import { PREFIX_SOURCE } from '../server/prefix-assemble.js';

const CONV = { id: 77, account_id: null, permission: 'read', provider: null, model: null };

/** 假库：只认共享入口真正会发的几条语句（刻意"窄"——它一变宽，夹具就开始自欺）。
 *  `hist` 是**会随写入增长**的消息列表：真库里"INSERT 之后按 id 查历史"必然查得到刚插的那条，
 *  假库要是静态返回，夹具就会在"历史是否含本轮用户消息"这件事上给出假的绿灯。 */
function fakeDb({ conv = CONV, hist = [], setting = null, insertId = 555 } = {}) {
  const sqls = [];
  let nextId = insertId;
  const db = {
    sqls,
    messages: [],
    async query(sql, params = []) {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      // 注意匹配顺序：assistant 落库用的是 `INSERT INTO messages (...) SELECT ... FROM conversations WHERE id=?`
      // —— 它同时命中"INSERT INTO messages"和"FROM conversations WHERE id=?"，先判 INSERT，否则会被当成
      // "取会话"返回列表（夹具自己踩过一次：messageId 恒为 null 却看不出为什么）。
      if (/INSERT INTO messages/.test(sql)) {
        const id = nextId++;
        db.messages.push({ sql, params, id });
        // 真库会写库、后续 SELECT 读得到：假库至少要把角色/正文补进 hist（列顺序：会话、角色、正文…）
        hist.push({ role: params[1], content: params[2] });
        return { insertId: id };
      }
      if (/FROM conversations WHERE id=\?/.test(sql)) return conv ? [conv] : [];
      if (/FROM settings WHERE skey=\?/.test(sql)) return setting === null ? [] : [{ svalue: JSON.stringify(setting) }];
      if (/FROM messages WHERE conversation_id=\?/.test(sql)) return hist.map((m) => ({ role: m.role, content: m.content }));
      if (/UPDATE tool_calls/.test(sql)) return { affectedRows: 1 };
      return [];
    },
  };
  return db;
}

/** 假引擎：记录"被怎么调的"，并可按剧本 emit 事件 / 抛错 */
function fakeRunAgent({ outcome = {}, emitEvents = [], throws = null, onCall = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    for (const e of emitEvents) args.emit(e);
    if (onCall) await onCall(args);
    if (throws) throw throws;
    return {
      content: '（渠道回复）干完了。', toolLog: [], usage: { tokens_in: 10, tokens_out: 3 },
      usageTotals: { cost: 0.01 }, spentYuan: 0.01, finishReason: 'stop', ...outcome,
    };
  };
  fn.calls = calls;
  return fn;
}

/** 假投递：记录 begin/finish 的每一次调用 —— 「可信」面的证据就是这两行 */
function fakeDeliveries() {
  const begun = [];
  const finished = [];
  return {
    begun, finished,
    begin: async (o) => { begun.push(o); return { id: 900 + begun.length, fresh: true }; },
    finish: async (id, o) => { finished.push({ id, ...o }); },
  };
}

const deps = (over = {}) => ({
  db: fakeDb(),
  runAgent: fakeRunAgent(),
  persistEvent: () => true,
  keys: { deepseek: 'k-deepseek' },
  RW_WORKSPACE: 'E:/tmp/ws',
  beginDelivery: fakeDeliveries().begin,
  finishDelivery: fakeDeliveries().finish,
  ensureRun: async () => ({ id: 9001 }),
  markRun: async () => {},
  resumeHint: async () => null,
  now: (() => { let t = 1000; return () => (t += 7); })(),
  ...over,
});

const ledger = () => { const rows = []; const fn = (convId, ev) => { rows.push({ convId, ev }); return true; }; fn.rows = rows; return fn; };
const typesOf = (rows) => rows.map((r) => r.ev.type);

test('① 可观测：emit 收到的引擎事件 + run 边界事件，全部落进事件账本（且都挂在同一个会话上）', async () => {
  const persist = ledger();
  const db = fakeDb();
  const outcome = await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '你好',
    deps: deps({
      db, persistEvent: persist,
      runAgent: fakeRunAgent({ emitEvents: [{ type: 'agent_thinking', round: 1 }, { type: 'tool_start', tool: { name: 'read_file' } }, { type: 'tool_done', tool: { name: 'read_file', status: 'done' } }] }),
    }),
  });

  const types = typesOf(persist.rows);
  // 改前渠道**一条都没有**（不传 emit）；现在引擎事件与 run 边界都在账上
  for (const t of ['run_start', 'agent_thinking', 'tool_start', 'tool_done', 'run_end']) {
    assert.ok(types.includes(t), '账本缺 ' + t + '（改前渠道连 emit 都没传）：' + types.join(','));
  }
  assert.deepEqual(types, ['run_start', 'agent_thinking', 'tool_start', 'tool_done', 'run_end'], '顺序＝发生顺序，账本是可回放的源');
  assert.ok(persist.rows.every((r) => r.convId === 77), '每条事件都要挂在会话上（否则账本无从按会话回放）');
  const start = persist.rows[0].ev;
  assert.equal(start.v, 1, 'run_start 要带协议版本（与 /api/chat 同形状）');
  assert.equal(start.conversationId, 77);
  assert.equal(start.runId, 9001, 'run_start 要带现场 id（断点恢复的锚点）');
  assert.equal(start.channel, 'feishu', 'G5 要分得出"哪一端"——渠道事件必须盖渠道名');
  assert.equal(start.provider, 'deepseek');
  assert.equal(start.model, 'deepseek-v4-flash');
  assert.equal(start.permission, 'read');
  const end = persist.rows.at(-1).ev;
  assert.equal(end.status, 'saved');
  // messageId 必须**指得着库里刚落的那条 assistant**（不是 0/undefined：那种"看着成功、其实没落上"
  // 正是从前渠道的失败模式）。落库列序见 run-turn.js 的 INSERT 形状（model 在 provider 前）。
  const assistantRow = db.messages.find((m) => m.params[1] === 'assistant');
  assert.ok(assistantRow, 'assistant 必须落库');
  assert.ok(assistantRow.id > db.messages[0].id, 'assistant 是后落的那一条（user 先落、id 更小）');
  assert.equal(end.messageId, assistantRow.id, 'run_end.messageId 要指得着这条 assistant');
  assert.equal(end.usage.tokens_in, 10, 'run_end 要带用量（成本可见是 G5 四要素里"可信"的一半）');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.content, '（渠道回复）干完了。');
  assert.equal(outcome.messageId, assistantRow.id);
});

test('① 可观测：assistant 回复落库后才终结（顺序与 /api/chat 一致：先落库、再回执）', async () => {
  const persist = ledger();
  const db = fakeDb();
  await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: '继续',
    deps: deps({ db, persistEvent: persist, runAgent: fakeRunAgent() }),
  });
  const first = db.messages[0];
  assert.deepEqual(first.params.slice(0, 3), [77, 'user', '继续'], '用户消息先落库（引擎随后就挂也要在账上）');
  const assistant = db.messages.find((m) => m.params[1] === 'assistant');
  assert.ok(assistant, 'assistant 必须落库（回复发出去之前先在账上）');
  assert.equal(assistant.params[2], '（渠道回复）干完了。', '落的正文＝真正发出去的那段');
  assert.equal(assistant.params[3], 'deepseek-v4-flash', 'assistant 落库要带模型（历史回看用）');
  assert.equal(assistant.params[4], 'deepseek', 'assistant 落库要带厂商');
  assert.ok(db.sqls.some((s) => /UPDATE tool_calls SET message_id=\?/.test(s)), '本轮工具调用要回填到这条消息');
  // 终结事件在落库之后（账本里 run_end 的 messageId 就是刚落的那个 id）
  const endIdx = persist.rows.findIndex((r) => r.ev.type === 'run_end');
  assert.equal(persist.rows[endIdx].ev.messageId, assistant.id);
});

test('② 可信：成功 → 投递记录 succeeded 且存下接受结果；失败 → failed + failures.js 里登记的码', async () => {
  // 成功
  const okD = fakeDeliveries();
  const okRes = await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '干个活',
    deps: deps({ beginDelivery: okD.begin, finishDelivery: okD.finish, runAgent: fakeRunAgent() }),
  });
  assert.equal(okD.begun.length, 1, '无幂等键也要建投递记录（渠道没有键，但"这一轮跑没跑完"必须留证）');
  assert.deepEqual(okD.begun[0], { accountId: null, conversationId: 77 }, '渠道会话归属账号为 NULL（与建会话时的 findOrCreateConv 同口径）');
  assert.equal(okD.finished.length, 1);
  assert.equal(okD.finished[0].state, 'succeeded');
  assert.ok(okD.finished[0].messageId > 0, '投递记录要带上落库产生的 messageId（回放/对账靠它）');
  assert.equal(okD.finished[0].runId, 9001);
  assert.equal(okD.finished[0].response.content, '（渠道回复）干完了。', '存的是"接受结果"（与 /api/chat 的 response_json 同口径）');
  assert.equal(okRes.error, null);

  // 失败（引擎抛错）
  const badD = fakeDeliveries();
  const badRes = await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: '干个活',
    deps: deps({ beginDelivery: badD.begin, finishDelivery: badD.finish, runAgent: fakeRunAgent({ throws: new Error('模型网关 502') }) }),
  });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, 'error');
  assert.equal(badRes.error.code, 'INTERNAL', '失败码取自 server/failures.js，不是自由中文');
  assert.equal(badRes.error.error, '模型网关 502', '失败原因如实带出来（不吞）');
  assert.equal(badD.finished[0].state, 'failed', '失败必须如实落成 failed（这样人能在死信列表里看到）');
  assert.equal(badD.finished[0].errorCode, 'INTERNAL');
  assert.equal(badD.finished[0].error, '模型网关 502');
});

test('② 可信：失败也要在账本里留下带原因的终结事件（不是"什么都没发生"）', async () => {
  const persist = ledger();
  const res = await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: 'x',
    deps: deps({ persistEvent: persist, runAgent: fakeRunAgent({ throws: new Error('连接超时') }) }),
  });
  const types = typesOf(persist.rows);
  assert.deepEqual(types, ['run_start', 'error', 'run_end']);
  assert.equal(persist.rows[2].ev.status, 'error');
  assert.equal(persist.rows[2].ev.reason, 'exception');
  assert.equal(persist.rows[2].ev.reasonText, '连接超时');
  assert.equal(res.error.code, 'INTERNAL');
});

test('③ 跨端一致：模型取自会话（渠道不硬编码），会话没设才落到平台默认', async () => {
  // 会话里存了 glm / glm-4.5 → 必须用它（改前恒为 deepseek/deepseek-v4-flash）
  const runAgent = fakeRunAgent();
  await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '你好',
    deps: deps({ db: fakeDb({ conv: { ...CONV, provider: 'glm', model: 'glm-4.5' } }), runAgent, keys: { glm: 'k-glm' } }),
  });
  assert.equal(runAgent.calls[0].provider, 'glm');
  assert.equal(runAgent.calls[0].model, 'glm-4.5');
  // 会话没设 → 平台默认（厂商注册表的 defaultModel / settings.default_models），不是渠道自己拍的一对数
  const runAgent2 = fakeRunAgent();
  await runChannelTurn({ channel: 'wechat', conversationId: 77, text: '你好', deps: deps({ runAgent: runAgent2 }) });
  assert.equal(runAgent2.calls[0].provider, 'deepseek');
  assert.equal(runAgent2.calls[0].model, 'deepseek-v4-flash');
  // settings.default_models 覆盖（平台配置的默认可改，渠道跟着走）
  const runAgent3 = fakeRunAgent();
  await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: '你好',
    deps: deps({ db: fakeDb({ setting: { deepseek: 'deepseek-v4-pro' } }), runAgent: runAgent3 }),
  });
  assert.equal(runAgent3.calls[0].model, 'deepseek-v4-pro', 'settings.default_models 要生效（那是平台配置，不是渠道发明的默认）');
  // 会话 provider 没配 Key → 回落平台默认，**不冒充**（与 /api/chat 同口径）
  // 注：用一个**没登记在厂商表里**的 id，只考察"回落 + 出声"这条分支，不掺进真实厂商的 key 配置
  const runAgent4 = fakeRunAgent();
  await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '你好',
    deps: deps({ db: fakeDb({ conv: { ...CONV, provider: 'not-a-real-provider', model: 'x-1' } }), runAgent: runAgent4, keys: {} }),
  });
  assert.equal(runAgent4.calls[0].provider, 'deepseek', '未登记/未配 Key 的厂商不许冒充（回落并出声）');
  assert.equal(runAgent4.calls[0].model, 'deepseek-v4-flash');
});

test('③ 跨端一致：渠道走的就是会话 ctx 与全量工具面（不另造一套上下文）', async () => {
  const runAgent = fakeRunAgent();
  await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '看一眼磁盘',
    deps: deps({ db: fakeDb({ hist: [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复' }] }), runAgent }),
  });
  const call = runAgent.calls[0];
  assert.equal(call.permission, 'read', '权限用会话档位（渠道既有口径）');
  assert.equal(call.ctx.permission, 'read');
  assert.equal(call.ctx.conversationId, 77);
  assert.equal(call.ctx.root, 'E:/tmp/ws', 'read 档的 root 是工作区');
  assert.equal(call.ctx.__light, false, '渠道始终全量工具面（改前也是），本轮不改行为');
  assert.equal(call.ctx.__runId, 9001, '现场 id 注入引擎（checkpoint 与断点恢复靠它）');
  assert.equal(typeof call.emit, 'function', 'emit 必须有——这就是渠道从前缺的那一条');
  assert.ok(call.ctx.__signal, '要有 AbortSignal（"可停"的机制面）');
  // 历史：只追加，不滑窗（v0.3 §4.4.1 规则1）
  const msgs = call.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs.at(-1).content, '看一眼磁盘', '本轮用户消息在最后');
});

test('③ 跨端一致：渠道轮次也落**组装侧跨轮前缀账**（v0.3 §4.4.1 规则5；改前这条路径零覆盖）', async () => {
  const db = fakeDb();
  await runChannelTurn({ channel: 'feishu', conversationId: 77, text: '你好', deps: deps({ db }) });

  const readIdx = db.sqls.findIndex((s) => /^SELECT detail FROM audit_log/.test(s));
  const histIdx = db.sqls.findIndex((s) => /FROM messages WHERE conversation_id=\?/.test(s));
  const userInsertIdx = db.sqls.findIndex((s) => /^INSERT INTO messages/.test(s));
  assert.ok(readIdx > 0, '渠道轮次必须读上一轮的指纹当对照（改前一次都没有——这就是覆盖缺口）');
  assert.ok(histIdx > 0 && histIdx < readIdx, '先拼好历史、再落账（账要对着"这一轮真发出去的那串"）');
  assert.ok(userInsertIdx > 0 && userInsertIdx < readIdx, '用户消息先落库、再算前缀（与 /api/chat 同序）');
  // 落账用的动作名/来源标签与 `/api/chat`、headless **同一份常量**（各写各的字符串 = 静默不计账）
  const inserts = db.sqls.filter((s) => /^INSERT INTO audit_log/.test(s));
  assert.ok(inserts.length >= 1, '至少一行 prefix:assemble');
  assert.equal(PREFIX_LEDGER.ASSEMBLE, 'prefix:assemble');
  assert.equal(PREFIX_SOURCE.CHANNEL, 'channel');
});

test('④ 可控制：跑起来时能中止（进程内停止入口），并如实落成 stopped/ABORTED + 现场 interrupted', async () => {
  const persist = ledger();
  const marks = [];
  const d = fakeDeliveries();
  const db = fakeDb();
  let innerTurns = null;
  const runAgent = fakeRunAgent({
    outcome: { content: '', stopped: true, usage: {} },
    onCall: async () => {
      innerTurns = activeChannelTurns();          // 跑的中途看现场
      assert.equal(abortChannelTurn(77, 'user'), true, '跑着的时候必须能停');
      assert.equal(abortChannelTurn(78), false, '没有在跑的会话 → 返回 false（不算错）');
    },
  });
  const res = await runChannelTurn({
    channel: 'feishu', conversationId: 77, text: '跑个长任务',
    deps: deps({ db, persistEvent: persist, runAgent, beginDelivery: d.begin, finishDelivery: d.finish, markRun: async (id, s, r) => marks.push({ id, s, r }) }),
  });
  assert.deepEqual(innerTurns, [{ conversationId: 77, channel: 'feishu', startedAt: 1007 }], '跑的时候轮次要登记在册（否则无从停）');
  assert.equal(res.ok, false);
  assert.equal(res.status, 'stopped');
  assert.equal(res.error.code, 'ABORTED', '中止的失败码是 ABORTED（failures.js 里已登记的那一条）');
  assert.deepEqual(typesOf(persist.rows), ['run_start', 'stopped', 'run_end']);
  assert.equal(persist.rows[2].ev.status, 'stopped');
  assert.equal(persist.rows[2].ev.reason, 'user');
  assert.deepEqual(marks, [{ id: 9001, s: 'interrupted', r: '用户点击停止' }], '现场要标成 interrupted（这样"继续任务"才有现场可依）');
  assert.equal(d.finished[0].state, 'failed', '中止＝没有可交付结果 → 投递记 failed（与 /api/chat 的 STOPPED_BY_USER 同口径）');
  assert.equal(d.finished[0].errorCode, 'STOPPED_BY_USER');
  assert.equal(db.messages.filter((m) => m.params[1] === 'assistant').length, 0, '中止的轮次不落 assistant（与 /api/chat 的 skipStore 同口径）');
  assert.deepEqual(activeChannelTurns(), [], '跑完必须把登记清掉（否则下一轮会被误停）');
});

test('④ 可控制：停止后同一会话能接着跑（现场保留、账本连续、下一轮照常成功）', async () => {
  const persist = ledger();
  const d = fakeDeliveries();
  // 第一轮被中止
  await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: '长任务',
    deps: deps({ persistEvent: persist, beginDelivery: d.begin, finishDelivery: d.finish, runAgent: fakeRunAgent({ outcome: { content: '', stopped: true, usage: {} } }) }),
  });
  // 第二轮：用户在渠道里说"继续" —— 同一会话、同一份历史照常送进引擎，账本与投递记录接着写。
  // **别把这条读成"断点恢复已经可用"**：本夹具的 markRun 是空的；真正"现场能不能被 resumeHint 读回来"
  // 取决于 agent_runs 的状态（本入口每轮结束时标 completed/interrupted），
  // 只有"服务重启时那一轮正在跑"（interruptStaleOnBoot）才可能留下可恢复现场——这一层如实写在契约文档里。
  const runAgent = fakeRunAgent();
  const res = await runChannelTurn({
    channel: 'wechat', conversationId: 77, text: '继续',
    deps: deps({ persistEvent: persist, beginDelivery: d.begin, finishDelivery: d.finish, runAgent }),
  });
  assert.equal(res.ok, true, '停止不该把会话弄坏（下一轮照常能跑）');
  assert.equal(runAgent.calls[0].messages.at(-1).content, '继续');
  assert.equal(d.finished.length, 2, '两轮各有一条投递记录（一条 failed、一条 succeeded）');
  assert.deepEqual(d.finished.map((x) => x.state), ['failed', 'succeeded']);
  const types = typesOf(persist.rows);
  assert.equal(types.filter((t) => t === 'run_start').length, 2, '两轮各有一个 run_start（run 边界是断线重连判断"我在哪一段"的依据）');
});

test('早失败：会话不存在 → CONV_NOT_FOUND（结构性结果，不抛）', async () => {
  const res = await runChannelTurn({
    channel: 'feishu', conversationId: 404, text: '你好',
    deps: deps({ db: fakeDb({ conv: null }) }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'CONV_NOT_FOUND');
  assert.equal(res.conversationId, 404);
});

test('渠道文件里不再硬编码模型，也不再直调引擎（防回归：跨端一致靠共享入口，不靠自觉）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['feishu-webhook.js', 'wechat.js']) {
    const src = fs.readFileSync(path.join(dir, '..', 'server', 'channels', f), 'utf8');
    // 只看**代码**（去掉注释行）：注释里会引述"改前硬编码了哪一对"，那不是硬编码
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.equal(/deepseek/.test(code), false, f + ' 的代码里不许再出现厂商名（模型要走会话/平台默认）');
    assert.equal(/v4-flash/.test(code), false, f + ' 的代码里不许再出现具体模型名');
    assert.equal(/from '\.\.\/agent\.js'/.test(code), false, f + ' 不许再直调引擎，必须走共享入口');
    assert.equal(/from '\.\.\/deliveries\.js'/.test(code), false, f + ' 投递记录也不许在渠道里自己写');
    assert.ok(/from '\.\/run-turn\.js'/.test(code), f + ' 必须走共享入口 run-turn.js');
    assert.ok(/runChannelTurn\(/.test(code), f + ' 必须调用 runChannelTurn');
  }
});
