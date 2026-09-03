#!/usr/bin/env node
// scripts/verify.mjs - 统一验证入口（WS9：供 agent 与 driver 复用，带退出码）
// 用法:
//   node scripts/verify.mjs syntax <paths...>   JS 语法校验
//   node scripts/verify.mjs test <dir>           项目测试（有 package.json 跑 npm test）
//   node scripts/verify.mjs selfcheck            平台冒烟（调 selfcheck.mjs，需服务器）
//   node scripts/verify.mjs kpi [--days N]       调 kpi.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const run = (bin, a, opts = {}) => { try { const o = execFileSync(bin, a, { cwd: ROOT, stdio: 'inherit', ...opts }); return { ok: true, code: 0 }; } catch (e) { return { ok: false, code: typeof e.status === 'number' ? e.status : 1 }; } };

if (cmd === 'syntax') {
  if (!rest.length) { console.error('用法: verify.mjs syntax <paths...>'); process.exit(2); }
  let fail = 0;
  for (const p of rest) { const r = run('node', ['--check', path.resolve(ROOT, p)]); console.log((r.ok ? '✅' : '❌') + ' syntax ' + p); if (!r.ok) fail++; }
  process.exit(fail ? 1 : 0);
} else if (cmd === 'test') {
  const dir = rest[0] || '.';
  if (!fs.existsSync(path.join(ROOT, dir, 'package.json'))) { console.error('目录无 package.json: ' + dir); process.exit(2); }
  const r = run('npm', ['test'], { cwd: path.resolve(ROOT, dir) });
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'selfcheck') {
  const r = run('node', [path.join(ROOT, 'scripts/selfcheck.mjs'), ...rest]);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'kpi') {
  const r = run('node', [path.join(ROOT, 'scripts/kpi.mjs'), ...(rest.length ? rest : ['--days', '7'])]);
  process.exit(r.ok ? 0 : 1);
} else {
  console.error('用法: verify.mjs <syntax|test|selfcheck|kpi> [...]');
  process.exit(2);
}
