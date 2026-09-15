// test/invariants.test.mjs - 步8 三条不变式机检（架构 §3.5）：每条都带"故意破坏 → 必须报红"的负例，
// 防止出现"永远不会红的假门禁"。
//   ① 缓存三纪律（只追加/前缀冻结/工具面冻结）
//   ② 第 2 层 fail-closed（安全网钩子异常时必须拦，纪律钩子按声明放行）
//   ③ 系统层 + 工具层逐字节一致（工具面同输入同字节；变了必须能被哈希发现）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { diffCore, isUnexpectedBreak } from '../server/prefix.js';
import { toolDefs } from '../server/tools/index.js';
import { listHooks, registerHook, clearHook, emitHooks } from '../server/tools/hooks.js';

// ---------- ① 只追加 / 前缀冻结 / 工具面冻结 ----------
test('① 只追加：新消息追加在尾部 → 不算断链', () => {
  const a = { role: 'user' }, b = { role: 'assistant' };
  assert.equal(diffCore([a], [a, b]), null);
  assert.equal(diffCore(null, [a]), null, '首轮无对照，恒合规');
});

test('① 故意破坏：就地改写/替换早期消息 → 必须报出首个不同下标', () => {
  const a = { role: 'user', content: '原' }, b = { role: 'tool' };
  const rewritten = { role: 'user', content: '被改写' }; // 模拟"折叠以外的就地改写"
  const d = diffCore([a, b], [rewritten, b]);
  assert.ok(d, '改写早期消息必须被检出');
  assert.equal(d.broke, 0);
  // 破坏性更强的两种情况同样必须检出
  assert.equal(diffCore([a, b], [a]).broke, 1, '历史被截断必须检出');
  assert.equal(diffCore([a, b], [b, a]).broke, 0, '顺序被调换必须检出');
});

test('① 段边界折叠是预期失效：折叠轮的断链不计 C4，其余轮次必须计', () => {
  const a = { role: 'user' };
  const d = diffCore([a], []); // 折叠把早期整段换成一条 system → core 变短
  assert.ok(d);
  assert.equal(isUnexpectedBreak(d, 3, 3), false, '折叠轮：预期失效（C5），不计 C4');
  assert.equal(isUnexpectedBreak(d, 3, 4), true, '非折叠轮：必须计 C4');
  assert.equal(isUnexpectedBreak(null, -1, 5), false, '无断链不必计');
});

test('① 工具面冻结：同输入同字节，且哈希必须能发现变化（非空检）', () => {
  const h = (defs) => createHash('sha256').update(JSON.stringify(defs)).digest('hex').slice(0, 12);
  const a = toolDefs('all', null, null);
  const b = toolDefs('all', null, null);
  assert.equal(h(a), h(b), '同输入必须逐字节一致（否则每轮前缀都会变）');
  assert.notEqual(h(a), h(toolDefs('standard', null, null)), '裁剪档位不同必须得出不同哈希（证明检查不是恒真）');
  assert.notEqual(h(a), h(a.slice(1)), '工具面少一个工具必须改变哈希');
});

// ---------- ② 第 2 层 fail-closed ----------
// 2026-09-15 OP-03：语义字段从 `failClosed` 布尔改为 `failure: 'closed'|'open'`，
// 且**注册时必填**（不声明直接抛错，见 test/op03-hooks.test.mjs）。本项仍锁同一件事：
// 出事时是拦还是放必须显式可审计，且安全网只能是那两条。
test('② 安全网钩子声明 fail-closed；纪律钩子声明 fail-open（语义显式，不许靠缺省）', () => {
  const builtin = listHooks().filter((x) => x.builtin);
  assert.ok(builtin.length >= 10, '内置钩子应已注册：' + builtin.length);
  for (const x of builtin) assert.ok(['closed', 'open'].includes(x.failure), x.name + ' 必须显式声明 failure=closed|open');
  const closed = builtin.filter((x) => x.failure === 'closed').map((x) => x.name);
  for (const must of ['danger_command_guard', 'system_write_guard']) {
    assert.ok(closed.includes(must), must + ' 是安全网，必须 fail-closed（被改成放行＝门禁失效）');
  }
  const open = builtin.filter((x) => x.failure === 'open').map((x) => x.name);
  for (const guide of ['preset_tier_guard', 'enabled_tools_guard', 'readonly_intent_guard', 'shell_cd_normalizer']) {
    assert.ok(open.includes(guide), guide + ' 是纪律引导，按设计 fail-open');
  }
});

test('② 故意破坏：fail-closed 钩子抛错 → 必须拦截（而不是放行）', async () => {
  registerHook('before', 'ghost_tool', 'test_boom_closed', () => { throw new Error('注入的钩子故障'); }, { builtin: true, failure: 'closed' });
  const r = await emitHooks('before', 'ghost_tool', { args: {}, ctx: {} });
  assert.equal(r.stopped, true, 'fail-closed 钩子异常必须拦截执行');
  assert.match(r.reason, /fail-closed/);
  clearHook('before', 'ghost_tool', 'test_boom_closed');
});

test('② fail-open 钩子抛错 → 只告警不阻断（纪律是引导，不拖垮主流程）', async () => {
  registerHook('before', 'ghost_tool', 'test_boom_open', () => { throw new Error('注入的纪律钩子故障'); }, { builtin: true, failure: 'open' });
  const r = await emitHooks('before', 'ghost_tool', { args: {}, ctx: {} });
  assert.equal(r.stopped, false, 'fail-open 钩子异常不应阻断');
  clearHook('before', 'ghost_tool', 'test_boom_open');
});

// ---------- ③ 系统层 + 工具层逐字节一致 ----------
test('③ 系统提示层：固定段与尾巴区的拼装顺序稳定（固定段在前，易变内容在历史之后）', async () => {
  // 该不变式的运行期机检在 agent.js（[prefix-debug] sys/tools 哈希 + [prefix-invariant]）；
  // 这里锁住"可静态验证"的那一半：环境/身份/纪律三层同输入必须逐字节一致。
  const mod = await import('../server/agent.js');
  const parts = [mod.ENV_ENV, mod.ENV_IDENTITY('full'), mod.ENV_DISCIPLINE];
  assert.equal(parts.join('\u0000'), [mod.ENV_ENV, mod.ENV_IDENTITY('full'), mod.ENV_DISCIPLINE].join('\u0000'), '同输入必须同字节');
  assert.notEqual(mod.ENV_IDENTITY('read'), mod.ENV_IDENTITY('full'), '权限层必须随权限变化（证明不是常量）');
  assert.ok(mod.ENV_ENV.includes('环境信息'), '环境层内容在位');
});
