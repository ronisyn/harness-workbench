#!/usr/bin/env node
// scripts/session-import-rehearsal.mjs - 会话导入演练：把导入会发出的每一条 INSERT 改写成 EXPLAIN 交**真库**解析，一行不写
//
// 为什么要有它（与 scripts/migration-rehearsal.mjs 同一立场：在真库上验，但绝不碰真数据）：
//   · 假库夹具认任何列名 —— 列名写错、占位符个数不对、取值序列化不对（JSON 列/时间列），它照样绿；
//   · 真导入又不许做 —— 导入会在真库里落一整个会话并分配新会话 id（那是污染，不是演练）。
//   两者之间只有一条路：**让真库解析真语句、但不执行**。`EXPLAIN <INSERT>` 正是这个语义。
// 做法（照 tmp/explain-import.mjs 原型固化）：导出走真连接（只读 SELECT）；导入时把连接换成拦截器——
//   非 INSERT 原样交真库；INSERT 改写成 `EXPLAIN <原语句>`（回一个假 insertId 让模块继续走到下一条）；
//   前后各查一次五张表的行数，**完全一致**才算通过。
// 用法：node scripts/session-import-rehearsal.mjs <导出的json>
//   导出物：node scripts/session-export.mjs export <convId>（默认写 tmp/session-<convId>.json）
import fs from 'node:fs';
import { pool } from '../server/db.js';
import { importConversation } from '../server/session-export.js';

const say = (s) => console.log(s);
const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/session-import-rehearsal.mjs <导出的json>');
  console.error('（导出物用 node scripts/session-export.mjs export <convId> 生成）');
  process.exit(2);
}

let ok = false;
let explained = 0; // 真库 EXPLAIN 通过的语句数（跨 try/catch 用，判定那句要如实报数）
let nextId = 900000; // 假 insertId：只为让模块继续走到下一条语句（真 id 由自增列分配，演练里不需要）
const real = await pool.getConnection();
try {
  say('== 1. 读导出物（坏 JSON 在这里就炸，不会走到库）==');
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  say(`   format=${obj.format} formatVersion=${obj.formatVersion} 源会话 #${obj.conversation && obj.conversation.id}`
    + `：messages ${obj.messages.length} · toolCalls ${obj.toolCalls.length} · events ${obj.events.length} · usage ${obj.usage.rows.length}`);

  say('== 2. 真连接 + INSERT 拦截器（EXPLAIN 只解析、不执行）==');
  const fakeConn = {
    async query(sql, params) {
      if (!/^\s*INSERT/i.test(sql)) { const [r] = await real.query(sql, params); return [r]; }
      await real.query('EXPLAIN ' + sql, params); // 真解析、不执行
      explained++;
      return [{ insertId: nextId++, affectedRows: 1 }];
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  };
  const stub = { query: (sql, params) => real.query(sql, params), getConnection: async () => fakeConn };

  say('== 3. 演练前的五张表行数（基准）==');
  const counts = async () => (await real.query('SELECT (SELECT COUNT(*) FROM conversations) c, (SELECT COUNT(*) FROM messages) m, (SELECT COUNT(*) FROM tool_calls) t, (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM usage_stats) u'))[0];
  const before = await counts();
  say('   ' + JSON.stringify(before));

  say('== 4. 跑导入：每条 INSERT → EXPLAIN（验列名/占位符个数/取值序列化）==');
  const r = await importConversation(obj, { dryRun: false, pool: stub });
  say(`   真库 EXPLAIN 通过 ${explained} 条 INSERT · 源会话 #${r.sourceId} → 假想新会话 #${r.newId}`
    + ` · messages ${r.counts.messages} · toolCalls ${r.counts.toolCalls} · events ${r.counts.events} · usage ${r.counts.usage}`);

  say('== 5. 复核：一行未写 ==');
  const after = await counts();
  const same = JSON.stringify(before) === JSON.stringify(after);
  say('   演练后 ' + JSON.stringify(after));
  say(same ? '   ★ 行数完全一致：EXPLAIN 确实没写库' : '   ★ 行数变了！出问题了');
  if (!explained) say('   ⚠️ 一条 INSERT 都没走到 —— 这次演练没验到任何东西，不算通过');

  say('== 6. 判定 ==');
  ok = same && explained > 0;
} catch (e) {
  // 失败必须说清是"哪条语句/哪个字段"：EXPLAIN 报的错就是真导入会撞上的那个错
  console.error('[失败] ' + ((e && e.name) || 'Error') + ': ' + ((e && e.message) || e));
} finally {
  await real.release();
  await pool.end();
}
say(`\n演练判定：${ok ? `**通过**（真 MySQL 解析了导入会发出的 ${explained} 条 INSERT，一行未写）` : '**未通过**（见上方失败原因；本脚本只发 EXPLAIN，从不写库）'}`);
process.exit(ok ? 0 : 1);
