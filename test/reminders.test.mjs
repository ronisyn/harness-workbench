// test/reminders.test.mjs —— 提醒投递接口夹具（2026-09-16）
//
// 依据：v0.3 §5「**提醒由产品层配置的通道投递，引擎提供通道接口**」。
// 本夹具锁四件事：
//   ① 注册/选择点的形状：未知实现名 **抛错**（不静默回落）；接口动词缺一个就在装配期抛；
//      `available()` 是 probe 口径（没配通道＝`configured:false` 这个**状态**，不是错误）；
//   ② 飞书实现在**假 transport** 下能投递一次（发出去的 to/文本/类型可断言）；
//   ③ **无供应商时的行为如实**：没配通道 ⇒ `deliver` 明确抛错；email/sms 只有位置 ⇒ 明确抛"没有实现"；
//      凭据缺失 / 缺收件人 / 缺正文 ⇒ 一律抛错，**绝不静默返回 ok**；
//   ④ 反向核对：提醒层没有第二份发信实现（飞书发信仍只有 `server/channels/feishu-webhook.js` 那一处），
//      且**没有**邮件/短信依赖被装进来（package.json 里不许出现 nodemailer/邮件短信 SDK）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_NAMES, IMPLEMENTED_NAMES, assertProvider, selectProvider,
  deliverReminder, remindersAvailable,
} from '../server/reminders/index.js';
import * as feishuImpl from '../server/reminders/feishu.js';
import { RW_REMINDER_CHANNEL } from '../server/env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── ① 注册 / 选择点的形状 ───────────────────────────────────────────────────────────────
test('提醒接口①：未知实现名抛错，不静默回落（与 exec/kbsearch 两个选择点同纪律）', () => {
  assert.deepEqual(PROVIDER_NAMES, ['feishu', 'email', 'sms'], '"有哪些通道"只有实现表这一个出处');
  assert.deepEqual(IMPLEMENTED_NAMES, ['feishu'], '本批只有飞书是真实现');
  assert.throws(() => selectProvider('telegram'), /未知提醒通道：telegram/, '未知名字必须抛错');
  // 没配 ⇒ null（"没通道"是状态，不是错误）；选择点不抛
  assert.equal(selectProvider(''), null);
  assert.equal(selectProvider(null), null);
  assert.equal(selectProvider(undefined), null, '缺省（RW_REMINDER_CHANNEL 为空）＝没通道');
  // 名字在表里、实现没接 ⇒ 抛错且说清"位置已留、未接供应商"
  assert.throws(() => selectProvider('email'), /没有实现.*位置已留/);
  assert.throws(() => selectProvider('sms'), /没有实现.*位置已留/);
  // 装配期校验：缺动词/缺 id 一律抛（不等到第一次投递才发现）
  assert.throws(() => assertProvider('x', { id: 'x', deliver: () => {} }), /缺动词 configured/);
  assert.throws(() => assertProvider('x', { configured: () => {}, deliver: () => {} }), /缺 id/);
  assert.equal(assertProvider('feishu', feishuImpl).id, 'feishu');
});

