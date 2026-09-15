// server/cards.js - 待答卡片（问询 ask / 审批 approval）的**按会话路由**：唯一出处
//
// 为什么要有它（v0.3 §4.7 G5「跨端一致」，契约 §7 里记的第四条缺口之一）：
//   `server/asks.js` / `server/approval.js` 的待答队列是**进程内 Map，键是卡片 id** —— 从一张卡片
//   反查"它属于哪个会话、该投到哪一端"没有出处。后果有两条（都是核对报告 §3.5① 记的实例）：
//   ① `GET /api/approvals` / `GET /api/asks` 报不出会话与渠道 ⇒ 没人知道这张卡该回哪儿；
//   ② 渠道轮次产生的问询，**人在渠道里答不了**（要登录 GUI 才看得见、答得上）。
//
// 本模块只做两件事，且都不发明新机制：
//   · **归属与投递目标**：卡片 → 会话 → 渠道，取自会话行**既有**的 `channel` / `external_id` 两列
//     （不新造列、不新造表；查不到就如实给 null，不猜）。
//   · **回答入口只有一条**：内部调 `decideAsk` / `decideApproval` —— 就是 `POST /api/asks/:id`、
//     `POST /api/approvals/:id`（`server/index.js`）调的那两个函数。渠道侧因此**不另造问答 API**，
//     也不自己动待答队列（只读 + 走那两个裁决函数，夹具锁住这一条）。
import { db as realDb } from './db.js';
import { decideAsk, listPendingAsks } from './asks.js';
import { decideApproval, listPending } from './approval.js';

// 「这一端有没有回答通道」——**如实登记**，不是能力想象（v0.3 §4.6 那条"禁止静默降级"的同一条纪律，
// 方向相反：拿不准就说"不支持"，不许假装支持）：
//   · web（GUI）：本来就能答（`POST /api/asks/:id` 那条链）；
//   · feishu：webhook 收消息 + 有回信通道（`sendFeishuText`）⇒ 能答；
//   · wechat：iLink `client.on('message')` 收 + `client.sendText` 发 ⇒ 形态上能答
//     （**真机未验证**，如实写在契约 §7：代码路径与飞书同源，但线上链路本轮没有条件跑）。
//   未登记的渠道（将来新增的端）一律 false —— 宁可报"该渠道暂不支持回答"。
export const CHANNEL_ANSWER_SUPPORT = { web: true, feishu: true, wechat: true };

/** 中文端名（卡片文案用；只做显示，不参与任何判据）。未登记的渠道原样回显渠道名。 */
const CHANNEL_CN = { web: 'GUI', feishu: '飞书', wechat: '微信' };

/** 该渠道能不能在渠道里回答（未登记 ⇒ false，见上） */
export function channelAnswerable(channel) {
  return CHANNEL_ANSWER_SUPPORT[String(channel || '')] === true;
}

// ── 待答卡片的读侧：按会话找卡片 ────────────────────────────────────────────────────────────────
/**
 * 某个会话此刻挂着的待答卡片（按 created 升序；只读快照）。
 * 会话归属来自 `createAsk` / `createApproval` 的 `{conversationId}` 参数（`server/tools/index.js` 接线，
 * 那是工具侧唯一知道"这一轮属于哪个会话"的地方）。
 * @param {number|string} conversationId
 * @returns {Array<{kind:'ask'|'approval', id:string, conversationId:number, createdAt:number}>}
 */
export function pendingCards(conversationId) {
  const cid = Number(conversationId);
  if (!cid) return [];
  const asks = listPendingAsks()
    .filter((p) => Number(p.conversationId) === cid)
    .map((p) => ({ ...p, kind: 'ask' }));
  const approvals = listPending()
    .filter((p) => Number(p.conversationId) === cid)
    .map((p) => ({ ...p, kind: 'approval' }));
  return [...asks, ...approvals].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

// ── 卡片文案与回答解析（渠道是纯文本通道，没有按钮；这套词表就是"渠道里的回答协议"）────────────────
/**
 * 卡片 → 渠道可发的纯文本。刻意最短：渠道里只有文字，多一个字段就多一处要维护的协议。
 * 两种输入形状都要认（**文案只有一份**，所以归一放在这里）：
 *   · 待答队列项（`pendingCards()`）：带 `kind`（'ask'/'approval'）；
 *   · 引擎事件（`runChannelTurn` 的 onCard 拿到的）：带 `type`，值同名。
 * @param {{kind?:string, type?:string, question?:string, options?:Array<{label:string,value:string}>, desc?:string}} card
 */
export function cardText(card) {
  if (!card) return '';
  const kind = card.kind || card.type;
  if (kind === 'ask') {
    const lines = (card.options || []).map((o, i) => (i + 1) + ') ' + String(o.label));
    return '❓ ' + String(card.question || '') + '\n' + lines.join('\n')
      + '\n\n回复编号或选项内容即可（回答后本轮会接着往下跑）。';
  }
  return '⚠️ ' + String(card.desc || '') + '\n\n回复「批准」或「拒绝」。';
}

/** 回答确认（人在渠道里答上之后回执；真正的回复由被唤醒的那一轮自己发） */
export function answerAckText(result) {
  if (!result || !result.answered) return '（这条消息没有对应到待答卡片）';
  return result.kind === 'ask'
    ? '✅ 已回答：' + result.value + '。本轮会接着往下跑。'
    : '✅ 已' + (result.value === 'approve' ? '批准' : '拒绝') + '。本轮会接着往下跑。';
}

const APPROVE_WORDS = ['approve', '批准', '同意', 'yes', 'y'];
const REJECT_WORDS = ['reject', '拒绝', 'no', 'n'];

/**
 * 把渠道里的一句文本对到一张卡片上（纯函数，无副作用）。
 * 识别不了就返回 null —— **不猜**：宁可当普通消息（照常跑一轮），也不把一句无关的话当成裁决。
 * @returns {string|null} 选择的 option.value / 'approve' / 'reject'
 */
function parseAnswer(card, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (card.kind === 'ask') {
    const opts = card.options || [];
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= opts.length) return String(opts[n - 1].value);
    const hit = opts.find((o) => String(o.value).toLowerCase() === low || String(o.label).toLowerCase() === low);
    return hit ? String(hit.value) : null;
  }
  if (APPROVE_WORDS.includes(low)) return 'approve';
  if (REJECT_WORDS.includes(low)) return 'reject';
  return null;
}

