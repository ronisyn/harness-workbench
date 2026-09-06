// P20 流式 tool_calls 累加器单测（纯函数，无网络）：三形态（增量拼接/多工具交错/整块）+ 解析失败回退信号
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulateToolDeltas, finalizeToolCalls } from '../server/llm/gateway.js';

test('单工具多块参数增量拼接', () => {
  let acc = { calls: [] };
  acc = accumulateToolDeltas(acc, [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }]);
  acc = accumulateToolDeltas(acc, [{ index: 0, function: { arguments: '"/a.js"}' } }]);
  const calls = finalizeToolCalls(acc);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: '/a.js' });
});

test('多工具交错增量互不污染', () => {
  let acc = { calls: [] };
  acc = accumulateToolDeltas(acc, [{ index: 0, id: 'a', function: { name: 'grep_search', arguments: '{"q":"x"' } }]);
  acc = accumulateToolDeltas(acc, [{ index: 1, id: 'b', function: { name: 'find_file', arguments: '{"n":"y"' } }]);
  acc = accumulateToolDeltas(acc, [{ index: 0, function: { arguments: '}' } }]);
  acc = accumulateToolDeltas(acc, [{ index: 1, function: { arguments: '}' } }]);
  const calls = finalizeToolCalls(acc);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'grep_search');
  assert.equal(calls[1].function.name, 'find_file');
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { n: 'y' });
});

test('整块发送（兼容网关）直接通过', () => {
  let acc = { calls: [] };
  acc = accumulateToolDeltas(acc, [{ index: 0, id: 'c', type: 'function', function: { name: 'db_query', arguments: '{"sql":"SELECT 1"}' } }]);
  const calls = finalizeToolCalls(acc);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { sql: 'SELECT 1' });
});

test('空 delta / 非对象安全忽略', () => {
  let acc = { calls: [] };
  acc = accumulateToolDeltas(acc, null);
  acc = accumulateToolDeltas(acc, [null, { index: 'x' }, { index: -1 }]);
  assert.equal(finalizeToolCalls(acc).length, 0);
});

test('参数残缺解析失败抛错（触发一次性回退信号）', () => {
  let acc = { calls: [] };
  acc = accumulateToolDeltas(acc, [{ index: 0, id: 'd', function: { name: 'run_command', arguments: '{"cmd":' } }]);
  assert.throws(() => finalizeToolCalls(acc), /解析失败/);
});
