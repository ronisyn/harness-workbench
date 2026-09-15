// test/prefix-paths.test.mjs - 跨轮前缀账**三条入口都落账**（v0.3 §4.4.1 规则5「失效可数」）
//
// 这条防的是**已登记的覆盖缺口**（`proposals/架构文档冲突登记-20260915.md` 的 C-53 取证那段）：
//   跨轮"只追加/前缀冻结"机检**只挂在 `/api/chat` 上**。实测（`scripts/c1c2-forensics.mjs` 只读复跑，
//   真库 rw_test）：`prefix:assemble` 全表 15 行**全部**是 09-16 04:30 之后的 web 探针会话；
//   headless（`scripts/rw-run.mjs` → 直接调 runAgent）与渠道（`server/channels/run-turn.js`）
//   两条路径**一次都没落过** —— 与已登记的 C-38①（"渠道绕过会话 API"）同源。
//
// 结构（三条路径 = 一个实现，不是三份复制）：
//   ① 共享实现的判据与副作用形状（真库行为用假库观察）；
//   ② **web**（/api/chat 那条路）落账本的行形状/时机**与抽出前逐字节相同**；
//   ③ **headless**（runHeadless，假库 + 假内核，不调模型）跨两轮真的落账，且拿"真发出去的那串"当对照；
//   ④ **渠道**（runChannelTurn 的既有注入缝）同样落账，`src=channel` 分得出来源；
//   ⑤ 三条路径的**常量同源**（动作名/来源标签写错一个字母 = 静默不计账，C4 会假装是 0）。
//
// 纪律：**不连真库、不调模型**（`test/headless.test.mjs`、`test/channel-turn.test.mjs` 同一做法）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPrefixAssemble, prefixLane, PREFIX_SOURCE, PREFIX_ASSEMBLE_ACTION } from '../server/prefix-assemble.js';
import { PREFIX_LEDGER } from '../server/prefix-participants.js';
import { PREFIX_RECORD_ACTION, historyFingerprint } from '../server/history.js';
import { runHeadless } from '../scripts/rw-run.mjs';
import { runChannelTurn } from '../server/channels/run-turn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// ① 共享实现：写账的形状（假库把"执行了哪几条语句、参数是什么"如实记下来）
// ---------------------------------------------------------------------------

/** 只认 `recordPrefixAssemble` 真正会发的那两条语句（刻意窄：宽了夹具就开始自欺） */
function ledgerDb({ prev = null, failOn = null } = {}) {
  const rows = []; // 落进 audit_log 的行
  const sqls = [];
  return {
    rows, sqls,
    async query(sql, params = []) {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      if (failOn && failOn.test(sql)) throw new Error('库抖了');
      if (/^SELECT detail FROM audit_log/.test(sql)) return prev ? [{ detail: prev }] : [];
      if (/^INSERT INTO audit_log/.test(sql)) { rows.push({ action: params[1], detail: params[2], accountId: params[0], shellId: params[3], convId: params[4] }); return { insertId: rows.length }; }
      return [];
    },
  };
}

const H = (...items) => items.map(([role, content]) => ({ role, content }));

test('① 首轮：只落一行 prefix:assemble（首次没有对照，属 C5 的 first-round，不计 C4）', async () => {
  const db = ledgerDb();
  const d = await recordPrefixAssemble({
    db, conversationId: 9, accountId: 3, shellId: null,
    hist: H(['user', '你好']), lane: prefixLane({ model: 'm1' }), source: PREFIX_SOURCE.WEB,
  });
  assert.equal(d.state, 'first');
  assert.equal(d.prevCnt, null, '首轮没有上一轮可对照（日志要能如实说 ?→1，而不是编一个 0）');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].action, 'prefix:assemble');
  assert.equal(db.rows[0].convId, 9, '账要挂在会话上（否则跨轮对照找不到上一行）');
  assert.match(db.rows[0].detail, /^fp=[0-9a-f]{12} cnt=1 peak=1 lane=[0-9a-f]{12}$/, 'detail 是机器可读的固定形状（写与读同一份定义）');
});

