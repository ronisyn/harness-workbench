// test/asyncwrap.test.mjs - Express 4 的 async 处理器兜底（2026-09-16，Windows 端到端实测驱动）
//
// 为什么值得单独钉：实测 `POST /api/conversations` 在全新库（缺列）上抛错时，客户端**永久挂住**——
// Express 4 不接 async 处理器的 rejection（Express 5 才原生接），错误中间件只有人显式 next(err) 才跑。
// 一个请求挂住而不是回 500，是"客户机上出问题时最难诊断"的一类表现，所以这里用真 express + 真 HTTP 断言：
// 抛错必须换来 500，而不是超时。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { wrapAsyncHandlers } from '../server/asyncwrap.js';

function buildApp() {
  const app = express();
  app.get('/async-throw', async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('数据库说：Unknown column'); });
  app.get('/async-reject', () => Promise.reject(new Error('直接拒绝')));
  app.get('/sync-throw', () => { throw new Error('同步抛'); });
  app.get('/ok', async (req, res) => { res.json({ ok: true }); });
  app.use((err, req, res, next) => {
    if (res.headersSent) { res.end(); return; }
    res.status(500).json({ ok: false, code: 'INTERNAL', message: String(err && err.message) });
  });
  const n = wrapAsyncHandlers(app);
  return { app, n };
}

const start = (app) => new Promise((resolve) => {
  const srv = app.listen(0, () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
});
// 3 秒还没回就算"挂住"（真实现里是 240 秒客户端超时）
const get = async (url) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 3000);
  try { const r = await fetch(url, { signal: ac.signal }); return { status: r.status, body: await r.json().catch(() => null) }; }
  finally { clearTimeout(t); }
};

test('async 处理器抛错 → 500（不是挂住），且带 code', async () => {
  const { app, n } = buildApp();
  assert.ok(n >= 4, '应至少包住 4 个处理器，实际 ' + n);
  const { srv, url } = await start(app);
  try {
    const a = await get(url + '/async-throw');
    assert.equal(a.status, 500, 'await 抛错必须变成 500');
    assert.equal(a.body.code, 'INTERNAL');
    const b = await get(url + '/async-reject');
    assert.equal(b.status, 500, 'promise 拒绝同样要变成 500');
    const c = await get(url + '/sync-throw');
    assert.equal(c.status, 500, '同步抛也走同一条路');
    const d = await get(url + '/ok');
    assert.equal(d.status, 200, '正常路由不受影响');
  } finally { srv.close(); }
});

test('重复装配不会套两层，也不碰错误中间件（4 参）', async () => {
  const { app, n } = buildApp();
  const again = wrapAsyncHandlers(app);
  assert.equal(again, 0, '已包过的标记住了，第二次应当是 0');
  assert.ok(n > 0);
  const { srv, url } = await start(app);
  try {
    const r = await get(url + '/async-throw');
    assert.equal(r.status, 500);
    assert.equal(r.body.message, '数据库说：Unknown column', '错误中间件收到的是原始错误（没被包装层吃掉）');
  } finally { srv.close(); }
});
