// test/op03-hooks.test.mjs - OP-03 夹具：策略引擎的**失败语义必须是显式契约**，且出事必留痕
// 依据《RW-Agent 架构 v1.1》§15 `OP-03`（"fail-open/closed、超时、缓存失效"缺失）与 §7.2 失败语义表。
// 旧问题：语义靠 `builtin && failClosed` 这个**隐式默认**决定，且**没有超时**——一个挂起的钩子能冻住整轮工具调用。
// 本夹具的价值在负例：没声明语义的注册必须被拒；声明 open 的钩子抛错后**必须继续执行后续钩子**。
import { test } from 'node:test';
import assert from 'node:assert';
import { registerHook, clearHook, emitHooks, listHooks, hookPolicySummary } from '../server/tools/hooks.js';

test('OP-03 负例：不声明 failure 的注册直接被拒（语义不能靠隐式默认）', () => {
  assert.throws(() => registerHook('before', '__t__', 'no_policy', () => ({})), /必须显式声明失败语义/);
  assert.throws(() => registerHook('before', '__t__', 'bad_policy', () => ({}), { failure: 'maybe' }), /必须显式声明失败语义/);
  assert.equal(listHooks().some((h) => h.name === 'no_policy'), false, '被拒的钩子不得进入注册表');
});

test('OP-03 兼容：老写法 failClosed 布尔仍可用，且被规范化成 failure', () => {
  registerHook('before', '__t__', 'legacy_closed', () => ({}), { failClosed: true });
  registerHook('before', '__t__', 'legacy_open', () => ({}), { failClosed: false });
  const byName = Object.fromEntries(listHooks().map((h) => [h.name, h]));
  assert.equal(byName.legacy_closed.failure, 'closed');
  assert.equal(byName.legacy_open.failure, 'open');
  clearHook(null, null, 'legacy_closed'); clearHook(null, null, 'legacy_open');
});

test('OP-03 正例：fail-closed 钩子抛错 → 拦截（危险动作宁可停）', async () => {
  registerHook('before', '__t__', 'boom_closed', () => { throw new Error('引擎炸了'); }, { failure: 'closed' });
  const r = await emitHooks('before', '__t__', { args: {}, ctx: {} });
  assert.equal(r.stopped, true);
  assert.match(r.reason, /fail-closed|引擎炸了/);
  clearHook(null, null, 'boom_closed');
});

test('OP-03 负例：fail-open 钩子抛错 → 放行，且**后续钩子照常执行**（不能一颗老鼠屎坏一锅）', async () => {
  registerHook('before', '__t__', 'boom_open', () => { throw new Error('引擎炸了'); }, { failure: 'open' });
  let later = false;
  registerHook('before', '__t__', 'after_boom', () => { later = true; return {}; }, { failure: 'open' });
  const r = await emitHooks('before', '__t__', { args: {}, ctx: {} });
  assert.equal(r.stopped, false, 'fail-open 必须放行');
  assert.equal(later, true, 'fail-open 的钩子抛错不得阻断后续钩子');
  clearHook(null, null, 'boom_open'); clearHook(null, null, 'after_boom');
});

test('OP-03 正例：钩子挂起必须被超时打断，并按声明的语义处置', async () => {
  const never = () => new Promise(() => {});
  registerHook('before', '__t__', 'hang_closed', never, { failure: 'closed', timeoutMs: 40 });
  const t0 = Date.now();
  const r = await emitHooks('before', '__t__', { args: {}, ctx: {} });
  assert.equal(r.stopped, true, '超时 + fail-closed ⇒ 拦截（旧实现没有超时，会永久挂住）');
  assert.ok(Date.now() - t0 < 1500, '必须真的被打断，而不是等钩子自己结束');
  clearHook(null, null, 'hang_closed');

  registerHook('before', '__t__', 'hang_open', never, { failure: 'open', timeoutMs: 40 });
  const r2 = await emitHooks('before', '__t__', { args: {}, ctx: {} });
  assert.equal(r2.stopped, false, '超时 + fail-open ⇒ 放行');
  clearHook(null, null, 'hang_open');
});

test('OP-03 尾巴：参数改写必须留痕（asked/used 都在），且改写结果真的生效', async () => {
  registerHook('before', '__t__', 'rewriter', () => ({ args: { path: '/normalized/x' } }), { failure: 'open', rewritesArgs: true });
  const payload = { args: { path: 'x', keep: 1 }, ctx: {} };
  const r = await emitHooks('before', '__t__', payload);
  assert.equal(payload.args.path, '/normalized/x', '改写要生效');
  assert.equal(payload.args.keep, 1, '浅合并：未提到的键保留');
  assert.equal(r.rewrites.length, 1, '改写必须被记录');
  assert.equal(r.rewrites[0].by, 'rewriter');
  assert.equal(r.rewrites[0].asked.path, 'x', '改写前');
  assert.equal(r.rewrites[0].used.path, '/normalized/x', '改写后');
  clearHook(null, null, 'rewriter');
});

test('OP-03 自检：内置钩子每一处都声明了合法语义（closed 只留给真正的安全网）', () => {
  const s = hookPolicySummary();
  assert.ok(s.n >= 13, '内置钩子应至少 13 处注册，实为 ' + s.n);
  assert.deepEqual(s.bad, [], '不得存在语义不可判定的钩子');
  assert.equal(s.closed + s.open, s.n, '每一处注册都要落在 closed/open 之一');
  assert.ok(s.closed >= 2, '至少 danger_command_guard 与 system_write_guard 是 fail-closed');
  const closedHooks = [...new Set(listHooks().filter((h) => h.failure === 'closed').map((h) => h.name))];
  assert.deepEqual(closedHooks.sort(), ['danger_command_guard', 'system_write_guard'], 'fail-closed 名单必须恰好是这两条安全网（多一条都要有理由）');
});

test('OP-03：stop 之后不再执行后续钩子（短路语义未被本次改动破坏）', async () => {
  let later = false;
  registerHook('before', '__t__', 'stopper', () => ({ stop: true, reason: '停' }), { failure: 'open' });
  registerHook('before', '__t__', 'never_ran', () => { later = true; return {}; }, { failure: 'open' });
  const r = await emitHooks('before', '__t__', { args: {}, ctx: {} });
  assert.equal(r.stopped, true);
  assert.equal(r.reason, '停');
  assert.equal(later, false);
  clearHook(null, null, 'stopper'); clearHook(null, null, 'never_ran');
});
