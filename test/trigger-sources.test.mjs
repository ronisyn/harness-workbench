// test/trigger-sources.test.mjs - **三档触发源接线**夹具（v0.3 §4.5 编排面，2026-09-16 补）
//
// 背景：`server/triggers.js` 把四档接口定义好了、事件档也接上了事件账本，但**手动/定时/外部调用三档
// 一直没有源**——全仓 import `triggers.js` 的只有 `test/triggers.test.mjs` ⇒ "定义了接口，没有任何东西会 fire"。
// 本夹具锁的是**接线本身**（不是接口契约，接口契约在 `triggers.test.mjs` 里锁着，一条都没动）：
//   ① 三档的源各自真的 fire 到 handler 一次（**机制性断言**：注入假 handler，看它收到什么）；
//   ② handler 抛错 **不打断**主流程 —— 定时档：一轮扫描照常跑完（两个到期任务都发起执行、next_run 都推进）；
//      外部档：被包装的方法照常返回结果；
//   ③ 未知档位**仍然抛错**（既有口径不许放宽）：`fire` 照旧同步抛；源用的 `fireSafely` 只记日志不抛。
// 三处源（file:line 见 `docs/编排与触发器-v1.md` §3）：
//   · 定时＝`server/scheduler.js` 的 `runSchedulerTick`（原 `startScheduler` 的 setInterval 回调体，原样抽出）；
//   · 手动＝`server/scheduler.js` 的 `executeScheduledTask` 里 `__manual` 分支（入口＝`POST /api/tasks/:id/run`）；
//   · 外部＝`server/external-trigger.js` 的 `wrapExternalCalls`（两个适配器脚本各自包一层）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, fire, fireSafely, TRIGGER_KINDS, makeProbeHandler } from '../server/triggers.js';
import { runSchedulerTick, executeScheduledTask } from '../server/scheduler.js';
import { externalCallPayload, wrapExternalCalls } from '../server/external-trigger.js';

const tick = () => new Promise((r) => setTimeout(r, 0)); // handler 是 fire-and-forget：等微/宏任务跑完

/** 安静地收集控制台输出（失败必须出声，但夹具自己不想刷屏）。 */
function captureErrors() {
  const lines = [];
  const real = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = real; }, text: () => lines.join('\n') };
}

/** 假库：按 SQL 里的关键字分派（**不连真库**；语句形状照 `server/scheduler.js` 的既有查询抄）。
 *  `due` 可以是数组，也可以是"每轮现取"的函数（多轮夹具用后者给不同的 task id）。
 *  注意：一轮扫描里"总数"与"到期"是**两条**查询，所以给函数时必须让它**一轮只换一次值**
 *  （同一个 tick 里两次调用要看到同一批任务，否则夹具自己就把读数弄矛盾了）。 */
function fakeSchedulerDb({ due = [] } = {}) {
  const updates = [];
  let round = null;      // 本轮的值（`due` 是函数时按两条查询一组缓存）
  let readsInRound = 0;
  const current = () => {
    if (typeof due !== 'function') return due;
    if (readsInRound % 2 === 0) round = due();
    readsInRound += 1;
    return round;
  };
  const db = {
    updates,
    async query(sql, params) {
      if (/COUNT\(\*\)/.test(sql)) return [{ n: current().length + 3 }];
      if (/next_run IS NULL/.test(sql)) return [];          // 没有缺 next_run 的任务
      if (/next_run <= NOW\(\)/.test(sql)) return current(); // 到期任务
      if (/UPDATE scheduled_tasks SET next_run=\?/.test(sql)) { updates.push(params); return { affectedRows: 1 }; }
      throw new Error('夹具不认这条 SQL：' + sql);
    },
  };
  return db;
}

