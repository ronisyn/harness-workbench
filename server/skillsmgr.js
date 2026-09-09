// server/skillsmgr.js - A5 技能库管理（§8.6：skills/<名>/SKILL.md 文件权威 + 三层校验）
// 三层校验：①静态（frontmatter/正文/占位符）②冲突（与既有技能 description 语义重叠、工具命名空间）③运行回环（存后一次会话载入验证）
// 停用：frontmatter enabled:false 软停（skills_list/load 跳过，文件保留）；删除=rm 目录（先停用观察再删）。
import fs from 'node:fs';
import path from 'node:path';
import { SKILLS_ROOT } from './tools/index.js';

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const PH_RE = /\[(?:内容已截断|原文 \d+ 字符已截断|已截断|参数已省略|上下文已裁剪)[^\]]*\]|_archived|tool_call_id\s*=/;

export function skillDir(name) { return path.join(SKILLS_ROOT, name, 'SKILL.md'); }
export function skillNameOk(name) { return NAME_RE.test(String(name || '')); }

// frontmatter 极简解析（与 tools/index parseSkillFront 同构；缺省=无 meta）
export function parseFront(full) {
  const meta = {};
  const m = String(full || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let body = String(full || '');
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    body = body.slice(m[0].length);
  }
  return { meta, body };
}

export function listSkillsMeta() {
  const out = [];
  if (!fs.existsSync(SKILLS_ROOT)) return out;
  for (const d of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = skillDir(d.name);
    if (!fs.existsSync(p)) continue;
    try {
      const { meta } = parseFront(fs.readFileSync(p, 'utf8'));
      const enabled = meta.enabled === undefined ? true : String(meta.enabled) !== 'false';
      out.push({
        name: d.name,
        description: meta.description || '(无简介)',
        version: meta.version || '1.0.0',
        when: meta.when || '', not: meta.not || '',
        enabled, bodyChars: fs.statSync(p).size,
      });
    } catch { /* 跳过损坏项 */ }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function getSkill(name) {
  if (!skillNameOk(name)) return null;
  const p = skillDir(name);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').slice(0, 32000);
  return { name, raw, ...parseFront(raw) };
}

// ①静态校验
export function layer1Static(name, content) {
  const errors = [];
  if (!skillNameOk(name)) errors.push('name 非法：需小写字母开头的字母数字-（2-42 位）');
  const { meta, body } = parseFront(content);
  if (!meta.description || !String(meta.description).trim()) errors.push('缺 frontmatter description（一句话说明何时用=软触发判据）');
  if (!body.trim()) errors.push('正文为空（需可执行步骤/说明）');
  if (!/name\s*:/i.test(String(content).split('---')[1] || '')) errors.push('缺 frontmatter name');
  if (PH_RE.test(content)) errors.push('正文疑似含截断/裁剪占位符污染，拒绝保存');
  const { steps } = meta;
  if (steps !== undefined) {
    const arr = typeof steps === 'string' ? steps.split(/[,，;；]/) : steps;
    if (Array.isArray(arr) && !arr.length) errors.push('frontmatter steps 为空数组');
  }
  return errors;
}

// ②冲突检查（warning 级，非阻断）：description 语义重叠 / 工具命名空间占用
export function layer2Conflict(name, content) {
  const warns = [];
  const { meta } = parseFront(content);
  const desc = String(meta.description || '').replace(/[，。、；\s]+/g, '|');
  const tokens = desc ? desc.split('|').filter((s) => s.length >= 3) : [];
  for (const s of listSkillsMeta()) {
    if (s.name === name) continue;
    const d = String(s.description || '').replace(/[，。、；\s]+/g, '');
    const hit = tokens.filter((t) => d.includes(t) || t.includes(s.description || ''));
    if (hit.length) warns.push(`与既有技能「${s.name}」description 语义重叠（${hit.slice(0, 2).join('、')}）——确认不是重复技能，建议合并或改描述`);
  }
  return warns;
}

// 写 SKILL.md（含 enabled 合并：更新时保留既有 enabled:false 除非显式给定）
export function saveSkill(name, content, { enabled } = {}) {
  const errors = layer1Static(name, content);
  if (errors.length) return { ok: false, errors };
  const dir = path.join(SKILLS_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const prev = getSkill(name);
  const prevEnabled = prev && prev.meta ? (String(prev.meta.enabled || '') === 'false' ? false : true) : true;
  const eff = enabled === undefined ? prevEnabled : enabled;
  let out = String(content).trimEnd() + '\n';
  if (eff === false) {
    // 追加/更新 enabled:false（frontmatter 已有则替换）
    if (/^---\r?\n/.test(out)) {
      out = out.replace(/^---\r?\n/, '---\n').replace(/\nenabled\s*:\s*(true|false)\n/, eff === false ? '\nenabled: false\n' : '');
      if (!out.includes('enabled: false')) out = out.replace(/^(---\r?\n)/, '$1enabled: false\n');
    } else {
      out = '---\nenabled: false\n---\n' + out;
    }
  }
  fs.writeFileSync(skillDir(name), out, 'utf8');
  return { ok: true, name, enabled: eff, conflictWarnings: layer2Conflict(name, out) };
}

export function setSkillEnabled(name, enabled) {
  const s = getSkill(name);
  if (!s) return { ok: false, message: '技能不存在' };
  if (String(s.meta.enabled || '') === 'false') enabled = false; // 已停用不可自动复活（防误操作，需手动编辑）
  return saveSkill(name, s.raw.replace(/^(---\r?\n)/, '---\n').replace(/\nenabled\s*:\s*false\n/, enabled ? '' : '\nenabled: false\n'), { enabled });
}

export function deleteSkill(name) {
  if (!skillNameOk(name)) return { ok: false, message: 'name 非法' };
  const dir = path.join(SKILLS_ROOT, name);
  if (!fs.existsSync(dir)) return { ok: false, message: '技能不存在' };
  const s = getSkill(name);
  if (s && String(s.meta.enabled || '') !== 'false') return { ok: false, message: '删除前请先停用（enabled:false 观察）；停用后再删' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
