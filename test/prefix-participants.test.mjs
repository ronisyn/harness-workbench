// test/prefix-participants.test.mjs - v0.3 §4.4.1 规则5 夹具：**任何进前缀的组件都必须声明缓存影响**
// 引擎方案 v0.3 §7.1 ⑨ 的状态原文：「"缓存影响"声明检查**未做**」。本夹具就是那条检查。
// 三层保障：① 结构合法 + 前缀破坏者名单可枚举；② 每个声明的**源码锚点必须真的还在**（防这张表烂掉）；
//          ③ **节点 0 只有一个写入点**（这条是 2026-09-15 技能改 in-history 之后的回归锁）。
// 2026-09-16 补（核对报告 §3.5④：漏登记 = C4 的假阴性）：原表 12 条集中在 agent.js 与尾巴区，
//   `/api/chat` 在历史**之前**的 4 条注入、COMPLETION_HINT、护栏/打回提示**一条都没登记**。
//   这里补上"漏项必须登记"的机检 —— 判据是**声明必须指向那条注入在源码里的同一段**，不是数条数。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX_PARTICIPANTS, PREFIX_LEDGER, auditPrefixDeclarations } from '../server/prefix-participants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const byId = (id) => PREFIX_PARTICIPANTS.find((p) => p.id === id);
/** 声明覆盖判定：这条声明的**任一个**锚点必须真的落在源码里（锚点核对那条测试会再逐条验）。 */
const declaredFor = (id, file, pattern) => {
  const p = byId(id);
  assert.ok(p, '声明表缺组件：' + id + '（漏登记 = C4 假阴性，见 §3.5④）');
  return p.anchors.some((a) => a.file === file && src(file).includes(a.pattern));
};
const srcCache = new Map();
const src = (f) => { if (!srcCache.has(f)) srcCache.set(f, read(f)); return srcCache.get(f); };

test('声明检查：每条都结构合法、有源码锚点、有一句实话', () => {
  const a = auditPrefixDeclarations();
  assert.deepEqual(a.bad, [], '声明不合法：' + a.bad.join(' / '));
  assert.ok(a.n >= 10, '进请求的组件不应少于 10 个（实为 ' + a.n + '）——少一个就说明有注入点没被登记');
  assert.ok(a.tailOnly >= 6, '尾巴区组件应有多个（实为 ' + a.tailOnly + '）');
});

// ── 2026-09-16 补：§3.5④ 的漏项必须被登记（各自指向源码里那段注入） ────────────────────────────
// 判据刻意不写"表里至少 N 条"：条数会随实现变，而"这条注入有没有人声明"不会。
// 每条都要求声明锚点**落在那段注入的源码上**（锚点核对那条测试会再逐条验它确实还在）。
test('漏项补齐：4 条 hist 前注入 + COMPLETION_HINT + 护栏/打回提示都必须登记（§3.5④）', () => {
  const cases = [
    ['history-early-summary', 'server/index.js', '【早期对话摘要，无需回复】'],
    ['history-user-prompt', 'server/index.js', '【用户自定义指令】'],
    ['history-project-agents', 'server/index.js', '说明（AGENTS.md）】'],
    ['history-shell-context', 'server/index.js', '【壳语境：'],
    ['completion-hint', 'server/agent.js', 'const COMPLETION_HINT = ['],
    ['guard-hints', 'server/agent.js', '【平台强制检测：本轮声称完成但无工具调用】'],
    ['guard-hints', 'server/agent.js', '【平台强制检测：本轮只输出行动承诺、未调用任何工具】'],
    ['guard-hints', 'server/agent.js', '请【停止原样重试】'],
    ['guard-hints', 'server/agent.js', '请【改变策略】'],
  ];
  const missing = cases.filter(([id, f, pat]) => !declaredFor(id, f, pat)).map(([id]) => id);
  assert.deepEqual(missing, [], '这些注入点没有声明（漏登记即 C4 假阴性）：' + missing.join('、'));
  // 漏项的缓存影响必须如实：4 条 hist 前注入 = 历史之前 ⇒ breaks-prefix；其余 = 尾巴区追加 ⇒ tail-only
  for (const id of ['history-early-summary', 'history-user-prompt', 'history-project-agents', 'history-shell-context']) {
    assert.equal(byId(id).where, 'system', id + ' 注入在历史之前，where 必须是 system');
    assert.equal(byId(id).cacheImpact, 'breaks-prefix', id + ' 在历史之前，改一次就让其后全部历史失效');
  }
  for (const id of ['completion-hint', 'guard-hints']) {
    assert.equal(byId(id).where, 'tail', id + ' 是运行期追加，位置=尾巴区');
    assert.equal(byId(id).cacheImpact, 'tail-only', id + ' 只影响其后的增量');
  }
});

test('跨轮指纹声明在位：prefix-assemble 必须登记（它是 C4 在"两次请求之间"维度的唯一机检）', () => {
  const p = byId('prefix-assemble');
  assert.ok(p, 'C4 的跨轮机检机制本身也必须进声明表（否则它自己就是无人看着的注入点）');
  assert.equal(p.cacheImpact, 'none', '它不进请求，所以不影响缓存');
  assert.ok(p.anchors.some((a) => a.file === 'server/history.js' && src('server/history.js').includes(a.pattern)), '锚点必须指向判定函数本体');
  assert.ok(p.anchors.some((a) => a.file === 'server/index.js'), '锚点必须指向组装侧的接线（只有函数没有接线=白写）');
  // 账本动作名是常量（写/读/分类共用一份定义）：改名人必须一起改，否则就是静默不计账
  assert.equal(PREFIX_LEDGER.ASSEMBLE, 'prefix:assemble');
  assert.equal(PREFIX_LEDGER.INVALIDATE, 'prefix:invalidate');
  assert.equal(PREFIX_LEDGER.EXEMPT, 'prefix:exempt');
  assert.equal(PREFIX_LEDGER.COLLAPSE, 'prefix:collapse');
  for (const [k, v] of Object.entries(PREFIX_LEDGER)) assert.ok(v.startsWith('prefix:'), k + ' 必须在 prefix: 命名空间下（审计分类 prefix:% 靠它）');
});

test('前缀破坏者名单必须可枚举且**恰好是这些**（多一个都要走评审，少一个说明漏报）', () => {
  const a = auditPrefixDeclarations();
  // 名单变更史（每一版都要在这里留一行理由，否则下次没人知道为什么是这几个）：
  //   · 2026-09-15 技能改 in-history 追加之后，skill-load 从名单里出去了（4 → 3 条）。
  //   · 2026-09-16 按 §3.5④ 补登记 4 条 hist 前注入（3 → 7 条）：它们**确实**在历史之前，
  //     如实标 breaks-prefix 才是对的 —— 把它们标成 tail-only 只会让声明白写（这也正是原表的病：
  //     没有这一行可标，于是整批注入从名单里消失，看起来"只有 3 个破坏者"）。
  assert.deepEqual(a.breakers, ['collapse', 'history-early-summary', 'history-project-agents', 'history-shell-context',
    'history-user-prompt', 'system-prompt', 'tools-face'],
  'breaks-prefix 名单变了：新加的前缀破坏者必须先在这里登记并说明理由');
  assert.ok(!a.breakers.includes('skill-load'), '载技能**不得**再破坏前缀（已改 in-history 追加）');
  assert.ok(!a.breakers.includes('completion-hint') && !a.breakers.includes('guard-hints'),
    '运行期追加的提示不得标成 breaks-prefix（它们在尾部，前面的历史照样命中）');
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
