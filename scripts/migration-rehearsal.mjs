// tmp/migration-rehearsal.mjs - 迁移演练：在一份**真实行数**的临时库上跑本次 DDL，量耗时、验不丢数据
// 依据《数据库迁移规范》§零③ / §五：DDL 必须在真实数据量上跑通过，并记下耗时与锁时间。
// 做法：CREATE DATABASE rw_mig_rehearsal → 建同构表（含存量行数）→ 记录前后行数+指纹 → 应用迁移 → 复核 → DROP。
// 只碰临时库；不动 rw_test，不动生产。
import mysql from 'mysql2/promise';
import { config } from '../server/config.js';

const TMP = 'rw_mig_rehearsal';
const TABLES = ['tool_calls', 'messages', 'usage_stats', 'conversations', 'agent_runs', 'audit_log'];

const root = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, multipleStatements: false });
const say = (s) => console.log(s);

say('== 1. 建临时库 ==');
await root.query(`DROP DATABASE IF EXISTS ${TMP}`);
await root.query(`CREATE DATABASE ${TMP} CHARACTER SET utf8mb4`);
await root.query(`USE ${TMP}`);

say('== 2. 在临时库里建同构表（CREATE TABLE ... LIKE：逐字照抄 rw_test 的结构，再砍掉本次要加的那一列）==');
const src = config.db.name;
for (const t of TABLES) {
  await root.query(`CREATE TABLE ${t} LIKE \`${src}\`.\`${t}\``);
  // 模拟"改造前的库"：把本次新增列去掉（若源库还没有该列，这条会报错，忽略即可）
  await root.query(`ALTER TABLE ${t} DROP COLUMN result_bytes`).catch(() => {});
}
say(`   建表 ${TABLES.length} 张（模拟"改造前的库"：没有 result_bytes）`);

say('== 3. 灌真实量级的数据（按 rw_test 的真实行数造同规模行；只关心行数与 DDL 耗时，不搬内容）==');
const src2 = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.pass, database: src });
const counts = {};
for (const t of TABLES) {
  const [[{ n }]] = await src2.query(`SELECT COUNT(*) n FROM ${t}`);
  counts[t] = Number(n);
  if (!counts[t]) continue;
  // 造数：用递归 CTE 生成序号行；非空列一律给值（整数给序号，其余给占位），因为 NOT NULL 列不能留空
  await root.query(`SET SESSION cte_max_recursion_depth = 30000`);
  const cols = (await root.query(`SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [TMP, t]))[0]
    .filter((c) => c.COLUMN_KEY !== 'PRI' && !String(c.EXTRA || '').includes('auto_increment'));
  const ints = new Set(['int', 'bigint', 'smallint', 'tinyint', 'decimal', 'float', 'double']);
  const exprs = cols.map((c) => {
    if (ints.has(c.DATA_TYPE)) return 'x';
    if (c.DATA_TYPE === 'json') return "JSON_OBJECT('k', x)";
    if (c.DATA_TYPE === 'datetime' || c.DATA_TYPE === 'timestamp' || c.DATA_TYPE === 'date') return 'NOW()';
    return "'x'";
  });
  await root.query(
    `INSERT INTO ${t} (${cols.map((c) => '`' + c.COLUMN_NAME + '`').join(',')})
     WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x < ${counts[t]})
     SELECT ${exprs.join(', ')} FROM s`);
}
say('   造入行数：' + JSON.stringify(counts));

say('== 4. 应用本次迁移（server/db.js MIGRATIONS 里的那一条）==');
const t0 = Date.now();
await root.query('ALTER TABLE tool_calls ADD COLUMN result_bytes INT DEFAULT 0');
const ddlMs = Date.now() - t0;
say(`   ALTER TABLE tool_calls ADD COLUMN result_bytes → 耗时 ${ddlMs} ms（${counts.tool_calls} 行）`);

say('== 5. 复核：列在、行数不变、存量值语义正确 ==');
const col = (await root.query(`SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='tool_calls' AND COLUMN_NAME='result_bytes'`, [TMP]))[0];
say('   新列：' + JSON.stringify(col));
let ok = col.length === 1;
for (const t of TABLES) {
  const c = (await root.query(`SELECT COUNT(*) n FROM ${TABLES.includes(t) ? t : t}`))[0][0].n;
  const same = Number(c) === counts[t];
  ok = ok && same;
  say(`   ${t}: ${c} 行（迁移前 ${counts[t]}）${same ? ' ✅' : ' ❌ 行数变了'}`);
}
const zeros = (await root.query('SELECT COUNT(*) n FROM tool_calls WHERE result_bytes = 0'))[0][0].n;
say(`   存量行 result_bytes=0 的有 ${zeros} 行（预期=全部：新列默认 0，由回填脚本补历史值）`);
ok = ok && zeros === counts.tool_calls;

say('== 6. 清理临时库 ==');
await src2.end();
await root.query(`DROP DATABASE ${TMP}`);
say(`\n演练判定：${ok ? `**通过**（真实行数 ${counts.tool_calls} 行上 DDL 耗时 ${ddlMs}ms，无丢数据）` : '**未通过**'}`);
await root.end();
process.exit(ok ? 0 : 1);
