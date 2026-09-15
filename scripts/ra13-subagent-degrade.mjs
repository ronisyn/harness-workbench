// scripts/ra13-subagent-degrade.mjs - RA-13 端到端实测：**真模型**父代理派生一个"注定失败"的子代理，
// 验证"一个子代理失败 → 交付物照出并标注该块数据未取得"。
// 依据《RW-Agent 架构 v1.1》§14.4 RA-13。
//
// 为什么必须真模型：RA-13 验收的是**父代理的装配行为**（它得把取不到的那一块如实写进交付物，
// 而不是静默省略或伪造）。这一行为只能由模型在真实循环里做出来。
//
// 两种失败形态都要测（第一版只测了一种，把另一种误判成失败）：
//   --mode toolfail（默认）：子代理只放 read_file，任务要求读三个不存在的路径 → 工具连续失败。
//       子代理**可以**如实汇报"读不到"并正常收尾（status=done）——这种"诚实的空手而归"同样满足 RA-13；
//   --mode apierr：把子代理的 provider 换成一个没有 key 的厂商 → runAgent 直接抛错 → 走 status=error 分支。
//
// 通过判据（按事实，不按词表）：
//   ① 交付物**如实标注了取不到**（出现失败/未取到/ENOENT 等表述，且逐项说明）
//   ② 没有伪造结论（不得出现与"读取失败"矛盾的成功断言或编造数值）
//   ③ 事件流完整收尾，且父代理确实派了子代理（子代理记录可见、工具面被收窄）
//   ④ （apierr 模式额外）子代理 status=error 且带部分产出
//
// 用法（服务器上）：node scripts/ra13-subagent-degrade.mjs [--mode toolfail|apierr]
import express from 'express';
import { db } from '../server/db.js';
import { runAgent, clearActivity } from '../server/agent.js';
import { subs } from '../server/subagent.js';
import { config } from '../server/config.js';
import { rebuild } from '../src/eventstream.js';

const argv = process.argv.slice(2);
const MODE = (argv.includes('--mode') ? argv[argv.indexOf('--mode') + 1] : 'toolfail');
const PORT = Number(process.env.RA13_PORT || (MODE === 'apierr' ? 3194 : 3193));
const SESSION = 'ra13-' + Date.now().toString(36);
const MODEL = process.env.RA13_MODEL || 'deepseek-v4-flash';
const START = Date.now();

const admin = (await db.query('SELECT id, username FROM accounts ORDER BY id LIMIT 1'))[0];
if (!admin) { console.error('库里没账号'); process.exit(1); }
await db.query('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(), NOW() + INTERVAL 1 DAY)', [SESSION, admin.id]);
const conv = await db.query("INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)",
  [admin.id, MODE === 'apierr' ? '__ra13_apierr__' : '__ra13_degrade__', 'full', 'chat', 'all', 'default']);
const conversationId = conv.insertId;
console.log(`模式=${MODE} 临时会话 conv=${conversationId} 模型=${MODEL} 账号=${admin.username}`);

const PROMPT = MODE === 'apierr'
  ? [
    '请用 subagent 工具派一个子代理去盘点库存，按下面方式派（这是刻意的失败注入，不要试图绕过）：',
    '· model 参数填 kimi-k2-0905-preview（子代理会用与父代理不同的厂商配置）',
    '· tools 参数只给 read_file',
    '· prompt：读取 /tmp/ra13-nonexistent-a.txt 统计各 SKU 备货量；读不到就如实说明',
    '· mode=sync',
    '子代理返回后，整理一份**盘点交付物**：## 库存盘点表 / ## 数据来源与完整性；',
    '哪一块取不到就照实说明，不要替他补数据，也不要省略取不到的部分。',
  ].join('\n')
  : [
    '请用 subagent 工具派一个子代理去盘点库存，**必须**按下面方式派：',
    '· tools 参数只给 read_file（这是刻意的：子代理只允许用这一个工具）',
    '· prompt 里要求它：依次读取 /tmp/ra13-nonexistent-a.txt、/tmp/ra13-nonexistent-b.txt、/tmp/ra13-nonexistent-c.txt',
    '  三个文件来统计各 SKU 备货量；读不到就如实说明读不到，不要编数据',
    '· mode=sync（等它结束）',
    '子代理返回后，请把结果整理成一份**盘点交付物**给我，格式：',
    '## 库存盘点表',
    '（每个 SKU 一行；哪一块取不到就照实说明那一块的情况）',
    '## 数据来源与完整性',
    '（说明哪些数据取到了、哪些没取到、原因是什么）',
    '不要替他补数据，也不要省略取不到的部分。',
  ].join('\n');

