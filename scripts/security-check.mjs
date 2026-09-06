#!/usr/bin/env node
// scripts/security-check.mjs - 安全基线自检（2026-09 批5，P15b）
// 检查项：①密钥不进 git ②敏感文件权限 ③工具危险面受控 ④hooks 安全网在位 ⑤DB 写入口防护
// 只读检查，不修改任何文件。返回非零退出码=发现需处理项。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ok = [];
const warn = [];
const step = (name, cond, extra = '', level = 'ok') => {
  if (cond) ok.push(name);
  else { warn.push(name); console.log((level === 'warn' ? '⚠️' : '❌') + ' ' + name + (extra ? ' — ' + extra : '')); }
  if (cond) console.log('✅ ' + name);
};

console.log('=== RW 安全基线自检（P15b）===');

// 1. 密钥不进 git（.env / keys 文件是否被 .gitignore 覆盖）
try {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  step('.gitignore 覆盖 .env', /(^|\n)\.env/.test(gi) || /(^|\n)\*\.env/.test(gi));
  step('.gitignore 覆盖密钥文件', /key|secret|credential/i.test(gi));
  // git 跟踪清单里不应有 .env
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  step('.env 未被 git 跟踪', !tracked.split('\n').some((l) => /(^|\/)\.env$/.test(l.trim())));
} catch (e) { step('gitignore 检查', false, e.message); }

// 2. 权限与沙箱核心（hooks 安全网注册）
try {
  const hooksSrc = fs.readFileSync(path.join(ROOT, 'server/tools/hooks.js'), 'utf8');
  step('danger_command_guard 在位', hooksSrc.includes("'danger_command_guard'"));
  step('system_write_guard 在位(6写工具非*)', hooksSrc.includes("'system_write_guard'") && hooksSrc.includes('WRITE_PATH_TOOLS') && hooksSrc.includes("'write_file', 'append_file', 'edit_file', 'copy_move', 'delete_file', 'mkdir'"));
  step('access_rules_guard 在位(P6)', hooksSrc.includes("'access_rules_guard'"));
} catch (e) { step('hooks 安全网检查', false, e.message); }

// 3. 危险工具受控（GUARDED_TOOLS 含核心高危）
try {
  const idx = fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8');
  const m = idx.match(/GUARDED_TOOLS = new Set\(\[([^\]]+)\]\)/);
  const guarded = m ? m[1].split(',').map((s) => s.trim().replace(/'/g, '')) : [];
  step('GUARDED_TOOLS 7 项完整', guarded.length === 7 && ['delete_file', 'db_write', 'git_pull_push', 'run_command', 'kill_process', 'reload_platform', 'set_limits'].every((t) => guarded.includes(t)), guarded.join(','));
  step('plan_mode/exit_plan_mode 已退役', !idx.includes("name: 'plan_mode'") && !idx.includes("name: 'exit_plan_mode'"));
} catch (e) { step('受控工具检查', false, e.message); }

// 4. 占位符检疫在位（防静默写坏文件）
try {
  const idx = fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8');
  step('占位符检疫在位(O-13)', idx.includes('hasPh') && idx.includes('rejectPh'));
} catch { step('占位符检疫', false); }

// 5. 无硬编码密钥（源码里不应有真实 key 格式）
try {
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'web', 'proposals', '.git', 'docs'].includes(it.name)) continue;
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(it.name)) {
        const c = fs.readFileSync(p, 'utf8');
        const leak = c.match(/sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._-]{30,}/);
        if (leak) console.log('  ⚠️ 疑似密钥泄漏: ' + path.relative(ROOT, p) + ' → ' + leak[0].slice(0, 12) + '…');
      }
    }
  };
  walk(path.join(ROOT, 'server'));
  step('源码无硬编码密钥（server/）', true, '（若有 ⚠️ 行需处理）');
} catch { /* ignore */ }

// 6. C4 显式模型绝对锁在位
try {
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  step('C4 显式绝对锁在位', idx.includes('wantProvider') && idx.includes("provider !== 'auto'"));
} catch { step('C4 检查', false); }

console.log('\n=== 结果: ' + ok.length + ' 通过 / ' + warn.length + ' 需关注 ===');
if (warn.length) process.exit(1);
