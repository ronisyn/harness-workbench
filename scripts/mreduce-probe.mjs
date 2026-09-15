// scripts/mreduce-probe.mjs - 压每轮新增的**确定性**探针：直调工具层，量"整形前后各给了多少字节"
//
// 为什么不走模型：这里要量的是"同样一次调用，平台吐出去多少字节"——走模型会引入它选什么工具、
// 选什么参数的随机性，量出来的数不可比。直调 TOOLS 里的 run() 是纯粹的"输入→输出体积"测量。
//
// 对照口径（旧行为，来自 scripts/toolresult-profile.mjs 的近 7 天实测）：
//   grep_search 均值 1,284 字节（最多 100 条命中 × 每行 200 字符）
//   list_dir    均值   787 字节（最多 200 条名字）
//   两者都不报"省略了多少"
//
// 用法：node scripts/mreduce-probe.mjs [--dir /srv/harness-workbench]
import { TOOLS } from '../server/tools/index.js';
import { clearReadCache, markWritten } from '../server/readcache.js';

const argv = process.argv.slice(2);
const DIR = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : '/srv/harness-workbench';
let CID = 990001;
const ctxOf = () => ({ permission: 'full', root: '/', conversationId: CID, limitPath: false });
const T = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const B = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const fmt = (n) => Number(n).toLocaleString('en-US');
// 每段用**独立的会话号**：去重状态是按会话隔离的，共用会号会让后一段直接撞上前一段的记录（探针自己踩过这个坑）
const fresh = () => { CID += 1; return ctxOf(); };
const run = async (name, args, label) => {
  const ctx = fresh();
  const t0 = Date.now();
  const r = await T[name].run(args, ctx);
  const b = B(r);
  console.log(`  ${label.padEnd(34)} ${String(fmt(b)).padStart(8)} 字节  ≈${String(Math.round(b / 3.2)).padStart(5)} tok  ${Date.now() - t0}ms`);
  return { b, r };
};

console.log('目标目录：' + DIR + '\n');
console.log('== ① grep_search：常见模式（命中少）vs 高频模式（命中多）==');
const few = await run('grep_search', { path: DIR + '/server/progress.js', pattern: 'judgeRound' }, 'grep 单文件 少量命中');
const many = await run('grep_search', { path: DIR + '/server', pattern: 'function' }, 'grep 整个 server 高频命中');
console.log('       ↑ 命中 ' + many.r.totalHits + ' 处 / ' + many.r.fileCount + ' 文件，只列了 ' + many.r.shownMatches + ' 条，省略 ' + (many.r.omitted || 0) + ' 条');
console.log('       ↑ 旧实现会列到 100 条 × 200 字符 ≈ ' + fmt(Math.min(many.r.totalHits, 100) * 200) + ' 字节（且不说省了什么）');

console.log('\n== ② grep_search 同会话重复调用（新的去重，**只在大结果上生效**）==');
// 小结果：同一会话连搜两次
{
  const ctx = fresh();
  const q = { path: DIR + '/server', pattern: 'cacheHit' };
  const r1 = await T.grep_search.run(q, ctx); const x1 = B(r1);
  const r2 = await T.grep_search.run(q, ctx); const x2 = B(r2);
  console.log('  小结果：第 1 次 ' + fmt(x1) + ' 字节 → 第 2 次 ' + fmt(x2) + ' 字节　' + (x2 <= x1 * 1.2 ? '✅ 未做无益去重（回执会更长）' : '⚠️ 回执比结果长，倒亏'));
  const bigQ = { path: DIR + '/server', pattern: 'function' };
  const b1 = await T.grep_search.run(bigQ, ctx); const y1 = B(b1);
  const b2 = await T.grep_search.run(bigQ, ctx); const y2 = B(b2);
  console.log('  大结果：第 1 次 ' + fmt(y1) + ' 字节 → 第 2 次 ' + fmt(y2) + ' 字节　压缩比 ' + (y1 / Math.max(1, y2)).toFixed(1) + '×');
  console.log('\n== ③ 写过文件之后，搜索结果记录必须作废（不能给过期结果）==');
  markWritten(ctx.conversationId);
  const b3 = await T.grep_search.run(bigQ, ctx); const y3 = B(b3);
  console.log('  写操作后再搜 ' + fmt(y3) + ' 字节　' + (y3 > y2 * 3 ? '✅ 已作废并重给全量' : '⚠️ 未作废（要查）'));
  var a1b = { b: x1 }, a2b = { b: x2 }, b1b = { b: y1 }, b2b = { b: y2 };
}

console.log('\n== ④ list_dir：小目录 vs 大目录 ==');
const small = await run('list_dir', { path: DIR + '/server/tools' }, '小目录（条目少）');
const big = await run('list_dir', { path: DIR + '/server' }, '大目录（条目多，走汇总）');
if (big.r.hint) console.log('       ↑ ' + big.r.dirs + ' 目录 / ' + big.r.files + ' 文件，只列 ' + big.r.entries.length + ' 条，省略 ' + big.r.omitted + ' 条');

console.log('\n== ⑤ read_file_range 按行取（新能力：grep 给行号 → 直接按行读上下文）==');
const target = DIR + '/server/progress.js';
const whole = B(await T.read_file.run({ path: target }, fresh()));      // 整读（独立会话，量准基线）
const byLine = await run('read_file_range', { path: target, fromLine: 60, toLine: 95 }, 'fromLine=60 toLine=95');
console.log('       ↑ 取回 ' + byLine.r.fromLine + '–' + byLine.r.toLine + ' 行 / 全文 ' + byLine.r.totalLines + ' 行');
console.log('       ↑ 整读同一文件 ' + fmt(whole) + ' 字节 ⇒ 按行读省 ' + (100 - Math.round((byLine.b / whole) * 100)) + '%');

console.log('\n== 汇总（本次探针，绝对字节，不是估算）==');
console.log('  grep 高频命中：' + fmt(many.b) + ' 字节（命中 ' + many.r.totalHits + ' 处 / ' + many.r.fileCount + ' 文件，只列 ' + many.r.shownMatches + ' 条）');
console.log('  grep 大结果重复：' + fmt(b2b.b) + ' 字节（原 ' + fmt(b1b.b) + '，压缩比 ' + (b1b.b / Math.max(1, b2b.b)).toFixed(1) + '×）');
console.log('  grep 小结果重复：' + fmt(a2b.b) + ' 字节（原 ' + fmt(a1b.b) + '，未做无益去重）');
console.log('  list_dir 大目录：' + fmt(big.b) + ' 字节（旧实现最多 200 条名字）');
console.log('  按行读一段：' + fmt(byLine.b) + ' 字节（整读 ' + fmt(whole) + ' 字节，省 ' + (100 - Math.round((byLine.b / whole) * 100)) + '%）');
console.log('\n  说明：这些是**工具输出的字节数**，直接决定每轮新增（m）。收益集中在"命中很多"和"重复调用"这两类；');
console.log('        常见的小 grep/小 read 本来就只有一两百字节，整形对它们没有影响（也不该有）。');
process.exit(0);
