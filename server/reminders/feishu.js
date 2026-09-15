// server/reminders/feishu.js —— 提醒通道实现：**飞书**（v0.3 §5；本目录的**唯一真实实现**）
//
// 复用既有渠道代码，**不重写第二个发信器**：真正发消息的就是
// `server/channels/feishu-webhook.js` 的 `sendFeishuText`（渠道回信用的是同一个函数）。
// 本文件只做三件事：① 报"这条通道配好没有"（凭据）；② 把中性 `reminder` 翻译成飞书的那次调用；
// ③ 把结果翻译回中性形状 `{ok, provider, id, detail}`。
//
// 为什么用**动态 import** 取 sendFeishuText：`feishu-webhook.js` 静态 import 了 `express` 与 `../db.js`
// （渠道服务要用的东西）。提醒接口不该因为"提醒"这件事把数据库连接池拉起来——所以默认传输在**第一次真要发**时才加载。
// 这也让夹具能塞一个假 transport（`deliver(reminder, { transport })`），不发真消息、不碰真库。

/** 实现身份（接口要求 `id`）。 */
export const id = 'feishu';
export const label = '飞书';

/** 飞书机器人凭据的判据**只有一处**：`server/tools/feishu.js` 的 `feishuConfigured()`（同一份事实不抄第二遍）。 */
async function feishuConfigured() {
  const m = await import('../tools/feishu.js');
  return m.feishuConfigured();
}

/** 默认 transport ＝既有渠道发信函数（动态取，见文件头）。 */
async function defaultTransport() {
  const m = await import('../channels/feishu-webhook.js');
  return (receiveId, receiveIdType, text, opts) => m.sendFeishuText(receiveId, receiveIdType, text, opts);
}

/**
 * 这条通道配好了吗（**probe**：只查凭据，不发消息）。
 * @param {{env?:object}} [opts] `env` 是夹具缝（不改 process.env 就能断言"没配凭据"那一臂），缺省读真实环境。
 */
export function configured(opts = {}) {
  const env = opts.env || process.env;
  const has = Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET);
  return has
    ? { ok: true, reason: null, detail: '已配置 FEISHU_APP_ID / FEISHU_APP_SECRET' }
    : { ok: false, reason: '未配置飞书凭据（FEISHU_APP_ID / FEISHU_APP_SECRET）：通道在位但发不出去', detail: null };
}

/**
 * 投递一条提醒（v0.3 §5 的 `deliver(reminder)`）。
 *
 * @param {{to:any, text:string, kind?:string, receiveIdType?:string}} reminder
 *   · `to` —— 飞书侧的接收者 id（open_id / chat_id / user_id 都行，由 `receiveIdType` 说明是哪一种，
 *     缺省 `chat_id`＝本仓渠道回信一直在用的那种）；
 *   · `text` —— 正文（引擎**不**在这里截断或改写；截断口径在 `sendFeishuText` 里，与渠道回信同一份）。
 * @param {{transport?:Function, receiveIdType?:string, signal?:AbortSignal, env?:object}} [opts]
 *   · `transport` —— 夹具缝：给一个假的发信函数就不发真消息（形状同 `sendFeishuText`）；
 *   · 凭据缺失、缺 `to`、缺 `text` —— **一律如实抛错**（不许静默吞：投递失败必须让调用方看见）。
 */
export async function deliver(reminder, opts = {}) {
  const r = reminder || {};
  if (r.to == null || String(r.to).trim() === '') throw new Error('飞书提醒投递失败：缺少收件人（reminder.to）——引擎不知道发给谁，如实拒绝');
  if (r.text == null || String(r.text).trim() === '') throw new Error('飞书提醒投递失败：缺少正文（reminder.text）——空提醒没有投递的意义，如实拒绝');
  const conf = configured(opts);
  if (!conf.ok) throw new Error('飞书提醒投递失败：' + conf.reason);

  const transport = opts.transport || await defaultTransport();
  const receiveIdType = opts.receiveIdType || r.receiveIdType || 'chat_id';
  const res = await transport(r.to, receiveIdType, String(r.text), { signal: opts.signal });
  return {
    ok: true,
    provider: id,
    // 飞书接口回的 message_id 是"这条真发出去了"的唯一凭据；拿不到就如实 null（不编一个 id）
    id: (res && (res.data?.message_id || res.message_id)) || null,
    detail: { receiveIdType },
  };
}