const app = express();
app.use(express.json());
app.post('/api/chat', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const chunks = [];
  const send = (o) => { const s = `data: ${JSON.stringify(o)}\n\n`; chunks.push(s); res.write(s); };
  const facts = { toolNames: [], subIds: [] };
  send({ type: 'run_start', v: 1, conversationId, runId: null, light: false, provider: 'deepseek', model: MODEL, preset: 'all', permission: 'full' });
  try {
    const result = await runAgent({
      provider: 'deepseek', model: MODEL, permission: 'full',
      messages: [{ role: 'user', content: PROMPT }],
      ctx: { permission: 'full', accountId: admin.id, conversationId, root: '/', __light: false, preset: 'all', mode: 'chat' },
      keys: config.keys, temperature: 0.2,
      emit: (ev) => {
        if (ev.type === 'delta') send({ type: 'delta', delta: ev.delta });
        else if (ev.type === 'tool_start') { facts.toolNames.push(ev.tool.name); send({ type: 'tool_start', tool: ev.tool }); }
        else if (ev.type === 'tool_done') {
          send({ type: 'tool_done', tool: ev.tool });
          if (/^sub/.test(ev.tool.name) && ev.tool.result) {
            try { const j = JSON.parse(ev.tool.result); if (j.sub_id) facts.subIds.push(j.sub_id); } catch { /* 结果不是 JSON 就跳过 */ }
          }
        } else if (ev.type === 'thinking') send({ type: 'thinking', round: ev.round });
      },
    });
    const answer = result.content || '';
    const r = await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'assistant', answer]);
    send({ type: 'done', usage: result.usage || {}, messageId: r.insertId, totals: result.usageTotals || null });
    send({ type: 'run_end', status: 'saved', messageId: r.insertId, contentLength: answer.length });
    facts.answer = answer;
  } catch (e) {
    send({ type: 'error', message: e.message });
    console.error('[ra13] 父代理执行失败：' + e.message);
    facts.answer = '';
  }
  facts.used = true;
  clearActivity(conversationId);
  res.end();
  app.locals.facts = facts;
});
const server = app.listen(PORT);
const raw = await fetch(`http://127.0.0.1:${PORT}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId }) }).then((r) => r.text());
server.close();
const facts = app.locals.facts || {};
const view = rebuild(raw);
const answer = facts.answer || view.answer || '';

// 子代理记录：按本次运行的 sub_id 精确取（不靠时间猜）
const child = (facts.subIds || []).map((id) => subs.get(id)).filter(Boolean)[0]
  || [...subs.values()].filter((s) => new Date(s.createdAt).getTime() >= START).pop();
console.log('\n=== 子代理记录 ===');
if (child) {
  console.log(`  id=${child.id} status=${child.status} tools=${JSON.stringify(child.tools)}`);
  console.log(`  部分产出长度=${String(child.result || '').length} 失败原因=${(child.error || child.reason || '-').slice(0, 140)}`);
  console.log(`  工具步骤=${JSON.stringify((child.toolLog || []).slice(-5))}`);
} else console.log('  （没有找到子代理记录）');

// ── 判据（按事实）────────────────────────────────────────────────────────────────────────
const ANNOT = /(未取得|取不到|未能取得|无法取得|读取失败|全部失败|ENOENT|不存在|0\/3|未获取到|无任何)/;
const FAKE_OK = /(库存充足|备货量正常|数据正常|盘点完成[，,]\s*各\s*SKU\s*正常|各 SKU 备货量如下)/;
const checks = [];
checks.push(['① 交付物如实标注"取不到"', ANNOT.test(answer), `命中标注词=${(answer.match(ANNOT) || ['-'])[0]}`]);
checks.push(['② 未伪造结论', !FAKE_OK.test(answer), '交付物里没有与"读取失败"矛盾的成功断言']);
checks.push(['③ 事件流完整收尾', raw.includes('"type":"done"') && answer.length > 0, `done=${raw.includes('"type":"done"')} 交付物长度=${answer.length}`]);
checks.push(['④ 确实派了子代理且工具面收窄', Boolean(child) && Array.isArray(child.tools) && child.tools.length === 1, child ? `tools=${JSON.stringify(child.tools)} 子代理工具步骤 ${(child.toolLog || []).length} 步` : '无子代理记录']);
if (MODE === 'apierr') {
  // 注：这一支**不要求**有部分产出——子代理在第一次 LLM 调用就抛错时确实什么都没产出；
  // 关键是"走到 error 分支且被如实回传"，而不是硬凑出内容。
  checks.push(['⑤ 子代理走到 error 分支并被如实回传', Boolean(child) && child.status === 'error', child ? `status=${child.status} 失败原因=${String(child.error || '').slice(0, 60)}` : '-']);
}
console.log('\n=== RA-13 判据 ===');
for (const [name, ok, detail] of checks) console.log(`${ok ? '  ✅' : '  ❌'} ${name} — ${detail}`);
const verdict = checks.every(([, ok]) => ok);
console.log(`\n判定（${MODE}）：${verdict ? '**通过**（失败被照出并标注，未伪造）' : '**未通过**'}`);
console.log('\n--- 交付物（原样，前 1800 字）---\n' + answer.slice(0, 1800));

// ── 清理 ────────────────────────────────────────────────────────────────────────────────
for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [conversationId]);
await db.query('DELETE FROM conversations WHERE id=?', [conversationId]);
await db.query('DELETE FROM sessions WHERE token=?', [SESSION]);
await db.query('DELETE FROM audit_log WHERE conversation_id=?', [conversationId]);
const left = (await db.query('SELECT COUNT(*) n FROM messages WHERE conversation_id=?', [conversationId]))[0];
console.log(`\n清理后残留 messages=${left.n}`);
process.exit(verdict ? 0 : 1);
