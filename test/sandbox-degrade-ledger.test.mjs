// test/sandbox-degrade-ledger.test.mjs —— 沙箱降级**必须留痕**（v0.3 §4.6「禁止静默降级：留痕 + 提高审批 + 客户可见」）
//
// 为什么补这条夹具（2026-09-16 实测教训）：审计写口从直连 SQL 迁到存储接口时，`server/sandbox/degrade.js`
//   忘了 import storage —— 本地全量门禁**全绿**（这条路径一份夹具都没有），直到服务器启动才在日志里炸出
//   `[sandbox] 降级账本缺行（降级已发生）：storage is not defined`。真机复核的"日志错误扫描"那一段抓到了它。
// 判据（对着 §4.6 的三件事）：① 降级真的落一行 `audit_log(action='sandbox:degrade')`；
//   ② detail 里能直接读出**为什么降级**（缺哪几层、原因、逐次上报的 enforcement、平台、归属）；
//   ③ 留痕失败**必须出声**且**不改判主流程**（返回 false，不抛）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditDegrade } from '../server/sandbox/degrade.js';

const COMPOSED = {
  enforcement: 'none', level: 'partial', probed: true, runner: null,
  layers: [{ id: 1, state: 'none' }, { id: 2, state: 'none' }, { id: 3, state: 'partial' }, { id: 4, state: 'full' }],
};

/** 记账假存储：只认 audit.append（其余调用一律抛错——免得夹具悄悄假装支持了什么） */
const fakeStore = ({ fail = false } = {}) => {
  const appends = [];
  return {
    appends,
    audit: {
      async append(f) {
        if (fail) throw new Error('audit 表锁住了');
        appends.push(f);
        return { id: appends.length };
      },
    },
  };
};

test('降级留痕：落一行 sandbox:degrade，detail 能直接读出"为什么降级"', async () => {
  const store = fakeStore();
  const ok = await auditDegrade(COMPOSED, { reason: '本机没有可用 runner', accountId: 7, shellId: 3, conversationId: 42 }, store);
  assert.equal(ok, true, '落账成功要回 true（调用方靠它判断"账有没有缺行"）');
  assert.equal(store.appends.length, 1);
  const row = store.appends[0];
  assert.equal(row.action, 'sandbox:degrade');
  assert.equal(row.accountId, 7);
  assert.equal(row.shellId, 3);
  assert.equal(row.conversationId, 42);
  const d = JSON.parse(row.detail);
  assert.equal(d.enforcement, 'none', '逐次上报值要进账（§4.6：enforcement 要如实上报）');
  assert.equal(d.level, 'partial');
  assert.equal(d.probed, true);
  assert.deepEqual(d.missingLayers, ['1:none', '2:none', '3:partial'], '缺哪几层要一眼看得出（4 层是 full，不进这份清单）');
  assert.equal(d.reason, '本机没有可用 runner');
  assert.equal(typeof d.platform, 'string');
});

test('降级留痕：没给 reason 时退回"第 2 层（引擎自带沙箱）的说明"——不许给出空的原因', async () => {
  const store = fakeStore();
  const composed = { ...COMPOSED, layers: [{ id: 1, state: 'none' }, { id: 2, state: 'none', note: '拿不到模式' }] };
  await auditDegrade(composed, {}, store);
  assert.equal(JSON.parse(store.appends[0].detail).reason, '拿不到模式');
  assert.equal(store.appends[0].accountId, null, '没有归属就是 null（不编一个 0）');
});

test('降级留痕失败：必须出声、且**不改判主流程**（返回 false，不抛）', async () => {
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  let ok;
  try {
    ok = await auditDegrade(COMPOSED, { reason: 'x' }, fakeStore({ fail: true }));
  } finally { console.error = realErr; }
  assert.equal(ok, false, '账没落上要如实回 false');
  assert.ok(errs.some((l) => /\[sandbox\] 降级账本缺行（降级已发生）/.test(l)), '留痕失败必须出声：' + JSON.stringify(errs));
});

test('降级留痕的写口是存储接口（不是直连 SQL）——源码级反向锁', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/sandbox/degrade.js', import.meta.url), 'utf8');
  assert.ok(!/INSERT INTO audit_log/.test(src), '不得在自己这里拼 SQL（v0.3 §4.1：写口走接口）');
  assert.match(src, /store\.audit\.append\(/, '写口必须走注入进来的 store');
  assert.match(src, /import \{ storage \}/, '默认实现要 import 进来（忘 import ＝ 真机上才炸，本夹具就是为这条补的）');
});
