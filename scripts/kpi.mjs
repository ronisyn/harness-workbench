#!/usr/bin/env node
// scripts/kpi.mjs - RW KPI 报告与基线快照（WS0 度量基线；口径见 docs/RW撑竿跳方案.md §0.2）
// 用法: node scripts/kpi.mjs [--days 7] [--json] [--save docs/metrics/baseline-YYYYMMDD.json]
// 直连 MySQL（复用 server/db.js，读仓库 .env）；需在服务器或可达 DB 的环境运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] || '') : null; };
const DAYS = Number(val('days')) || 7;
const AS_JSON = args.includes('--json');
const SAVE = val('save'); // 相对 ROOT 或绝对
const out = { generatedAt: new Date().toISOString(), days: DAYS };

async function rows(sql, p) {
  try { return await db.query(sql, p); }
  catch (e) { console.error('[kpi] DB 查询失败: ' + e.message + '\n提示：需在服务器（/srv/harness-workbench）或可连 MySQL 的环境运行。'); process.exit(2); }
}
const mid = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2 * 100) / 100; };
const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100 : 0;

// ---------- 基础：期内用量 ----------
const usage = await rows('SELECT COUNT(*) c, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cost),0) cost FROM usage_stats WHERE created_at > NOW() - INTERVAL ? DAY', [DAYS]);
out.usage = { llmRounds: usage[0].c, tokensIn: Number(usage[0].tin), tokensOut: Number(usage[0].tout), cost: Number(usage[0].cost) };

// ---------- KPI2 任务级步数/成本（按 agent_runs 归集；WS0 挂 run 后生效） ----------
const runs = await rows(
  `SELECT r.id, r.conversation_id, r.status, COALESCE(r.rounds,0) rounds, r.started_at,
          COALESCE(SUM(u.tokens_in),0) tin, COALESCE(SUM(u.tokens_out),0) tout, COALESCE(SUM(u.cost),0) cost
   FROM agent_runs r LEFT JOIN usage_stats u ON u.agent_run_id = r.id
   WHERE r.started_at > NOW() - INTERVAL ? DAY GROUP BY r.id ORDER BY r.id`, [DAYS]);
const statusDist = {};
for (const r of runs) statusDist[r.status] = (statusDist[r.status] || 0) + 1;
out.kpi2 = {
  tasks: runs.length, statusDist,
  medianRounds: mid(runs.map((r) => r.rounds || 0)),
  avgRounds: avg(runs.map((r) => r.rounds || 0)),
  medianCost: mid(runs.map((r) => Number(r.cost))),
  avgCost: avg(runs.map((r) => Number(r.cost))),
};
// 未挂 run 的 round 行（driver/scheduler 契约会话与存量数据）→ 按会话回退归集，防成本悬空
const orphan = await rows(
  `SELECT u.conversation_id, COUNT(*) c, COALESCE(SUM(u.cost),0) cost
   FROM usage_stats u LEFT JOIN agent_runs r ON u.agent_run_id = r.id
   WHERE u.kind='round' AND u.agent_run_id IS NULL AND u.created_at > NOW() - INTERVAL ? DAY
   GROUP BY u.conversation_id ORDER BY cost DESC LIMIT 10`, [DAYS]);
out.orphanRounds = { convs: orphan.length, topByCost: orphan.map((x) => ({ conversationId: x.conversation_id, rounds: x.c, cost: Number(x.cost) })) };

// ---------- KPI1 打回率（口径 §0.2：强词，finish_task 后 7 天内同会话用户消息） ----------
const STRONG = /打回|重做|重新做|推翻|返工|不通过|没达到|再来一遍/;
const finished = await rows(
  `SELECT conversation_id, MIN(created_at) t0 FROM tool_calls
   WHERE tool_name='finish_task' AND status='done' AND created_at > NOW() - INTERVAL ? DAY
   GROUP BY conversation_id LIMIT 300`, [DAYS]);
