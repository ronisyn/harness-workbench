// test/policy-write.test.mjs - B-①② 夹具：策略类写入必须**可识别 + 可归属 + 单独成行**（2026-09-16 拍板）
// 依据《提示注入防线-方案-20260916》§3-B / §5 的 B-①②（B-③"write/full 硬拦"已明确不做 = 安全剧场）。
// 夹具守三件事：
//   ① 清单与**真实来源**对得上（settingsSchema 的实际键名 / set_limits 源码里真正写的键 / index.js 的消费点）
//      —— "策略写入"的定义不许有缺口，也不许有死键；
//   ② 各种 SQL 写法都认得出（含负例：业务表、非策略键、读 settings 一律不许误报）；
//   ③ **如实标出已知边界**：识别点只有工具执行路径，绕过工具的直改不在这套机制里（不假装覆盖）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY_SETTINGS_KEYS, policyWriteOf, policyWriteDetail, listHooks } from '../server/tools/hooks.js';
import { SETTINGS_SCHEMA } from '../server/settingsSchema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('清单与真实来源对账：每个键都指得到来源，且不漏 set_limits 能写的护栏键', () => {
  assert.equal(new Set(POLICY_SETTINGS_KEYS).size, POLICY_SETTINGS_KEYS.length, '清单不得重复');
  const schemaKeys = new Set(SETTINGS_SCHEMA.map((s) => s.key));
  const idx = read('server/index.js');
  const dead = POLICY_SETTINGS_KEYS.filter((k) => !schemaKeys.has(k) && !idx.includes("getSetting('" + k + "'"));
  assert.deepEqual(dead, [], '清单里有死键（既不在 settingsSchema，也没人在 index.js 消费）：' + dead.join(', '));
  // 方案 §3-B 写的 `max_progress_stall_n` 在 settingsSchema 里**不存在**，真名是 progress_stall_n ⇒ 清单必须用真名
  assert.ok(!POLICY_SETTINGS_KEYS.includes('max_progress_stall_n'), '键名必须按 settingsSchema 的实际键名写（不存在 max_progress_stall_n）');
  // 反向：`set_limits` 能写的护栏键必须全在清单里——否则"模型改自己的保险丝"就有一条静默通道（源码锚点比对）
  const written = [...read('server/tools/index.js').matchAll(/ups\.push\(\['([A-Za-z_]+)'/g)].map((m) => m[1]);
  assert.ok(written.length >= 4, 'set_limits 应至少写 4 个护栏键（实为 ' + written.length + '）');
  const missing = written.filter((k) => !POLICY_SETTINGS_KEYS.includes(k));
  assert.deepEqual(missing, [], 'set_limits 能写但不在策略清单里的护栏键（新增护栏键请同步登记）：' + missing.join(', '));
});

test('正例：三种写 settings 的写法 × 每个策略键都认得出，且 kind/keys 精确', () => {
  const forms = {
    insert: (k) => `INSERT INTO settings (skey, svalue, updated_at) VALUES ('${k}','1',NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue)`,
    update: (k) => `UPDATE settings SET svalue='1' WHERE skey='${k}'`,
    delete: (k) => `DELETE FROM settings WHERE skey='${k}'`,
  };
  for (const k of POLICY_SETTINGS_KEYS) {
    for (const [kind, sql] of Object.entries(forms)) {
      const p = policyWriteOf(sql(k));
      assert.ok(p, '认不出策略写入：' + k + '（' + kind + '）');
      assert.equal(p.kind, kind, k + ' 的写法判定错了');
      assert.deepEqual(p.keys, [k], k + ' 应精确命中一个键');
    }
  }
  // 一条语句改多个键：keys 必须全在（账本要能一眼看清这次动了哪些策略）
  const multi = policyWriteOf("UPDATE settings SET svalue='[]' WHERE skey IN ('access_rules','toolset_enabled')");
  assert.deepEqual(multi.keys.sort(), ['access_rules', 'toolset_enabled']);
});

