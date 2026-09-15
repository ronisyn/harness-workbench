// test/audit-not-swallowed.test.mjs - 留痕不得被静默吞掉（2026-09-15，两次栽在同一处）
//
// 背景：本仓库两次出现"主链路某处抛错 → 被静默 catch 吞掉 → 现象只在别处露头"：
//   ① `result is not defined`：每轮对话在 done 之前中断；
//   ② `hookStop is not defined`：工具照常执行（文件真写了），但 `tool_calls` 与 `tool:<名>` 审计
//      **一行都不落**，静默 40 分钟，直到端到端冒烟查库才发现。
// 两次的根因都是"变量作用域跨了执行块边界"。这类错误静态检查抓不住，但**"失败必须出声"**可以抓。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8');

test('留痕失败必须打日志（不得再是静默 catch）', () => {
  assert.match(src, /\[tool-audit\] 留痕失败/, '漏账必须出声：过去是 `catch { /* 留痕失败不影响 */ }`，账断了没人知道');
  assert.ok(!/catch \{ \/\* 留痕失败不影响 \*\/ \}/.test(src), '旧的静默 catch 不得复活');
});

test('留痕块引用的变量必须在执行块之外声明（作用域跨界的回归锁）', () => {
  // 注意：仓库文件是 CRLF（git 检出时转换），必须先剥掉行尾的 \r，否则 `/^\s*try \{$/` 这类锚定正则永远匹配不上
  const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));
  // 执行块 = `try {` 且下一行是 `let blocked = null;` 的那一处；留痕块 = 含 [tool-audit] 的那一处
  let execTry = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*try \{$/.test(lines[i]) && /blocked = null/.test(lines[i + 1] || '')) { execTry = i; break; }
  }
  const auditLine = lines.findIndex((l) => l.includes('[tool-audit] 留痕失败'));
  assert.ok(execTry > 0, '定位执行块失败（源码结构变了，请更新本夹具）');
  assert.ok(auditLine > execTry, '定位留痕块失败（源码结构变了，请更新本夹具）');
  const execBody = lines.slice(execTry, auditLine).join('\n');
  const before = lines.slice(0, execTry).join('\n');
  for (const id of ['hookStop', 'argsAsked']) {
    assert.ok(!new RegExp('^\\s*(const|let|var)\\s+' + id + '\\b', 'm').test(execBody),
      id + ' 不得在执行块内声明——它在块外的留痕代码里被引用，会抛 ReferenceError 并被 catch 吞掉');
    assert.ok(new RegExp('^\\s*(const|let|var)\\s+' + id + '\\b', 'm').test(before),
      id + ' 必须在执行块**之前**声明（留痕代码要用它）');
  }
});