test('① 只追加 → append 不记账；变短/换头 → prefix:invalidate（同一实现，两条路径都靠它）', async () => {
  const lane = prefixLane({ model: 'm1' });
  // 上一轮记了 2 条，这一轮尾部追加 1 条
  const prev = 'fp=' + historyFingerprint(H(['user', 'a'], ['assistant', 'b']), 2) + ' cnt=2 peak=2 lane=' + lane;
  const appendDb = ledgerDb({ prev });
  const d1 = await recordPrefixAssemble({ db: appendDb, conversationId: 9, hist: H(['user', 'a'], ['assistant', 'b'], ['user', 'c']), lane, source: PREFIX_SOURCE.WEB });
  assert.equal(d1.state, 'append');
  assert.deepEqual(appendDb.rows.map((r) => r.action), ['prefix:assemble'], '合规轮次**不许**多记一行 —— 多记就是把 C4 口径搞脏');

  // 同一份上一轮记录，这一轮历史被改短（滑窗/截断复活就会长这样）
  const cutDb = ledgerDb({ prev });
  const d2 = await recordPrefixAssemble({ db: cutDb, conversationId: 9, hist: H(['assistant', 'b']), lane, source: PREFIX_SOURCE.HEADLESS });
  assert.equal(d2.state, 'rewrite');
  assert.equal(d2.prevCnt, 2, '日志要能说 cnt 2→1（prevCnt 从读到的那一行直接带出来，不靠反推）');
  assert.deepEqual(cutDb.rows.map((r) => r.action), ['prefix:invalidate', 'prefix:assemble'], '先记 C4 失效、再记本轮指纹（顺序即语义）');
  assert.match(cutDb.rows[0].detail, / rewrite=1 lost=1 src=headless$/, 'C4 行必须带来源（三端混在一张表里，没有 src 就没法归因）');

  // 车道不同 → 跳过比较（换模型/换工具面是 C5 预期失效，已在 agent.js 的 prefix:exempt 记过一次）
  const laneDb = ledgerDb({ prev });
  const d3 = await recordPrefixAssemble({ db: laneDb, conversationId: 9, hist: H(['assistant', 'b']), lane: prefixLane({ model: 'm2' }), source: PREFIX_SOURCE.WEB });
  assert.equal(d3.state, 'skipped-lane');
  assert.deepEqual(laneDb.rows.map((r) => r.action), ['prefix:assemble'], '换车道不记 C4（同一件事数两遍 = 假阳性）');
});

test('① 写不进去**不许吞**：抛出去由调用方按各自口径处置（/api/chat 出声不杀对话、渠道出声不杀本轮）', async () => {
  const db = ledgerDb({ failOn: /^INSERT INTO audit_log/ });
  const e = await recordPrefixAssemble({
    db, conversationId: 9, hist: H(['user', 'x']), lane: prefixLane({ model: 'm1' }), source: PREFIX_SOURCE.HEADLESS,
  }).then(() => null, (err) => err);
  assert.ok(e, '账写不进去必须抛：吞掉就是"账本静默少一行"，正是这一系列缺陷的成因');
  assert.match(e.message, /库抖了/);
});

test('① 常量同源：动作名只能有一处出处（各写各的字符串 ⇒ 错一个字母就静默不计账）', () => {
  assert.equal(PREFIX_ASSEMBLE_ACTION, 'prefix:assemble');
  assert.equal(PREFIX_ASSEMBLE_ACTION, PREFIX_LEDGER.ASSEMBLE);
  assert.equal(PREFIX_ASSEMBLE_ACTION, PREFIX_RECORD_ACTION, 'history.js 的动作名与组装账同源（写/读共用一份定义）');
  assert.equal(new Set(Object.values(PREFIX_SOURCE)).size, 3);
  assert.deepEqual(Object.values(PREFIX_SOURCE).sort(), ['channel', 'headless', 'web']);
});

// ---------------------------------------------------------------------------
// ② web（/api/chat）：行为**逐字节不变** —— 抽出前后落的是同一行、同一个时机
// ---------------------------------------------------------------------------

