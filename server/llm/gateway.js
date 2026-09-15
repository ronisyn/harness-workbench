// server/llm/gateway.js - OpenAI 兼容统一网关
// 护栏标准（参照 3080）：模型 API 调用超时 60-90s；流式连接 60s
import { findProvider } from './providers.js';
import { FAIL } from '../failures.js'; // 失败码表只此一处（工具侧与 LLM 侧同表，见 server/failures.js）

// 真实计费价目（元/M tokens，三档 hit/miss/out）
// deepseek 档=2026-09 真实账单加权有效单价（平台两档价并存，按用量加权：hit≈0.086/miss≈2.30/out≈8.0）；
// 其它厂商无账单明细，沿用平台报价近似（hit 按 miss×5% 估算）
export const PRICE = {
  deepseek: { hit: 0.086, miss: 2.3, out: 8.0 },
  glm: { hit: 0.1, miss: 2, out: 5 },
  ark: { hit: 0.02, miss: 0.3, out: 0.8 },
  moonshot: { hit: 0.2, miss: 4, out: 16 },
  dashscope: { hit: 0.03, miss: 0.5, out: 2 },
  tokenhub: { hit: 0.1, miss: 2, out: 5 },
  qianfan: { hit: 0.4, miss: 8, out: 20 },
  minimax: { hit: 0.25, miss: 5, out: 12 },
  siliconflow: { hit: 0.1, miss: 2, out: 5 },
};
export function calcCost(providerId, tokens = {}) {
  const p = PRICE[providerId] || { hit: 0.1, miss: 2, out: 6 };
  const hit = Number(tokens.hit) || 0;
  const miss = Number(tokens.miss) || 0;
  const out = Number(tokens.out) || 0;
  return Number(((hit / 1e6) * p.hit + (miss / 1e6) * p.miss + (out / 1e6) * p.out).toFixed(4));
}
// 从响应 usage 提取缓存拆分（deepseek 专有字段优先，OpenAI cached_tokens 回退）
const cacheOf = (u = {}) => {
  const hit = u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : (u.prompt_tokens_details?.cached_tokens || 0);
  const miss = u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens : Math.max(0, (u.prompt_tokens || 0) - Number(hit || 0));
  return { cache_hit: Number(hit) || 0, cache_miss: Number(miss) || 0 };
};

function resolve(providerId, keys) {
  const p = findProvider(providerId);
  if (!p) throw new Error('未知厂商: ' + providerId);
  const key = keys[p.keyEnv];
  if (!key) throw new Error(`厂商「${p.name}」未配置 API Key`);
  return { ...p, key };
}

