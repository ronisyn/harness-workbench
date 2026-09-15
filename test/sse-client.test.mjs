// test/sse-client.test.mjs - 外部适配器共用的 SSE 读流器（v0.3 §0.5「不留两套」+ 一个真缺陷的回归锁）
//
// 缺陷（2026-09-16 实测，由 ⑳ JSON-RPC 的核对撞出来，MCP 适配器也踩过同一个坑）：
// 在循环体内读完 `run_end` 就 `ac.abort()` ⇒ `for await` 的 `next()` **当场以 AbortError 拒绝** ⇒
// 自己的 catch 把"流已跑完"归成**超时**（`status:'timeout'`、`runId:null`），而内容靠回读落库兜住 ⇒ 肉眼看不见。
// 本夹具用**合成流**把这条路钉死：正常收尾绝不许被当成超时。
//
// 写夹具时踩过的三个坑（留档，免得下一个人重犯）：① chunk 必须是**字节**（把 Buffer 转成 latin1 字符串再
// `Buffer.from(..,'utf8')` 会二次编码成乱码）；② `done` 与 `run_end` 在真实服务端是**同一个 tick 连着发**的，
// 拆成两个 chunk 会让"读到 done 就收尾"的读法先跳出（那是正确行为，不是 bug）；③ 模拟超时要让迭代器
// **以 AbortError 拒绝**，而不是只 abort controller（读流器只依赖前者，signal 是给 fetch 用的）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from '../server/sse-client.js';

const frame = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const B = (s) => Buffer.from(s, 'utf8');

function makeBody(chunks, { abortAtChunk = null } = {}) {
  const ac = new AbortController();
  const abortErr = () => { ac.abort(); const e = new Error('The operation was aborted'); e.name = 'AbortError'; return e; };
  return {
    ac,
    stream: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < chunks.length; i++) {
          if (abortAtChunk !== null && i >= abortAtChunk) throw abortErr(); // 中途超时
          yield chunks[i];
        }
        // 尾部分支：块喂完了、**本轮还没结束**就被中止（真实的超时几乎都长这样——
        // 写完这一条才让 abortAtChunk 在"只有一个 chunk"时也生效；第一版夹具漏了它，于是那条用例永远走不到超时路径）
        if (abortAtChunk !== null) throw abortErr();
      },
    },
  };
}

test('正常收尾：内容/run_end/done 都对，且**绝不许**被当成超时', async () => {
  // done 与 run_end 同 chunk（真实服务端就是这么连发的）
  const { stream } = makeBody([
    B(frame({ type: 'intent' })),
    B(frame({ type: 'delta', delta: '你' })),
    B(frame({ type: 'delta', delta: '好' })),
    B(frame({ type: 'done', messageId: 9, usage: { tokens_in: 5 } }) + frame({ type: 'run_end', v: 1, status: 'saved', runId: 7, messageId: 9 })),
  ]);
  const r = await readChatStream(stream);
  assert.equal(r.content, '你好');
  assert.equal(r.runEnd.status, 'saved');
  assert.equal(r.runEnd.runId, 7);
  assert.equal(r.done.messageId, 9);
  assert.equal(r.aborted, false, '正常收尾必须 aborted:false');
});

test('**回归锁**：读到 run_end 之后流被 abort（旧写法就是这样）也必须是"完成"而非超时', async () => {
  const ac = new AbortController();
  async function* gen() {
    yield B(frame({ type: 'delta', delta: 'ok' }) + frame({ type: 'run_end', status: 'saved', runId: 3 }));
    // 旧实现的写法：循环体内 abort ⇒ 下一次 next() 抛 AbortError
    ac.abort();
    const err = new Error('aborted'); err.name = 'AbortError'; throw err;
  }
  const r = await readChatStream(gen(), { signal: ac.signal });
  assert.equal(r.aborted, false, '读完 run_end 之后的 abort 不许改写成超时（这就是那个真缺陷）');
  assert.equal(r.runEnd.status, 'saved');
  assert.equal(r.runEnd.runId, 3, 'runId 不许丢成 null');
});

test('真超时：还没读到本轮结束就被中止 ⇒ aborted:true，且保留已收内容', async () => {
  const { stream, ac } = makeBody([B(frame({ type: 'delta', delta: '半' }))], { abortAtChunk: 1 });
  const r = await readChatStream(stream, { signal: ac.signal });
  assert.equal(r.aborted, true, '未读到本轮结束就被中止 ⇒ aborted:true');
  assert.equal(r.content, '半', '超时也要把已经收到的内容带回去（别丢）');
  assert.equal(r.runEnd, null);
});

test('error 帧如实带出（不吞）', async () => {
  const { stream } = makeBody([B(frame({ type: 'error', message: '内部错误（code=INTERNAL）' }) + frame({ type: 'run_end', status: 'error' }))]);
  const r = await readChatStream(stream);
  assert.match(r.errMsg, /INTERNAL/);
  assert.equal(r.runEnd.status, 'error');
});

test('分帧健壮性：一条帧跨 chunk、多字节字符被切断、`id:` 与 `: ping` 都要忽略', async () => {
  const full = Buffer.concat([
    B('id: 12\n'),
    B(frame({ type: 'delta', delta: '中文' })),
    B(': ping\n\n'),
    B(frame({ type: 'run_end', status: 'saved', runId: 1 })),
  ]);
  const cut = Math.floor(full.length / 2);
  // 切成**字节**片段（很可能切在多字节字符或帧中间）
  const { stream } = makeBody([full.subarray(0, cut - 1), full.subarray(cut - 1, cut + 1), full.subarray(cut + 1)]);
  const r = await readChatStream(stream);
  assert.equal(r.content, '中文', '跨 chunk 的多字节字符必须拼回来');
  assert.equal(r.runEnd.status, 'saved');
});

test('只有 done 没有 run_end 也算收尾（老客户端口径）', async () => {
  const { stream } = makeBody([B(frame({ type: 'delta', delta: 'x' }) + frame({ type: 'done', messageId: 1 }))]);
  const r = await readChatStream(stream);
  assert.equal(r.aborted, false);
  assert.equal(r.runEnd, null);
  assert.equal(r.done.messageId, 1);
});
