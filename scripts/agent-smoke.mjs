#!/usr/bin/env node
// scripts/agent-smoke.mjs - 端到端冒烟：**agent 到底还能不能用**（真模型 / 真工具 / 真写盘 / 真落账）
//
// 为什么要有它（2026-09-15 的教训，两次）：
//   本仓库已经两次栽在"主链路某处抛错、被一个静默 catch 吞掉"上：
//     ① `result is not defined` —— 每轮对话都在 done 之前中断（靠部署后 selfcheck 才发现）；
//     ② `hookStop is not defined` —— 工具照常执行（文件真写了），但 `tool_calls` 与 `tool:<名>` 审计
//        **一行都不落**，静默了 40 分钟，直到本脚本查库才暴露。
//   共同点：**单元测试不经过 server/index.js 与 execTool 的真实收尾路径**，只有"发一条真消息、再用工具、再查库"能挡住。
//
// 因此本脚本是**部署后第一件事**要跑的检查（selfcheck 只验证接口活着，验不了"账本有没有断"）。
// 判据（任一不过即退出码 1）：
//   1. 两轮对话都收到 done + run_end(status=saved)，无 error 帧
//   2. `run_end.capabilities.used` 里能看到本轮真正用过的工具
//   3. **工具调用必须落 tool_calls 账**（这条就是 ② 的回归锁）
//   4. 每轮都带两枚前缀指纹；同一会话的工具面指纹不来回翻
//
// 用法：node scripts/agent-smoke.mjs [baseUrl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../server/db.js';
// 探针要让 Agent 写/读的路径必须跟着工作区走：写死 /srv/rw-workspace 在客户机（Windows Server）上不存在。
import { RW_WORKSPACE } from '../server/env.js';
// 冒烟会话的标题走**统一声明**（`__probe__ …`）：原先的 `__smoke_agent__` 本来就命中探针族，这里改成
// 同一个出处，免得"每个脚本各写一份族字面量"（判据唯一实现在 server/cohort.js，见它导出的 probeTitle）。
import { probeTitle } from './cohort.mjs';

const argv = process.argv.slice(2);
const BASE = argv[0] || 'http://127.0.0.1:880';
// 账号文件放在**运行账户的家目录**（原来是写死的 /root/.rw-keys.env）：Linux 上服务以 root 跑时
// homedir 就是 /root，行为逐字节不变；Windows 客户机上则是服务账户的家目录——同一套写法两边都成立。
const KEYS_FILE = path.join(os.homedir(), '.rw-keys.env');
let user = process.env.RW_ADMIN_USER, pass = process.env.RW_ADMIN_PASS;
if (!user || !pass) {
  try {
    const env = fs.readFileSync(KEYS_FILE, 'utf8');
    const get = (k) => env.split('\n').find((l) => l.startsWith(k + '='))?.split('=').slice(1).join('=').trim();
    user = user || get('RW_ADMIN_USER'); pass = pass || get('RW_ADMIN_PASS');
  } catch { /* 环境不可用时走参数 */ }
}
if (!user || !pass) { console.error('缺账号：设 RW_ADMIN_USER/RW_ADMIN_PASS，或把两行写进 ' + KEYS_FILE); process.exit(2); }

const ok = [], fail = [];
const step = (name, cond, extra = '') => { (cond ? ok : fail).push(name); console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); };
const lg = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pass }) })).json();
step('登录', Boolean(lg.token), lg.token ? '' : JSON.stringify(lg).slice(0, 120));
if (!lg.token) { console.log('\n=== ' + ok.length + ' passed, ' + fail.length + ' failed ==='); process.exit(1); }
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lg.token };

const c = await (await fetch(BASE + '/api/conversations', { method: 'POST', headers: H, body: JSON.stringify({ title: probeTitle('smoke_agent') }) })).json();
step('建探针会话（标题命中探针族，不进任何口径）', Boolean(c.id), 'conv=' + c.id);
if (!c.id) { console.log('\n=== ' + ok.length + ' passed, ' + fail.length + ' failed ==='); process.exit(1); }
await db.query("UPDATE conversations SET permission='full' WHERE id=?", [c.id]);

