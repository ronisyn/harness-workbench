#!/usr/bin/env node
// scripts/release.mjs - 发布流水线雏形（2026-09 批5，P15）
// 用法: node scripts/release.mjs [--check-only]
// 流程：①语法全检 → ②前端构建 → ③selfcheck 冒烟（需服务器+账号）→ ④受控部署说明（git push/服务器 pull/reload 走 C5）
// 只做只读+校验+构建；部署动作（reload）由人工/C5 决策，脚本不自动执行。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check-only');
const ok = [];
const fail = [];
const step = (name, cond, extra = '') => {
  (cond ? ok : fail).push(name);
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
};
const run = (bin, a, opts = {}) => {
  try { execFileSync(bin, a, { cwd: ROOT, stdio: 'ignore', ...opts }); return true; }
  catch { return false; }
};

console.log('=== RW 发布流水线（P15 雏形）===');
// 1. 工作区干净（发布基线）
try {
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  step('工作区干净（无未提交改动）', st.trim() === '', st.trim() ? '有 ' + st.trim().split('\n').length + ' 项未提交' : '');
} catch { step('git 状态可读', false); }

// 2. 语法全检（server + scripts）
const codeFiles = [];
const walk = (d) => {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    if (it.name === 'node_modules' || it.name === 'web' || it.name === 'proposals' || it.name === '.git') continue;
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(it.name) && !p.includes('web/dist')) codeFiles.push(p);
  }
};
walk(path.join(ROOT, 'server')); walk(path.join(ROOT, 'scripts'));
let syntaxFail = 0;
for (const f of codeFiles) { if (!run('node', ['--check', f])) { syntaxFail++; console.log('  ❌ syntax ' + path.relative(ROOT, f)); } }
step('语法全检（server+scripts ' + codeFiles.length + ' 文件）', syntaxFail === 0, syntaxFail ? syntaxFail + ' 失败' : '');

// 2.5 安全基线自检（P15b：密钥/危险面/安全网/绝对锁）
const secOk = (() => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts/security-check.mjs')], { cwd: ROOT, stdio: 'inherit' }); return true; }
  catch { return false; }
})();
step('安全基线自检（security-check.mjs）', secOk);

// 3. 前端构建（vite build）
// 跨平台：直接 node 调 vite 的 js 入口（.cmd 在 Windows execFileSync 会 EINVAL）
const buildOk = (() => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch { return false; }
})();
step('前端构建（vite build）', buildOk);

// 4. 部署前检查：服务器活跃会话（只读提示，不自动 reload）
step('部署走 C5 受控（git push → 服务器 pull → 人工/受控 reload）', true, '本脚本不自动部署');

console.log('\n=== 结果: ' + ok.length + ' 通过 / ' + fail.length + ' 失败 ===');
if (fail.length) {
  console.log('失败项：' + fail.join(', '));
  process.exit(1);
}
if (!CHECK_ONLY) {
  console.log('\n发布检查通过。若需部署到服务器：');
  console.log('  1) git push origin main');
  console.log('  2) 服务器: cd /srv/harness-workbench && git pull origin main --no-rebase');
  console.log('  3) node --check 关键文件 + node scripts/selfcheck.mjs（真实冒烟）');
  console.log('  4) 确认无活跃会话后受控 reload（C5）');
}