test('提醒接口②：available() 是 probe —— 没配通道如实报状态、不抛错、也不假装就绪', () => {
  const none = remindersAvailable({ provider: '' });
  assert.equal(none.configured, false);
  assert.equal(none.provider, null);
  assert.match(none.reason, /未配置提醒通道/);
  // 通道未配置＝RW_REMINDER_CHANNEL 的缺省值就是空串（本仓没有"默认通道"这回事）
  assert.equal(RW_REMINDER_CHANNEL, '');
  // 飞书：凭据缺 ⇒ configured:false + 原因；凭据全 ⇒ configured:true（probe 只看配置，不发消息）
  const noCred = remindersAvailable({ provider: 'feishu', providers: { feishu: { ...feishuImpl, configured: () => feishuImpl.configured({ env: {} }) } } });
  assert.equal(noCred.configured, false);
  assert.match(noCred.reason, /未配置飞书凭据/);
  const withCred = remindersAvailable({ provider: 'feishu', providers: { feishu: { ...feishuImpl, configured: () => feishuImpl.configured({ env: { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' } }) } } });
  assert.equal(withCred.configured, true);
  assert.equal(withCred.provider, 'feishu');
  // 名字写错时 available 如实报原因（不抛：probe 不该把只读检查变成异常）
  const bad = remindersAvailable({ provider: 'telegram' });
  assert.equal(bad.configured, false);
  assert.match(bad.reason, /未知提醒通道/);
});

// ── ③ 飞书实现：假 transport 下能投递一次 ────────────────────────────────────────────────
test('提醒接口③：飞书实现用假 transport 能投递一次（to / 文本 / 类型 / 返回形状可断言）', async () => {
  const sent = [];
  const transport = async (to, type, text) => { sent.push({ to, type, text }); return { code: 0, data: { message_id: 'om_123' } }; };
  const env = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'sec' };
  const r = await deliverReminder(
    { to: 'oc_chat_1', text: '任务 #42 今天 18:00 到期' },
    { provider: 'feishu', transport, env, providers: { feishu: { ...feishuImpl, configured: () => feishuImpl.configured({ env }) } } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'feishu');
  assert.equal(r.id, 'om_123', '发出去的凭据（message_id）要带回来，拿不到就 null——不编');
  assert.equal(sent.length, 1, '投递一次＝发一次');
  assert.equal(sent[0].to, 'oc_chat_1');
  assert.equal(sent[0].type, 'chat_id', '缺省接收者类型＝渠道回信一直在用的 chat_id');
  assert.equal(sent[0].text, '任务 #42 今天 18:00 到期', '正文原样送出去（截断口径在既有发信函数里，不在这里改）');
  // 接收者类型可覆盖（实现自己解释 to 的格式，引擎不拍）
  const sent2 = [];
  await feishuImpl.deliver({ to: 'ou_user', text: 'x', receiveIdType: 'open_id' },
    { transport: async (to, type, text) => { sent2.push({ to, type, text }); return {}; }, env });
  assert.equal(sent2[0].type, 'open_id');
});

// ── ④ 无供应商 / 缺参数：行为如实（明确报错，不静默吞）────────────────────────────────────
test('提醒接口④：没配通道 ⇒ 明确抛错；缺凭据/收件人/正文 ⇒ 同样抛错（绝不静默返回 ok）', async () => {
  await assert.rejects(() => deliverReminder({ to: 'x', text: 'y' }, { provider: '' }), /提醒通道未配置.*如实拒绝/);
  await assert.rejects(() => deliverReminder({ to: 'x', text: 'y' }, { provider: 'email' }), /没有实现/);
  await assert.rejects(() => deliverReminder({ to: 'x', text: 'y' }, { provider: 'nope' }), /未知提醒通道/);
  await assert.rejects(() => deliverReminder({ to: 'x', text: 'y' }), /提醒通道未配置/, '默认（未配）也是抛错，不静默跳过');
  // 实现内部的如实拒绝
  const transport = async () => { throw new Error('不该被调到'); };
  await assert.rejects(() => feishuImpl.deliver({ to: '', text: 'y' }, { transport, env: { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' } }), /缺少收件人/);
  await assert.rejects(() => feishuImpl.deliver({ to: 'x', text: '   ' }, { transport, env: { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' } }), /缺少正文/);
  await assert.rejects(() => feishuImpl.deliver({ to: 'x', text: 'y' }, { transport, env: {} }), /未配置飞书凭据/);
  // 实现自己投递失败 ⇒ 异常照传（本层不吞）
  await assert.rejects(
    () => feishuImpl.deliver({ to: 'x', text: 'y' }, { transport: async () => { throw new Error('飞书发送失败: 应用被停'); }, env: { FEISHU_APP_ID: 'a', FEISHU_APP_SECRET: 'b' } }),
    /飞书发送失败/,
  );
});

// ── 反向核对：没有第二份发信实现、没装邮件/短信依赖 ───────────────────────────────────────
test('提醒接口⑤（反向）：飞书发信只有一处实现；邮件/短信不写假实现、不装依赖', () => {
  const webhook = read('server/channels/feishu-webhook.js');
  assert.match(webhook, /export async function sendFeishuText\(/, '渠道发信函数必须是导出的（提醒层复用它）');
  // 全仓"往飞书发消息"的 HTTP 调用只允许出现在渠道文件里
  const senders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { walk(path.join(dir, e.name)); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = read(path.join(dir, e.name));
      if (/im\/v1\/messages/.test(src)) senders.push(path.join(dir, e.name).split(path.sep).join('/'));
    }
  };
  walk('server');
  assert.deepEqual(senders, ['server/channels/feishu-webhook.js'], '发飞书消息的实现只允许有一处（提醒层复用，不重写）');
  // 提醒层不许出现假的 email/sms 实现模块
  const files = fs.readdirSync(path.join(ROOT, 'server', 'reminders'));
  assert.deepEqual(files.sort(), ['feishu.js', 'index.js'], '本批只允许这两个文件（邮件/短信只有实现位置，不落地假模块）');
  // 依赖里不许有邮件/短信 SDK（v0.3 §0.6：本批不接外部供应商）
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
  const forbidden = deps.filter((d) => /nodemailer|mail|sms|twilio|sendgrid|aliyun|tencentcloud/i.test(d));
  assert.deepEqual(forbidden, [], '不许为邮件/短信装依赖：' + forbidden.join(', '));
  // 实现表里那两行必须是显式的 null（位置），而不是缺行或假对象
  const idx = read('server/reminders/index.js');
  assert.match(idx, /email:\s*null/, 'email 的实现位置必须显式留 null');
  assert.match(idx, /sms:\s*null/, 'sms 的实现位置必须显式留 null');
});
