// scripts/c1-ceiling.mjs - RA-35 判据拆解（只读）：把 C1 的缺口拆成"结构地板"与"可省失效"
// ── 口径与上界（2026-09-15 更正：早前写的"首轮必然 100% 未命中"是**错的**）─────────────────
// 实测（conv=633，真实人发起 2 轮）：第 1 轮 命中 10,496 / 未命中 707 —— 首轮就命中了，
// 因为**固定前缀（系统提示 + 工具面 + 环境块 ≈ 10.5k）是跨会话共享的**，第一次请求就命中它。
// 因此正确的上界按"每轮输入里有多少是上一轮已出现过的内容"算：
//     hit_t  = in_{t-1}          （上一轮输入在本轮原样重现 → 可命中）
//     in_t   = in_{t-1} + m_t    （上下文只追加；m_t = 本轮固有新增：用户消息 + 上轮模型输出 + 本轮工具结果）
//     C1_max(会话) = Σhit / Σin  ← 随轮数单调升高，**受模型窗口封顶**
// 下面这个 `1 − 会话数/总轮数` 只是"若首轮全 miss 且此前无任何共享前缀"的**下界式粗估**，
// 现在只作为"冷启动占比"的参考指标，**不再当作上界**（实际首轮命中率远高于 0）。
export const coldStartShare = (convs, rounds) => (rounds > 0 ? convs / rounds : null);

/**
 * 按实测参数递推 C1 上界（与平台实现一致：只追加、上一轮输入即本轮可命中部分）。
 * @param {number} prefix 固定前缀 tokens（实测 ≈10,496）
 * @param {number} perRound 每轮固有新增 tokens（实测 ≈1,772）
 * @param {number} N 轮数
 */
export const c1Ceiling = (prefix, perRound, N) => {
  if (N <= 0) return null;
  let inPrev = prefix + perRound, H = prefix, M = perRound;
  for (let t = 2; t <= N; t++) { H += inPrev; M += perRound; inPrev += perRound; }
  return H / (H + M);
};
// 用法：node scripts/c1-ceiling.mjs
import { db } from '../server/db.js';
import { COHORTS, HUMAN_WHERE, SCHEDULED_WHERE, PROBE_WHERE, REAL_WHERE, SAMPLE_WHERE } from './cohort.mjs';

const q = async (sql, p = []) => { try { return await db.query(sql, p); } catch (e) { return [{ __err: e.message }]; } };
const pct = (x) => (x == null || !isFinite(x) ? '-' : (x * 100).toFixed(2) + '%');
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

console.log('== 分档：结构地板 / 实测 C1 / 可省缺口 ==');
console.log('口径        轮数   会话   轮/会话   C1 实测   C1 结构地板   可省缺口   成本');
for (const [label, mk] of COHORTS) {
  if (label === '孤儿') continue;
  const w = mk('u');
  const r = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT u.conversation_id) convs,
                             SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                      FROM usage_stats u WHERE u.kind='round' AND ${w}`))[0];
  if (!r || !r.n) { console.log(`${label.padEnd(10)} （无数据）`); continue; }
  const rounds = Number(r.n), convs = Number(r.convs);
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  const floorGap = convs / rounds;              // 首轮那一次必然未命中占的比例
  const ceiling = rounds > 0 ? 1 - floorGap : null;
  console.log(`${label.padEnd(10)} ${fmt(rounds).padStart(6)} ${fmt(convs).padStart(5)}  ${(rounds / convs).toFixed(1).padStart(6)}   ${pct(c1).padStart(8)}   ${pct(ceiling).padStart(9)}   ${pct(ceiling - c1).padStart(8)}   ¥${r.cost}`);
}

console.log('\n== 分档自检 ==');
const cnt = async (w) => Number(((await q(`SELECT COUNT(*) n FROM usage_stats u WHERE u.kind='round' AND ${w}`))[0] || {}).n || 0);
const nHuman = await cnt(HUMAN_WHERE('u'));
const nSched = await cnt(`(${SCHEDULED_WHERE('u')}) AND NOT (${PROBE_WHERE('u')}) AND NOT (${SAMPLE_WHERE('u')})`);
const nSample = await cnt(SAMPLE_WHERE('u'));
const nReal = await cnt(REAL_WHERE('u'));
const nProbe = await cnt(PROBE_WHERE('u'));
const sum3 = nHuman + nSched + nSample;
console.log(`  真实流量 = 人发起 ${fmt(nHuman)} + 定时任务 ${fmt(nSched)} + 样本 ${fmt(nSample)} = ${fmt(sum3)}　vs　${fmt(nReal)}　${sum3 === nReal ? '✅ 一致（三档互斥且穷尽）' : '❌ 不一致（某档写重了或漏了）'}`);
console.log(`  样本(人造任务) ${fmt(nSample)} 轮：落在真实流量内 ${fmt(await cnt(`(${SAMPLE_WHERE('u')}) AND (${REAL_WHERE('u')})`))} / 落在探针档 ${fmt(await cnt(`(${SAMPLE_WHERE('u')}) AND (${PROBE_WHERE('u')})`))}`);
if (await cnt(`(${SAMPLE_WHERE('u')}) AND (${PROBE_WHERE('u')})`) > 0) {
  console.log('  ⚠️ 样本落在探针档：说明它的会话带有 `prefix:*` 账本且已被探针判据捞到——'
    + '口径里那一支**只应匹配"已删除的会话"**（捞回早期已清理的探针），若新会话也中招就是判据写宽了。');
}
console.log(`  探针档合计 ${fmt(nProbe)} 轮`);

console.log('\n== 结构结论（口径级，别按"单会话平均轮数 ≥100"理解——那是错的推导）==');;
const all = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT conversation_id) convs FROM usage_stats WHERE kind='round'`))[0];
console.log(`  全库：${fmt(all.n)} 轮 / ${fmt(all.convs)} 会话 → 口径上界 1 − ${all.convs}/${all.n} = ${pct(1 - all.convs / all.n)}`);
const need = (await q(`SELECT COUNT(*) n, COUNT(DISTINCT conversation_id) convs FROM usage_stats u WHERE kind='round' AND (${HUMAN_WHERE('u')})`))[0];
const capH = 1 - Number(need.convs) / Number(need.n);
console.log(`  人发起：${fmt(need.n)} 轮 / ${fmt(need.convs)} 会话 → 口径上界 ${pct(capH)}（首轮未命中只占 ${pct(Number(need.convs) / Number(need.n))}）`);
console.log(`  ⇒ 99% 在**口径级**是可达到的（它不是单会话指标）；真正的缺口是"地板与实测之间那 90 多个点"。`);
console.log(`  短会话数量少时口径上界几乎不受影响，但**任何一个长期 0% 命中的大会话都会把总量拖平**——见逐会话报告。`);

