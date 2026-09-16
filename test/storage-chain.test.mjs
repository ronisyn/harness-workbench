// test/storage-chain.test.mjs —— G1 出口的机检（v0.3 §0.2 G1 / §0.4 M1 / §4.1「存储走接口」）
//
// 判据（三部分，缺一不可）：
//   ① **端到端真跑**：`RW_STORAGE=jsonfile` + **MySQL 不可达**（DB_PORT 指向没人监听的端口）起**真服务**，
//      走真 HTTP：登录 → 建会话 → 发一轮（离线壳，不真调模型）→ 落消息 → 读回历史 → 一次工具调用。
//      为什么这条能证明"调用点真的迁到了接口"：MySQL 不可达的情况下，数据**只可能**落到那份 JSON 文件里
//      （`rw-store.json` 里出现账号/会话/消息 ⇒ 这些写入必然经过存储接口，别无第二条路）。
//   ② **机制断言（运行时·记账假实现）**：`test/storage-recorder-shell.mjs` 预载后把接口对象逐方法包一层，
//      每一次调用记一行再原样转发。判据是"**链上的每一段都留下了经过接口的痕迹**"——
//      "跑得通"本身证明不了这句（一半留在原地也照样跑得通：写走接口、读还在 SQL，或者反过来）。
//   ③ **机制断言（源码级）**：这条链上不许再有直连 SQL 的写入/读取——`server/auth.js` / `server/index.js`
//      里 `db.query('… messages/conversations/accounts/sessions/settings …')` 一律判红。
//      为什么源码级这一半也要有：① 只证明"今天这条路跑得通"，③ 拦住"下次顺手加回一条 SQL"。
//   ④ **重启后读回**：杀掉进程、换端口重起，复用**重启前那个 token** 读同一会话同一批消息。
//      没有这一条，前面几条全在同一个进程里跑完——"落在 JSON 文件而不是内存里"这句话没被区分开。
//
// 纪律：不连真库、不真调模型（`test/offline-model-shell.mjs` 预载：官方 test-hook 换掉模型实现 +
//       fetch 闸门拦截一切非本机请求）；一次性目录（os.tmpdir 下），跑完删掉。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHELL = pathToFileURL(path.join(ROOT, 'test', 'offline-model-shell.mjs')).href;
// 记账假存储：与离线壳同一用法（`--import` 预载），只多观测、不改语义（见 test/storage-recorder-shell.mjs）
const RECORDER = pathToFileURL(path.join(ROOT, 'test', 'storage-recorder-shell.mjs')).href;

const ADMIN = { user: 'gw-fixture-admin', pass: 'gw-fixture-pass' };
let WS = null;         // 一次性工作区
let child = null;      // 真服务子进程
let BASE = null;
let SHELL_LOG = null;  // 离线壳的观测文件（每次模型调用收到的上下文）
let CALL_LOG = null;   // 记账假存储的日志（每次接口调用一行）
let TOKEN = null;      // 链上签发的 token（重启那条用例要复用它，才能证明会话落在介质里）

/** 取一个空闲端口：先 listen(0) 问系统要一个，再关掉（同仓既有夹具同款做法）。 */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};
const H = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) });

/**
 * 起一个真服务子进程，等它**真的在听**再返回（就绪判据＝启动日志那一行，不是 sleep 猜的时长）。
 * 抽成函数是因为"重启后读回"那条用例要重起一次，且**换一个端口**——就绪判据必须两份完全一样。
 * 环境里那三样就是"干净机器"的定义：换实现（jsonfile）、MySQL 指向没人监听的端口、数据只落一次性目录。
 */
