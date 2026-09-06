// P1-4 最小回归测试集（2026-09 全面体检修复）
// 运行：node --test test/regression.test.mjs
// 覆盖：P0-1 密钥脱敏 redactSecrets（审计留痕脱敏，commit 1ec89d6 引入）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../server/tools/index.js';

test('P0-1: ghp_ 个人访问令牌被脱敏', () => {
  const fake = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0';
  const out = redactSecrets('my token is ' + fake + ' end');
  assert.equal(out.includes(fake), false, '完整 token 不应出现在输出中');
  assert.equal(out, 'my token is [REDACTED] end');
});

test('P0-1: github_pat_ 细粒度令牌被脱敏', () => {
  const fake = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  const out = redactSecrets('pat=' + fake);
  assert.equal(out.includes(fake), false);
  assert.equal(out, 'pat=[REDACTED]');
});

test('P0-1: sk- 形态密钥被脱敏', () => {
  const fake = 'sk-' + 'a1B2c3D4e5F6g7H8i9';
  const out = redactSecrets('key ' + fake + '!');
  assert.equal(out.includes(fake), false);
  assert.equal(out, 'key [REDACTED]!');
});

test('P0-1: Bearer 令牌被脱敏', () => {
  const fake = 'Bearer ' + 'xY'.repeat(12);
  const out = redactSecrets('Authorization: ' + fake);
  assert.equal(out.includes('Bearer ' + 'xY'.repeat(12)), false);
  assert.equal(out, 'Authorization: [REDACTED]');
});

test('P0-1: 非字符串输入原样透传（不抛异常）', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  const obj = { a: 1 };
  assert.equal(redactSecrets(obj), obj);
});

test('P0-1: 普通文本不受影响', () => {
  assert.equal(redactSecrets('hello world 123'), 'hello world 123');
});