console.log('\n== 逐会话（人发起）：谁是拖累项 ==');
for (const r of await q(`SELECT u.conversation_id cid, c.title, COUNT(*) rounds,
                                SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss, ROUND(SUM(u.cost),4) cost
                         FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                         WHERE u.kind='round' AND (${HUMAN_WHERE('u')}) GROUP BY u.conversation_id, c.title ORDER BY rounds DESC`)) {
  const c1 = (Number(r.hit) + Number(r.miss)) > 0 ? Number(r.hit) / (Number(r.hit) + Number(r.miss)) : null;
  console.log(`  conv=${String(r.cid).padEnd(5)} 轮 ${String(r.rounds).padStart(5)}  C1 ${pct(c1).padStart(7)}  ¥${String(r.cost).padStart(9)}  ${String(r.title || '').slice(0, 22)}`);
}

// ── 集中度：口径级 C1 会不会被少数会话"锁死" ─────────────────────────────────────────────
// 这是本报告最该看的一段：C1 是**整个口径累计**的比，历史大会话的未命中会**永久**留在分子分母里。
// 只要有一个长期 0% 命中的大会话，改造后的成绩就会被它按住不动——指标因此**不反映当前机制是否生效**。
console.log('\n== 集中度：谁在决定口径 C1 ==');
for (const [label, w] of [['人发起', HUMAN_WHERE('u')], ['真实流量', REAL_WHERE('u')]]) {
  const tot = (await q(`SELECT SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) m, COUNT(*) n FROM usage_stats u WHERE u.kind='round' AND (${w})`))[0];
  const totC1 = (Number(tot.hit) + Number(tot.m)) > 0 ? Number(tot.hit) / (Number(tot.hit) + Number(tot.m)) : null;
  console.log(`  ${label}：总未命中 ${fmt(tot.m)}（${fmt(tot.n)} 轮）· C1 ${pct(totC1)}`);
  const top = await q(`SELECT u.conversation_id cid, c.title, COUNT(*) rounds, SUM(u.cache_miss_tokens) miss
                       FROM usage_stats u LEFT JOIN conversations c ON c.id=u.conversation_id
                       WHERE u.kind='round' AND (${w}) GROUP BY u.conversation_id, c.title ORDER BY miss DESC LIMIT 3`);
  let acc = 0;
  for (const r of top) {
    const share = Number(r.miss) / Number(tot.m);
    acc += share;
    console.log(`    conv=${String(r.cid).padEnd(5)} 未命中 ${fmt(r.miss).padStart(11)}（占 ${pct(share)}）· ${String(r.rounds).padStart(5)} 轮 · ${String(r.title || '').slice(0, 20)}`);
  }
  console.log(`    → 前 3 个会话占该口径未命中的 ${pct(acc)}`);
  const rest = (await q(`SELECT SUM(hit) hit, SUM(miss) miss FROM (
                           SELECT u.conversation_id cid, SUM(u.cache_hit_tokens) hit, SUM(u.cache_miss_tokens) miss
                           FROM usage_stats u WHERE u.kind='round' AND (${w}) GROUP BY u.conversation_id
                           ORDER BY miss DESC LIMIT 100 OFFSET 2) z`))[0] || {};
  const c1rest = (Number(rest.hit) + Number(rest.miss)) > 0 ? Number(rest.hit) / (Number(rest.hit) + Number(rest.miss)) : null;
  console.log(`    → 剔除未命中最多的 2 个会话后：C1 ${pct(c1rest)}（该口径整体 ${pct(totC1)}）`);
}

console.log('\n== 归因（人发起 + 定时任务）==');
const ledger = await q(`SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE 'prefix:%' GROUP BY action ORDER BY n DESC`);
console.log('  账本：' + (ledger.length ? ledger.map((r) => r.action + '=' + r.n).join('  ') : '（空）'));
const ex = await q(`SELECT detail, COUNT(*) n FROM audit_log WHERE action='prefix:exempt' GROUP BY detail ORDER BY n DESC LIMIT 6`);
for (const r of ex) if (!r.__err) console.log('  C5 归因：' + r.detail + ' × ' + r.n + '（属预期失效：首轮/长空闲/切模型/工具面变更）');
const near = (await q(`SELECT ROUND(AVG(rr),1) avg_rounds FROM (SELECT u.conversation_id, COUNT(*) rr FROM usage_stats u
                        WHERE u.kind='round' AND u.created_at > NOW() - INTERVAL 7 DAY GROUP BY u.conversation_id) x`))[0];
console.log(`  近 7 天平均轮/会话 = ${near.avg_rounds}`);
process.exit(0);
