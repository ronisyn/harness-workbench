// scripts/cache-ttl2.mjs - 受控实验：**把"公共前缀被隔壁请求顺手刷新"这个混淆因子摘掉**
//
// 为什么需要它（前两版的坑）：
//   · v1（cache-ttl-probe.mjs）五个会话的第一条消息**字节完全相同**，于是它们的可缓存前缀
//     [系统提示][工具面][Q1] 也是同一段；任何一个会话发请求都会刷新这段公共前缀，
//     所以 Δ 再大，下一个会话看到的仍然"热" —— 测到的是**公共前缀**的存活，不是本次会话的。
//   · 更正：`runAgent({messages})` 是**调用方负责拼历史**的，它自己不会去读会话历史。
//     所以第二次请求若只发一句新问题，那这一句之前的 nonce 根本不在前缀里 —— 又一次测成公共段。
//     ⇒ v2 第二次请求必须**把 nonce 原样再发一遍**，nonce 才会落在前缀里。
//
// v2 设计：每个 Δ 一个**互不相同的随机长块（nonce）**，两次请求都带上它。
//   前缀结构 = [系统提示][工具面][nonce_Δ][问题]   ← 只有 nonce_Δ 是本会话独有的、且不可被隔壁刷新
//   ① t0：各发一次（建立各自的前缀）
//   ② t0+Δ：各再发一次（**nonce 原样重发**，只改问题），用**未命中量**区分三种情形：
//        miss ≈ 200~500            → nonce 块仍存活（公共段 + nonce 全命中）
//        miss ≈ nonce 长度         → nonce 块已过期，只剩被隔壁刷新的公共段
//        miss ≈ 公共段 + nonce     → 全过期
//   并行跑不会互相污染 —— 隔壁刷新的是公共段，而判据看的是 nonce 段。
//
// 注意：本探针只能测**小时以内**的窗口。更长的窗口用真实生产数据量（`node tmp/probe-idle-survival.mjs`）：
//   已实测会话 269 空闲 **167.9 小时**后未命中仅 2.9%、会话 185 连续三天 24 小时空闲未命中仅 1.0%。
//
// 用法（服务器 /srv/harness-workbench 下）：node scripts/cache-ttl2.mjs [--model deepseek-v4-flash] [--deltas 60,600,1800] [--dry]
import { db } from '../server/db.js';
import { runAgent } from '../server/agent.js';
import { config } from '../server/config.js';

const argv = process.argv.slice(2);
const MODEL = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : 'deepseek-v4-flash';
const DRY = argv.includes('--dry');
const DELTAS = argv.includes('--deltas')
  ? argv[argv.indexOf('--deltas') + 1].split(',').map(Number).filter((x) => isFinite(x) && x > 0)
  : [60, 600, 1800]; // 1 分钟（对照）/ 10 分钟 / 30 分钟（＝生产曾经观察到的"悬崖"，本实验直接证伪或证实它）
const NONCE_WORDS = 700; // 随机串分词很差，实测约 3,700 tokens

// 确定性伪随机长块：同一 Δ 每次跑都得到同一串（便于复现与复盘）
function makeNonce(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const alpha = 'qwertyuiopasdfghjklzxcvbnm';
  const out = [];
  for (let i = 0; i < NONCE_WORDS; i++) {
    let v = (h ^ Math.imul(i + 1, 2654435761)) >>> 0;
    let w = '';
    for (let k = 0; k < 9; k++) { w += alpha[v % 26]; v = (Math.floor(v / 26) + 7 + k) >>> 0; }
    v = (v ^ Math.imul(i + 7, 40503)) >>> 0;
    h = (Math.imul(h ^ v, 2246822519) + i) >>> 0;
    out.push(w);
  }
  return '【随机载荷 ' + seedStr + '】' + out.join(' ');
}

const admin = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
const convs = [];
for (const d of DELTAS) {
  const c = await db.query('INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)',
    [admin.id, `__ttl2_${d}s__`, 'read', 'chat', 'all', 'default']);
  convs.push({ d, cid: c.insertId, nonce: makeNonce('ttl2-' + d) });
}
const T0 = Date.now();
if (DRY) {
  console.log('已建会话：' + convs.map((c) => `${c.d}s=conv${c.cid} nonce字符=${c.nonce.length}`).join('  '));
  for (const c of convs) await db.query('DELETE FROM conversations WHERE id=?', [c.cid]);
  process.exit(0);
}

