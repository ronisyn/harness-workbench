// test/metric-alerts-wiring.test.mjs —— 决策1「页面标记」的**服务端接线**机检（2026-09-17）
//
// 依据：v0.3 §4.4.1 规则4「给'每轮新增'设阈值并监控」的落地形态（机制在位、**缺省不设线**、由配置给数），
// 以及 `server/selfeval/alerts.js` 文件头写的那一行接线：
//   `GET /api/cache-hit/summary` 要多带一个 `metricAlerts` 字段（`src/Dashboard.jsx` 的越线标记早就写好了，
//   收不到这个字段就**永远不显示**）。本文件锁这条链的四件事：
//   ① 缺省（没设线）⇒ `metricAlerts: []`（页面那段什么都不显示 —— 与接线前逐字相同）；
//   ② 设了线且越线 ⇒ 告警记录出现在响应里（指标/运算符/阈值/实测值/单位/可读一句，前端只用 .message）；
//   ③ 没越线 ⇒ 不告警（判据是"越过了"那一侧，不是"有个数就算"）；
//   ④ **脏存量值 ⇒ 不许 500**：库里存了一个合法 JSON 但 alerts.js 取值域不认的键时，整页仍要出数，
//      原因走 `metricAlertsError`（静默当"没设线"会让人以为监控开着；整页 500 会让用户什么都看不到）。
//
// 环境（与 test/storage-chain.test.mjs 同一套纪律）：一次性工作区 + `RW_STORAGE=jsonfile` + MySQL 不可达，
// 另加 `test/fake-db-shell.mjs`：**只读的假 db**（读数由夹具给）+ 离线模型壳 + fetch 闸门。
// 为什么不连真库：本夹具要验的是"读数 → 越线 → 页面字段"这条链，不该为此往开发库里写任何行。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = pathToFileURL(path.join(ROOT, 'test', 'fake-db-shell.mjs')).href;
const ADMIN = { user: 'ma-fixture-admin', pass: 'ma-fixture-pass' };

let WS = null, child = null, BASE = null, TOKEN = null, LINES = null;

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
/** 设定"库里的线"：写那个文件模拟**存量值**（生产里它就是 settings 表里的一行） */
const setLines = (text) => { if (text == null) { try { fs.rmSync(LINES, { force: true }); } catch { /* ignore */ } } else fs.writeFileSync(LINES, text); };
const summary = async () => {
  const r = await j('/api/cache-hit/summary', { headers: H(TOKEN) });
  assert.equal(r.status, 200, '摘要接口必须出数（不是 500）：' + String(r.raw).slice(0, 200));
  return r.body;
};

before(async () => {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-metric-alerts-'));
  LINES = path.join(WS, 'metric-alert-lines.txt');
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--import', SHELL, path.join('server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RW_STORAGE: 'jsonfile',
      DB_PORT: '1',                       // MySQL 不可达：读数只可能来自假 db
      RW_WORKSPACE: WS,
      RW_FAKE_SETTINGS_FILE: LINES,       // 假 db 从这里读"库里的线"
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
  const t0 = Date.now();
  const ready = () => /\[RW\] Roni Workbench 启动: http:\/\/localhost:\d+/.test(out);
  while (!ready()) {
    if (child.exitCode !== null) throw new Error('服务子进程提前退出（code=' + child.exitCode + '）：\n' + out);
    if (Date.now() - t0 > 60000) throw new Error('等服务启动超时（60s）：\n' + out);
    await new Promise((r) => setTimeout(r, 100));
  }
  // 钩子必须真的装上（装不上就会走真 db/真模型 —— 那种"夹具绿"是假的，当场判红）
  assert.match(out, /\[fake-db-shell\] 已装载/, '假 db 壳必须真的加载：\n' + out.slice(0, 600));
  const login = await j('/api/auth/login', { method: 'POST', headers: H(), body: JSON.stringify({ username: ADMIN.user, password: ADMIN.pass }) });
  assert.equal(login.status, 200, '登录要成功：' + JSON.stringify(login.body));
  TOKEN = login.body.token;
});

