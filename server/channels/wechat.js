// server/channels/wechat.js - 微信渠道（W1-W6，iLink 协议）
// 复用 885 已登录的 iLink 凭证（state.json），收消息 → RW agent 处理 → 回复
import fs from 'node:fs';
import { WeChatClient } from 'wechat-ilink-client';
import { db } from '../db.js';
// 渠道「跑一轮并落账」的共享入口（v0.3 §4.7 G5「跨端一致」）：与飞书走同一套语义
// （事件账本、投递记录、可停/可续、失败码），本文件只留 iLink 协议这一层（收消息/发消息/登录态）。
import { runChannelTurn, makeChannelTurnDeps } from './run-turn.js';
// 待答卡片（审批/问询）的按会话路由与文案：与飞书同源（`answerCard` 内部调的就是
// `POST /api/asks/:id`、`POST /api/approvals/:id` 调的那两个裁决函数）。
import { answerCard, answerAckText, cardText } from '../cards.js';

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

async function findOrCreateConv(fromUserId, dbc = db) {
  let conv = (await dbc.query('SELECT id, permission FROM conversations WHERE channel="wechat" AND external_id=?', [fromUserId]))[0];
  if (!conv) {
    const r = await dbc.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (NULL,"wechat",?,?,?)',
      [fromUserId, process.env.RW_CHANNEL_PERMISSION || 'read', '微信对话']);
    conv = { id: r.insertId, permission: process.env.RW_CHANNEL_PERMISSION || 'read' };
  }
  return conv;
}

/**
 * 处理一条 iLink 消息（**导出是为了可夹具化**：适配器只做协议这一层，语义在共享入口里）。
 * 与飞书同构的三步：会话归属 → 先看是不是在回答待答卡片 → 否则照常跑一轮（卡片经 onCard 发出去）。
 * @param {object} o
 * @param {object} o.msg    iLink 消息原文
 * @param {object} o.client iLink 客户端（要 `sendText`，可选 `getContextToken`）
 * @param {object} [o.deps] 渠道轮次依赖（夹具传假的；缺省走 `makeChannelTurnDeps()`）
 */
export async function handleWechatMessage({ msg, client, deps = null }) {
  const from = msg.from_user_id || msg.sender_id;
  const text = extractText(msg);
  if (!from || !text) return { ok: false, reason: 'no-text' };
  console.log(`[wechat] 收到 ${from}: ${text.slice(0, 60)}`);
  const d = deps || await makeChannelTurnDeps();   // 夹具缝：给了假依赖就不碰真库/真模型
  const conv = await findOrCreateConv(from, d.db);
  // 上下文令牌要在**跑之前**取：卡片是在这一轮中途发出去的，那时也要用它
  const ct = client.getContextToken ? client.getContextToken(from) : undefined;
  // 一条消息两种可能：**在回答一张待答卡片**（问询/审批），或是一句新指令。回答走 `server/cards.js`
  // 的 `answerCard` —— 与 `POST /api/asks/:id`、`POST /api/approvals/:id` 同一批裁决函数（不另造问答 API）。
  const answered = answerCard(conv.id, text);
  // 跑一轮：历史组装、runAgent（带 emit）、事件账本、投递记录、现场登记全在共享入口里 ——
  // 改前这里是"自己拼历史 + 直调 runAgent 不传 emit + 硬编码 deepseek/deepseek-v4-flash"，
  // 于是微信会话不可观测/不可停/不可续、失败无处落账（核对报告 §3.5 缺陷①）。对外行为不变：照样回一条文本。
  const turn = answered.answered ? null : await runChannelTurn({
    channel: 'wechat', conversationId: conv.id, text,
    deps: { ...d, onCard: (card) => client.sendText(from, cardText(card), ct) },
  });
  const reply = answered.answered ? answerAckText(answered) : (turn.content || '（无回复）');
  await client.sendText(from, reply, ct);
  // 注：user 消息与 assistant 回复的落库都已在共享入口内完成（顺序与 /api/chat 一致），这里不再重复写。
  return { ok: true, answered: answered.answered, conversationId: conv.id, reply };
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
      // 语义全在共享入口里（会话归属 / 待答卡片 / 跑一轮 / 发卡片 / 发回复），这里只兜协议层错误
      await handleWechatMessage({ msg, client });
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
