#!/usr/bin/env node
// scripts/migration-index-diff.mjs —— C-48 取证出口（**不连库**）：比出"db.js SCHEMA 声明的索引集合"
// 与"迁移链累计产生的索引集合"的差集。它是 `test/schema-sync.test.mjs` 那条索引判据的**原始读数**出口：
// 夹具判红/判绿，这个脚本回答"到底差哪几条"，排障时不用去读夹具代码。
// 口径：只比**索引**（含列顺序与类型），不碰列（列已有 test/schema-sync.test.mjs 在看）。
// 索引身份＝(表, 索引名)；值＝类型 + 列顺序；PRIMARY KEY 也计入（列级内联 `id INT … PRIMARY KEY` 也抠）。
// 输出：missingInChain（升级来的库会缺的）、extraInChain（链有 SCHEMA 无＝忘了同步新库路径）、
//       shapeMismatch（同名但列/顺序/类型不符）——三者都空才叫两条路径一致。
// 判据的**定义域**（哪些表由链负责索引）见 `test/schema-sync.test.mjs`：本脚本只如实列出全部差集，
// 不做取舍——"链之前的建表语句带来的索引"（如 messages.idx_msg_conv）也会出现在 missingInChain 里，
// 那是**预期的**（链从来不管它们），别照着这里无脑补。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'db.js'), 'utf8');

// ── 从 db.js 抠 SCHEMA 里的索引（与 test/schema-sync.test.mjs 同一条正则，抠不出表数会当场露馅）──
function schemaIndexes(src) {
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\)`/g;
  for (const m of src.matchAll(re)) {
    const table = m[1];
    const map = new Map();
    for (const raw of m[2].split('\n')) {
      const line0 = raw.trim().replace(/,$/, '');
      if (!line0) continue;
      let mm;
      if ((mm = /^(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)(.*)$/i.exec(line0))) {
        const full = line0.match(/^([A-Za-z]+)/i)[1].toUpperCase();
        const type = /^UNIQUE$/i.test(full) ? 'UNIQUE' : (/^FULLTEXT$/i.test(full) ? 'FULLTEXT' : (/^SPATIAL$/i.test(full) ? 'SPATIAL' : 'INDEX'));
        map.set(mm[1], { type, cols: mm[2].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
      } else if ((mm = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(line0))) {
        map.set('PRIMARY', { type: 'PRIMARY', cols: mm[1].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
      } else if ((mm = /^`?(\w+)`?\s+[\s\S]*\bPRIMARY\s+KEY\b/i.exec(line0)) && !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL)$/i.test(line0.split(/[\s(]+/)[0])) {
        map.set('PRIMARY', { type: 'PRIMARY', cols: [mm[1]] });
      }
    }
    out.set(table, map);
  }
  return out;
}

// ── 从迁移链抠"累计产生"的索引 ──
import { VERSIONS } from '../server/migrations.js';
function chainIndexes(versions) {
  const out = new Map();
  const put = (t, n, v) => { if (!out.has(t)) out.set(t, new Map()); out.get(t).set(n, v); };
  for (const v of versions) {
    for (const stmt of v.statements || []) {
      const s = String(stmt).trim();
      let m;
      // CREATE TABLE：表内声明的索引（含 PRIMARY）
      if ((m = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?(\w+)`?\s*\(([\s\S]*)\)$/i.exec(s))) {
        const lines = m[2].split('\n').map((x) => x.trim().replace(/,$/, '')).filter(Boolean);
        // 逐行找索引声明（表内每行一个定义；这里不解析嵌套括号以外的怪写法）
        const body = lines.join('\n');
        for (const mm of body.matchAll(/(?:^|\n)\s*(?:UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/gi)) {
          const type = /UNIQUE/i.test(mm[0]) ? 'UNIQUE' : (/FULLTEXT/i.test(mm[0]) ? 'FULLTEXT' : (/SPATIAL/i.test(mm[0]) ? 'SPATIAL' : 'INDEX'));
          put(m[1], mm[1], { type, cols: mm[2].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        }
        for (const mm of body.matchAll(/(?:^|\n)\s*PRIMARY\s+KEY\s*\(([^)]*)\)/gi)) {
          put(m[1], 'PRIMARY', { type: 'PRIMARY', cols: mm[1].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        }
        for (const mm of body.matchAll(/(?:^|\n)\s*`?(\w+)`?\s+[^\n]*\bPRIMARY\s+KEY\b/gi)) {
          if (/^\s*(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|FULLTEXT|SPATIAL)\b/i.test(mm[0].trim())) continue;
          if (!out.get(m[1]) || !out.get(m[1]).has('PRIMARY')) put(m[1], 'PRIMARY', { type: 'PRIMARY', cols: [mm[1]] });
        }
        continue;
      }
      // ALTER TABLE … ADD [UNIQUE|FULLTEXT|SPATIAL] KEY|INDEX <名> (cols)
      if ((m = /^ALTER TABLE\s+`?(\w+)`?\s+ADD\s+(?:CONSTRAINT\s+`?\w+`?\s+)?(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(s))) {
        const type = m[2] ? m[2].trim().toUpperCase() : 'INDEX';
        put(m[1], m[3], { type, cols: m[4].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        continue;
      }
      // CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX <名> ON <表> (cols)
      if ((m = /^CREATE\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]*)\)/i.exec(s))) {
        const type = m[1] ? m[1].trim().toUpperCase() : 'INDEX';
        put(m[3], m[2], { type, cols: m[4].split(',').map((c) => c.trim().replace(/`/g, '').split(/\s+/)[0]) });
        continue;
      }
      // 链里删索引的语句（本轮没有；有的话必须从累计集合里减掉，否则会假绿）
      if ((m = /^DROP\s+INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?/i.exec(s))) { if (out.has(m[2])) out.get(m[2]).delete(m[1]); continue; }
    }
  }
  return out;
}

const S = schemaIndexes(src);
const C = chainIndexes(VERSIONS);
const key = (t, n) => t + '.' + n;
const sig = (v) => v.type + '(' + v.cols.join(',') + ')';

const schemaFlat = [];
for (const [t, map] of S) for (const [n, v] of map) schemaFlat.push([key(t, n), sig(v)]);
const chainFlat = [];
for (const [t, map] of C) for (const [n, v] of map) chainFlat.push([key(t, n), sig(v)]);
const chainKeys = new Set(chainFlat.map(([k]) => k));
const schemaKeys = new Set(schemaFlat.map(([k]) => k));

const missing = schemaFlat.filter(([k]) => !chainKeys.has(k)).map(([k, s]) => k + ' ' + s);
const extra = chainFlat.filter(([k]) => !schemaKeys.has(k)).map(([k, s]) => k + ' ' + s);
const mismatched = schemaFlat.filter(([k, s]) => chainKeys.has(k) && chainFlat.find(([ck]) => ck === k)[1] !== s)
  .map(([k, s]) => k + '：SCHEMA ' + s + ' vs 链 ' + chainFlat.find(([ck]) => ck === k)[1]);

console.log(JSON.stringify({
  schemaTables: S.size,
  schemaIndexes: schemaFlat.length,
  chainTablesWithIndexes: C.size,
  chainIndexes: chainFlat.length,
  missingInChain: missing,
  extraInChain: extra,
  shapeMismatch: mismatched,
}, null, 2));