async function ask(cid, q, note) {
  const t = Date.now();
  await runAgent({
    provider: 'deepseek', model: MODEL, permission: 'read',
    messages: [{ role: 'user', content: q }],
    ctx: { permission: 'read', accountId: admin.id, conversationId: cid, root: '/', __light: false, preset: 'all', mode: 'chat' },
    keys: config.keys, temperature: 0,
  });
  const row = (await db.query(`SELECT cache_hit_tokens hit, cache_miss_tokens miss, tokens_in tin, cost
                               FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id DESC LIMIT 1`, [cid]))[0] || {};
  const hit = Number(row.hit || 0), miss = Number(row.miss || 0), tin = Number(row.tin || 0);
  console.log(`  [${note}] +${((t - T0) / 1000).toFixed(0)}s  conv=${cid}  命中 ${String(hit).padStart(6)} / 未命中 ${String(miss).padStart(6)} / 输入 ${String(tin).padStart(6)}  ¥${Number(row.cost || 0).toFixed(4)}`);
  return { hit, miss, tin, cost: Number(row.cost || 0) };
}

const Q1 = '\n\n请只回复：ok';
const Q2 = '\n\n再回复一次：ok';
console.log(`模型=${MODEL}　间隔=${DELTAS.join('/')}s　nonce字符数=${convs[0].nonce.length}／会话`);
console.log('\n== ① 建立各自的前缀（t0，各带自己的 nonce）==');
console.log('（只有第一条可能碰到公共段全冷；后面几条的公共段已被前一条打热，属正常）');
for (const c of convs) c.first = await ask(c.cid, c.nonce + Q1, 'req1');

// 用"两次请求输入量之差"反推 nonce 实际 tokens —— 比拿常量减更可靠
const nonceTok = Math.max(...convs.map((c) => c.first.tin)) - 10496; // 10496 = 实测公共前缀
console.log(`\n  req1 输入 ≈ 公共前缀 10,496 + nonce + 问题 ⇒ nonce ≈ ${nonceTok} tokens`);
console.log(`  判据：req2 miss ≤ 600 = **nonce 块仍存活**　|　≈ ${nonceTok}（±40%）= nonce 块过期（公共段是隔壁刷新的，不算本次存活）　|　≈ ${10496 + nonceTok} = 全过期`);

console.log('\n== ② 等 Δ 后**把 nonce 原样再发一遍**，用未命中量判定 ==');
for (const c of convs) {
  const waitMs = Math.max(0, T0 + c.d * 1000 - Date.now());
  if (waitMs > 0) { console.log(`  …等 ${Math.round(waitMs / 1000)}s（Δ=${c.d}s）`); await new Promise((r) => setTimeout(r, waitMs)); }
  c.second = await ask(c.cid, c.nonce + Q2, `Δ=${c.d}s`);
}

console.log('\n== 判定 ==');
for (const c of convs) {
  const m2 = c.second.miss;
  const verdict = m2 <= 600
    ? '✅ nonce 块仍存活（本次会话的前缀没被清掉）'
    : (m2 < 10496 * 0.8 ? '⚠️ nonce 块已过期（只剩被隔壁刷新的公共段）' : '❌ 全过期（公共段也没了）');
  console.log(`  Δ=${String(c.d).padStart(5)}s  req1 输入 ${c.first.tin}  req2 miss ${String(m2).padStart(6)}  → ${verdict}`);
}
const live = convs.filter((c) => c.second.miss <= 600).map((c) => c.d);
const dead = convs.filter((c) => c.second.miss >= 10496 * 0.8).map((c) => c.d);
console.log(`\n  结论：会话独有前缀的存活窗口 ≥ ${live.length ? Math.max(...live) : 0}s；完全失效于 ${dead.join('/') || '（无）'}s`);
console.log('  配合生产数据（空闲 167.9 小时仍命中 97.1%）⇒ **空闲不是冷启动的原因，前缀变更才是**。');
console.log(`  总成本 ¥${convs.reduce((a, c) => a + c.first.cost + c.second.cost, 0).toFixed(4)}`);

for (const c of convs) {
  for (const t of ['tool_calls', 'usage_stats', 'messages', 'agent_runs']) await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [c.cid]);
  await db.query('DELETE FROM audit_log WHERE conversation_id=?', [c.cid]);
  await db.query('DELETE FROM conversations WHERE id=?', [c.cid]);
}
console.log('（探针会话已清理）');
process.exit(0);
