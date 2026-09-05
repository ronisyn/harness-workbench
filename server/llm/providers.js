// server/llm/providers.js - 多厂商配置（全部 OpenAI 兼容）
// 每项：id（唯一）/ name / base（OpenAI 兼容 base URL）/ keyEnv（config.keys 里的键名）/ defaultModel / capabilities / chatModels
// chatModels：该厂商「主对话模型」菜单清单——以 2026-09 各厂商带 key 实测 GET /models 返回为准，
// 人工剔除 embedding/rerank/视频/图像/音频/OCR/3D/过旧版本等非纯对话模型，保留主流对话模型供模型菜单可选。
export const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', keyEnv: 'deepseek',
    defaultModel: 'deepseek-v4-flash', capabilities: ['chat', 'code', 'reasoning'],
    chatModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'glm', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'glm',
    defaultModel: 'glm-4.5', capabilities: ['chat', 'tool', 'image'],
    chatModels: ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash'],
  },
  {
    id: 'ark', name: '豆包/火山方舟', base: 'https://ark.cn-beijing.volces.com/api/v3', keyEnv: 'ark',
    defaultModel: 'doubao-seed-2-1-pro-260628', capabilities: ['chat', 'vision', 'image', 'video'],
    chatModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628', 'doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-mini-260428', 'doubao-seed-1-8-251228', 'doubao-seed-1-6-251015'],
  },
  {
    id: 'moonshot', name: 'Kimi', base: 'https://api.moonshot.cn/v1', keyEnv: 'moonshot',
    defaultModel: 'kimi-k3', capabilities: ['chat', 'reasoning', 'code'],
    chatModels: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
  },
  {
    id: 'dashscope', name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'dashscope',
    defaultModel: 'qwen3.8-flash', capabilities: ['chat', 'vision', 'code'],
    chatModels: ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3.6-plus', 'qwen3.5-plus'],
  },
  {
    id: 'tokenhub', name: '腾讯 TokenHub', base: 'https://tokenhub.tencentmaas.com/v1', keyEnv: 'tokenhub',
    defaultModel: 'hy3', capabilities: ['chat', 'reasoning', 'tool'],
    chatModels: ['hy3', 'hy4-preview', 'hy-role', 'hunyuan-t1-vision-20250916'],
  },
  {
    id: 'qianfan', name: '百度文心', base: 'https://qianfan.baidubce.com/v2', keyEnv: 'qianfan',
    defaultModel: 'ernie-4.5-turbo-128k', capabilities: ['chat', 'vision'],
    chatModels: ['ernie-4.5-turbo-128k', 'ernie-4.5-turbo-32k', 'ernie-5.0', 'ernie-5.0-thinking-preview', 'ernie-5.1', 'ernie-x1.1', 'ernie-4.5-turbo-vl'],
  },
  {
    id: 'minimax', name: 'MiniMax', base: 'https://api.minimaxi.com/v1', keyEnv: 'minimax',
    defaultModel: 'MiniMax-M3', capabilities: ['chat'],
    chatModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  },
  {
    id: 'siliconflow', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', keyEnv: 'siliconflow',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Flash', capabilities: ['chat', 'vision', 'image', 'ocr'],
    chatModels: ['deepseek-ai/DeepSeek-V4-Flash', 'deepseek-ai/DeepSeek-V4-Pro', 'zai-org/GLM-5.3', 'zai-org/GLM-5.2', 'moonshotai/Kimi-K2.7-Code', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.6-35B-A3B', 'MiniMaxAI/MiniMax-M2.5', 'deepseek-ai/DeepSeek-V3.2', 'meituan-longcat/LongCat-2.0'],
  },
  {
    id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', keyEnv: 'openrouter',
    defaultModel: '', capabilities: ['chat'], chatModels: [],
  },
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

// 把各厂商 chatModels 清单同步进 models 表（启动时调用）。
// 规则：目录内模型未入库则插入(enabled=1)；已存在则不改 enabled（人工关闭/开启的选择不被启动覆盖），仅补全名称与能力。
// 传入 db 实例（server/db.js 的 query），pRow = providers 表行 {id, provider_key}。
export async function syncChatModels(db, pRow) {
  const p = PROVIDERS.find((x) => x.id === pRow.provider_key);
  if (!p || !p.chatModels || !p.chatModels.length) return 0;
  let n = 0;
  for (const mid of p.chatModels) {
    await db.query(
      'INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ' +
      'ON DUPLICATE KEY UPDATE last_seen_at=NOW()',
      [pRow.id, mid, mid === p.defaultModel ? p.name + '（默认）' : mid, JSON.stringify(p.capabilities || ['chat'])]
    );
    n++;
  }
  return n;
}
