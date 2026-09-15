// test/failures.test.mjs - 统一失败分类（2026-09-15）
//
// 锁四件事：
//   ① 码表本身可用：每个码都有 retryable 与处置说明；用表外的码直接抛错（防"悄悄多出一个没人认识的分类"）；
//   ② 分类函数只认可靠信号（errno/错误名/HTTP 状态），不靠中文文案猜；
//   ③ LLM 侧的重试判定**读同一张表**（不允许两处各判一次）；
//   ④ 源码交叉核对：server/ 里出现的每个失败码都在表里（这是这条链最容易被改烂的地方）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAIL, fail, failSpec, classifyToolThrow, inputError } from '../server/failures.js';
import { llmRetryDecision } from '../server/llm/gateway.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const err = (o) => Object.assign(new Error(o.message || 'x'), o);

test('码表：每项都有明确的"能不能重试"与处置说明', () => {
  const codes = Object.keys(FAIL);
  assert.ok(codes.length >= 15, '码表太小，可能是被删空了');
  for (const c of codes) {
    assert.equal(typeof FAIL[c].retryable, 'boolean', c + ' 缺 retryable');
    assert.ok(String(FAIL[c].note || '').length >= 6, c + ' 缺处置说明（人看不懂的码等于没分类）');
    assert.match(c, /^[A-Z][A-Z0-9_]+$/, c + ' 命名不规范（大写+下划线）');
  }
  assert.equal(new Set(codes).size, codes.length);
});

test('fail()：表外的码直接抛错（不许悄悄流进账本）；表内的码产出 {error, code}', () => {
  assert.throws(() => fail('NOT_A_REGISTERED_CODE', 'x'), /未登记的失败码/);
  const r = fail('TOOL_ARGS_INVALID', '参数 path 必填');
  assert.equal(r.code, 'TOOL_ARGS_INVALID');
  assert.equal(r.error, '参数 path 必填');
  assert.deepEqual(Object.keys(r).sort(), ['code', 'error'], '工具结果口径就这两个字段（另加的字段由 extra 显式给）');
  assert.equal(fail('TOOL_TIMEOUT', 'x', { timeoutMs: 5 }).timeoutMs, 5, 'extra 必须能带附加信息（如超时毫秒）');
  assert.equal(failSpec('TOOL_TIMEOUT').retryable, false);
  assert.equal(failSpec('NOT_A_REGISTERED_CODE'), null);
});

test('工具异常分类：只认 errno/错误名，不靠中文文案', () => {
  assert.equal(classifyToolThrow(err({ aborted: true, message: '数据库操作已被中止' })).code, 'ABORTED');
  assert.equal(classifyToolThrow(err({ code: 'TOOL_TIMEOUT', message: '超时' })).code, 'TOOL_TIMEOUT');
  assert.equal(classifyToolThrow(err({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyToolThrow(err({ code: 'ENOTFOUND' })).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyToolThrow(err({ name: 'AbortError', message: 'This operation was aborted' })).code, 'TOOL_TIMEOUT');
  assert.equal(classifyToolThrow(err({ name: 'TimeoutError' })).code, 'TOOL_TIMEOUT');
  assert.equal(classifyToolThrow(new Error('fetch failed')).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(classifyToolThrow(new Error('随便什么错')).code, 'TOOL_ERROR');
  // 文案里的字眼不该左右分类（这条就是"不靠中文猜"的反例锁）
  assert.equal(classifyToolThrow(new Error('未找到该文件，重试无效')).code, 'TOOL_ERROR');
});

test('输入与现实不符要单独成码（平台没坏，是模型猜错了表名/路径/原文）', () => {
  // 可靠信号一：文件系统 errno
  for (const c of ['ENOENT', 'ENOTDIR', 'EISDIR']) assert.equal(classifyToolThrow(err({ code: c })).code, 'TOOL_INPUT_REJECTED', c);
  // 可靠信号二：MySQL 的输入类错误码（真实数据：近 14 天 db_query 22 次 Unknown column → ER_BAD_FIELD_ERROR）
  for (const c of ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_PARSE_ERROR']) assert.equal(classifyToolThrow(err({ code: c })).code, 'TOOL_INPUT_REJECTED', c);
  // 可靠信号三：工具自己判定（edit_file 的 old 不匹配 6 次）
  assert.equal(classifyToolThrow(inputError('未找到要替换的原文')).code, 'TOOL_INPUT_REJECTED');
  assert.equal(inputError('x').code, 'TOOL_INPUT_REJECTED');
  // 与"平台坏了"必须分开：这两类的处置人不同
  assert.notEqual(classifyToolThrow(inputError('x')).code, classifyToolThrow(new Error('内部错误')).code);
  assert.equal(FAIL.TOOL_INPUT_REJECTED.retryable, false, '同一输入重试没意义（要改输入）');
});

test('LLM 侧读同一张表：retryable 必须等于码表里的值', () => {
  const cases = [
    [err({ status: 429 }), 'LLM_RATE_LIMITED'],
    [err({ status: 503 }), 'LLM_HTTP_RETRYABLE'],
    [err({ status: 408 }), 'LLM_HTTP_RETRYABLE'],
    [err({ status: 401 }), 'LLM_HTTP_FATAL'],
    [err({ status: 400 }), 'LLM_HTTP_FATAL'],
    [err({ aborted: true }), 'LLM_ABORTED'],
    [err({ needFallback: true }), 'LLM_STREAM_BROKEN'],
    [new Error('socket hang up'), 'LLM_NETWORK'],
    [new Error('莫名其妙'), 'LLM_UNKNOWN'],
  ];
  for (const [e, code] of cases) {
    const d = llmRetryDecision(e);
    assert.equal(d.code, code, '分类不符：' + e.message);
    assert.equal(d.retryable, FAIL[code].retryable, code + ' 的 retryable 必须来自码表（不许两处各判一次）');
  }
  assert.equal(llmRetryDecision(err({ status: 429, retryAfterMs: 3000 })).retryAfterMs, 3000);
});

test('源码交叉核对：server/ 里出现的失败码都在表里（改名/新增漏登记会在这里被拦下）', () => {
  const files = [];
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      if (it.name === 'node_modules') continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (/\.m?js$/.test(it.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // 只认"当码用"的写法：fail('X') / blockedCode = 'X' / err.code = 'X' / code: 'X'
    for (const m of src.matchAll(/(?:fail\(|blockedCode\s*=\s*|err\.code\s*=\s*|code:\s*)'([A-Z][A-Z0-9_]+)'/g)) used.add(m[1]);
  }
  const unknown = [...used].filter((c) => !FAIL[c]);
  assert.deepEqual(unknown, [], '这些码在 server/ 里被使用但没在 failures.js 登记：' + unknown.join(', '));
  assert.ok(used.size >= 8, '交叉核对没扫到码（匹配规则可能失效了）：' + [...used].join(','));
});