after(() => {
  try { if (child && child.exitCode === null) child.kill(); } catch { /* ignore */ }
  try { if (WS) fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('接线①：读数来自端点自己查回来的那几列（夹具给什么就读什么，不新采集）', async () => {
  const s = await summary();
  assert.equal(s.perRequest.rounds, 40, '40 轮样本');
  assert.equal(s.c2.median, 10, 'C2 中位＝夹具给的每轮未命中 10');
  assert.equal(s.perRequest.median, 99, 'C1 逐轮命中率 990/1000 ⇒ 99%');
  assert.equal(s.c3.runs, 40);
  assert.equal(s.c4.count, 3, 'C4 账本 3 行');
  assert.equal(s.c5.total, 12, 'C5 豁免 12 次');
});

test('接线②：缺省不设线 ⇒ metricAlerts 为空数组（页面那段不渲染，与接线前逐字相同）', async () => {
  setLines(null);
  const s = await summary();
  assert.ok(Array.isArray(s.metricAlerts), '必须带出 metricAlerts 字段（Dashboard 读它）：' + JSON.stringify(Object.keys(s)));
  assert.deepEqual(s.metricAlerts, [], '没设线 ⇒ 一条告警都不产');
  assert.equal(s.metricAlertsError, undefined, '没写坏就不该有错误字段');
  assert.ok(s.definition.metricAlerts, '新字段的口径写在 definition 里（前端不自己解释指标）');
  assert.ok(s.definition.perRequest, '既有字段一个都没动');
});

test('接线③：设了线且越线 ⇒ 告警记录出现；没越线 ⇒ 不告警', async () => {
  // 越线：C2 中位 10 > 5（`<=` 语义＝"不超过这条线"，超了就是越线）
  setLines('{"c2Median":{"op":"<=","value":5}}');
  const hit = await summary();
  assert.equal(hit.metricAlerts.length, 1, '恰好一条告警：' + JSON.stringify(hit.metricAlerts));
  const a = hit.metricAlerts[0];
  assert.equal(a.metric, 'c2Median');
  assert.equal(a.op, '<=');
  assert.equal(a.value, 5);
  assert.equal(a.actual, 10, '实测值＝端点自己报的那个读数（10）');
  assert.equal(a.level, 'alert');
  assert.equal(a.unit, 'tokens（每轮新增未命中的中位）');
  assert.match(a.message, /c2Median 10 > 5/, '页面只用 .message 渲染');
  // 没越线：C1 0.99 ≥ 0.99（同一条线不许"有个数就算越线"）
  setLines('{"c1":{"op":">=","value":0.99}}');
  const miss = await summary();
  assert.deepEqual(miss.metricAlerts, [], '刚好等于线 ⇒ 不越线：' + JSON.stringify(miss.metricAlerts));
  // 两条线一起：越线的进数组、没越线的不进
  setLines('{"c1":{"op":">=","value":0.99},"c4Invalidate":{"op":"<=","value":0}}');
  const both = await summary();
  assert.deepEqual(both.metricAlerts.map((x) => x.metric), ['c4Invalidate'], 'C4=3 超过 0 ⇒ 越线；C1 不越线');
  setLines(null);
});

test('接线④（反向·重点）：库里的线是**脏值**（合法 JSON、但不是已知指标）⇒ 不许 500，原因如实回', async () => {
  setLines('{"c9Median":{"op":"<=","value":5}}');
  const s = await summary();   // 内部已断言 200
  assert.deepEqual(s.metricAlerts, [], '判不了就不判（不许造出假告警）');
  assert.match(String(s.metricAlertsError), /unknown metric/, '原因必须如实回给页面：' + JSON.stringify(s.metricAlertsError));
  assert.ok(s.perRequest && s.definition.perRequest, '整页数据照常在位（最坏情况是这一块不显示，不是整页打不开）');
  // 反向再走一格：不是合法 JSON 的存量值同样不许 500
  setLines('{不是 json');
  const s2 = await summary();
  assert.deepEqual(s2.metricAlerts, []);
  assert.match(String(s2.metricAlertsError), /不是合法 JSON/, '原因如实：' + JSON.stringify(s2.metricAlertsError));
  setLines(null);
});