// ── ① 定时档：一轮真扫描 fire 到 handler（两层各一次，见下）──────────────────────────────────
// 定时档**两层都会投**（都是 `schedule` 档，payload 各带各的事实；`server/triggers.js` 有意不做去重——
// "频率限制/去重窗口一律不设"，需要幂等的使用方自己判）：
//   · 扫描层（`runSchedulerTick`）：发起了哪些任务 + 本轮读数（`due`/`scanned`、推进到的 `next_run`）；
//   · 执行层（`executeScheduledTask`）：这一次执行属于哪个任务与哪个会话（`taskId`/`name`/`conversationId`）。
// 两层都留的理由：执行层在"任务连账号都不存在"时根本走不到（提前 return），那时扫描层是唯一的记录。
test('定时档：扫描层与执行层各投一次 schedule（载荷各带各的事实）', async () => {
  const seen = [];
  const off = register('schedule', makeProbeHandler(seen), { id: 'src-schedule' });
  const db = fakeSchedulerDb({ due: [{ id: 7, name: '每日成本汇总', cron: '0 5 * * *' }] });
  const ran = [];
  try {
    // 执行层那一次由"真执行器"投：`__manual` 不置位 ⇒ schedule 档；它内部前几步查询由拦截器答掉
    // （不碰真库、不进 agent）。扫描层用的是上面的假库（`db` 参数），两者互不干扰。
    await withInterceptedDb(/FROM evo_goal_tasks/, async () => {
      const out = await runSchedulerTick({ db, runner: async (t) => { ran.push(t.id); await executeScheduledTask(t); } });
      await new Promise((r) => setTimeout(r, 20)); // 等执行层那次收尾
      assert.deepEqual(out, { scanned: 4, due: 1, started: 1, failed: 0 }, '本轮读数：看 4 条（3 条不到期 + 1 条到期）、发起 1 条');
    });
    await tick();
    assert.deepEqual(ran, [7], '任务照常被发起执行（触发面不接管主循环）');
    assert.equal(seen.length, 2, '扫描层 + 执行层各一次');
    assert.equal(seen[0].payload.taskId, 7);
    assert.equal(seen[0].payload.name, '每日成本汇总');
    assert.equal(seen[0].meta.source, 'cron', 'meta.source 说明这次触发从哪来（cron）');
    assert.equal(typeof seen[0].payload.nextRun, 'string', '扫描层带上本次推进到的 next_run（可核对）');
    assert.ok(!('prompt' in seen[0].payload), '载荷不带任务正文（只有标识）');
    assert.equal(seen[1].payload.conversationId, 555, '执行层带上这次执行落在哪个会话');
  } finally { off(); }
});

test('定时档：执行层真的发起一轮时也投一次（谁在跑、跑在哪个会话）', async () => {
  const seen = [];
  const off = register('schedule', makeProbeHandler(seen), { id: 'src-schedule-exec' });
  try {
    // 真执行器 + 真库对象（被拦截）：`executeScheduledTask` 的前几步会去查账号/会话/设置，
    // 夹具把它们答掉、并在"执行之前"那一步拦下 ⇒ 不真调模型。
    await withInterceptedDb(/FROM evo_goal_tasks/, async () => {
      await executeScheduledTask({ id: 8, name: '定时跑', account_id: 1, cron: '0 5 * * *', prompt: 'x' });
      await new Promise((r) => setTimeout(r, 20)); // 让它收尾（最后那次 UPDATE 落库）
    });
    await tick();
    assert.equal(seen.length, 1, '执行层投一次');
    assert.equal(seen[0].payload.taskId, 8);
    assert.equal(seen[0].payload.conversationId, 555, '带上这次执行落在哪个会话（排障要它）');
    assert.equal(seen[0].meta.source, 'cron');
  } finally { off(); }
});

test('定时档：连着两轮扫描都能把各自到期的任务跑完（本轮结束后并发计数不留残影）', async () => {
  const seen = [];
  const off = register('schedule', makeProbeHandler(seen), { id: 'src-schedule-two-rounds' });
  const rounds = [[11, 12], [21, 22]];
  const db = fakeSchedulerDb({ due: () => (rounds.shift() || []).map((id) => ({ id, name: 't' + id, cron: '* * * * *' })) });
  const ran = [];
  try {
    const r1 = await runSchedulerTick({ db, runner: async (t) => { ran.push(t.id); } });
    await tick();
    const r2 = await runSchedulerTick({ db, runner: async (t) => { ran.push(t.id); } });
    await tick();
    assert.deepEqual(r1, { scanned: 5, due: 2, started: 2, failed: 0 });
    assert.deepEqual(r2, { scanned: 5, due: 2, started: 2, failed: 0 }, '第二轮照常跑完两个（没被上一轮冻住）');
    assert.deepEqual(ran, [11, 12, 21, 22]);
    assert.equal(seen.length, 4, '四条触发都投出去了');
  } finally { off(); }
});

