// test/livefeed.test.mjs —— RA-37 G5「断线重连不丢现场」的客户端那一半（裁定 B 落地）
//
// 这一条夹具要回答的是**可证伪的三件事**（浏览器没有 DOM 测试面，所以这里只打传输层与重建器）：
//   ① POST 流没收段就断了 ⇒ 客户端会带 `Last-Event-ID` **续订**（不是重发一遍问题）；
//   ② 续订开播帧若如实说 `gap:true`（环已回收）⇒ **回落**（回调 onReload），且那半截不连续的事件
//      **不许**接到本地视图上（接上去正文就是错的，而且错得看不出来）；
//   ③ 活的这条路径确实用的是 `src/eventstream.js` 那个重建器（同一批帧，活路径与 rebuild() 逐字一致）。
//
// 手法：把 `fetch` 换成"按 URL 分派的假服务端"（真 SSE 文本 → Response.body），把 localStorage 换成内存桩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuild } from '../src/eventstream.js';
import { streamChat } from '../src/api.js';

const sse = (frames) => frames.map((f) => (f.id ? `id: ${f.id}\n` : '') + 'data: ' + JSON.stringify(f.ev) + '\n\n').join('');

function stubEnv(routes) {
  const calls = [];
  globalThis.localStorage = { getItem: () => 'tok-test', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, body: opts.body });
    const r = routes.find((x) => url.startsWith(x.url));
    if (!r) throw new Error('假服务端没有这条路由：' + url);
    const text = typeof r.body === 'function' ? r.body(calls) : r.body;
    if (text === null) return new Response('{"message":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return calls;
}
const POST_HEAD = [
  { id: 1, ev: { type: 'run_start', v: 1, runId: 7, conversationId: 42, model: 'm' } },
  { id: 2, ev: { type: 'delta', v: 1, delta: '你' } },
];
const HELLO = (gap) => ({ id: 3, ev: { type: 'stream_hello', v: 1, conversationId: 42, after: 2, gap, earliestSeq: gap ? null : 3, buffered: gap ? 0 : 5 } });
const TAIL = [{ id: 4, ev: { type: 'delta', v: 1, delta: '好' } }, { id: 5, ev: { type: 'run_end', v: 1, status: 'saved', messageId: 99, contentLength: 2 } }];

test('断线续订：带 Last-Event-ID 接着要，视图与 rebuild() 逐字一致（真的用了重建器）', async () => {
  const calls = stubEnv([
    { url: '/api/chat', body: sse(POST_HEAD) },                       // 没收段就断了（没有 run_end）
    { url: '/api/conversations/42/stream', body: sse([HELLO(false), ...TAIL]) },
  ]);
  const deltas = []; let reloads = 0; const errors = [];
  const view = await streamChat({ conversationId: 42, content: '问题' }, {
    onDelta: (d) => deltas.push(d), onReload: () => { reloads++; }, onError: (m) => errors.push(m),
  });
  assert.equal(calls.length, 2, '共两次请求：POST /api/chat + 一次续订');
  assert.equal(calls[1].headers['Last-Event-ID'], '2', '续订带的是"最后见过的序号"（视图游标）');
  assert.deepEqual(deltas, ['你', '好'], '续订接上的那一段也要按顺序交给界面');
  assert.equal(reloads, 0, 'gap:false ＝ 中间没漏 ⇒ 不回落 /messages');
  assert.deepEqual(errors, []);
  assert.equal(view.answer, '你好');
  assert.equal(view.messageId, 99, '收段回执来自续订那一段');
  // ③ 同源：活路径的重建结果与"把同一批帧喂给重建器"逐字一致
  const offline = rebuild([...POST_HEAD, HELLO(false), ...TAIL].map((f) => ({ ...f.ev, _seq: f.id })));
  assert.equal(view.answer, offline.answer, '活路径与 rebuild() 必须给出同一个答案');
  assert.equal(view.contentLength, offline.contentLength);
});

test('gap:true ⇒ 回落 /messages（onReload 恰好一次），且不连续的那半截不许接进视图', async () => {
  const calls = stubEnv([
    { url: '/api/chat', body: sse(POST_HEAD) },
    { url: '/api/conversations/42/stream', body: sse([HELLO(true), ...TAIL]) },
  ]);
  const deltas = []; let reloads = 0; const errors = [];
  const view = await streamChat({ conversationId: 42, content: '问题' }, {
    onDelta: (d) => deltas.push(d), onReload: () => { reloads++; }, onError: (m) => errors.push(m),
  });
  assert.equal(calls.length, 2);
  assert.equal(reloads, 1, '恰好一次回落（界面自己去拉 /messages 全量）');
  assert.deepEqual(deltas, ['你'], 'gap 之后的事件一律不接：接上去正文会错得看不出来');
  assert.equal(view.answer, '你');
  assert.equal(view.hello.gap, true, '开播帧的"接丢了"这个事实要留在视图里（可观测）');
  assert.deepEqual(errors, [], '这不是错误路径，是如实回落');
});

test('收段正常时**不**续订（不多发一个请求）', async () => {
  const calls = stubEnv([{ url: '/api/chat', body: sse([...POST_HEAD, ...TAIL]) }]);
  let reloads = 0;
  const view = await streamChat({ conversationId: 42, content: '问题' }, { onReload: () => { reloads++; } });
  assert.equal(calls.length, 1, '正常结束只有一个请求');
  assert.equal(view.answer, '你好');
  assert.equal(reloads, 0);
});

test('续订本身也接不上（HTTP 500）⇒ 如实报错，不静默', async () => {
  stubEnv([
    { url: '/api/chat', body: sse(POST_HEAD) },
    { url: '/api/conversations/42/stream', body: null },
  ]);
  await assert.rejects(() => streamChat({ conversationId: 42, content: '问题' }, {}), /续订失败（HTTP 500）/);
});