// 非流式调用（工具场景/测试用）
export async function chatOnce(providerId, messages, opts = {}, keys) {
  const p = resolve(providerId, keys);
  const model = opts.model || p.defaultModel;
  const timeoutMs = opts.timeoutMs || p.timeoutMs || 90000; // O-3：厂商级超时（GLM thinking 180s）
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 8000, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p.name}(${model}) 调用失败 ${res.status}: ${(j.error?.message || res.statusText || '').slice(0, 200)}`);
  const content = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  return { content, model: j.model || model, tokensIn: usage.prompt_tokens || 0, tokensOut: usage.completion_tokens || 0, finishReason: j.choices?.[0]?.finish_reason || '', ...cacheOf(usage) };
}

// 流式调用：async generator，产出 content 增量；思考内容经 ctx.onThink 回调；ctx.usage 带回用量
export async function* chatStream(providerId, messages, opts = {}, keys, ctx = {}) {
  const p = resolve(providerId, keys);
  const model = opts.model || p.defaultModel;
  // 首字节等待：GLM thinking 模型 reasoning 长（O-3）→ 按厂商 timeoutMs 比例放宽；默认 60s。
  // 一旦开始收到数据（含 reasoning delta），改为"流空闲"护栏（厂商 timeoutMs 或默认 120s）。
  const firstByteMs = opts.firstByteMs || Math.min(60000, Math.round((p.timeoutMs || 90000) / 3));
  const idleMs = p.timeoutMs || 120000;
  const ac = new AbortController();
  let idleTimer = setTimeout(() => ac.abort(), firstByteMs);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ac.abort(), idleMs); };
  let res;
  try {
    res = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 8000, temperature: opts.temperature ?? 0.4, stream: true, stream_options: { include_usage: true } }),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(idleTimer);
    throw new Error(`${p.name}(${model}) 连接失败/超时(${Math.round(firstByteMs / 1000)}s): ${e.message}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(idleTimer);
    const text = await res.text().catch(() => '');
    throw new Error(`${p.name}(${model}) 调用失败 ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) armIdle(); // 有数据即续命（空闲 120s 才中止）
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          const think = j.choices?.[0]?.delta?.reasoning_content;
          const fr = j.choices?.[0]?.finish_reason;
          if (fr) ctx.finishReason = fr; // stop|length|…
          if (think && ctx.onThink) ctx.onThink(think);
          if (delta) yield delta;
          if (j.usage && !ctx.usage) {
            ctx.usage = {
              tokens_in: j.usage.prompt_tokens || 0,
              tokens_out: j.usage.completion_tokens || 0,
              ...cacheOf(j.usage),
            };
          }
        } catch { /* 忽略不完整帧 */ }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 失败分类与可取消等待（架构对齐 DSH `dsh-llm-retry`）
// DSH 的策略字段：`{mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}`，
// 核心两句：① 只在 `retryableCodes.includes(failure.code)` 时重试（不搞"一律重试"）；
// ② 每次重试"先把意图落进会话，再做**可取消**的等待"（cancellableDelay + AbortSignal.any）。
// 我们照做①②；退避参数（initialDelayMs/jitterRatio）**暂不引入**——DSH 仓库里没有它的实际取值
// （策略在部署配置里），编一个 initialDelayMs 就是莫须有的值。等待时长优先用服务端给的 Retry-After，
// 它没给就立刻重试。这条差距登记在《架构文档冲突登记》。
// ---------------------------------------------------------------------------

/** 厂商侧"可恢复"的 HTTP 状态：限流/超时/网关类。其余 4xx（参数、鉴权、模型不存在）重试纯属浪费。 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);
/** 网络/超时类失败（无 HTTP 状态码时的判据，措辞取自 Node fetch/undici 与本网关自有文案） */
const RETRYABLE_MSG = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|other side closed|fetch failed|terminated|空闲超时|连接失败/i;

/**
 * 把一次厂商失败分类成"能不能重试"。**码表在 server/failures.js 一处**（统一失败分类）——
 * 这里只做映射，`retryable` 从表里读，避免"同一件事在两个地方各判一次、时间久了不一致"。
 * @param {Error & {status?: number, aborted?: boolean, retryAfterMs?: number}} err
 * @returns {{code: string, retryable: boolean, reason: string, retryAfterMs: number|null}}
 */
export function llmRetryDecision(err) {
  const mk = (code, reason) => ({ code, retryable: !!(FAIL[code] && FAIL[code].retryable), reason, retryAfterMs: (err && err.retryAfterMs) || null });
  if (!err) return { code: 'LLM_UNKNOWN', retryable: false, reason: '未知失败', retryAfterMs: null };
  // 用户已停止：**绝不重试**（重试等于把用户按下的停止键又按回去）
  if (err.aborted) return mk('LLM_ABORTED', '用户已停止');
  // 流式帧损坏：走"非流式兜底"这条**另一条**机制，不属于重试
  if (err.needFallback) return mk('LLM_STREAM_BROKEN', '流式帧损坏（改用非流式兜底）');
  const st = Number(err.status) || 0;
  if (st) {
    if (st === 429) return mk('LLM_RATE_LIMITED', 'HTTP 429（厂商限流）');
    if (RETRYABLE_STATUS.has(st)) return mk('LLM_HTTP_RETRYABLE', 'HTTP ' + st + '（厂商侧可恢复）');
    return mk('LLM_HTTP_FATAL', 'HTTP ' + st + '（请求被拒，重试无效）');
  }
  const msg = String(err.message || '');
  if (RETRYABLE_MSG.test(msg)) return mk('LLM_NETWORK', '网络/超时类失败');
  // 未分类一律**不重试**（宁可少重试一次，也不要对参数类错误反复打厂商）——非流式兜底仍会走
  return mk('LLM_UNKNOWN', '未分类失败（按不可重试处理）');
}

/** 解析厂商 Retry-After 头（秒数或 HTTP 日期）。解析不出返回 null（= 不等待，立刻重试）。 */
export function retryAfterMsOf(headerValue) {
  if (!headerValue) return null;
  const s = String(headerValue).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

/**
 * 可取消等待（DSH `cancellableDelay` 同款）：等待期间用户"停止"即刻返回 false。
 * 用 setTimeout 而非 sleep 轮询：不空转，且把监听器在两条路径上都摘干净。
 * 注意**不 unref**（与 DSH 一致）：这个计时器正是调用方在等的那件事，unref 会让"只有它在等待"时
 * 进程/测试进程直接退出（本地实测：夹具被 node:test 判成 "event loop has already resolved"）。
 */
export function cancellableDelay(delayMs, signal) {
  const ms = Number(delayMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(true);
  if (signal && signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => {
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } }
      resolve(true);
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 非流式 + 工具调用（function calling）：返回 { content, toolCalls, usage, reasoning }
// opts.signal：外部中止（A5）。原来这里**不接** signal——于是"流式失败后走兜底"那段时间里
// 用户按停止是无效的（真实洞，2026-09-15 统一口径时修）。厂商自带超时与外部 signal 取并集。
export async function chatOnceWithTools(providerId, model, messages, tools, keys, temperature = 0.4, opts = {}) {
  const p = resolve(providerId, keys);
  // 工具名去重防御（2026-09 批5）：外部源（MCP server）工具可能与本地/自身重复 → deepseek 报
  // "Tool names must be unique" 400。发送前按 name 去重（保留首个），并记录重名供诊断。
  const seen = new Set();
  const uniqTools = [];
  for (const t of tools || []) {
    const nm = t && t.function && t.function.name;
    if (!nm) continue;
    if (seen.has(nm)) { console.warn('[gateway] 工具名重复已去重: ' + nm); continue; }
    seen.add(nm);
    uniqTools.push(t);
  }
  const body = {
    model: model || p.defaultModel,
    messages,
    tools: uniqTools,
    tool_choice: 'auto',
    max_tokens: 12000, // C 方案(2026-09)：原 8000 在 reasoning+长计划+工具调用同轮输出时可能被 content 耗尽致 tool_calls 未发出（假开始物理成因）；12000 只作上限不留计费差异
    temperature,
    stream: false,
  };
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify(body),
    // O-3：工具模式超时按厂商（GLM thinking 180s）；与外部 signal 取并集（可被"停止"打断）
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(p.timeoutMs || 90000)]) : AbortSignal.timeout(p.timeoutMs || 90000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${p.name} 调用失败 ${res.status}: ${(j.error?.message || res.statusText || '').slice(0, 200)}`);
    err.status = res.status;
    err.retryAfterMs = retryAfterMsOf(res.headers.get('retry-after')); // 等待时长优先用服务端给的（不自己编退避）
    throw err;
  }
  const msg = j.choices?.[0]?.message || {};
  const usage = j.usage || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || '',
    finishReason: j.choices?.[0]?.finish_reason || '',
    toolCalls: msg.tool_calls || [],
    usage: { tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0, ...cacheOf(usage) },
  };
}

