// test/prefix-participants.test.mjs - v0.3 §4.4.1 规则5 夹具：**任何进前缀的组件都必须声明缓存影响**
// 引擎方案 v0.3 §7.1 ⑨ 的状态原文：「"缓存影响"声明检查**未做**」。本夹具就是那条检查。
// 三层保障：① 结构合法 + 前缀破坏者名单可枚举；② 每个声明的**源码锚点必须真的还在**（防这张表烂掉）；
//          ③ **节点 0 只有一个写入点**（这条是 2026-09-15 技能改 in-history 之后的回归锁）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX_PARTICIPANTS, auditPrefixDeclarations } from '../server/prefix-participants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('声明检查：每条都结构合法、有源码锚点、有一句实话', () => {
  const a = auditPrefixDeclarations();
  assert.deepEqual(a.bad, [], '声明不合法：' + a.bad.join(' / '));
  assert.ok(a.n >= 10, '进请求的组件不应少于 10 个（实为 ' + a.n + '）——少一个就说明有注入点没被登记');
  assert.ok(a.tailOnly >= 6, '尾巴区组件应有多个（实为 ' + a.tailOnly + '）');
});

test('前缀破坏者名单必须可枚举且**恰好是这些**（多一个都要走评审，少一个说明漏报）', () => {
  const a = auditPrefixDeclarations();
  // 2026-09-15 技能改 in-history 追加之后，skill-load 从名单里出去了（4 → 3 条）。
  assert.deepEqual(a.breakers, ['collapse', 'system-prompt', 'tools-face'],
    'breaks-prefix 名单变了：新加的前缀破坏者必须先在这里登记并说明理由');
  assert.ok(!a.breakers.includes('skill-load'), '载技能**不得**再破坏前缀（已改 in-history 追加）');
});

test('源码锚点核对：每个声明指向的那行代码**确实还在**（防止声明表与实际实现脱节）', () => {
  const missing = [];
  for (const p of PREFIX_PARTICIPANTS) {
    for (const a of p.anchors) {
      let src = '';
      try { src = read(a.file); } catch { missing.push(p.id + ' → 文件不存在 ' + a.file); continue; }
      if (!src.includes(a.pattern)) missing.push(p.id + ' → 锚点已不在 ' + a.file + '：' + a.pattern);
    }
  }
  assert.deepEqual(missing, [], '声明与实现脱节：\n' + missing.join('\n'));
});

test('节点 0 只有一个写入点，且内容只来自 buildEnv()（技能改 in-history 之后的回归锁）', () => {
  const src = read('server/agent.js');
  const writes = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /msgs\[0\]\s*=/.test(l));
  assert.equal(writes.length, 1, '节点 0 只允许有一个写入点（refreshSys），实为 ' + writes.length + ' 处：'
    + writes.map(([n]) => 'L' + n).join(','));
  // 该写入点的内容必须只来自 buildEnv()
  const idx = src.split('\n').findIndex((l) => /msgs\[0\]\s*=/.test(l));
  const around = src.split('\n').slice(Math.max(0, idx - 4), idx + 1).join('\n');
  assert.ok(/const c = buildEnv\(\)/.test(around), 'refreshSys 的内容必须来自 buildEnv()，不得再拼技能/知识等动态内容');
  // 反向锁：旧实现那个"把技能拼进节点 0"的函数不得复活
  assert.ok(!/const sysContent\s*=/.test(src), 'sysContent（把技能拼进节点 0 的旧实现）不得复活');
});

test('技能一律走"追加到历史之后"：两条路径都在，且都不碰节点 0', () => {
  const agent = read('server/agent.js');
  const idx = read('server/index.js');
  assert.match(agent, /const appendNewSkills = \(\) => \{/, '运行期载技能必须有 in-history 追加入口');
  assert.match(agent, /msgs\.push\(\{ role: 'system', content: '【已载入技能: '/, '追加的必须是 system 角色消息（权威性不变）');
  assert.match(idx, /messages\.push\(\{ role: 'system', content: '【已载入技能: '/, '开跑前载入的技能也走 messages（紧跟节点 0 之后）');
  // 追加**调用点**必须在工具结果之后（不是循环开头改前缀）——定义点当然在函数区，所以看调用点
  const lines = agent.split('\n');
  const callLine = lines.findIndex((l) => /const added = appendNewSkills\(\);/.test(l));
  const toolPushLine = lines.findIndex((l) => /role: 'tool', tool_call_id: call\.id/.test(l));
  assert.ok(callLine > 0 && toolPushLine > 0 && callLine > toolPushLine,
    '技能追加应在工具结果之后（位置=真正发生的位置）：call=' + callLine + ' tool=' + toolPushLine);
});

test('尾巴区组件不得出现在"系统提示拼装"里（位置声明与实现同口径）', () => {
  const env = read('server/agent.js');
  const buildEnvLine = env.split('\n').find((l) => l.includes('export const buildEnvFor'));
  assert.ok(buildEnvLine, 'buildEnvFor 必须存在（系统提示的单一拼装出口）');
  for (const p of PREFIX_PARTICIPANTS.filter((x) => x.where === 'tail')) {
    for (const a of p.anchors) assert.ok(!buildEnvLine.includes(a.pattern), p.id + ' 声明在尾巴区，却出现在系统提示拼装里');
  }
});
