// server/llm/providers.js - 多厂商配置（全部 OpenAI 兼容）
// 每项：id（唯一）/ name / base（OpenAI 兼容 base URL）/ keyEnv（config.keys 里的键名）/ defaultModel / capabilities
export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', keyEnv: 'deepseek', defaultModel: 'deepseek-chat', capabilities: ['chat', 'code'] },
  { id: 'glm', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'glm', defaultModel: 'glm-4.5', capabilities: ['chat', 'tool', 'image'] },
  { id: 'ark', name: '豆包/火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ark', defaultModel: 'doubao-seed-2-1-pro-260628', capabilities: ['chat', 'vision', 'image', 'video'] },
  { id: 'moonshot', name: 'Kimi', base: 'https://api.moonshot.cn/v1', keyEnv: 'moonshot', defaultModel: 'kimi-k3', capabilities: ['chat', 'reasoning', 'code'] },
  { id: 'dashscope', name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'dashscope', defaultModel: 'qwen3.8-flash', capabilities: ['chat', 'vision', 'code'] },
  { id: 'tokenhub', name: '腾讯 TokenHub', base: 'https://tokenhub.tencentmaas.com/v1', keyEnv: 'tokenhub', defaultModel: 'hy3', capabilities: ['chat', 'reasoning', 'tool'] },
  { id: 'qianfan', name: '百度文心', base: 'https://qianfan.baidubce.com/v2', keyEnv: 'qianfan', defaultModel: 'ernie-4.5-turbo-128k', capabilities: ['chat', 'vision'] },
  { id: 'minimax', name: 'MiniMax', base: 'https://api.minimaxi.com/v1', keyEnv: 'minimax', defaultModel: 'MiniMax-M3', capabilities: ['chat'] },
  { id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', keyEnv: 'siliconflow', defaultModel: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: ['chat', 'vision', 'image', 'ocr'] },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyEnv: 'openrouter', defaultModel: '', capabilities: ['chat'] },
];

// 已配置 key 的厂商（=已接入）
export function activeProviders(keys) {
  return PROVIDERS
    .filter((p) => keys[p.keyEnv])
    .map((p) => ({ id: p.id, name: p.name, defaultModel: p.defaultModel, capabilities: p.capabilities }));
}

// 所有厂商（模型市场用，标注是否已接）
export function allProviders(keys) {
  return PROVIDERS.map((p) => ({ ...p, connected: Boolean(keys[p.keyEnv]) }));
}

export function findProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}
