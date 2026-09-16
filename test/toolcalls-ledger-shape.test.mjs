// test/toolcalls-ledger-shape.test.mjs —— 工具调用账（`tool_calls`）的**形状口径**机检（G1 收口 2026-09-17）
//
// 背景：写入口从"直连 MySQL 的 `INSERT INTO tool_calls …`"迁到存储接口（`storage.toolCalls.append`）时，
// 有一个**很容易搞错、错了又很难发现**的点：`args` 该交什么形状？
//   · 调用点手上是 `JSON.stringify(args).slice(0, 2000)` —— 一个**已经 stringify 过**的串（截断与脱敏是
//     调用点的"记什么"策略，要保留）；
//   · 而 `server/storage/mysql.js` 的 `enc()` 对 JSON 列**还会再 stringify 一次**（那是接口的"怎么存"）。
//   ⇒ 把那个串直接交上去 = **二次编码**：库里存成"JSON 字符串标量"，`/toolcalls` 的 `args` 从对象变成字符串。
// 真库口径（实测，只读）：`tool_calls.args` 是 JSON 列、**8583 行 `JSON_TYPE` 全是 OBJECT**，
// 经 `dec()` 后对外给的就是**对象**。所以调用点必须交对象（`decodeArgsForLedger` 就是干这个的）。
//
// 本文件把这条口径钉成机检（三组）：
//   ① **二次编码真的会把形状改掉**（反证：证明"交对象"不是洁癖）；
//   ② `decodeArgsForLedger` 的真值表：能解析就还原成对象、截断切坏了就如实留字符串、非字符串原样透传；
//   ③ 两个实现 round-trip：同一个对象交进去，读回来还是**同一个对象**（mysql 侧走 JSON 列、jsonfile 侧直接存）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// ⚠️ 装载顺序要紧（与 test/storage.test.mjs 同款，实测踩过）：先 `storage/index.js`、再 `storage/mysql.js`。
import { createStorage } from '../server/storage/index.js';
import { createMysqlStorage } from '../server/storage/mysql.js';
import { createJsonFileStorage } from '../server/storage/jsonfile.js';
import { decodeArgsForLedger } from '../server/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-tcshape-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// ---- 假 MySQL：只认 tool_calls 的 INSERT / SELECT，并按 `mysql.js` 的 enc/dec 口径处理 JSON 列 ----
// 为什么假 pool 也要照那个口径：本文件要验的正是"enc() 对已 stringify 的串会二次编码"这件事，
// 假 pool 若自己"聪明地"跳过编码，就把被测的那一步绕过去了。
const JSON_COLS = new Set(['args']);
const enc = (v) => JSON.stringify(v);
function fakeMysql() {
  const rows = [];
  let nextId = 1;
  const db = {
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT \* FROM tool_calls WHERE conversation_id=\? ORDER BY id DESC/i.test(s)) {
        return rows.filter((r) => Number(r.conversation_id) === Number(params[0])).slice().reverse();
      }
      if (/^SELECT \* FROM tool_calls WHERE conversation_id=\? ORDER BY id/i.test(s)) {
        return rows.filter((r) => Number(r.conversation_id) === Number(params[0]));
      }
      throw new Error('假 MySQL 不认识的语句：' + s);
    },
    run: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      const m = /^INSERT INTO tool_calls \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(s);
      if (!m) throw new Error('假 MySQL 不认识的语句：' + s);
      const cols = m[1].split(',').map((c) => c.trim());
      // 照真表：`created_at DATETIME DEFAULT NOW()` —— 介质自己打的时间戳（测试要断言它被带出来）
      const row = { id: nextId++, created_at: '2026-09-16 12:00:00' };
      cols.forEach((c, i) => {
        const v = params[i];
        // 照 `mysql.js` 的 enc()：JSON 列写时 stringify,其它列原样
        const stored = JSON_COLS.has(c) ? enc(v) : v;
        // 照库的 JSON 列：过一遍 JSON.parse（解析失败＝SQL 会报错，这里如实抛）
        row[c] = JSON_COLS.has(c) ? JSON.parse(stored) : stored;
      });
      rows.push(row);
      return { insertId: row.id, affectedRows: 1 };
    },
  };
  return { storage: createMysqlStorage({ db, pool: { getConnection: async () => { throw new Error('本夹具不用事务'); } } }), rows };
}

// ---- ① 反证：二次编码真的会把 args 从对象变成字符串 ----

test('① 反证：把"已 stringify 的串"交给 JSON 列 ⇒ `enc()` 二次编码 ⇒ 读回来是**字符串**（不是对象）', async () => {
  const { storage, rows } = fakeMysql();
  const rArgs = JSON.stringify({ path: 'a.txt' }).slice(0, 2000);   // 调用点手上那个串
  await storage.toolCalls.append({ conversationId: 1, toolName: 'read_file', args: rArgs, status: 'done' });
  const back = (await storage.toolCalls.list(1))[0];
  assert.equal(typeof rows[0].args, 'string', '库里那颗 JSON 值应当是**字符串标量**（二次编码的直接后果）');
  assert.equal(typeof back.args, 'string', '于是对外形状也从对象变成了字符串 —— 这就是"换个写法就改契约"');
  // 对照：交**对象**时读回来是对象
  const { storage: s2 } = fakeMysql();
  await s2.toolCalls.append({ conversationId: 1, toolName: 'read_file', args: { path: 'a.txt' }, status: 'done' });
  assert.equal(typeof (await s2.toolCalls.list(1))[0].args, 'object', '交对象 ⇒ 读回来是对象（真库 8583 行就是这个形状）');
});

