// test/streampatch.test.mjs - RA-37 G1 补流对账夹具
// 依据《RW-Agent 架构 v1.1》§14.9 RA-37："任一客户端仅靠事件流可重建全过程"。
// 这条主张成立的前提是：**delta 顺序拼接 == 落库正文**。而落库正文会被后置加工（续写/截断提示/假完成前缀/
// 空答兜底摘要），那些字节从不经过 delta —— 本夹具测的就是"差额算得对不对"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamPatch } from '../server/streampatch.js';

const joined = (streamed, p) => streamed + p.tail; // 客户端最终看到的正文 = 已流的 + 补发的尾部
const clientSees = (streamed, p) => p.head + streamed + p.tail;

test('RA-37 后置追加（C4 续写段 / 截断提示 / 兜底摘要）→ 只补尾部', () => {
  const streamed = '正文前半';
  const stored = '正文前半' + '（本轮输出触到模型长度上限，已截断）';
  const p = streamPatch(stored, streamed);
  assert.equal(p.mode, 'appended');
  assert.equal(p.head, '');
  assert.equal(clientSees(streamed, p), stored, '拼接结果必须逐字等于落库正文');
  assert.equal(joined(streamed, p), stored);
});

test('RA-37 前置加注（假完成 ⚠️ 前缀）→ 只补前缀（顺序也要对）', () => {
  const streamed = '我已经完成了所有工作。';
  const stored = '⚠️【平台检测：本回复只承诺行动、无任何工具调用记录，内容未经工具验证】\n' + streamed;
  const p = streamPatch(stored, streamed);
  assert.equal(p.mode, 'prefixed');
  assert.equal(p.tail, '');
  assert.equal(clientSees(streamed, p), stored, '前缀必须补在已流正文**之前**');
});

test('RA-37 头尾都夹了东西 → 头尾都补', () => {
  const streamed = '中段';
  const stored = '【头】' + streamed + '【尾】';
  const p = streamPatch(stored, streamed);
  assert.equal(p.mode, 'wrapped');
  assert.equal(clientSees(streamed, p), stored);
});

test('RA-37 完全一致 → 一个字节都不补（不能重复显示）', () => {
  const p = streamPatch('一样的内容', '一样的内容');
  assert.equal(p.mode, 'exact');
  assert.deepEqual([p.head, p.tail], ['', '']);
});

test('RA-37 对不上账 → 整段补发并标记 mismatch（宁可重复，也不让客户端与库不符）', () => {
  const p = streamPatch('库里是这样', '流出去的是另一样');
  assert.equal(p.mode, 'mismatch');
  assert.equal(p.tail, '库里是这样');
});

test('RA-37 边界：空正文/空流式文本/空值都不炸', () => {
  assert.equal(streamPatch('', 'x').mode, 'empty');
  assert.deepEqual(streamPatch('', 'x'), { head: '', tail: '', mode: 'empty' });
  const noStream = streamPatch('有正文但没流过', '');
  assert.equal(noStream.mode, 'no-stream');
  assert.equal(noStream.tail, '有正文但没流过');
  assert.equal(streamPatch(null, null).mode, 'empty');
  assert.equal(streamPatch('abc', undefined).tail, 'abc');
});
