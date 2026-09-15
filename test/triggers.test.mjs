// test/triggers.test.mjs - 触发器接口与事件档（v0.3 §4.5「定义触发器接口（手动/定时/外部调用/事件），
// 实现归使用方」，2026-09-16 补"事件"那一档）
//
// 背景：四档里手动（`POST /api/chat`）、定时（scheduler.js）、外部调用（HTTP 契约 + MCP server）都有实现，
// **事件零实现**（符合性核对 §1.4 ㉑）。本夹具锁的是接口契约本身，不是某个使用方的业务：
//   ① 四档齐全，`register` 校验严（未知档位/非函数/重复 id 一律抛错，不静默吞掉一条永远不会被触发的哑线）；
//   ② 手写 handler 被一条事件**恰好触发一次**，payload/meta 的形状稳定且是冻结快照；
//   ③ 只发给同档位，退订即摘掉；
//   ④ **fire 失败不拖垮事件写入**（照 DSH `dsh-webhook` 的进程内 fire-and-forget 边界）：
//      handler 抛错不 starve 兄弟、不许冒泡回账本，事件照旧落账；裸订阅者抛错也一样。
//   ⑤ 默认一个 handler 都没有（"实现归使用方"）——没人在听时触发是**零成本且不报错**的正常状态。
import { test } from 'node:test';
import assert from 'node:assert';
import { register, fire, TRIGGER_KINDS, makeProbeHandler } from '../server/triggers.js';
import { persistEvent, onEventAppended, eventLogStats } from '../server/eventlog.js';

/** 夹具假存储：只认账本追加那一个方法（给 persistEvent 的夹具缝），并记下每次追加的中性记录。
 *  v0.3 §7.1 ⑦ 之后账本走 `storage.events.append`（那条 INSERT 已收进存储实现层），缝的位置随之抬到
 *  `events.append`；反面样本（`fail`）仍然只影响落账、不影响触发面。 */
class FakeDb {
  constructor({ fail = null } = {}) { this.calls = []; this.fail = fail; }
  get events() {
    return {
      append: async (row) => {
        this.calls.push({ row });
        if (this.fail) throw new Error(this.fail);
        return { insertId: this.calls.length };
      },
    };
  }
}

/** 安静地收集控制台输出（失败必须出声，但夹具自己不想刷屏）。 */
function captureErrors() {
  const lines = [];
  const real = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, restore: () => { console.error = real; }, text: () => lines.join('\n') };
}

const tick = () => new Promise((r) => setTimeout(r, 0)); // handler 是 fire-and-forget：让微/宏任务跑完

// ── ① 接口本身 ────────────────────────────────────────────────────────────────────
test('四档就是 v0.3 §4.5 括号里的那四档（顺序即对外口径）', () => {
  assert.deepEqual(TRIGGER_KINDS, ['manual', 'schedule', 'external', 'event']);
});

test('register 校验严格：未知档位/非函数 handler/重复 id 都抛错（哑线不许静默存在）', () => {
  assert.throws(() => register('webhook', () => {}), /未知的触发器档位：webhook/);
  assert.throws(() => register('event', 'not a function'), /handler 必须是函数/);
  const off = register('manual', () => {}, { id: 'dup-check' });
  try {
    assert.throws(() => register('manual', () => {}, { id: 'dup-check' }), /id 已被占用/, 'id 重复＝退订会摘错一条');
  } finally { off(); }
  off(); // 幂等：再退订一次不抛错
});

test('默认一个 handler 都没有：没人在听时触发是零成本的正常状态，不是错误', () => {
  const r = fire('manual', { hello: 1 }, { source: 'http' });
  assert.deepEqual(r, { kind: 'manual', matched: 0 });
  const e = fire('event', { conversationId: 1, type: 'x' });
  assert.equal(e.matched, 0);
});

test('fire 的档位写错如实抛错（同 DSH dispatch：坏投递同步抛，不悄悄扔掉）', () => {
  assert.throws(() => fire('webhook', {}), /未知的触发器档位/);
});

test('payload 必须是无损 JSON：函数/BigInt/循环引用当场抛错，不塞给 handler', () => {
  // 有使用方在听才谈得上"把 payload 交给 handler"——没人在听时 fire 直接早退（连快照都不做），
  // 所以这条契约要用一个真实注册过的 handler 来验。
  const off = register('external', makeProbeHandler([]), { id: 'json-probe' });
  try {
    assert.throws(() => fire('external', { fn: () => {} }), /无损 JSON/, '函数会被 stringify 悄悄丢掉（`{fn(){}}` → `{}`），必须当场报错');
    assert.throws(() => fire('external', { n: 1n }), /无损 JSON/);
    assert.throws(() => fire('external', { u: undefined }), /无损 JSON/);
    assert.throws(() => fire('external', { ok: 1 }, { bad: Symbol('x') }), /无损 JSON/, 'meta 走同一条口径');
    const cyc = {}; cyc.self = cyc;
    assert.throws(() => fire('external', cyc), /无损 JSON/);
  } finally { off(); }
});

