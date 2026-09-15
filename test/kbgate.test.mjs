// test/kbgate.test.mjs - RA-09 夹具：不用知识的轮次，上下文里一条知识都没有
// 依据《RW-Agent 架构 v1.1》§14.3 RA-09；被测单元 server/kbgate.js（纯函数）。
// 本夹具的价值在**负例**：不仅证明"该注入时注入了"，更要证明"不该注入时确实一个字节都没有"。
import { test } from 'node:test';
import assert from 'node:assert';
import { kbInjectMode, kbBlock, KB_INTENT_RE } from '../server/kbgate.js';

const ROWS = [
  { scope: 'global', title: '发布纪律', body: '先 TEST 再 PROD。\n回滚必须演练过。' },
  { scope: 'shell', title: '本壳约定', body: '正文只给前五条。' },
];

test('RA-09 负例：本轮无关且从未用过知识 → none，且不产出任何注入块', () => {
  assert.equal(kbInjectMode('把 build 脚本里的 vite 版本抬到 8', 0), 'none');
  assert.equal(kbBlock(ROWS, 'none'), null, 'none 档必须返回 null（调用方据此跳过注入）');
});

test('RA-09 负例：即使库里有 12 条知识，none 档也不得漏出标题', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ scope: 'global', title: '条目' + i, body: 'x' }));
  assert.equal(kbBlock(many, 'none'), null);
});

test('RA-09 负例：无可见知识时不注入空标题块', () => {
  assert.equal(kbBlock([], 'index'), null);
  assert.equal(kbBlock([], 'explicit'), null);
  assert.equal(kbBlock(null, 'explicit'), null);
});

test('RA-09 正例：本轮在问知识 → explicit（标题 + 前 5 条正文摘要）', () => {
  assert.equal(kbInjectMode('我们之前说过的发布纪律是什么？', 0), 'explicit');
  const block = kbBlock(ROWS, 'explicit');
  assert.match(block, /【知识库条目/);
  assert.match(block, /- \[全局\] 发布纪律/);
  assert.match(block, /先 TEST 再 PROD/, 'explicit 应带正文摘要');
});

test('RA-09 正例：本会话此前实际用过 kb_* → index（只给标题，无正文）', () => {
  assert.equal(kbInjectMode('继续按刚才的办法做', 3), 'index');
  const block = kbBlock(ROWS, 'index');
  assert.match(block, /- \[全局\] 发布纪律/);
  assert.ok(!block.includes('先 TEST 再 PROD'), 'index 档不得带正文');
  assert.ok(block.length < kbBlock(ROWS, 'explicit').length, 'index 档应比 explicit 更小');
});

test('RA-09 摘要上限：最多 5 条带正文、每条 300 字符、总量 12 条', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ scope: 'conv', title: 't' + i, body: 'b'.repeat(1000) }));
  const block = kbBlock(rows, 'explicit');
  assert.equal(block.split('\n- ').length - 1, 12, '注入上限 12 条');
  const withBody = block.split('\n- ').slice(1).filter((l) => l.includes('b'.repeat(10)));
  assert.equal(withBody.length, 5, '带正文摘要的最多 5 条');
  for (const l of withBody) assert.ok(l.length <= 300 + 20, '单条摘要 ≤300 字符');
});

test('RA-09 词面判据：只收记忆/知识类词，普通任务词不误判为 explicit', () => {
  for (const s of ['知识库', '长期记忆', '错题', '复盘', '经验教训', '之前的约定']) assert.ok(KB_INTENT_RE.test(s), s + ' 应命中');
  for (const s of ['把这个文件删掉', '跑一下测试', '重构 driver.js', '帮我看看文档']) assert.ok(!KB_INTENT_RE.test(s), s + ' 不应命中');
});
