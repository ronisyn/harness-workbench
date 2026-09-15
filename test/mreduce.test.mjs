// test/mreduce.test.mjs - 压每轮新增的三个整形点（2026-09-15）：grep 导航优先 / list_dir 汇总 / grep 去重
// 依据：真实长会话 conv=185 实测 —— grep_search 43 次/71 轮、均值 1,284 字节（调用次数最多的工具），
// list_dir 均值 787 字节；改法是"少给但说清楚"（附省略量 + 取回指引），不是悄悄截断。
import { test } from 'node:test';
import assert from 'node:assert';
import { __shapeTestables } from '../server/tools/index.js';
import { planGrep, noteGrepServed, markWritten, grepRepeatNotice, clearReadCache, _grepsOf } from '../server/readcache.js';

const { grepShape, listShape } = __shapeTestables;

test('grep 整形：导航信息（counts 的键即文件清单）优先，命中行受上限约束，且**如实说明省略了多少**', () => {
  const matches = [{ file: '/a.js', line: 3, text: 'x' }, { file: '/a.js', line: 9, text: 'y' }];
  const out = grepShape(matches, { '/a.js': 40, '/b.js': 25 }, 65, 30, 3);
  assert.deepEqual(Object.keys(out.counts), ['/a.js', '/b.js'], '文件清单由 counts 的键承载');
  assert.equal(out.files, undefined, '不得再单独列一份 files —— 实测两者并存会把路径列两遍，输出 9,990 字节（整形等于没做）');
  assert.equal(out.counts['/a.js'], 40, '每文件命中数要给出（导航按它排序）');
  assert.equal(out.totalHits, 65);
  assert.equal(out.omitted, 63, '省略量必须如实报');
  assert.match(out.hint, /read_file_range \{path, fromLine, toLine\}/, '要给出"怎么看上下文"的明确指引');
  assert.match(out.hint, /maxMatches/, '要告诉模型怎么拿到更多');
});

test('grep 整形：命中不多时不加 hint（不要为了提示而提示）', () => {
  const out = grepShape([{ file: '/a.js', line: 1, text: 'x' }], { '/a.js': 1 }, 1, 30, 3);
  assert.equal(out.omitted, undefined);
  assert.equal(out.hint, undefined);
});

test('list_dir 小目录：保持原样（≤40 条不动它，别把简单事做复杂）', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ name: 'f' + i + '.js', type: 'file' }));
  const out = listShape(entries, '/d');
  assert.equal(out.entries.length, 12);
  assert.equal(out.omitted, undefined);
  assert.equal(out.hint, undefined);
});

test('list_dir 大目录：给"有什么、各多少"+ 前若干条 + 省略量（目录优先）', () => {
  const entries = [
    ...Array.from({ length: 60 }, (_, i) => ({ name: 'f' + i + '.js', type: 'file' })),
    ...Array.from({ length: 30 }, (_, i) => ({ name: 'm' + i + '.md', type: 'file' })),
    ...Array.from({ length: 5 }, (_, i) => ({ name: 'd' + i, type: 'dir' })),
  ];
  const out = listShape(entries, '/d');
  assert.equal(out.dirs, 5); assert.equal(out.files, 90);
  assert.equal(out.byExt['.js'], 60); assert.equal(out.byExt['.md'], 30);
  assert.equal(out.entries.length, 30, '最多列 30 条');
  assert.equal(out.entries[0].type, 'dir', '目录优先（导航更常用）');
  assert.equal(out.omitted, 95 - 30);
  assert.match(out.hint, /find_file|grep_search/, '要给出更精确的取法');
});

test('grep 去重：同会话同路径同正则第二次 ⇒ 判重复并给极短回执（仅当上次结果够大）', () => {
  clearReadCache(9001);
  const p = { cid: 9001, root: '/d', pattern: 'foo' };
  assert.equal(planGrep(p).duplicate, false, '第一次不判重');
  noteGrepServed({ ...p, bytes: 4000 });           // 上次给了 4,000 字节 ⇒ 值得去重
  const second = planGrep(p);
  assert.equal(second.duplicate, true);
  const notice = grepRepeatNotice('/d', 'foo', second.times);
  assert.match(notice, /已跳过重复搜索/);
  assert.match(notice, /force:true/, '必须给出强取路径，否则模型会以为搜失败');
  assert.ok(notice.length < 260, '回执必须极短');
  assert.ok(Buffer.byteLength(notice) < 4000, '回执必须比它替代的结果短（这是去重的前提）');
});

test('grep 去重门槛：上次结果太小就不去重（回执本身一百多字节，换掉更小的结果是倒亏）', () => {
  clearReadCache(9011);
  const p = { cid: 9011, root: '/d', pattern: 'tiny' };
  noteGrepServed({ ...p, bytes: 71 });             // 实测：71 字节的小结果曾被换成 308 字节回执（压缩比 0.3×）
  assert.equal(planGrep(p).duplicate, false, '小结果直接重给——本来就便宜');
});

test('grep 去重：换正则或换路径不算重复', () => {
  clearReadCache(9002);
  noteGrepServed({ cid: 9002, root: '/d', pattern: 'foo', bytes: 4000 });
  assert.equal(planGrep({ cid: 9002, root: '/d', pattern: 'bar' }).duplicate, false);
  assert.equal(planGrep({ cid: 9002, root: '/other', pattern: 'foo' }).duplicate, false);
});

test('grep 去重：**本会话只要有写操作，记录整体作废**（宁可多搜一次，不能给过期结果）', () => {
  clearReadCache(9003);
  const p = { cid: 9003, root: '/d', pattern: 'foo' };
  noteGrepServed({ ...p, bytes: 4000 });
  assert.equal(planGrep(p).duplicate, true);
  markWritten(9003);
  assert.equal(planGrep(p).duplicate, false, '写过文件后必须重搜（文件内容可能变了）');
  assert.equal(_grepsOf(9003), 1, '旧记录不删但已随 epoch 失效');
});

test('grep 去重：force=true 强取（与读去重同语义）', () => {
  clearReadCache(9004);
  const p = { cid: 9004, root: '/d', pattern: 'foo' };
  noteGrepServed({ ...p, bytes: 4000 });
  assert.equal(planGrep({ ...p, force: true }).duplicate, false);
});

test('grep 去重：跨会话不串用', () => {
  clearReadCache(9005); clearReadCache(9006);
  noteGrepServed({ cid: 9005, root: '/d', pattern: 'foo', bytes: 4000 });
  assert.equal(planGrep({ cid: 9006, root: '/d', pattern: 'foo' }).duplicate, false);
});
