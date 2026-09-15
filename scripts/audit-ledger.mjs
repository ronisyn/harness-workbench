// scripts/audit-ledger.mjs - RA-36 过账清单逐项取证（只读）
// 口径：**只看实现代码 + 运行时事实**；文档表述不算"已做"的证据。
// 注意：本脚本**自身**要排除在扫描之外 —— 第一版把探针写成正则字面量，结果每个探针都匹配到了自己
// （"实现里找到了"其实是"脚本自己写了这个词"）。现在探针只以字符串存在，且显式跳过本文件。
// 用法：node scripts/audit-ledger.mjs
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';

const ROOT = process.cwd();
const SELF = path.relative(ROOT, path.join(ROOT, 'scripts', 'audit-ledger.mjs'));
const CODE_DIRS = ['server', 'scripts', 'src', 'apps', 'packs', 'shellpacks', 'test'];
const IGNORE = /(^|[\\/])(node_modules|\.git|dist|tmp|\.rw-checkpoints)([\\/]|$)/;
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (IGNORE.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|jsx|json|yml|yaml|conf|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = CODE_DIRS.flatMap((d) => walk(d)).filter((f) => path.relative(ROOT, f) !== SELF);
const find = (pat) => {
  const re = new RegExp(pat, 'i');
  const hits = [];
  for (const f of FILES) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const code = l.split('//')[0];
      if (code && re.test(code)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  return hits;
};
const show = (h, n = 3) => (h.length ? h.slice(0, n).join('  ') + (h.length > n ? `  …共${h.length}处` : '') : '**实现里没有**');

const settings = {};
for (const r of await db.query('SELECT skey, svalue FROM settings')) settings[r.skey] = r.svalue;
const tables = (await db.query('SHOW TABLES')).map((r) => Object.values(r)[0]);
const resultBytes = (await db.query('SELECT COUNT(*) n, SUM(result_bytes > 0) withBytes FROM tool_calls'))[0];
const ledger = await db.query("SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE 'prefix:%' GROUP BY action");

// 探针用字符串写，避免自匹配
const P = {
  dataView: '数据视窗|dataView|egressOnly',
  autoVerify: 'autoVerify|verifyBusiness',
  failClosed: 'failClosed',
  skillReview: 'skillReview',
  agentAdapter: 'AgentAdapter',
  costBaseline: 'costBaseline',
  sandbox: 'gVisor|codexExec',
  subagentDepth: 'noSubagent|DEPTH_MAX',
  spillBytes: 'SPILL_BYTES|resultBytesOf',
  injectGuard: 'injectionGuard|promptGuard',
  reviews: 'INSERT INTO reviews|submit_review',
  rolePackage: 'rolePackage',
  redact: 'redactSecrets',
  cmdGuard: 'danger_command_guard',
  enforcement: 'enforcement',
  spillCleanup: 'SPILL_DIR',
  hotReload: 'reloadManifest|syncMcpTools',
  hookRewrite: 'hookNote|payload\\.args',
};
const ITEMS = [
  ['OP-01', '数据出口唯一化', P.dataView, '平台侧为主'],
  ['OP-02', '自动验证谁读业务数据', P.autoVerify, '平台'],
  ['OP-03', '策略引擎失败语义', P.failClosed, '平台'],
  ['OP-04', '技能审核闸门', P.skillReview, '平台'],
  ['OP-05', 'AgentAdapter 契约成文', P.agentAdapter, 'agent'],
  ['OP-06', '三家引擎成本基线', P.costBaseline, 'agent'],
  ['OP-07', '外部前提实测（Codex/境内端点/沙箱）', P.sandbox, '平台+agent'],
  ['OP-08', '子代理深度实证（2 层够不够）', P.subagentDepth, 'agent'],
  ['OP-09', '配额缓冲/gVisor/等价物选型', 'quotaBuffer', '平台'],
  ['OP-10', 'spill 阈值标定 + 部分失效触发点', P.spillBytes, 'agent'],
  ['OP-11', '提示注入工程化', P.injectGuard, '平台+agent'],
  ['OP-12', '经验/复盘层归属', P.reviews, '平台'],
  ['OP-13', '岗位包定版', P.rolePackage, '平台'],
  ['OP-14', '脱敏机制', P.redact, '平台+agent'],
  ['OP-15', '命令策略能力边界', P.cmdGuard, '平台 / agent'],
  ['OP-16', '降级语义', P.enforcement, '平台+agent'],
  ['OP-17', '溢出文件清理策略', P.spillCleanup, '平台+agent'],
  ['OP-18', '热装载（本轮已完成）/ MCP 合流', P.hotReload, '平台+agent'],
  ['§16', 'hooks.js 参数改写与审计一致性', P.hookRewrite, 'agent'],
];
console.log('RA-36 过账清单逐项取证（只看实现代码 + 运行时事实；已排除本脚本自身）');
console.log('='.repeat(92));
for (const [id, name, pat, owner] of ITEMS) {
  console.log(`\n### ${id} ${name}   [owner: ${owner}]`);
  console.log('  证据：' + show(find(pat)));
}
console.log('\n' + '='.repeat(92));
console.log('运行时事实：');
console.log('  表：' + ['reviews', 'audit_log', 'tool_calls', 'agent_runs', 'contract_events'].map((t) => t + (tables.includes(t) ? '✓' : '✗')).join(' '));
console.log('  settings：' + ['toolset_enabled', 'collapse_window_ratio', 'task_budget_total', 'time_budget_min', 'access_rules']
  .map((k) => k + '=' + (settings[k] === undefined ? '未设置' : String(settings[k]).slice(0, 20))).join(' · '));
console.log('  tool_calls.result_bytes 覆盖：' + JSON.stringify(resultBytes));
console.log('  prefix 账本：' + (ledger.length ? ledger.map((r) => r.action + '=' + r.n).join(' ') : '（空）'));
process.exit(0);