// ---------------------------------------------------------------------------
// P20 流式工具调用（2026-09，蓝图 P20/P21）：每轮 stream:true + tools，取消总时限改为
// 空闲看门狗（首字节 90s / 之后 120s 无字节判死），支持外部 signal 贯穿（A5/O-20，覆盖现主路径）。
// 思考增量经 ctx.onThink 逐块回调（前端折叠区）；正文增量经 opts.onContent 回调（前端真流）；
// tool_calls 增量由纯函数 accumulateToolDeltas 累积（官方 SDK 同款模式，带单测）；usage 取流末帧（B1）。
// ---------------------------------------------------------------------------

// OpenAI 兼容流式 tool_calls 累加器（纯函数，可单测）：delta.tool_calls[] 按 index 累积，
// arguments 为字符串片段按 index 拼接；id/name/type 通常仅首帧携带（重复则覆盖相同值）。
// 返回新的 acc：{ calls: [{ index, id, name, type, arguments }] }
export function accumulateToolDeltas(acc, deltaToolCalls) {
  const calls = (acc && acc.calls ? acc.calls : []).map((c) => ({ ...c }));
  for (const d of deltaToolCalls || []) {
    if (!d || typeof d !== 'object') continue;
    const idx = Number(d.index);
    if (!Number.isFinite(idx) || idx < 0) continue;
    let slot = calls.find((c) => c.index === idx);
    if (!slot) { slot = { index: idx, id: '', name: '', type: '', arguments: '' }; calls.push(slot); }
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    const fn = d.function || {};
    if (fn.name) slot.name = fn.name;
    if (typeof fn.arguments === 'string') slot.arguments += fn.arguments; // 增量片段拼接
  }
  calls.sort((a, b) => a.index - b.index);
  return { calls };
}

// 把累积结果转成 agent 需要的完整 tool_calls（function calling 结构）；arguments JSON 解析失败抛错（调用方一次性回退）
export function finalizeToolCalls(acc) {
  const calls = (acc && acc.calls) || [];
  const out = [];
  for (const c of calls) {
    if (!c.name) continue; // 无名片段（异常流）丢弃
    let parsed = {};
    try { parsed = c.arguments ? JSON.parse(c.arguments) : {}; }
    catch (e) { throw new Error('工具 ' + c.name + ' 参数流式累积解析失败: ' + String(e.message || e).slice(0, 120)); }
    out.push({
      id: c.id || ('call_' + c.index),
      type: c.type || 'function',
      function: { name: c.name, arguments: JSON.stringify(parsed) },
    });
  }
  return out;
}

