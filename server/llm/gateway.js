// server/llm/gateway.js - OpenAI 兼容统一网关
// 护栏标准（参照 3080）：模型 API 调用超时 60-90s；流式连接 60s
import { findProvider } from './providers.js';

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
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 4000, stream: false }),
    signal: AbortSignal.timeout(opts.timeoutMs || 90000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${p.name}(${model}) 调用失败 ${res.status}: ${(j.error?.message || res.statusText || '').slice(0, 200)}`);
  const content = j.choices?.[0]?.message?.content || '';
  const usage = j.usage || {};
  return { content, model: j.model || model, tokensIn: usage.prompt_tokens || 0, tokensOut: usage.completion_tokens || 0 };
}

// 流式调用：async generator，产出 content 增量；思考内容经 ctx.onThink 回调；ctx.usage 带回用量
export async function* chatStream(providerId, messages, opts = {}, keys, ctx = {}) {
  const p = resolve(providerId, keys);
  const model = opts.model || p.defaultModel;
  const res = await fetch(p.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
    body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens || 4000, temperature: opts.temperature ?? 1.0, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(60000), // 首次响应 60s；建立后流式读取无超时
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`${p.name}(${model}) 调用失败 ${res.status}: ${text.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
        if (think && ctx.onThink) ctx.onThink(think);
        if (delta) yield delta;
        if (j.usage && !ctx.usage) {
          ctx.usage = {
            tokens_in: j.usage.prompt_tokens || 0,
            tokens_out: j.usage.completion_tokens || 0,
            cache_hit: j.usage.prompt_tokens_details?.cached_tokens || 0,
          };
        }
      } catch { /* 忽略不完整帧 */ }
    }
  }
}

// 非流式 + 工具调用（function calling）：返回 { content, toolCalls, usage, reasoning }
export async function chatOnceWithTools(providerId, model, messages, tools, keys, temperature = 1.0) {
  const p = resolve(providerId, keys);
  const body = {
    model: model || p.defaultModel,
    messages,
    tools: tools || [],
    tool_choice: 'auto',
    max_tokens: 4000,
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
    toolCalls: msg.tool_calls || [],
    usage: { tokens_in: usage.prompt_tokens || 0, tokens_out: usage.completion_tokens || 0 },
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
