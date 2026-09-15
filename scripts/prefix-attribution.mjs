// scripts/prefix-attribution.mjs - M1 的兑现：**一条命令回答"这次冷启动是谁打破了前缀"**（只读）
//
// 背景（见 proposals/缓存追平DSH-方案-v1-20260915.md §2）：
//   前缀缓存按逐字节前缀匹配。实测同一会话、同样的 24 小时空闲，前缀没变则首轮未命中 ≤142，
//   变了则 ≥8,964（其中一次只差 +46 个 token）。但我们此前**根本没有落库**前缀指纹 ——
//   sys/tools 哈希只在 RW_PREFIX_DEBUG=1 的日志里，事后查不出是谁打破了前缀。
//   M1a 之后每轮都带 prefix_sys_hash / prefix_tools_hash，于是本脚本能把每一轮冷启动归因到具体一类：
//
//   · 真·首见  —— 该会话从未出现过这枚指纹 ⇒ 这是它的第一次请求（冷启动不可免）
//   · 换纪元  —— 指纹在本会话出现过，但中间被别的指纹替换过 ⇒ 前缀面变了（翻转/部署/MCP 漂移）
//   · 久未用  —— 指纹就是上一次用的那枚，但中间隔了很久 ⇒ 才轮到"缓存过期"这个解释
//
// 用法：node scripts/prefix-attribution.mjs [--days 7] [--cold 3000]
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const num = (f, d) => (argv.includes(f) ? Number(argv[argv.indexOf(f) + 1]) : d);
const DAYS = num('--days', 7);
const COLD = num('--cold', 3000); // 未命中超过这个 token 数才算"冷启动"，避免把每轮固有新增算进来

const q = async (s, p = []) => { try { return await db.query(s, p); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
// created_at 经驱动回传是 JS Date，`String(d).slice()` 会切出 "ep 15 2026 20:"。统一成 "MM-DD HH:MM"。
const ts = (d) => {
  if (!d) return '-';
  const x = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
};

console.log(`== 近 ${DAYS} 天 · 冷启动（单轮未命中 > ${fmt(COLD)}）归因 ==`);
console.log(`口径：只看 kind='round' 且带指纹的轮次（预热 kind='warmup' 与存量 NULL 行不计）\n`);

const rows = await q(`
  SELECT u.id, u.conversation_id cid, u.tokens_in tin, u.cache_hit_tokens hit, u.cache_miss_tokens miss,
         u.prefix_sys_hash sys, u.prefix_tools_hash tools, u.created_at t,
         TIMESTAMPDIFF(SECOND,
           (SELECT MAX(v.created_at) FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id),
           u.created_at) gap_since_prev,
         (SELECT v.prefix_tools_hash FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id ORDER BY v.id DESC LIMIT 1) prev_tools,
         (SELECT COUNT(*) FROM usage_stats v WHERE v.kind='round' AND v.conversation_id=u.conversation_id AND v.id<u.id
            AND v.prefix_sys_hash=u.prefix_sys_hash AND v.prefix_tools_hash=u.prefix_tools_hash) seen_before
    FROM usage_stats u
   WHERE u.kind='round' AND u.prefix_sys_hash IS NOT NULL AND u.cache_miss_tokens > ?
     AND u.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
   ORDER BY u.id DESC LIMIT 60`, [COLD, DAYS]);

if (!rows.length) {
  console.log('  （窗口内没有冷启动轮次；或指纹列刚上线、样本还没积累起来）');
} else {
  const cls = (r) => (Number(r.seen_before) === 0 ? '真·首见' : (r.prev_tools && r.prev_tools !== r.tools ? '换纪元' : '久未用'));
  console.log('判定       会话     轮次   输入     未命中   本行指纹(工具)   同会话是否出现过   与上一轮间隔');
  const tally = {};
  for (const r of rows) {
    const c = cls(r); tally[c] = (tally[c] || 0) + 1;
    const gap = r.gap_since_prev == null ? '-' : (r.gap_since_prev / 60).toFixed(1) + ' 分';
    console.log(`${c.padEnd(9)} conv=${String(r.cid).padEnd(5)} #${String(r.id).padEnd(6)} ${fmt(r.tin).padStart(8)} ${fmt(r.miss).padStart(8)}  ${r.tools}  ${String(Number(r.seen_before) > 0 ? '出现过 ' + r.seen_before + ' 次' : '从未').padEnd(16)} ${gap}`);
  }
  console.log('\n  小计：' + Object.entries(tally).map(([k, v]) => `${k} ${v}`).join('　·　'));
  console.log('  读法：**"换纪元"条数 = 可以通过前缀面纪律消掉的那部分**；"真·首见"是会话的第一次请求，消不掉；');
  console.log('        "久未用"才是"缓存过期"能解释的那部分 —— 实测它通常最少见（见方案 §2）。');
}

console.log('\n== 纪元账本（audit_log · prefix:*）==');
for (const r of await q("SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE 'prefix:%' GROUP BY action ORDER BY n DESC")) console.log(`  ${r.action} × ${r.n}`);
console.log('  最近 8 条：');
for (const r of await q("SELECT action, detail, created_at FROM audit_log WHERE action LIKE 'prefix:%' ORDER BY id DESC LIMIT 8")) {
  console.log(`   ${ts(r.created_at).padEnd(13)} ${r.action.padEnd(22)} ${String(r.detail).slice(0, 110)}`);
}

console.log('\n== 预热成效（kind=warmup：命中说明前缀本来就热，未命中说明我们替真实请求付掉了重建）==');
const w = await q("SELECT COUNT(*) n, SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) miss, SUM(cost) cost FROM usage_stats WHERE kind='warmup' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)", [DAYS]);
if (w[0] && Number(w[0].n)) {
  const x = w[0];
  console.log(`  预热 ${x.n} 次：命中 ${fmt(x.hit)} / 未命中 ${fmt(x.miss)}（命中率 ${(100 * Number(x.hit) / (Number(x.hit) + Number(x.miss))).toFixed(1)}%）· 花费 ¥${Number(x.cost || 0).toFixed(4)}`);
  console.log('  ⇒ 未命中那部分 = 本该由下一次真实请求承担的前缀重建，被提前在启动时付掉了。');
} else console.log('  （窗口内没有预热记录）');
process.exit(0);
