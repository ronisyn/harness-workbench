// server/channels/wechat.js - 微信渠道（W1-W6，iLink 协议）
// 复用 885 已登录的 iLink 凭证（state.json），收消息 → RW agent 处理 → 回复
import fs from 'node:fs';
import { WeChatClient } from 'wechat-ilink-client';
import { db } from '../db.js';
import { runAgent } from '../agent.js';
import { config } from '../config.js';

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
      // 存用户消息
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'user', text]);
      // 组装历史
      const hist = await db.query('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id', [conv.id]);
      const messages = hist.map((m) => ({ role: m.role, content: m.content }));
      // Agent 处理（渠道权限默认 read，可提权）
      const ctx = { permission: conv.permission || 'read', accountId: null, conversationId: conv.id, root: process.env.RW_WORKSPACE || '/srv/rw-workspace' };
      const result = await runAgent({ provider: 'deepseek', model: 'deepseek-chat', messages, permission: conv.permission || 'read', ctx, keys: config.keys });
      const reply = result.content || '（无回复）';
      const ct = client.getContextToken ? client.getContextToken(from) : undefined;
      await client.sendText(from, reply, ct);
      // 存 assistant
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'assistant', reply]);
    } catch (e) {
      console.error('[wechat] 消息处理失败:', e.message);
      try { await client.sendText(msg.from_user_id, '处理出错：' + e.message.slice(0, 100), client.getContextToken ? client.getContextToken(msg.from_user_id) : undefined); } catch { /* ignore */ }
    }
  });
  client.on('error', (e) => console.error('[wechat] 连接错误:', e.message));
  client.on('sessionExpired', () => console.error('[wechat] 会话过期，请重新扫码登录'));

  try {
    await client.start();
    console.log('[wechat] 微信渠道已启动（复用 iLink 登录态）');
    return client;
  } catch (e) {
    console.error('[wechat] 启动失败:', e.message);
    return null;
  }
}
