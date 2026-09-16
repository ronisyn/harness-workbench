// test/fake-db-shell.mjs —— 夹具用的离线模型壳 + **假 db 层**（`node --import <本文件> server/index.js` 起真服务时预载）
//
// 为什么需要它（本文件只服务一件事：`GET /api/cache-hit/summary` 的读数从哪来）：
//   那个端点直接查 MySQL 的 `usage_stats` / `audit_log`（不是存储接口）。夹具里 MySQL 不可达时它整页 500
//   （改造前就是这个行为，与本批改动无关），于是**没法**验证"指标告警线接线之后页面标记到底出不出得来"。
//   三条路都不合适：连真库（会往开发库写启动/登录/设置行）、改名建库（不是夹具该做的事）、
//   把端点改成"库不可达也 200"（那是改既有语义，超出本批范围）。
//   ⇒ 第四条：**在夹具进程内把 db 换成一个只读的假实现**（与 test/exec-callsites.test.mjs 同一手法：
//     `module.register` + 官方 loader 钩子），读数由夹具自己给 —— 于是"读数 → 越线 → 页面字段"这条链
//     可以在不碰任何真库的前提下被完整验证。
//
// 两件都不许越界：
//   · 假 db **只读**：除了 `insertId/affectedRows` 这种形状占位，它不保存任何东西（服务写入落到哪里由存储层决定）；
//   · 模型仍然被换掉 + fetch 闸门仍然拦外部请求（不真调模型，这一条不因为有了假 db 而放松）。
import fs from 'node:fs';
import { register } from 'node:module';

// ── 假 db 的源码（在服务进程内以 data: URL 模块加载，所以它只认 process.env）─────────────────────────
// 读数固定成夹具自己造的样本（不是真库读数）：C1=0.99、C2 中位/P90=10、C3=¥2.5/run、C4=3 次、C5=12 次。
// `metric_alert_lines` 那一行**不从这里读**：设置写在存储层（本夹具是 jsonfile），所以那一条由下面的
// `RW_FAKE_SETTINGS_FILE` 指定一个文件——它模拟的正是生产环境里"设置与读数同一个库"的事实。
const FAKE_DB = `
import fs from 'node:fs';
const ROUNDS = Number(process.env.RW_FAKE_USAGE_ROUNDS || 40);
const roundRows = Array.from({ length: ROUNDS }, () => ({ h: 990, m: 10, cid: 1 }));
const linesFile = () => {
  try { return fs.readFileSync(process.env.RW_FAKE_SETTINGS_FILE, 'utf8'); }
  catch { return ''; }   // 文件不存在 ＝ 没设线（缺省语义）
};
async function answer(sql, params) {
  const s = String(sql);
  if (/FROM settings/.test(s)) {
    const key = params && params[0];
    return key === 'metric_alert_lines' ? [{ svalue: linesFile() }] : [];
  }
  if (/FROM usage_stats/.test(s)) {
    if (/GROUP BY DATE\\(created_at\\)/.test(s)) return [];                        // 按天分布：夹具不造日线
    if (/cache_hit_tokens h/.test(s)) return roundRows;                            // 逐轮读数（C1/C2 的来源）
    return [{ total: 100, runs: 40, convs: 10 }];                                  // 成本聚合（C3）
  }
  if (/FROM audit_log/.test(s)) {
    if (/GROUP BY action/.test(s)) return [{ action: 'prefix:invalidate', n: 3 }, { action: 'prefix:exempt', n: 12 }];
    if (/ORDER BY id DESC/.test(s)) return [{ created_at: '2026-09-17 09:00:00', detail: 'first-round fixture' }];
    if (/SUBSTRING_INDEX/.test(s)) return [{ r: 'first-round', n: 12 }];
    return [];
  }
  if (/^\\s*(SELECT|SHOW|DESCRIBE|EXPLAIN)/i.test(s)) return [];
  return { insertId: 1, affectedRows: 1 };   // 写语句：只给形状，不保存（夹具不碰真库）
}
export const db = { query: answer, run: async () => ({ insertId: 1, affectedRows: 1 }) };
export const pool = {
  query: async (sql, params) => [await answer(sql, params), []],
  execute: async () => [{ insertId: 1, affectedRows: 1 }, []],
};
export async function bumpPolicyRev() { /* 夹具里不落策略版本 */ }
export async function initSchema() { /* 夹具里不建表 */ }
export default { db, pool, bumpPolicyRev, initSchema };
`;

register('data:text/javascript,' + encodeURIComponent(`
export async function initialize() {}
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r && r.url && /[/\\\\]server[/\\\\]db\\.js$/.test(r.url)) {
    return { url: 'data:text/javascript;base64,' + ${JSON.stringify(Buffer.from(FAKE_DB).toString('base64'))}, shortCircuit: true, format: 'module' };
  }
  return r;
}
`));

// 模型：直接出正文（本夹具不验工具/帧，只验摘要端点的读数与告警字段）。
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(u)) {
    return Promise.reject(new Error('[fake-db-shell] 已阻断外部请求（夹具不允许真调模型）: ' + u));
  }
  return realFetch(url, opts);
};
const { chatStreamWithTools } = await import('../server/llm/gateway.js');
chatStreamWithTools.impl = async (provider, model, msgs, defs, opts = {}) => {
  const text = '（离线壳回复）读数夹具。';
  if (opts.onContent) opts.onContent(text);
  return { content: text, reasoning: '', finishReason: 'stop', usage: { tokens_in: 10, tokens_out: 5, cache_hit: 5, cache_miss: 5 }, streamed: false };
};

// 让"这个壳真的生效了"可观测（夹具断言启动日志里有它；钩子没装上就必须判红，而不是悄悄用真实现）
console.log('[fake-db-shell] 已装载：db 换成假实现（读数由夹具给），模型换成离线壳');
