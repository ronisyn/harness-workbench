// test/prefix-epoch.test.mjs - M2 夹具：纪元指纹必须能**分辨**前缀面的任何改动，且不误报
// 依据 2026-09-15 实测（proposals/缓存追平DSH-方案-v1-20260915.md §2.2）：前缀面 +46 个 token
// 就让会话 185 的首轮未命中从 142 涨到 13,156。夹具的价值在**负例**：
// 系统提示一个字都没变时必须判"没换纪元"（否则每次启动都无谓预热、白花钱）。
import { test } from 'node:test';
import assert from 'node:assert';
import { prefixHash, epochKey, laneKey, isEpochChange, diffCore, isUnexpectedBreak } from '../server/prefix.js';

const ENV = '身份：你是 RW 工作台智能体\n环境信息…\n行动原则…';
const TOOLS = 'abc123def456';

test('纪元指纹是稳定的短串（同样输入永远同样结果，12 位十六进制）', () => {
  assert.equal(prefixHash(ENV), prefixHash(ENV));
  assert.match(prefixHash(ENV), /^[0-9a-f]{12}$/);
  assert.match(epochKey(ENV, TOOLS), /^[0-9a-f]{12}$/);
});

test('正例：系统提示变一个字符 ⇒ 换纪元（+46 token 那次的等价物）', () => {
  const before = epochKey(ENV, TOOLS);
  const after = epochKey(ENV + '。', TOOLS);
  assert.notEqual(before, after);
  assert.equal(isEpochChange(before, after), true);
});

test('正例：工具面变一个字符 ⇒ 换纪元（工具面是前缀里最贵的那段）', () => {
  assert.equal(isEpochChange(epochKey(ENV, TOOLS), epochKey(ENV, TOOLS + 'x')), true);
});

test('负例：两边都没动 ⇒ 不换纪元（否则每次启动都白预热一次）', () => {
  assert.equal(isEpochChange(epochKey(ENV, TOOLS), epochKey(ENV, TOOLS)), false);
});

test('负例：首次记录（prev 为空）不算变更，不报警不预热', () => {
  assert.equal(isEpochChange(null, epochKey(ENV, TOOLS)), false);
  assert.equal(isEpochChange(undefined, epochKey(ENV, TOOLS)), false);
  assert.equal(isEpochChange('', epochKey(ENV, TOOLS)), false);
});

test('负例：当前值不可用（空串）按"不变"处理 —— 宁可漏预热，不可每次启动都预热', () => {
  assert.equal(isEpochChange(epochKey(ENV, TOOLS), ''), false);
  assert.equal(isEpochChange(epochKey(ENV, TOOLS), null), false);
});

test('拼接不歧义：("ab","c") 与 ("a","bc") 必须给出不同纪元键', () => {
  assert.notEqual(epochKey('ab', 'c'), epochKey('a', 'bc'));
});

test('泳道标签：permission / preset / light 任一不同即为不同泳道（=不同前缀）', () => {
  assert.equal(laneKey('read', 'all'), 'read/all');
  assert.notEqual(laneKey('read', 'all'), laneKey('full', 'all'));
  assert.notEqual(laneKey('read', 'all'), laneKey('read', 'minimal'));
  assert.equal(laneKey('read', 'all', true), 'read/all#light');
  assert.notEqual(laneKey('read', 'all'), laneKey('read', 'all', true), '轻量面与全量面是两条不同前缀');
  assert.equal(laneKey(), 'full/all'); // 缺省即默认泳道
});

test('回归：既有 diffCore/isUnexpectedBreak 语义未被本次改动破坏', () => {
  // 注意：diffCore 判的是**对象同一性**（"未被就地改写"），不是深相等 —— 所以这里必须共用同一个引用。
  const shared = { role: 'user', content: 'x' };
  const prev = [shared];
  const appended = [shared, { role: 'assistant', content: 'y' }];
  assert.equal(diffCore(prev, appended), null, '只追加（原对象未被换掉）= 合规');
  const d = diffCore(prev, [{ role: 'user', content: 'x' }]);
  assert.ok(d, '首条被换成新对象 = 断链（哪怕内容一样）');
  assert.equal(isUnexpectedBreak(d, -1, 3), true, '非折叠轮的断链 = 非预期（C4）');
  assert.equal(isUnexpectedBreak(d, 3, 3), false, '折叠轮的断链 = 预期（C5）');
});

test('确定性（真实泳道）：连续两次算出同一纪元键 —— 前缀面只要有非确定性，每次请求都会是冷的', async () => {
  const { laneEpoch, FACES } = await import('../server/epoch.js');
  for (const light of [false, true]) {
    const a = laneEpoch('read', 'all', light);
    const b = laneEpoch('read', 'all', light);
    assert.equal(a.key, b.key);
    assert.equal(a.sysHash, b.sysHash);
    assert.equal(a.toolsHash, b.toolsHash);
    assert.ok(a.defs.length > 0, '工具面不能为空（空工具面 = 前缀与真实请求完全对不上）');
  }
  // 两种工具面必须是两条不同前缀（light 会随消息内容翻转，漏掉一面就漏掉一半真实请求）
  assert.notEqual(laneEpoch('read', 'all', false).key, laneEpoch('read', 'all', true).key);
  // 不同 permission 必须是不同泳道（身份层随 permission 变）
  assert.notEqual(laneEpoch('read', 'all').key, laneEpoch('full', 'all').key);
  assert.equal(FACES.length, 2, '工具面有且只有两种：全量面 / 轻量面（多一种就要同步改 agent.js 的 defs 表达式）');
});
