// test/prefix-participants.test.mjs - v0.3 §4.4.1 规则5 夹具：**任何进前缀的组件都必须声明缓存影响**
// 引擎方案 v0.3 §7.1 ⑨ 的状态原文：「"缓存影响"声明检查**未做**」。本夹具就是那条检查。
// 两层保障：① 结构合法 + 前缀破坏者名单可枚举；② 每个声明的**源码锚点必须真的还在**（防这张表烂掉）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX_PARTICIPANTS, auditPrefixDeclarations } from '../server/prefix-participants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('声明检查：每条都结构合法、有源码锚点、有一句实话', () => {
  const a = auditPrefixDeclarations();
  assert.deepEqual(a.bad, [], '声明不合法：' + a.bad.join(' / '));
  assert.ok(a.n >= 10, '进请求的组件不应少于 10 个（实为 ' + a.n + '）——少一个就说明有注入点没被登记');
  assert.ok(a.tailOnly >= 5, '尾巴区组件应有多个（实为 ' + a.tailOnly + '）');
});

test('前缀破坏者名单必须可枚举且**恰好是这些**（多一个都要走评审，少一个说明漏报）', () => {
  const a = auditPrefixDeclarations();
  assert.deepEqual(a.breakers, ['collapse', 'skill-load', 'system-prompt', 'tools-face'],
    'breaks-prefix 名单变了：新加的前缀破坏者必须先在这里登记并说明理由');
});

test('源码锚点核对：每个声明指向的那行代码**确实还在**（防止声明表与实际实现脱节）', () => {
  const missing = [];
  for (const p of PREFIX_PARTICIPANTS) {
    const f = path.join(ROOT, p.file);
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { missing.push(p.id + ' → 文件不存在 ' + p.file); continue; }
    if (!src.includes(p.anchor)) missing.push(p.id + ' → 锚点已不在 ' + p.file + '：' + p.anchor);
  }
  assert.deepEqual(missing, [], '声明与实现脱节：\n' + missing.join('\n'));
});

test('尾巴区组件不得出现在"系统提示拼装"里（位置声明与实现同口径）', () => {
  // 反向核对：system 档的组件必须能在 agent.js 的第 0 条拼装路径上找到；
  // 而 tail 档的组件不应出现在 buildEnvFor 的拼装表达式里。
  const env = fs.readFileSync(path.join(ROOT, 'server/agent.js'), 'utf8');
  const buildEnvLine = env.split('\n').find((l) => l.includes('export const buildEnvFor'));
  assert.ok(buildEnvLine, 'buildEnvFor 必须存在（系统提示的单一拼装出口）');
  for (const p of PREFIX_PARTICIPANTS.filter((x) => x.where === 'tail')) {
    assert.ok(!buildEnvLine.includes(p.anchor), p.id + ' 声明在尾巴区，却出现在系统提示拼装里');
  }
});