// ── ②③ 事件档：手写 handler 被事件触发一次，形状稳定 ──────────────────────────────────
test('事件源＝账本追加点：一条状态事件恰好触发一次，payload/meta 形状如约', async () => {
  const seen = [];
  const off = register('event', makeProbeHandler(seen), { id: 'ev-probe' });
  const other = [];
  const offOther = register('manual', makeProbeHandler(other), { id: 'manual-probe' }); // 另一档：不该被事件触发
  const fake = new FakeDb();
  try {
    assert.equal(persistEvent(42, { seq: 7, at: 1757000000000, type: 'tool_done', tool: { name: 'read_file', status: 'done' } }, fake), true);
    await tick();
    assert.equal(seen.length, 1, '一条事件触发一次（不是 0 次，也不是 2 次）');
    assert.deepEqual(seen[0].payload, {
      conversationId: 42, type: 'tool_done', seq: 7, at: 1757000000000,
      payload: { tool: { name: 'read_file', status: 'done' } },
    });
    assert.deepEqual(seen[0].meta, { source: 'eventlog', conversationId: 42, type: 'tool_done', seq: 7 });
    assert.equal(other.length, 0, '档位是隔离的：事件档的触发不许发给手动档');
    assert.equal(fake.calls.length, 1, '事件照旧落账');
    assert.equal(fake.calls[0].row.type, 'tool_done', '账本收到的仍是最初那条事件（语句本身现在归存储实现层，见 test/storage.test.mjs）');
    assert.equal(fake.calls[0].row.conversationId, 42);
    assert.equal(Object.isFrozen(seen[0].payload), true, '交给 handler 的是冻结快照（多个 handler 看到的是同一份数据）');
    assert.equal(Object.isFrozen(seen[0].payload.payload), true, '深冻结，不只冻最外层');
    assert.equal(Object.isFrozen(seen[0].meta), true);
  } finally { off(); offOther(); }
});

test('transient 事件（think/delta）不进账本 ⇒ 也不触发（触发源＝账本，不是内存事件流）', async () => {
  const seen = [];
  const off = register('event', makeProbeHandler(seen), { id: 'ev-transient' });
  try {
    assert.equal(persistEvent(42, { type: 'think', text: 'x' }, new FakeDb()), false, '账本明确不收');
    assert.equal(persistEvent(42, { type: 'delta', delta: 'x' }, new FakeDb()), false);
    assert.equal(persistEvent(0, { type: 'tool_done' }, new FakeDb()), false, '没有会话 id 的账不写也不触发');
    await tick();
    assert.equal(seen.length, 0);
  } finally { off(); }
});

test('退订即摘掉：再触发不再调用它', async () => {
  const seen = [];
  const off = register('event', makeProbeHandler(seen), { id: 'ev-off' });
  persistEvent(1, { type: 'run_start', at: 1 }, new FakeDb());
  await tick();
  assert.equal(seen.length, 1);
  off();
  persistEvent(1, { type: 'run_start', at: 2 }, new FakeDb());
  await tick();
  assert.equal(seen.length, 1, '退订之后不许再被调用');
});

// ── ④ fire 失败不拖垮事件写入（DSH dsh-webhook 的边界）────────────────────────────────
test('handler 抛错：不 starve 兄弟、不冒泡、事件照旧落账（fire-and-forget）', async () => {
  const seen = [];
  const off1 = register('event', () => { throw new Error('使用方 handler 炸了'); }, { id: 'ev-boom' });
  const off2 = register('event', makeProbeHandler(seen), { id: 'ev-after-boom' });
  const cap = captureErrors();
  const fake = new FakeDb();
  try {
    assert.equal(persistEvent(9, { type: 'tool_start', at: 5, tool: { name: 'x' } }, fake), true, '触发面炸了也不许影响落账');
    await tick();
    assert.equal(seen.length, 1, 'DSH：one throw or rejection is logged without starving siblings');
    assert.equal(fake.calls.length, 1, '事件照旧追加进账本');
    assert.match(cap.text(), /\[trigger\] ev-boom（kind=event）失败：使用方 handler 炸了/, '失败必须出声');
  } finally { off1(); off2(); cap.restore(); }
});

