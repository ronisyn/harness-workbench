// test/session-format-migration.test.mjs —— 会话格式**迁移链**的夹具（依据 v0.3 §4.9 / §7.1 ⑪，2026-09-16）
//
// 为什么要有它：迁移注册点最容易写成"看着有、其实不拦人"——跳步能注册、缺步能跑、旧文件被当成当前版本硬读。
// 这三条都是**静默的数据错误**（出事那天没有任何报错），所以夹具的价值全在负例。这里锁五件事：
//   ① 跳步注册必须在**注册时**就抛错（相邻步是装配期规则，不靠运行时兜底）；
//   ② 链有缺口 / 有多余步必须在**读任何文件之前**抛错（不带半条链跑）；
//   ③ **"首版、无迁移步"是合法状态**：当前只有 v1 ⇒ 链为空、启动校验通过（这不是"缺一步"）；
//   ④ 合成的一条 **v0→v1** 步证明"导入时先按链逐步迁移、再导入"真的走得通（含引用重指向、纯函数不改入参、
//      以及**注销后立刻回到拒绝**——证明通路是注册点打开的，不是碰巧能读）；
//   ⑤ 迁移步自己抛错 ⇒ 显式报"哪一步拒绝了哪个版本"，不许静默变成"文件坏了"。
// **合成步只活在本夹具里**（用注册点返回的注销函数还原），不进产品代码——当前没有 v0 的文件，写它没有第二个使用者。
import { test } from 'node:test';
import assert from 'node:assert';
import {
  registerSessionMigration, sessionMigrations, validateSessionMigrationChain, planSessionMigration,
  migrateSessionExport, importConversation,
  SessionFormatUnsupportedMigrationError, SESSION_FORMAT, SESSION_FORMAT_VERSION, SESSION_FORMAT_FIRST_VERSION,
} from '../server/session-export.js';

/** 合成链用的一步（形状与注册表里的一致；纯函数校验器接受这种裸数组，见 migrations.js 的 validateChain 同款用法） */
const step = (from, fn = (o) => o) => ({ fromVersion: from, toVersion: from + 1, name: 'v' + from + '-to-v' + (from + 1), fn });

/** 只认"本模块发出的 INSERT"的假池（够用就行：这里验的是**迁移**，导入通路的完整夹具在 session-export.test.mjs） */
function fakePool() {
  const store = { conversations: [], messages: [], tool_calls: [], events: [], usage_stats: [] };
  const calls = { getConnection: 0 };
  let seq = 0;
  const query = (sql, params = []) => {
    const ins = /^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+)$/.exec(sql);
    if (!ins) throw new Error('假库不认识的语句：' + sql);
    const cols = ins[2].split(',').map((s) => s.trim());
    const rows = [];
    for (let i = 0; i < params.length; i += cols.length) {
      const row = { id: ++seq };
      cols.forEach((c, k) => { row[c] = params[i + k]; });
      rows.push(row);
    }
    store[ins[1]].push(...rows);
    return [{ insertId: rows[0].id, affectedRows: rows.length }];
  };
  return {
    store,
    calls,
    pool: {
      query: async (sql, params) => query(sql, params),
      getConnection: async () => {
        calls.getConnection++;
        return { query: async (sql, params) => query(sql, params), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
      },
    },
  };
}

// 合成的 v0 形状（**只在本夹具里**）：字段名与 v1 故意不同（msgs/calls/text/msg_id），
// 这样"导入成功"只可能是因为**真的迁移过**，而不是碰巧能读。
const v0doc = () => ({
  format: SESSION_FORMAT,
  formatVersion: 0,
  exportedAt: '2026-09-01T00:00:00.000Z',
  conversation: { id: 7, account_id: 1, title: 'v0 旧会话' },
  msgs: [
    { id: 101, role: 'user', text: '你好' },
    { id: 102, role: 'assistant', text: '我是 v0 回复', reasoning: '想…' },
  ],
  calls: [{ msg_id: 102, tool: 'read_file', args: { path: 'a.md' }, status: 'ok' }],
  events: [{ seq: 1, type: 'run_start', payload: { run: 1 } }],
});

