// server/canary.js - A2 金标 canary（§7.4 自审登记②/§10 门禁：行为级"变更即跑"回环载体）
// 载体：<ROOT>/eval/<goldenSetRef>.json|.jsonl（随仓库 git 管理；shells.eval_ref=goldenSetRef 引用）。
//   文件结构：{ name?, items: [ { q, expectIntent?, expectTool?, expectExposed? } ] } 或逐行 JSON。
//   断言类型（确定性、零 LLM 成本，行为级=按壳意图词表/工具 schema 的真值判定）：
//     - expectIntent：classifyIntent(q, 壳词表) 与期望标签一致（动手普通 act / 高危 act-high / 只读 readonly / 闲聊 chat / 拿不准 ask）
//     - expectTool + expectExposed：按壳工具 schema（presetBase∩force 三态+启用集口径）该工具是否暴露
// 无金标集（goldenSetRef 为空或文件缺失）→ { skipped: true }，不报错——门禁目标态：金标集随壳评估沉淀后自动生效。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { db } from './db.js';
import { classifyIntent } from './intent.js';
import { toolDefs } from './tools/index.js';
import { PLATFORM_EXEMPT } from './tools/meta.js';

export const EVAL_ROOT = path.join(ROOT, 'eval');
const PLATFORM_EXEMPT_SET = new Set(PLATFORM_EXEMPT);
const INTENT_OK = ['act', 'act-high', 'readonly', 'chat', 'ask'];

// 解析金标文件（json 数组 / {items} / jsonl 逐行）
export function loadGoldenItems(goldenSetRef) {
  if (!goldenSetRef || typeof goldenSetRef !== 'string') return null;
  const safe = goldenSetRef.replace(/[^a-zA-Z0-9._/-]/g, '').replace(/^\/+/, '');
  if (!safe) return null;
  // 防目录穿越：只允许 <EVAL_ROOT>/<ref>(.json|.jsonl)
  const rel = safe.endsWith('.json') || safe.endsWith('.jsonl') ? safe : safe + '.json';
  const p = path.resolve(EVAL_ROOT, rel);
  if (!p.startsWith(path.resolve(EVAL_ROOT) + path.sep) || !fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  let items = [];
  if (p.endsWith('.jsonl')) {
    items = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  } else {
    const j = JSON.parse(raw);
    items = Array.isArray(j) ? j : (Array.isArray(j.items) ? j.items : []);
  }
  return items.map((it, i) => ({
    q: String((it && it.q) || ''),
    expectIntent: it && it.expectIntent,
    expectTool: it && it.expectTool,
    expectExposed: it && it.expectExposed !== undefined ? Boolean(it.expectExposed) : null,
    _i: i + 1,
  }));
}

// 获取壳词表（intent_rules JSON 列）
async function shellRules(shellId) {
  try {
    const [s] = await db.query('SELECT intent_rules FROM shells WHERE id=?', [shellId]);
    if (!s || s.intent_rules == null) return null;
    const r = typeof s.intent_rules === 'string' ? JSON.parse(s.intent_rules) : s.intent_rules;
    return r && typeof r === 'object' ? r : null;
  } catch { return null; }
}

// 按壳 schema 某工具是否暴露（与 /api/chat 同口径：会话 preset 缺省 all ∩ 壳 presetBase；forceOn 越级 / forceOff 移除；豁免仅绕过启用集、仍受档位约束）
export function shellToolExposed(shell, toolName) {
  const base = shell && shell.presetBase || 'standard';
  const on = shell && Array.isArray(shell.forceOn) ? new Set(shell.forceOn) : new Set();
  const off = shell && Array.isArray(shell.forceOff) ? new Set(shell.forceOff) : new Set();
  if (off.has(toolName) && !PLATFORM_EXEMPT_SET.has(toolName)) return false;
  const defs = toolDefs('all', null, { presetBase: base, forceOn: on, forceOff: off, mcpAllow: null });
  return defs.some((d) => d.function && d.function.name === toolName);
}

// 运行金标断言（确定性，无 LLM）
export async function runGoldenChecks(goldenSetRef, shell) {
  const items = loadGoldenItems(goldenSetRef);
  if (!items || !items.length) return { skipped: true, ref: goldenSetRef, reason: '金标文件缺失或为空' };
  const rules = shell && shell.id ? await shellRules(shell.id) : null;
  const results = items.map((it) => {
    if (!it.q) return { ...it, pass: false, got: '缺题面' };
    const want = [];
    const got = [];
    let pass = true;
    if (it.expectIntent) {
      if (!INTENT_OK.includes(it.expectIntent)) return { ...it, pass: false, got: 'expectIntent 取值非法' };
      const cl = classifyIntent(it.q, rules);
      want.push('意图=' + it.expectIntent);
      got.push('意图=' + (cl.label || '?'));
      if (cl.label !== it.expectIntent) pass = false;
    }
    if (it.expectTool) {
      const exposed = shellToolExposed(shell, it.expectTool);
      want.push('工具 ' + it.expectTool + (it.expectExposed === null ? ' 暴露' : it.expectExposed ? ' 暴露' : ' 不可见'));
      got.push('工具 ' + it.expectTool + (exposed ? ' 暴露' : ' 不可见'));
      if (it.expectExposed === null) { if (!exposed) pass = false; }
      else if (exposed !== it.expectExposed) pass = false;
    }
    return { q: it.q, expectIntent: it.expectIntent, expectTool: it.expectTool, expectExposed: it.expectExposed, pass, want: want.join(' & '), got: got.join(' & '), _i: it._i };
  });
  const passed = results.filter((r) => r.pass).length;
  return { skipped: false, ref: goldenSetRef, total: results.length, passed, results };
}
