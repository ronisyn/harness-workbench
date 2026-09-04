#!/usr/bin/env node
// scripts/apply-pack.mjs - 调教包一键应用（发行物：packs/rw-core → 实例）
// 用法: node scripts/apply-pack.mjs [--instance <root>] [--skills-dir <dir>] [--force]
// 默认 instance=仓库根（发行模板自应用校验）；skills-dir 默认 $RW_SKILLS 或 <instance>/skills
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] || '') : null; };
const INSTANCE = path.resolve(val('instance') || ROOT);
const SKILLS_DIR = path.resolve(val('skills-dir') || process.env.RW_SKILLS || path.join(INSTANCE, 'skills'));
const FORCE = args.includes('--force');
const PACK = path.join(ROOT, 'packs', 'rw-core');

const report = [];
const cp = (src, dst, isDir = false) => {
  if (isDir) {
    // 递归复制目录（packs 技能结构 skills/<名>/SKILL.md）
    const copyTree = (s, d) => {
      let n = 0;
      fs.mkdirSync(d, { recursive: true });
      for (const f of fs.readdirSync(s)) {
        if (f.startsWith('.')) continue;
        const sp = path.join(s, f);
        const dp = path.join(d, f);
        if (fs.statSync(sp).isDirectory()) { n += copyTree(sp, dp); continue; }
        if (fs.existsSync(dp) && !FORCE) { report.push(`⚠️ 已存在跳过: ${path.relative(ROOT, dp)}（--force 覆盖）`); continue; }
        fs.mkdirSync(path.dirname(dp), { recursive: true });
        fs.copyFileSync(sp, dp);
        report.push(`✅ ${path.relative(ROOT, dp)}`);
        n++;
      }
      return n;
    };
    return copyTree(src, dst);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst) && !FORCE) { report.push(`⚠️ 已存在跳过: ${path.relative(ROOT, dst)}（--force 覆盖）`); return 0; }
  fs.copyFileSync(src, dst);
  report.push(`✅ ${path.relative(ROOT, dst)}`);
  return 1;
};

if (!fs.existsSync(path.join(PACK, 'skills'))) { console.error('调教包不存在: ' + PACK); process.exit(2); }
console.log('== RW 调教包应用 ==\n  模板根:', ROOT, '\n  实例根:', INSTANCE, '\n  技能目录:', SKILLS_DIR, FORCE ? '(force)' : '');

// 1. 规则/模板文档 → 实例 docs/
const docSrc = path.join(ROOT, 'docs');
const RULE_DOCS = ['RW行为准则-服务器版.md', '信任契约-v1.md', '记忆架构.md', '权限与沙箱-服务器版.md', 'RW撑竿跳方案.md', '复盘模板.md', 'tool-contracts-v1.md'];
let docsOk = 0;
for (const d of RULE_DOCS) { if (fs.existsSync(path.join(docSrc, d))) docsOk += cp(path.join(docSrc, d), path.join(INSTANCE, 'docs', d)); }
cp(path.join(docSrc, 'templates', '验收模板.md'), path.join(INSTANCE, 'docs', 'templates', '验收模板.md'));

// 2. 技能 → 实例技能目录
const nSkills = cp(path.join(PACK, 'skills'), SKILLS_DIR, true);
report.push(`✅ 技能展开: ${nSkills} 个到 ${path.relative(ROOT, SKILLS_DIR)}`);

// 3. 代码内默认（护栏/schema/启用集）由代码版本保证——提示校验
report.push(`ℹ️ 代码内默认（settingsSchema/启用集/ENV_MAP）随发行版本一致，无需复制；.env/DB 差异位按 docs/RW发行物与调教包设计-v1.md §2.3 配置。`);

console.log('\n== 应用清单 ==');
for (const r of report) console.log('  ' + r);
const warn = report.filter((x) => x.startsWith('⚠️')).length;
console.log(`\n文档复制 ${docsOk} 项 / 技能 ${nSkills} 个；${warn} 项跳过（--force 可覆盖）。`);
console.log('下一步：node scripts/selfcheck.mjs + node scripts/kpi.mjs 初始化基线（见发行设计 §3）。');
