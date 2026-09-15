// scripts/tool-bounds.mjs - 工具面"界限"审计（架构项：工具级超时，口径对齐 DSH `dsh-tool-call-timeout-policy`）
//
// 为什么要这张表：架构要求是"每个工具调用都有界，或**如实**声明它没有界"。
// 光靠逐个读实现是无法核对的（人会漏），所以这里从**运行期真实对象**派生：
//   · 工具定义上声明了 `timeoutMs`  → 有界，出处=声明（execTool 据此派生 signal 并如实报超时）
//   · run 源码里自己去起子进程/自带 timeout 参数 → 有界，出处=实现（如 runCmd/execFile 的 timeout）
//   · 源码里出现 `AbortSignal.timeout(` → **私有字面量**（不允许：它既不出现在工具面上，也吞掉用户"停止"）
//   · 其余 → 未声明（如实列出；长任务与等人工两类是**有意**不设线）
//
// 用法：node scripts/tool-bounds.mjs        # 打印表；任何"私有字面量"都以非零退出码报错
import { TOOLS } from '../server/tools/index.js';
import { MANIFEST_NAMES } from '../server/tools/registry.js';

// 有意不设线的两类。写在这里而不是散在实现里，是为了让"不设线"本身可见、可审。
const INTENT = {
  ask_user: '等人工（答案什么时候来由用户决定，给它编一个数就是莫须有的限制）',
};
const LONG_TASK = /^(subagent|subagent_fork|subagent_fanout|subagent_join|subagent_output|ralph|run_long_task|job_output|job_list)$/;

const src = (t) => String(t.run || '');
const rows = [];
const privates = [];
for (const t of TOOLS) {
  const s = src(t);
  if (/AbortSignal\.timeout\(/.test(s)) privates.push(t.name);
  let bound = null, from = '';
  if (Number.isFinite(Number(t.timeoutMs)) && Number(t.timeoutMs) > 0) { bound = Number(t.timeoutMs); from = '声明（工具定义 timeoutMs）'; }
  else if (/runCmd\(|execFile/.test(s)) { bound = null; from = '实现自带（子进程 timeout 参数）'; }
  else if (INTENT[t.name]) from = INTENT[t.name];
  else if (LONG_TASK.test(t.name)) from = '长任务（有意不设线：等子代理/后台任务）';
  else from = '未声明（本地快操作）';
  rows.push({ name: t.name, bound, from });
}

const declared = rows.filter((r) => r.bound);
const w = Math.max(...rows.map((r) => r.name.length));
console.log('工具界限表：' + rows.length + ' 个工具（清单 ' + MANIFEST_NAMES.length + ' 条）\n');
console.log('【有界·声明】' + declared.length + ' 个');
for (const r of declared) console.log('  ' + r.name.padEnd(w) + '  ' + String(r.bound).padStart(7) + 'ms  ' + r.from);
const groups = new Map();
for (const r of rows.filter((x) => !x.bound)) groups.set(r.from, [...(groups.get(r.from) || []), r.name]);
console.log('\n【无声明】（有意者已注明理由）');
for (const [from, names] of groups) console.log('  ' + from + '（' + names.length + '）：' + names.join(', '));

if (privates.length) {
  console.error('\n[✗] 以下工具把界限写死在实现里（私有字面量）——必须改成工具定义上的 timeoutMs：\n  ' + privates.join(', '));
  process.exit(1);
}
console.log('\n[✓] 无私有超时字面量：所有外部阻塞调用的界限都来自工具定义上的声明。');
