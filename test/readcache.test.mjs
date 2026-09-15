// test/readcache.test.mjs - RA-35 措施②夹具：同会话重复读去重（**区间级**）
// 实测背景：read 类调用里 41.7% 是重复读同一文件；且**第一版"整文件级"去重一次都没触发**——
// 模型第二次改用 `read_file_range` 读同一文件的不同区间（6,665B 全文 vs 5,711B 分段，内容高度重叠）。
// 所以判据必须落在"区间覆盖"上：
//   ① 文件未改动 + 请求区间已被覆盖 → 极短回执（且回执要说明"在上文/未改动/如何强取"）
//   ② 文件未改动 + 请求区间部分重叠 → 只给未覆盖的部分，并在开头说明跳过了多少
//   ③ 文件改动过（mtime/size 变）→ 旧记录作废，必须照常给全文
//   ④ force=true → 照常给全
//   ⑤ 跨会话不串用
// 纯函数（mergeIntervals/subtractIntervals/planRead）单独测，状态行为另测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIntervals, subtractIntervals, planRead, noteServed, repeatNotice, partialNotice, clearReadCache, _filesOf, _ivOf } from '../server/readcache.js';

const F = { cid: 101, absPath: '/tmp/x.md', mt: 111, size: 2048 };

test('区间代数：merge 合并重叠与相邻', () => {
  assert.deepEqual(mergeIntervals([[0, 10], [5, 20], [30, 40], [40, 50]]), [[0, 20], [30, 50]]);
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals([[5, 5]]), [], '空区间被丢弃');
});

test('区间代数：subtract 只保留未覆盖部分', () => {
  assert.deepEqual(subtractIntervals([0, 100], []), [[0, 100]]);
  assert.deepEqual(subtractIntervals([0, 100], [[0, 100]]), []);
  assert.deepEqual(subtractIntervals([0, 100], [[0, 40]]), [[40, 100]]);
  assert.deepEqual(subtractIntervals([0, 100], [[30, 60]]), [[0, 30], [60, 100]]);
  assert.deepEqual(subtractIntervals([10, 20], [[0, 5], [25, 30]]), [[10, 20]], '不相关区间不影响');
});

test('RA-35② 首次读：不判重复，全给', () => {
  clearReadCache(101);
  const plan = planRead({ ...F, span: [0, 1000] });
  assert.equal(plan.duplicate, false);
  assert.deepEqual(plan.gaps, [[0, 1000]]);
});

test('RA-35② 整文件被覆盖（改成 read_file_range 读同一文件）→ 判重复', () => {
  clearReadCache(101);
  noteServed({ ...F, spans: [[0, 2048]] });         // read_file 给过全文
  const plan = planRead({ ...F, span: [0, 1500] }); // 再用 range 读前 1500
  assert.equal(plan.duplicate, true, '区间已覆盖 → 应判重复（第一版整文件级判不出来的就是这种）');
  assert.ok(plan.coveredChars === 1500);
});

test('RA-35② 部分重叠：只补没读过的部分', () => {
  clearReadCache(101);
  noteServed({ ...F, spans: [[0, 500]] });
  const plan = planRead({ ...F, span: [0, 1000] });
  assert.equal(plan.duplicate, false);
  assert.deepEqual(plan.gaps, [[500, 1000]], '前 500 已给过，只补 500–1000');
  assert.equal(plan.coveredChars, 500);
});

test('RA-35② 文件改动（mtime 或 size 变）→ 旧记录作废，照常给全', () => {
  clearReadCache(101);
  noteServed({ ...F, spans: [[0, 2048]] });
  assert.equal(planRead({ ...F, mt: 222, span: [0, 2048] }).duplicate, false, 'mtime 变了');
  assert.equal(planRead({ ...F, size: 9999, span: [0, 2048] }).duplicate, false, 'size 变了');
});

test('RA-35② force=true → 不参与去重，照常给全', () => {
  clearReadCache(101);
  noteServed({ ...F, spans: [[0, 2048]] });
  assert.equal(planRead({ ...F, span: [0, 2048], force: true }).duplicate, false);
});

test('RA-35② 跨会话不串用', () => {
  clearReadCache(101); clearReadCache(202);
  noteServed({ ...F, spans: [[0, 2048]] });
  assert.equal(planRead({ ...F, cid: 202, span: [0, 2048] }).duplicate, false);
});

test('RA-35② 多段累加：读 0–500、500–1000 后，0–1000 全覆盖', () => {
  clearReadCache(303);
  noteServed({ ...F, cid: 303, spans: [[0, 500]] });
  noteServed({ ...F, cid: 303, spans: [[500, 1000]] });
  assert.deepEqual(_ivOf(303, F.absPath), [[0, 1000]], '相邻区间应合并');
  assert.equal(planRead({ ...F, cid: 303, span: [0, 1000] }).duplicate, true);
  assert.deepEqual(planRead({ ...F, cid: 303, span: [900, 1200] }).gaps, [[1000, 1200]]);
});

test('RA-35② 回执文案：必须含"在上文/未改动/force"三要素，且极短', () => {
  const t = repeatNotice('read_file', '/tmp/x.md', { size: 6665, span: [0, 6665] });
  assert.match(t, /上文已给出/);
  assert.match(t, /文件未改动/);
  assert.match(t, /force:true/);
  assert.ok(t.length < 220, '回执必须极短（全文均值 2.4KB）');
  const p = partialNotice('read_file_range', '/tmp/x.md', { span: [0, 1000], coveredChars: 500 });
  assert.match(p, /已给出/);
  assert.match(p, /只补未读过的部分/);
});

test('RA-35② 状态清理：会话删除后不占内存', () => {
  clearReadCache(404);
  noteServed({ ...F, cid: 404, spans: [[0, 10]] });
  assert.equal(_filesOf(404), 1);
  clearReadCache(404);
  assert.equal(_filesOf(404), 0);
});

test('RA-35② 无会话 id 退化为 "g" 桶，不炸', () => {
  clearReadCache(null);
  const p = { ...F, cid: null };
  noteServed({ ...p, spans: [[0, 100]] });
  assert.equal(planRead({ ...p, span: [0, 100] }).duplicate, true);
  clearReadCache(null);
});
