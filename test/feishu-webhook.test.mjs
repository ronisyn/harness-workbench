// test/feishu-webhook.test.mjs - 飞书回调入口的**来源校验**（RA-42 的 HMAC 那一半，2026-09-16 落地）
//
// 背景（真实缺口，不是假想）：`POST /api/feishu/webhook` 是全仓**唯一没有 requireAuth 的写入路由**。
// 原实现的处理顺序是"先看有没有 challenge → 有就回显；没有就（可选解密）直接当成真事件"，于是：
//   · 未配置加密策略时，任何能访问端口的人 POST 一个 `im.message.receive_v1` 就能让平台**真跑一轮 Agent**
//     （花模型费、往它指定的 chat_id 发消息）；
//   · 配置了 Encrypt Key 时，challenge 是**加密**下发的，而原代码在解密**之前**就看 `body.challenge`
//     ⇒ 网址校验永远失败（渠道根本注册不上）。
// 修法照飞书开放平台官方文档（不是自己拍的规范）：
//   · 配了 Encrypt Key ⇒ 签名校验 sha256(timestamp + nonce + encrypt_key + **原始请求体**)，与 X-Lark-Signature 比；
//   · 只配了 Verification Token ⇒ 比对事件里的 token；
//   · 都没配 ⇒ 放行 + 启动时明确告警（不把正在用的渠道打死，但如实声明"本入口不校验来源"）；
//   · challenge **不在签名校验范围内**（官方原文），单独按 token 比对，且必须先解密再取 challenge。
// 顺序上照 DSH 的 GitHub webhook 适配器：**验来源在动手之前**，失败 401。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { registerFeishuWebhook, feishuSignature } from '../server/channels/feishu-webhook.js';

// 起一个只装这一个路由的最小 app（与 index.js 同口径：express.json 留一份 rawBody）
function startApp() {
  const app = express();
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  registerFeishuWebhook(app);
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}
const post = (url, body, headers = {}) => fetch(url + '/api/feishu/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
// 与飞书同款加密：key = sha256(encrypt_key)，AES-256-CBC，密文 = base64(iv + ciphertext)
function encryptEvent(obj, key) {
  const iv = crypto.randomBytes(16);
  const k = crypto.createHash('sha256').update(key).digest();
  const c = crypto.createCipheriv('aes-256-cbc', k, iv);
  return Buffer.concat([iv, c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]).toString('base64');
}
const withEnv = async (env, fn) => {
  const saved = { FEISHU_ENCRYPT_KEY: process.env.FEISHU_ENCRYPT_KEY, FEISHU_VERIFICATION_TOKEN: process.env.FEISHU_VERIFICATION_TOKEN };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const OTHER_EVENT = { schema: '2.0', header: { event_type: 'some.other.event' }, event: {} };

test('未配置任何校验密钥：入口如实告警，且行为与从前一致（不把正在用的渠道打死）', async () => {
  await withEnv({ FEISHU_ENCRYPT_KEY: undefined, FEISHU_VERIFICATION_TOKEN: undefined }, async () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let app;
    try { app = await startApp(); } finally { console.warn = orig; }
    try {
      assert.ok(warns.some((w) => /不校验来源/.test(w)), '没有校验密钥时必须明确告警：' + JSON.stringify(warns));
      const r = await post(app.url, OTHER_EVENT);
      assert.equal(r.status, 200, '未配置密钥时不阻断（保持既有行为）');
      // 明文 challenge 照旧回显
      const c = await post(app.url, { challenge: 'abc-123', type: 'url_verification', token: 'whatever' });
      assert.deepEqual(await c.json(), { challenge: 'abc-123' });
    } finally { app.srv.close(); }
  });
});

test('配了 Verification Token：token 不对 → 401；对了 → 200', async () => {
  await withEnv({ FEISHU_ENCRYPT_KEY: undefined, FEISHU_VERIFICATION_TOKEN: 'VT-1' }, async () => {
    const app = await startApp();
    try {
      const bad = await post(app.url, { header: { event_type: 'some.other.event', token: 'WRONG' }, event: {} });
      assert.equal(bad.status, 401, 'token 不匹配必须拒（原实现会照单全收）');
      const ok = await post(app.url, { header: { event_type: 'some.other.event', token: 'VT-1' }, event: {} });
      assert.equal(ok.status, 200);
      // challenge 也按 token 比对
      const badChallenge = await post(app.url, { challenge: 'x', type: 'url_verification', token: 'WRONG' });
      assert.equal(badChallenge.status, 401);
    } finally { app.srv.close(); }
  });
});

test('配了 Encrypt Key：真实事件必须带正确签名（缺头/错签 → 401，对签 → 200）', async () => {
  await withEnv({ FEISHU_ENCRYPT_KEY: 'EK-test-key', FEISHU_VERIFICATION_TOKEN: undefined }, async () => {
    const app = await startApp();
    try {
      const raw = JSON.stringify(OTHER_EVENT);
      const noHeader = await post(app.url, raw);
      assert.equal(noHeader.status, 401, '配了 Encrypt Key 却没带签名头 → 必须拒');
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = 'n-1';
      const wrong = await post(app.url, raw, { 'X-Lark-Request-Timestamp': ts, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': 'deadbeef' });
      assert.equal(wrong.status, 401, '签名不对 → 必须拒');
      const sig = feishuSignature(ts, nonce, 'EK-test-key', Buffer.from(raw, 'utf8'));
      const good = await post(app.url, raw, { 'X-Lark-Request-Timestamp': ts, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': sig });
      assert.equal(good.status, 200, '签名正确 → 放行');
      // 改一个字节就应当验签失败（证明签的是**原始 body**，而不是某个重新序列化的等价 JSON）
      const tampered = raw.replace('some.other.event', 'some.other.evenT');
      const r2 = await post(app.url, tampered, { 'X-Lark-Request-Timestamp': ts, 'X-Lark-Request-Nonce': nonce, 'X-Lark-Signature': sig });
      assert.equal(r2.status, 401, 'body 被改过必须验签失败');
    } finally { app.srv.close(); }
  });
});

test('加密模式下的网址校验（challenge 在密文里）：能解密并原样返回（原实现在这里必然失败）', async () => {
  await withEnv({ FEISHU_ENCRYPT_KEY: 'EK-test-key', FEISHU_VERIFICATION_TOKEN: 'VT-1' }, async () => {
    const app = await startApp();
    try {
      const plain = { challenge: 'ch-9', token: 'VT-1', type: 'url_verification' };
      const body = { encrypt: encryptEvent(plain, 'EK-test-key') };
      const r = await post(app.url, body);
      assert.equal(r.status, 200, 'challenge 必须先解密再回（官方口径：网址校验不走签名校验）');
      assert.deepEqual(await r.json(), { challenge: 'ch-9' });
      // token 不对的加密 challenge 仍然要拒
      const bad = { encrypt: encryptEvent({ challenge: 'ch-9', token: 'WRONG', type: 'url_verification' }, 'EK-test-key') };
      assert.equal((await post(app.url, bad)).status, 401);
      // 用错误密钥加密的内容解不出来（400，不是 200 也不是 500）
      const badKey = { encrypt: encryptEvent(plain, 'OTHER-key') };
      assert.equal((await post(app.url, badKey)).status, 400);
    } finally { app.srv.close(); }
  });
});
