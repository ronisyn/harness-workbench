// test/llm-retry.test.mjs - LLM 失败分类与可取消重试（架构对齐 DSH `dsh-llm-retry`）
//
// DSH 的两条核心口径：① 只在 `retryableCodes.includes(failure.code)` 时重试（不搞"一律重试"）；
// ② 每次重试"先把意图落进会话，再做**可取消**的等待"。这里锁：分类正确、等待可取消、
// 重试预算来自设置（不是写死的数）、agent 侧顺序与传参正确。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmRetryDecision, retryAfterMsOf, cancellableDelay } from '../server/llm/gateway.js';
import { LIMIT_DEFAULTS, SETTINGS_SCHEMA, schemaByKey } from '../server/settingsSchema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentSrc = fs.readFileSync(path.join(ROOT, 'server/agent.js'), 'utf8');
const err = (o) => Object.assign(new Error(o.message || 'x'), o);

test('分类：厂商侧可恢复的状态码才重试（限流/网关/超时）', () => {
  for (const st of [408, 409, 425, 429, 500, 502, 503, 504, 522, 524]) {
    assert.equal(llmRetryDecision(err({ status: st })).retryable, true, 'HTTP ' + st + ' 应可重试');
  }
});

test('分类：参数/鉴权/模型不存在等 4xx 不重试（重试纯属浪费厂商配额）', () => {
  for (const st of [400, 401, 403, 404, 413, 422]) {
    const d = llmRetryDecision(err({ status: st }));
    assert.equal(d.retryable, false, 'HTTP ' + st + ' 不该重试');
    assert.match(d.reason, /重试无效/);
  }
});

test('分类：网络/空闲超时类可重试；用户已停止一律不重试', () => {
  for (const m of ['fetch failed', 'socket hang up', 'read ECONNRESET', 'deepseek 流式空闲超时(90s 无数据)', 'deepseek(gpt) 流式连接失败: terminated']) {
    assert.equal(llmRetryDecision(new Error(m)).retryable, true, m + ' 应可重试');
  }
  const aborted = llmRetryDecision(err({ aborted: true, message: '流式中止' }));
  assert.equal(aborted.retryable, false, '用户按了停止就绝不能重试（等于把停止键按回去）');
  assert.match(aborted.reason, /用户已停止/);
});

test('分类：未分类失败按**不可重试**处理（宁可少重试，也不对未知错误反复打厂商）', () => {
  const d = llmRetryDecision(err({ needFallback: true, message: '工具 参数流式累积解析失败' }));
  assert.equal(d.retryable, false, '流式帧损坏走非流式兜底，不属于"重试"');
  assert.match(d.reason, /未分类/);
  assert.equal(llmRetryDecision(null).retryable, false);
});

test('等待时长优先用服务端 Retry-After；解析不出就不等（不自己编退避参数）', () => {
  assert.equal(retryAfterMsOf('30'), 30000);
  assert.equal(retryAfterMsOf(' 0 '), 0);
  assert.ok(retryAfterMsOf(new Date(Date.now() + 5000).toUTCString()) > 0);
  assert.equal(retryAfterMsOf('abc'), null);
  assert.equal(retryAfterMsOf(null), null);
  const d = llmRetryDecision(err({ status: 429, retryAfterMs: 2000 }));
  assert.equal(d.retryAfterMs, 2000, '分类结果必须把服务端给的等待时长带出来');
});

test('cancellableDelay：等待期间用户"停止"立刻返回 false；正常等完返回 true', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 60);
  const okAborted = await cancellableDelay(5000, ac.signal);
  const ms = Date.now() - t0;
  assert.equal(okAborted, false, '中止必须让等待立刻结束（不能等满 5s）');
  assert.ok(ms < 1000, '中止后应立即返回，实测 ' + ms + 'ms');
  assert.equal(await cancellableDelay(30, new AbortController().signal), true);
  const already = new AbortController(); already.abort();
  assert.equal(await cancellableDelay(5000, already.signal), false, '已中止的 signal 不该进等待');
  assert.equal(await cancellableDelay(0, undefined), true, '0/非法时长＝不需要等');
});

// ---------- 重试预算必须可调（不得把数字写死在代码里） ----------
test('可重试次数来自设置项 llm_max_retries（0=关，默认 1），不是写死的数', () => {
  assert.equal(LIMIT_DEFAULTS.llmMaxRetries, 1);
  const s = schemaByKey('llm_max_retries');
  assert.ok(s, 'settingsSchema 必须登记 llm_max_retries（否则 UI 里调不了、等于写死）');
  assert.equal(s.type, 'number');
  assert.equal(s.min, 0, '必须允许 0＝关闭');
  assert.ok(SETTINGS_SCHEMA.some((x) => x.key === 'llm_max_retries'));
  assert.match(agentSrc, /pick\('llm_max_retries'/, 'agent.js 必须从 settings 读它');
  assert.match(agentSrc, /llm_max_retries'\]\)/, 'agent.js 的 SELECT 键清单必须包含它（漏了会永远取默认值）');
});

// ---------- agent 侧顺序与传参（源级） ----------
test('重试判定必须同时看"可重试"与"剩余预算"（缺一个就会无限重试）', () => {
  assert.match(agentSrc, /if \(d\.retryable && attempt < maxRetries\)/, '重试条件必须同时含可重试与预算上限');
});

test('先落事件再等待（DSH：durable before cancellable wait）', () => {
  const iEvent = agentSrc.indexOf("type: 'llm_retry'");
  const iWait = agentSrc.indexOf('await cancellableDelay(');
  assert.ok(iEvent > 0, '未找到重试事件落点');
  assert.ok(iWait > 0, '未找到可取消等待');
  assert.ok(iEvent < iWait, '重试事件必须在等待**之前**发（否则等待中崩溃就查不到它准备重试过）');
});

test('非流式兜底必须带 signal（否则兜底那段时间里"停止"无效——这是修掉的那个洞）', () => {
  assert.match(agentSrc, /chatOnceWithTools\(provider, model, msgs, defs, keys, temperature, \{ signal: ctx\.__signal \}\)/, '兜底调用必须传 signal');
});

test('兜底失败不得被静默吞掉（原来 .catch(() => null) 吞了，排查时看不见）', () => {
  assert.match(agentSrc, /\[llm-retry\] 非流式兜底也失败/, '兜底失败必须出声');
  assert.ok(!/chatOnceWithTools\([^)]*\)\.catch\(\(\) => null\)/.test(agentSrc), '不得再静默吞掉兜底失败');
});
