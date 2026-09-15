// test/schema-sync.test.mjs - 两条建库路径必须等价：`db.js` 的建表语句 vs `migrations.js` 的迁移链
//
// 为什么必须有这条（2026-09-16，Windows 端到端实测撞出来的**装机阻断**）：
// 平台有两条建库路径 —— 全新库走 `db.js` 的 `CREATE TABLE`（"按最终形状建表"），存量库走 `migrations.js` 的 ALTER 链。
// 两条路径的形状本该一样，但**全靠人肉同步**（migrations.js 头部那句"两处都改才算完整"）。实测它们已经漂移 14 列：
// 全新库建出来的 `conversations` 连 `provider` 都没有 ⇒ 客户机（或任何新机器）装完第一次建会话就
// `Unknown column 'provider' in 'field list'`，而且因为 Express 4 不接 async 拒绝，请求**永久挂住**。
// 这不是 Windows 特有：纯数据库路径，Linux 全新装机同款。
//
// 判据（只判可判的那一半，不用连库、不用解析 SQL 语法树）：
//   迁移链里每一条 `ALTER TABLE t ADD COLUMN c` / `CREATE TABLE t`，都必须在 `db.js` 的建表语句里能找到
//   对应的列/表 —— 否则"全新库"就少了它。
//   **反方向判不了**（SCHEMA 里有、链里没有的列，无从知道它是不是"改造前基线"就有的）——所以运行时那条
//   "关键列缺失"自检仍然保留，且现在直接从链里推导（见 server/db.js），两条合起来才盖住两个方向。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS } from '../server/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

// 从 db.js 源码里抠出每个 CREATE TABLE 的列名（模板字符串里的建表语句，缩进规整，按行首标识符取）
function schemaTables(src) {
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)`/g;
  for (const m of src.matchAll(re)) {
    const cols = new Set();
    for (const raw of m[2].split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const first = line.split(/[\s(]+/)[0].replace(/,$/, '');
      if (/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL)$/i.test(first)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) cols.add(first);
    }
    out.set(m[1], cols);
  }
  return out;
}

const SCHEMA = schemaTables(DB_SRC);

test('db.js 能抠出建表语句（抠不出来说明这段正则失效了，别让夹具变成摆设）', () => {
  assert.ok(SCHEMA.size >= 20, '应抠出 20 张以上的表，实际 ' + SCHEMA.size);
  assert.ok(SCHEMA.has('conversations') && SCHEMA.get('conversations').size >= 5, 'conversations 表要能抠到列');
});

test('迁移链里加过的每一列，全新库路径（db.js 建表）都要有 —— 否则新装机缺列', () => {
  const missing = [];
  for (const v of VERSIONS) {
    for (const stmt of v.statements || []) {
      const s = String(stmt);
      const add = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(s);
      if (add) {
        const [, table, col] = add;
        if (!SCHEMA.has(table)) { missing.push(v.id + ': 表 ' + table + ' 不在 db.js 建表语句里'); continue; }
        if (!SCHEMA.get(table).has(col)) missing.push(v.id + ': ' + table + '.' + col + ' 只在迁移链里，db.js 的建表语句缺它');
        continue;
      }
      const ct = /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(s);
      if (ct && !SCHEMA.has(ct[1])) missing.push(v.id + ': 表 ' + ct[1] + ' 只在迁移链里，db.js 缺整张表');
    }
  }
  assert.deepEqual(missing, [], '两条建库路径已经漂移（全新库会缺这些列/表）：\n  ' + missing.join('\n  '));
});
