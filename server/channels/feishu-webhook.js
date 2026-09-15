// server/channels/feishu-webhook.js - 飞书消息对话（F1-F5，v2.0 渠道一期）
// 接收飞书事件订阅（im.message.receive_v1）→ agent 处理 → 回复
// 需要公网 HTTPS 回调地址（PROD 域名阶段启用；TEST 阶段可用反向代理/隧道）
import crypto from 'node:crypto';
import express from 'express';
import { db } from '../db.js';
import { getToken as getFeishuToken } from '../tools/feishu.js';
// 渠道「跑一轮并落账」的共享入口（v0.3 §4.7 G5「跨端一致」）：飞书/微信走同一套语义
// （事件账本、投递记录、可停/可续、失败码），本文件只留平台协议这一层（验签/解密/收发消息）。
import { runChannelTurn, makeChannelTurnDeps } from './run-turn.js';
// 待答卡片（审批/问询）的按会话路由与文案：卡片发得出去、人在渠道里的回答回得到同一个入口
// （`answerCard` 内部调的就是 `POST /api/asks/:id`、`POST /api/approvals/:id` 调的那两个裁决函数）。
import { answerCard, answerAckText, cardText } from '../cards.js';

const FEISHU_API = 'https://open.feishu.cn/open-apis';

// 飞书事件解密（AES-256-CBC，encrypt_key 派生）
function decryptEvent(encryptStr, encryptKey) {
  const b = Buffer.from(encryptStr, 'base64');
  const iv = b.subarray(0, 16);
  const cipher = b.subarray(16);
  const key = crypto.createHash('sha256').update(String(encryptKey || '')).digest();
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([d.update(cipher), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// 来源校验的三条口径（2026-09-16 照飞书开放平台官方文档实现，不是自己拍的规范）：
//  · 配了 Encrypt Key ⇒ **签名校验**：sha256(X-Lark-Request-Timestamp + X-Lark-Request-Nonce + encrypt_key + 原始请求体)，
//    与请求头 X-Lark-Signature 比对。官方明确"body 指整个请求体，**不要在反序列化后再计算**"
//    ⇒ 依赖 index.js 的 express.json 把原始字节留一份（rawBody）。
//  · 只配了 Verification Token ⇒ 比对事件里的 token（官方注明这种简单但明文传输、安全性较低）。
//  · 两个都没配 ⇒ 本入口**没有来源校验**：任何能访问这个端口的人都能 POST 一个事件把 Agent 叫起来。
//    这里**不阻断**（避免把正在用的渠道打死），但启动时明确告警——这就是"如实声明"的那一半。
//  另：官方口径里【请求网址校验（challenge）**不在**签名校验范围内】，所以 challenge 单独按 token 比对。
export function feishuSignature(timestamp, nonce, encryptKey, rawBody) {
  const prefix = String(timestamp) + String(nonce) + String(encryptKey);
  return crypto.createHash('sha256').update(prefix).update(rawBody || Buffer.alloc(0)).digest('hex');
}

// 解析消息内容（text 或 file/media）
function parseMessageContent(contentStr) {
  try {
    const j = JSON.parse(contentStr || '{}');
    if (j.text) return { type: 'text', text: j.text };
    if (j.file_key) return { type: 'file', fileKey: j.file_key, name: j.file_name || '' };
    if (j.image_key) return { type: 'image', imageKey: j.image_key };
    return { type: 'unknown', raw: contentStr };
  } catch { return { type: 'text', text: contentStr }; }
}

// 发送飞书文本消息
async function sendFeishuText(receiveId, receiveIdType, text) {
  const token = await getFeishuToken();
  const res = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: String(text).slice(0, 4000) }) }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error('飞书发送失败: ' + (j.msg || j.code));
  return j;
}

async function findOrCreateConv(chatId, dbc = db) {
  let conv = (await dbc.query('SELECT id, permission FROM conversations WHERE channel="feishu" AND external_id=?', [chatId]))[0];
  if (!conv) {
    const r = await dbc.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (NULL,"feishu",?,?,?)',
      [chatId, process.env.RW_CHANNEL_PERMISSION || 'read', '飞书对话']);
    conv = { id: r.insertId, permission: process.env.RW_CHANNEL_PERMISSION || 'read' };
  }
  return conv;
}

/**
 * @param {import('express').Express} app
 * @param {object} [opts] 夹具缝（与 `runChannelTurn` 的 deps 同款：给了就不碰真库/真模型/真飞书）
 *   · `opts.deps`：渠道轮次依赖（`makeChannelTurnDeps()` 的形状），夹具传假的；
 *   · `opts.sendText`：发文本到飞书的实现（默认真调开放平台接口）。
 *   为什么要缝：卡片要能真的发出去、回答要能对回来，这两件事必须有可断言的路径（本轮无真机条件）。
 */