let rejected = 0;
const rejectedConvs = [];
for (const f of finished) {
  const msgs = await rows(
    `SELECT content FROM messages WHERE conversation_id=? AND role='user'
     AND created_at > ? AND created_at < DATE_ADD(?, INTERVAL 7 DAY) ORDER BY id ASC LIMIT 50`,
    [f.conversation_id, f.t0, f.t0]);
  if (msgs.some((m) => STRONG.test(String(m.content || '')))) { rejected++; rejectedConvs.push(f.conversation_id); }
}
out.kpi1 = { submissions: finished.length, rejected, rate: finished.length ? Math.round(rejected / finished.length * 1000) / 10 : 0, rejectedConvs };

// ---------- KPI3 自审闭环率（打回会话有"打回复盘:"沉淀） ----------
let closed = 0;
for (const convId of rejectedConvs) {
  const kb = await rows(`SELECT COUNT(*) c FROM knowledge WHERE title LIKE '打回复盘:%' AND (conversation_id=? OR scope='global')`, [convId]);
  if (kb[0].c > 0) closed++;
}
out.kpi3 = { rejected: rejectedConvs.length, closed, rate: rejectedConvs.length ? Math.round(closed / rejectedConvs.length * 1000) / 10 : null };

// ---------- KPI4 沉淀增长率 ----------
const kbNew = await rows('SELECT COUNT(*) c FROM knowledge WHERE created_at > NOW() - INTERVAL ? DAY', [DAYS]);
const kbReuse = await rows(`SELECT COUNT(*) c FROM tool_calls WHERE tool_name IN ('skill_load','kb_search') AND created_at > NOW() - INTERVAL ? DAY`, [DAYS]);
let skillNew = 0;
try {
  const skillsRoot = process.env.RW_SKILLS || path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', 'skills');
  const since = Date.now() - DAYS * 86400000;
  const walk = (d) => { let n = 0; for (const it of fs.readdirSync(d, { withFileTypes: true })) { if (it.isDirectory()) n += walk(path.join(d, it.name)); else if (it.name === 'SKILL.md' && fs.statSync(path.join(d, it.name)).mtimeMs > since) n++; } return n; };
  skillNew = walk(skillsRoot);
} catch { skillNew = -1; } // 本地无技能目录时 -1=不可用，不误报 0
out.kpi4 = { kbNew: kbNew[0].c, skillNew, skillAndKbReuse: kbReuse[0].c };

// ---------- KPI5 事故率（口径 §0.2：失控类；guard 挂起单列不计事故） ----------
const paused = await rows(`SELECT COUNT(*) c FROM agent_runs WHERE status='paused' AND started_at > NOW() - INTERVAL ? DAY`, [DAYS]);
const guard = await rows(`SELECT COUNT(*) c FROM agent_runs WHERE status='interrupted' AND started_at > NOW() - INTERVAL ? DAY AND (reason LIKE '%预算%' OR reason LIKE '%上限%' OR reason LIKE '%停止%' OR reason LIKE '%重启%')`, [DAYS]);
const silent = await rows(`SELECT COUNT(*) c FROM messages WHERE role='assistant' AND content LIKE '（任务执行完成）本轮共%' AND created_at > NOW() - INTERVAL ? DAY`, [DAYS]);
const danger = await rows(`SELECT COUNT(*) c FROM tool_calls WHERE tool_name IN ('db_write','git_pull_push','delete_file') AND created_at > NOW() - INTERVAL ? DAY`, [DAYS]);
// 假继续检测（v1 近似口径，附录A #35）：assistant 消息命中"承诺动手"表达、该条无工具调用归属、
// 且该会话在此后无任何工具调用或 finish_task（=承诺后停滞）→ 计一次
const COMMIT_RE = /(我(?:来|会|将|现在|马上|先|这就)(?:去|就|要)?(?:执行|动手|开始|检查|修复|写|建|改|查|跑|调|测|部署|处理))|(?:现在就(?:去|开始|动手))|(?:继续任务|继续执行)/;
const commitCand = await rows(
  `SELECT id, conversation_id, content, created_at FROM messages
   WHERE role='assistant' AND created_at > NOW() - INTERVAL ? DAY
     AND (content LIKE '%执行%' OR content LIKE '%动手%' OR content LIKE '%我来%' OR content LIKE '%开始%' OR content LIKE '%继续%' OR content LIKE '%检查%' OR content LIKE '%修复%' OR content LIKE '%部署%')
   ORDER BY id DESC LIMIT 400`, [DAYS]);