test('定时档：没有任务到期时一轮扫描不 fire（不制造"每 60s 一次空触发"）', async () => {
  const seen = [];
  const off = register('schedule', makeProbeHandler(seen), { id: 'src-schedule-idle' });
  try {
    const out = await runSchedulerTick({ db: fakeSchedulerDb({ due: [] }), runner: async () => {} });
    await tick();
    assert.equal(out.started, 0);
    assert.equal(seen.length, 0);
  } finally { off(); }
});

// ── ② 手动档：__manual 走 manual 档，定时扫描走 schedule 档（同一个执行器，两档分清）──────────
/**
 * 借**真库对象**的 `query` 做一次现场拦截：`executeScheduledTask` 内部用的是模块级 db 单例
 * （`server/scheduler.js` 里 `import { db }`），夹具够不着它——但 `db` 是个普通对象，
 * 在**本文件的内存（node --test 每个文件一个进程）**里临时换掉 `query`、跑完立刻还原，是最小改动的一种：
 * 不为夹具在生产文件里加"测试专用分支"，也不动 `server/db.js`（那是别人的地盘）。
 *
 * ⚠️ 还原的时机是这里唯一的坑（第一版就栽在这）：扫描一轮会 **fire-and-forget 地起一个真任务**，
 * 那个任务在我们拿到 `runSchedulerTick` 的返回值以后还在跑；如果这时把 `query` 还回真库，
 * 后面那几步就会**打到真库**（更糟的是那次执行会一直挂在那里，把 `schedulerRunning` 吃掉一格 ⇒
 * 后面的用例平白少跑一个任务）。所以还原点必须等"真库里没有仍在飞的调用"——
 * `settle()` 给一段静默期，之后才还回去。
 *
 * 拦截点停在**执行之前**那几步（设置/进化目标都是在 `runAgent` 之前查的）⇒
 * **永远不会走到 `runAgent`**（一次模型都不调，这是硬规则）。
 * @param {RegExp} failOn 命中的 SQL 当场抛错（任务内部自己有 try/catch，会如实记成"执行失败"）
 * @param {() => any} fn 要跑的动作
 * @param {{settleMs?:number}} [opts] `settleMs` 静默期（默认 60ms；期间仍有查询就顺延）
 */
async function withInterceptedDb(failOn, fn, { settleMs = 60 } = {}) {
  const { db } = await import('../server/db.js');
  const real = db.query;
  const seen = [];
  const pending = new Set();
  let restoring = false;
  const restore = () => { if (!restoring) { restoring = true; db.query = real; } };
  /** 静默期：等到"没有在飞的假查询"为止，再把真库还回去（最多等 settleMs×10，如实记在返回值里） */
  const settle = async () => {
    const deadline = Date.now() + settleMs * 10;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, settleMs));
      if (!pending.size) { restore(); return true; }
    }
    restore();
    return false;
  };
  try {
    db.query = async (sql, params) => {
      const p = (async () => {
        seen.push({ sql, params });
        if (failOn.test(sql)) throw new Error('夹具拦截：' + sql);
        if (/SELECT id FROM accounts WHERE id=\?/.test(sql)) return [{ id: 1 }];
        if (/SELECT id FROM conversations WHERE channel="task"/.test(sql)) return [{ id: 555 }];
        if (/SELECT svalue FROM settings/.test(sql)) return [];           // 没有 access_rules：既有分支
        if (/^UPDATE scheduled_tasks/.test(sql)) return { affectedRows: 1 }; // 手动跑一次那两处收尾落库
        if (/^(INSERT|UPDATE) /.test(sql)) return { insertId: 1, affectedRows: 1 };
        throw new Error('夹具不认这条 SQL：' + sql);
      })();
      pending.add(p);
      p.catch(() => {}).finally(() => pending.delete(p)); // 只为计数：不许变成 unhandledRejection
      return p;
    };
    const result = await fn();
    const settled = await settle();
    return { result, seen, settled };
  } finally { restore(); }
}

