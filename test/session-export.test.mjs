// test/session-export.test.mjs —— 会话导出/导入（夹具，**不碰真库**）
//
// 为什么要有假库：写库路径不许在真库上验证（那是别人的数据），但"写路径对不对"不能只靠嘴说。
// 所以这里实现一个只认**本模块发出的那几条语句**的假池（SELECT … WHERE id/conversation_id、
// INSERT INTO <表> (列) VALUES (…),(…)），并带事务语义——真库验证只做只读 export 与 import --dry-run。
//
// 夹具锁四件事：
//   ① 导出物是**自描述**的（format/formatVersion/exportedAt + conversation/messages/toolCalls/events/usage.rows）；
//   ② export→import→export 的**稳定字段逐字一致**（只有目标库重新分配的自增 id / message_id 允许变）；
//   ③ 版本不认识 → 显式失败且一行不写（"更新的版本"与"缺迁移的旧版本"分开报）；
//   ④ 缺字段 / 未解析的 JSON / 引用不一致 → 失败路径说清哪一条；dryRun 连连接都不取。
import { test } from 'node:test';
import assert from 'node:assert';
import {
  exportConversation, importConversation, validateSessionExport,
  SessionFormatUnsupportedMigrationError, SESSION_FORMAT, SESSION_FORMAT_VERSION,
} from '../server/session-export.js';

// ---------------- 夹具数据（形状照真库：列名取自 information_schema，不是照抄建表语句） ----------------
const seed = () => ({
  conversations: [{
    id: 7, account_id: 1, channel: 'web', external_id: null, permission: 'write', preset: 'all', mode: 'chat',
    project: 'default', title: '夹具会话', provider: 'deepseek', model: 'deepseek-v4-flash', shell_id: null,
    face_full: 0, created_at: new Date('2026-09-15T01:02:03Z'), updated_at: new Date('2026-09-15T04:05:06Z'),
  }],
  messages: [
    { id: 101, conversation_id: 7, role: 'user', content: '你好', reasoning: null, model: null, provider: null, tokens_in: 0, tokens_out: 0, created_at: new Date('2026-09-15T01:02:03Z') },
    { id: 102, conversation_id: 7, role: 'assistant', content: '我是夹具回复', reasoning: '思考中…', model: 'deepseek-v4-flash', provider: 'deepseek', tokens_in: 11, tokens_out: 22, created_at: new Date('2026-09-15T01:02:10Z') },
  ],
  tool_calls: [
    { id: 501, conversation_id: 7, message_id: 102, tool_name: 'read_file', args: { path: 'a.md' }, result_summary: '{"ok":true}', result_bytes: 12, duration_ms: 33, status: 'ok', error_code: null, shell_id: null, created_at: new Date('2026-09-15T01:02:11Z') },
    // args 给**字符串**：驱动给对象还是字符串随版本而异（JSON 列），两条分支都要覆盖
    { id: 502, conversation_id: 7, message_id: null, tool_name: 'web_search', args: '{"q":"x"}', result_summary: null, result_bytes: 0, duration_ms: 0, status: 'error', error_code: 'timeout', shell_id: null, created_at: new Date('2026-09-15T01:02:12Z') },
  ],
  events: [
    { id: 9001, conversation_id: 7, seq: 1, type: 'run_start', payload: { run: 1 }, created_at: new Date('2026-09-15T01:02:03Z') },
    { id: 9002, conversation_id: 7, seq: 2, type: 'done', payload: {}, created_at: new Date('2026-09-15T01:02:13Z') },
  ],
  usage_stats: [
    { id: 3001, account_id: 1, conversation_id: 7, agent_run_id: 55, shell_id: null, message_id: 102, provider_id: 'deepseek', model_id: 'deepseek-v4-flash', tokens_in: 11, tokens_out: 22, cost: '0.0012', duration_ms: 700, first_token_ms: 120, cache_hit_tokens: 0, cache_miss_tokens: 11, prefix_sys_hash: 'abc123', prefix_tools_hash: 'def456', kind: 'round', created_at: new Date('2026-09-15T01:02:10Z') },
  ],
});

const SELECT_RE = /^SELECT (.+?) FROM (\w+) WHERE (\w+)=\?/;
const INSERT_RE = /^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+)$/;