export function registerFeishuWebhook(app, opts = {}) {
  const router = express.Router();
  const sendText = opts.sendText || sendFeishuText;

  router.post('/webhook', async (req, res) => {
    const body = req.body || {};
    const encKey = process.env.FEISHU_ENCRYPT_KEY || '';
    const vToken = process.env.FEISHU_VERIFICATION_TOKEN || '';
    // 事件解密（加密模式下 challenge 也在密文里，必须先解密才能分辨"这是网址校验还是真事件"）
    let event = body;
    if (body.encrypt) {
      try { event = decryptEvent(body.encrypt, encKey); } catch { return res.status(400).json({ ok: false, message: '解密失败' }); }
    }
    // 请求网址校验（首次配置时飞书发 challenge）：官方明确它不在签名校验范围内，按 Verification Token 比对
    if (event.challenge !== undefined || event.type === 'url_verification') {
      if (vToken && event.token !== vToken) return res.status(401).json({ ok: false, message: 'challenge 的 token 不匹配' });
      return res.json({ challenge: event.challenge });
    }
    // 真实事件：**先验来源，再动手**（DSH 的 GitHub webhook 也是"解析 JSON 之前验签、失败 401"）
    if (encKey) {
      const sig = String(req.get('X-Lark-Signature') || '');
      const ts = String(req.get('X-Lark-Request-Timestamp') || '');
      const nonce = String(req.get('X-Lark-Request-Nonce') || '');
      if (!sig || !ts || !nonce || !req.rawBody) return res.status(401).json({ ok: false, message: '缺少签名头（配置了 Encrypt Key 就必须带 X-Lark-Signature/Timestamp/Nonce）' });
      const want = feishuSignature(ts, nonce, encKey, req.rawBody);
      // 定长比较：避免按字节提前返回造成的时序差异
      const okSig = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      if (!okSig) return res.status(401).json({ ok: false, message: '签名校验失败' });
    } else if (vToken) {
      const t = (event.header && event.header.token) || event.token;
      if (t !== vToken) return res.status(401).json({ ok: false, message: 'token 校验失败' });
    }
    const header = event.header || {};
    const ev = event.event || {};
    res.json({ ok: true }); // 先确认接收（官方要求 3 秒内回 200，否则会重推）

    if (header.event_type !== 'im.message.receive_v1') return;

    try {
      const chatId = ev.message?.chat_id;
      const sender = ev.sender?.sender_id?.open_id || ev.message?.chat_id;
      if (!chatId || !sender) return;
      const msg = parseMessageContent(ev.message?.content);
      if (msg.type !== 'text' || !msg.text) {
        await sendText(chatId, 'chat_id', '暂只支持文本消息（图片/文件/语音支持开发中）');
        return;
      }
      console.log(`[feishu] 收到 ${chatId}: ${msg.text.slice(0, 60)}`);
      const d = opts.deps || await makeChannelTurnDeps();  // 夹具缝：给了假依赖就不碰真库/真模型
      const conv = await findOrCreateConv(chatId, d.db);
      // 一条消息两种可能：**在回答一张待答卡片**（问询/审批），或是一句新指令。
      // 回答走 `server/cards.js` 的 `answerCard` —— 它内部调 `decideAsk`/`decideApproval`，
      // 与 `POST /api/asks/:id`、`POST /api/approvals/:id` 是**同一批裁决函数**（渠道不另造问答 API）：
      // 裁决一落，被挂住的那一轮（工具里的 await）就接着往下跑，与 GUI 里点一下完全同一条路。
      const answered = answerCard(conv.id, msg.text);
      // 跑一轮：历史组装、runAgent（带 emit）、事件账本、投递记录、现场登记全在共享入口里 ——
      // 改前这里是"自己拼历史 + 直调 runAgent 不传 emit + 硬编码 deepseek/deepseek-v4-flash"，
      // 于是飞书会话不可观测/不可停/不可续、失败无处落账（核对报告 §3.5 缺陷①）。对外行为不变：照样回一条文本。
      // `onCard`：卡片（审批/问询）事件一到就发到聊天里——渠道没有 SSE，不发出去人在渠道里就看不到它。
      const turn = answered.answered ? null : await runChannelTurn({
        channel: 'feishu', conversationId: conv.id, text: msg.text,
        deps: { ...d, onCard: (card) => sendText(chatId, 'chat_id', cardText(card)) },
      });
      const reply = answered.answered ? answerAckText(answered) : (turn.content || '（无回复）');
      await sendText(chatId, 'chat_id', reply);
      // 注：user 消息与 assistant 回复的落库都已在共享入口内完成（顺序与 /api/chat 一致），这里不再重复写。
    } catch (e) {
      console.error('[feishu] 消息处理失败:', e.message);
      try { await sendText(ev.message?.chat_id, 'chat_id', '处理出错：' + e.message.slice(0, 100)); } catch { /* ignore */ }
    }
  });

  app.use('/api/feishu', router);
  // 如实声明：没有任何校验密钥时，这个入口是不设防的（能访问端口的人都能 POST 一个事件把 Agent 叫起来）。
  // 不在这里拒绝请求（那会把正在用的渠道打死），但启动时必须说清楚，别让"看起来接上了"掩盖"其实没验来源"。
  if (!process.env.FEISHU_ENCRYPT_KEY && !process.env.FEISHU_VERIFICATION_TOKEN) {
    console.warn('[feishu] webhook 未配置 FEISHU_ENCRYPT_KEY / FEISHU_VERIFICATION_TOKEN：本入口**不校验来源**，'
      + '任何能访问该端口的人都能 POST 事件触发 Agent 调用（配置见 scripts/PROD-DEPLOY.md 的加密策略一节）。');
  }
  console.log('[feishu] webhook 已注册（/api/feishu/webhook，需公网 HTTPS 回调）');
}
