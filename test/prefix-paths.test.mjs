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
      // 真库语义：全量、按 id 升序（2026-09-16 去窗口之后与 /api/chat 同口径）。
      // 夹具**照抄实现真正发的那条 SQL 形状**：形状一变（比如窗口/截断复活）这里就查不到东西，
      // 前缀会当场塌成"只剩本条任务"，比"静默返回全量"更能让改写暴露出来。
      if (/FROM messages WHERE conversation_id=\? ORDER BY id$/.test(s)) {
        return messages.map((m) => ({ role: m.role, content: m.content }));
      }
      // 旧窗口形状：**故意如实执行**（而不是抛错）——这样"窗口复活"会以**真的改写**的形态出现，
      // 让上面那条"长会话不许落 C4"的行为断言去抓它（抛错只能证明写了那条 SQL，证明不了前缀坏了）
      if (/FROM messages WHERE conversation_id=\? ORDER BY id DESC LIMIT (\d+)/.test(s)) {
        const n = Number(/LIMIT (\d+)/.exec(s)[1]);
        return messages.slice(-n).slice().reverse().map((m) => ({ role: m.role, content: m.content }));
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

// 2026-09-16（v0.3 §4.4.1 规则1「只追加：禁止中途改写早期消息」）：headless 原有的
//   "最近 30 条窗口 + assistant >4000 字符截断"已删除（与 `/api/chat` 09-16 那批 `17c74e9` 同口径）。
//   下面这条**正向**断言的就是"去掉窗口之后长会话不再落 C4"——它是本次改动的机器判据。
test('③ headless：**长会话连续多轮不许落 prefix:invalidate**（去窗口之后前缀只追加）', async () => {
  // 故意造到远超旧窗口线（旧实现 30 条就开滑）：40 条旧历史
  const messages = [];
  for (let i = 1; i <= 40; i++) messages.push({ id: i, role: i % 2 ? 'user' : 'assistant', content: '第' + i + '条' });
  const db = headlessDb({ messages });
  const runAgent = fakeAgent();
  const deps = { ...hdDeps({ db, runAgent }), db };
  await runHeadless({ ...deps, task: '第一轮', quiet: true });
  await runHeadless({ ...deps, task: '第二轮', quiet: true });
  await runHeadless({ ...deps, task: '第三轮', quiet: true });

  assert.equal(db.audit.filter((r) => r.action === 'prefix:invalidate').length, 0,
    '只追加就是合规：跨过旧窗口线之后连续三轮**一条 C4 都不许有**（窗口一回来这里必然红）');
  const rows = db.audit.filter((r) => r.action === 'prefix:assemble');
  assert.equal(rows.length, 3, '每轮各一行指纹（跨轮对照的对照来源）');
  // 条数逐轮 +2（本轮任务 + 上一轮回复）：41 → 43 → 45 —— 只增不减，正是"只追加"的形状
  assert.match(rows[0].detail, / cnt=41 peak=41 /, '第 1 轮＝40 条旧历史 + 本轮任务');
  assert.match(rows[1].detail, / cnt=43 peak=43 /, '第 2 轮＝41 + 上一轮回复 + 本轮任务（全量，不滑窗）');
  assert.match(rows[2].detail, / cnt=45 peak=45 /, '第 3 轮同理：前缀只会变长，不会换头');
  // 账与请求同源：真送出去的就是那 45 条（头 40 条旧历史**逐字还在最前面**）
  assert.equal(runAgent.calls.length, 3);
  assert.equal(runAgent.calls[2].messages.length, 45, '送进引擎的确实是全量历史（旧窗口实现这里只会是 30）');
  assert.equal(runAgent.calls[2].messages[0].content, '第1条', '最老的那条历史仍在前缀最前（窗口若复活，这里会变成"第3条"）');
});

test('③ headless：跨轮对照的是**真正拼进请求的那串历史**（真的改写了才落 C4，不再靠窗口造样本）', async () => {
  const messages = [];
  for (let i = 1; i <= 28; i++) messages.push({ id: i, role: i % 2 ? 'user' : 'assistant', content: '第' + i + '条' });
  const db = headlessDb({ messages });
  const runAgent = fakeAgent();
  const deps = { ...hdDeps({ db, runAgent }), db };
  await runHeadless({ ...deps, task: '第一轮', quiet: true });
  const first = db.audit.filter((r) => r.action === 'prefix:assemble');
  assert.equal(first.length, 1);
  assert.match(first[0].detail, / cnt=29 peak=29 /, '对照的条数＝真正拼进去的那串（29 = 28 条旧历史 + 本轮任务）');
  assert.equal(runAgent.calls[0].messages.length, 29, '送进引擎的确实是那 29 条（账与请求同源）');
  // 真改写：把库里早期消息**真的删掉**（事故形状；窗口已不是改写源了）
  db.messages.splice(0, 10);
  await runHeadless({ ...deps, task: '第二轮', quiet: true });
  const invalid = db.audit.filter((r) => r.action === 'prefix:invalidate');
  assert.equal(invalid.length, 1, '真的改写了历史 ⇒ C4 非预期失效必须被看见（判据没有被放宽）');
  assert.match(invalid[0].detail, / rewrite=1 lost=8 src=headless$/, 'C4 行要标明来源，并如实报出少了多少条（29 峰值 − 21 本轮 = 8）');
  const last = db.audit.filter((r) => r.action === 'prefix:assemble').at(-1);
  assert.match(last.detail, / cnt=21 peak=29 /, '这一轮只剩 21 条、峰值 29（lost 相对峰值，不相对上一轮）');
  assert.equal(db.audit.filter((r) => r.action === 'prefix:assemble').length, 2, '每轮各一行指纹');
});

test('③ headless：长 assistant 历史**原样进请求**（截断一回来 ⇒ 前缀中段被换 ⇒ 必须落 C4）', async () => {
  // 4600 字符的 assistant 历史（超过旧实现 4000 字符的截断线）
  const long = '原'.repeat(4600);
  const messages = [
    { id: 1, role: 'user', content: '请给我一段长文' },
    { id: 2, role: 'assistant', content: long },
  ];
  const db = headlessDb({ messages });
  const runAgent = fakeAgent();
  const deps = { ...hdDeps({ db, runAgent }), db };
  await runHeadless({ ...deps, task: '第一轮', quiet: true });
  await runHeadless({ ...deps, task: '第二轮', quiet: true });
  assert.equal(runAgent.calls[1].messages[1].content, long,
    '历史里的长文必须**一字不改**进请求（旧实现这里会变成"头 2400 + 标记 + 尾 1600"）');
  assert.equal(db.audit.filter((r) => r.action === 'prefix:invalidate').length, 0,
    '原样重放长文就是只追加：不许落 C4（截断一回来，下面这条与上面那条会一起红）');
});

test('③ headless：源码里不许再有"窗口/截断"的形状（静态反向锁：行为夹具之外再钉一道）', () => {
  const src = read('scripts/rw-run.mjs');
  assert.ok(!/ORDER BY id DESC LIMIT \d+/.test(src), '历史不得按 DESC/LIMIT 读（v0.3 §4.4.1 规则1：滑窗＝每轮改写前缀）');
  assert.ok(!/历史消息过长已截断/.test(src), '不得再贴回截断标记（把历史中段换成另一串字节，同样不是只追加）');
  assert.ok(!/\.slice\(0,\s*2400\)/.test(src), '旧截断实现（头 2400 + 尾 1600）不得复活');
  assert.ok(/FROM messages WHERE conversation_id=\? ORDER BY id'/.test(src), '必须按 id 升序读**全量**历史（与 server/index.js 同口径）');
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
