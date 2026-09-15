// test/modelwindow.test.mjs - RA-08 比例制折叠阈值：换小窗口模型 → 阈值自动收紧；未知模型 → 回退绝对值并说明
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowOf, effectiveCollapseChars, WINDOW_DEFAULTS, CHARS_PER_TOKEN } from '../server/modelwindow.js';

test('已知模型能取到窗口；未知模型返回 null（不猜）', () => {
  assert.equal(windowOf('deepseek-v4-flash'), WINDOW_DEFAULTS['deepseek-v4']);
  assert.equal(windowOf('glm-4-plus'), WINDOW_DEFAULTS['glm-4']);
  assert.equal(windowOf('some-unknown-model-xyz'), null);
  assert.equal(windowOf(''), null);
});

test('阈值恒为 min(绝对阈值, 比例阈值)：绝不比改造前的绝对阈值更激进', () => {
  const r = effectiveCollapseChars('deepseek-v4-flash', 30000, 0.15, null);
  const byRatio = Math.floor(WINDOW_DEFAULTS['deepseek-v4'] * 0.15 * CHARS_PER_TOKEN);
  assert.equal(r.chars, Math.min(30000, byRatio), '取两者较小值');
  assert.ok(r.chars <= 30000, '有效阈值不得超过绝对阈值（不激进）');
  assert.ok(r.note.length > 0, '必须说明阈值来源与窗口');
});

test('小窗口模型：比例阈值更小 → 自动收紧（RA-08 的核心要求）', () => {
  const big = effectiveCollapseChars('deepseek-v4-flash', 30000, 0.15, null);
  const small = effectiveCollapseChars('deepseek-v3', 30000, 0.15, null); // 65536 tokens
  assert.equal(small.source, 'ratio');
  assert.ok(small.chars < big.chars, '小窗口必须得到更小的折叠阈值：' + small.chars + ' < ' + big.chars);
  assert.equal(small.chars, Math.floor(65536 * 0.15 * CHARS_PER_TOKEN));
});

test('未知模型：回退绝对阈值，并给出"未知"说明（不静默假装比例制生效）', () => {
  const r = effectiveCollapseChars('mystery-model', 12345, 0.15, null);
  assert.equal(r.chars, 12345);
  assert.equal(r.source, 'absolute');
  assert.equal(r.windowTokens, null);
  assert.match(r.note, /窗口未知/);
});

test('窗口越大阈值越大（单调），且设置里的覆盖表优先于内置表', () => {
  const a = effectiveCollapseChars('deepseek-v3', 999999, 0.15, null).chars;
  const b = effectiveCollapseChars('deepseek-v4-flash', 999999, 0.15, null).chars;
  assert.ok(b > a, '窗口大 → 阈值大');
  const ov = effectiveCollapseChars('deepseek-v4-flash', 999999, 0.15, { 'deepseek-v4': 8192 });
  assert.equal(ov.chars, Math.floor(8192 * 0.15 * CHARS_PER_TOKEN), '覆盖表生效');
});

// 2026-09-15（C-14）：settings `collapse_window_ratio` 声明"0=关闭比例制只用绝对阈值"，
// 而这条语义此前**三层都没实现**（键不在读取清单里 + `pick||15` 把 0 变 15 + 这里把 0 变 0.15）。
test('比例制可显式关闭：ratio=0 → 只用绝对阈值（不是"按 15% 继续收紧"）', () => {
  const r = effectiveCollapseChars('deepseek-v4-flash', 30000, 0, null);
  assert.equal(r.chars, 30000, '关闭后必须用绝对阈值');
  assert.equal(r.source, 'absolute');
  assert.match(r.note, /比例制已关闭/);
  // 关闭是"更保守"：不会比开启时更激进
  const on = effectiveCollapseChars('deepseek-v4-flash', 30000, 0.15, null);
  assert.ok(r.chars >= on.chars, '关闭比例制不得让阈值变小（否则就是把"关闭"实现成"更激进"）');
});

test('ratio=0 与"没传/脏值"必须区分：null/undefined 走默认比例，负数按默认比例兜底', () => {
  const base = effectiveCollapseChars('deepseek-v3', 999999, 0.15, null).chars;
  assert.equal(effectiveCollapseChars('deepseek-v3', 999999, null, null).chars, base, 'null＝没传，按默认 15%');
  assert.equal(effectiveCollapseChars('deepseek-v3', 999999, undefined, null).chars, base, 'undefined＝没传');
  assert.equal(effectiveCollapseChars('deepseek-v3', 999999, -1, null).chars, base, '负数＝配置错误，按默认兜底（不得把阈值压成 0）');
  assert.equal(effectiveCollapseChars('deepseek-v3', 999999, 0, null).chars, 999999, '严格 0 才是关闭');
});
