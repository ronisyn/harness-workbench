// server/apps.js - D9 应用形态 v1（壳内启动式应用=业务单元入口包；§6.5/D9）
// 文件权威：apps/<key>/app.json 随仓库 git 管理；应用=persona+entryProfile+skills+acceptance+openingPrompt。
// 与模板库关系：模板=应用"半成品"（档案+技能+验收）；应用在此之上加 persona 与开场，成为可一键启动的业务入口。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { isTplKeyOk } from './templates.js';

export const APPS_ROOT = path.join(ROOT, 'apps');
const REQUIRED = ['key', 'name', 'description'];

export function isAppKeyOk(key) {
  return isTplKeyOk(key); // 同小写字母数字-规范
}

export function validateApp(a) {
  const errs = [];
  if (!a || typeof a !== 'object') return { ok: false, errors: ['应用必须为对象'] };
  for (const k of REQUIRED) if (a[k] === undefined || a[k] === '') errs.push('缺必填: ' + k);
  if (a.key !== undefined && !isAppKeyOk(a.key)) errs.push('key 非法（小写字母数字-）: ' + a.key);
  if (a.entryProfile && a.entryProfile.key && !isAppKeyOk(a.entryProfile.key)) errs.push('entryProfile.key 非法');
  return { ok: errs.length === 0, errors: errs };
}

// 扫描 apps/*/app.json → 列表摘要
export function listApps() {
  const out = [];
  if (!fs.existsSync(APPS_ROOT)) return out;
  for (const dir of fs.readdirSync(APPS_ROOT)) {
    const p = path.join(APPS_ROOT, dir, 'app.json');
    if (!fs.existsSync(p)) continue;
    try {
      const a = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = validateApp(a);
      if (!v.ok) { out.push({ key: dir, error: v.errors.join('; ') }); continue; }
      out.push({
        key: a.key,
        name: a.name,
        description: String(a.description || ''),
        targetShell: a.targetShell || null,
        entryProfileKey: (a.entryProfile && a.entryProfile.key) || null,
        skills: Array.isArray(a.skills) ? a.skills : [],
        checks: ((a.acceptance && a.acceptance.checks) || []).length,
        hasOpening: Boolean(a.openingPrompt),
      });
    } catch (e) { out.push({ key: dir, error: '解析失败: ' + e.message }); }
  }
  return out.sort((x, y) => String(x.key).localeCompare(String(y.key)));
}

// 读应用全量
export function getApp(key) {
  if (!isAppKeyOk(key)) return null;
  const p = path.join(APPS_ROOT, key, 'app.json');
  if (!fs.existsSync(p)) return null;
  try {
    const a = JSON.parse(fs.readFileSync(p, 'utf8'));
    return validateApp(a).ok ? a : null;
  } catch { return null; }
}

// 启动草稿：把 persona（开场人格）+ openingPrompt（引导用户输入）合成"启动会话的预填消息"。
// 用户可在对话页编辑后发送 = 应用语境进入本轮对话（走既有 /api/chat，不建第二套会话体系）。
export function buildLaunchDraft(app, goal = '') {
  const parts = [];
  if (app.persona) parts.push('【应用人格】' + String(app.persona));
  if (app.openingPrompt) parts.push('【应用开场】' + String(app.openingPrompt));
  const extra = [];
  if (app.entryProfile && app.entryProfile.key) extra.push('按【' + (app.entryProfile.name || app.entryProfile.key) + '】业务档案处理');
  if (Array.isArray(app.skills) && app.skills.length) extra.push('载入技能：' + app.skills.join('、'));
  if (Array.isArray(app.acceptance?.checks) && app.acceptance.checks.length) {
    extra.push('验收要求：' + app.acceptance.checks.map((c, i) => (i + 1) + ') ' + c).join('；'));
  }
  if (extra.length) parts.push('【应用约定】' + extra.join('；'));
  if (goal.trim()) parts.push('【本次目标】' + String(goal).trim());
  return parts.join('\n');
}

// 应用 → 壳档案片段（复用模板 profile 结构；应用带档案时可选装配到目标壳）
export function toAppProfileFragment(app) {
  const ep = app.entryProfile;
  if (!ep || !ep.key) return null;
  return {
    key: ep.key,
    name: ep.name || ep.key,
    match: Array.isArray(ep.match) ? ep.match : [],
    modelHint: ep.modelHint || {},
    ...(ep.readonlyOnly ? { readonlyOnly: true } : {}),
  };
}
