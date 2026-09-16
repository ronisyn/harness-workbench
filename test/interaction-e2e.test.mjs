// test/interaction-e2e.test.mjs —— v0.3 §4.7 交互契约接线批的**真服务那一半**（2026-09-17）
//
// 纯函数那一半在 test/interaction-frames.test.mjs；本文件走**真 HTTP + 真 SSE**：起一个真服务
// （`test/interaction-shell.mjs` 预载：官方 test-hook 换掉模型实现 + fetch 闸门拦截一切非本机请求），
// 走真 API 跑几轮对话，直接看**帧**长什么样。
//
// 纪律（与 test/storage-chain.test.mjs 同一套）：
//   · 不连真库：`RW_STORAGE=jsonfile` + `DB_PORT` 指向没人监听的端口 + `RW_WORKSPACE` 是一次性目录；
//   · 不真调模型：离线壳的 fetch 闸门会把任何非本机请求当场拒掉（日志里看得到它拦过 epoch 预热那条）。
//
// 五件事各自的机检：
//   ① 溢出对客户端可见（§2.5 第 4/5 条）：`tool_done.tool.spill` 只增带出，路径真能取回；
//      反向：**没发生省略的轮次不许有这个字段**；
//   ② 进度帧（§4.7 可观测）：`progress` 帧给出第几轮 / 上限（既有 settings.round_cap）/ 计划第几步；
//   ③ 续订缺口（§4.7 可控制）：`stream_hello` 如实报 gap + earliestSeq（起点早于环内最早一条才算缺口）；
//   ④ 决策3 接线（§4.3 受限自动沉淀）：会话收尾那一刻产出**待审卡片**（ask 帧 + 队列里查得到）；
//      反向：没有够格候选的会话**一张卡都不许建**。
//   （决策1 的页面标记接线（§4.4.1 规则4）不在本文件：`GET /api/cache-hit/summary` 要查真 MySQL 的
//     usage_stats/audit_log，本文件刻意不连真库 ⇒ 那一件在 test/metric-alerts-wiring.test.mjs，
//     它用**只读的假 db** 给读数，把"读数 → 越线 → 页面字段"整条链验证掉。）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = pathToFileURL(path.join(ROOT, 'test', 'interaction-shell.mjs')).href;
const ADMIN = { user: 'it-fixture-admin', pass: 'it-fixture-pass' };

let WS = null;        // 一次性工作区
let child = null;     // 真服务子进程
let BASE = null;
let TOKEN = null;

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

const newConv = async (title, permission = 'read') => {
  const r = await j('/api/conversations', { method: 'POST', headers: H(TOKEN), body: JSON.stringify({ title, permission }) });
  assert.equal(r.status, 200, '建会话要成功：' + JSON.stringify(r.body));
  return r.body.id;
};
const chat = async (cid, content) => {
  const r = await j('/api/chat', { method: 'POST', headers: H(TOKEN), body: JSON.stringify({ conversationId: cid, content }) });
  assert.equal(r.status, 200, '一轮对话要能跑（不是 500）：' + String(r.body).slice(0, 300));
  const frames = framesOf(r.body);
  assert.ok(frames.some((f) => f.type === 'run_end' && f.status === 'saved'), '本轮要以"已落库"收尾：' + frames.map((f) => f.type).join(','));
  return frames;
};

/** 读续订流的前若干帧（读到 stream_end 或超时就断开）：只需要 stream_hello，不必跟播到底 */
async function helloFrame(cid, lastEventId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(BASE + '/api/conversations/' + cid + '/stream', {
      headers: { ...H(TOKEN), ...(lastEventId == null ? {} : { 'Last-Event-ID': String(lastEventId) }) },
      signal: ac.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('"stream_hello"')) break;   // 第一帧就是它，拿到就够
    }
    ac.abort();
    return framesOf(buf);
  } catch (e) {
    if (e && e.name === 'AbortError') return framesOf('');
    throw e;
  } finally { clearTimeout(timer); }
}

