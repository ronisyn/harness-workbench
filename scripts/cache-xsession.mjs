// scripts/cache-xsession.mjs - 跨会话前缀复用实验（RA-35 措施① 的对照实验）
//
// 问题：新会话的第一个请求，能不能复用"上一个会话已经发给厂商的那份前缀"？
//   · 前缀 = 系统提示 + 工具面 + 环境块（实测 ≈10.5k tokens）
//   · 若能复用 → 首请求命中率应当很高；若每次都 33% → 前缀里还有随会话变化的字节
//
// 方法（对照实验，不依赖真实等待）：
//   用桩网关记录**每次请求的 messages[0]（系统提示）哈希**与真实 usage，
//   然后连续开两个**全新会话**跑同一个问题，比较两个会话首请求的命中率与系统提示哈希。
//   · 哈希相同 + 首请求命中率高 ⇒ 前缀已稳定（措施①生效）
//   · 哈希相同但命中率仍低 ⇒ 前缀稳定了，但厂商侧没跨会话复用（另有原因，如缓存按 prompt 前缀 + 会话隔离）
//   · 哈希不同 ⇒ 前缀里还有易变内容（继续审计）
//
// 用法（服务器上）：node scripts/cache-xsession.mjs [--model deepseek-v4-flash]
import express from 'express';
import { db } from '../server/db.js';
import { runAgent, clearActivity } from '../server/agent.js';
import { chatStreamWithTools } from '../server/llm/gateway.js';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'deepseek-v4-flash';
const PORT = 3195;
const SESSION = 'xss-' + Date.now().toString(36);
const admin = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
await db.query('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?,?,NOW(), NOW() + INTERVAL 1 DAY)', [SESSION, admin.id]);

// 桩网关：记录系统提示哈希，然后调用**真实**网关（这样才能拿到真实的 cache 命中数据）
const real = chatStreamWithTools;
const seen = [];
chatStreamWithTools.impl = async (provider, model, msgs, defs, keys, opts) => {
  const sys = msgs.filter((m) => m.role === 'system').map((m) => String(m.content || ''));
  const toolsJson = JSON.stringify(defs || []);
  seen.push({
    sysHash: createHash('sha256').update(sys.join('\u0000')).digest('hex').slice(0, 12),
    sysChars: sys.join('').length,
    sysCount: sys.length,
    toolsHash: createHash('sha256').update(toolsJson).digest('hex').slice(0, 12),
    toolsCount: (defs || []).length,
  });
  return real(provider, model, msgs, defs, keys, opts);
};

const QUESTION = '请用一句话说明你是谁。';

async function runOnce(label) {
  const conv = await db.query("INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)",
    [admin.id, '__xsession_probe__', 'read', 'chat', 'all', 'default']);
  const conversationId = conv.insertId;
  const before = seen.length;
  const result = await runAgent({
    provider: 'deepseek', model: MODEL, permission: 'read',
    messages: [{ role: 'user', content: QUESTION }],
    ctx: { permission: 'read', accountId: admin.id, conversationId, root: '/', __light: false, preset: 'all', mode: 'chat' },
    keys: (await import('../server/config.js')).config.keys, temperature: 0,
  });
  const round = (await db.query(`SELECT cache_hit_tokens hit, cache_miss_tokens miss, tokens_in tin, tokens_out tout, cost
                                 FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id LIMIT 1`, [conversationId]))[0];
  const rate = round && (Number(round.hit) + Number(round.miss)) > 0 ? Number(round.hit) / (Number(round.hit) + Number(round.miss)) : null;
  const s = seen[before];
  console.log(`\n[${label}] conv=${conversationId}`);
  console.log(`  系统提示：${s ? s.sysCount + ' 段 / ' + s.sysChars + ' 字符 / hash=' + s.sysHash : '（未记录）'}`);
  console.log(`  工具面　：${s ? s.toolsCount + ' 个 / hash=' + s.toolsHash : '-'}`);
  console.log(`  首请求　：命中 ${round ? round.hit : '-'} / 未命中 ${round ? round.miss : '-'} / 输入 ${round ? round.tin : '-'}  → 命中率 ${rate == null ? '-' : (rate * 100).toFixed(2) + '%'}　¥${round ? round.cost : '-'}`);
  console.log(`  回答　　：${String(result.content || '').replace(/\s+/g, ' ').slice(0, 60)}`);
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [conversationId]);
  await db.query('DELETE FROM conversations WHERE id=?', [conversationId]);
  await db.query('DELETE FROM audit_log WHERE conversation_id=?', [conversationId]);
  return { rate, sys: s, conversationId };
}

console.log(`模型=${MODEL}　连续两次**全新会话**（同一问题、同一 preset），看首请求能否复用上一个会话的前缀`);
const a = await runOnce('会话A');
const b = await runOnce('会话B');

console.log('\n=== 结论 ===');
const same = a.sys && b.sys && a.sys.sysHash === b.sys.sysHash && a.sys.toolsHash === b.sys.toolsHash;
console.log(`  两次的系统提示 + 工具面哈希：${same ? '**完全相同** ✅（前缀已稳定）' : '**不同** ❌（前缀里仍有易变内容，需继续审计）'}`);
console.log(`  首请求命中率：A ${a.rate == null ? '-' : (a.rate * 100).toFixed(2) + '%'} → B ${b.rate == null ? '-' : (b.rate * 100).toFixed(2) + '%'}`);
if (same && b.rate != null && b.rate >= 0.9) console.log('  ⇒ **跨会话前缀复用已生效**（B 的首请求直接命中了 A 建好的前缀）');
else if (same) console.log('  ⇒ 前缀稳定但命中率仍低：说明"厂商侧没有把这份前缀跨会话缓存"（可能按 prompt 前缀 + 账号/TTL 隔离），需另行验证');
else console.log('  ⇒ 先消除前缀差异，再重复本实验');
await db.query('DELETE FROM sessions WHERE token=?', [SESSION]);
process.exit(0);