/** v0→v1：改字段名、补 v1 才有的部分、丢掉 v0 的旧键（迁移步必须是纯函数，不改入参） */
function v0ToV1(o) {
  const { msgs, calls, ...rest } = o;
  return {
    ...rest,
    conversation: { ...o.conversation, channel: 'web', permission: 'write', preset: 'all', mode: 'chat', project: 'default' },
    messages: msgs.map((m) => ({ id: m.id, role: m.role, content: m.text, reasoning: m.reasoning ?? null, model: null, provider: null, tokens_in: 0, tokens_out: 0 })),
    toolCalls: calls.map((c) => ({ message_id: c.msg_id, tool_name: c.tool, args: c.args, result_summary: null, result_bytes: 0, duration_ms: 0, status: c.status, error_code: null, shell_id: null })),
    usage: { rows: [] },
  };
}

// ---------------- ③ 首版无步 ----------------
test('正例：当前只有 v1 ⇒ 链为空是**合法状态**（首版、无迁移步），启动校验通过', () => {
  assert.equal(SESSION_FORMAT_VERSION, 1);
  assert.equal(SESSION_FORMAT_FIRST_VERSION, 1);
  assert.deepEqual(sessionMigrations(), [], 'v1 是首版：没有任何旧版本存在过 ⇒ 没有迁移步可写');
  assert.equal(validateSessionMigrationChain(), true, '"链为空"不是缺口（否则当前这次发布根本起不来）');
  // 当前版本的导出物**不走迁移**（照 DSH ③：current 直接走 codec）——原样返回，零开销
  const cur = { format: SESSION_FORMAT, formatVersion: SESSION_FORMAT_VERSION, conversation: { account_id: 1 }, messages: [], toolCalls: [], events: [], usage: { rows: [] } };
  assert.equal(migrateSessionExport(cur), cur);
});

// ---------------- ① 相邻步（注册时校验） ----------------
test('负例：跳步/倒步/非法版本号必须在**注册时**抛错，且不留半条链', () => {
  assert.throws(() => registerSessionMigration(0, 2, v0ToV1), /必须相邻/);
  assert.throws(() => registerSessionMigration(0, 1.5, v0ToV1), /必须相邻|非负整数/);
  assert.throws(() => registerSessionMigration(1, 1, v0ToV1), /必须相邻/);
  assert.throws(() => registerSessionMigration(2, 1, v0ToV1), /必须相邻/);
  assert.throws(() => registerSessionMigration(-1, 0, v0ToV1), /非负整数/);
  assert.throws(() => registerSessionMigration('0', 1, v0ToV1), /非负整数/);
  assert.throws(() => registerSessionMigration(0, 1, '不是函数'), /缺少迁移函数/);
  assert.deepEqual(sessionMigrations(), [], '注册失败不得在链里留下半条');
});

test('负例：同一起点重复注册必须抛错（同一版本不能有两条出路）', () => {
  const off = registerSessionMigration(0, 1, v0ToV1);
  try {
    assert.throws(() => registerSessionMigration(0, 1, v0ToV1), /重复注册/);
    assert.equal(sessionMigrations().length, 1);
  } finally { off(); }
  assert.deepEqual(sessionMigrations(), [], '注销函数必须把链还原干净（夹具靠它不污染别的用例）');
});