async function chat(text) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ conversationId: c.id, content: text }) });
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const ev = {}; const types = new Set();
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const part of buf.split('\n\n')) {
      const line = part.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let j = null; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      types.add(j.type);
      if (j.type === 'done' || j.type === 'run_end' || j.type === 'error') ev[j.type] = j;
    }
  }
  return { ev, types: [...types], secs: (Date.now() - t0) / 1000 };
}

// ① 一轮任务式对话：必须真的调用工具（写盘 + 触发 after 钩子）
const r1 = await chat(`请在 ${path.join(RW_WORKSPACE, 'tmp')} 下写一个文件 smoke-agent.mjs，内容只有一行：export const ok = 1;  写完不要做别的。`);
step('对话一：收到 done 且无 error', Boolean(r1.ev.done) && !r1.ev.error, r1.ev.error ? r1.ev.error.message : r1.secs.toFixed(1) + 's');
step('对话一：run_end 落定', r1.ev.run_end && r1.ev.run_end.status === 'saved', r1.ev.run_end ? r1.ev.run_end.status : '（无 run_end）');
step('对话一：能力清单里能看到用过的工具', Boolean(r1.ev.run_end && r1.ev.run_end.capabilities && r1.ev.run_end.capabilities.used.length), JSON.stringify(r1.ev.run_end ? r1.ev.run_end.capabilities : null));
step('对话一：事件流完整（intent→run_start→…→done→run_end）',
  ['intent', 'run_start', 'tool_start', 'tool_done', 'done', 'run_end'].every((t) => r1.types.includes(t)), r1.types.join(','));

// ② 第二轮：读回来确认（用 read_file）
const r2 = await chat(`用 read_file 读回 ${path.join(RW_WORKSPACE, 'tmp', 'smoke-agent.mjs')}，确认内容后一句话回答。`);
step('对话二：收到 done 且无 error', Boolean(r2.ev.done) && !r2.ev.error, r2.ev.error ? r2.ev.error.message : r2.secs.toFixed(1) + 's');

// ③ **账本回归锁**：工具调用必须落 tool_calls（这是本脚本存在的首要理由）
const tcs = await db.query("SELECT tool_name, status, result_bytes FROM tool_calls WHERE conversation_id=? ORDER BY id", [c.id]);
step('工具调用已落 tool_calls 账（静默丢账的回归锁）', tcs.length >= 2,
  '落账 ' + tcs.length + ' 条：' + tcs.map((t) => t.tool_name + '/' + t.status).join('、'));
const audits = await db.query("SELECT COUNT(*) n FROM audit_log WHERE conversation_id=? AND action LIKE 'tool:%'", [c.id]);
step('工具调用已落 audit_log（tool:<名>）', Number(audits[0].n) >= 2, '落账 ' + audits[0].n + ' 条');

// ④ 前缀指纹与工具面稳定性
const rounds = await db.query("SELECT id, tokens_in, cache_hit_tokens, cache_miss_tokens, prefix_sys_hash s, prefix_tools_hash t FROM usage_stats WHERE conversation_id=? AND kind='round' ORDER BY id", [c.id]);
step('每轮都带前缀指纹', rounds.length > 0 && rounds.every((r) => r.s && r.t), rounds.length + ' 轮');
const faces = [...new Set(rounds.map((r) => r.t))];
step('同一会话的工具面不来回翻（会话内单向粘滞）', faces.length <= 2, '共 ' + faces.length + ' 种工具面：' + faces.join(','));
const rates = rounds.filter((r) => Number(r.cache_hit_tokens) + Number(r.cache_miss_tokens) > 0).map((r) => Number(r.cache_hit_tokens) / (Number(r.cache_hit_tokens) + Number(r.cache_miss_tokens)));
if (rates.length) {
  const med = [...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)];
  step('每请求命中率中位 ≥ 50%（冒烟只挡"整段全废"这种断崖）', med >= 0.5, '中位 ' + (med * 100).toFixed(2) + '% · ' + rates.map((x) => (x * 100).toFixed(1) + '%').join(' '));
}

console.log('\n=== ' + ok.length + ' passed, ' + fail.length + ' failed ===');
if (fail.length) console.log('未通过：' + fail.join('；'));
console.log('（探针会话 conv=' + c.id + ' 保留，供人工查看；清理见 scripts/probe-cleanup.js）');
process.exit(fail.length ? 1 : 0);