// ---- ② decodeArgsForLedger 的真值表 ----

test('② decodeArgsForLedger：能解析就还原成对象；截断切坏了如实留字符串；非字符串原样透传', () => {
  assert.deepEqual(decodeArgsForLedger('{"path":"a.txt"}'), { path: 'a.txt' }, '合法 JSON 串 ⇒ 还原成对象');
  assert.deepEqual(decodeArgsForLedger('{}'), {}, '空对象也要还原');
  assert.deepEqual(decodeArgsForLedger('[1,2]'), [1, 2], '数组同样是合法 JSON');
  assert.equal(decodeArgsForLedger('"just a string"'), 'just a string', 'JSON 字符串字面量 ⇒ 还原成它本身（不抛）');
  // 截断恰好切在结构中间：**不许抛**（抛了就是整次留痕丢行，而工具已经执行完了）
  const cut = JSON.stringify({ path: 'x'.repeat(3000) }).slice(0, 2000);
  assert.equal(typeof decodeArgsForLedger(cut), 'string', '截断切坏 ⇒ 原样留字符串（改造前记的也是这个片段）');
  assert.equal(decodeArgsForLedger('{' ), '{', '半个花括号也不抛');
  assert.equal(decodeArgsForLedger(undefined), undefined, '非字符串原样透传');
  assert.deepEqual(decodeArgsForLedger({ a: 1 }), { a: 1 }, '已经是对象就原样透传');
  assert.equal(decodeArgsForLedger(null), null);
});

// ---- ③ 两个实现 round-trip：交对象 ⇒ 读回来还是同一个对象 ----

test('③ 两个实现 round-trip：`args` 交对象 ⇒ 读回来仍是对象（换实现不改对外形状）', async () => {
  const args = { path: 'a.txt', nested: { n: 1 }, list: [1, 2, 3] };
  const meta = { conversationId: 7, messageId: 11, toolName: 'read_file', args, resultSummary: '{"ok":true}', resultBytes: 12, durationMs: 3, status: 'done', errorCode: null, shellId: null };

  const { storage: my } = fakeMysql();
  await my.toolCalls.append(meta);
  const a = (await my.toolCalls.list(7))[0];
  assert.deepEqual(a.args, args, 'mysql 侧：读回来的 args 与写进去的逐字段相同');
  assert.equal(typeof a.resultSummary, 'string', 'result_summary 是 TEXT 列 ⇒ 字符串（不许顺手也 parse）');

  const file = path.join(TMP, 'store.json');
  const js = createJsonFileStorage({ file });
  await js.toolCalls.append(meta);
  const b = (await js.toolCalls.list(7))[0];
  assert.deepEqual(b.args, args, 'jsonfile 侧：同样是对象（两个实现形状一致）');
  assert.equal(typeof b.resultSummary, 'string');

  // 对外形状（`GET /api/conversations/:id/toolcalls` 读的就是这几个键）
  for (const r of [a, b]) {
    for (const k of ['id', 'conversationId', 'messageId', 'toolName', 'args', 'resultSummary', 'resultBytes', 'durationMs', 'status', 'errorCode', 'shellId', 'createdAt']) {
      assert.ok(k in r, '两个实现都要回这个字段：' + k);
    }
  }
  // 两个实现的字段面必须一模一样（"换实现不改调用方"的最小判据；差一个键就是漏迁一处）
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), '两个实现回的中性记录字段面必须一致');
  assert.equal(a.conversationId, 7);
  assert.equal(b.conversationId, 7);
  // 反向：截断后的串（不是合法 JSON）交上去也不许抛 —— 那一行照记，形状如实是字符串
  const cut = JSON.stringify({ path: 'x'.repeat(3000) }).slice(0, 2000);
  const { storage: my2 } = fakeMysql();
  await my2.toolCalls.append({ conversationId: 7, toolName: 'run_command', args: cut, status: 'done' });
  const c = (await my2.toolCalls.list(7))[0];
  assert.equal(typeof c.args, 'string', '截断切坏的参数照记（形状如实是字符串），不许因为"形状不对"就丢这一行');
  assert.equal(c.args.length, 2000, '截断上限 2000 字符是调用点策略，一字不动');
});

test('④ 调用点真的走了存储接口（源码级）：`server/tools/index.js` 里不再直接 INSERT tool_calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'tools', 'index.js'), 'utf8');
  assert.ok(!/db\.query\(\s*['"]INSERT INTO tool_calls/.test(src), '写入口不许再直连 MySQL 的 tool_calls');
  assert.match(src, /storage\.toolCalls\.append\(/, '写入口必须走存储接口');
  assert.match(src, /decodeArgsForLedger\(/, 'args 必须经过"形状还原"再交给接口（否则二次编码）');
  // 契约面：storage 的选择点是唯一的（`createStorage` 只在这里读 RW_STORAGE 之外，本文件只做正向断言）
  assert.equal(typeof createStorage, 'function');
});
