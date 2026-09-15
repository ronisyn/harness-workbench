// server/reminders/index.js —— 提醒投递层：**接口 + 单一选择点**（v0.3 §5
// 「提醒由产品层配置的通道投递，**引擎提供通道接口**」）。
//
// ── 这条边界是什么（v0.3 §5 / §6.2 边界铁律：引擎 / 平台 / 产品）─────────────────────────────
//   引擎负责：**一个与通道无关的投递接口**（`deliver(reminder)` / `available()`）＋ 一个唯一的选择点。
//   产品层负责：**投什么、投给谁、用哪个通道**（收件人、账号、通道选择都是产品侧配置）。
//   ⇒ 本模块只认一个中性对象 `reminder`（`{to, text, kind?}`），不认识"飞书 open_id""邮箱地址"的差别：
//     "to 长什么样"由实现自己解释——**引擎不替产品层拍这个格式**。
//   照 v0.3 §5 改前的写法是"提醒走飞书/邮件/短信"（把三个供应商写进了架构），现在是"通道可插拔"。
//
// ── 与本仓另两个选择点同形（先问规矩：DSH 是"接口包 + 实现包"，一个 host 只装一个实现）──────────
//   · `server/exec/index.js`    —— 实现表 + 装配期校验 + 未知名字抛错；
//   · `server/kbsearch/index.js` —— 同上 + "加一个实现＝写一个模块 + 加一行"；
//   · 本目录：接口动词只有两个，都是"现在真正要用的"（不预造）。
//
// ── 加一个供应商＝**写一个实现模块 + 在下面 PROVIDERS 表里加一行**（就这两步）────────────────
//   ① 写 `server/reminders/<name>.js`：导出 `{ id, label, configured(), deliver(reminder, opts) }`；
//      `deliver` 返回 `{ ok:true, provider, id?, detail? }`，**失败必须抛错**（不许 return ok:false 静默吞）；
//   ② 在 `PROVIDERS` 里加一行 `name: impl`，并在 `server/env.js` 注释里登记该名字。
//   ③ 部署时把 `RW_REMINDER_CHANNEL` 指过去即生效——**调用方一行都不用改**（这正是本轮接口的意义）。
//
// ── 现在有哪些实现（如实登记，不吹）───────────────────────────────────────────────────────
//   · `feishu` —— **唯一实现**，复用渠道那条发信路径（`server/channels/feishu-webhook.js` 的 `sendFeishuText`），
//     **没有重写**第二个发信器。真机未验证（本批没有条件发真消息；夹具用假 transport 断言"能投递一次"）。
//   · 邮件 / 短信 —— **只有实现位置**：`PROVIDERS` 里各留一行 `null`，`deliver` 会如实报
//     "没有实现：邮件（位置已留，未接供应商）"。**不写假实现、不装依赖**（v0.3 §0.6 明确不做 + 本批硬规则）。
//
// ── 没配通道时的行为（如实，不许静默吞）────────────────────────────────────────────────────
//   · `available()` → `{ configured:false, provider:null, ... }`（"没配"是**状态**，不是错误）；
//   · `deliver()`   → **明确抛错**（`通道未配置`）——调用方必须处理，绝不允许"看起来投出去了"。
import { RW_REMINDER_CHANNEL } from '../env.js';
import * as feishu from './feishu.js';

/** 一个投递实现必须提供的动词（装配期校验；照 §7.1 ③④「清单装配期校验、默认拒绝」的做法）。 */
const VERBS = ['configured', 'deliver'];

/**
 * 实现表 —— **唯一选择点**。
 * `null` ＝ **实现位置**（位置留着、供应商没接）：`available()` 会把它报成"没有实现"，
 * `deliver()` 抛明确错误。**不在这里写假实现**（假实现比不实现更坏：它会让人以为通道通了）。
 */
const PROVIDERS = {
  feishu,
  email: null,   // 位置：写 server/reminders/email.js（SMTP/供应商）+ 把这一行换成实现模块即生效
  sms: null,     // 位置：写 server/reminders/sms.js（短信供应商）+ 把这一行换成实现模块即生效
};
export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));   // "有哪些通道"只有这一个出处
export const IMPLEMENTED_NAMES = Object.freeze(Object.entries(PROVIDERS).filter(([, v]) => v).map(([k]) => k));

/** 校验一个实现是否满足接口（导出是为了可夹具：装配期校验本身也要能被机检，而不是只写在注释里）。 */
export function assertProvider(name, impl) {
  const missing = VERBS.filter((v) => typeof impl?.[v] !== 'function');
  if (!impl || typeof impl.id !== 'string' || missing.length) {
    throw new Error('提醒通道 ' + name + ' 不满足接口：' + (missing.length ? '缺动词 ' + missing.join('、') : '缺 id'));
  }
  return impl;
}