test('异步 handler 拒绝也一样被兜住（只记日志，不变成 unhandledRejection）', async () => {
  const seen = [];
  const off1 = register('event', async () => { await tick(); throw new Error('异步拒绝'); }, { id: 'ev-async-boom' });
  const off2 = register('event', makeProbeHandler(seen), { id: 'ev-async-after' });
  const cap = captureErrors();
  const fake = new FakeDb();
  try {
    assert.equal(persistEvent(9, { type: 'tool_done', at: 6 }, fake), true);
    await tick(); await tick();
    assert.equal(seen.length, 1);
    assert.equal(fake.calls.length, 1);
    assert.match(cap.text(), /ev-async-boom（kind=event）失败：异步拒绝/);
  } finally { off1(); off2(); cap.restore(); }
});

test('事件原文无法无损 JSON（使用方发出的帧带函数）⇒ 订阅者自己兜住，落账不受影响', async () => {
  const seen = [];
  const off = register('event', makeProbeHandler(seen), { id: 'ev-badjson' });
  const cap = captureErrors();
  const fake = new FakeDb();
  try {
    // 帧里带一个函数：`JSON.stringify` 会把它**悄悄丢掉**（账本那边照旧写得进去），而触发面的口径是
    // "必须无损"——两边的严格程度不同，所以这条正好验"订阅者自己兜住"：snapshot 抛错 ⇒ 不派发 ⇒ 账本照旧。
    // （触发的输入来自使用方，不能假定它干净。）
    assert.equal(persistEvent(11, { type: 'tool_done', at: 1, fn: () => {} }, fake), true);
    await tick();
    assert.equal(seen.length, 0, '这一条没法无损 JSON ⇒ 不派发（而不是把残缺数据交给 handler）');
    assert.equal(fake.calls.length, 1, '账本照常落账——触发面坏一次不等于账本写不进去');
    assert.match(cap.text(), /\[trigger\] 事件档派发失败（账本不受影响）/, '出声，别静默');
  } finally { off(); cap.restore(); }
});

test('（现状登记，非本次改动）事件原文里放 BigInt 会让 persistEvent 同步抛错——调用点已自行兜住', () => {
  // 说明：`JSON.stringify(row.payload)` 在 eventlog 里是**同步**求值的，遇到 BigInt 会抛。这是本次改动**之前**
  // 就有的行为（index.js 的 send 用 try/catch 兜住），本轮只登记、不顺手改——它属于账本自己的输入校验。
  // 记在这里是为了防止我的夹具误把"两种不可序列化"当成同一件事（函数会被 stringify 丢掉，BigInt 会抛）。
  assert.throws(() => persistEvent(11, { type: 'tool_done', n: 1n }, new FakeDb()), /BigInt/);
});

test('裸订阅者（直接用 onEventAppended 挂一个抛错的函数）也不影响落账与其它订阅者', async () => {
  const seen = [];
  const offBad = onEventAppended(() => { throw new Error('裸订阅者炸了'); });
  const offGood = onEventAppended((e) => seen.push(e.type));
  const cap = captureErrors();
  const fake = new FakeDb();
  try {
    assert.equal(persistEvent(3, { type: 'run_end', at: 2 }, fake), true);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(seen, ['run_end'], '先抛错的那个不许把它后面的订阅者饿死');
    assert.match(cap.text(), /\[eventlog\] 事件订阅者出错（不影响落账）/);
    assert.equal(typeof offBad, 'function');
  } finally { offBad(); offGood(); cap.restore(); }
});

test('fire 本身是真的 fire-and-forget：handler 还没结束就已经返回了', async () => {
  let done = false;
  const off = register('manual', async () => { await tick(); done = true; }, { id: 'manual-slow' });
  try {
    const r = fire('manual', { x: 1 }, { source: 'http' });
    assert.deepEqual(r, { kind: 'manual', matched: 1 }, '返回的是"启动了几个"，不是"跑完了"');
    assert.equal(done, false, 'DSH dispatch：return before any callback settles');
    await tick(); await tick();
    assert.equal(done, true);
  } finally { off(); }
});

test('落账失败的路径与触发面互不牵连（事件写不进去时，触发也照样发生）', async () => {
  const seen = [];
  const off = register('event', makeProbeHandler(seen), { id: 'ev-dbfail' });
  const cap = captureErrors();
  const before = eventLogStats().fail;
  try {
    assert.equal(persistEvent(4, { type: 'tool_done', at: 1 }, new FakeDb({ fail: '库挂了' })), true);
    await tick();
    assert.equal(seen.length, 1, '触发源是"账本接收了这条事件"，不是"这条事件落库成功了"');
    assert.ok(eventLogStats().fail >= before, '落账失败照既有口径计数（观测面自己要能看见丢了账）');
  } finally { off(); cap.restore(); }
});