test('手动档：__manual 的"跑一次"fire 到 manual 档（入口＝POST /api/tasks/:id/run）', async () => {
  const seen = [];
  const off = register('manual', makeProbeHandler(seen), { id: 'src-manual' });
  try {
    // `__manual: true` 正是 `server/index.js:1972` 那一行传的形状（本轮不改 index.js，只接源）。
    // 拦截点选"进化目标"那一步：它就在 `runAgent` **之前**、且源接线点也在它之前 ⇒
    // 手动档的触发真的发生了，而这次执行在调模型之前就被夹具拦下（不真调模型）。
    const { result, seen: sqls } = await withInterceptedDb(/FROM evo_goal_tasks/,
      () => executeScheduledTask({ id: 12, name: '手动补跑', account_id: 1, cron: '0 5 * * *', prompt: 'x', __manual: true }));
    await tick();
    assert.match(result, /^执行失败: /, '夹具只驱动到"执行之前"，之后如实报错（不假装跑完）');
    assert.ok(sqls.some((s) => /SELECT id FROM conversations WHERE channel="task"/.test(s.sql)), '走到了会话复用那一步（在执行之前）');
    // 必须等这次执行**真的收尾**（它最后会 UPDATE scheduled_tasks）再离开本用例，否则它会活到下一个用例里：
    // 下一条用例的 schedule handler 会收到它那一次触发，读数就平白多一条（第一版就栽在这）。
    for (let i = 0; i < 50 && !sqls.some((s) => /UPDATE scheduled_tasks/.test(s.sql)); i++) await tick();
    assert.equal(seen.length, 1, '手动跑一次真的 fire 了一次');
    assert.equal(seen[0].payload.taskId, 12);
    assert.equal(seen[0].meta.source, 'http', '手动档的来源是人经 HTTP 端点点的');
    assert.ok(!('prompt' in seen[0].payload), '载荷不带任务正文');
  } finally { off(); }
});

test('手动档与定时档分得开：同一个执行器，非 __manual 走 schedule 档、不记成手动', async () => {
  const manual = [];
  const sched = [];
  const off1 = register('manual', makeProbeHandler(manual), { id: 'src-manual-2' });
  const off2 = register('schedule', makeProbeHandler(sched), { id: 'src-schedule-2' });
  try {
    // 这里跑的是**真执行器 + 真库对象**（被拦截）：`runSchedulerTick` 是 fire-and-forget 地起任务的，
    // 所以夹具要自己把那次执行 await 干净再断言——不然它会活到下一个用例里（第一版就栽在这）。
    let settled = null;
    await withInterceptedDb(/FROM evo_goal_tasks/, async () => {
      settled = await runSchedulerTick({
        db: fakeSchedulerDb({ due: [{ id: 3, name: '定时跑', cron: '* * * * *' }] }),
        runner: (t) => executeScheduledTask(t), // 真执行器、走的不是 __manual 那条路
      });
      await new Promise((r) => setTimeout(r, 20)); // 等那次执行走到"执行之前"那一步被拦截、收尾
    });
    await tick();
    assert.equal(settled.started, 1, '扫描发起了 1 个任务');
    assert.equal(sched.length, 2, '扫描层 + 执行层各一次，都归 schedule 档');
    assert.equal(manual.length, 0, '它不该被记成"人手动触发的"');
  } finally { off1(); off2(); }
});

// ── ③ 外部档：包装后的方法被调用时 fire 一次，且载荷不带凭据 ────────────────────────────────
test('外部档：wrapExternalCalls 每个方法被调用时 fire 一次，且不改变返回值', async () => {
  const seen = [];
  const off = register('external', makeProbeHandler(seen), { id: 'src-external' });
  try {
    const backend = { 'session.chat': async (args) => ({ ok: true, echo: args.message }) };
    const wrapped = wrapExternalCalls(backend, { source: 'jsonrpc' });
    const r = await wrapped['session.chat']({ message: '你好世界', conversationId: '42', idempotencyKey: 'k-1', password: 'p' });
    await tick();
    assert.deepEqual(r, { ok: true, echo: '你好世界' }, '包装层原样透传返回值（不 await、不改写）');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload.tool, 'session.chat', '载荷记的是**对外的**方法名');
    assert.equal(seen[0].meta.source, 'jsonrpc');
    assert.equal(seen[0].payload.messageLength, 4, '正文只带长度，不带原文');
    assert.equal(seen[0].payload.conversationId, '42');
    assert.equal(seen[0].payload.hasIdempotencyKey, true, '幂等键只带"给没给"');
    assert.equal(seen[0].payload.idempotencyKey, undefined, '幂等键的值不进触发载荷');
    assert.equal(seen[0].payload.password, undefined, '口令字段不进触发载荷');
  } finally { off(); }
});

