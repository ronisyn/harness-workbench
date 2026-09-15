// test/knowledge-sink.test.mjs —— 「受限自动沉淀」提案式夹具（2026-09-16）
//
// 依据：v0.3 §4.3「记忆」行的「**受限自动沉淀**」＋ §0.4 M3 铁律「产出物只能是提案，不许自我放行」。
// 主导架构师拍板：**提案式，不全自动写库**。本夹具逐条锁住：
//   ① 产出的是**提案**（待审条目 + 一张既有问询卡），**不是**直接写库 —— 未确认时 `knowledge` 无新增；
//   ② 确认之后才写入（且写的是同一张 `knowledge` 表、列形状与 `kb_add` 逐字一致）；
//   ③ 反向核对：跳卡/超时/杂答复 **一律不写**；`proposeKnowledge` 的源码里不许有 INSERT。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SINK_KINDS, SINK_TAG, candidatesFromSession, renderCard, proposeKnowledge, decisionOf, writeKnowledge, describeProposals,
} from '../server/selfeval/knowledge-sink.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'selfeval', 'knowledge-sink.js'), 'utf8');

/** 记账假库（口径同 test/selfeval.test.mjs 的 makeFakeDb）：只记写操作，读一律返回空 */
function makeFakeDb() {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) { writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { insertId: 7001, affectedRows: 1 }; }
      return [];
    },
  };
}

/** 一段"够格沉淀"的会话经历：复盘三段 + 失败转成功 + 用户长期约定 */
const SESSION = {
  conversationId: 184,
  messages: [
    { role: 'user', content: '这条命令以后都按 pwsh 写，别再改成 cmd' },
    { role: 'assistant', content: '## 复盘\n做得好：先读了夹具；做得不好：漏了 node --check；改进项：每改必 check' },
  ],
  toolCalls: [
    { tool_name: 'run_command', status: 'fail' },
    { tool_name: 'run_command', status: 'ok' },
    { tool_name: 'read_file', status: 'ok' },
  ],
  summary: { summary: '本轮把 X 收口；决策：只增不删。' },
};

// ── ① 产出的是提案（不是写库）────────────────────────────────────────────────────────────
test('沉淀①：产出待审条目 + 既有问询卡；此时**一行都不写库**', () => {
  const D = makeFakeDb();
  const cards = [];
  const r = proposeKnowledge({
    ...SESSION, dbc: undefined,
    createAskFn: (q, options, o) => ({ id: 'ask-test-1', question: q, options, conversationId: o && o.conversationId }),
    emit: (e) => cards.push(e),
  });
  assert.ok(r.pending.length >= 2, '复盘 + 失败转成功至少两条候选，实际 ' + r.pending.length);
  assert.ok(r.pending.every((p) => p.status === 'pending'), '待审条目的状态必须是 pending');
  assert.ok(r.pending.every((p) => SINK_KINDS.includes(p.kind)), 'kind 必须在既有取值域内');
  assert.equal(cards.length, r.pending.length, '每条待审条目挂一张卡');
  assert.equal(cards[0].type, 'ask', '出口用的是**既有**的 ask 事件形状（与 ask_user 工具同一个）');
  assert.deepEqual(cards[0].options.map((o) => o.value), ['write:global', 'write:conv', 'skip']);
  assert.equal(D.writes.length, 0, 'proposeKnowledge **不许**写库');
  // 卡片文案必须明确"不选就不写"
  assert.match(renderCard(r.pending[0]).question, /你不选就不会写入任何东西/);
  assert.match(describeProposals(r), /人确认后才写库/);
});

