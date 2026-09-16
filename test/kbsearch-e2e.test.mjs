// test/kbsearch-e2e.test.mjs —— **干净机器上 `kb_search` 真的能返回结果**（G1 收口 2026-09-17 的端到端那一半）
//
// 为什么单独一份：`test/kbsearch-js.test.mjs` 钉的是检索后端本身（纯函数 + 假介质），
// 而"没有 MySQL 的机器上 `kb_search` 能返回结果、且 `mode` 如实"这句判据是**整条链**的事：
//   起真服务（`RW_STORAGE=jsonfile` + `DB_PORT` 指向没人监听的端口 + 一次性工作区）
//   → 真登录/建会话 → 发一轮（离线壳真发起 `kb_search`）→ 看工具结果帧里有什么。
//
// 判据：
//   ① `RW_KB_SEARCH=like` 时：`kb_search` **返回结果**（不是空数组、不是失败帧），`mode` 如实报 `like`；
//   ② 可见范围仍由 `kbVisibleWhere` 判：别的账号、别的会话、superseded 的条目都搜不出来（换了实现没换口径）；
//   ③ 工具账上留下了这次调用（Gap A 的落盘在这一轮里也是真的）；
//   ④ 反向：**默认（不显式选 like）时不会悄悄用 like** —— 缺 MySQL 时 fts 如实抛错、`kb_search` 返回失败，
//      而不是"看起来搜了、其实是另一条路"（§4.6 禁止静默降级）。
//
// 纪律：不连真库、不真调模型（`test/kbsearch-shell.mjs` 预载：官方 test-hook 换掉模型实现 + fetch 闸门）；
//       一次性目录（os.tmpdir 下），跑完删掉。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = pathToFileURL(path.join(ROOT, 'test', 'kbsearch-shell.mjs')).href;
const ADMIN = { user: 'kb-fixture-admin', pass: 'kb-fixture-pass' };
const ACCOUNT_OTHER = 99;              // 另一个账号的条目（同一次运行里不存在这个账号，纯反向判据）
const CONV_OTHER = 4242;               // 别的会话的私有条目

let WS = null;
let child = null;
let BASE = null;
let SHELL_LOG = null;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, raw: text };
};
const H = (t) => ({ 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) });

