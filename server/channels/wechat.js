// server/channels/wechat.js - 微信渠道（W1-W6，iLink 协议）
// 复用 885 已登录的 iLink 凭证（state.json），收消息 → RW agent 处理 → 回复
import fs from 'node:fs';
import { WeChatClient } from 'wechat-ilink-client';
import { db } from '../db.js';
// 渠道「跑一轮并落账」的共享入口（v0.3 §4.7 G5「跨端一致」）：与飞书走同一套语义
// （事件账本、投递记录、可停/可续、失败码），本文件只留 iLink 协议这一层（收消息/发消息/登录态）。
import { runChannelTurn, makeChannelTurnDeps } from './run-turn.js';

const STATE_FILE = process.env.WECHAT_STATE_FILE || '/root/.dsh/wechat-bridge/state.json';

function loadCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return j.credentials || null;
  } catch { return null; }
}

// 提取消息文本（兼容不同字段）
function extractText(msg) {
  if (msg.text) return String(msg.text);
  if (msg.content) return String(msg.content);
  if (msg.items) {
    const t = msg.items.filter((i) => i.type === 1).map((i) => i.content || i.text || '').join(' ');
    if (t) return t;
  }
  return '';
}

async function findOrCreateConv(fromUserId) {
  let conv = (await db.query('SELECT id, permission FROM conversations WHERE channel="wechat" AND external_id=?', [fromUserId]))[0];
  if (!conv) {
    const r = await db.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (NULL,"wechat",?,?,?)',
      [fromUserId, process.env.RW_CHANNEL_PERMISSION || 'read', '微信对话']);
    conv = { id: r.insertId, permission: process.env.RW_CHANNEL_PERMISSION || 'read' };
  }
  return conv;
}

export async function startWechatChannel() {
  const creds = loadCreds();
  if (!creds?.token) {
    console.log('[wechat] 未找到登录凭证（需扫码登录：可复用 885 wechat-bridge 登录态）');
    return null;
  }
  let client;
  try {
    client = new WeChatClient({ baseUrl: creds.baseUrl, token: creds.token, accountId: creds.accountId });
  } catch (e) {
    console.error('[wechat] 客户端创建失败:', e.message);
    return null;
  }

  client.on('message', async (msg) => {
    try {
      const from = msg.from_user_id || msg.sender_id;
      const text = extractText(msg);
      if (!from || !text) return;
      console.log(`[wechat] 收到 ${from}: ${text.slice(0, 60)}`);
      const conv = await findOrCreateConv(from);
      // 跑一轮：历史组装、runAgent（带 emit）、事件账本、投递记录、现场登记全在共享入口里 ——
      // 改前这里是"自己拼历史 + 直调 runAgent 不传 emit + 硬编码 deepseek/deepseek-v4-flash"，
      // 于是微信会话不可观测/不可停/不可续、失败无处落账（核对报告 §3.5 缺陷①）。对外行为不变：照样回一条文本。
      const turn = await runChannelTurn({
        channel: 'wechat', conversationId: conv.id, text, deps: await makeChannelTurnDeps(),
      });
      const reply = turn.content || '（无回复）';
      const ct = client.getContextToken ? client.getContextToken(from) : undefined;
      await client.sendText(from, reply, ct);
      // 注：user 消息与 assistant 回复的落库都已在共享入口内完成（顺序与 /api/chat 一致），这里不再重复写。
    } catch (e) {
      console.error('[wechat] 消息处理失败:', e.message);
      try { await client.sendText(msg.from_user_id, '处理出错：' + e.message.slice(0, 100), client.getContextToken ? client.getContextToken(msg.from_user_id) : undefined); } catch { /* ignore */ }
    }
  });
  client.on('error', (e) => console.error('[wechat] 连接错误:', e.message));
  client.on('sessionExpired', () => console.error('[wechat] 会话过期，请重新扫码登录'));

  // start() 内部为常驻轮询（startMonitor），不 await，fire-and-forget
  client.start().catch((e) => console.error('[wechat] 轮询停止:', e.message));
  console.log('[wechat] 微信渠道已启动（复用 iLink 登录态）');
  return client;
}
