// server/llm/market.js - 模型市场（v2.0 D+ 需求）
// 数据源：OpenRouter(公开) / SiliconFlow / TokenHub / 百炼（聚合平台）
// 功能：拉取市场快照入库、列出未接入厂商模型、勾选接入（归属来源 provider）
import { db } from '../db.js';
import { config } from '../config.js';

export const MARKET_SOURCES = [
  { source: 'openrouter', name: 'OpenRouter（海外）', base: 'https://openrouter.ai/api/v1', needsKey: false },
  { source: 'siliconflow', name: '硅基流动（国内）', base: 'https://api.siliconflow.cn/v1', needsKey: true },
  { source: 'tokenhub', name: '腾讯 TokenHub', base: 'https://tokenhub.tencentmaas.com/v1', needsKey: true },
  { source: 'dashscope', name: '阿里百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', needsKey: true },
];

function keyFor(source) {
  const map = { openrouter: 'openrouter', siliconflow: 'siliconflow', tokenhub: 'tokenhub', dashscope: 'dashscope' };
  return config.keys[map[source]];
}

// 拉取单个来源的模型列表
export async function fetchMarketModels(source) {
  const s = MARKET_SOURCES.find((x) => x.source === source);
  if (!s) throw new Error('未知市场源: ' + source);
  const key = keyFor(source);
  if (s.needsKey && !key) throw new Error(`市场源 ${s.name} 未配置 API Key`);
  const res = await fetch(s.base + '/models', {
    headers: key ? { Authorization: 'Bearer ' + key } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${s.name} 模型列表获取失败 ${res.status}`);
  const j = await res.json().catch(() => ({}));
  const data = j.data || [];
  return data.map((m) => ({
    source,
    model_id: String(m.id || ''),
    name: String(m.name || m.id || ''),
    provider_name: String(m.provider_name || (m.id || '').split('/')[0] || ''),
    domain: String(m.domain || ''),
  })).filter((m) => m.model_id);
}

// 刷新市场快照（每日 0 点定时 + 手动）
export async function refreshMarket() {
  const results = [];
  for (const s of MARKET_SOURCES) {
    try {
      const models = await fetchMarketModels(s.source);
      for (const m of models) {
        await db.query(
          'INSERT INTO market_snapshot (source, model_id, name, provider_name, domain, snapshot_date) VALUES (?,?,?,?,?,CURDATE()) ON DUPLICATE KEY UPDATE name=VALUES(name), provider_name=VALUES(provider_name), domain=VALUES(domain)',
          [m.source, m.model_id, m.name, m.provider_name, m.domain]
        );
      }
      results.push({ source: s.source, count: models.length });
    } catch (e) {
      results.push({ source: s.source, error: e.message });
    }
  }
  return results;
}

// 市场列表（含已接入标记）
export async function marketList() {
  const rows = await db.query('SELECT source, model_id, name, provider_name, domain, snapshot_date FROM market_snapshot ORDER BY source, model_id LIMIT 2000');
  const connected = await db.query('SELECT provider_id, model_id, enabled FROM models');
  const connSet = new Set(connected.map((c) => `${c.provider_id}:${c.model_id}`));
  const providers = await db.query('SELECT id, provider_key, name FROM providers');
  const providerByKey = Object.fromEntries(providers.map((p) => [p.provider_key, p]));
  const grouped = {};
  for (const r of rows) {
    const g = grouped[r.source] || (grouped[r.source] = { source: r.source, count: 0, models: [] });
    g.count++;
    const p = providerByKey[r.source];
    g.models.push({
      id: r.model_id,
      name: r.name,
      providerName: r.provider_name,
      domain: r.domain,
      connected: p ? connSet.has(`${p.id}:${r.model_id}`) : false,
    });
  }
  return Object.values(grouped);
}

// 勾选接入：模型归属来源聚合平台 provider（v2.0 决定）
export async function connectModels(source, modelIds) {
  // 确保 provider 存在（来源即 provider）
  let p = (await db.query('SELECT id FROM providers WHERE provider_key=?', [source]))[0];
  if (!p) {
    const s = MARKET_SOURCES.find((x) => x.source === source);
    const r = await db.query('INSERT INTO providers (provider_key, name, base_url, api_key_env, enabled) VALUES (?,?,?,?,1)', [source, s?.name || source, s?.base || '', source]);
    p = { id: r.insertId };
  }
  const inserted = [];
  for (const mid of modelIds) {
    const snap = (await db.query('SELECT name, domain FROM market_snapshot WHERE source=? AND model_id=?', [source, mid]))[0];
    await db.query(
      'INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1, last_seen_at=NOW()',
      [p.id, mid, snap?.name || mid, JSON.stringify([domainToCap(snap?.domain)])]
    );
    inserted.push(mid);
  }
  return { provider: source, inserted };
}

function domainToCap(domain) {
  const d = String(domain || '').toLowerCase();
  if (d.includes('image')) return 'image';
  if (d.includes('video')) return 'video';
  if (d.includes('embed')) return 'embedding';
  if (d.includes('audio')) return 'audio';
  return 'chat';
}

// 每日定时刷新（0 点）
export function scheduleMarketRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delay = next - now;
  setTimeout(async () => {
    try { await refreshMarket(); console.log('[market] 每日市场刷新完成'); } catch { /* ignore */ }
    scheduleMarketRefresh();
  }, delay);
}