/** 只认本模块发出的语句的假池（带事务语义） */
function fakePool(input) {
  const store = {};
  for (const [t, rows] of Object.entries(input)) store[t] = rows.map((r) => ({ ...r }));
  const seq = {};
  for (const [t, rows] of Object.entries(store)) seq[t] = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
  let snapshot = null;
  const calls = { getConnection: 0 };

  function query(sql, params = []) {
    const sel = SELECT_RE.exec(sql);
    if (sel) {
      const cols = sel[1].split(',').map((s) => s.trim());
      // 夹具的行允许省列（真库不会）→ 按 NULL 返回：否则 JSON.stringify 会丢键，导出物形状就不稳定了
      return [store[sel[2]].filter((r) => r[sel[3]] === params[0]).sort((x, y) => x.id - y.id)
        .map((r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]])))];
    }
    const ins = INSERT_RE.exec(sql);
    if (!ins) throw new Error('假库不认识的语句：' + sql);
    const cols = ins[2].split(',').map((s) => s.trim());
    const n = (ins[3].match(/\(/g) || []).length;
    const rows = [];
    for (let i = 0; i < params.length; i += cols.length) {
      const row = { id: ++seq[ins[1]] };
      cols.forEach((c, k) => { row[c] = params[i + k]; });
      rows.push(row);
    }
    // 制造一次"写到一半失败"：内容为 __fail__ 时模拟驱动报错（用来锁"整体回滚、不留半截会话"）
    if (rows.some((r) => r.content === '__fail__')) throw new Error('模拟写失败');
    store[ins[1]].push(...rows);
    return [{ insertId: rows[0].id, affectedRows: rows.length }];
  }

  return {
    store,
    calls,
    pool: {
      query: async (sql, params) => query(sql, params),
      getConnection: async () => {
        calls.getConnection++;
        snapshot = Object.fromEntries(Object.entries(store).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]));
        return {
          query: async (sql, params) => query(sql, params),
          beginTransaction: async () => {},
          commit: async () => { snapshot = null; },
          rollback: async () => { for (const [t, rows] of Object.entries(snapshot)) store[t] = rows; snapshot = null; },
          release: () => {},
        };
      },
    },
  };
}

/** 稳定字段 = 不随目标库重新分配而变的部分（自增 id / message_id 会变，其余必须逐字一致） */
function stable(obj) {
  const drop = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  return JSON.parse(JSON.stringify({
    format: obj.format, formatVersion: obj.formatVersion, exportedAt: '（导出时间不参与比对）',
    conversation: drop(obj.conversation, ['id']),
    messages: obj.messages.map((m) => drop(m, ['id'])),
    toolCalls: obj.toolCalls.map((t) => drop(t, ['message_id'])),
    events: obj.events,
    usage: { rows: obj.usage.rows.map((u) => drop(u, ['message_id'])) },
  }));
}