let fakeContinue = 0;
const fcConvs = new Set();
for (const c of commitCand) {
  if (!COMMIT_RE.test(String(c.content || ''))) continue;
  // 该条消息是否被工具轨迹归属（本轮有真工具动作）
  const own = await rows('SELECT COUNT(*) c FROM tool_calls WHERE message_id=?', [c.id]);
  if (own[0].c > 0) continue;
  // 该会话此后（时间序）是否有任何工具调用或 finish_task
  const after = await rows(`SELECT COUNT(*) c FROM tool_calls WHERE conversation_id=? AND created_at > ?`, [c.conversation_id, c.created_at]);
  if (after[0].c > 0) continue;
  fakeContinue++; fcConvs.add(c.conversation_id);
}
out.kpi5 = { runawayPaused: paused[0].c, silentWrapup: silent[0].c, fakeContinue, guardSuspends_normal: guard[0].c, dangerToolCalls: danger[0].c, fcConvs: [...fcConvs].slice(0, 10) };

// ---------- 工具健康度榜 ----------
const tools = await rows(
  `SELECT tool_name, COUNT(*) n, SUM(status='fail') fails, ROUND(AVG(duration_ms)) avg_ms
   FROM tool_calls WHERE created_at > NOW() - INTERVAL ? DAY GROUP BY tool_name ORDER BY n DESC LIMIT 20`, [DAYS]);
out.toolHealth = tools.map((t) => ({ tool: t.tool_name, calls: t.n, fails: Number(t.fails || 0), avgMs: Number(t.avg_ms || 0) }));

// ---------- 输出 ----------
if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
else {
  const L = [];
  L.push(`=== RW KPI（近 ${DAYS} 天）===`);
  L.push(`用量: ${out.usage.llmRounds} LLM轮 / in ${out.usage.tokensIn} / out ${out.usage.tokensOut} / ¥${out.usage.cost.toFixed(4)}`);
  L.push(`KPI1 打回率: ${out.kpi1.rejected}/${out.kpi1.submissions} = ${out.kpi1.rate}%`);
  L.push(`KPI2 任务(${out.kpi2.tasks}): 轮数中位 ${out.kpi2.medianRounds} / 均 ${out.kpi2.avgRounds}；成本中位 ¥${out.kpi2.medianCost} / 均 ¥${out.kpi2.avgCost}`);
  L.push(`     状态分布: ${JSON.stringify(out.kpi2.statusDist)}${out.orphanRounds.convs ? `；未挂run会话 ${out.orphanRounds.convs} 个（成本 top: ${out.orphanRounds.topByCost.map((x) => '#' + x.conversationId + ' ¥' + x.cost.toFixed(3)).join(' ') }）` : ''}`);
  L.push(`KPI3 自审闭环: ${out.kpi3.closed}/${out.kpi3.rejected}${out.kpi3.rate === null ? '' : ' = ' + out.kpi3.rate + '%'}`);
  L.push(`KPI4 沉淀: kb新增 ${out.kpi4.kbNew} / 技能新增 ${out.kpi4.skillNew < 0 ? '(目录不可用)' : out.kpi4.skillNew} / 复用 ${out.kpi4.skillAndKbReuse}`);
  L.push(`KPI5 事故: 失控挂起 ${out.kpi5.runawayPaused} / 空答兜底 ${out.kpi5.silentWrapup} / 假继续 ${out.kpi5.fakeContinue}（guard正常挂起 ${out.kpi5.guardSuspends_normal} 不计；高危工具 ${out.kpi5.dangerToolCalls} 次单列）`);
  L.push(`工具榜 top${Math.min(out.toolHealth.length, 8)}: ${out.toolHealth.slice(0, 8).map((t) => t.tool + '×' + t.calls + (t.fails ? '(fail' + t.fails + ')' : '')).join(' ')}`);
  console.log(L.join('\n'));
}
if (SAVE) {
  const p = path.isAbsolute(SAVE) ? SAVE : path.join(ROOT, SAVE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n[saved] ' + p);
}