async function startServer() {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const c = spawn(process.execPath, ['--import', SHELL, '--import', RECORDER, path.join('server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RW_STORAGE: 'jsonfile',           // ← 本夹具的主角：换实现
      DB_PORT: '1',                     // ← MySQL 指向没人监听的端口（"干净机器"的定义）
      RW_WORKSPACE: WS,                 // ← 数据只许落在这次性目录里
      RW_OFFLINE_SHELL_LOG: SHELL_LOG,  // ← 观测量：每轮真正送进模型的上下文
      RW_STORAGE_CALL_LOG: CALL_LOG,    // ← 观测量：每次经过存储接口的调用（记账假实现）
      PORT: String(port),
      RW_ADMIN_USER: ADMIN.user,
      RW_ADMIN_PASS: ADMIN.pass,
      RW_WECHAT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (d) => { out += String(d); });
  c.stderr.on('data', (d) => { out += String(d); });
  c.__log = () => out;
  // 等它真的在听（就绪判据＝启动日志那一行，不是 sleep 猜的时长）
  const t0 = Date.now();
  while (!/\[RW\] Roni Workbench 启动: http:\/\/localhost:\d+/.test(out)) {
    if (c.exitCode !== null) throw new Error('服务子进程提前退出（code=' + c.exitCode + '）：\n' + out);
    if (Date.now() - t0 > 60000) throw new Error('等服务启动超时（60s）：\n' + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  BASE = base;
  return c;
}

/** 停掉当前服务并**等它真的退出**（不等就可能出现"两个进程同时写那一个 JSON 文件"的假象）。 */
async function stopServer() {
  const c = child;
  if (!c || c.exitCode !== null) return;
  const exited = new Promise((r) => c.once('exit', r));
  try { c.kill(); } catch { /* ignore */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
}

before(async () => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-gw-chain-'));
  SHELL_LOG = path.join(WS, 'offline-shell-calls.jsonl');
  CALL_LOG = path.join(WS, 'storage-calls.log');
  child = await startServer();
});

after(() => {
  try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
  try { if (WS) fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[jsonfile] 启动日志如实说明"跳过 MySQL 建表/迁移"（不假装连上了库）', () => {
  assert.match(child.__log(), /存储实现=jsonfile：跳过 MySQL 建表\/迁移/, '启动时必须如实报出用的哪个实现、跳过了什么');
});

test('[jsonfile] 登录 → 会话 → 一轮（含工具调用）→ 落消息 → 读回历史，全链在"没有 MySQL"下跑通', async () => {
  // ① 登录
  const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
  assert.equal(login.status, 200, '登录要成功（账号存在 jsonfile 存储里）：' + JSON.stringify(login.body));
  assert.ok(login.body.token, '登录要发 token');
  const token = login.body.token;
  TOKEN = token;   // 重启那条用例要复用这一个 token（能复用 ⇒ sessions 真在介质里）

  // ② token 真的能换回身份
  const me = await j('/api/auth/me', { headers: H(token) });
  assert.equal(me.body.user && me.body.user.username, ADMIN.user);

  // ③ 建会话
  const conv = await j('/api/conversations', { method: 'POST', headers: H(token), body: JSON.stringify({ title: 'G1 夹具会话', permission: 'read' }) });
  assert.equal(conv.status, 200, '建会话要成功：' + JSON.stringify(conv.body));
  const cid = conv.body.id;
  assert.ok(cid > 0);

  // ④ 会话列表（读也走接口）
  const list = await j('/api/conversations', { headers: H(token) });
  assert.deepEqual(list.body.conversations.map((c) => c.id), [cid], '刚建的会话必须在列表里');
  // 对外字段名不许因为换了存储实现而变（前端 web/dist 读的是这些蛇形键）
  for (const k of ['shell_key', 'shell_name', 'created_at', 'updated_at']) {
    assert.ok(k in list.body.conversations[0], '会话列表的对外字段 ' + k + ' 丢了（换了实现就改对外形状＝破坏契约）');
  }

  // ⑤ 发一轮：离线壳第一轮会**真调一次工具**（list_dir），第二轮出正文
  const chat = await j('/api/chat', { method: 'POST', headers: H(token), body: JSON.stringify({ conversationId: cid, content: '列一下当前工作区根目录' }) });
  assert.equal(chat.status, 200, '一轮对话要能跑（不是 500）');
  const sse = String(chat.body);
  assert.match(sse, /"type":"tool_start"[^\n]*"name":"list_dir"/, '这一轮必须真发起一次工具调用');
  assert.match(sse, /"type":"tool_done"[^\n]*"name":"list_dir"[^\n]*"status":"done"/, '工具必须真执行成功');
  assert.match(sse, /"type":"run_end"[^\n]*"status":"saved"/, '本轮要以"已落库"收尾');
  assert.ok(!/ECONNREFUSED/.test(sse), '这一轮里不许出现"连不上库"的错误帧：' + sse.slice(0, 400));

  // ⑥ 读回历史（用户消息 + 助手消息，都来自 jsonfile）
  const msgs = await j('/api/conversations/' + cid + '/messages', { headers: H(token) });
  assert.deepEqual(msgs.body.messages.map((m) => m.role), ['user', 'assistant'], '读回的历史必须是"用户 + 助手"两条');
  assert.equal(msgs.body.messages[0].content, '列一下当前工作区根目录');
  assert.match(msgs.body.messages[1].content, /离线壳回复/, '助手那條要是本轮真落的');
  for (const k of ['reasoning', 'model', 'provider', 'created_at']) {
    assert.ok(k in msgs.body.messages[0], '/messages 的对外字段 ' + k + ' 丢了');
  }

  // ⑦ 工具调用账：**写口也迁到接口之后**（2026-09-17），这一轮真执行过的 list_dir 必须在账上，
  // 而且形状与 mysql 链路上**逐字段相同**（`args` 是对象——真库 8583 行 JSON_TYPE 全是 OBJECT，
  // 见交付报告 ②；`result_summary` 是字符串——TEXT 列）。只断言"数组"是不够的：账上一条都没有时
  // 它也满足"是个数组"，那正是"读侧迁了、写侧没迁"能瞒过去的原因。
  const ledger = await j('/api/conversations/' + cid + '/toolcalls', { headers: H(token) });
  assert.equal(ledger.status, 200, '工具调用账的读口必须读得动：' + JSON.stringify(ledger.body));
  assert.ok(Array.isArray(ledger.body.toolcalls), '/toolcalls 要回一个数组');
  assert.equal(ledger.body.toolcalls.length, 1, '本轮真执行过一次工具 ⇒ 账上必须有且只有一行：' + JSON.stringify(ledger.body));
  const row = ledger.body.toolcalls[0];
  assert.equal(row.tool_name, 'list_dir', '账上那行要是本轮真执行的那个工具');
  assert.equal(row.status, 'done', '执行成功 ⇒ status=done（失败会落 fail）');
  assert.equal(typeof row.args, 'object', 'args 必须是**对象**（与 mysql 链路同形；写成 JSON 字符串就是换了实现换形状）');
  // 参数值本身不做逐字断言：`tool_calls.args` 记的是**实际执行**的参数，而平台的 before 钩子会把相对路径
  // 归一成工作区绝对路径（本仓既有口径，见 tools/index.js 的 argsChanged/"参数经平台归一"）。所以只钉形状与键名。
  assert.equal(typeof row.args.path, 'string', 'args 里要能看见本轮那个 path 参数');
  assert.equal(typeof row.result_summary, 'string', 'result_summary 是 TEXT 列 ⇒ 字符串（不是对象）');
  assert.ok(row.message_id > 0, '这一行要认领到那条 assistant 消息（attachToMessage 的回填）');
  assert.ok(typeof row.created_at === 'string' && row.created_at.length > 0, 'created_at 由介质给');
});

test('[jsonfile] 第二轮（同一会话）的上下文里必须出现第一轮那两条消息——历史真的从存储里读回来', async () => {
  // 这一条盯的是**半迁移**那个坑：写入走了存储、读取却还在原地 ⇒ 上下文看不到历史（对话"失忆"）。
  // 观测点在离线壳里（`RW_OFFLINE_SHELL_LOG`）：它记下每次模型调用**真正收到**的上下文。
  const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
  const token = login.body.token;
  const chat = await j('/api/chat', { method: 'POST', headers: H(token), body: JSON.stringify({ conversationId: 1, content: '第二轮：再看一次目录' }) });
  assert.equal(chat.status, 200);
  assert.match(String(chat.body), /"type":"run_end"[^\n]*"status":"saved"/, '第二轮也要正常落库收尾');

  const calls = fs.readFileSync(SHELL_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const second = calls[calls.length - 1];
  const flat = second.history.map((m) => m.role + ':' + m.content).join(' | ');
  assert.ok(second.history.length >= 3, '第二轮送进模型的上下文至少要有"前两条 + 本轮用户消息"，实际：' + flat);
  assert.match(flat, /user:列一下当前工作区根目录/, '第一轮的用户消息必须在第二轮的上下文里（否则就是"看不到历史"）');
  assert.match(flat, /assistant:（离线壳回复）/, '第一轮的助手消息必须在第二轮的上下文里');
  assert.match(flat, /user:第二轮：再看一次目录/, '本轮的用户消息也要在');
});

test('[jsonfile] 数据落在这次性目录的那份 JSON 文件里（MySQL 不可达 ⇒ 只可能经过存储接口）', () => {
  const file = path.join(WS, 'storage', 'rw-store.json');
  assert.ok(fs.existsSync(file), '存储文件必须落在 RW_WORKSPACE 下：' + file);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.format, 'rw-store-json');
  assert.equal(doc.version, 1);
  const rows = (t) => Object.values(doc.tables[t] || {});
  assert.equal(rows('accounts').length, 1, '账号要在文件里（否则重启后没人登得进来）');
  assert.equal(rows('accounts')[0].username, ADMIN.user);
  assert.ok(rows('sessions').length >= 1, '登录签发的 token 要在文件里');
  assert.equal(rows('conversations').length, 1);
  assert.equal(rows('conversations')[0].title, 'G1 夹具会话');
  // 消息：条数随"跑了几轮"变（本文件里跑了两轮），所以这里断言**形状与归属**而不是写死条数
  const msgs = rows('messages');
  assert.ok(msgs.length >= 2, '至少要有一轮的用户消息与助手消息落在文件里');
  assert.equal(new Set(msgs.map((m) => m.conversationId)).size, 1, '消息只该属于那个会话');
  const roles = msgs.sort((a, b) => a.id - b.id).map((m) => m.role);
  assert.deepEqual(roles, roles.map((_, i) => (i % 2 === 0 ? 'user' : 'assistant')), '消息应当 user/assistant 交替（实际 ' + roles.join(',') + '）');
  for (const m of msgs) assert.ok(String(m.content || '').length > 0, '每条消息都要有正文');
});

test('机制断言：这条链上不许再有直连 SQL（换了实现才可能真的没有 MySQL）', () => {
  // 链上归属的表（登录/会话/消息/历史/设置/工具账）：命中即判红。
  const TABLES = 'conversations|messages|accounts|sessions|settings|tool_calls';
  const re = new RegExp("(?:db\\.(?:query|run|one)|pool\\.(?:query|execute))\\s*\\(\\s*[`'\"][^`'\"]*\\b(?:" + TABLES + ")\\b", 'gi');
  const hitsOf = (f) => [...read(f).matchAll(re)].map((m) => m[0].replace(/\s+/g, ' '));

  // 链上的模块：一处都不许剩（登录链本来就是一整条，剩半截等于换实现时半途炸）
  for (const f of ['server/auth.js', 'server/autotitle.js']) {
    assert.deepEqual(hitsOf(f), [], f + ' 里还有直连 SQL 打在链上那几张表上（应走 storage.* 接口）');
  }

  // index.js：**已登记的遗留**（不在存储接口范围内，见 proposals/架构文档冲突登记-20260915.md 的 C-61）。
  // 判据是**只减不增**：这里断言的是"没有新的直连 SQL"，遗留项照实列出、不假装它们不存在；
  // 将来谁把它们也迁了，本用例照样绿（子集判定），谁新加一条直连 SQL 则当场判红。
  const KNOWN_LEFTOVERS = [
    "db.query('INSERT INTO conversations",     // 技能冒烟建临时会话（整段是 MySQL 形状的诊断流程）
    "db.query('DELETE FROM conversations",     // 同上：冒烟收尾
    'db.query(\'SELECT id, tool_name, status, duration_ms, created_at FROM tool_calls',  // /trace 视图（同路由还要读 audit_log）
    'db.query("SELECT id FROM accounts',       // 启动时 kb 巡检任务种子（admin 账号查询）
  ];
  const KEEP_IMPLICIT = [/model_telemetry/, /COUNT\(\*\) steps FROM tool_calls/]; // 观测表 / 用量统计（同路由必读 usage_stats）
  const unknown = hitsOf('server/index.js').filter(
    (h) => !KNOWN_LEFTOVERS.some((k) => h.startsWith(k)) && !KEEP_IMPLICIT.some((k) => k.test(h)));
  assert.deepEqual(unknown, [], 'server/index.js 新增了链上直连 SQL（要么走接口，要么登记进 C-61）：' + unknown.join(' | '));

  // 正面判据：链上确实在调接口（否则"没直连 SQL"可以靠"什么都不做"满足）
  assert.match(read('server/auth.js'), /storage\.accounts\.findByUsername|storage\.sessions\.create/, 'auth.js 必须走存储接口');
  const idx = read('server/index.js');
  assert.match(idx, /storage\.messages\.(?:append|history|guardAppend|list)/, 'index.js 的消息读写必须走存储接口');
  assert.match(idx, /storage\.settings\.(?:get|all|getMany)/, 'index.js 的设置读取必须走存储接口');
  assert.match(idx, /storage\.conversations\.(?:get|getAs|findOwned|create|listByAccount)/, 'index.js 的会话读写必须走存储接口');
});

test('机制断言②：这条链的每一段都真的经过存储接口（记账假实现全程记录，不是读源码猜）', () => {
  // 为什么"跑得通"不够：一半留在原地也照样跑得通（写走接口、读还在 SQL，或者反过来）——
  // 上一轮的"半迁移"就是这么发生的。这里的观测点在**接口对象本身**：预载把每个方法包一层再转发，
  // 于是"这段到底走没走接口"变成一条可数的事实。预载若失效，本用例会因缺少 `#recorder` 自述行而判红
  // （不能让它变成恒绿的摆设）。
  const raw = fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n');
  const headers = raw.filter((l) => l.startsWith('#recorder'));
  assert.ok(headers.length >= 1, '记账假实现没生效（--import 预载失败？）——本用例会因此变成恒绿，必须判红');
  assert.match(headers[0], /^#recorder 已包 \d+ 个接口方法（实现=jsonfile）$/, '记账壳自述行不对：' + headers[0]);
  const calls = raw.filter((l) => !l.startsWith('#'));
  const names = new Set(calls.map((l) => l.split(' ')[0]));
  const has = (n) => names.has(n);

  // ① 链上每一段都必须留下"经过接口"的痕迹：缺哪一段，就是哪一段还留在原地。
  const REQUIRED = {
    '登录读账号': 'accounts.findByUsername',
    '登录签发会话': 'sessions.create',
    '每次请求校验会话': 'sessions.findValid',
    '建会话': 'conversations.create',
    '会话列表（按账号读）': 'conversations.listByAccount',
    '会话读回（含只读列子集）': 'conversations.getAs',
    '落用户消息': 'messages.append',
    '落助手消息（孤儿守卫那条）': 'messages.guardAppend',
    '读回历史（上下文口径）': 'messages.history',
    '读回历史（接口口径）': 'messages.list',
    '设置读取': 'settings.get',
    '设置批量读取': 'settings.getMany',
    '事件账本': 'events.append',
    '工具调用账（读）': 'toolCalls.recent',
    '工具调用账（写）': 'toolCalls.append',   // 2026-09-17 从"登记缺口"变成"已迁移"：写口也走接口了
  };
  for (const [what, name] of Object.entries(REQUIRED)) {
    assert.ok(has(name), what + ' 没有经过存储接口（期望 ' + name + '）。实际记录：' + [...names].sort().join(', '));
  }

  // ② "介质里落了行"必须与"接口上发生了写"对得上：文件里有行、接口却没被调用过，只能是绕过接口写进去的。
  const doc = JSON.parse(fs.readFileSync(path.join(WS, 'storage', 'rw-store.json'), 'utf8'));
  const rows = (t) => Object.values(doc.tables[t] || {});
  const WRITES = {
    accounts: ['create'], sessions: ['create'], conversations: ['create'], messages: ['append', 'guardAppend'],
    events: ['append'], settings: ['set'], agentRuns: ['create', 'update'], deliveries: ['insert'], toolCalls: ['append'],
  };
  const unpaired = Object.entries(WRITES)
    .filter(([t, verbs]) => rows(t).length && !verbs.some((v) => has(t + '.' + v)))
    .map(([t]) => t);
  assert.deepEqual(unpaired, [], '这些实体在介质里有行，接口上却没有对应的写调用（＝绕过接口写的）：' + unpaired.join(', '));

  // ③ 反向的缺口：**事实已经发生、账上却没有行**的那一类。这一轮真的执行过一次工具（事件账里有 tool_done），
  //    所以介质里必须有 toolCalls 行、接口上必须有 toolCalls.append。2026-09-17 之前这里登记着
  //    `KNOWN_UNPAIRED = ['toolCalls']`（写入口在 `server/tools/index.js:1859` 直连 MySQL，见 proposals 的 C-61；
  //    没有 MySQL 时每次工具调用都打一条 `[tool-audit] 留痕失败（工具已执行，但账本缺行）`）。
  //    **补上了就必须从名单里删掉**（登记项的意义是"还差什么"，不是"允许差什么"）——
  //    所以现在这条是**正面判据**：没有行、或没有接口调用，都判红。
  assert.ok(rows('events').some((e) => e.type === 'tool_done'), '这一轮的事件账里应当有 tool_done（前面用例已断言工具真执行成功）');
  const gaps = [];
  if (!rows('toolCalls').length) gaps.push('toolCalls 介质里 0 行');
  if (!has('toolCalls.append')) gaps.push('toolCalls.append 没被调用过');
  assert.deepEqual(gaps, [], '这一轮工具真执行过，账上却没有行/没经过接口（不允许再出现这类缺口）：' + gaps.join('；'));
  // 行数也要对得上：本轮只执行一次工具 ⇒ 恰好一行（多行＝重复记账，那同样是账本不可信）
  assert.equal(rows('toolCalls').length, 1, '本轮执行过一次工具 ⇒ 介质里恰好一行：' + rows('toolCalls').length);
  assert.equal(rows('toolCalls')[0].toolName, 'list_dir');
  assert.equal(typeof rows('toolCalls')[0].args, 'object', '落在文件里的 args 也是对象（与 /toolcalls 读到的一致）');
});

test('[jsonfile] 重启进程后：同一个 token 仍认得出人、同一会话与消息读得回来（数据在文件里，不在内存里）', async () => {
  // 没有这一条，前面几条全在**同一个进程**里跑完 —— "落在 JSON 文件而不是内存"这句话根本没被区分开。
  // 复用**重启前那个 token**：它还能用 ⇒ sessions 真在介质里；会话与消息一字不差 ⇒ 它们是读回来的。
  assert.ok(TOKEN, '前一条用例要先跑过（本用例复用链上签发的 token）');
  const before = await j('/api/conversations/1/messages', { headers: H(TOKEN) });
  assert.equal(before.status, 200);

  await stopServer();
  child = await startServer();   // ← 换一个端口重起（就绪判据仍是启动日志那一行）

  const me = await j('/api/auth/me', { headers: H(TOKEN) });
  assert.equal(me.status, 200, '重启后旧 token 必须仍然有效（否则会话只在内存里）：' + JSON.stringify(me.body));
  assert.equal(me.body.user.username, ADMIN.user);

  const after = await j('/api/conversations/1/messages', { headers: H(TOKEN) });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.messages, before.body.messages, '重启前后读到的同一会话消息必须逐字一致');

  // 重启后再发一轮：送进模型的上下文里必须有**重启前**那两条（历史真的从介质读回来）
  const chat = await j('/api/chat', { method: 'POST', headers: H(TOKEN), body: JSON.stringify({ conversationId: 1, content: '重启之后再看一次目录' }) });
  assert.equal(chat.status, 200);
  assert.match(String(chat.body), /"type":"run_end"[^\n]*"status":"saved"/, '重启后的这一轮也要正常落库收尾');
  const calls = fs.readFileSync(SHELL_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = calls[calls.length - 1];
  const flat = last.history.map((m) => m.role + ':' + m.content).join(' | ');
  assert.match(flat, /user:列一下当前工作区根目录/, '重启前的用户消息必须出现在重启后的上下文里（历史来自介质，不是内存残留）：' + flat);
  assert.match(flat, /assistant:（离线壳回复）/, '重启前的助手消息也要在');
  assert.match(flat, /user:重启之后再看一次目录/, '本轮的用户消息也要在');
});
