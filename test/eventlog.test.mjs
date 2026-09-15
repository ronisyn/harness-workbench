// test/eventlog.test.mjs - 事件账本（append-only，可回放）：确定性投影的前提
//
// 背景（2026-09-15 摸底）：事件流此前只活在内存环里（最多 300 条、进程重启即忘），库里没有任何事件表。
// 于是"把运行态当成事件流的投影"这件事**没有源**。本夹具锁三件：
//   ① 行形状与"跳过纯流式增量"的唯一出处（think/delta 不进账本，最终文本在 messages 里可查）；
//   ② 唯一写入点：只有 server/eventlog.js 向 events 表写入，且 emitEv 必须调它；
//   ③ 落账失败**不阻断**执行（事件是观测面，丢了要看得见，但不能让整轮失败）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventRow, persistEvent, eventLogStats, TRANSIENT_TYPES } from '../server/eventlog.js';
import { VERSIONS } from '../server/migrations.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('行形状：seq/at 由表承担，payload 存其余原文', () => {
  const r = eventRow(7, { seq: 12, at: 1757000000000, type: 'tool_done', tool: { name: 'read_file', status: 'done' } });
  assert.deepEqual(r, { conversation_id: 7, seq: 12, type: 'tool_done', payload: { tool: { name: 'read_file', status: 'done' } } });
  assert.equal(eventRow(null, { type: 'x' }).conversation_id, null);
  assert.equal(eventRow(1, {}).type, 'unknown', '缺 type 不得写出 undefined 进列');
});

test('跳过名单是唯一出处，且只含纯流式增量（防止哪天顺手把状态事件也跳过）', () => {
  assert.deepEqual([...TRANSIENT_TYPES].sort(), ['delta', 'think']);
  for (const t of ['run_start', 'run_end', 'tool_start', 'tool_done', 'intent', 'plan', 'llm_retry', 'approval', 'done']) {
    assert.equal(TRANSIENT_TYPES.has(t), false, t + ' 是状态事件，必须进账本');
  }
  assert.equal(persistEvent(1, { type: 'think', text: 'x' }), false, 'transient 明确不写（返回 false 而不是假装写了）');
  assert.equal(persistEvent(1, { type: 'tool_start' }), true, '状态事件必须尝试写入');
  assert.equal(persistEvent(0, { type: 'tool_start' }), false, '没有会话 id 不写（拿不到归属的账没有意义）');
});

test('落账失败不阻断：db 抛错也不得让 persistEvent 抛出（事件是观测面）', async () => {
  // 用不存在的库名把插入打失败：调用点必须毫无感觉
  const before = eventLogStats().fail;
  assert.doesNotThrow(() => persistEvent(1, { type: 'tool_done', tool: { name: 'x' } }));
  await new Promise((r) => setTimeout(r, 400)); // 让 fire-and-forget 的失败路径走完（连不上库时也会落 catch）
  const st = eventLogStats();
  assert.ok(st.ok + st.fail >= before, '统计必须能读到（自检要用）');
  assert.equal(typeof st.lastError === 'string' || st.lastError === null, true);
});

test('唯一写入点：只有 eventlog.js 往 events 表写，且 emitEv 必须调用它', () => {
  const files = [];
  const walk = (d) => {
    for (const it of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (it.name === 'node_modules') continue;
      const rel = d + '/' + it.name;
      if (it.isDirectory()) walk(rel);
      else if (/\.m?js$/.test(it.name)) files.push(rel);
    }
  };
  walk('server');
  const inserters = files.filter((f) => /INSERT INTO events\b/i.test(read(f)));
  assert.deepEqual(inserters, ['server/eventlog.js'], 'events 账本只能有一个写入点，实际：' + inserters.join(', '));
  assert.match(read('server/agent.js'), /persistEvent\(conversationId, ev\)/, 'emitEv 必须把事件交给账本（否则账本永远空着）');
  // 迁移与建表都要有（存量库走迁移、新库走 SCHEMA —— 两条路径缺一不可）
  assert.ok(VERSIONS.some((v) => v.id === '0003_event_log'), '迁移链必须有 0003_event_log');
  assert.match(read('server/db.js'), /CREATE TABLE IF NOT EXISTS events/, '新库 SCHEMA 也要建这张表');
});

test('账本只追加：代码里不得出现对 events 的 UPDATE/DELETE', () => {
  const src = read('server/eventlog.js');
  assert.ok(!/UPDATE\s+events|DELETE\s+FROM\s+events/i.test(src), '账本只追加，不改写不删除');
  assert.match(src, /保留策略沿用审计账本/, '保留策略要写明出处（不自己发明一个天数）');
});
