// test/offline-model-shell.mjs —— 夹具用的**离线模型壳**（`node --import <本文件> server/index.js` 起真服务时预载）
//
// 为什么要有它：本轮验收要求"**不许真调模型**"跑通一轮对话 + 一次工具调用。把厂商 Key 清空这条路走不通——
// `server/config.js` 的取键是 `process.env[k] ?? envFile[k] ?? def`，而 PowerShell 里 `$env:X=''` 会**删掉**
// 变量 ⇒ 又落回 `.env` 里的真 Key（本任务第一次实测就这么真调了一次，已如实登记）。
// 所以离线只能在进程内做，两道保险：
//   ① `chatStreamWithTools.impl`：gateway 自己留的官方 test-hook（`scripts/ra37-rebuild.mjs` 同一用法）；
//   ② `globalThis.fetch` 闸门：任何发往非本机地址的请求当场抛错 —— "不真调模型"不靠自觉，靠拦截
//      （epoch 预热那条直连路径就是被它挡下来的，日志里能看到）。
import fs from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(u)) {
    return Promise.reject(new Error('[offline-shell] 已阻断外部请求（夹具不允许真调模型）: ' + u));
  }
  return realFetch(url, opts);
};

const { chatStreamWithTools } = await import('../server/llm/gateway.js');

// 观测量（可选）：把**每次调用真正收到的上下文**追加到 `RW_OFFLINE_SHELL_LOG` 指向的文件。
// 为什么要有这个口子：夹具要能断言"这一轮的历史是从存储里读回来的"，而模型看到的上下文在服务进程内、
// 夹具在进程外——不落一个可读的观测点，就只能去断言"日志里出现过字样"那种软判据。
const LOG = process.env.RW_OFFLINE_SHELL_LOG || '';
const note = (rec) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch { /* 观测失败不影响对话 */ } } };

let call = 0;
chatStreamWithTools.impl = async (provider, model, msgs, defs, opts = {}) => {
  call += 1;
  note({
    call,
    contextLen: msgs.length,
    systemCount: msgs.filter((m) => m.role === 'system').length,
    history: msgs.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: String(m.content || '') })),
  });
  // 每个进程只调一次工具 ⇒ "第二轮"必然走的是"没有工具调用的那条分支"，
  // 断言里就能区分"这一轮是首次执行"还是"这一轮带着历史继续"
  if (!globalThis.__offlineToolDone && defs.some((d) => d.function.name === 'list_dir')) {
    globalThis.__offlineToolDone = true;
    return {
      content: '', reasoning: '先看一眼目录', finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_offline_1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
      usage: { tokens_in: 1100, tokens_out: 30, cache_hit: 900, cache_miss: 200 },
      streamed: false,
    };
  }
  const text = '（离线壳回复）目录已列出。';
  if (opts.onContent) opts.onContent(text);
  return {
    content: text, reasoning: '', finishReason: 'stop',
    usage: { tokens_in: 1200, tokens_out: 20, cache_hit: 1000, cache_miss: 200 },
    streamed: false,
  };
};
