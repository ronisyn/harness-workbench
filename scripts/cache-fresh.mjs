// scripts/cache-fresh.mjs - "一条全新对话，从 0 开始"到底是多少（真跑，不看历史）
//
// 为什么要有这个脚本（2026-09-15 用户指出）：
//   我此前报的"最近 400 轮中位 87.95%"是把**破窗期**（09-09/09-10，每轮未命中 4.6 万）的轮次混进了窗口——
//   那是历史欠账，不是现在的机制。用户的要求很直白：**别管过去几百次对话，开一条全新的，从 0 开始量。**
//   所以本脚本就是干这个的：真开一条新会话、跑 N 轮真活、逐轮报数。
//
// 判读方式（重要）：
//   · 第 1 轮 = 冷启动轮，但它**不该是 0%** —— 规范前缀（系统提示+工具面）跨会话共享，
//     第一次请求就命中它；这一轮只该为"这条会话自己的新内容"付全价。
//   · 第 2 轮起 = 稳态轮，命中率应接近"上一轮输入 ÷（上一轮输入 + 本轮新增）"。
//   · 未命中 tokens 在稳态下≈**每轮新增**（这正是"省不省钱"的直接来源，也是唯一值得盯的工程量）。
//
// 用法：node scripts/cache-fresh.mjs [--rounds 6] [--model deepseek-v4-flash] [--keep]
import { db } from '../server/db.js';
import { runAgent } from '../server/agent.js';
import { config } from '../server/config.js';

const argv = process.argv.slice(2);
const num = (f, d) => (argv.includes(f) ? Number(argv[argv.indexOf(f) + 1]) : d);
const ROUNDS = num('--rounds', 6);
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'deepseek-v4-flash';
const KEEP = argv.includes('--keep');
const WS = '/srv/rw-workspace/tmp/fresh-probe';

const admin = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
const c = await db.query("INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)",
  [admin.id, '__cache_fresh__', 'full', 'chat', 'all', 'default']);
const cid = c.insertId;
console.log(`模型=${MODEL}　轮数=${ROUNDS}　全新会话 conv=${cid}（标题命中探针族，不进任何口径）\n`);

// 六轮"小而真"的活：每轮都有真实工具结果（体积接近日常中位数），能反映稳态
const TASKS = [
  `在 ${WS} 下建目录并写一个文件 a.mjs，内容：export const a = 1;  只做这一件事。`,
  `用 read_file 读回 ${WS}/a.mjs 确认内容。`,
  `用 list_dir 列出 ${WS} 目录。`,
  `把 ${WS}/a.mjs 里的 1 改成 2。`,
  `用 run_command 跑 node --check ${WS}/a.mjs，把输出原样告诉我。`,
  `一句话总结刚才做了什么。`,
];

const rows = [];
for (let i = 0; i < Math.min(ROUNDS, TASKS.length); i++) {
  const t0 = Date.now();
  await runAgent({
    provider: 'deepseek', model: MODEL, permission: 'full',
    messages: [{ role: 'user', content: TASKS[i] }],
    ctx: { permission: 'full', accountId: admin.id, conversationId: cid, root: '/', __light: false, preset: 'all', mode: 'chat' },
    keys: config.keys, temperature: 0,
  });
  const r = (await db.query("SELECT tokens_in tin, cache_hit_tokens h, cache_miss_tokens m, cost, prefix_tools_hash t FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id DESC LIMIT 1", [cid]))[0] || {};
  const tin = Number(r.tin || 0), h = Number(r.h || 0), m = Number(r.m || 0);
  rows.push({ i: i + 1, tin, h, m, rate: tin > 0 ? h / tin : null, cost: Number(r.cost || 0), tools: r.t, ms: Date.now() - t0 });
}

console.log('轮   输入      命中      未命中   命中率     本轮新增≈未命中   成本      工具面');
for (const r of rows) {
  console.log(
    String(r.i).padStart(2) + '  ' + String(r.tin).padStart(7) + '  ' + String(r.h).padStart(8) + '  ' + String(r.m).padStart(7)
    + '  ' + ((r.rate * 100).toFixed(2) + '%').padStart(7) + '  ' + String(r.m).padStart(15)
    + '   ¥' + r.cost.toFixed(4) + '   ' + r.tools);
}
const warm = rows.slice(1);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const H = rows.reduce((s, r) => s + r.h, 0), M = rows.reduce((s, r) => s + r.m, 0);
console.log('\n== 结论（只看这一条新会话，不掺任何历史）==');
console.log('  第 1 轮（冷启动轮）命中率 = ' + (rows[0].rate * 100).toFixed(2) + '%　未命中 ' + rows[0].m + ' tokens（= 这条会话自己的新内容，不是"前缀全废"）');
if (warm.length) {
  console.log('  第 2 轮起（稳态）命中率：中位 ' + (med(warm.map((r) => r.rate)) * 100).toFixed(2) + '%　最好 ' + (Math.max(...warm.map((r) => r.rate)) * 100).toFixed(2) + '%　最差 ' + (Math.min(...warm.map((r) => r.rate)) * 100).toFixed(2) + '%');
  console.log('  稳态每轮新增（≈未命中）：中位 ' + med(warm.map((r) => r.m)) + ' tokens　最大 ' + Math.max(...warm.map((r) => r.m)));
}
console.log('  本会话累计命中率（DSH 右下角那个口径）= ' + ((H / (H + M)) * 100).toFixed(2) + '%（' + H + '/' + (H + M) + '）');
console.log('  全程成本 ¥' + rows.reduce((s, r) => s + r.cost, 0).toFixed(4));

// 与库内"最近窗口"对照：只用**最近 48 小时**新建的会话，避免把破窗期混进来
const recent = await db.query(`
  SELECT u.conversation_id cid, u.tokens_in tin, u.cache_hit_tokens h, u.cache_miss_tokens m
    FROM usage_stats u JOIN conversations c ON c.id=u.conversation_id
   WHERE u.kind='round' AND u.created_at >= NOW() - INTERVAL 48 HOUR
     AND (c.title NOT REGEXP '^(__.*__|ST-|B[1-7](-|[A-Z]|$)|PROBE$)')
     AND u.tokens_in > 0`);
const rr = recent.filter((r) => Number(r.h) + Number(r.m) > 0).map((r) => Number(r.h) / (Number(r.h) + Number(r.m)));
if (rr.length) {
  console.log('\n== 对照：最近 48 小时新建会话的全部轮次（已排除探针）==');
  console.log('  轮次 ' + rr.length + '　每请求命中率 中位 ' + (med(rr) * 100).toFixed(2) + '%　P90 ' + ([...rr].sort((a, b) => a - b)[Math.min(rr.length - 1, Math.ceil(0.9 * rr.length) - 1)] * 100).toFixed(2) + '%');
  console.log('  每轮新增（未命中）中位 ' + med(recent.map((r) => Number(r.m))) + ' tokens');
} else console.log('\n（最近 48 小时没有非探针会话轮次可对照）');

if (!KEEP) {
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [cid]);
  await db.query('DELETE FROM audit_log WHERE conversation_id=?', [cid]);
  await db.query('DELETE FROM conversations WHERE id=?', [cid]);
  console.log('\n（探针会话已清理；加 --keep 可保留）');
} else console.log('\n（已保留探针会话 conv=' + cid + '）');
process.exit(0);
