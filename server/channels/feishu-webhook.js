// server/channels/feishu-webhook.js - 飞书消息对话（F1-F5，v2.0 渠道一期）
// 接收飞书事件订阅（im.message.receive_v1）→ agent 处理 → 回复
// 需要公网 HTTPS 回调地址（PROD 域名阶段启用；TEST 阶段可用反向代理/隧道）
import crypto from 'node:crypto';
import express from 'express';
import { db } from '../db.js';
import { runAgent } from '../agent.js';
import { config } from '../config.js';
import { getToken as getFeishuToken } from '../tools/feishu.js';

const FEISHU_API = 'https://open.feishu.cn/open-apis';

// 飞书事件解密（AES-256-CBC，encrypt_key 派生）
function decryptEvent(encryptStr) {
  const b = Buffer.from(encryptStr, 'base64');
  const iv = b.subarray(0, 16);
  const cipher = b.subarray(16);
  const key = crypto.createHash('sha256').update(process.env.FEISHU_ENCRYPT_KEY || '').digest();
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([d.update(cipher), d.final()]);
  return JSON.parse(plain.toString('utf8'));
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

async function findOrCreateConv(chatId) {
  let conv = (await db.query('SELECT id, permission FROM conversations WHERE channel="feishu" AND external_id=?', [chatId]))[0];
  if (!conv) {
    const r = await db.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (NULL,"feishu",?,?,?)',
      [chatId, process.env.RW_CHANNEL_PERMISSION || 'read', '飞书对话']);
    conv = { id: r.insertId, permission: process.env.RW_CHANNEL_PERMISSION || 'read' };
  }
  return conv;
}

export function registerFeishuWebhook(app) {
  const router = express.Router();

  router.post('/webhook', async (req, res) => {
    const body = req.body || {};
    // URL 验证（首次配置时飞书发 challenge）
    if (body.challenge !== undefined) {
      return res.json({ challenge: body.challenge });
    }
    // 事件解密
    let event = body;
    if (body.encrypt) {
      try { event = decryptEvent(body.encrypt); } catch (e) { return res.status(400).json({ ok: false, message: '解密失败' }); }
    }
    const header = event.header || {};
    const ev = event.event || {};
    res.json({ ok: true }); // 先确认接收

    if (header.event_type !== 'im.message.receive_v1') return;

    try {
      const chatId = ev.message?.chat_id;
      const sender = ev.sender?.sender_id?.open_id || ev.message?.chat_id;
      if (!chatId || !sender) return;
      const msg = parseMessageContent(ev.message?.content);
      if (msg.type !== 'text' || !msg.text) {
        await sendFeishuText(chatId, 'chat_id', '暂只支持文本消息（图片/文件/语音支持开发中）');
        return;
      }
      console.log(`[feishu] 收到 ${chatId}: ${msg.text.slice(0, 60)}`);
      const conv = await findOrCreateConv(chatId);
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'user', msg.text]);
      const hist = await db.query('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id', [conv.id]);
      const messages = hist.map((m) => ({ role: m.role, content: m.content }));
      const ctx = { permission: conv.permission || 'read', accountId: null, conversationId: conv.id, root: process.env.RW_WORKSPACE || '/srv/rw-workspace' };
      const result = await runAgent({ provider: 'deepseek', model: 'deepseek-v4-flash', messages, permission: conv.permission || 'read', ctx, keys: config.keys });
      const reply = result.content || '（无回复）';
      await sendFeishuText(chatId, 'chat_id', reply);
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'assistant', reply]);
    } catch (e) {
      console.error('[feishu] 消息处理失败:', e.message);
      try { await sendFeishuText(ev.message?.chat_id, 'chat_id', '处理出错：' + e.message.slice(0, 100)); } catch { /* ignore */ }
    }
  });

  app.use('/api/feishu', router);
  console.log('[feishu] webhook 已注册（/api/feishu/webhook，需公网 HTTPS 回调）');
}
