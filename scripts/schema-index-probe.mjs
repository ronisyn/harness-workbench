#!/usr/bin/env node
// scripts/schema-index-probe.mjs —— C-48 只读探针：真库当前到底缺哪些 SCHEMA 声明的索引。
// **只读**：查询 `information_schema.STATISTICS`，不建、不改、不删任何东西（库名取自 .env 的 DB_NAME，
// 本机＝`rw_test`，走 SSH 隧道 127.0.0.1:3306）。用途：部署前/后各跑一次，回答"迁移补完了没有"。
// 比法：对每张 SCHEMA 表，按"类型 + 列顺序"比它声明的索引与真库的索引：
//   missingInDb  —— SCHEMA 有、真库没有（**这就是待补的漂移**；升级库跑完迁移后应为空）
//   shapeDiff    —— 同名但类型/列/顺序不符（判红）
//   extraInDb    —— 真库有、SCHEMA 没声明的（如别的批次的表、列级内联 UNIQUE——如实列出，不判红）
// 注意：`information_schema` 的 INDEX_TYPE 只有 BTREE/FULLTEXT/SPATIAL/HASH，"是不是唯一索引"看
// `NON_UNIQUE`，索引名 `PRIMARY` 才是主键——别把 BTREE 当成类型不符（第一版探针就是这么误报的）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

function schemaIndexes(src) {
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)`/g;
  for (const m of src.matchAll(re)) {
    const map = new Map();
    for (const raw of m[2].split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!line) continue;
      let mm;
      if ((mm = /^(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(line))) {
        const type = mm[1] ? mm[1].trim().toUpperCase() : 'INDEX';
        map.set(mm[2], { type, cols: mm[3].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
      } else if ((mm = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line))) {
        map.set('PRIMARY', { type: 'PRIMARY', cols: mm[1].split(',').map((c) => c.trim()) });
      } else if ((mm = /^`?(\w+)`?\s+[\s\S]*\bPRIMARY\s+KEY\b/i.exec(line))) {
        map.set('PRIMARY', { type: 'PRIMARY', cols: [mm[1]] });
      }
    }
    out.set(m[1], map);
  }
  return out;
}

const S = schemaIndexes(src);
const conn = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, database: config.db.name, connectTimeout: 8000 });
const rows = (await conn.query(
  'SELECT TABLE_NAME t, INDEX_NAME n, NON_UNIQUE nu, INDEX_TYPE it, SEQ_IN_INDEX s, COLUMN_NAME c, SUB_PART sp, EXPRESSION ex FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
  [config.db.name]))[0];
await conn.end();

const actual = new Map();
// 注意：information_schema.STATISTICS 的 INDEX_TYPE 只有 BTREE/FULLTEXT/SPATIAL/HASH，
// "是不是唯一索引"看 NON_UNIQUE，'PRIMARY' 索引名才是主键 —— 别把 BTREE 当成类型不符（第一版探针就是这么误报的）。
const actualKind = (n, it, nu) => (n === 'PRIMARY' ? 'PRIMARY' : (Number(nu) === 0 ? 'UNIQUE' : (it === 'FULLTEXT' ? 'FULLTEXT' : (it === 'SPATIAL' ? 'SPATIAL' : 'INDEX'))));
for (const r of rows) {
  if (!actual.has(r.t)) actual.set(r.t, new Map());
  const map = actual.get(r.t);
  if (!map.has(r.n)) map.set(r.n, { type: actualKind(r.n, r.it, r.nu), nonUnique: Number(r.nu), cols: [], parts: [] });
  map.get(r.n).cols.push(r.c);
  map.get(r.n).parts.push(r.sp === null ? null : Number(r.sp));
}
const sig = (v) => v.type + '(' + v.cols.join(',') + ')';

const missing = [];
const shapeDiff = [];
const present = [];
for (const [t, map] of S) {
  const a = actual.get(t);
  for (const [n, v] of map) {
    if (!a || !a.has(n)) { missing.push(t + '.' + n + ' ' + sig(v)); continue; }
    const av = a.get(n);
    if (sig(av) !== sig(v)) shapeDiff.push(t + '.' + n + '：SCHEMA ' + sig(v) + ' vs 真库 ' + sig(av));
    else present.push(t + '.' + n + ' ' + sig(v));
  }
}
// 真库有、SCHEMA 没声明的索引（反方向：不判红，只报告）
const extra = [];
for (const [t, map] of actual) for (const [n, v] of map) if (!S.has(t) || !S.get(t).has(n)) extra.push(t + '.' + n + ' ' + sig(v));

console.log(JSON.stringify({
  db: config.db.name,
  schemaTables: S.size,
  dbTables: actual.size,
  schemaIndexes: [...S.values()].reduce((n, m) => n + m.size, 0),
  dbIndexRows: rows.length,
  presentInDb: present.length,
  missingInDb: missing,
  shapeDiff,
  extraInDb: extra,
}, null, 2));
