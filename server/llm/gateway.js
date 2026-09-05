// server/llm/gateway.js - OpenAI 兼容统一网关
// 护栏标准（参照 3080）：模型 API 调用超时 60-90s；流式连接 60s
import { findProvider } from './providers.js';

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
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 8000, stream: false }),
    signal: AbortSignal.timeout(opts.timeoutMs || 90000),
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
  // 首字节等待 60s；一旦开始收到数据，改为"流空闲 120s"护栏 —— 避免长输出（思考+生成 >60s）被整段中止
  const ac = new AbortController();
  let idleTimer = setTimeout(() => ac.abort(), 60000);
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => ac.abort(), 120000); };
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
    throw new Error(`${p.name}(${model}) 连接失败/超时(60s): ${e.message}`);
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

// 非流式 + 工具调用（function calling）：返回 { content, toolCalls, usage, reasoning }
export async function chatOnceWithTools(providerId, model, messages, tools, keys, temperature = 0.4) {
  const p = resolve(providerId, keys);
  const body = {
    model: model || p.defaultModel,
    messages,
    tools: tools || [],
    tool_choice: 'auto',
    max_tokens: 12000, // C 方案(2026-09)：原 8000 在 reasoning+长计划+工具调用同轮输出时可能被 content 耗尽致 tool_calls 未发出（假开始物理成因）；12000 只作上限不留计费差异
    temperature,
    stream: false,
  };
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000), // 工具模式 LLM 调用 90s
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p.name} 调用失败 ${res.status}: ${(j.error?.message || res.statusText || '').slice(0, 200)}`);
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

// 拉取厂商模型列表（模型市场「加载模型」按钮用）
export async function fetchModels(providerId, keys) {
  const p = resolve(providerId, keys);
  const res = await fetch(p.base + '/models', { headers: { Authorization: 'Bearer ' + p.key } });
  if (!res.ok) throw new Error(`${p.name} 模型列表获取失败 ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const list = (j.data || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  return list;
}
