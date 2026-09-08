// test/knowledge.test.mjs - ④ 知识库数据面单测：可见性 SQL 构造 + 行/文本解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kbVisibleWhere, rowsToEntries, textToEntries } from '../server/knowledge.js';

test('kbVisibleWhere: 会话可见=global+本会话壳+本会话conv', () => {
  const r = kbVisibleWhere({ accountId: 7, shellId: 3, conversationId: 9 });
  assert.equal(r.where, 'account_id=? AND (scope="global" OR (scope="shell" AND shell_id<=>?) OR (scope="conv" AND conversation_id=?))');
  assert.deepEqual(r.params, [7, 3, 9]);
});

test('kbVisibleWhere: 无壳会话仅 global+conv', () => {
  const r = kbVisibleWhere({ accountId: 7, conversationId: 9 });
  assert.deepEqual(r.params, [7, null, 9]);
});

test('kbVisibleWhere: scopeOnly=shell 且带壳 → scope+shell_id', () => {
  const r = kbVisibleWhere({ accountId: 7, shellId: 3, scopeOnly: 'shell' });
  assert.equal(r.where, 'account_id=? AND scope=? AND shell_id=?');
  assert.deepEqual(r.params, [7, 'shell', 3]);
});

test('kbVisibleWhere: scopeOnly=global 无壳条件', () => {
  const r = kbVisibleWhere({ accountId: 7, scopeOnly: 'global' });
  assert.equal(r.where, 'account_id=? AND scope=?');
  assert.deepEqual(r.params, [7, 'global']);
});

test('rowsToEntries: 首行表头 + 每行一条', () => {
  const rows = [
    ['主题', '要点', '备注'],
    ['A产品', '是主推', 'Q3'],
    ['', '空首列此行', 'x'],      // 空首列 → title 回退
    ['', '', ''],                 // 全空行跳过
  ];
  const out = rowsToEntries(rows, { basename: 'x.xlsx' });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 'A产品');
  assert.ok(out[0].body.includes('要点: 是主推'));
  assert.ok(out[0].body.includes('备注: Q3'));
  assert.equal(out[1].title, 'x.xlsx-第3行');
  assert.ok(out[1].body.includes('要点: 空首列此行'));
  assert.ok(out[1].body.includes('备注: x'));
});

test('rowsToEntries: 无表头(hasHeader=false) 全部当数据', () => {
  const rows = [['t1', 'v1'], ['t2', 'v2']];
  const out = rowsToEntries(rows, { hasHeader: false });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, 't1');
  assert.equal(out[0].body, 'col2: v1');
});

test('textToEntries: 空行分段', () => {
  const t = '第一段标题\n第一段正文\n\n第二段标题\n第二段正文';
  const out = textToEntries(t, { basename: 'doc' });
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '第一段标题');
  assert.ok(out[0].body.includes('第一段正文'));
  assert.equal(out[1].title, '第二段标题');
});

test('textToEntries: 空文件兜底一条', () => {
  const out = textToEntries('   ', { basename: 'd.txt' });
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'd.txt');
});
