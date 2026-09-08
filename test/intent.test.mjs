// test/intent.test.mjs - B2 意图分类纯函数单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../server/intent.js';

test('高危险词 → act-high', () => {
  assert.equal(classifyIntent('把测试库里的那条记录删了').label, 'act-high');
  assert.equal(classifyIntent('删除一下线上配置').label, 'act-high');
});
test('只读规划词 → readonly', () => {
  assert.equal(classifyIntent('先别改，帮我把这次重构的方案想清楚').label, 'readonly');
  assert.equal(classifyIntent('帮我分析一下这段代码').label, 'readonly');
});
test('普通动手 → act', () => {
  assert.equal(classifyIntent('帮我修一下登录超时的问题').label, 'act');
  assert.equal(classifyIntent('给导出加一个 jsonl 格式').label, 'act');
});
test('闲聊/收尾 → chat', () => {
  assert.equal(classifyIntent('你觉得昨天那场比赛怎么样').label, 'chat');
  assert.equal(classifyIntent('就这样吧，谢谢').label, 'chat');
});
test('口语化像任务但无命中 → ask（不猜）', () => {
  assert.equal(classifyIntent('帮我把那坨经常抽风的逻辑拾掇一下').label, 'act'); // 拾掇命中 do
  assert.equal(classifyIntent('这个玩意能弄不').label, 'ask');
});
test('壳级词表覆盖默认（优先级 高危>只读>动手）', () => {
  const rules = { highRisk: ['危险动作A'], readonly: ['仅看看'], do: ['执行X'] };
  assert.equal(classifyIntent('执行X 仅看看', rules).label, 'readonly');
  assert.equal(classifyIntent('危险动作A 执行X', rules).label, 'act-high');
});
