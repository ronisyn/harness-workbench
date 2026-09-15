// scripts/acceptance-status.mjs - 验收状态**生成器**（只读）：状态不再由人手写
//
// 为什么（2026-09-15，治理"状态列过期"这个根因）：
//   同一件事在三份文档里有三种说法，因为状态是**人手抄的**。DSH 把这类契约写在代码旁边强制声明，
//   CD 靠编译器强制；JS 里我们做得到的最接近的事是：**声明 + 机检 + 生成状态表**。
//   人只维护"目标 / 理由 / 决策"，"做没做"由本脚本扫出来。
//
// 三类判定（不猜、不美化）：
//   auto      锚点齐全 ⇒ ✅；缺锚点 ⇒ ❌（并列出缺哪个）——**机器能证实的才敢说做完**
//   manual    机器判不了（需真实流量/真机/人工）⇒ 输出"需人判"+ 取证命令，**绝不假装完成**
//   milestone 明确属后续里程碑 ⇒ 输出"转 M2/M3"，不计入未完成
//
// 用法：node scripts/acceptance-status.mjs [--write]
//   --write 时把表写到 proposals/验收状态-生成.md（连同生成时间戳与 git 版本）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'proposals', '验收锚点.json');
const OUT = path.join(ROOT, 'proposals', '验收状态-生成.md');
const WRITE = process.argv.includes('--write');

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const items = spec.items || [];
const rel = (p) => p; // 相对仓库根
let gitRev = '（无 git）';
try { gitRev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* 忽略 */ }

const rows = [];
for (const it of items) {
  if (it.kind === 'milestone') { rows.push({ ...it, status: '转 ' + (it.milestone || 'M2/M3') }); continue; }
  if (it.kind === 'manual') { rows.push({ ...it, status: '需人判' }); continue; }
  const missing = [];
  for (const a of it.anchors || []) {
    let src = '';
    try { src = fs.readFileSync(path.join(ROOT, a.file), 'utf8'); } catch { missing.push(a.file + '（文件不存在）'); continue; }
    if (!src.includes(a.pattern)) missing.push(a.file + ' :: ' + a.pattern);
  }
  rows.push({ ...it, status: missing.length ? '❌' : '✅', missing });
}

const n = (s) => rows.filter((r) => r.status === s).length;
const counts = { done: n('✅'), todo: n('❌'), manual: n('需人判'), ms: rows.length - n('✅') - n('❌') - n('需人判') };
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

const L = [];
L.push('# 验收状态（生成物，勿手改）');
L.push('');
L.push('> 本表由 `node scripts/acceptance-status.mjs --write` 生成 —— **不要手工编辑**。');
L.push('> 锚点与判据在 `proposals/验收锚点.json`；"做没做"由源码锚点机检得出，人只维护目标与理由。');
L.push('> 为什么这么做：状态列靠人手抄，代码动了没人回头改，同一件事就会在三份文档里出现三种说法。');
L.push('');
L.push(`- 生成时间：**${stamp}**　·　代码版本：\`${gitRev}\``);
L.push(`- 机检通过 **${counts.done}** · 缺锚点 **${counts.todo}** · 需人判 **${counts.manual}** · 转后续里程碑 **${counts.ms}**`);
L.push('');
L.push('| 项 | 要求 | owner | 状态 | 说明 / 取证 |');
L.push('|---|---|---|---|---|');
// 单元格里的竖线必须**转义**成 `\|`（markdown 表格的转义写法），不能替换成别的字符。
// 2026-09-16 修：原先 `.replace(/\|/g,'/')` 会把内容**静默改写**——说明里的逻辑或 `||` 印成 `//`，
// 取证命令里的管道 `grep x | head` 变成 `grep x / head`（已经发生过：OP-08 的取证命令就是斜杠）。
// 表格里的竖线是结构，正文里的竖线是内容，两者不能混为一谈。
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|');
for (const r of rows) {
  const ev = r.status === '✅' ? (r.anchors || []).map((a) => '`' + a.file + '`').join(' ') : '';
  const evTxt = r.kind === 'manual' ? (r.evidence || '（见说明）') : (r.missing && r.missing.length ? '缺：' + r.missing.join('；') : ev);
  L.push(`| ${r.id} | ${r.title} | ${r.owner || '-'} | ${r.status} | ${cell(r.note)}${evTxt ? '<br>' + cell(evTxt) : ''} |`);
}
L.push('');
L.push('## 怎么用');
L.push('');
L.push('1. 改完代码后跑一次 `node scripts/acceptance-status.mjs --write`，状态表自动更新（**不用再手工同步三份文档**）。');
L.push('2. 新增验收项：先在 `验收锚点.json` 里加一条并给它挂源码锚点；挂不上锚点的，说明它还不能算"做完"。');
L.push('3. `需人判` 的条目**不许**在别处写成"已完成"——机器判不了的事情，就要人出示证据。');
L.push('');

const text = L.join('\n');
if (WRITE) { fs.writeFileSync(OUT, text, 'utf8'); }

console.log(text);
if (WRITE) console.log('\n（已写入 ' + path.relative(ROOT, OUT) + '）');
if (counts.todo > 0) process.exitCode = 1; // 缺锚点即失败，便于挂进 CI