// ---------------- ② 链缺口 / 多余步 ----------------
test('负例：链有缺口必须抛错（合成链 base=1/head=3 缺 v1→v2）', () => {
  const gap = [step(0), step(2)];
  assert.throws(() => validateSessionMigrationChain(gap, { base: 1, head: 3 }), /有缺口：缺 v1→v2/);
  // 同一份链在"规划"里也必须显式报，不允许静默按当前版本读
  assert.throws(() => planSessionMigration(1, { steps: gap, head: 3 }), (e) => {
    assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v1→v3 的迁移/);
    assert.match(e.message, /缺这一步：v1→v2/);
    return true;
  });
  // 正例对照（否则上面两条可能只是"这个函数永远不会通过"）
  assert.equal(validateSessionMigrationChain([step(0), step(1), step(2)], { base: 1, head: 3 }), true);
  assert.deepEqual(planSessionMigration(1, { steps: [step(1), step(2)], head: 3 }).map((s) => s.name), ['v1-to-v2', 'v2-to-v3']);
});

test('负例：把坏链直接交给校验器也要拦（不相邻 / 重复起点 / 缺函数 / 不是数组）', () => {
  assert.throws(() => validateSessionMigrationChain([step(1), { fromVersion: 2, toVersion: 4, fn: () => {} }]), /必须相邻/);
  assert.throws(() => validateSessionMigrationChain([step(1), step(1)], { base: 1, head: 3 }), /重复/);
  assert.throws(() => validateSessionMigrationChain([{ fromVersion: 1, toVersion: 2 }]), /缺少迁移函数/);
  assert.throws(() => validateSessionMigrationChain('不是数组'), /必须是数组/);
});

test('负例：指向未来的多余步必须抛错（改了版本号却先注册了下一步 / 忘了改版本号）', () => {
  const off = registerSessionMigration(1, 2, (o) => o); // 而 head 还是 1
  try {
    assert.throws(() => validateSessionMigrationChain(), /多余步.*v1/);
  } finally { off(); }
  // v0 的文件在**没有 v0→v1 这一步**时一律拒绝（消息逐字锁住既有判据）
  assert.throws(() => planSessionMigration(0), (e) => {
    assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v0→v1 的迁移/);
    return true;
  });
});

// ---------------- ④ 导入时先迁移（合成 v0→v1） ----------------
test('正例：注册 v0→v1 后，v0 导出物**先迁移再导入**；注销后又回到显式拒绝', async () => {
  const { pool, store, calls } = fakePool();
  const before = v0doc();

  // 对照（注册之前）：v0 显式拒绝，一行不写、连连接都不取
  await assert.rejects(() => importConversation(v0doc(), { pool }), (e) => {
    assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
    assert.match(e.message, /没有 v0→v1 的迁移/);
    return true;
  });
  assert.equal(calls.getConnection, 0);

  const off = registerSessionMigration(0, 1, v0ToV1, { name: 'v0-to-v1' });
  try {
    assert.equal(validateSessionMigrationChain(), true, '合成的相邻链本身必须是合法的');
    // dryRun：计数只可能来自**迁移后**的 v1 形状（v0 里根本没有 messages/usage 这些键）
    const dry = await importConversation(v0doc(), { pool });
    assert.deepEqual(dry.counts, { messages: 2, toolCalls: 1, events: 1, usage: 0 });
    assert.equal(calls.getConnection, 0, 'dryRun 仍然不取连接');

    // 真写一遍：落地的行必须是 v1 形状（字段名与取值都搬过去了）
    const w = await importConversation(v0doc(), { dryRun: false, pool });
    const conv = store.conversations.find((c) => c.id === w.newId);
    assert.equal(conv.title, 'v0 旧会话');
    assert.equal(conv.mode, 'chat');
    const msgs = store.messages.filter((m) => m.conversation_id === w.newId);
    assert.deepEqual(msgs.map((m) => [m.role, m.content]), [['user', '你好'], ['assistant', '我是 v0 回复']]);
    assert.equal(msgs[1].reasoning, '想…');
    const tc = store.tool_calls.filter((t) => t.conversation_id === w.newId);
    assert.equal(tc.length, 1);
    assert.equal(tc[0].tool_name, 'read_file', 'v0 的 tool → v1 的 tool_name');
    assert.equal(tc[0].message_id, msgs[1].id, 'v0 的 msg_id → 新 messages 行的 id（引用重指向照旧）');
    assert.ok(store.events.some((e) => e.conversation_id === w.newId && e.type === 'run_start'));
    // 迁移是**纯函数**：入参一个字都不许改（调用方可能还持有那份文件对象）
    assert.deepEqual(before, v0doc(), 'migrateSessionExport 不得就地改写入参');
  } finally { off(); }

  // 注销 ⇒ 回到"链为空"，v0 重新被显式拒绝：证明这条路是注册点打开的，不是碰巧读得动
  assert.deepEqual(sessionMigrations(), []);
  await assert.rejects(() => importConversation(v0doc(), { pool }), /没有 v0→v1 的迁移/);
  assert.equal(store.conversations.length, 1, '拒绝路径一行不写（上面真写的那一次除外）');
});