/**
 * 按名字取实现（**唯一选择点**）。三条如实语义：
 *   · 完全没配（空串/null/undefined）⇒ `null`（＝"没通道"这个状态本身，不是错误）；
 *   · 名字在表里但**没接实现**（email/sms）⇒ 抛错，错误里说明"位置已留、未接供应商"；
 *   · 名字不认识 ⇒ 抛错并列出可选名字。
 * **绝不静默回落**到任何默认通道（与 exec/storage/kbsearch 三个选择点同一条纪律）。
 */
export function selectProvider(name = RW_REMINDER_CHANNEL, providers = PROVIDERS) {
  const key = String(name == null ? '' : name).trim();
  if (!key) return null;
  if (!(key in providers)) {
    throw new Error('未知提醒通道：' + key + '（RW_REMINDER_CHANNEL 可选：' + Object.keys(providers).join(' / ') + '）；不静默回落到默认通道');
  }
  const impl = providers[key];
  if (!impl) {
    throw new Error('提醒通道「' + key + '」没有实现：位置已留在 server/reminders/（写一个实现模块 + 在实现表加一行即生效），'
      + '本批没有接它的供应商，也不提供假实现。可用的实现：' + (IMPLEMENTED_NAMES.join(' / ') || '（无）'));
  }
  return assertProvider(key, impl);
}

/**
 * 投递一条提醒（v0.3 §5 的 `deliver(reminder)`）。
 * @param {{to:any, text:string, kind?:string}} reminder 中性对象：`to` 的格式由实现解释（引擎不拍格式）
 * @param {{provider?:string|object, providers?:object, signal?:AbortSignal}} [opts]
 *   `provider` 收名字或**实现对象本身**（前者＝正常用法；后者是夹具缝，用来断言"注册/选择点的形状"，
 *   不必为了测接口去动全局选择）。
 * @returns {Promise<{ok:true, provider:string, id?:any, detail?:any}>}
 * @throws 没配通道 / 名字不认识 / 实现没接 / 实现自己投递失败（缺 `to`、缺 `text` 也在实现里如实抛）
 */
export async function deliverReminder(reminder, opts = {}) {
  const impl = resolveImpl(opts);
  return impl.deliver(reminder, opts);
}

/**
 * 当前通道就绪吗（**probe** 口径，照 `exec/local.js` 的 probe：只查配置，不真发消息）。
 * 没配通道也是**正常状态**（`configured:false`），不抛错——投递那一刻才该报错。
 */
export function remindersAvailable(opts = {}) {
  const p = opts.provider;
  // 没配通道（缺省/空串）⇒ 这就是"没通道"这个**状态**本身，不走选择点（选择点对"没配"返回 null；
  // 但对"名字写错/实现没接"是抛错，见下面 catch——"查不到"与"没配"是两件事，别混成一句）。
  if (!p && p !== undefined) {
    return {
      configured: false, provider: null,
      reason: '未配置提醒通道（RW_REMINDER_CHANNEL 为空）——引擎侧接口在位，通道由产品层配置',
      channels: PROVIDER_NAMES, implemented: IMPLEMENTED_NAMES,
    };
  }
  let impl;
  try { impl = resolveImpl(opts); }
  catch (e) { return { configured: false, provider: null, reason: String((e && e.message) || e) }; }
  if (!impl) {
    return {
      configured: false, provider: null,
      reason: '未配置提醒通道（RW_REMINDER_CHANNEL 为空）——引擎侧接口在位，通道由产品层配置',
      channels: PROVIDER_NAMES, implemented: IMPLEMENTED_NAMES,
    };
  }
  const c = impl.configured();
  return {
    configured: Boolean(c && c.ok),
    provider: impl.id,
    reason: (c && c.reason) || null,
    detail: (c && c.detail) || null,
    channels: PROVIDER_NAMES, implemented: IMPLEMENTED_NAMES,
  };
}

/** 解析这次要用哪个实现（名字 / 实现对象 / 未配置）。**唯一选择点**就在 `selectProvider`。 */
function resolveImpl(opts) {
  const p = opts.provider;
  if (p && typeof p === 'object') return assertProvider(p.id || 'inline', p);
  const chosen = p === undefined ? RW_REMINDER_CHANNEL : p;
  const impl = selectProvider(chosen, opts.providers || PROVIDERS);
  if (!impl) {
    throw new Error('提醒通道未配置：投递被如实拒绝（RW_REMINDER_CHANNEL 为空）。'
      + '可选实现：' + (IMPLEMENTED_NAMES.join(' / ') || '（无）') + '；未实现的供应商（email/sms）只有位置，本批不接。');
  }
  return impl;
}
