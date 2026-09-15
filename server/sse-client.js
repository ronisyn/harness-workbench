// server/sse-client.js - 读 `/api/chat` 的 SSE 流并解到"本轮结束"，**一份实现供所有外部适配器共用**
//
// 为什么要有它（v0.3 §0.5「不留两套」+ 2026-09-16 实测的真缺陷）：
//   `scripts/rw-mcp-server.mjs` 与 `scripts/rw-jsonrpc.mjs` 各写了一份几乎相同的读流代码，而两份都踩过同一个坑——
//   在**循环体内**读完 `run_end` 就 `ac.abort()`：那会让 `for await` 的 `next()` **当场以 AbortError 拒绝**，
//   于是"流明明跑完了"被自己的 catch 归成 **超时**（`status:'timeout'`、`runId` 丢成 null）。内容靠"回读落库那条"
//   兜住了，所以肉眼几乎发现不了（MCP 那次真机验证就出现过一次 timeout，当时归因到了别处）。
//   两份实现 ⇒ 一个坑要踩两遍。这里收成一份，并用夹具把"正常收尾不得被当成超时"钉死。
//
// 帧格式以契约 §4 为准：`[id: <seq>\n]data: <json>\n\n`，另有 `: ping` 保活。
// 口径：**读完即 break**（不 abort）；abort 只留给真正的超时。
export const CHAT_SSE_FRAME_NOTE = '契约 §4：`[id: <seq>]data: <json>`，`: ping` 是保活';

/**
 * 读一条 chat SSE 流到"本轮结束"。
 * @param {ReadableStream|AsyncIterable} body 响应体（fetch 的 `r.body`）
 * @param {{signal?:AbortSignal}} [opts] 超时用的 signal（**只在超时时被 abort**，正常收尾不要 abort）
 * @returns {Promise<{content:string, done:object|null, runEnd:object|null, errMsg:string|null, aborted:boolean}>}
 *   `aborted:true` 表示"还没读到本轮结束就被中止"（＝调用方超时）；正常收尾一定是 `false`。
 */
export async function readChatStream(body, { signal } = {}) {
  let content = '';
  let done = null;
  let runEnd = null;
  let errMsg = null;
  let buf = '';
  const dec = new TextDecoder();
  const eat = (block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue; // 跳过 `id:` 与 `: ping`
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      // 正文在 `delta` 里（`text` 只是旧写法兜底）
      if (ev.type === 'delta') content += (ev.delta !== undefined ? ev.delta : (ev.text || ''));
      else if (ev.type === 'done') { done = ev; if (ev.content) content = ev.content; }
      else if (ev.type === 'run_end') runEnd = ev;
      else if (ev.type === 'error') errMsg = ev.message;
    }
  };
  try {
    for await (const chunk of body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        eat(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
      if (runEnd || done) break; // 读完即 break；**不要**在这里 abort（见文件头）
    }
  } catch (e) {
    // 只有"还没读到本轮结束"的中止才算超时；读完之后的任何中止都不该把结果改写成失败
    if (runEnd || done) return { content, done, runEnd, errMsg, aborted: false };
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
      return { content, done, runEnd, errMsg, aborted: true };
    }
    throw e;
  }
  return { content, done, runEnd, errMsg, aborted: false };
}
