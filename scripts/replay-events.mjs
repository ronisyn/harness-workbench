#!/usr/bin/env node
// scripts/replay-events.mjs —— 从**事件账本**回放一个会话（确定性投影的第一块砖）
//
// 与既有 `src/eventstream.js`（前端重建器，读 messages/tool_calls）的分工：
//   · 那个回答"这轮对话发生了什么"（面向界面，数据源是业务表）；
//   · 这里回答"事件的**顺序与内容**本身是什么"（面向投影/回放，数据源是 append-only 账本）。
// 下一增量的确定性投影（运行态 = 事件流的投影）就读这份账本。
//
// 用法：node scripts/replay-events.mjs <conversationId> [--json]
import { readEvents } from '../server/eventlog.js';
import { pool } from '../server/db.js';

const cid = Number(process.argv[2]);
const asJson = process.argv.includes('--json');
if (!cid) { console.error('用法：node scripts/replay-events.mjs <conversationId> [--json]'); process.exit(2); }

const events = await readEvents(cid);
if (asJson) { console.log(JSON.stringify(events, null, 2)); }
else {
  console.log('=== 会话 ' + cid + ' 的事件账本：' + events.length + ' 条 ===');
  for (const e of events) {
    const p = e.payload || {};
    let brief = '';
    if (e.type === 'tool_start') brief = (p.tool && p.tool.name) || '';
    else if (e.type === 'tool_done') brief = ((p.tool && p.tool.name) || '') + ' ' + ((p.tool && p.tool.status) || '');
    else if (e.type === 'intent') brief = String(p.label || p.intent || '').slice(0, 40);
    else if (e.type === 'llm_retry') brief = JSON.stringify(p.retry || {}).slice(0, 60);
    else brief = JSON.stringify(p).slice(0, 60);
    console.log('  #' + String(e.id).padStart(6) + ' seq=' + String(e.seq).padStart(4) + '  ' + String(e.type).padEnd(14) + brief);
  }
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log('\n按类型：' + JSON.stringify(byType));
}
await pool.end();