test('② /api/chat：落账点收进了共享实现，且**时机不变**（light/enabledTools 定型之后、请求发出之前）', () => {
  const src = read('server/index.js');
  assert.ok(src.includes("from './prefix-assemble.js'"), 'index.js 必须调共享实现（不许自己再养一份）');
  assert.match(src, /recordPrefixAssemble\(\{/, 'index.js 要真的调它（只是 import 不算接线）');
  assert.match(src, /source: PREFIX_SOURCE\.WEB/, 'web 的 C4 行要带 src=web（三端混表时可归因）');
  assert.ok(!/INSERT INTO audit_log[\s\S]{0,200}PREFIX_LEDGER\.INVALIDATE/.test(src), 'index.js 不得再自己写 C4 行（两份实现 = 两套口径）');
  const ledger = src.indexOf('await recordPrefixAssemble({');
  const lightLine = src.indexOf('const light = !needsTools(content)');
  const runAgentCall = src.indexOf('runOutcome = await runAgent({');
  assert.ok(ledger > lightLine, 'lane 必须在 light 定型之后才算（否则轻量面翻转会被误判成改写）');
  assert.ok(ledger < runAgentCall, '账必须在请求发给模型**之前**落（否则会把"没发出去的请求"记成账）');
  const catchLine = src.indexOf("console.warn('[prefix-assemble] 指纹落账失败（不影响对话）");
  assert.ok(catchLine > ledger && catchLine - ledger < 900, '/api/chat 既有口径不变：落账失败出声、但**不阻断对话**');
});

// ---------------------------------------------------------------------------
// ③ headless（scripts/rw-run.mjs）：跨两轮**真的落账**，且对照的是"真发出去的那串"
// ---------------------------------------------------------------------------

/** 有状态的假库：消息真会增长（"INSERT 之后查得到"这件事必须真，否则夹具给假绿灯） */
function headlessDb({ conv = { id: 77, permission: 'write', provider: null, model: null, project: 'default' }, messages = [], audit = [] } = {}) {
  const sqls = [];
  let nextId = 1000;
  const db = {
    sqls, messages, audit,
    async query(sql, params = []) {
      const s = String(sql);
      sqls.push(s.replace(/\s+/g, ' ').trim());
      if (/^SELECT \* FROM conversations WHERE id=\?/.test(s)) return [{ ...conv, id: params[0] }];
      if (/SELECT id FROM accounts/.test(s)) return [{ id: 1 }];
      if (/^INSERT INTO conversations/.test(s)) return { insertId: 77 };
      if (/^INSERT INTO messages/.test(s)) {
        const id = nextId++;
        messages.push({ id, role: params[1], content: params[2] });
        return { insertId: id };
      }
      // 真库的 DESC LIMIT 30 语义：夹具必须照做 —— 窗口滑动的改写**正是要靠它才能被看见**
      if (/FROM messages WHERE conversation_id=\? ORDER BY id DESC LIMIT 30/.test(s)) {
        return messages.slice(-30).slice().reverse().map((m) => ({ ...m }));
      }
      if (/FROM settings WHERE skey=\?/.test(s)) return [];
      if (/SELECT COALESCE\(SUM\(cost\)/.test(s)) return [{ c: 0 }];
      if (/^SELECT detail FROM audit_log/.test(s)) return audit.length ? [{ detail: audit.at(-1).detail }] : [];
      if (/^INSERT INTO audit_log/.test(s)) { audit.push({ action: params[1], detail: params[2] }); return { insertId: audit.length }; }
      return [];
    },
  };
  return db;
}

const fakeAgent = () => {
  const calls = [];
  const fn = async (args) => { calls.push(args); return { content: '干完了。', toolLog: [], usage: { tokens_in: 1, tokens_out: 1 }, usageTotals: { cost: 0 }, spentYuan: 0, finishReason: 'stop' }; };
  fn.calls = calls;
  return fn;
};
const hdDeps = (over = {}) => ({
  db: headlessDb(), runAgent: fakeAgent(), keys: {}, config: {},
  RW_WORKSPACE: 'E:/tmp/ws', RW_FS_ROOT: 'E:/',
  ensureRun: async () => ({ id: 9001 }), markRun: async () => {},
  env: {}, now: (() => { let t = 1000; return () => (t += 7); })(),
  ...over,
});

test('③ headless：第一轮落一行 prefix:assemble（改前这条路径**从来没落过**）', async () => {
  const db = headlessDb();
  const runAgent = fakeAgent();
  const { exitCode } = await runHeadless({ ...hdDeps({ db, runAgent }), task: '看一眼磁盘', quiet: true });
  assert.equal(exitCode, 0, '落账不得改变执行结果（headless 照常跑完）');
  const mine = db.audit.filter((r) => r.action === 'prefix:assemble');
  assert.equal(mine.length, 1, 'headless 必须落组装账（这就是本夹具要钉的那条覆盖缺口）');
  assert.match(mine[0].detail, /^fp=[0-9a-f]{12} cnt=1 peak=1 lane=[0-9a-f]{12}$/, '首轮：只有刚落的那条用户消息');
  assert.equal(db.audit.some((r) => r.action === 'prefix:invalidate'), false, '首轮不是非预期失效（不计 C4）');
  // 位置：账落在"用户消息落库之后、引擎开跑之前"（与 /api/chat 同序）
  const idx = db.sqls.findIndex((s) => /^SELECT detail FROM audit_log/.test(s));
  const runIdx = db.sqls.findIndex((s) => /INSERT INTO messages/.test(s) && /reasoning/.test(s));
  assert.ok(idx > 0 && runIdx > idx, '账必须在请求发出之前落（否则会把没发出去的请求记成账）');
  assert.equal(runAgent.calls.length, 1, '夹具走的是假内核（本文件纪律：不真调模型）');
  assert.equal(runAgent.calls[0].messages.at(-1).content, '看一眼磁盘', '落账不得改动送进引擎的消息');
});

test('③ headless：跨轮对照的是**真正拼进请求的那串历史**（窗口滑动 ⇒ 如实记一次 C4）', async () => {
  const messages = [];
  for (let i = 1; i <= 28; i++) messages.push({ id: i, role: i % 2 ? 'user' : 'assistant', content: '第' + i + '条' });
  const db = headlessDb({ messages });
  const deps = { ...hdDeps({ db }), db };
  // 第 1 轮：库里 28 条 + 刚落的本轮用户消息 = 29 条（还没到 30 条窗口线）
  await runHeadless({ ...deps, task: '第一轮', quiet: true });
  const first = db.audit.filter((r) => r.action === 'prefix:assemble');
  assert.equal(first.length, 1);
  assert.match(first[0].detail, / cnt=29 peak=29 /, '对照的条数＝真正拼进去的那串（29 = 28 条旧历史 + 本轮任务）');
  // 第 2 轮：库里 31 条 ⇒ 窗口只取最近 30 条，前缀的**头一条**从 #1 变成 #2
  await runHeadless({ ...deps, task: '第二轮', quiet: true });
  const invalid = db.audit.filter((r) => r.action === 'prefix:invalidate');
  assert.equal(invalid.length, 1, '窗口滑掉第 1 条 = 前缀头部变了 ⇒ C4 非预期失效必须被看见（改前这条路看不见）');
  // 注：这里 lost=0 —— 条数没少（29→30），是**指纹分支**抓到的"同条数换头"。两条分支同属一份判据，不必都命中。
  assert.match(invalid[0].detail, / rewrite=1 lost=0 src=headless$/, 'C4 行要标明来源：三端混在一张表里，没有 src 就没法归因');
  const last = db.audit.filter((r) => r.action === 'prefix:assemble').at(-1);
  assert.match(last.detail, / cnt=30 peak=30 /, '本轮指纹＝窗口那 30 条（峰值只涨不落：会话历史见过的最大条数）');
  assert.equal(db.audit.filter((r) => r.action === 'prefix:assemble').length, 2, '每轮各一行指纹（跨轮对照的对照来源）');
});

test('③ headless：短会话（历史不超窗）**不许**误报 C4（判据没被放宽，也没被弄成惊弓之鸟）', async () => {
  const db = headlessDb({ messages: [{ id: 1, role: 'user', content: '旧消息' }, { id: 2, role: 'assistant', content: '旧回复' }] });
  const deps = { ...hdDeps({ db }), db };
  await runHeadless({ ...deps, task: '第一轮', quiet: true });
  await runHeadless({ ...deps, task: '第二轮', quiet: true });
  await runHeadless({ ...deps, task: '第三轮', quiet: true });
  assert.equal(db.audit.filter((r) => r.action === 'prefix:invalidate').length, 0, '只追加就是合规：三轮都不该记 C4');
  assert.equal(db.audit.filter((r) => r.action === 'prefix:assemble').length, 3, '每一轮都要留下一行指纹（跨轮对照的对照来源）');
});

test('③ headless：跨轮账**不阻断**执行（落账失败只是出声，任务照跑完）', async () => {
  const db = headlessDb();
  const orig = db.query;
  db.query = async (sql, params) => {
    if (/^INSERT INTO audit_log/.test(String(sql))) throw new Error('audit 表锁住了');
    return orig.call(db, sql, params);
  };
  const { exitCode, payload } = await runHeadless({ ...hdDeps({ db }), task: 'x', quiet: true });
  assert.equal(exitCode, 0, '账写不进去不该把一次 headless 执行弄失败（与 /api/chat 的既有权衡一致）');
  assert.equal(payload.status, 'saved');
});

// ---------------------------------------------------------------------------
// ④ 渠道（server/channels/run-turn.js）：用**既有注入缝**证明它也走同一段
// ---------------------------------------------------------------------------

/** 有状态假渠道库：在 `test/channel-turn.test.mjs` 那份之上加了 audit_log 的读/写（唯一的扩展） */
function channelDb({ conv = { id: 77, account_id: null, permission: 'read', provider: null, model: null }, hist = [], audit = [] } = {}) {
  const sqls = [];
  let nextId = 555;
  return {
    sqls, messages: [], audit,
    async query(sql, params = []) {
      const s = String(sql);
      sqls.push(s.replace(/\s+/g, ' ').trim());
      if (/INSERT INTO messages/.test(s)) {
        const id = nextId++;
        hist.push({ role: params[1], content: params[2] });
        return { insertId: id };
      }
      if (/FROM conversations WHERE id=\?/.test(s)) return conv ? [conv] : [];
      if (/FROM settings WHERE skey=\?/.test(s)) return [];
      if (/FROM messages WHERE conversation_id=\?/.test(s)) return hist.map((m) => ({ role: m.role, content: m.content }));
      if (/^SELECT detail FROM audit_log/.test(s)) return audit.length ? [{ detail: audit.at(-1).detail }] : [];
      if (/^INSERT INTO audit_log/.test(s)) { audit.push({ action: params[1], detail: params[2] }); return { insertId: audit.length }; }
      if (/UPDATE tool_calls/.test(s)) return { affectedRows: 1 };
      return [];
    },
  };
}

const chDeps = (over = {}) => ({
  db: channelDb(),
  runAgent: async () => ({ content: '（渠道回复）', toolLog: [], usage: {}, usageTotals: null, spentYuan: 0, finishReason: 'stop' }),
  persistEvent: () => true, keys: { deepseek: 'k' }, RW_WORKSPACE: 'E:/tmp/ws',
  beginDelivery: async () => ({ id: 1 }), finishDelivery: async () => {},
  ensureRun: async () => ({ id: 9001 }), markRun: async () => {}, resumeHint: async () => null,
  ...over,
});

test('④ 渠道：一轮落一行 prefix:assemble（改前这条路径**零覆盖**）', async () => {
  const db = channelDb();
  const res = await runChannelTurn({ channel: 'feishu', conversationId: 77, text: '你好', deps: chDeps({ db }) });
  assert.equal(res.ok, true, '落账不得改变渠道轮次的结果');
  const mine = db.audit.filter((r) => r.action === 'prefix:assemble');
  assert.equal(mine.length, 1, '渠道轮次必须落组装账 —— 这就是 C-38① 那个缺口的正面证据');
  assert.match(mine[0].detail, /^fp=[0-9a-f]{12} cnt=1 peak=1 lane=[0-9a-f]{12}$/, '首轮：只有刚落的那条用户消息');
  assert.equal(db.audit.filter((r) => r.action === 'prefix:invalidate').length, 0);
  // 位置：账在"历史拼好之后、引擎开跑之前"
  const idx = db.sqls.findIndex((s) => /^SELECT detail FROM audit_log/.test(s));
  assert.ok(idx > 0, '账要真的落（只是 import 不算接线）');
});

test('④ 渠道：跨轮改短历史 → prefix:invalidate 且 src=channel 分得出来源', async () => {
  const hist = [];
  const db = channelDb({ hist });
  const deps = { ...chDeps({ db }), db };
  await runChannelTurn({ channel: 'wechat', conversationId: 77, text: '第一句', deps });
  await runChannelTurn({ channel: 'wechat', conversationId: 77, text: '第二句', deps });
  assert.equal(db.audit.filter((r) => r.action === 'prefix:invalidate').length, 0, '只追加：两轮都合规（不误报）');
  assert.equal(hist.length, 4, '两轮各落 user+assistant（下一轮的前缀就该是这 4 条 + 新的一条）');
  // 人为把历史改短（模拟"跨轮把早期消息删掉/换头"这类真实事故），再跑一轮
  hist.length = 0;
  await runChannelTurn({ channel: 'wechat', conversationId: 77, text: '第三句', deps });
  const invalid = db.audit.filter((r) => r.action === 'prefix:invalidate');
  assert.equal(invalid.length, 1, '跨轮历史变短必须被判成改写（同一份判据，不分入口）');
  // lost 相对**峰值**：三轮里见过 3 条（第 2 轮），这一轮只剩 1 条 ⇒ lost=2（拿上一轮当基准会越报越小）
  assert.match(invalid[0].detail, / rewrite=1 lost=2 src=channel$/, '渠道的 C4 行带 src=channel（三端混表时可归因）');
});

test('④ 渠道：账写不进去**不阻断本轮**（出声即可，渠道的回复照发）', async () => {
  const db = channelDb();
  const orig = db.query;
  db.query = async (sql, params) => {
    if (/^INSERT INTO audit_log/.test(String(sql))) throw new Error('audit 表锁住了');
    return orig.call(db, sql, params);
  };
  const res = await runChannelTurn({ channel: 'feishu', conversationId: 77, text: '你好', deps: chDeps({ db }) });
  assert.equal(res.ok, true, '账本写不进去不许把渠道这一轮弄失败（与 /api/chat 同口径）');
});

test('④ 渠道文件头那条纪律没被破坏：run-turn.js **不静态 import** ../agent.js', () => {
  const src = read('server/channels/run-turn.js');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/from '\.\.\/agent\.js'/.test(code), false, '静态 import 引擎会把工具注册表的启动期校验连坐给夹具');
  assert.ok(/await import\('\.\.\/agent\.js'\)/.test(code), '引擎仍走按需动态装载');
  assert.ok(/from '\.\.\/prefix-assemble\.js'/.test(code), '跨轮账走共享模块（它不 import db/agent，静态 import 安全）');
});

// ---------------------------------------------------------------------------
// ⑤ 覆盖清单：谁在落这笔账（新加一条入口就要在这里出现）
// ---------------------------------------------------------------------------

test('⑤ 三条入口都在落账，且都来自**同一份实现**（不是三份复制）', () => {
  const paths = {
    web: 'server/index.js',
    headless: 'scripts/rw-run.mjs',
    channel: 'server/channels/run-turn.js',
  };
  for (const [name, file] of Object.entries(paths)) {
    const src = read(file);
    assert.match(src, /recordPrefixAssemble\(/, file + '（' + name + '）必须调共享落账函数');
    assert.match(src, new RegExp('PREFIX_SOURCE\\.' + name.toUpperCase() + '\\b'), file + ' 必须声明自己的来源标签（否则三端混表没法归因）');
    assert.equal(/formatPrefixRecord\(/.test(src), false, file + ' 不得自己拼账本行（行形状只能有一处出处：server/history.js）');
  }
  // 判据本体也只有一处出处
  for (const [name, file] of Object.entries(paths)) {
    if (name === 'web') continue; // index.js 的既有注释里会提到判据函数名，判据的**调用**在共享模块里
    assert.equal(/detectPrefixRewrite\s*\(/.test(read(file)), false, file + ' 不得自己实现判据（判据只有 server/history.js 一处）');
  }
  for (const file of Object.values(paths)) {
    assert.equal(/const\s+fp\s*=\s*historyFingerprint/.test(read(file)), false, file + ' 不得自己算指纹（指纹只有 server/history.js 一处）');
  }
});