before(async () => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-interaction-e2e-'));
  // 夹具材料：① 30 条长命中行（grep_search 结果 ≈ 7KB ⇒ 必然触发外层溢出）
  //            ② 一个不存在的路径（read_file 必失败 ⇒ 给"失败后成功"那条候选留素材）
  const needle = 'NEEDLE ' + 'x'.repeat(150);
  fs.writeFileSync(path.join(WS, 'needles.txt'), Array.from({ length: 30 }, (_, i) => needle + ' #' + (i + 1)).join('\n') + '\n');
  fs.writeFileSync(path.join(WS, 'small.txt'), 'small file\n');
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--import', SHELL, path.join('server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RW_STORAGE: 'jsonfile',
      DB_PORT: '1',                    // MySQL 指向没人监听的端口（本夹具不碰真库）
      RW_WORKSPACE: WS,
      PORT: String(port),
      RW_ADMIN_USER: ADMIN.user,
      RW_ADMIN_PASS: ADMIN.pass,
      RW_WECHAT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  child.__log = () => out;
  const t0 = Date.now();
  while (!/\[RW\] Roni Workbench 启动: http:\/\/localhost:\d+/.test(out)) {
    if (child.exitCode !== null) throw new Error('服务子进程提前退出（code=' + child.exitCode + '）：\n' + out);
    if (Date.now() - t0 > 60000) throw new Error('等服务启动超时（60s）：\n' + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
  assert.equal(login.status, 200, '登录要成功：' + JSON.stringify(login.body));
  TOKEN = login.body.token;
  assert.ok(TOKEN, '登录要发 token');
});

after(() => {
  try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
  try { if (WS) fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── ① 溢出对客户端可见 ───────────────────────────────────────────────────────────────────────
test('溢出①：大结果那一帧带出 `spill`（路径 + 省略量），路径就是磁盘上那份全文', async () => {
  const cid = await newConv('夹具：大输出');
  const frames = await chat(cid, '【大输出】帮我把这些命中看一下');
  const done = frames.filter((f) => f.type === 'tool_done' && f.tool && f.tool.name === 'grep_search');
  assert.equal(done.length, 1, '这一轮应当恰好跑一次 grep_search：' + frames.map((f) => f.type).join(','));
  const tool = done[0].tool;
  assert.ok(tool.spill, '溢出必须对客户端可见（tool.spill 只增带出）：' + JSON.stringify(tool).slice(0, 300));
  assert.equal(tool.spill.omitted, true);
  assert.equal(tool.spill.kind, 'file', 'grep_search 不是读取类工具 ⇒ 走"落盘 + 取回"那条路');
  assert.ok(tool.spill.omittedBytes > 0, '省略量要如实报出：' + JSON.stringify(tool.spill));
  assert.ok(tool.spill.path && fs.existsSync(tool.spill.path), '路径必须是磁盘上真存在的那份溢出文件：' + tool.spill.path);
  assert.ok(fs.readFileSync(tool.spill.path, 'utf8').includes('NEEDLE'), '溢出文件里是全文（含被省略的中段）');
  assert.ok(tool.spill.returnedBytes < tool.spill.bytes, '进上下文的那一份必须比原始结果小：' + JSON.stringify(tool.spill));
  // 事实与磁盘上的那份全文必须对得上（同一件事不许两个说法）：bytes 量的就是溢出文件的内容
  assert.equal(Buffer.byteLength(fs.readFileSync(tool.spill.path, 'utf8'), 'utf8'), tool.spill.bytes,
    'spill.bytes 必须等于溢出文件里那份全文的字节数');
  // 这一帧同时带着**原始结果**（既有行为，一个字没改）：客户端现在既能看到原文，也能看到"进上下文的那份被省略了多少"
  assert.ok(String(tool.result).length > 0, '既有字段不动：tool.result 仍在帧里');
});

test('溢出②（反向）：没发生省略的轮次**不许**出现 spill 字段（只增、不造假事实）', async () => {
  const cid = await newConv('夹具：小结果');
  const frames = await chat(cid, '【小结果】列一下目录');
  const done = frames.filter((f) => f.type === 'tool_done' && f.tool && f.tool.name === 'list_dir');
  assert.equal(done.length, 1, '这一轮应当恰好跑一次 list_dir');
  assert.equal(Object.prototype.hasOwnProperty.call(done[0].tool, 'spill'), false,
    '没省略就没有这条事实：' + JSON.stringify(done[0].tool).slice(0, 200));
});

// ── ② 进度帧 ────────────────────────────────────────────────────────────────────────────────
test('进度①：每轮一次 progress 帧，轮次与服务端循环同源；上限缺省 ⇒ null（不发明数字）', async () => {
  const cid = await newConv('夹具：进度');
  const frames = await chat(cid, '【小结果】看看目录');
  const prog = frames.filter((f) => f.type === 'progress');
  assert.deepEqual(prog.map((p) => p.round), [1, 2], '两轮就该有两个进度帧，round 从 1 起：' + JSON.stringify(prog));
  for (const p of prog) {
    assert.equal(p.roundCap, null, '人在场的会话里轮次护栏本就不生效（round_cap 只在无人值守档拦人）⇒ 上限如实为 null，不报一个不生效的 2000');
    assert.equal(p.plan, null, '本会话没有计划 ⇒ 计划进度如实为 null');
    assert.equal(p.v, 1, '协议版本随帧下发');
    assert.ok(Number.isFinite(p.seq) && p.seq > 0, '进度帧进事件环 ⇒ 带 seq（可断点续订）');
  }
  // 顺序：每轮先 thinking（agent_thinking 改写）再 progress
  const types = frames.map((f) => f.type);
  assert.ok(types.indexOf('thinking') < types.indexOf('progress'), '进度帧排在该轮的 thinking 之后（同一轮、不抢跑）');
});

test('进度②：roundCap 来自**既有** settings.round_cap（且只在它真的会拦人时才报）；计划步跟着 plan_done 走', async () => {
  // 两个键都是**既有**设置：round_cap（轮次护栏）+ fuse_interactive（把"只在无人值守生效"的两条熔断也套到人在场的会话上）。
  // 为什么要开 fuse_interactive：round_cap 的既有语义就是"只在无人值守时生效"（settingsSchema hint + progress.js 的
  // fuseDecision 同一口径），不生效时进度帧如实报 null（那是"没有可报的上限"，不是"0 轮"）。
  const put = await j('/api/settings', { method: 'PUT', headers: H(TOKEN), body: JSON.stringify({ updates: { round_cap: 5, fuse_interactive: 1 } }) });
  assert.equal(put.status, 200, '设置写入要成功：' + JSON.stringify(put.body));
  // 护栏读有**既有的** 5 秒缓存（agent.js 的 limitsCache）——等它过期，夹具不发明别的办法绕
  await new Promise((r) => setTimeout(r, 5200));
  const cid = await newConv('夹具：有计划 + 上限');
  const frames = await chat(cid, '【有计划】按计划把这件事做完');
  const prog = frames.filter((f) => f.type === 'progress');
  assert.deepEqual(prog.map((p) => p.round), [1, 2, 3], '三轮就该有三个进度帧：' + JSON.stringify(prog.map((p) => p.round)));
  for (const p of prog) assert.equal(p.roundCap, 5, '上限＝settings.round_cap 的现值（既有配置，不是本帧发明的）');
  assert.equal(prog[0].plan, null, '第 1 轮还没规划 ⇒ null');
  assert.deepEqual(prog[1].plan, { total: 4, done: 0, current: 1 }, '规划后：共 4 步、还没完成、当前第 1 步');
  assert.deepEqual(prog[2].plan, { total: 4, done: 1, current: 2 }, '第 1 步完成后：当前第 2 步（数据来自 plan 事件的同一份状态）');
  // plan 事件与 progress 的步数必须同源（不是两处各算一份）
  const planEv = frames.filter((f) => f.type === 'plan');
  assert.ok(planEv.length >= 1 && planEv[planEv.length - 1].plan.length === 4, 'plan 事件也是 4 步');
  await j('/api/settings', { method: 'PUT', headers: H(TOKEN), body: JSON.stringify({ updates: { round_cap: 0, fuse_interactive: 0 } }) });
});

// ── ③ 续订缺口帧 ────────────────────────────────────────────────────────────────────────────
test('缺口①：续订帧如实报 gap/earliestSeq/buffered（起点早于环内最早一条才算缺口）', async () => {
  const cid = await newConv('夹具：缺口');
  await chat(cid, '【小结果】列一下目录');   // 先把环喂上（这一段的 seq 必然 > 0）
  // 新订阅（没有 Last-Event-ID ⇒ after=0）：不是缺口
  const fresh = await helloFrame(cid, null);
  const hello = fresh.find((f) => f.type === 'stream_hello');
  assert.ok(hello, '续订第一帧必须是 stream_hello：' + JSON.stringify(fresh).slice(0, 200));
  assert.equal(hello.gap, false, 'after=0（我什么都没看过）不算缺口：' + JSON.stringify(hello));
  assert.ok(Number.isFinite(hello.earliestSeq) && hello.earliestSeq > 0, '要给出"最早还能给到的 seq"：' + JSON.stringify(hello));
  assert.ok(hello.buffered > 0, '环内条数要如实报出：' + JSON.stringify(hello));
  // 边界：起点正好是环内最早那一条（after = earliest-1）⇒ 接得上
  const exact = (await helloFrame(cid, hello.earliestSeq - 1)).find((f) => f.type === 'stream_hello');
  assert.equal(exact.gap, false, 'after+1 === earliestSeq：要的下一条还在，不许报缺口：' + JSON.stringify(exact));
  // 起点更早 ⇒ 中间那段已经收不回来了，如实报缺口
  const stale = (await helloFrame(cid, Math.max(0, hello.earliestSeq - 2))).find((f) => f.type === 'stream_hello');
  assert.equal(stale.gap, true, '起点早于环内最早一条 ⇒ 必须如实说接不上（而不是假装连续）：' + JSON.stringify(stale));
  assert.equal(stale.earliestSeq, hello.earliestSeq, '缺口帧里的"最早可给"与实测一致');
});

test('缺口②：环已被回收/从未有事件时，声明看过序号 ⇒ 如实报缺口（不许假装能接）', async () => {
  const cid = await newConv('夹具：空环');
  const hello = (await helloFrame(cid, 3)).find((f) => f.type === 'stream_hello');
  assert.equal(hello.gap, true, '这个会话从未产生过事件 ⇒ "你说的位置我手里什么都没有"：' + JSON.stringify(hello));
  assert.equal(hello.earliestSeq, null);
  assert.equal(hello.buffered, 0);
});

// ── ⑤ 决策3 接线：收尾那一刻产出待审卡片 ──────────────────────────────────────────────────────
test('决策3①：收尾时抽出候选 ⇒ 产出**待审卡片**（ask 帧落在 run_end 之后 + 队列里查得到）', async () => {
  const cid = await newConv('夹具：待沉淀');
  const frames = await chat(cid, '【待沉淀】复盘一下：做得好的是夹具跑通了，做得不好的是没覆盖真实模型，改进项是继续补夹具。');
  const asks = frames.filter((f) => f.type === 'ask');
  assert.equal(asks.length, 1, '应当恰好一张待审卡：' + JSON.stringify(frames.map((f) => f.type)));
  const ask = asks[0];
  assert.ok(ask.sink, '卡片要带出品条目 id（跨端对账用）：' + JSON.stringify(ask));
  assert.match(String(ask.question), /受限自动沉淀·待你确认/, '卡片题目要说清"这是待你确认的提案"');
  assert.deepEqual(ask.options.map((o) => o.value), ['write:global', 'write:conv', 'skip'], '选项就是那三个（不选不写）');
  const types = frames.map((f) => f.type);
  assert.ok(types.indexOf('ask') > types.indexOf('run_end'), '接线点在**收尾**：卡在 run_end（已落定）之后才发');
  // 卡片同时挂在既有待答队列上（GUI 轮询 /api/asks 也看得到，不是只在事件流里闪一下）
  const pend = await j('/api/asks', { headers: H(TOKEN) });
  const mine = (pend.body.pending || []).filter((p) => p.id === ask.id);
  assert.equal(mine.length, 1, '待答队列里必须查得到这张卡：' + JSON.stringify(pend.body).slice(0, 300));
  assert.equal(mine[0].conversationId, cid, '卡片归属会话（跨端按会话路由）');
});

test('决策3②（反向）：这段经历里没有够格候选 ⇒ 一张卡都不许建、一个帧都不许发', async () => {
  const before = (await j('/api/asks', { headers: H(TOKEN) })).body.pending.length;
  const cid = await newConv('夹具：无候选');
  const frames = await chat(cid, '【无候选】看看目录就行');
  assert.deepEqual(frames.filter((f) => f.type === 'ask'), [], '没有候选就不许打扰收尾：' + JSON.stringify(frames.map((f) => f.type)));
  const after2 = (await j('/api/asks', { headers: H(TOKEN) })).body.pending.length;
  assert.equal(after2, before, '待答队列也不许多出卡片');
});
