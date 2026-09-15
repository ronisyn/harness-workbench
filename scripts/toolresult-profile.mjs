// scripts/toolresult-profile.mjs - 只读：找出"工具结果"里最重的那些调用（措施②要打的目标）
// 口径：tool_calls.result_bytes = 工具返回值的 UTF-8 字节数（即真正进上下文的文本体积，v1 口径见 RA-05b）
// 目的：不是看均值，而是回答"要把每轮新增从 ~1.7k tokens 压到 500–800，该压谁"。
// 用法：node scripts/toolresult-profile.mjs [--days 7]
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const DAYS = Number(argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 7) || 7;
const q = async (s) => { try { return await db.query(s); } catch (e) { return [{ __err: e.message }]; } };
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));
const TOK = 3.2; // 字节→token 粗估（中文≈3、英文≈4）

console.log(`窗口：近 ${DAYS} 天　（字节 → token 按 ${TOK} 字节/token 粗估）\n`);

console.log('== ① 按工具：谁在撑大上下文 ==');
for (const r of await q(`SELECT tool_name, COUNT(*) n, SUM(result_bytes) bytes, ROUND(AVG(result_bytes)) avg,
                                MAX(result_bytes) mx, SUM(result_bytes > 4000) over4k
                         FROM tool_calls WHERE created_at > NOW() - INTERVAL ${DAYS} DAY
                         GROUP BY tool_name ORDER BY bytes DESC LIMIT 14`)) {
  if (r.__err) { console.log('  ' + r.__err); break; }
  console.log(`  ${String(r.tool_name).padEnd(22)} 次 ${String(r.n).padStart(6)}  字节合计 ${fmt(r.bytes).padStart(12)} ≈ ${fmt(Math.round(r.bytes / TOK)).padStart(10)} tok  均值 ${fmt(r.avg).padStart(7)}  最大 ${fmt(r.mx).padStart(7)}  >4k 的 ${fmt(r.over4k).padStart(5)}`);
}

console.log('\n== ② 最重的 12 次调用（单次就把一轮新增顶上去）==');
for (const r of await q(`SELECT t.id, t.tool_name, t.result_bytes, t.created_at, t.conversation_id cid, LEFT(CAST(t.args AS CHAR), 60) args
                         FROM tool_calls t WHERE t.created_at > NOW() - INTERVAL ${DAYS} DAY
                         ORDER BY t.result_bytes DESC LIMIT 12`)) {
  if (r.__err) { console.log('  ' + r.__err); break; }
  console.log(`  #${String(r.id).padEnd(6)} ${String(r.tool_name).padEnd(18)} ${fmt(r.result_bytes).padStart(8)} 字节 ≈ ${fmt(Math.round(r.result_bytes / TOK)).padStart(7)} tok  conv=${r.cid}  ${String(r.created_at).slice(5, 16)}  ${String(r.args || '').replace(/\s+/g, ' ').slice(0, 44)}`);
}

console.log('\n== ③ 体积分布（近 %d 天全部工具调用）==', DAYS);
for (const r of await q(`WITH t AS (SELECT result_bytes b, ROW_NUMBER() OVER (ORDER BY result_bytes) rn, COUNT(*) OVER () c
                                     FROM tool_calls WHERE created_at > NOW() - INTERVAL ${DAYS} DAY AND result_bytes > 0)
                          SELECT MAX(c) n, MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.50)) THEN b END) p50,
                                 MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.90)) THEN b END) p90,
                                 MAX(CASE WHEN rn=GREATEST(1,FLOOR(c*0.99)) THEN b END) p99, MAX(b) mx FROM t`)) {
  if (r.__err) { console.log('  ' + r.__err); break; }
  console.log(`  n=${fmt(r.n)}  p50=${fmt(r.p50)} 字节 ≈ ${fmt(Math.round((r.p50 || 0) / TOK))} tok　p90=${fmt(r.p90)} ≈ ${fmt(Math.round((r.p90 || 0) / TOK))} tok　p99=${fmt(r.p99)} ≈ ${fmt(Math.round((r.p99 || 0) / TOK))} tok　max=${fmt(r.mx)} ≈ ${fmt(Math.round((r.mx || 0) / TOK))} tok`);
  console.log(`  ⇒ 若把"单次工具结果"统一压到 ≤2,000 字节（≈625 tok），被压掉的行数 = ${fmt(await q(`SELECT COUNT(*) n FROM tool_calls WHERE created_at > NOW() - INTERVAL ${DAYS} DAY AND result_bytes > 2000`).then((x) => x[0].n))}`);
}

console.log('\n== ④ 一次执行里工具结果的总量（决定这一轮的注入量）==');
for (const r of await q(`SELECT conversation_id cid, COUNT(*) calls, SUM(result_bytes) bytes
                         FROM tool_calls WHERE created_at > NOW() - INTERVAL ${DAYS} DAY
                         GROUP BY conversation_id HAVING bytes > 20000 ORDER BY bytes DESC LIMIT 8`)) {
  if (r.__err) { console.log('  ' + r.__err); break; }
  console.log(`  conv=${String(r.cid).padEnd(6)} 调用 ${String(r.calls).padStart(4)} 次  结果合计 ${fmt(r.bytes).padStart(12)} 字节 ≈ ${fmt(Math.round(r.bytes / TOK)).padStart(9)} tok  平均每次 ${fmt(Math.round(r.bytes / Math.max(1, r.calls)))} 字节`);
}
process.exit(0);