test('外部档：MCP 侧的键映射成调用方看到的工具名（rw_chat/rw_status/rw_export）', async () => {
  const seen = [];
  const off = register('external', makeProbeHandler(seen), { id: 'src-external-mcp' });
  try {
    const wrapped = wrapExternalCalls(
      { chat: async () => ({ ok: 1 }), status: async () => ({ ok: 2 }), exportSession: async () => ({ ok: 3 }) },
      { source: 'mcp', method: (n) => (n === 'chat' ? 'rw_chat' : n === 'status' ? 'rw_status' : 'rw_export') },
    );
    await wrapped.chat({ message: 'x' });
    await wrapped.status({ conversation_id: '9' });
    await wrapped.exportSession({ conversation_id: '9' });
    await tick();
    assert.deepEqual(seen.map((s) => s.payload.tool), ['rw_chat', 'rw_status', 'rw_export']);
    assert.ok(seen.every((s) => s.meta.source === 'mcp'));
    assert.equal(seen[1].payload.conversation_id, '9', '会话标识原样带出来（排障要它）');
  } finally { off(); }
});

test('外部档载荷白名单：不在清单里的参数一律不进载荷；读不动的参数标 unreadable 而不抛', () => {
  assert.deepEqual(
    externalCallPayload('session.chat', { message: 'hi', conversationId: 3, note: '不该出现', after: 5 }),
    { tool: 'session.chat', messageLength: 2, conversationId: 3, after: 5 },
  );
  const boom = {};
  Object.defineProperty(boom, 'message', { enumerable: true, get() { throw new Error('读不动'); } });
  assert.deepEqual(externalCallPayload('session.chat', boom), { tool: 'session.chat', unreadable: true });
  assert.deepEqual(externalCallPayload('session.chat', ['不是对象']), { tool: 'session.chat', unreadable: true });
});

// ── ④ handler 抛错不许打断主流程（定时档：一轮扫描照常跑完；外部档：方法照常返回）────────────────
test('handler 抛错不打断定时档的一轮扫描：本轮照常收尾（next_run 照推、读数照返回）', async () => {
  const off = register('schedule', () => { throw new Error('编排面 handler 炸了'); }, { id: 'src-schedule-boom' });
  const cap = captureErrors();
  const db = fakeSchedulerDb({ due: [{ id: 11, name: 'a', cron: '* * * * *' }, { id: 12, name: 'b', cron: '* * * * *' }] });
  const ran = [];
  try {
    const out = await runSchedulerTick({ db, runner: async (t) => { ran.push(t.id); } });
    await tick();
    assert.deepEqual(out, { scanned: 5, due: 2, started: 2, failed: 0 }, '一轮扫描照常收尾并返回读数（没有因为 handler 抛错而中断）');
    assert.deepEqual(ran, [11, 12], '两个到期任务都照常发起执行');
    assert.equal(db.updates.length, 2, '两处 next_run 都照常推进（防双跑那一步照旧）');
    assert.match(cap.text(), /\[trigger\] src-schedule-boom（kind=schedule）失败：编排面 handler 炸了/, '失败必须出声');
  } finally { off(); cap.restore(); }
});

test('下一轮扫描不被上一轮那次 handler 抛错冻住：换个正常 handler 照常跑完两个任务', async () => {
  // 这条与上一条分开跑（各自一轮）：上一条那次同步抛会让 `schedulerRunning` 在本轮结束后才回落
  // （真实 handler 走微任务，不会出现这种"卡在 2"的形态——夹具的同步抛把它显式化了）。
  const seen = [];
  const off = register('schedule', makeProbeHandler(seen), { id: 'src-schedule-next-round' });
  const db = fakeSchedulerDb({ due: [{ id: 21, name: 'c', cron: '* * * * *' }, { id: 22, name: 'd', cron: '* * * * *' }] });
  const ran = [];
  try {
    const out = await runSchedulerTick({ db, runner: async (t) => { ran.push(t.id); } });
    await tick();
    assert.deepEqual(out, { scanned: 5, due: 2, started: 2, failed: 0 }, '一轮照常跑完两个到期任务');
    assert.deepEqual(ran, [21, 22]);
    assert.equal(db.updates.length, 2, '两处 next_run 都推进');
    assert.equal(seen.length, 2, '两个任务的 schedule 触发都投出去了');
  } finally { off(); }
});