// ── ② 未确认 ⇒ knowledge 无新增；确认后 ⇒ 才写入 ─────────────────────────────────────────
test('沉淀②：未确认不写；确认后才写入（同一张 knowledge 表、列形状与 kb_add 一致）', async () => {
  const D = makeFakeDb();
  const r = proposeKnowledge({ ...SESSION, createAskFn: () => ({ id: 'ask-test-2' }) });
  const entry = r.pending[0];

  // 未确认（超时/取消：答复为空）⇒ 不写
  const none = await writeKnowledge(entry, { answer: null, dbc: D, accountId: 1 });
  assert.equal(none.written, false);
  assert.match(none.reason, /没有答复/);
  assert.equal(D.writes.length, 0, '未确认时 knowledge 必须无新增');

  // 确认（写入本会话私有）⇒ 才写一条
  const ok = await writeKnowledge(entry, { answer: 'write:conv', dbc: D, accountId: 1 });
  assert.equal(ok.written, true);
  assert.equal(ok.scope, 'conv');
  assert.equal(D.writes.length, 1);
  assert.match(D.writes[0].sql, /^INSERT INTO knowledge \(account_id, scope, conversation_id, shell_id, kind, title, body, status\)/);
  assert.equal(D.writes[0].params.length, 8);
  assert.equal(D.writes[0].params[0], 1, 'account_id 必须是确认者的账号');
  assert.equal(D.writes[0].params[4], entry.kind);
  assert.match(String(D.writes[0].params[6]), new RegExp(SINK_TAG.slice(0, 8)), '正文要留下"提案式沉淀"的来源痕迹');
  // 全局选项：scope=global 时不得带上会话/壳的归属（可见性口径留给 kbVisibleWhere）
  const D2 = makeFakeDb();
  await writeKnowledge(entry, { answer: 'write:global', dbc: D2, accountId: 1, conversationId: 184, shellId: 9 });
  assert.equal(D2.writes[0].params[1], 'global');
  assert.equal(D2.writes[0].params[2], null);
  assert.equal(D2.writes[0].params[3], null);
});

// ── ③ 反向核对：跳卡/杂答复/空条目 一律不写 ───────────────────────────────────────────────
test('沉淀③（反向）：skip / 超时 / 杂答复 / 空条目 / 缺账号 ⇒ 一律不写，且如实说明原因', async () => {
  const D = makeFakeDb();
  const r = proposeKnowledge({ ...SESSION, createAskFn: () => ({ id: 'a' }) });
  const entry = r.pending[0];
  const skip = await writeKnowledge(entry, { answer: 'skip', dbc: D, accountId: 1 });
  assert.equal(skip.written, false);
  assert.equal(D.writes.length, 0);
  const junk = await writeKnowledge(entry, { answer: '写吧', dbc: D, accountId: 1 });
  assert.equal(junk.written, false);
  assert.match(junk.reason, /不在选项内/);
  const timeout = await writeKnowledge(entry, { answer: '', dbc: D, accountId: 1 });
  assert.equal(timeout.written, false);
  await assert.rejects(() => writeKnowledge({ title: '', body: 'x' }, { answer: 'write:global', dbc: D, accountId: 1 }), /缺 title\/body/);
  await assert.rejects(() => writeKnowledge(entry, { answer: 'write:global', dbc: null, accountId: 1 }), /没有可用的库句柄/);
  await assert.rejects(() => writeKnowledge(entry, { answer: 'write:global', dbc: D }), /需要账号/);
  await assert.rejects(() => writeKnowledge(entry, { answer: 'write:global', dbc: D, accountId: 1, kind: '随便' }), /不在既有取值域内/);
  assert.equal(D.writes.length, 0, '上面每一条都必须"不写"');
  // decisionOf 的取值域：只有本模块给出的三个选项
  assert.deepEqual(decisionOf('write:global'), { write: true, scope: 'global', reason: '用户确认写入全局' });
  assert.deepEqual(decisionOf('write:conv').scope, 'conv');
  assert.equal(decisionOf('skip').write, false);
  assert.equal(decisionOf(undefined).write, false);
});

// ── ④ 源码反向锁：产出路径里没有 INSERT；写点只有一处 ─────────────────────────────────────
test('沉淀④（反向）：proposeKnowledge 里不出现 INSERT（写点唯一，且只在确认之后）', () => {
  const body = SRC.slice(SRC.indexOf('export function proposeKnowledge'), SRC.indexOf('/** 答卡结果'));
  assert.ok(!/INSERT\s+INTO/i.test(body), 'proposeKnowledge 必须**只产出对象**：出现 INSERT 就是"自动写库"了');
  const inserts = [...SRC.matchAll(/INSERT\s+INTO\s+([a-z_]+)/gi)].map((m) => m[1]);
  assert.deepEqual(inserts, ['knowledge'], '本模块只允许写 knowledge 一张表，实际：' + inserts.join(', '));
  // writeKnowledge 的签名里必须有"答复"这个入参（没有它就无法保证"人确认"是前置）
  assert.match(SRC, /export async function writeKnowledge\(entry, \{ answer,/);
  // 没有候选时如实说"没有"，不许静默当成功
  const empty = proposeKnowledge({ conversationId: 1, messages: [{ role: 'user', content: '你好' }] });
  assert.equal(empty.pending.length, 0);
  assert.match(empty.skipped[0], /没有够格的候选/);
  assert.equal(candidatesFromSession({ messages: [] }).length, 0);
});
