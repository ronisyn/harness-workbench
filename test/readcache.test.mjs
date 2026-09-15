// test/readcache.test.mjs - RA-35 措施②夹具：同会话重复读去重
// 依据：实测 read 类调用里 **41.7% 是重复读同一个文件**（同一文件最多被读 56 次、单次 3,799 字节）。
// 判据（四条，缺一条就等于没去重或去重错了）：
//   ① 首次读 → 必须给全文（不能因为"没见过"就不给）
//   ② 同会话再次读、文件未改动、同一区域 → 极短回执（且必须让模型明白"内容在上文"，否则它会反复重试）
//   ③ 文件改动过（mtime/size 变）→ 必须给全文（新内容必须看得见）
//   ④ force=true → 必须给全文（调用方显式要求时不得省）
// 另外：跨会话不得串用（A 会话读过的文件，B 会话必须照常给全文）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRepeat, noteReadFull, repeatNotice, clearReadCache, _sizeOf } from '../server/readcache.js';

const P = { cid: 101, kind: 'read_file', absPath: '/tmp/x.md', mt: 111, size: 2048 };

test('RA-35② 首次读：不给"跳过"，必须走全文', () => {
  clearReadCache(101);
  assert.equal(checkRepeat(P).hit, false);
});

test('RA-35② 同会话重复读且未改动：给极短回执，且回执里要有"在上文/未改动/如何强取"三要素', () => {
  clearReadCache(101);
  noteReadFull(P);
  const r = checkRepeat(P);
  assert.equal(r.hit, true);
  assert.equal(r.times, 1);
  const t = repeatNotice('read_file', P.absPath, r);
  assert.match(t, /上文已完整给出/);
  assert.match(t, /文件未改动/);
  assert.match(t, /force:true/);
  assert.ok(t.length < 200, '回执必须极短（实测全文均值 2.4KB，回执应 <200 字符）');
});

test('RA-35② 文件改动过：必须重新给全文（mtime 或 size 任一变化）', () => {
  clearReadCache(101);
  noteReadFull(P);
  assert.equal(checkRepeat({ ...P, mt: 222 }).hit, false, 'mtime 变了');
  assert.equal(checkRepeat({ ...P, size: 3000 }).hit, false, 'size 变了');
});

test('RA-35② force=true：即使读过也重新给全文', () => {
  clearReadCache(101);
  noteReadFull(P);
  assert.equal(checkRepeat({ ...P, force: true }).hit, false);
});

test('RA-35② 跨会话不串用：另一个会话必须照常给全文', () => {
  clearReadCache(101); clearReadCache(202);
  noteReadFull(P);
  assert.equal(checkRepeat({ ...P, cid: 202 }).hit, false);
});

test('RA-35② 分段读按"文件+区间"区分：同区间才算重复，换区间照常给', () => {
  clearReadCache(303);
  const seg = { cid: 303, kind: 'read_file_range', absPath: '/tmp/big.log', off: 0, len: 2000, mt: 5, size: 9000 };
  noteReadFull(seg);
  assert.equal(checkRepeat(seg).hit, true, '同区间 → 回执');
  assert.equal(checkRepeat({ ...seg, off: 2000 }).hit, false, '换区间 → 给内容');
  assert.equal(checkRepeat({ ...seg, len: 500 }).hit, false, '换长度 → 给内容');
});

test('RA-35② 计数与清理：重复次数可累加，会话删除后状态清零（不长期占内存）', () => {
  clearReadCache(404);
  const p = { cid: 404, kind: 'read_file', absPath: '/tmp/y.md', mt: 7, size: 100 };
  assert.equal(noteReadFull(p), 1);
  noteReadFull(p);
  assert.equal(noteReadFull(p), 3, '第三次给全文时应记到 3');
  assert.equal(_sizeOf(404), 1);
  clearReadCache(404);
  assert.equal(_sizeOf(404), 0);
});

test('RA-35② 无会话 id 时退化为"g"桶，不炸（无会话上下文的调用仍可用）', () => {
  clearReadCache(null);
  const p = { cid: null, kind: 'read_file', absPath: '/tmp/z.md', mt: 1, size: 10 };
  assert.equal(checkRepeat(p).hit, false);
  noteReadFull(p);
  assert.equal(checkRepeat(p).hit, true);
  clearReadCache(null);
});