/** SSE 原文 → 帧对象数组（只取 data: 行；`: ping` 这类注释帧忽略） */
function framesOf(text) {
  return String(text).split('\n\n').map((part) => {
    const line = part.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return null;
    try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
}

async function startServer({ kbSearch = 'like' } = {}) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const c = spawn(process.execPath, ['--import', SHELL, path.join('server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RW_STORAGE: 'jsonfile',           // 干净机器的定义之一：换实现
      DB_PORT: '1',                     // 干净机器的定义之二：MySQL 指向没人监听的端口
      RW_WORKSPACE: WS,                 // 数据只许落在这次性目录里
      RW_KB_SEARCH: kbSearch,           // ← 本夹具的主角：显式选第二个检索实现
      RW_OFFLINE_SHELL_LOG: SHELL_LOG,
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
  const t0 = Date.now();
  while (!/\[RW\] Roni Workbench 启动: http:\/\/localhost:\d+/.test(out)) {
    if (c.exitCode !== null) throw new Error('服务子进程提前退出（code=' + c.exitCode + '）：\n' + out);
    if (Date.now() - t0 > 60000) throw new Error('等服务启动超时（60s）：\n' + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  BASE = base;
  return c;
}

async function stopServer() {
  const c = child;
  if (!c || c.exitCode !== null) return;
  const exited = new Promise((r) => c.once('exit', r));
  try { c.kill(); } catch { /* ignore */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
}

/** 把一批知识条目放进 jsonfile 存储（本实现只读 knowledge，写入路径不在本轮范围 —— 见交付报告 ⑥）。 */
function seedKnowledge(convId) {
  const file = path.join(WS, 'storage', 'rw-store.json');
  assert.ok(fs.existsSync(file), '服务跑过一轮后存储文件必须在：' + file);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [
    { id: 1, accountId: 1, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '部署口径', body: '蓝绿部署：先切 10% 流量观察 30 分钟', status: 'active', createdAt: '2026-09-16 00:00:00' },
    { id: 2, accountId: 1, scope: 'conv', conversationId: convId, shellId: null, kind: 'guide', title: '本会话经验', body: '部署口径要跟着变更单走', status: 'active', createdAt: '2026-09-16 00:00:00' },
    { id: 3, accountId: 1, scope: 'conv', conversationId: CONV_OTHER, shellId: null, kind: 'guide', title: '别的会话私有', body: '部署口径（不该被搜出来）', status: 'active', createdAt: '2026-09-16 00:00:00' },
    { id: 4, accountId: 1, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '已被取代', body: '部署口径（旧）', status: 'superseded', createdAt: '2026-09-16 00:00:00' },
    { id: 5, accountId: ACCOUNT_OTHER, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '别人的账号', body: '部署口径', status: 'active', createdAt: '2026-09-16 00:00:00' },
  ];
  doc.tables.knowledge = Object.fromEntries(rows.map((r) => [String(r.id), r]));
  doc.counters = { ...(doc.counters || {}), knowledge: rows.length };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return rows;
}

before(async () => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-kb-e2e-'));
  SHELL_LOG = path.join(WS, 'kb-shell-calls.jsonl');
  child = await startServer({ kbSearch: 'like' });
});

after(() => {
  try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
  try { if (WS) fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[like] 干净机器上 `kb_search` 真的返回结果：mode 如实报 like、可见范围仍由 kbVisibleWhere 判', async () => {
  // ① 登录（账号也落在 jsonfile 里 —— 没有 MySQL）
  const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
  assert.equal(login.status, 200, '登录要成功：' + JSON.stringify(login.body));
  const token = login.body.token;

  // ② 建会话 → 拿到会话 id（也就是 knowledge 的 conv 归属）
  const conv = await j('/api/conversations', { method: 'POST', headers: H(token), body: JSON.stringify({ title: 'kb like 夹具会话', permission: 'read' }) });
  assert.equal(conv.status, 200, '建会话要成功：' + JSON.stringify(conv.body));
  const cid = conv.body.id;

  // ③ 铺知识条目（先跑一轮让存储文件建出来），再重启服务让它**从介质**读回来
  seedKnowledge(cid);
  await stopServer();
  child = await startServer({ kbSearch: 'like' });

  // ④ 发一轮：离线壳会真发起一次 kb_search
  const chat = await j('/api/chat', { method: 'POST', headers: H(token), body: JSON.stringify({ conversationId: cid, content: '搜一下知识库：部署口径是怎么约定的？' }) });
  assert.equal(chat.status, 200, '这一轮要能跑（不是 500）：' + String(chat.body).slice(0, 300));
  const frames = framesOf(chat.body);
  const start = frames.find((f) => f.type === 'tool_start' && f.tool && f.tool.name === 'kb_search');
  assert.ok(start, '这一轮必须真发起一次 kb_search（否则这条判据什么都没验）：' + String(chat.body).slice(0, 400));
  const done = frames.find((f) => f.type === 'tool_done' && f.tool && f.tool.name === 'kb_search');
  assert.ok(done, 'kb_search 必须有一个 tool_done 帧');
  assert.equal(done.tool.status, 'done', '干净机器上 kb_search **不许失败**（这就是本轮补的缺口）：' + JSON.stringify(done.tool).slice(0, 400));

  // ⑤ 结果本体：items 非空、mode 如实、命中的正是可见范围内那两条
  const out = typeof done.tool.result === 'string' ? JSON.parse(done.tool.result) : done.tool.result;
  assert.ok(out && Array.isArray(out.items), '工具结果里要有 items 数组：' + JSON.stringify(out).slice(0, 300));
  assert.ok(out.items.length > 0, '**干净机器上 kb_search 必须返回结果**（缺口 B 的判据）：' + JSON.stringify(out));
  assert.equal(out.mode, 'like', 'mode 必须如实报 like（纯 JS 子串匹配），不许假装 fts');
  assert.equal(out.backend, 'like', 'backend 要报出用的是哪个实现');
  assert.deepEqual(out.items.map((x) => x.id).sort((a, b) => a - b), [1, 2], '可见范围内命中的是 global(1) 与本会话 conv(2)');
  assert.equal(out.items[0].title.length > 0, true);
  for (const id of [3, 4, 5]) {
    assert.ok(!out.items.some((x) => x.id === id), 'id=' + id + '（别的会话/已被取代/别的账号）不许被搜出来');
  }

  // ⑥ 反向：这一轮的审计缺行**不再**出现（Gap A：写口已迁；audit_log 不是存储接口的一部分，如实降级）
  const log = child.__log();
  assert.ok(!/\[tool-audit\] 留痕失败（工具已执行，但账本缺行）/.test(log),
    '工具账的写口已经迁到存储接口了，不该再出现"账本缺行"：' + log.slice(-1200));

  // ⑦ 工具账上真的留下了这次调用（落盘可查）
  const ledger = await j('/api/conversations/' + cid + '/toolcalls', { headers: H(token) });
  assert.equal(ledger.status, 200);
  const row = (ledger.body.toolcalls || []).find((t) => t.tool_name === 'kb_search');
  assert.ok(row, '工具账里要有这次 kb_search：' + JSON.stringify(ledger.body).slice(0, 300));
  assert.equal(typeof row.args, 'object', 'args 是对象（与 mysql 链路同形）');
  assert.equal(typeof row.result_summary, 'string', 'result_summary 是字符串（TEXT 列）');
});

test('[反向] 没显式选 like 时不会悄悄用它：缺 MySQL 的机器上 fts 如实报错，而不是"看着像搜了"', async () => {
  // 这一条盯的是"禁止静默降级"：`fts` 连不上库时必须**如实抛**，不许自己退回子串匹配假装成功。
  const prev = child;
  await stopServer();
  child = await startServer({ kbSearch: 'fts' });
  try {
    const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
    assert.equal(login.status, 200, '换后端不影响登录：' + JSON.stringify(login.body));
    const token = login.body.token;
    const conv = await j('/api/conversations', { method: 'POST', headers: H(token), body: JSON.stringify({ title: 'fts 反向夹具', permission: 'read' }) });
    const cid = conv.body.id;
    // 第二轮起才有会话；这里直接用同一个会话发一轮（壳的一次性闸门在**新进程**里已重置）
    const chat = await j('/api/chat', { method: 'POST', headers: H(token), body: JSON.stringify({ conversationId: cid, content: '搜一下知识库：部署口径是怎么约定的？' }) });
    assert.equal(chat.status, 200);
    const frames = framesOf(chat.body);
    const done = frames.find((f) => f.type === 'tool_done' && f.tool && f.tool.name === 'kb_search');
    assert.ok(done, '这一轮同样真发起了 kb_search：' + String(chat.body).slice(0, 300));
    assert.equal(done.tool.status, 'fail', '没有 MySQL 时 fts **必须如实失败**（不许悄悄换成另一条路）：' + JSON.stringify(done.tool).slice(0, 300));
    // 帧里的 result 是**给人看的文本**（`错误: …`），不是 JSON —— 所以这里按文本断言，
    // 失败码另外从 `tool.code` 取（统一失败分类那条口径，前端也这么读）
    const txt = String(done.tool.result);
    assert.match(txt, /错误:/, '失败要带可读原因：' + txt.slice(0, 300));
    assert.match(txt, /ECONNREFUSED|connect|连不上|ETIMEDOUT/i,
      '失败原因要指向"连不上库"（而不是别的什么错）：' + txt.slice(0, 300));
    assert.ok(!/"?mode"?\s*[:=]\s*"?like/.test(txt), '失败路径不许返回 mode:like（那就成了静默回落）');
  } finally {
    await stopServer();
    child = prev && prev.exitCode === null ? prev : null;
  }
});
