// server/config.js - 环境配置加载（手写极简 .env 解析，零依赖）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envFile = loadEnvFile();
// 把 .env 变量写回 process.env，供所有模块直接读取（如 FEISHU_APP_ID）
for (const [k, v] of Object.entries(envFile)) {
  if (process.env[k] === undefined) process.env[k] = v;
}
const env = (k, def) => process.env[k] ?? envFile[k] ?? def;

export const config = {
  port: Number(env('PORT', 3000)),
  root: ROOT,
  db: {
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(env('DB_PORT', 3306)),
    user: env('DB_USER', 'rw_app'),
    pass: env('DB_PASS', ''),
    name: env('DB_NAME', 'rw_dev'),
  },
  session: {
    secret: env('SESSION_SECRET', 'dev-secret-change-me'),
    days: Number(env('SESSION_DAYS', 5)),
  },
  admin: {
    user: env('RW_ADMIN_USER', 'Ronisyn'),
    pass: env('RW_ADMIN_PASS', ''),
  },
  // 各厂商 API Key（env 或 .env）
  keys: {
    deepseek: env('DEEPSEEK_API_KEY', ''),
    glm: env('GLM_API_KEY', ''),
    ark: env('VOLC_ARK_API_KEY', ''),
    moonshot: env('MOONSHOT_API_KEY', ''),
    dashscope: env('DASHSCOPE_API_KEY', ''),
    tokenhub: env('TOKENHUB_API_KEY', ''),
    qianfan: env('QIANFAN_API_KEY', ''),
    minimax: env('MINIMAX_API_KEY', ''),
    siliconflow: env('SILICONFLOW_API_KEY', ''),
    openrouter: env('OPENROUTER_API_KEY', ''),
  },
};
