#!/usr/bin/env node
// scripts/projection-replay.mjs —— 从事件账本重放投影，并**与数据库现值逐项对账**
//
// 与既有 `scripts/replay-events.mjs` 的分工：那个只按顺序列出账本（"发生了什么事件"），
// 这个把账本折成运行态（"这些事件意味着什么"）再拿业务表核一遍 —— 不一致本身就是发现分叉的手段，
// 所以差异**如实打印**，不为了好看放宽判据。
//
// 用法：node scripts/projection-replay.mjs <conversationId> [--json]
import { readEvents } from '../server/eventlog.js';
import { project, verifyProjection } from '../server/projection.js';
import { db, pool } from '../server/db.js';

const cid = Number(process.argv[2]);
const asJson = process.argv.includes('--json');
if (!cid) { console.error('用法：node scripts/projection-replay.mjs <conversationId> [--json]'); process.exit(2); }

const events = await readEvents(cid);
const states = project(events);

// 会话内见过的工具面上下文（run_start 里的 permission/preset/light）——对账要复算"当时的可用面"
const ctx = new Map();
for (const e of events) {
  if (e.type !== 'run_start') continue;
  const p = e.payload || {};
  ctx.set(String(p.permission) + '/' + String(p.preset) + '#' + (p.light ? 'light' : 'full'),
    { permission: p.permission || 'full', preset: p.preset || 'all', light: !!p.light });
}
const { checks, notes } = await verifyProjection({ conversationId: cid, states, db, ctx });

if (asJson) {
  console.log(JSON.stringify({ conversationId: cid, applied: states.__applied, states, checks, notes }, null, 2));
} else {
  console.log('=== 会话 ' + cid + ' 的投影（账本 ' + events.length + ' 条 / 实际折叠 ' + states.__applied + ' 条）===');
  console.log('\n[runStats] 每个 run 的轮次/工具/失败码/重试');
  for (const [k, r] of Object.entries(states.runStats.runs)) {
    console.log('  ' + k.padEnd(12)
      + ' 轮次=' + r.rounds
      + ' 工具=' + r.toolStarted + '（done ' + r.toolDone + ' / fail ' + r.toolFail + '）'
      + ' 重试=' + r.llmRetries
      + ' 失败码=' + (Object.keys(r.failureCodes).length ? JSON.stringify(r.failureCodes) : '无'));
  }
  if (!Object.keys(states.runStats.runs).length) console.log('  （无）');

  console.log('\n[toolFace] 本会话调用过的工具（首次出现顺序）');
  console.log('  顺序：' + (states.toolFace.order.join(' → ') || '（无）'));
  console.log('  计数：' + (Object.entries(states.toolFace.counts).map(([k, v]) => k + '×' + v).join('、') || '（无）')
    + '；工具调用事件合计 ' + states.toolFace.calls + ' 次');

  console.log('\n[outcomes] 每次 run 的终结状态');
  // 没收到 run_end 的 run 要看得出来（打印 null 而不是 undefined，否则像"值丢了"）
  const show = (v) => (v == null ? '—' : String(v));
  for (const [k, o] of Object.entries(states.outcomes.runs)) {
    console.log('  ' + k.padEnd(12) + ' 终结事件=' + show(o.terminal) + ' status=' + show(o.status)
      + ' reason=' + show(o.reason) + ' guard=' + show(o.guard));
  }
  if (!Object.keys(states.outcomes.runs).length) console.log('  （无）');

  console.log('\n=== 与数据库现值对账 ===');
  let pass = 0, fail = 0, skip = 0;
  for (const c of checks) {
    const mark = c.ok === null ? '—' : (c.ok ? '✓' : '✗');
    if (c.ok === null) skip++; else if (c.ok) pass++; else fail++;
    console.log('  ' + mark + ' ' + c.name + '\n      ' + c.detail);
  }
  for (const n of notes) console.log('  · ' + n);
  console.log('\n小计：✓ ' + pass + ' / ✗ ' + fail + (skip ? ' / — ' + skip + '（无法判定）' : ''));
}
await pool.end();