/**
 * 人在渠道里的回答 → 裁决。**这一条就是"跨端一致"的接口**：
 * 它不自己做任何裁决，只是按会话找到卡片，然后调 `decideAsk` / `decideApproval`
 * （`POST /api/asks/:id`、`POST /api/approvals/:id` 调的就是这两个函数 ⇒ 回答之后"该轮次恢复执行"
 * 与 GUI 路径走的是**同一条路**，不是两条实现长得像）。
 * @param {number|string} conversationId
 * @param {string} text 用户在渠道里发的原文
 * @returns {{answered:boolean, kind?:string, id?:string, value?:string, conversationId:number, reason?:string}}
 */
export function answerCard(conversationId, text) {
  const cid = Number(conversationId);
  for (const card of pendingCards(cid)) {
    const value = parseAnswer(card, text);
    if (value == null) continue;
    // 裁决函数只有那一对（asks.js / approval.js 各一个）；这里**不碰**待答队列本身
    const decided = card.kind === 'ask' ? decideAsk(card.id, value) : decideApproval(card.id, value);
    if (decided) return { answered: true, kind: card.kind, id: card.id, value, conversationId: cid };
    // 卡片在"列出"与"裁决"之间被别处答掉/超时了：接着看下一张，不假装答上了
  }
  return { answered: false, conversationId: cid, reason: 'no-pending-match' };
}

// ── 列表侧：给待答项带上"属于哪个会话、在哪一端等回答" ─────────────────────────────────────────────
/**
 * 给待答项补上路由事实（`GET /api/approvals` / `GET /api/asks` 用）。
 * 只**追加**字段，不改既有字段的含义/类型（契约 §6 规则 1：只增不改、新字段可选）。
 *
 * 读不到会话行时**不阻断列表**（观测面坏掉不该让人连卡片都看不见）：`channel` 如实给 null 并出声，
 * `channelAnswerable` 随之 false —— "查不到"就说查不到，不假装这个渠道能答。
 * @param {Array<{conversationId?:number|null}>} items
 * @param {{db?:object}} [o] db 是夹具缝（默认真库）
 */
export async function attachCardRoutes(items, { db = realDb } = {}) {
  const list = Array.isArray(items) ? items : [];
  const ids = [...new Set(list.map((i) => Number(i.conversationId)).filter((n) => Number.isFinite(n) && n > 0))];
  const route = new Map();
  if (ids.length) {
    try {
      const rows = await db.query(
        'SELECT id, channel, external_id FROM conversations WHERE id IN (' + ids.map(() => '?').join(',') + ')', ids);
      for (const r of rows || []) {
        route.set(Number(r.id), { channel: r.channel || null, externalId: r.external_id == null ? null : String(r.external_id) });
      }
    } catch (e) {
      console.warn('[cards] 待答卡片的渠道路由读取失败（列表照常返回，channel 如实为 null）：' + String((e && e.message) || e));
    }
  }
  return list.map((it) => {
    const cid = it.conversationId == null ? null : Number(it.conversationId);
    const r = cid ? route.get(cid) : null;
    const channel = r ? r.channel : null;
    return {
      ...it,
      conversationId: cid,                        // 归属会话（链到 GUI 的入口）
      channel,                                    // 'web' / 'feishu' / 'wechat'；查不到为 null
      channelName: channel ? (CHANNEL_CN[channel] || channel) : null,
      externalId: r ? r.externalId : null,        // 渠道侧的对端 id（会话行既有列，不新造）
      channelAnswerable: channelAnswerable(channel), // 能不能"在渠道里答"（未登记 ⇒ false，见上）
    };
  });
}
