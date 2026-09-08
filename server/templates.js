// server/templates.js - ⑥ 任务模板库 v1（§6.5/D9 半成品：应用=模板，模板=档案+技能+验收+说明）
// 文件权威：templates/<key>/tpl.json 随仓库 git 管理；本模块纯读写文件+纯函数装配，不碰 DB。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const TEMPLATES_ROOT = path.join(ROOT, 'templates');
const REQUIRED = ['key', 'name', 'description'];

export function isTplKeyOk(key) {
  return typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(key);
}

// 校验模板包结构（服务端与测试共用）
export function validateTemplate(t) {
  const errs = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: ['模板必须为对象'] };
  for (const k of REQUIRED) if (t[k] === undefined || t[k] === '') errs.push('缺必填: ' + k);
  if (t.key !== undefined && !isTplKeyOk(t.key)) errs.push('key 非法（小写字母数字-）: ' + t.key);
  if (t.taskProfile && t.taskProfile.key && !isTplKeyOk(t.taskProfile.key)) errs.push('taskProfile.key 非法');
  return { ok: errs.length === 0, errors: errs };
}

// 扫描 templates/*/tpl.json → 列表（轻量摘要）
export function listTemplates() {
  const out = [];
  if (!fs.existsSync(TEMPLATES_ROOT)) return out;
  for (const dir of fs.readdirSync(TEMPLATES_ROOT)) {
    const p = path.join(TEMPLATES_ROOT, dir, 'tpl.json');
    if (!fs.existsSync(p)) continue;
    try {
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = validateTemplate(t);
      if (!v.ok) { out.push({ key: dir, error: v.errors.join('; ') }); continue; }
      out.push({
        key: t.key,
        name: t.name,
        description: String(t.description || ''),
        targetShell: t.targetShell || null,
        profileKey: (t.taskProfile && t.taskProfile.key) || null,
        skills: Array.isArray(t.skills) ? t.skills : [],
        checks: ((t.acceptanceTemplate && t.acceptanceTemplate.checks) || []).length,
      });
    } catch (e) { out.push({ key: dir, error: '解析失败: ' + e.message }); }
  }
  return out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

// 读单模板完整内容（含 guide/acceptanceTemplate）
export function getTemplate(key) {
  if (!isTplKeyOk(key)) return null;
  const p = path.join(TEMPLATES_ROOT, key, 'tpl.json');
  if (!fs.existsSync(p)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    const v = validateTemplate(t);
    return v.ok ? t : null;
  } catch { return null; }
}

// 壳内"从模板开任务"提示词装配：模板 → 可直接作为对话开任务指令的文本
// （含档案点名 + 技能载入提示 + 验收要点；档案实际生效依赖壳已含该 taskProfile——见 applyTemplate）
export function buildLaunchPrompt(tpl, userGoal = '') {
  const lines = [];
  if (tpl.taskProfile && tpl.taskProfile.key) {
    lines.push('【任务档案】按"' + (tpl.taskProfile.name || tpl.taskProfile.key) + '"档案处理：' + (tpl.taskProfile.modelHint ? '建议模型 ' + tpl.taskProfile.modelHint.defaultProvider + '/' + tpl.taskProfile.modelHint.defaultModel : ''));
  }
  if (Array.isArray(tpl.skills) && tpl.skills.length) {
    lines.push('【技能】载入技能：' + tpl.skills.join('、'));
  }
  if (tpl.acceptanceTemplate && Array.isArray(tpl.acceptanceTemplate.checks) && tpl.acceptanceTemplate.checks.length) {
    lines.push('【验收要点】' + tpl.acceptanceTemplate.checks.map((c, i) => (i + 1) + ') ' + c).join('；'));
  }
  if (tpl.guide) lines.push('【说明】' + String(tpl.guide));
  if (userGoal.trim()) lines.push('【本次任务】' + String(userGoal).trim());
  return lines.join('\n');
}

// 模板 → 可 import 到壳 pack 的 taskProfile 片段（前端"克隆为壳档案"用）
export function toProfileFragment(tpl) {
  const tp = tpl.taskProfile;
  if (!tp || !tp.key) return null;
  return {
    key: tp.key,
    name: tp.name || tp.key,
    match: Array.isArray(tp.match) ? tp.match : [],
    modelHint: tp.modelHint || {},
    ...(tp.readonlyOnly ? { readonlyOnly: true } : {}),
  };
}