test('handler 抛错不影响外部档这次调用：被包装的方法照常返回结果', async () => {
  const off = register('external', async () => { await tick(); throw new Error('外部档 handler 炸了'); }, { id: 'src-external-boom' });
  const cap = captureErrors();
  try {
    const wrapped = wrapExternalCalls({ 'session.status': async () => ({ count: 3 }) }, { source: 'jsonrpc' });
    const r = await wrapped['session.status']({ conversationId: '1' });
    await tick(); await tick();
    assert.deepEqual(r, { count: 3 }, '这次调用照常成功——触发面坏一次不许把正常调用变成失败');
    assert.match(cap.text(), /src-external-boom（kind=external）失败：外部档 handler 炸了/);
  } finally { off(); cap.restore(); }
});

test('源接线不改变"业务失败"的口径：被包装的方法抛错照旧原样抛给门面', async () => {
  const seen = [];
  const off = register('external', makeProbeHandler(seen), { id: 'src-external-throw' });
  try {
    const wrapped = wrapExternalCalls({ 'session.chat': async () => { throw new Error('业务失败'); } }, { source: 'jsonrpc' });
    await assert.rejects(() => wrapped['session.chat']({ message: 'x' }), /业务失败/);
    await tick();
    assert.equal(seen.length, 1, '触发照旧发生了：fire 只说明"有人调了这个入口"，不说明这次调用成功');
  } finally { off(); }
});

// ── ⑤ 未知档位仍抛错（既有口径不许放宽：`fire` 照旧同步抛；源用的包装只记日志）──────────────────
test('未知档位仍抛错：fire 同步抛（既有口径），源用的 fireSafely 只记日志不抛', () => {
  // 包装前后两条语义都要断（不许把 fire 那一条改掉）：① `fire` 自己照旧同步抛；
  // ② 源用的 `fireSafely` 只把这次投递吞掉并记一行日志——接线坏一次不许打断主流程。
  assert.throws(() => fire('webhook', {}, {}), /未知的触发器档位：webhook/);
  const cap = captureErrors();
  try {
    const off = register('manual', () => {}, { id: 'src-unknown-probe' });
    try {
      assert.doesNotThrow(() => fireSafely('webhook', {}, {}, (fn) => fn()), '源用的投递口永不抛错（接线坏一次不许打断主循环）');
      assert.match(cap.text(), /\[trigger\] webhook 档投递失败/, '但要出声，别静默');
      assert.equal(TRIGGER_KINDS.includes('webhook'), false, '四档口径一个字没动');
    } finally { off(); }
  } finally { cap.restore(); }
});

// ── ⑥ 与事件档的边界：源只投自己那一档，不串档 ───────────────────────────────────────────
test('三处源只投自己那一档：定时/手动/外部互不串档', async () => {
  const per = { schedule: [], manual: [], external: [], event: [] };
  const offs = [
    register('schedule', makeProbeHandler(per.schedule), { id: 'x-schedule' }),
    register('manual', makeProbeHandler(per.manual), { id: 'x-manual' }),
    register('external', makeProbeHandler(per.external), { id: 'x-external' }),
    register('event', makeProbeHandler(per.event), { id: 'x-event' }),
  ];
  try {
    await runSchedulerTick({ db: fakeSchedulerDb({ due: [{ id: 1, name: 'a', cron: '* * * * *' }] }), runner: async () => {} });
    await wrapExternalCalls({ 'session.status': async () => ({}) }, { source: 'jsonrpc' })['session.status']({});
    await tick();
    assert.deepEqual([per.schedule.length, per.manual.length, per.external.length, per.event.length], [1, 0, 1, 0]);
  } finally { for (const off of offs) off(); }
});
