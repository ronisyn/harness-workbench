// test/settings-wiring.test.mjs - 设置项必须**真的接线**（2026-09-15，C-14 的回归锁）
//
// 起因：`collapse_window_ratio` 在 settingsSchema 里登记了、agentLimits() 也 pick() 了它，
// 但它**不在那条 `SELECT ... WHERE skey IN (…)` 的键清单里** ⇒ pick 永远找不到行、永远返回默认值，
// 于是界面上怎么调都不生效。这类错误没有任何症状：不报错、不告警，只是"设置没用"。
// 同类第二处：schema 明写"0=关闭"，代码却写 `pick(k, 0) || 默认` —— 显式 0 被静默变成默认值。
// 两条都做成机检：**设置项的存在必须以"能被读到、且 0 的语义被尊重"为准**。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_SCHEMA } from '../server/settingsSchema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server/agent.js'), 'utf8');

// 定位 agentLimits() 里那条读取设置的行：`SELECT skey, svalue FROM settings WHERE skey IN (?,?…)', [ 'k1', 'k2' … ]`
const m = /SELECT skey, svalue FROM settings WHERE skey IN \(([?,]+)\)',\s*\[([^\]]+)\]/.exec(src);
assert.ok(m, '未能在 agent.js 里定位设置读取语句（源码结构变了，请更新本夹具）');
const placeholders = m[1].split(',').length;
const keyList = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
// agent.js 里所有 pick('X') 的键
const picked = [...src.matchAll(/pick\('([a-z_0-9]+)'/g)].map((x) => x[1]);

test('SQL 占位符数量必须等于键清单长度（不等＝查询在运行期直接抛错）', () => {
  assert.equal(placeholders, keyList.length, '它 ' + placeholders + ' 个 ? 对 ' + keyList.length + ' 个键');
  assert.ok(!/,,\s*\]/.test(m[2]), '键清单里不该有空位');
});

test('凡被 pick() 读取的键，都必须在 SELECT 键清单里（C-14：漏一个＝那个设置项设了不生效）', () => {
  const missing = picked.filter((k) => !keyList.includes(k));
  assert.deepEqual(missing, [], '这些键被 pick() 却不在读取清单里，设置永远不会生效：' + missing.join(', '));
});

test('schema 声明"0=关闭/不限"的键，不得用 `|| 默认值` 把显式 0 吞掉', () => {
  const zeroMeansOff = SETTINGS_SCHEMA.filter((s) => /0\s*=\s*(关闭|关|不限|不启用)/.test(String(s.hint || ''))).map((s) => s.key);
  assert.ok(zeroMeansOff.length > 0, '未能从 schema hint 里识别出"0=关闭/不限"的键（hint 写法变了？）');
  const offenders = [];
  for (const k of zeroMeansOff) {
    if (!picked.includes(k)) continue; // 不在 agent.js 读的不归本夹具管
    const re = new RegExp("pick\\('" + k + "'[^)]*\\)\\s*\\|\\|");
    if (re.test(src)) offenders.push(k);
  }
  assert.deepEqual(offenders, [], '这些键的 schema 写着 0=关闭/不限，代码却把 0 当"没设"处理：' + offenders.join(', '));
});