// 流式工具轮调用：返回 { content, reasoning, toolCalls, finishReason, usage }
// opts：{ temperature, signal(外部中止, A5), onThink(思考块), onContent(正文增量), firstByteMs, idleMs, maxTokens }
// [test-hook] `chatStreamWithTools.impl`：仅给"端到端实测"注入厂商桩（RA-37 的 scripts/ra37-rebuild.mjs）。
// 目的是让实测能跑**真的** HTTP/SSE/agent 循环/落库/事件环，只把"字节从模型来"这一步换掉；
// 生产路径不设置它 → 走下面真实实现，行为不变。
export async function chatStreamWithTools(providerId, model, messages, tools, keys, opts = {}) {
  if (typeof chatStreamWithTools.impl === 'function') return chatStreamWithTools.impl(providerId, model, messages, tools, keys, opts);
  const p = resolve(providerId, keys);
  const uniqTools = [];
  const seen = new Set();
  for (const t of tools || []) {
    const nm = t && t.function && t.function.name;
    if (!nm) continue;
    if (seen.has(nm)) { console.warn('[gateway] 工具名重复已去重: ' + nm); continue; }
    seen.add(nm);
    uniqTools.push(t);
  }
  const ac = new AbortController();
  let abortedBy = null;
  const kill = () => { try { ac.abort(); } catch { /* ignore */ } };
  const onExtAbort = () => { abortedBy = 'external'; kill(); };
  if (opts.signal) {
    if (opts.signal.aborted) { abortedBy = 'external'; kill(); }
    else opts.signal.addEventListener('abort', onExtAbort, { once: true });
  }
  const firstByteMs = opts.firstByteMs || Math.min(90000, Math.round((p.timeoutMs || 180000) / 2));
  const idleMs = opts.idleMs || 120000;
  let idleTimer = setTimeout(() => { abortedBy = 'idle'; kill(); }, firstByteMs);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { abortedBy = 'idle'; kill(); }, idleMs); };
  const cleanup = () => { clearTimeout(idleTimer); if (opts.signal) { try { opts.signal.removeEventListener('abort', onExtAbort); } catch { /* ignore */ } } };
  let res;
  try {
    res = await fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify({
        model: model || p.defaultModel,
        messages,
        tools: uniqTools,
        tool_choice: 'auto',
        max_tokens: opts.maxTokens || 12000,
        temperature: opts.temperature ?? 0.4,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: ac.signal,
    });
  } catch (e) {
    cleanup();
    const why = abortedBy === 'external' ? '已中止' : (abortedBy === 'idle' ? '空闲超时(' + Math.round(firstByteMs / 1000) + 's 无数据)' : '连接失败');
    const err = new Error(`${p.name}(${model || p.defaultModel}) 流式${why}: ${String(e.message || e).slice(0, 160)}`);
    err.aborted = abortedBy === 'external';
    throw err;
  }
  if (!res.ok || !res.body) {
    cleanup();
    const text = await res.text().catch(() => '');
    const err = new Error(`${p.name}(${model || p.defaultModel}) 流式调用失败 ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.retryAfterMs = retryAfterMsOf(res.headers.get('retry-after')); // 同上：限流等待时长听服务端的
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  let acc = { calls: [] };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) armIdle();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') break;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        const ch = j.choices && j.choices[0];
        const delta = (ch && ch.delta) || {};
        if (ch && ch.finish_reason) finishReason = ch.finish_reason;
        const think = delta.reasoning_content || delta.reasoning || '';
        if (think) { reasoning += think; if (opts.onThink) opts.onThink(think); }
        if (typeof delta.content === 'string' && delta.content) {
          content += delta.content;
          if (opts.onContent) opts.onContent(delta.content);
        }
        if (delta.tool_calls) acc = accumulateToolDeltas(acc, delta.tool_calls);
        if (j.usage && !usage) {
          usage = {
            tokens_in: j.usage.prompt_tokens || 0,
            tokens_out: j.usage.completion_tokens || 0,
            ...cacheOf(j.usage),
          };
        }
      }
    }
  } catch (e) {
    if (abortedBy === 'external') { const err = new Error('流式中止'); err.aborted = true; cleanup(); throw err; }
    cleanup();
    throw e;
  }
  cleanup();
  try { await reader.cancel().catch(() => {}); } catch { /* ignore */ }
  let toolCalls = [];
  try { toolCalls = finalizeToolCalls(acc); }
  catch (e) { const err = new Error(String(e.message || e)); err.needFallback = true; throw err; }
  return { content, reasoning, toolCalls, finishReason, usage };
}

// 拉取厂商模型列表（模型市场「加载模型」按钮用）
export async function fetchModels(providerId, keys) {
  const p = resolve(providerId, keys);
  const res = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + p.key } });
  if (!res.ok) throw new Error(`${p.name} 模型列表获取失败 ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const list = (j.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  return list;
}