test('正例：链盖 formatVersion（步自己写错版本号也不会让链错位）', () => {
  // 这一步故意把 formatVersion 写成 99：链必须在每一步之后**盖章**，否则"走到哪一版"就有两个出处
  const off = registerSessionMigration(0, 1, (o) => ({ ...v0ToV1(o), formatVersion: 99 }));
  try {
    assert.equal(migrateSessionExport(v0doc()).formatVersion, 1);
  } finally { off(); }
});

// ---------------- ⑤ 迁移步抛错 / 返回值不对 ----------------
test('负例：迁移步自己抛错 ⇒ 显式报"哪一步拒绝了哪个版本"（不许看起来像文件坏了）', () => {
  const off = registerSessionMigration(0, 1, () => { throw new TypeError('字段缺失'); }, { name: 'v0-to-v1' });
  try {
    assert.throws(() => migrateSessionExport(v0doc()), (e) => {
      assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
      assert.match(e.message, /迁移步 v0-to-v1 拒绝了这份 v0 导出物/);
      assert.match(e.message, /字段缺失/);
      return true;
    });
  } finally { off(); }
});

test('负例：迁移步必须返回导出物对象（返回 null / 数组都要拦）', () => {
  const off = registerSessionMigration(0, 1, () => null);
  try {
    assert.throws(() => migrateSessionExport(v0doc()), /必须返回导出物对象（实际是 object）/);
  } finally { off(); }
  const off2 = registerSessionMigration(0, 1, () => []);
  try {
    assert.throws(() => migrateSessionExport(v0doc()), /必须返回导出物对象（实际是 array）/);
  } finally { off2(); }
});

// ---------------- 信封检查（两个入口共用一份） ----------------
test('信封检查先于版本判定：非对象 / 不是我们的格式 / 版本号不合法，三档分开报', () => {
  const a = { format: SESSION_FORMAT, formatVersion: 1, conversation: { account_id: 1 }, messages: [], toolCalls: [], events: [], usage: { rows: [] } };
  assert.throws(() => migrateSessionExport('{"format":"rw-session"}'), /必须是 JSON 对象（实际是 string）/);
  assert.throws(() => migrateSessionExport([a]), /必须是 JSON 对象（实际是 array）/);
  assert.throws(() => migrateSessionExport({ ...a, format: 'rw-other' }), /不是 rw-session 导出物/);
  for (const bad of ['1', 1.5, -1, null, undefined]) {
    assert.throws(() => migrateSessionExport({ ...a, formatVersion: bad }), /formatVersion 必须是非负整数/);
  }
  // 更新版本：不降级读取（与既有夹具同一条判据，走迁移入口也必须一致）
  assert.throws(() => migrateSessionExport({ ...a, formatVersion: 2 }), (e) => {
    assert.ok(e instanceof SessionFormatUnsupportedMigrationError);
    assert.match(e.message, /更新的格式 v2/);
    return true;
  });
});