test('负例：不写 settings / 写 settings 但没碰策略键 / 只读，一律不许报"策略变更"', () => {
  const notPolicy = [
    "INSERT INTO knowledge (title, body) VALUES ('access_rules 怎么配','把 access_rules 清空的步骤')", // 提到策略词，但写的是业务表
    "INSERT INTO audit_log (detail) SELECT svalue FROM settings WHERE skey='access_rules'", // 读 settings 写别处
    "UPDATE conversations SET title='access_rules' WHERE id=718",
    "UPDATE settings SET svalue='\"0.7\"' WHERE skey='temperature'", // 写 settings，但不是策略键
    "UPDATE settings SET svalue='\"x\"' WHERE skey LIKE 'prefix_epoch:%'",
    "SELECT skey, svalue FROM settings WHERE skey='access_rules'", // 只读
    'DROP TABLE settings',
    '', '   ', null, undefined, 123,
  ];
  for (const sql of notPolicy) assert.equal(policyWriteOf(sql), null, '误报为策略写入：' + JSON.stringify(sql));
  // 键名必须按标识符边界匹配：备份表/派生名不许撞上
  assert.equal(policyWriteOf("UPDATE settings SET svalue='1' WHERE skey='my_access_rules_backup'"), null);
  assert.equal(policyWriteOf("UPDATE settings SET svalue='1' WHERE skey='max_round_cap'"), null);
});

test('账本 detail：谁改的 / 改前改后 / 原始 SQL 都在，且截断到 1000', () => {
  const d = JSON.parse(policyWriteDetail({
    kind: 'update', keys: ['access_rules'], from: { access_rules: '[]' }, to: { access_rules: '[{"pattern":"db_write","action":"deny"}]' },
    ctx: { accountId: 7, conversationId: 718, shellId: null }, result: { affected: 1, insertId: 0 },
    sql: "UPDATE settings SET svalue='[{\"pattern\":\"db_write\"}]' WHERE skey='access_rules'",
  }));
  assert.equal(d.via, 'db_write');
  assert.equal(d.actor, 'model-via-tool', '「模型还是人」要有明确取值：人改策略走设置页 API，不经过 execTool');
  assert.equal(d.kind, 'update');
  assert.deepEqual(d.keys, ['access_rules']);
  assert.equal(d.from.access_rules, '[]', '改前的值必须在（否则只看到"改过"，看不到改成了什么）');
  assert.match(d.to.access_rules, /deny/, '改后的值必须在');
  assert.deepEqual(d.by, { accountId: 7, conversationId: 718, shellId: null });
  assert.equal(d.affected, 1);
  assert.match(d.sql, /^UPDATE settings/);
  // 读不到改前值时必须如实标 null，不许编一个"改前"
  assert.equal(JSON.parse(policyWriteDetail({ kind: 'insert', keys: ['loop_guard'], from: null, to: { loop_guard: 6 } })).from.loop_guard, null);
  // 大值截断（账本列不能因为一个 set 语句爆掉）
  const big = policyWriteDetail({ kind: 'update', keys: ['toolset_enabled'], from: { toolset_enabled: 'x'.repeat(5000) }, to: { toolset_enabled: 'y'.repeat(5000) }, ctx: {}, result: { affected: 1 }, sql: 'UPDATE settings' });
  assert.ok(big.length <= 1000, 'detail 必须截断到 1000 字符（实为 ' + big.length + '）');
});

test('B-①② 边界如实：识别只挂在 db_write 上、两条钩子都不拦截，且**直改库不在这套机制里**', () => {
  const hooks = listHooks().filter((h) => h.name.startsWith('policy_write_'));
  assert.deepEqual(hooks.map((h) => h.side + ':' + h.tool).sort(), ['after:db_write', 'before:db_write'],
    '识别点只许挂在 db_write 上（挂到 * 会去判断别的工具的 SQL）');
  assert.deepEqual(hooks.filter((h) => h.failure !== 'open'), [],
    '这两条是取值/留痕钩子，不是门禁：必须 fail-open —— 出事只许少一行账，绝不许拦工具（B-③ 不做硬拦）');
  // 边界（不假装覆盖）：识别器本身是 SQL 级的（下面这条能认出来），但**调用点**只有 db_write 的 after 钩子；
  // 绕过工具直接改库（mysql CLI / 别的进程 / 其它写 settings 的代码）不经过 execTool ⇒ 不会留下 policy: 行。
  // 要让"直改也认得出"必须上库内机制（settings 上的触发器）或对账，那是另一笔改动（见交付报告"需决策"）。
  const direct = "UPDATE settings SET svalue='[]' WHERE skey='access_rules'";
  assert.deepEqual(policyWriteOf(direct).keys, ['access_rules'], '识别器认得这条 SQL —— 认不出的是"没经过工具的那次执行"');
});
