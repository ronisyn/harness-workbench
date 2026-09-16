// test/kbsearch-shell.mjs —— 夹具用**离线模型壳②**：第一轮真发起一次 `kb_search` 工具调用，之后出正文。
//
// 为什么不能复用 `offline-model-shell.mjs`：那一份的第一轮固定调 `list_dir`（G1 那一批的判据就是它），
// 改它会把 `test/storage-chain.test.mjs` 整条链的断言带偏。这一份是同形的第二只壳，只管检索那条链。
//
// 两道保险与另一只壳**逐字相同**（"不真调模型"不靠自觉，靠拦截）：
//   ① `chatStreamWithTools.impl`：gateway 自己留的官方 test-hook；
//   ② `globalThis.fetch` 闸门：任何发往非本机地址的请求当场抛错。
import fs from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(u)) {
    return Promise.reject(new Error('[kbsearch-shell] 已阻断外部请求（夹具不允许真调模型）: ' + u));
  }
  return realFetch(url, opts);
};

const { chatStreamWithTools } = await import('../server/llm/gateway.js');

// 观测量（可选）：把每次调用**真正收到的**上下文追加到这个文件（与另一只壳同一个口径）。
const LOG = process.env.RW_OFFLINE_SHELL_LOG || '';
const note = (rec) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch { /* 观测失败不影响对话 */ } } };

const QUERY = process.env.RW_KB_SHELL_Q || '部署口径';
// 2026-09-17 加：这一轮要发哪个工具（默认空＝保持原样，只发 `kb_search`）。
// 写路径的端到端夹具（`test/kbsearch-e2e.test.mjs` 的"干净机器上攒记忆"）用它发 `kb_add` / `kb_del`；
// 显式指定工具时**不再看关键词**（闸门仍是一次性的：一个进程只发一次，避免死循环）。
const TOOL = process.env.RW_KB_SHELL_TOOL || '';
const TOOL_ARGS = process.env.RW_KB_SHELL_ARGS || '{}';
let call = 0;
chatStreamWithTools.impl = async (provider, model, msgs, defs, opts = {}) => {
  call += 1;
  note({
    call,
    contextLen: msgs.length,
    history: msgs.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: String(m.content || '') })),
    toolNames: (defs || []).map((d) => d && d.function && d.function.name).filter(Boolean),
  });
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  // 显式指定了工具：只要它在工具面里就发一次（写路径夹具用；关键词判据不参与，免得为了触发它去凑词）
  if (TOOL && !globalThis.__kbShellDone && defs.some((d) => d.function.name === TOOL)) {
    globalThis.__kbShellDone = true;
    return {
      content: '', reasoning: '按夹具脚本调用 ' + TOOL, finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_kb_scripted', type: 'function', function: { name: TOOL, arguments: TOOL_ARGS } }],
      usage: { tokens_in: 900, tokens_out: 20, cache_hit: 700, cache_miss: 200 },
      streamed: false,
    };
  }
  // 只在"用户这轮明确要求搜知识库"且**本进程还没搜过**时发起一次工具调用（与另一只壳同款的一次性闸门）
  if (!globalThis.__kbShellDone && defs.some((d) => d.function.name === 'kb_search')
      && /知识库|记得|约定|搜一下|查一下/.test(String((lastUser && lastUser.content) || ''))) {
    globalThis.__kbShellDone = true;
    return {
      content: '', reasoning: '先搜一下知识库', finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_kb_1', type: 'function', function: { name: 'kb_search', arguments: JSON.stringify({ q: QUERY }) } }],
      usage: { tokens_in: 900, tokens_out: 20, cache_hit: 700, cache_miss: 200 },
      streamed: false,
    };
  }
  const text = '（检索壳回复）搜完了。';
  if (opts.onContent) opts.onContent(text);
  return {
    content: text, reasoning: '', finishReason: 'stop',
    usage: { tokens_in: 1200, tokens_out: 20, cache_hit: 1000, cache_miss: 200 },
    streamed: false,
  };
};