// ---------------- ① 形状 ----------------
test('导出物自描述：format/formatVersion/exportedAt + 四部分，列名与真库一致', async () => {
  const { pool } = fakePool(seed());
  const obj = await exportConversation(7, { pool });
  assert.deepEqual(Object.keys(obj), ['format', 'formatVersion', 'exportedAt', 'conversation', 'messages', 'toolCalls', 'events', 'usage']);
  assert.equal(obj.format, SESSION_FORMAT);
  assert.equal(obj.formatVersion, SESSION_FORMAT_VERSION);
  assert.match(obj.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(obj.conversation), ['id', 'account_id', 'channel', 'external_id', 'permission', 'preset', 'mode', 'project', 'title', 'provider', 'model', 'shell_id', 'face_full', 'created_at', 'updated_at']);
  assert.deepEqual(Object.keys(obj.messages[0]), ['id', 'role', 'content', 'reasoning', 'model', 'provider', 'tokens_in', 'tokens_out', 'created_at']);
  assert.deepEqual(Object.keys(obj.toolCalls[0]), ['message_id', 'tool_name', 'args', 'result_summary', 'result_bytes', 'duration_ms', 'status', 'error_code', 'shell_id', 'created_at']);
  assert.deepEqual(Object.keys(obj.events[0]), ['seq', 'type', 'payload', 'created_at']);
  assert.deepEqual(Object.keys(obj.usage.rows[0]), ['account_id', 'message_id', 'agent_run_id', 'shell_id', 'provider_id', 'model_id', 'tokens_in', 'tokens_out', 'cost', 'duration_ms', 'first_token_ms', 'cache_hit_tokens', 'cache_miss_tokens', 'prefix_sys_hash', 'prefix_tools_hash', 'kind', 'created_at']);
  // JSON 列两条分支都归一成"解析后的值"（驱动可能给字符串）
  assert.deepEqual(obj.toolCalls.map((t) => t.args), [{ path: 'a.md' }, { q: 'x' }]);
  assert.deepEqual(obj.events[0].payload, { run: 1 });
  await assert.rejects(() => exportConversation(999, { pool }), /会话不存在：#999/);
});

// ---------------- ② 往返 ----------------
test('export→import→export：稳定字段逐字一致，且不覆盖源会话', async () => {
  const { pool, store } = fakePool(seed());
  const a = await exportConversation(7, { pool });
  const r = await importConversation(a, { dryRun: false, pool });
  assert.equal(r.dryRun, false);
  assert.notEqual(r.newId, 7); // 新 id 由目标库分配，不沿用源 id
  const b = await exportConversation(r.newId, { pool });
  assert.deepEqual(stable(b), stable(a));
  // 源会话原地未动（"导入"不是"往已有会话里灌数据"）
  assert.equal(store.conversations.length, 2);
  assert.deepEqual(pick(store.conversations.find((c) => c.id === 7), ['title', 'account_id', 'created_at']), {
    title: '夹具会话', account_id: 1, created_at: new Date('2026-09-15T01:02:03Z'),
  });
  assert.equal(store.messages.filter((m) => m.conversation_id === 7).length, 2);
  // 绑定口径（假库存的就是绑上去的值）：时间列还原成 Date（否则带 Z 的 ISO 会被当字面量存进去），JSON 列先序列化
  assert.ok(store.messages.find((m) => m.conversation_id === r.newId).created_at instanceof Date);
  assert.equal(typeof store.tool_calls.find((t) => t.conversation_id === r.newId).args, 'string');
});
function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

test('引用重指向：tool_calls / usage 的 message_id 指向**新** messages 的行', async () => {
  const { pool } = fakePool(seed());
  const r = await importConversation(await exportConversation(7, { pool }), { dryRun: false, pool });
  const b = await exportConversation(r.newId, { pool });
  const assistant = b.messages.find((m) => m.role === 'assistant');
  assert.equal(b.toolCalls[0].message_id, assistant.id, '有引用的那条要重指向');
  assert.equal(b.toolCalls[1].message_id, null, '本来就没有引用的不许被编出一个');
  assert.equal(b.usage.rows[0].message_id, assistant.id);
  assert.notEqual(assistant.id, 102);
});

// ---------------- ③ 版本 ----------------
test('版本不认识 → 显式失败（更新 / 缺迁移 / 版本号非法三种分开报），且一行不写', async () => {
  const { pool, store, calls } = fakePool(seed());
  const before = JSON.stringify(store);
  const a = await exportConversation(7, { pool });

  await assert.rejects(() => importConversation({ ...a, formatVersion: 2 }, { dryRun: false, pool }), (e) => {
    assert.equal(e.name, 'SessionFormatUnsupportedMigrationError');
    assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
    assert.match(e.message, /更新的格式 v2/);
    assert.match(e.message, /本版本只读写 v1/);
    return true;
  });
  await assert.rejects(() => importConversation({ ...a, formatVersion: 0 }, { dryRun: false, pool }), (e) => {
    assert.equal(e.name, 'SessionFormatUnsupportedMigrationError');
    assert.match(e.message, /没有 v0→v1 的迁移/);
    return true;
  });
  for (const bad of ['1', 1.5, -1, null, undefined]) {
    await assert.rejects(() => importConversation({ ...a, formatVersion: bad }, { dryRun: false, pool }), /formatVersion 必须是非负整数/);
  }
  assert.equal(JSON.stringify(store), before, '版本校验失败时绝不能写库（也不许部分导入）');
  assert.equal(calls.getConnection, 0, '版本校验失败发生在取连接之前');
});

// ---------------- ④ 缺字段 / 未解析 JSON / 引用不一致 ----------------
test('缺字段与坏输入：每条失败路径都指出是哪一条、为什么', async () => {
  const { pool, store, calls } = fakePool(seed());
  const a = await exportConversation(7, { pool });
  const before = JSON.stringify(store);
  const no = (k) => { const o = JSON.parse(JSON.stringify(a)); delete o[k]; return o; };

  assert.throws(() => validateSessionExport('{"format":"rw-session"}'), /必须是 JSON 对象（实际是 string）/);
  assert.throws(() => validateSessionExport(null), /必须是 JSON 对象/);
  assert.throws(() => validateSessionExport([a]), /必须是 JSON 对象（实际是 array）/);
  assert.throws(() => validateSessionExport(no('conversation')), /缺少 conversation 对象/);
  assert.throws(() => validateSessionExport({ ...a, format: 'rw-other' }), /不是 rw-session 导出物/);
  assert.throws(() => validateSessionExport({ ...a, messages: null }), /messages 必须是数组/);
  assert.throws(() => validateSessionExport({ ...a, usage: { rows: {} } }), /usage\.rows 必须是数组/);
  assert.throws(() => validateSessionExport({ ...a, conversation: { ...a.conversation, account_id: null } }), /conversation\.account_id 必须是整数/);
  assert.throws(() => validateSessionExport({ ...a, messages: [{ id: 1, content: 'x' }] }), /messages\[0\]\.role 必填/);
  assert.throws(() => validateSessionExport({ ...a, events: [{ seq: 1 }] }), /events\[0\]\.type 必填/);
  assert.throws(() => validateSessionExport({ ...a, messages: [{ ...a.messages[0] }, { ...a.messages[0] }] }), /messages\[1\]\.id 重复：101/);
  assert.throws(() => validateSessionExport({ ...a, messages: [{ ...a.messages[0], id: 'x' }] }), /messages\[0\]\.id 必须是整数/);
  assert.throws(() => validateSessionExport({ ...a, toolCalls: [{ ...a.toolCalls[0], message_id: 999 }] }), /toolCalls\[0\]\.message_id=999 在 messages 里不存在/);
  assert.throws(() => validateSessionExport({ ...a, usage: { rows: [{ message_id: 888 }] } }), /usage\[0\]\.message_id=888 在 messages 里不存在/);
  // 校验先于写库：坏输入不会留下任何痕迹
  await assert.rejects(() => importConversation({ ...a, messages: [{ id: 1, content: 'x' }] }, { dryRun: false, pool }), /role 必填/);
  await assert.rejects(() => importConversation({ ...a, toolCalls: [{ message_id: 999 }] }, { dryRun: false, pool }), /引用不一致|不存在/);
  assert.equal(JSON.stringify(store), before);
  assert.equal(calls.getConnection, 0, '校验失败必须发生在取连接之前');
});

// ---------------- ⑤ dryRun ----------------
test('dryRun 是默认值：只校验+计数，连连接都不取', async () => {
  const { pool, store, calls } = fakePool(seed());
  const a = await exportConversation(7, { pool });
  const before = JSON.stringify(store);
  const r = await importConversation(a, { pool }); // 不传 dryRun：默认必须是不写库
  assert.deepEqual(r, {
    ok: true, dryRun: true, newId: null, sourceId: 7,
    counts: { messages: 2, toolCalls: 2, events: 2, usage: 1 },
  });
  assert.equal(calls.getConnection, 0);
  assert.equal(JSON.stringify(store), before);
});

// ---------------- ⑥ 写失败不留半截 ----------------
test('写失败整体回滚：不留半截会话（假库实现事务语义，断言的是确实回滚且未提交）', async () => {
  const { pool, store, calls } = fakePool(seed());
  const a = await exportConversation(7, { pool });
  const broken = { ...a, messages: [{ ...a.messages[0], content: '__fail__' }], toolCalls: [], events: [], usage: { rows: [] } };
  const before = JSON.stringify(store);
  await assert.rejects(() => importConversation(broken, { dryRun: false, pool }), /模拟写失败/);
  assert.equal(calls.getConnection, 1);
  assert.equal(JSON.stringify(store), before, '会话行也要跟着回滚（否则留下一个空壳会话）');
});
