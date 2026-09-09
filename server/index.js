// server/index.js - Roni Workbench Express 入口 + API 路由
// P1 核心：登录 + 会话管理 + 多模型流式对话(SSE) + 工具启用集 + 用量统计
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT } from './config.js';
import { initSchema, db, bumpPolicyRev } from './db.js';
import { ensureAdmin, login, logout, me, requireAuth } from './auth.js';
import { activeProviders, allProviders, findProvider, syncChatModels } from './llm/providers.js';
import { calcCost } from './llm/gateway.js';
import { runAgent, activitySince, clearActivity } from './agent.js';
import { SKILLS_ROOT, TOOLS, redactSecrets } from './tools/index.js';
import { TOOL_META, DEFAULT_TOOLSET, PLATFORM_EXEMPT, TOOL_CN, TOOL_TIER_CN } from './tools/meta.js';
import { shellContext, rowToPack } from './shells.js';
import { classifyIntent } from './intent.js';
import { resolveTaskProfile } from './profile.js';
import { listShells, getShellByKey, importShell, cloneShell, disableShell, patchShell, shellTools, exportShell } from './shellstore.js';
import { runGoldenChecks, loadGoldenItems } from './canary.js';
import { SHELL_TEMPLATES } from './shelltemplates.js';
import { listSkillsMeta, getSkill, saveSkill, setSkillEnabled, deleteSkill, skillNameOk } from './skillsmgr.js';
import { parseKnowledgeUpload } from './knowledge.js';
import { listTemplates, getTemplate, buildLaunchPrompt, toProfileFragment, isTplKeyOk, validateTemplate, writeTemplateFile, cloneTemplate, removeTemplateDir, templateFilePath } from './templates.js';
import { listApps, getApp, buildLaunchDraft, toAppProfileFragment, isAppKeyOk } from './apps.js';
import { marketList, refreshMarket, connectModels, scheduleMarketRefresh } from './llm/market.js';
import { startWechatChannel } from './channels/wechat.js';
import { registerFeishuWebhook } from './channels/feishu-webhook.js';
import { startScheduler } from './scheduler.js';
import { startDriver } from './driver.js';
import { autoTitle } from './autotitle.js';
import { decideApproval, listPending } from './approval.js';
import { takeRestart, isRestartScheduled, markRestartScheduled } from './restart.js';
import { ensureRun, markRun, resumeHint, interruptStaleOnBoot } from './runtrack.js';
import { decideAsk } from './asks.js';
import { SETTINGS_SCHEMA, validateSetting } from './settingsSchema.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// 进程级兜底：DB/异步偶发 rejection 不拖垮整个平台（记录并保活；比 Node 默认崩溃更稳）
process.on('unhandledRejection', (reason) => console.error('[rw] unhandledRejection:', reason instanceof Error ? (reason.stack || reason.message) : reason));
process.on('uncaughtException', (err) => console.error('[rw] uncaughtException:', err && (err.stack || err.message)));

// 运行中 Agent 的中止表（前端"停止生成"→ POST /api/chat/stop 取消当前轮）
const abortMap = new Map(); // key = accountId:conversationId → AbortController
// 每账号并发对话计数（能力"并发限制"：默认同账号最多 3 条对话同时在跑）
const inflight = new Map(); // accountId → count

// reload_platform 协作：当前对话回复结束后自动重启服务（Agent 自我开发闭环，避免手动 restart 中断自己）
async function maybeSelfRestart() {
  const reason = takeRestart();
  if (!reason) return;
  if (isRestartScheduled()) return;
  markRestartScheduled();
  console.log('[rw] 自我重启请求:', reason, '—— 2 秒后执行（等当前回复落库）');
  setTimeout(async () => {
    try {
      const { execFile } = await import('node:child_process');
      const svc = process.env.RW_SERVICE || 'rw-test';
      const ch = execFile('systemctl', ['restart', svc], { detached: true, stdio: 'ignore' });
      ch.unref();
      console.log('[rw] 已触发 systemctl restart ' + svc);
    } catch (e) { console.error('[rw] 自动重启失败:', e.message); }
  }, 2000);
}

// ---------- 鉴权 ----------
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, message: '用户名和密码必填' });
    const r = await login(username, password);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await logout(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const h = req.headers.authorization || '';
  const u = await me(h.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true, user: u });
});

// ---------- 模型（已接入厂商） ----------
app.get('/api/models', requireAuth, async (req, res) => {
  // P7/F6c（2026-09 批3）：default_model 可配——settings default_model_<provider> 覆盖厂商硬编码默认模型
  const defs = await getSetting('default_models', null); // { glm: 'glm-5.3', deepseek: '...' }
  const over = (defs && typeof defs === 'object') ? defs : {};
  res.json({ ok: true, providers: activeProviders(config.keys).map((p) => ({ ...p, defaultModel: over[p.id] || p.defaultModel })) });
});

// M2-① 模型广场：models.enabled 启停（菜单闸门；显式会话锁不受影响——C4 显式=绝对锁不被覆盖）
// body { enabled: bool }；审计 model:toggle
app.put('/api/models/:id', requireAuth, async (req, res) => {
  try {
    const mid = Number(req.params.id) || 0;
    const enabled = req.body ? Boolean(req.body.enabled) : false;
    const r = await db.query('UPDATE models SET enabled=? WHERE id=?', [enabled ? 1 : 0, mid]);
    if (!r.affectedRows) return res.status(404).json({ ok: false, message: '模型不存在' });
    const m = (await db.query('SELECT id, model_id, name FROM models WHERE id=?', [mid]))[0];
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'model:' + (enabled ? 'enable' : 'disable'), String(m ? m.model_id : mid)]);
    res.json({ ok: true, id: mid, enabled });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- 能力开关（2026-09-09 移除：A/B/C 三组从未接线到运行时，属误导展示；真实可配=下方工具启用集 + 壳 tools 三态 + 权限/规则；capabilities 表已随迁移清理） ----------

// 5.3c 工具启用集（默认 DEFAULT_TOOLSET 28；平台豁免工具恒可用；设置→工具 勾选维护）
// 2026-09-09：真实工具列表人读化——遍历实际注册 TOOLS，附中文名/用途(meta when/not)/权限分级，取代误导性"能力开关"
app.get('/api/toolset', requireAuth, async (req, res) => {
  try {
    const saved = await getSetting('toolset_enabled', null);
    const list = Array.isArray(saved) ? saved : DEFAULT_TOOLSET;
    const enabled = new Set(list.filter((x) => typeof x === 'string'));
    const tools = TOOLS.map((t) => {
      const m = TOOL_META[t.name] || {};
      return {
        name: t.name,
        cn: TOOL_CN[t.name] || t.name,
        tier: m.tier || 'core',
        tierCn: TOOL_TIER_CN[m.tier || 'core'] || m.tier || '基础',
        permission: t.permission || 'read',
        when: m.when || '', not: m.not || '', ex: m.ex || '',
        platformExempt: PLATFORM_EXEMPT.includes(t.name),
        defaultOn: DEFAULT_TOOLSET.includes(t.name) || PLATFORM_EXEMPT.includes(t.name),
        enabled: enabled.has(t.name) || PLATFORM_EXEMPT.includes(t.name),
      };
    }).sort((a, b) => {
      const o = { core: 0, pro: 1, expert: 2 };
      return (o[a.tier] - o[b.tier]) || a.cn.localeCompare(b.cn, 'zh');
    });
    res.json({ ok: true, tools, defaultCount: DEFAULT_TOOLSET.length });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.put('/api/toolset', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (!Array.isArray(enabled)) return res.status(400).json({ ok: false, message: 'enabled 需为工具名数组' });
    const valid = new Set(TOOLS.map((t) => t.name));
    const clean = [...new Set(enabled)].filter((n) => valid.has(n) && !PLATFORM_EXEMPT.includes(n));
    await setSetting('toolset_enabled', clean);
    res.json({ ok: true, enabled: clean.length });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// A4 工具使用率看板（§8.5：tool_calls 实时统计 7/30 天调用数+失败数+均耗时，不加埋点；热度标签前端按占比呈现）
app.get('/api/toolusage', requireAuth, async (req, res) => {
  try {
    const days = [7, 30];
    const base = 'SELECT tool_name, COUNT(*) c, SUM(status="fail") fails, COALESCE(AVG(duration_ms),0) avgMs FROM tool_calls WHERE created_at > NOW() - INTERVAL ? DAY GROUP BY tool_name';
    const [d7, d30] = await Promise.all(days.map((d) => db.query(base, [d])));
    const cnOf = {};
    for (const t of TOOLS) { const m = TOOL_META[t.name] || {}; cnOf[t.name] = TOOL_CN[t.name] || t.name; }
    const map = (rows) => rows.map((r) => ({ tool: r.tool_name, cn: cnOf[r.tool_name] || r.tool_name, calls: Number(r.c), fails: Number(r.fails || 0), failRate: Number(r.c) ? Number(r.fails || 0) / Number(r.c) : 0, avgMs: Math.round(Number(r.avgMs || 0)) }));
    res.json({ ok: true, d7: map(d7), d30: map(d30) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// A5 技能库（§8.6：skills/<名>/SKILL.md 文件权威；三层校验①静态②冲突③运行回环；停用=enabled:false 软停）
app.get('/api/skills', requireAuth, async (req, res) => {
  try { res.json({ ok: true, skills: listSkillsMeta() }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.get('/api/skills/:name', requireAuth, async (req, res) => {
  try {
    const s = getSkill(req.params.name);
    if (!s) return res.status(404).json({ ok: false, message: '技能不存在' });
    res.json({ ok: true, skill: s });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// 保存（新建/更新；静态校验不过=400；返回冲突警告）
app.post('/api/skills/:name', requireAuth, async (req, res) => {
  try {
    const name = String(req.params.name || '');
    const content = String((req.body || {}).content || '');
    if (!skillNameOk(name)) return res.status(400).json({ ok: false, message: 'name 非法（小写字母数字连字符）' });
    if (!content) return res.status(400).json({ ok: false, message: 'content(SKILL.md 全文) 必填' });
    const r = saveSkill(name, content, { enabled: (req.body || {}).enabled });
    if (!r.ok) return res.status(400).json({ ok: false, message: '静态校验不过：' + r.errors.join('；') });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'skill:save', name + (r.enabled === false ? ' (enabled:false)' : '')]);
    res.json({ ok: true, name, enabled: r.enabled, conflictWarnings: r.conflictWarnings || [] });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// 停用/启用（软停：enabled:false；文件保留）
app.patch('/api/skills/:name', requireAuth, async (req, res) => {
  try {
    const enabled = (req.body || {}).enabled !== false;
    const r = setSkillEnabled(req.params.name, enabled);
    if (!r.ok) return res.status(400).json({ ok: false, message: r.message || '操作失败' });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, enabled ? 'skill:enable' : 'skill:disable', req.params.name]);
    res.json({ ok: true, name: req.params.name, enabled });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// 删除（须先停用）
app.delete('/api/skills/:name', requireAuth, async (req, res) => {
  try {
    const r = deleteSkill(req.params.name);
    if (!r.ok) return res.status(400).json({ ok: false, message: r.message || '删除失败' });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'skill:delete', req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
// 运行回环（第③层校验：存后跑一条真实会话载入技能，验证可载入+可执行初检；前台"保存并冒烟"用）
app.post('/api/skills/:name/smoke', requireAuth, async (req, res) => {
  try {
    const name = String(req.params.name);
    if (!skillNameOk(name)) return res.status(400).json({ ok: false, message: 'name 非法' });
    const s = getSkill(name);
    if (!s) return res.status(404).json({ ok: false, message: '技能不存在' });
    const acc = req.user.id;
    const conv = await db.query('INSERT INTO conversations (account_id, title, permission, preset) VALUES (?,?,?,?)', [acc, '技能冒烟:' + name, 'read', 'all']);
    const cid = conv.insertId;
    const result = await runAgent({
      provider: 'deepseek', model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '先 skill_load 载入技能 "' + name + '"，然后仅回答：已载入，技能适用场景是 ' + String(s.meta.description || '').slice(0, 200) + '。不要调用其它工具。' }],
      permission: 'read', ctx: { permission: 'read', accountId: acc, conversationId: cid, root: process.env.RW_WORKSPACE || '/srv/rw-workspace', __light: false }, keys: config.keys,
    });
    const ok = !result.error && !(result.guard) && (String(result.content || '').includes('已载入') || String(result.content || '').length > 20);
    const summary = String(result.content || result.error || '（无输出）').slice(0, 400);
    await db.query('DELETE FROM conversations WHERE id=?', [cid]).catch(() => {});
    for (const t of ['messages', 'tool_calls', 'usage_stats', 'agent_runs', 'conv_skills']) {
      try { await db.query(`DELETE FROM ${t} WHERE conversation_id=?`, [cid]); } catch { /* 个别表未建则跳过 */ }
    }
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [acc, 'skill:smoke', name + (ok ? ' PASS' : ' FAIL') + ' ' + summary.slice(0, 120)]);
    res.json({ ok: true, name, passed: ok, summary });
  } catch (e) { res.status(400).json({ ok: false, message: '冒烟异常: ' + e.message }); }
});

// ---------- 会话 ----------
app.get('/api/conversations', requireAuth, async (req, res) => {
  const rows = await db.query(
    'SELECT c.id, c.channel, c.permission, c.preset, c.title, c.provider, c.model, c.project, c.shell_id, s.skey AS shell_key, s.name AS shell_name, c.created_at, c.updated_at FROM conversations c LEFT JOIN shells s ON s.id = c.shell_id WHERE c.account_id=? OR (c.channel != "web" AND c.account_id IS NULL) ORDER BY c.updated_at DESC', [req.user.id]);
  res.json({ ok: true, conversations: rows });
});

app.post('/api/conversations', requireAuth, async (req, res) => {
  const { title, permission, preset, provider, model, project, shell } = req.body || {};
  // P24(O-22) permission 服务端白名单：非法值拒绝（原实现无校验，非法字符串在 checkPerm 静默全拒易踩坑）
  const perm = permission === undefined || permission === null ? 'full' : String(permission);
  if (!['read', 'write', 'guard', 'full'].includes(perm)) {
    return res.status(400).json({ ok: false, message: 'permission 需为 read|write|guard|full' });
  }
  // P25(O-25)：会话可指定 project（projects/<project>/AGENTS.md 项目记忆注入），缺省 default
  const proj = project === undefined || project === null ? 'default' : String(project).replace(/[\\/.]/g, '_').slice(0, 60) || 'default';
  // B1：会话可选指定壳（skey；缺失/禁用/非法 → NULL=默认壳语义，存量行为不变）
  let shellId = null;
  if (shell !== undefined && shell !== null && String(shell)) {
    const sr = (await db.query('SELECT id FROM shells WHERE skey=? AND status="enabled"', [String(shell)]))[0];
    shellId = sr ? sr.id : null;
  }
  const r = await db.query('INSERT INTO conversations (account_id, title, permission, preset, provider, model, project, shell_id) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, title || '新对话', perm, ['all', 'standard', 'minimal'].includes(preset) ? preset : 'all',
      provider || null, model || null, proj, shellId]);
  res.json({ ok: true, id: r.insertId, shellId });
});

app.patch('/api/conversations/:id', requireAuth, async (req, res) => {
  const { title, permission, preset, provider, model, project, shell } = req.body || {};
  const set = [], params = [];
  if (title !== undefined) { set.push('title=?'); params.push(title); }
  if (permission !== undefined) {
    if (!['read', 'write', 'guard', 'full'].includes(String(permission))) {
      return res.status(400).json({ ok: false, message: 'permission 需为 read|write|guard|full' });
    }
    set.push('permission=?'); params.push(permission);
  }
  if (project !== undefined) { set.push('project=?'); params.push(String(project).replace(/[\\/.]/g, '_').slice(0, 60) || 'default'); }
  if (preset !== undefined) { set.push('preset=?'); params.push(['all', 'standard', 'minimal'].includes(preset) ? preset : 'all'); }
  if (provider !== undefined) { set.push('provider=?'); params.push(provider || null); }
  if (model !== undefined) { set.push('model=?'); params.push(model || null); }
  // A2 会话挂壳：shell=''/'default'/null → 摘下（NULL=默认壳语义）；否则需为启用中的非 default 壳
  if (shell !== undefined) {
    const s = shell === null || shell === undefined || String(shell) === '' || String(shell) === 'default' ? '' : String(shell).trim();
    let shellId = null;
    if (s) {
      const sr = (await db.query('SELECT id FROM shells WHERE skey=? AND status="enabled" AND skey!="default"', [s]))[0];
      if (!sr) return res.status(400).json({ ok: false, message: '壳不存在或不可挂载（需为启用中的非 default 壳）' });
      shellId = sr.id;
    }
    set.push('shell_id=?'); params.push(shellId);
  }
  if (!set.length) return res.json({ ok: true });
  params.push(req.params.id, req.user.id);
  const r = await db.query(`UPDATE conversations SET ${set.join(',')}, updated_at=NOW() WHERE id=? AND account_id=?`, params);
  if (!r.affectedRows) return res.status(404).json({ ok: false, message: '会话不存在或无权修改' }); // E：与 DELETE 同口径
  if (shell !== undefined) {
    const detail = shell === undefined || shell === '' || shell === 'default' || shell === null ? 'detach' : 'attach=' + String(shell).trim();
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'conv:shell', 'conv=' + req.params.id + ' ' + detail]);
  }
  res.json({ ok: true });
});

app.post('/api/conversations/:id/autotitle', requireAuth, async (req, res) => {
  try { res.json(await autoTitle(req.params.id, req.user.id, !!req.body?.force)); }
  catch (e) { res.status(500).json({ ok: false, message: String(e.message) }); }
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  // P0-2 修复（2026-09 全面体检）：① 先校验会话归属，防越权删他人会话子表数据（原实现删 messages 无归属校验）
  // ② 级联清理全部子表：原实现只删 messages，遗留 tool_calls/usage_stats/agent_runs 等孤儿（实测 tool_calls 77% 为孤儿），污染用量统计口径
  const own = (await db.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]))[0];
  if (!own) return res.status(404).json({ ok: false, message: '会话不存在或无权删除' });
  // 孤儿防护（终审）：先中止该会话仍在执行的 agent（SSE 断连 abort 已发、但收尾落库可能与删除并发）——
  // 中止后 agent 收尾走 stopped 路径，配合落库前会话存在校验（原子 INSERT…SELECT WHERE EXISTS），杜绝"先删后写"孤儿
  try { const actrl = abortMap.get(req.user.id + ':' + req.params.id); if (actrl) actrl.abort('delete'); } catch { /* 忽略 */ }
  // 先删 conversations 行再清子表：会话行消失即向并发迟到写"关门"（存在校验即刻为假），随后子表删除按 id 全清
  await db.query('DELETE FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]);
  // 契约事件（contract_events 挂在 task_contracts 下、无 conversation_id）须先按其所属契约清理，避免孤儿
  try { await db.query('DELETE FROM contract_events WHERE contract_id IN (SELECT id FROM task_contracts WHERE conv_id=?)', [req.params.id]); } catch { /* 表未建则跳过 */ }
  for (const t of ['messages', 'tool_calls', 'usage_stats', 'agent_runs', 'conv_summaries', 'conv_skills', 'goals', 'knowledge', 'task_contracts', 'model_telemetry', 'reviews']) {
    try {
      await db.query(`DELETE FROM ${t} WHERE ${t === 'task_contracts' ? 'conv_id' : 'conversation_id'}=?`, [req.params.id]);
    } catch { /* 个别表未建则跳过 */ }
  }
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  // P0 归属校验：本人 或 渠道共享会话(account_id NULL 且非 web)——与会话列表口径一致，防枚举他人会话读消息
  const own = (await db.query('SELECT id FROM conversations WHERE id=? AND (account_id=? OR (channel != "web" AND account_id IS NULL))', [req.params.id, req.user.id]))[0];
  if (!own) return res.status(404).json({ ok: false, message: '会话不存在或无权查看' });
  const rows = await db.query('SELECT id, role, content, reasoning, model, provider, created_at FROM messages WHERE conversation_id=? ORDER BY id', [req.params.id]);
  res.json({ ok: true, messages: rows });
});

// 对话导出（Markdown，含思考/轨迹；前端亦可用本地 Blob 导出）
app.get('/api/conversations/:id/export', requireAuth, async (req, res) => {
  try {
    const conv = (await db.query('SELECT title, provider, model FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]))[0];
    if (!conv) return res.status(404).json({ ok: false, message: '会话不存在' });
    const ms = await db.query('SELECT id, role, content, reasoning, model, provider, tokens_in, tokens_out, created_at FROM messages WHERE conversation_id=? ORDER BY id', [req.params.id]);
    const tc = await db.query('SELECT message_id, tool_name, args, result_summary, status, duration_ms FROM tool_calls WHERE conversation_id=? ORDER BY id', [req.params.id]);
    // P26：?format=jsonl 机器可读导出（对齐 harness JSONL：消息+工具调用逐行 JSON，可回放/审计/迁移）
    if (req.query.format === 'jsonl') {
      const byMsg = {};
      for (const t of tc) if (t.message_id) (byMsg[t.message_id] = byMsg[t.message_id] || []).push(t);
      const rows = ms.map((m) => ({
        type: 'message', id: m.id, role: m.role, content: m.content,
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.model ? { model: m.model, provider: m.provider || null, tokens_in: m.tokens_in || 0, tokens_out: m.tokens_out || 0 } : {}),
        created_at: m.created_at,
        tool_calls: (byMsg[m.id] || []).map((t) => ({ tool: t.tool_name, args: safeJson(t.args), result: safeJson(t.result_summary), status: t.status, duration_ms: t.duration_ms || 0 })),
      }));
      return res.json({ ok: true, filename: (conv.title || '对话') + '.jsonl', content: rows.map((r) => JSON.stringify(r)).join('\n') });
    }
    const byMsg = {};
    for (const t of tc) if (t.message_id) (byMsg[t.message_id] = byMsg[t.message_id] || []).push(t);
    const lines = [];
    for (const m of ms) {
      lines.push('## ' + (m.role === 'user' ? '我' : 'AI') + '  \n');
      if (m.role === 'assistant') {
        if (m.reasoning) lines.push(m.reasoning.split('\n').filter(Boolean).map((l) => '> 🧠 ' + l).join('\n') + '  \n');
        const ts = byMsg[m.id] || [];
        for (const t of ts) lines.push(`> 🔧 ${t.tool_name}${t.status === 'fail' ? ' ✕' : ''}${t.result_summary ? '\n> ' + String(t.result_summary).slice(0, 200) : ''}  `);
        if (ts.length) lines.push('');
      }
      lines.push(String(m.content || '') + '\n\n---\n');
    }
    res.json({ ok: true, filename: (conv.title || '对话') + '.md', content: '# ' + (conv.title || '对话') + '\n\n' + lines.join('\n') });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }

// P26(O-30)：审计查询 API（audit_log 只写不读缺口）——单管理员场景默认返回全部；detail 再脱敏一次防残留
app.get('/api/audit', requireAuth, async (req, res) => {
  try {
    const n = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const q = String(req.query.q || '').trim();
    const cond = q ? ' WHERE action LIKE ? OR detail LIKE ?' : '';
    const p = q ? ['%' + q + '%', '%' + q + '%', n] : [n];
    const rows = await db.query('SELECT id, account_id, action, detail, created_at FROM audit_log' + cond + ' ORDER BY id DESC LIMIT ?', p);
    res.json({ ok: true, audit: rows.map((r) => ({ ...r, detail: r.detail ? redactSecrets(String(r.detail)) : r.detail })) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// 会话轨迹（工具调用记录）
app.get('/api/conversations/:id/toolcalls', requireAuth, async (req, res) => {
  const own = (await db.query('SELECT id FROM conversations WHERE id=? AND (account_id=? OR (channel != "web" AND account_id IS NULL))', [req.params.id, req.user.id]))[0];
  if (!own) return res.status(404).json({ ok: false, message: '会话不存在或无权查看' });
  const rows = await db.query('SELECT id, tool_name, args, result_summary, duration_ms, status, message_id, created_at FROM tool_calls WHERE conversation_id=? ORDER BY id DESC LIMIT 100', [req.params.id]);
  res.json({ ok: true, toolcalls: rows });
});

// 会话活动增量（事件环轮询：旁观/断连页面实时性；after=上次 seq）
app.get('/api/conversations/:id/activity', requireAuth, async (req, res) => {
  try {
    const own = await db.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [req.params.id, req.user.id]);
    if (!own.length) return res.status(404).json({ ok: false, message: '会话不存在' });
    const after = Number(req.query.after) || 0;
    const r = activitySince(req.params.id, after);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// 已接入厂商 + 模型（设置页展示；connected=该厂商 key 是否已配置，前端据此区分"已接入"与"未配置 Key"）
app.get('/api/providers', requireAuth, async (req, res) => {
  const providers = await db.query('SELECT id, provider_key, name, base_url, api_key_env, enabled FROM providers ORDER BY sort_order, id');
  const models = await db.query('SELECT id, provider_id, model_id, name, capabilities, enabled FROM models ORDER BY provider_id, model_id');
  const byProvider = {};
  for (const m of models) (byProvider[m.provider_id] = byProvider[m.provider_id] || []).push(m);
  res.json({
    ok: true,
    providers: providers.map((p) => ({ ...p, connected: Boolean(p.api_key_env && config.keys[p.api_key_env]), models: byProvider[p.id] || [] })),
  });
});

// M2-① 模型广场：厂商 key 临时连通测试（不落库——§8 凭证不进 DB 明文；仅本次请求内存使用）
// body { baseUrl, apiKey }；POST {base}/chat/completions 最小探测（1 token）
app.post('/api/providers/test', requireAuth, async (req, res) => {
  try {
    const { baseUrl, apiKey } = req.body || {};
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    const key = String(apiKey || '').trim();
    if (!base || !key) return res.status(400).json({ ok: false, message: 'baseUrl 与 apiKey 必填' });
    if (!/^https?:\/\//.test(base)) return res.status(400).json({ ok: false, message: 'baseUrl 需以 http(s):// 开头' });
    const probe = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: '__probe__', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (probe.status === 200) return res.json({ ok: true, status: probe.status, note: '连通' });
    const j = await probe.json().catch(() => ({}));
    // 400 通常=模型名非法但鉴权通过；401/403=key 无效
    const authed = ![401, 403].includes(probe.status);
    const hint = authed
      ? '鉴权通过但模型名被拒（400，正常：探测用假模型名）——需先用该厂商真实模型名再验'
      : ('鉴权失败（' + probe.status + '）：' + String(j.error?.message || j.message || '')).slice(0, 300);
    res.json({ ok: authed, status: probe.status, note: hint });
  } catch (e) {
    const msg = String(e && e.message || e);
    const dead = /fetch failed|ECONNREFUSED|ENOTFOUND|timed out|abort/i.test(msg);
    res.json({ ok: false, note: dead ? '无法连通：' + msg.slice(0, 200) : '测试异常：' + msg.slice(0, 200) });
  }
});

// ---------- 对话 ----------
// 普通对话不带 tools（模型自然回答，保持出厂自我认知）；检测到工具意图时走 Agent（function calling）
const TOOL_INTENT_RE = /(查|读|写|改|找|搜|看|打开|列出|创建|删除|复制|移动|执行|运行|命令|终端|数据库|sql|git|提交|推送|拉取|测试|语法|上传|下载|文件|目录|文件夹|路径|pdf|word|excel|ppt|ocr|图片|识别|飞书|文档|网址|http|网页|搜索|代码|编码|编程|脚本|优化|重构|修复|调试|部署|配置|接入|厂商|模型|安装|升级|维护|统计|用量|分析|检查|调研|了解|探索|护栏|限制|轮巡|轮次|时间预算|set_limits|reload_platform|技能|知识库|记忆|子代理|定时任务|目标|代码库|自审|断点|心跳|挂起|继续任务|恢复任务|现场|shell|环境信息|长任务|规划|计划模式|规划模式|退出计划|按计划执行|开始实施|进入计划|只读规划|立项|契约|任务单|验收|复测)/i;

function needsTools(content) {
  return TOOL_INTENT_RE.test(content);
}

// P1-F8 长对话摘要生成（懒加载：后台调 LLM 压缩早期消息）
async function generateSummary(provider, earlyText, conversationId) {
  try {
    const key = config.keys[findProvider(provider)?.keyEnv];
    const base = findProvider(provider)?.base;
    if (!key || !base) return;
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: findProvider(provider)?.defaultModel,
        messages: [
          { role: 'system', content: '请把以下早期对话压缩成简明中文摘要（保留：主题、关键决定、用户需求、文件路径、重要结论；200 字内）' },
          { role: 'user', content: earlyText.slice(0, 30000) },
        ],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await res.json().catch(() => ({}));
    const summary = j.choices?.[0]?.message?.content || '';
    // P25(O-27)：长对话摘要属旁路 LLM 消耗，入账（kind=summary），此前绕过 usage_stats
    try {
      const u = (j && j.usage) || {};
      const cowner = (await db.query('SELECT account_id FROM conversations WHERE id=?', [conversationId]))[0];
      const miss = u.prompt_cache_miss_tokens != null ? u.prompt_cache_miss_tokens : Math.max(0, (u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0));
      const cost = calcCost(provider, { hit: u.prompt_cache_hit_tokens || 0, miss, out: u.completion_tokens || 0 });
      await db.query('INSERT INTO usage_stats (account_id, conversation_id, provider_id, model_id, tokens_in, tokens_out, cache_hit_tokens, cache_miss_tokens, cost, duration_ms, created_at, kind) VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),"summary")',
        [cowner ? cowner.account_id : null, conversationId, provider, findProvider(provider)?.defaultModel || '', u.prompt_tokens || 0, u.completion_tokens || 0, u.prompt_cache_hit_tokens || 0, miss, cost, 0]);
    } catch { /* 计量失败不影响 */ }
    if (summary) {
      await db.query('INSERT INTO conv_summaries (conversation_id, summary, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE summary=VALUES(summary), updated_at=NOW()', [conversationId, summary]);
      console.log('[summary] 会话 ' + conversationId + ' 摘要已生成');
    }
  } catch (e) { console.error('[summary] 会话 ' + conversationId + ' 摘要失败:', e.message); }
}

// ---------- 设置读写（settings 表） ----------
async function getSetting(key, def) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', [key]);
    if (!r[0]) return def;
    try { return JSON.parse(r[0].svalue); } catch { return r[0].svalue; } // 兼容已 JSON 序列化与裸文本
  } catch { return def; }
}
async function setSetting(key, val, noBump) {
  await db.query('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()', [key, JSON.stringify(val)]);
  if (!noBump) await bumpPolicyRev(); // 政策版本自增：仅护栏/政策类键（运行时快照提示模型"规则已更新"）；普通参数高频调整不应使版本抖动
}

// ---------- 模型路由（F11 自动路由） ----------
const VISION_RE = /(图片|看图|照片|截图|识别.*图|vision|image)/i;
function resolveRoute(content, provider, model, defOverrides) {
  // C4 显式绝对锁（2026-09 批3）：provider 显式非 auto → 锁定该厂商（model 缺省用厂商 defaultModel），
  // 不允许被自动路由/视觉路由覆盖——用户选了 GLM 就是 GLM，5.2 都不行（契约六 C4）。
  if (provider && provider !== 'auto') {
    try {
      const p = findProvider(provider);
      if (!p) return { provider, model: model || '', note: '未知厂商（如实报错由 gateway 抛）' };
      // 显式厂商 + model 缺省 → 用厂商 defaultModel（P7：settings default_models 覆盖优先）；model 显式（非 __auto__）→ 原样用
      const defM = (defOverrides && defOverrides[provider]) || p.defaultModel;
      const m = (model && model !== '__auto__') ? model : defM;
      return { provider, model: m, note: model && model !== '__auto__' ? '显式模型' : '显式厂商默认模型' };
    } catch { return { provider, model: model || '' }; }
  }
  // 自动路由（provider=auto）：视觉需求 → 豆包视觉；非视觉 → 默认主力。
  // P25(O-28)：auto 分支读 settings default_models（P7"默认可配"对 auto 也生效），不再硬编码绕过配置
  let route;
  if (VISION_RE.test(content)) {
    const m = (defOverrides && defOverrides.ark) || 'doubao-seed-2-0-mini-260428';
    route = { provider: 'ark', model: m, note: '视觉任务→豆包视觉' };
  } else {
    const m = (defOverrides && defOverrides.deepseek) || 'deepseek-v4-flash';
    route = { provider: 'deepseek', model: m, note: '自动→DeepSeek V4 Flash' };
  }
  // 目标厂商未配 Key 时回落主力（防自动路由把对话带到不可用厂商）
  try {
    const p = findProvider(route.provider);
    if (!config.keys[p?.keyEnv]) route = { provider: 'deepseek', model: 'deepseek-v4-flash', note: '自动→' + route.provider + ' 未配置 Key，回落 DeepSeek' };
  } catch { /* 保持原路由 */ }
  return route;
}

// 费用=真实三档计费（calcCost，见 llm/gateway.js PRICE；与平台账单加权单价对齐）

app.post('/api/chat', requireAuth, async (req, res) => {
  let { conversationId, content, provider, model } = req.body || {};
  if (!conversationId || !content) return res.status(400).json({ ok: false, message: '参数缺失' });
  const convs = await db.query('SELECT id, permission, mode, preset, project, provider, model, shell_id FROM conversations WHERE id=? AND account_id=?', [conversationId, req.user.id]);
  if (!convs.length) { return res.status(404).json({ ok: false, message: '会话不存在' }); }
  const convProvider = (convs[0].provider === 'auto') ? null : (convs[0].provider || null);
  const convModel = (convs[0].model === '__auto__') ? null : (convs[0].model || null);
  // C4 显式模型绝对锁（2026-09 批3）：解析优先级 = ①body 显式传的 provider/model（用户本轮刚切换）→
  // ②会话已保存的 provider/model（用户此前选择，persist 在会话）→ ③档案→壳默认→全局默认（B3/F1）。
  // 关键修复：原实现只读 body（缺省默认 deepseek），完全忽略会话保存值 → 用户切 GLM 后若 body 丢参即静默回 deepseek=冒充（O-14）。
  // 显式选择（body 或会话里非 auto 的 provider）是绝对锁：不允许被自动路由/回退覆盖。
  // 'auto'/'__auto__' 是前端"自动路由"哨兵（C4=未显式选择语义）：归一为 null 才能继续走 B3 档案/F1 壳默认两级——
  // 否则 !wantProvider 恒 false，F1 壳默认与档案路由对 Web 主对话永不生效（审计 A，014609c×67e7a6a 接线冲突）。
  if (String(provider || '') === 'auto') provider = null;
  if (String(model || '') === '__auto__') model = null;
  let wantProvider = provider || convProvider;
  let wantModel = model || convModel;
  // P7/F6c：settings default_models（{厂商: 模型}）覆盖厂商硬编码默认
  let defOverrides = null;
  try { const dm = await getSetting('default_models', null); if (dm && typeof dm === 'object') defOverrides = dm; } catch { defOverrides = null; }
  // B1：解析会话所属壳（NULL=默认壳语义；非 default 且带 persona 时按总方案 §5.5 扩展语境——旧编号 v2.6 §1，2026-09-10 治理改指；不改内核自述）
  // 一次读取壳全字段：persona/domain/intent_rules/task_profiles/model_policy/tools —— 路由三级(档案/壳默认)与预算共用，避免多查询
  const convShellId = convs[0].shell_id || null;
  let convShellCtx = null;
  let shellIntentRules = null;
  let shellTaskProfiles = null;
  let shellModelPolicy = null; // 壳默认模型（三级路由第三级；§6.2 壳默认）
  let shellBudgetYuan = null;  // 壳级成本预算上限（§8 叠加生效：壳上限可收紧，不高于全局）
  let shellToolsOn = [], shellToolsOff = [];
  let shellPresetBase = null;  // A2：壳 tools.presetBase（schema 裁剪：壳会话暴露档=会话 preset ∩ 壳 presetBase）
  let shellMcpAllow = null;    // A2：按壳 MCP 白名单（serverId 集；null=未显式装载→维持全局 MCP 现状，MCP 资产化随 A3）
  if (convShellId) {
    try {
      const sr = (await db.query('SELECT skey, persona, domain_text, intent_rules, task_profiles, model_policy, tools_preset FROM shells WHERE id=? AND status="enabled"', [convShellId]))[0];
      convShellCtx = sr ? shellContext(sr) : null;
      if (sr) {
        if (sr.intent_rules != null) shellIntentRules = sr.intent_rules;
        if (sr.task_profiles != null) shellTaskProfiles = sr.task_profiles;
        shellPresetBase = ['minimal', 'standard', 'all'].includes(sr.tools_preset) ? sr.tools_preset : null;
        if (sr.model_policy != null) {
          try { const mp = typeof sr.model_policy === 'string' ? JSON.parse(sr.model_policy) : sr.model_policy; shellModelPolicy = mp && typeof mp === 'object' ? mp : null; } catch { shellModelPolicy = null; }
          if (shellModelPolicy) shellBudgetYuan = Number(shellModelPolicy.budgetYuan) > 0 ? Number(shellModelPolicy.budgetYuan) : null;
        }
      }
      const st = await db.query('SELECT tool_name, mode FROM shell_tools WHERE shell_id=?', [convShellId]);
      for (const r of st) { if (r.mode === 'force_on') shellToolsOn.push(r.tool_name); else if (r.mode === 'force_off') shellToolsOff.push(r.tool_name); }
      // A2：按壳 MCP 装载（shell_extensions type=mcp → 与已连接 mcp 客户端 id 交集的 serverId 白名单；无行=null 维持全局）
      if (convShellCtx && convShellCtx.key !== 'default') {
        try {
          const { listMcpClients } = await import('./mcp.js');
          const connIds = new Set((listMcpClients() || []).map((c) => c.id));
          const rows = await db.query('SELECT asset_key FROM shell_extensions WHERE shell_id=? AND asset_type="mcp"', [convShellId]);
          const allow = rows.map((r) => r.asset_key).filter((k) => connIds.has(k));
          if (allow.length) shellMcpAllow = allow; // 壳显式装载了 MCP → 裁剪到装载集
        } catch { shellMcpAllow = null; }
      }
    } catch { convShellCtx = null; }
  }
  // B3：任务档案点名（仅"显式点名"，不自动猜；C4 显式模型=绝对锁，本层不覆盖）
  let profileSuggestion = null;
  if (convShellId && !wantProvider && !wantModel && shellTaskProfiles != null) {
    try {
      const hit = resolveTaskProfile(content, shellTaskProfiles || undefined);
      if (hit && hit.profile && hit.profile.modelHint && hit.profile.modelHint.defaultProvider) {
        const cand = findProvider(hit.profile.modelHint.defaultProvider);
        if (cand && config.keys[cand.keyEnv]) {
          const mdl = hit.profile.modelHint.defaultModel || cand.defaultModel;
          profileSuggestion = { key: hit.profile.key, name: hit.profile.name, provider: cand.id, model: mdl, qualityCostBias: hit.profile.modelHint.qualityCostBias == null ? null : hit.profile.modelHint.qualityCostBias };
          wantProvider = profileSuggestion.provider;
          wantModel = profileSuggestion.model;
        }
      }
    } catch { profileSuggestion = null; }
  }
  // 三级路由第三级：壳默认（档案未命中、仍无显式时才应用；无 modelPolicy/无 key → 跳过回落全局 auto）
  if (!wantProvider && !wantModel && shellModelPolicy && shellModelPolicy.defaultProvider) {
    const cand = findProvider(shellModelPolicy.defaultProvider);
    const mdl = shellModelPolicy.defaultModel || (cand && cand.defaultModel) || '';
    if (cand && config.keys[cand.keyEnv] && mdl) {
      wantProvider = cand.id;
      wantModel = mdl;
      if (!profileSuggestion) profileSuggestion = { key: null, name: null, provider: cand.id, model: mdl, qualityCostBias: shellModelPolicy.qualityCostBias == null ? null : shellModelPolicy.qualityCostBias, shellDefault: true };
    }
  }
  const route = resolveRoute(content, wantProvider || 'auto', wantModel || '__auto__', defOverrides);
  provider = route.provider;
  model = route.model;
  // F12 高级参数：读全局温度设置（settings 表，默认 0.4——2026-09 自进化：低温度=少发散/稳执行/降假开始与漂移）
  const temperature = await getSetting('temperature', 0.4);
  // P18 并发限制（2026-09 批2）：上限=settings max_concurrent_chats（默认 5；0=不限）——原来硬编码 3。
  // 同账号同时在跑的对话超过上限则拒绝（先于写库），提示当前排在前面的对话数（队列可见）。
  const maxConcurrent = Number(await getSetting('max_concurrent_chats', 5)) || 0;
  const curInflight = inflight.get(req.user.id) || 0;
  if (maxConcurrent > 0 && curInflight >= maxConcurrent) {
    return res.status(429).json({ ok: false, message: `并发对话已达上限(${maxConcurrent})，当前另有 ${curInflight} 个对话在跑（可点"停止"结束其一，或调大 设置→运行护栏→并发对话上限）。` });
  }
  inflight.set(req.user.id, curInflight + 1);
  const permission = convs[0].permission || 'full';
  const convMode = convs[0].mode || 'chat';
  const convPreset = ['all', 'standard', 'minimal'].includes(convs[0].preset) ? convs[0].preset : 'all';
  const convProject = convs[0].project || 'default';

  // 存用户消息
  await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'user', content]);
  await db.query('UPDATE conversations SET updated_at=NOW() WHERE id=?', [conversationId]);
  // P25(O-24)：不再用首条消息 24 字符截断占位标题（曾致 LLM 自动标题恒 skip）——标题保持「新对话」，
  // 由回复完成后的 LLM 自动标题生成；LLM 失败时 autotitle.js 内兜底截断（见 autotitle.js）

  // 组装历史（长对话压缩 P1-F8：>40 条用摘要 + 最近 30 条；摘要异步懒生成不阻塞对话）
  let hist = await db.query('SELECT id, role, content FROM messages WHERE conversation_id=? ORDER BY id', [conversationId]);
  let earlySummary = null;
  if (hist.length > 40) {
    const s = (await db.query('SELECT summary FROM conv_summaries WHERE conversation_id=?', [conversationId]))[0];
    earlySummary = s?.summary || null;
    if (!earlySummary) {
      const early = hist.slice(0, -30).map((m) => `${m.role}: ${String(m.content || '').slice(0, 400)}`).join('\n---\n');
      generateSummary(provider, early, conversationId).catch(() => {});
    }
    hist = hist.slice(-30);
  }
  const messages = [];
  if (earlySummary) messages.push({ role: 'system', content: '【早期对话摘要，无需回复】\n' + earlySummary });
  // F10 目标注入：会话存在 active 目标时提醒持续推进（目标由 set_goal 工具创建；表缺失等异常不阻断对话）
  try {
    const gl = (await db.query('SELECT objective FROM goals WHERE conversation_id=? AND status="active" ORDER BY id DESC LIMIT 1', [conversationId]))[0];
    if (gl) messages.push({ role: 'system', content: '【当前会话目标】' + gl.objective + '\n（持续围绕该目标工作直至完成；完成时调用 update_goal 标记为 completed）' });
  } catch { /* goals 表不可用时静默跳过 */ }
  // F15 技能注入：会话已载入技能（conv_skills 记录名字，内容每次实时读 SKILL.md → 文件改动即生效）
  try {
    const skRows = await db.query('SELECT skill_name FROM conv_skills WHERE conversation_id=?', [conversationId]);
    for (const sk of skRows) {
      const sp = path.join(SKILLS_ROOT, sk.skill_name, 'SKILL.md');
      if (fs.existsSync(sp)) {
        const sfull = fs.readFileSync(sp, 'utf8').slice(0, 16000);
        const body = sfull.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        messages.push({ role: 'system', content: '【已载入技能: ' + sk.skill_name + '】\n' + body });
      }
    }
  } catch { /* 技能目录不可用时静默跳过 */ }
  // F19 知识注入（④：global 全部 + shell 仅本会话所属壳私有 + conv 本会话；§4 壳私有+全局共享）：
  // 会话可见知识（前 5 条带 300 字正文摘要；其余仅标题），主题相关可用 kb_search 取全
  try {
    // ④ 会话可见：global + 本会话所属真实壳私有(shell) + 本会话 conv；default 壳(中性)=无壳私有语义
    const kbShellId = (convShellCtx && convShellCtx.key !== 'default') ? convShellId : null;
    const kb = await db.query('SELECT id, scope, title, body FROM knowledge WHERE account_id=? AND (scope="global" OR (scope="shell" AND shell_id<=>?) OR (scope="conv" AND conversation_id=?)) ORDER BY id DESC LIMIT 12', [req.user.id, kbShellId, conversationId]);
    if (kb.length) {
      const lines = kb.map((k, i) => {
        const tag = k.scope === 'global' ? '全局' : k.scope === 'shell' ? '壳私有' : '会话';
        const snip = i < 5 && k.body ? '\n  ' + String(k.body).replace(/\n+/g, ' ').slice(0, 300) : '';
        return '- [' + tag + '] ' + k.title + snip;
      });
      messages.push({ role: 'system', content: '【知识库条目(记忆；主题相关可引用，或 agent 路径用 kb_search 检索)】\n' + lines.join('\n') });
    }
  } catch { /* 知识表不可用时静默跳过 */ }
  // F19b 平台自我进化·实时状态注入：最近 git 提交（事实源自动进上下文，防"记忆滞后于实现"→假遗忘/重复开发；git 不可用/非仓库时静默跳过）
  // 2026-09 C1 修复：git 块原位于 hist 之前=消息前缀中部，自改场景有新 commit 时该块内容变化
  // → 其后全部历史（含最近 30 条）前缀缓存击穿（DeepSeek miss/hit 价差 27 倍）。
  // 改为 append 到消息末尾（hist 之后）：前缀=固定注入+增长历史稳定，git 变化仅影响尾部少量 token。
  const buildGitBlock = async () => {
    try {
      const { execFileSync } = await import('node:child_process');
      const gitLog = execFileSync('git', ['-C', ROOT, 'log', '--oneline', '-8'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const gLines = gitLog.trim().split('\n').filter(Boolean);
      if (gLines.length) return '【平台自我进化·最近提交(事实源：以 git log + docs 勾选为准，勿凭记忆复述开发进度)】\n' + gLines.join('\n');
    } catch { /* git 不可用/非仓库时静默跳过 */ }
    return null;
  };
  // 用户自定义系统提示词（能力"系统提示词"：settings.systemPrompt，注入每条消息的模型上下文）
  try {
    const sp = await getSetting('systemPrompt', '');
    if (String(sp).trim()) messages.push({ role: 'system', content: '【用户自定义指令】\n' + String(sp) });
  } catch { /* 忽略 */ }
  // WS5c 项目自我说明（类 AGENTS.md）：projects/<project>/AGENTS.md 存在则注入（每任务必带的项目级事实）
  // P25(O-25)：去掉 '!== default' 门——default 项目也可放 projects/default/AGENTS.md；存在才注入
  try {
    if (convProject) {
      const agp = path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', 'projects', convProject, 'AGENTS.md');
      if (fs.existsSync(agp)) {
        const ag = fs.readFileSync(agp, 'utf8').slice(0, 16000);
        messages.push({ role: 'system', content: '【项目 ' + convProject + ' 说明（AGENTS.md）】\n' + ag });
      }
    }
  } catch { /* 项目说明不可用时静默跳过 */ }
  // 断点恢复：本会话存在 interrupted/paused 的长任务现场 → 注入现场信息，支持"继续任务"
  try {
    const hint = await resumeHint(conversationId);
    if (hint) messages.push({ role: 'system', content: hint });
  } catch { /* 忽略 */ }
  // P4 意图挡位（2026-09 批1）：不再有会话级 plan mode——"先规划/只调研/别动手"是本轮请求级只读意图
  // （无持久状态：本轮生效，用户放行/下一条新指令自然解除）。命中则本轮注入只读约束。
  const READONLY_INTENT_RE = /(?:只(?:规划|调研|研究|分析|设计|查证|评估|看看|读一下|查一下|先别改|先别执行)|先(?:规划|调研|设计|分析|出方案|评估|查证|看看|看一下方案|别动手)|别动手|不要动手|只读规划|先别改|先别执行|先别做|出个方案|出方案|先出方案|只读)/i;
  const readonlyIntent = READONLY_INTENT_RE.test(String(content).slice(0, 60));
  // B1：壳语境注入（非 default 壳且带 persona 时扩展语境；默认壳/无 persona=保持现状，不改内核自述）
  if (convShellCtx && convShellCtx.persona) {
    messages.push({ role: 'system', content: '【壳语境：' + convShellCtx.key + '】' + (convShellCtx.domain ? '领域说明：' + convShellCtx.domain + '\n' : '') + convShellCtx.persona });
  }
  if (readonlyIntent) {
    messages.push({
      role: 'system',
      content: [
        '【只读规划意图（本轮）】你正处只读规划：只用只读工具（read_file/list_dir/find_file/grep_search/web_search/fetch_url/db_query/kb_search）把方案查证清楚；',
        '- 写/改/执行类工具本轮已被平台禁用（会返回拒绝），不要反复尝试；',
        '- 规划完成把完整方案（目标/步骤/涉及文件/风险/验证）作为你的回答展示给用户，等待批准；',
        '- 用户说"开始/按计划执行/做吧"等放行后，下一条消息即恢复全部工具能力（无需退出任何模式）。',
      ].join('\n'),
    });
  } 
  // P4 高成本自荐（2026-09 批1）：用户指令带"重构/迁移/全部/大规模"等高成本信号 → 模型先给简短执行方案
  // （≤4 行：做什么/几步/涉及文件）再动手——用户可据此提前叫停，避免闷头烧钱。独立于只读意图与 needsTools：
  // 任务词命中（重构/迁移本身就是执行动词）也应触发；纯问答不含这些词不触发。自荐是软约束（方案后继续执行），非审批门禁。
  const HIGH_COST_RE = /(重构|迁移|从零|整个|全部|大规模|重写|搭建|部署|完整项目|一次性|统筹|全面|彻底|大改|多文件|几十|上百|跨模块|系统消息|子系统|架构)/;
  if (!readonlyIntent && HIGH_COST_RE.test(String(content).slice(0, 200))) {
    messages.push({
      role: 'system',
      content: '【高成本自荐】本任务规模较大（重构/迁移/批量/大改类）。开工前先用 ≤4 行说明执行方案（做什么→分几步→涉及哪些文件/区域→验证方式），然后直接按方案动手推进；不要在方案处停下等确认（除非你判断风险极高需要用户拍板）。',
    });
  }

  // 历史消息统一放最后（所有固定 system 注入之后）：2026-09 token 优化，
  // 前缀 = 固定注入 + 按时间增长的历史，跨请求前缀缓存命中最大化；
  // assistant 超长文逐条截断（保留头+尾，DB messages 表仍有全文，不影响 UI 回看）
  for (const m of hist) {
    let c = String(m.content || '');
    if (m.role === 'assistant' && c.length > 4000) {
      c = c.slice(0, 2400) + `\n…[历史消息过长已截断 ${c.length - 4000} 字符，原文在 messages 表可按 id=${m.id} 查询]…\n` + c.slice(-1600);
    }
    messages.push({ role: m.role, content: c });
  }

  // F19b git 块 append 到消息末尾（C1 修复：git 内容随 commit 变化，放 hist 之前会击穿其后全部历史的前缀缓存；
  // 放末尾则 git 变化只影响自身尾部，前缀 = 固定注入 + 增长历史保持稳定命中）
  try {
    const gb = await buildGitBlock();
    if (gb) messages.push({ role: 'system', content: gb });
  } catch { /* git 不可用/非仓库时静默跳过 */ }

  // SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 反代（nginx）禁用缓冲，SSE 即时透出
  });
  // O-8 心跳（2026-09 批3）：SSE 长思考/长任务期间可能 10-60s 无数据（LLM thinking 中），
  // 中间代理空闲超时会断连（驱动多次 terminated 的根因）。每 15s 无数据发注释帧保活；有数据活动即重置。
  let sseIdle = null;
  const armSseHeartbeat = () => {
    clearTimeout(sseIdle);
    sseIdle = setTimeout(() => {
      try { if (!res.writableEnded) res.write(': ping\n\n'); } catch { /* 连接已关 */ }
      armSseHeartbeat(); // 持续保活直到请求结束
    }, 15000);
  };
  armSseHeartbeat();
  const stopSseHeartbeat = () => { clearTimeout(sseIdle); sseIdle = null; };
  const send = (obj) => {
    try {
      if (!res.writableEnded) { res.write(`data: ${JSON.stringify(obj)}\n\n`); armSseHeartbeat(); }
    } catch { /* 连接已关，忽略 */ }
  };

  // B2：意图识别灰字事件（只发事件+审计，不改消息正文/导出，不影响现有 needsTools 行为路径）
  let highGuardIntent = false;
  try {
    const cl = classifyIntent(content, shellIntentRules || undefined);
    if (cl.label === 'act-high') highGuardIntent = true;
    send({ type: 'intent', label: cl.label, echo: cl.echo, hit: cl.hit });
    if (cl.label !== 'chat' || cl.echo) {
      // §8 审计脱敏：sample=用户原文可能含 sk-/ghp_ 等 → redactSecrets
      const detail = JSON.stringify({ hit: cl.hit || null, echo: cl.echo || null, sample: String(content).slice(0, 120) });
      await db.query('INSERT INTO audit_log (account_id, action, detail, shell_id) VALUES (?,?,?,?)',
        [req.user.id, 'intent:' + cl.label, redactSecrets(detail).slice(0, 900), convShellId]);
    }
  } catch { /* 意图事件失败不影响对话 */ }
  // B3/壳默认：路由灰字事件（档案点名或壳默认生效时；显式模型优先不受影响；不入消息正文/导出）
  if (profileSuggestion) {
    try {
      if (profileSuggestion.shellDefault) {
        // 第三级壳默认（§6.2）：会话无显式、未点名档案时按壳 modelPolicy 路由
        send({ type: 'route', profile: null, suggestProvider: profileSuggestion.provider, suggestModel: profileSuggestion.model, echo: '🧩 壳默认模型：本会话按壳默认使用 ' + profileSuggestion.model + '（显式选模型可覆盖）' });
        const detail = JSON.stringify({ provider: profileSuggestion.provider, model: profileSuggestion.model, shellDefault: true });
        await db.query('INSERT INTO audit_log (account_id, action, detail, shell_id) VALUES (?,?,?,?)',
          [req.user.id, 'route:shell-default', redactSecrets(detail).slice(0, 900), convShellId]);
      } else {
        send({ type: 'route', profile: profileSuggestion.key, suggestProvider: profileSuggestion.provider, suggestModel: profileSuggestion.model, echo: '📋 任务档案：' + (profileSuggestion.name || profileSuggestion.key) + ' → 已按档案建议使用模型 ' + profileSuggestion.model + '（显式选模型始终优先）' });
        const detail = JSON.stringify({ provider: profileSuggestion.provider, model: profileSuggestion.model, sample: String(content).slice(0, 120) });
        await db.query('INSERT INTO audit_log (account_id, action, detail, shell_id) VALUES (?,?,?,?)',
          [req.user.id, 'route:' + profileSuggestion.key, redactSecrets(detail).slice(0, 900), convShellId]);
      }
    } catch { /* 路由事件失败不影响对话 */ }
  }

  const t0 = Date.now();
  let firstTokenMs = 0;
  // 孤儿防护（2026-09 终审）：客户端断连后 agent 收尾（assistant/telemetry 落库）与"删会话"并发时，
  // 迟到写会在级联删除之后插入 → 孤儿行。落库前校验会话仍存在，已被删则跳过（删除即用户放弃该现场）。
  const convAlive = async () => {
    try { const r = await db.query('SELECT 1 FROM conversations WHERE id=?', [conversationId]); return !!(r && r.length); }
    catch { return true; } // 校验失败不阻塞主流程（宁可多写不丢回复）
  };
  const TRUNC_NOTE = '\n\n> ⚠️ 本段输出达到模型单次长度上限（已截断）。需要完整内容的话，告诉我"继续"，我会接着分段输出。';
  const akey = req.user.id + ':' + conversationId;
  const actrl = new AbortController();
  abortMap.set(akey, actrl);
  // SSE 断连即中止：客户端关页/断网 → Agent 停止继续（避免无人监听的循环烧 token/改动服务器）
  // 2026-09 中断原因区分：abort(reason) 传 'user'(点停止按钮) / 'disconnect'(断连)，收尾时据此标记 run 与占位消息
  const onDisconnect = () => actrl.abort('disconnect');
  req.on('close', onDisconnect);
  res.on('close', onDisconnect);
  let agentRunId = null; // 长任务现场 id（Agent 路径登记，异常时也要标记）
  let skipStore = false; // stopped 时跳过落库/统计（但仍走统一清理）
  try {
    // P1 统一工具通道（2026-09 批1）：删除 needsTools 双路径——所有对话统一走 runAgent 执行循环，
    // needsTools 仅降级为 schema 宽度选择：任务词命中 → 全量工具；纯问答 → LIGHT_TOOLSET 轻量 schema
    // （模型可零工具直接答，也可用轻量工具单轮查询；结构性消除"无工具路径假开始"O-1）。
    const light = !needsTools(content);
    let answer = '';
    let usage = {};
    let thinkBuf = ''; // 本轮的思考过程（reasoning）累积，落库供历史回看
    {
      // Agent 执行循环（统一通道）：带工具（function calling）；full 权限开放整个服务器，write/read 限定工作区
      // 实时流式：agent 每轮 emit 事件（思考中/工具开始/工具完成）即时转发给前端
      const ws = process.env.RW_WORKSPACE || '/srv/rw-workspace';
      // 长任务现场：登记/复用 run（断点恢复外壳）；纯问答（light）不登记现场（问答无断点恢复需求，省 run 噪音）
      let run = null;
      if (!light) {
        try { run = await ensureRun({ conversationId, accountId: req.user.id, goal: content }); } catch { /* 现场登记失败不阻塞 */ }
      }
      agentRunId = run ? run.id : null;
      // 5.7 预算融合：会话 24h 总账剩余（usage_stats 按会话归集，含子代理同会话计入；总预算 task_budget_total）
      let budgetRemain = null;
      try {
        const total = Number(await getSetting('task_budget_total', 100)) || 0;
        if (total > 0) {
          const spent = (await db.query('SELECT COALESCE(SUM(cost),0) c FROM usage_stats WHERE conversation_id=? AND created_at > NOW() - INTERVAL 24 HOUR', [conversationId]))[0] || {};
          budgetRemain = Math.max(0, Number(total) - Number(spent.c || 0));
        }
      } catch { /* 预算查询失败不阻断（null=不限） */ }
      // 5.3c 工具启用集（默认 28；settings toolset_enabled 覆盖；设置→工具 勾选）
      let enabledTools = null;
      try {
        const saved = await getSetting('toolset_enabled', null);
        const arr = Array.isArray(saved) ? saved : DEFAULT_TOOLSET;
        enabledTools = new Set(arr.filter((x) => typeof x === 'string'));
        if (!enabledTools.size) enabledTools = new Set(DEFAULT_TOOLSET);
      } catch { enabledTools = new Set(DEFAULT_TOOLSET); }
      // A2 按壳 schema 裁剪：force_on 越级并入启用集（钩子按 __enabledTools 拦截，schema 与执行一致）；
      // force_off 从启用集剔除（execTool 前置拦截仍在，双保险）；平台豁免工具不受影响
      const shellSchema = (convShellCtx && convShellCtx.key !== 'default') ? { presetBase: shellPresetBase, forceOn: new Set(shellToolsOn), forceOff: new Set(shellToolsOff), mcpAllow: shellMcpAllow } : null;
      if (enabledTools && shellSchema) {
        for (const n of shellSchema.forceOn) enabledTools.add(n);
        for (const n of shellSchema.forceOff) if (!PLATFORM_EXEMPT.includes(n)) enabledTools.delete(n);
      }
      // P6 allow/deny 规则层：settings access_rules 读入 ctx（execTool hooks 的 access_rules_guard 消费）
      let accessRules = null;
      try { const ar = await getSetting('access_rules', null); accessRules = Array.isArray(ar) ? ar : null; } catch { accessRules = null; }
      const agentCtx = { permission: (highGuardIntent && permission === 'full') ? 'guard' : permission, accountId: req.user.id, conversationId, root: permission === 'full' ? '/' : ws, __signal: actrl.signal, __runId: run ? run.id : null, __resumeStats: run && Number(run.rounds || 0) > 0 ? { rounds: run.rounds } : null, __budgetRemain: budgetRemain, __shellBudgetYuan: shellBudgetYuan, __enabledTools: enabledTools, __accessRules: accessRules, __light: light, __readonlyIntent: readonlyIntent, mode: convMode, preset: convPreset, shellId: convShellId, shellKey: convShellCtx ? convShellCtx.key : null, shellToolsOn, shellToolsOff, __shellSchema: shellSchema };
      // ⑤ model_telemetry 快照点：记录执行前的 usage_stats 最大 id → 执行后只归集本次执行新增行（kind=round/collapse），
      // 避免"同会话 1 小时内多次执行"把历史消耗重复计入观测（观察口径=本执行真实消耗）。
      let teleBase = null;
      try { teleBase = ((await db.query('SELECT COALESCE(MAX(id),0) m FROM usage_stats WHERE conversation_id=?', [conversationId]))[0] || {}).m || 0; } catch { teleBase = null; }
      const result = await runAgent({
        provider, model, messages, permission, ctx: agentCtx, keys: config.keys, temperature,
        emit: (ev) => {
          if (ev.type === 'agent_thinking') {
            send({ type: 'thinking', round: ev.round });
          } else if (ev.type === 'think') {
            thinkBuf += ev.text;
            send({ type: 'think', text: ev.text });
          } else if (ev.type === 'tool_start') {
            send({ type: 'tool_start', tool: ev.tool });
          } else if (ev.type === 'tool_done') {
            send({ type: 'tool_done', tool: ev.tool });
          } else if (ev.type === 'plan') {
            send({ type: 'plan', plan: ev.plan });
          } else if (ev.type === 'approval') {
            send({ type: 'approval', id: ev.id, desc: ev.desc });
          } else if (ev.type === 'ask') {
            send({ type: 'ask', id: ev.id, question: ev.question, options: ev.options });
          } else if (ev.type === 'delta') {
            // P20：agent 每轮流式正文实时透出（final 真流；工具轮旁白由前端灰字化）
            if (!firstTokenMs) firstTokenMs = Date.now() - t0;
            send({ type: 'delta', delta: ev.delta });
          }
        },
      });
      // 收尾：按结果登记现场状态（completed/paused/interrupted+原因）
      if (run) {
        try {
          if (result.stopped) {
            // 2026-09：区分中断来源——用户点停止(user) vs SSE 断连(disconnect)，现场都保留可恢复
            const why = (actrl.signal && actrl.signal.reason === 'user') ? '用户点击停止' : '连接断开（页面刷新/网络中断）';
            await markRun(run.id, 'interrupted', why);
          }
          else if (result.guard === 'budget') await markRun(run.id, 'interrupted', '时间预算达到（可 set_limits 调大/关闭）');
          else if (result.guard === 'cap') await markRun(run.id, 'interrupted', '轮次上限达到（可调大/关闭）');
          else if (result.paused) await markRun(run.id, 'paused', result.reason || '循环无进展挂起');
          else await markRun(run.id, 'completed', '');
        } catch { /* 忽略 */ }
      }
      if (result.stopped) {
        // 用户点击停止：不落 assistant/统计，但不再提前 return（避免泄漏 inflight/abortMap）
        send({ type: 'stopped' });
        skipStore = true;
      }
      // ⑤ model_telemetry 落表：本次执行消耗（id>teleBase 的新增 usage_stats 行=本执行真实消耗，round/collapse 均属执行；
      // summary/title 等旁路（摘要/自动标题）不入执行口径——§8 观测事实表按"执行模型×难度×档案"归集）
      if (!skipStore && teleBase !== null) {
        try {
          const agg = (await db.query('SELECT COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout, COALESCE(SUM(cache_hit_tokens),0) hit, COALESCE(SUM(cache_miss_tokens),0) miss, COALESCE(SUM(cost),0) cost, COUNT(*) n FROM usage_stats WHERE conversation_id=? AND id>? AND kind IN ("round","collapse")', [conversationId, teleBase]))[0] || {};
          // 仅真实发生 LLM 执行才落观测（护栏前置拦截/零消耗不产生空行污染 execs 口径）；
          // 原子守卫：会话已被删（删会话与收尾并发）则 EXISTS 为假 → 不插入 → 无孤儿 telemetry
          if ((agg.n || 0) > 0) {
            await db.query('INSERT INTO model_telemetry (conversation_id, account_id, shell_id, provider, model, profile_key, difficulty, tokens_in, tokens_out, cache_hit, cache_miss, cost, duration_ms, created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,NOW() FROM conversations WHERE id=?',
              [conversationId, req.user.id, convShellId, provider, model, profileSuggestion ? profileSuggestion.key : null, null, agg.tin || 0, agg.tout || 0, agg.hit || 0, agg.miss || 0, agg.cost || 0, Date.now() - t0, conversationId]);
          }
        } catch { /* 观测落表失败不影响对话 */ }
      }
      if (!skipStore) {
        answer = result.content || '（无输出）';
        usage = result.usage || {};
        if (result.finishReason === 'length' && answer) answer += TRUNC_NOTE;
        // P20：最终正文已在 agent 流式阶段经 delta 事件实时发出（result.streamed=true）→ 不再分块重发；
        // 兜底路径（一次性 fallback / F6a 诚实说明 / guard 文案等生成型内容）仍按 8 字分块模拟
        if (!result.streamed && answer) {
          const chunkSize = 8;
          for (let i = 0; i < answer.length; i += chunkSize) {
            if (!firstTokenMs) firstTokenMs = Date.now() - t0;
            send({ type: 'delta', delta: answer.slice(i, i + chunkSize) });
          }
        }
      }
    }
    if (!skipStore) {
      send({ type: 'done', usage });
      // 存 assistant 消息（reasoning=思考过程，历史回看可见）；原子守卫防"删会话与落库并发"产生孤儿消息
      const r = await db.query('INSERT INTO messages (conversation_id, role, content, reasoning, model, provider, tokens_in, tokens_out) SELECT ?,?,?,?,?,?,?,? FROM conversations WHERE id=?',
        [conversationId, 'assistant', answer, thinkBuf ? String(thinkBuf).slice(0, 20000) : null, model || provider, provider, usage.tokens_in || 0, usage.tokens_out || 0, conversationId]);
      // 轨迹回填：本轮执行产生的未关联工具调用归属到该 assistant 消息（历史回看用）
      if (r && r.insertId) await db.query('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [r.insertId, conversationId]);
      // 用量统计：统一通道已由 agent.js 每轮 LLM 调用计量（kind=round，含 light 问答单轮）；
      // 此处不再按"普通路径 request"二次计费（P1 删双路径后无独立无工具请求路径）。
    } else {
      // 停止/断连/中断也留痕：避免"刷新后整条消失"，现场信息可读可恢复
      // 2026-09：占位消息带中断原因 + 已执行进度（run.checkpoint 落库），避免"中断=看起来啥也没干"
      try {
        let prog = '';
        if (agentRunId) {
          const rr = (await db.query('SELECT rounds, tool_counts, last_step FROM agent_runs WHERE id=?', [agentRunId]))[0];
          if (rr) {
            const cts = (() => { try { return JSON.parse(rr.tool_counts || '{}'); } catch { return {}; } })();
            const cText = Object.entries(cts).map(([k, v]) => k + '×' + v).join('、');
            prog = '｜已执行 ' + (rr.rounds || 0) + ' 轮' + (cText ? '（' + cText + '）' : '') + (rr.last_step ? '；最后步骤：' + String(rr.last_step).slice(0, 200) : '');
          }
        }
        const why = (actrl.signal && actrl.signal.reason === 'user') ? '用户点击停止' : '连接断开（页面刷新/网络中断）';
        if (await convAlive()) await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)',
          [conversationId, 'assistant', '（任务中断：' + why + '。现场已保存' + prog + '；回复"继续任务"可基于现场恢复推进，或给我新指令。）']);
      } catch { /* 忽略 */ }
    }
  } catch (e) {
    send({ type: 'error', message: e.message });
    // P20/②（O-17）：异常路径也必须落 assistant 占位消息（含已做进度与错误原因），绝不"无声无息"
    try {
      let prog = '';
      if (agentRunId) {
        const rr = (await db.query('SELECT rounds, tool_counts, last_step FROM agent_runs WHERE id=?', [agentRunId]))[0];
        if (rr) {
          const cts = (() => { try { return JSON.parse(rr.tool_counts || '{}'); } catch { return {}; } })();
          const cText = Object.entries(cts).map(([k, v]) => k + '×' + v).join('、');
          prog = '｜已执行 ' + (rr.rounds || 0) + ' 轮' + (cText ? '（' + cText + '）' : '') + (rr.last_step ? '；最后步骤：' + String(rr.last_step).slice(0, 200) : '');
        }
      }
      await db.query('INSERT INTO messages (conversation_id, role, content) SELECT ?,?,? FROM conversations WHERE id=?',
        [conversationId, 'assistant', '（本轮执行失败：' + String(e.message || e).slice(0, 300) + '。现场已保存' + prog + '；回复"继续任务"可基于现场恢复推进，或给我新指令。）', conversationId]);
    } catch { /* 忽略 */ }
    if (agentRunId) { try { await markRun(agentRunId, 'interrupted', '执行出错: ' + e.message.slice(0, 200)); } catch { /* ignore */ } }
  }
  if (abortMap.get(akey) === actrl) abortMap.delete(akey);
  // 释放并发槽位
  inflight.set(req.user.id, Math.max(0, (inflight.get(req.user.id) || 1) - 1));
  clearActivity(conversationId); // 本轮事件环收尾（正常/异常/停止统一清理）
  stopSseHeartbeat(); // O-8：停止心跳（连接即将关闭）
  res.end();
  // 自我重启协作：本回复已完整发出/落库，处理 reload_platform 请求
  maybeSelfRestart().catch(() => {});
});

// ---------- 用量统计（统计条） ----------
app.get('/api/usage/stats', requireAuth, async (req, res) => {
  const { conversationId } = req.query;
  const convId = conversationId ? Number(conversationId) : null;
  const p = convId ? [req.user.id, convId] : [req.user.id];
  const where = convId ? 'WHERE account_id=? AND conversation_id=?' : 'WHERE account_id=?';
  const u = (await db.query(`SELECT COUNT(*) rounds, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(duration_ms) dur, SUM(cost) cost FROM usage_stats ${where}`, p))[0] || {};
  const t = await db.query('SELECT COUNT(*) steps FROM tool_calls WHERE conversation_id=?', [convId || 0]);
  const rounds = await db.query('SELECT COUNT(*) c FROM messages WHERE role="user" AND conversation_id=?', [convId || 0]);
  res.json({
    ok: true,
    stats: {
      rounds: convId ? (rounds[0]?.c || 0) : (u.rounds || 0),
      steps: convId ? (t[0]?.steps || 0) : 0,
      llmMs: u.dur || 0,
      tokensIn: u.tin || 0,
      tokensOut: u.tout || 0,
      cost: Number(u.cost || 0),
    },
  });
});

// ---------- 缓存命中率目标摘要（§8.10 cache_hit_rate_target；首页状态带数据源,2026-09-11 A1） ----------
app.get('/api/cache-hit/summary', requireAuth, async (req, res) => {
  try {
    const raw = await db.query('SELECT svalue FROM settings WHERE skey=?', ['cache_hit_rate_target']);
    let target = 0;
    if (raw && raw[0] && raw[0].svalue != null) { const v = Number(raw[0].svalue); target = Number.isFinite(v) && v > 0 ? v : 0; }
    const rows = await db.query(
      `SELECT DATE(created_at) d, COALESCE(SUM(cache_hit_tokens),0) hit, COALESCE(SUM(cache_miss_tokens),0) miss
       FROM usage_stats WHERE account_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at) ORDER BY d`, [req.user.id]);
    const now = new Date(); const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const sum = (arr) => arr.reduce((s, r) => s + Number(r.hit) + Number(r.miss), 0);
    const rate = (arr) => { const h = arr.reduce((s, r) => s + Number(r.hit), 0); const m = arr.reduce((s, r) => s + Number(r.miss), 0); return (h + m) > 0 ? (100 * h / (h + m)) : null; };
    const todayRow = rows.find((r) => String(r.d).slice(0, 10) === todayStr) || null;
    const f = (x) => (x == null ? null : Number(x.toFixed(1)));
    const todayRate = todayRow && (Number(todayRow.hit) + Number(todayRow.miss)) > 0 ? 100 * Number(todayRow.hit) / (Number(todayRow.hit) + Number(todayRow.miss)) : null;
    const avg7 = rate(rows.slice(-7));
    res.json({
      ok: true, target,
      todayHit: todayRow ? Number(todayRow.hit) : 0, todayMiss: todayRow ? Number(todayRow.miss) : 0,
      todayRate: f(todayRate), avg7: f(avg7), daily: rows.slice(-30).map((r) => ({ d: String(r.d), hit: Number(r.hit), miss: Number(r.miss) })),
      alert: target > 0 && avg7 != null && avg7 < target,
    });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- 结构化问询裁决（ask_user 卡片） ----------
app.get('/api/asks', requireAuth, async (req, res) => {
  const { listPendingAsks } = await import('./asks.js');
  res.json({ ok: true, pending: listPendingAsks() });
});
app.post('/api/asks/:id', requireAuth, async (req, res) => {
  const { option } = req.body || {};
  if (option === undefined || option === null || option === '') return res.status(400).json({ ok: false, message: 'option 必填' });
  const decided = decideAsk(req.params.id, String(option));
  try {
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)',
      [req.user.id, 'ask:answer', JSON.stringify({ id: req.params.id, option: String(option).slice(0, 60), decided })]);
  } catch { /* 忽略 */ }
  res.json({ ok: true, decided });
});

// ---------- 停止生成（服务端取消运行中的 Agent 轮） ----------
app.post('/api/chat/stop', requireAuth, (req, res) => {
  const { conversationId } = req.body || {};
  const c = conversationId ? abortMap.get(req.user.id + ':' + conversationId) : null;
  if (c) c.abort('user'); // 2026-09：区分用户主动停止(user) 与 SSE 断连(disconnect)
  res.json({ ok: true, stopped: Boolean(c) });
});

// ---------- 审批（F20：guard 会话高风险工具需用户确认） ----------
app.get('/api/approvals', requireAuth, (req, res) => res.json({ ok: true, pending: listPending() }));
app.post('/api/approvals/:id', requireAuth, async (req, res) => {
  const { decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ ok: false, message: 'decision=approve|reject' });
  const decided = decideApproval(req.params.id, decision);
  // 审计：审批裁决留痕（谁、批什么、结果）
  try {
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)',
      [req.user.id, 'approval:' + decision, JSON.stringify({ id: req.params.id, decided })]);
  } catch { /* 审计失败不影响 */ }
  res.json({ ok: true, decided });
});

// ---------- 设置 API（F12 温度等高级参数） ----------
// P11 密钥脱敏（2026-09 批5 安全修复）：mcp_servers 的 env 含 token/key——响应给前端前替换为占位符，
// 前端编辑框不显示明文；PUT 收到占位符时保留 DB 原值（用户未改动的键不覆盖）。token 永不出服务器。
const REDACT = '__REDACTED__';
const SECRET_KEY_RE = /(token|secret|key|password|passwd|apikey)/i;
function redactMcpServers(cfg) {
  if (!Array.isArray(cfg)) return cfg;
  return cfg.map((s) => {
    if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return s;
    const env = {};
    for (const [k, v] of Object.entries(s.env)) env[k] = SECRET_KEY_RE.test(k) && v ? REDACT : v;
    return { ...s, env };
  });
}
function unredactMcpServers(nextCfg, prevCfg) {
  // 前端传 REDACT 占位 → 用 DB 原值（prevCfg）对应键；否则用前端新值
  if (!Array.isArray(nextCfg) || !Array.isArray(prevCfg)) return nextCfg;
  return nextCfg.map((s) => {
    if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') return s;
    const prev = prevCfg.find((p) => p && p.id === s.id);
    const env = {};
    for (const [k, v] of Object.entries(s.env)) {
      if (v === REDACT && prev && prev.env && prev.env[k] !== undefined) env[k] = prev.env[k]; // 未改：保留原值
      else env[k] = v; // 新值/非敏感
    }
    return { ...s, env };
  });
}
app.get('/api/settings', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT skey, svalue FROM settings');
  const out = {};
  for (const r of rows) { try { out[r.skey] = JSON.parse(r.svalue); } catch { out[r.skey] = r.svalue; } }
  if (out.mcp_servers) out.mcp_servers = redactMcpServers(out.mcp_servers); // 密钥脱敏
  res.json({ ok: true, settings: out, schema: SETTINGS_SCHEMA });
});
app.put('/api/settings', requireAuth, async (req, res) => {
  const { updates } = req.body || {};
  const GUARD_KEYS = new Set(SETTINGS_SCHEMA.filter((s) => s.group === 'runtime').map((s) => s.key));
  for (const [k, v] of Object.entries(updates || {})) {
    const chk = validateSetting(k, v);
    if (!chk.ok) return res.status(400).json({ ok: false, message: chk.error });
    let val = chk.value; // 常规键：chk.value 已做类型归一（number 字符串→Number）
    if (k === 'mcp_servers') val = unredactMcpServers(chk.value, await getSetting('mcp_servers', [])); // 占位还原
    await setSetting(k, val, !GUARD_KEYS.has(k)); // 护栏键 bump（模型需即时感知）；普通参数不 bump
  }
  res.json({ ok: true });
});

// P6 allow/deny 规则层 API（2026-09 批2）：规则存 settings access_rules（JSON 数组），execTool hooks 消费
// 规则格式：{ id, pattern: 工具名正则, argPattern?: 参数JSON正则(可空), action: 'allow'|'deny', why }
app.get('/api/access-rules', requireAuth, async (req, res) => {
  const rules = await getSetting('access_rules', []);
  res.json({ ok: true, rules: Array.isArray(rules) ? rules : [] });
});
app.put('/api/access-rules', requireAuth, async (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ ok: false, message: 'rules 需为数组' });
  // 校验每条：pattern/action 必填，action ∈ {allow,deny}，正则可编译
  for (const r of rules) {
    if (!r || typeof r.pattern !== 'string' || !r.pattern) return res.status(400).json({ ok: false, message: '每条规则需含 pattern' });
    if (!['allow', 'deny'].includes(r.action)) return res.status(400).json({ ok: false, message: 'action 需为 allow|deny' });
    try { new RegExp(r.pattern); if (r.argPattern) new RegExp(r.argPattern); } catch { return res.status(400).json({ ok: false, message: '正则无法编译: ' + r.pattern }); }
  }
  await setSetting('access_rules', rules); // 策略类变更 bump policy rev（模型可见规则更新）
  res.json({ ok: true, count: rules.length });
});

// P3 proposals 提案 API（2026-09 批4）：平台 main 改动前先写提案（C5 受控合入配套）。
// 存储：<ROOT>/proposals/<YYYYMMDD-主题>.md（git 仓库内版本化）；模板 docs/templates/提案模板.md。
const PROPOSALS_DIR = path.join(ROOT, 'proposals');
function ensureProposalsDir() { try { fs.mkdirSync(PROPOSALS_DIR, { recursive: true }); } catch { /* ignore */ } }
app.get('/api/proposals', requireAuth, async (req, res) => {
  try {
    ensureProposalsDir();
    const files = fs.readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith('.md')).sort().reverse();
    const list = files.map((f) => {
      try {
        const raw = fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf8');
        const title = (String(raw).split('\n').find((l) => l.startsWith('# ')) || '# ' + f).replace(/^#\s*/, '').replace(/^提案\s*[:：]\s*/, '').slice(0, 80);
        const status = (String(raw).match(/状态：([^·\n]+)/) || [])[1] || '待审';
        return { file: f, title: title.trim(), status: status.trim(), size: raw.length };
      } catch { return { file: f, title: f, status: '?', size: 0 }; }
    });
    res.json({ ok: true, proposals: list });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/api/proposals/:file', requireAuth, async (req, res) => {
  try {
    const safe = path.basename(String(req.params.file || '')).replace(/[\\/]/g, '_');
    const p = path.join(PROPOSALS_DIR, safe);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, message: '提案不存在' });
    res.json({ ok: true, file: safe, content: fs.readFileSync(p, 'utf8').slice(0, 60000) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/api/proposals', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ ok: false, message: 'title/content 必填' });
    ensureProposalsDir();
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const safe = (String(title).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 50) || 'proposal');
    const file = stamp + '-' + safe + '.md';
    fs.writeFileSync(path.join(PROPOSALS_DIR, file), String(content), 'utf8');
    res.json({ ok: true, file });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// P11 MCP 管理 API（2026-09 批5）：查看/重连 MCP server（配置存 settings mcp_servers，改后调 reload 生效无需重启）
app.get('/api/mcp', requireAuth, async (req, res) => {
  try {
    const mcp = await import('./mcp.js');
    const cfg = await getSetting('mcp_servers', []);
    res.json({ ok: true, configured: redactMcpServers(cfg), clients: mcp.listMcpClients() }); // env 密钥脱敏
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/api/mcp/reload', requireAuth, async (req, res) => {
  try {
    const mcp = await import('./mcp.js');
    const { syncMcpExtras } = await import('./tools/index.js');
    // 断开全部 → 按配置重连
    for (const c of mcp.listMcpClients()) { try { mcp.disconnectMcp(c.id); } catch { /* ignore */ } }
    const r = await mcp.connectConfiguredMcps();
    const n = syncMcpExtras(mcp.listMcpClients());
    res.json({ ok: true, results: r, registeredTools: n });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/api/file', requireAuth, async (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ ok: false, message: '缺 path 参数' });
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return res.json({ ok: true, path: p, type: 'dir', entries: fs.readdirSync(p).slice(0, 200) });
    const isText = /\.(md|txt|js|jsx|ts|tsx|json|yaml|yml|html|css|py|sh|mjs|cjs|xml|sql|env|gitignore|conf)$/i.test(p) || p.includes('package.json');
    if (!isText) return res.json({ ok: true, path: p, type: 'binary', size: st.size });
    const content = fs.readFileSync(p, 'utf8');
    res.json({ ok: true, path: p, type: 'text', size: st.size, content: content.slice(0, 60000) });
  } catch (e) { res.status(400).json({ ok: false, message: '读取失败: ' + e.message }); }
});

// ---------- 上传文件（B29） ----------
app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { name, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ ok: false, message: '参数缺失' });
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return res.status(400).json({ ok: false, message: 'data 不是合法的 base64' });
    const buf = Buffer.from(data, 'base64');
    if (buf.length === 0) return res.status(400).json({ ok: false, message: '空文件' });
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ ok: false, message: '文件超过 8MB 上限' });
    const dir = path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(String(name).replace(/[\\/]/g, '_')).slice(0, 120) || 'file';
    const file = path.join(dir, Date.now() + '-' + safe);
    fs.writeFileSync(file, buf);
    res.json({ ok: true, path: file });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ---------- 下载文件（uploads 目录，登录后可下载；防目录穿越）——2026-09-09 会话393 Excel 收发链路恢复 ----------
app.get('/api/download/:name', requireAuth, async (req, res) => {
  try {
    const dir = path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', 'uploads');
    const name = path.basename(decodeURIComponent(req.params.name || ''));
    if (!name) return res.status(400).json({ ok: false, message: '文件名缺失' });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, message: '文件不存在' });
    res.download(file, name);
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ---------- 模型市场（P3） ----------
app.get('/api/market/list', requireAuth, async (req, res) => {
  try { res.json({ ok: true, sources: await marketList() }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/market/refresh', requireAuth, async (req, res) => {
  try { res.json({ ok: true, results: await refreshMarket() }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

app.post('/api/market/connect', requireAuth, async (req, res) => {
  try {
    const { source, modelIds } = req.body || {};
    if (!source || !Array.isArray(modelIds) || !modelIds.length) return res.status(400).json({ ok: false, message: '参数缺失' });
    res.json({ ok: true, ...(await connectModels(source, modelIds)) });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ---------- 定时任务 API（F14） ----------
app.get('/api/tasks', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT id, name, cron, prompt, provider, model, permission, enabled, last_run, next_run, last_result, created_at FROM scheduled_tasks WHERE account_id=? ORDER BY id DESC', [req.user.id]);
  res.json({ ok: true, tasks: rows });
});
app.post('/api/tasks', requireAuth, async (req, res) => {
  const { name, cron, prompt, provider, model, permission } = req.body || {};
  if (!name || !cron || !prompt) return res.status(400).json({ ok: false, message: '名称/cron/指令必填' });
  const { cronToNext } = await import('./scheduler.js');
  const next = cronToNext(cron);
  if (!next) return res.status(400).json({ ok: false, message: 'cron 格式错误（分 时 日 月 周）' });
  const r = await db.query('INSERT INTO scheduled_tasks (account_id, name, cron, prompt, provider, model, permission, next_run) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, name, cron, prompt, provider || 'deepseek', model || 'deepseek-v4-flash', permission || 'full', next]);
  res.json({ ok: true, id: r.insertId });
});
app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const { enabled, name, cron, prompt } = req.body || {};
  const sets = [], ps = [];
  if (enabled !== undefined) { sets.push('enabled=?'); ps.push(enabled ? 1 : 0); if (enabled) sets.push('next_run=NULL'); }
  if (name) { sets.push('name=?'); ps.push(name); }
  if (prompt) { sets.push('prompt=?'); ps.push(prompt); }
  if (cron) { sets.push('cron=?'); ps.push(cron); }
  if (!sets.length) return res.json({ ok: true });
  ps.push(req.params.id, req.user.id);
  await db.query(`UPDATE scheduled_tasks SET ${sets.join(',')} WHERE id=? AND account_id=?`, ps);
  const { cronToNext } = await import('./scheduler.js');
  if (cron) {
    const t = (await db.query('SELECT cron FROM scheduled_tasks WHERE id=? AND account_id=?', [req.params.id, req.user.id]))[0];
    if (t) await db.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [cronToNext(t.cron), req.params.id]);
  }
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  await db.query('DELETE FROM scheduled_tasks WHERE id=? AND account_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ---------- 健康检查（Agent 自开发演示产物，RW 自我开发闭环验证） ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'rw', ts: Date.now() });
});

// ---------- 任务契约（外部驱动器）API ----------
app.get('/api/contracts', requireAuth, async (req, res) => {
  try {
    const rows = await db.query('SELECT id,title,goal,status,attempts,last_ask,last_result,run_at,created_at,updated_at FROM task_contracts WHERE account_id=? OR account_id IS NULL ORDER BY id DESC LIMIT 50', [req.user.id]);
    res.json({ ok: true, contracts: rows });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.get('/api/contracts/:id/events', requireAuth, async (req, res) => {
  const rows = await db.query('SELECT kind,detail,created_at FROM contract_events WHERE contract_id=? ORDER BY id DESC LIMIT 50', [req.params.id]);
  res.json({ ok: true, events: rows });
});
app.post('/api/contracts', requireAuth, async (req, res) => {
  try {
    const { title, goal, acceptance, boundaries, runAt } = req.body || {};
    if (!goal) return res.status(400).json({ ok: false, message: 'goal 必填' });
    let acc = []; try { acc = Array.isArray(acceptance) ? acceptance : JSON.parse(acceptance || '[]'); } catch { acc = []; }
    let runAtD = null; if (runAt) { const d = new Date(runAt); if (!Number.isNaN(d.getTime())) runAtD = d; }
    const r = await db.query('INSERT INTO task_contracts (account_id,title,goal,acceptance,boundaries,run_at,status) VALUES (?,?,?,?,?,?,"queued")',
      [req.user.id, String(title || String(goal).slice(0, 40)).slice(0, 200), String(goal).slice(0, 3000), JSON.stringify(acc.slice(0, 10)), String(boundaries || '').slice(0, 1000), runAtD]);
    res.json({ ok: true, contract_id: r.insertId });
  } catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.post('/api/contracts/:id/confirm', requireAuth, async (req, res) => {
  // 复测确认（candidate_done）：accept→done；reject→打回修复
  const { decision } = req.body || {};
  const c = (await db.query('SELECT * FROM task_contracts WHERE id=?', [req.params.id]))[0];
  if (!c) return res.status(404).json({ ok: false, message: '契约不存在' });
  if (decision === 'accept') {
    await db.query('UPDATE task_contracts SET status="done", last_result=?, updated_at=NOW() WHERE id=?', [String(c.last_result || '用户复测通过').slice(0, 3000), c.id]);
    if (c.conv_id) await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [c.conv_id, 'user', '【用户复测通过 ✅】任务验收完成。']);
    res.json({ ok: true, status: 'done' });
  } else if (decision === 'reject') {
    await db.query('UPDATE task_contracts SET status="queued", attempts=0, updated_at=NOW() WHERE id=?', [c.id]);
    if (c.conv_id) await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [c.conv_id, 'user', '【用户复测未通过】请根据反馈继续修复，完成后再次调用 finish_task。']);
    res.json({ ok: true, status: 'queued' });
  } else res.status(400).json({ ok: false, message: 'decision=accept|reject' });
});
app.post('/api/contracts/:id/answer', requireAuth, async (req, res) => {
  // 无人值守排队问题答复（need_input）：写入执行会话并恢复 queued；judge 型 accept/continue 特判
  const { answer } = req.body || {};
  if (!answer) return res.status(400).json({ ok: false, message: 'answer 必填' });
  const c = (await db.query('SELECT * FROM task_contracts WHERE id=?', [req.params.id]))[0];
  if (!c) return res.status(404).json({ ok: false, message: '契约不存在' });
  let ask = null; try { ask = JSON.parse(c.last_ask || 'null'); } catch { /* ignore */ }
  if (ask && ask.kind === 'judge') {
    if (String(answer) === 'continue') {
      await db.query('UPDATE task_contracts SET status="queued", last_ask=NULL, attempts=0, updated_at=NOW() WHERE id=?', [c.id]);
      if (c.conv_id) await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [c.conv_id, 'user', '【用户裁决】继续执行该任务，直到调用 finish_task 完成。']);
      return res.json({ ok: true, status: 'queued' });
    }
    // accept → 视同用户接受当前结果（candidate 直达复测）
    await db.query('UPDATE task_contracts SET status="candidate_done", last_ask=NULL, updated_at=NOW() WHERE id=?', [c.id]);
    return res.json({ ok: true, status: 'candidate_done' });
  }
  await db.query('UPDATE task_contracts SET status="queued", last_ask=NULL, updated_at=NOW() WHERE id=?', [c.id]);
  if (c.conv_id) await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [c.conv_id, 'user', '【用户答复】' + String(answer).slice(0, 2000)]);
  res.json({ ok: true, status: 'queued' });
});

// ---------- B1 壳管理 API ----------
// §8.9 装配向导 step0 壳模板（内置预填列表）
app.get('/api/shell-templates', requireAuth, async (req, res) => {
  res.json({ ok: true, templates: SHELL_TEMPLATES });
});
app.get('/api/shells', requireAuth, async (req, res) => {
  try { res.json({ ok: true, shells: await listShells() }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/api/shells/:key', requireAuth, async (req, res) => {
  const s = await getShellByKey(req.params.key);
  if (!s) return res.status(404).json({ ok: false, message: '壳不存在' });
  res.json({ ok: true, shell: s, tools: await shellTools(req.params.key) });
});
// M2-① 壳开发：导出 pack（DB 镜像 → pack 对象，文件权威/DB 镜像语义见 §3.2）
app.get('/api/shells/:key/export', requireAuth, async (req, res) => {
  try {
    const pack = await exportShell(req.params.key);
    if (!pack) return res.status(404).json({ ok: false, message: '壳不存在' });
    res.json({ ok: true, pack });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.post('/api/shells', requireAuth, async (req, res) => {
  const { pack } = req.body || {};
  if (!pack) return res.status(400).json({ ok: false, message: 'body.pack 必填' });
  try { const r = await importShell(pack); await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'shell:import', String(r.key)]); maybeAutoCanary(r.key, req.user.id); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.post('/api/shells/:key/clone', requireAuth, async (req, res) => {
  const { newKey, name } = req.body || {};
  try { const r = await cloneShell(req.params.key, newKey, name); await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'shell:clone', req.params.key + '->' + newKey]); maybeAutoCanary(r.key, req.user.id); res.json({ ok: true, ...r }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.patch('/api/shells/:key', requireAuth, async (req, res) => {
  try { const r = await patchShell(req.params.key, req.body || {}); res.json({ ok: r.ok }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});
app.delete('/api/shells/:key', requireAuth, async (req, res) => {
  try { const r = await disableShell(req.params.key); await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'shell:disable', req.params.key]); res.json({ ok: r }); }
  catch (e) { res.status(400).json({ ok: false, message: e.message }); }
});

// ---------- A2 金标 canary（§7.4 自审登记②/§10 门禁）：行为级"变更即跑"回环载体 ----------// 运行壳金标断言（eval.goldenSetRef 指向 <ROOT>/eval/<ref>.json/.jsonl；无金标=skip，不报错）
// shell 快照：行（presetBase/intent_rules）+ shell_tools 三态（forceOn/Off）
async function runShellCanaryAndAudit(shellKey, accountId, { auto = false } = {}) {
  try {
    const row = await getShellByKey(shellKey);
    if (!row) return { skipped: true, reason: '壳不存在' };
    if (!row.eval_ref) return { skipped: true, reason: '未配置 eval.goldenSetRef' };
    if (!loadGoldenItems(row.eval_ref)) return { skipped: true, ref: row.eval_ref, reason: '金标文件缺失或为空' };
    const tools = await shellTools(shellKey);
    const on = [], off = [];
    for (const t of (tools || [])) { if (t.mode === 'force_on') on.push(t.tool_name); else if (t.mode === 'force_off') off.push(t.tool_name); }
    const shell = { id: row.id, presetBase: row.tools_preset || 'standard', forceOn: on, forceOff: off };
    const r = await runGoldenChecks(row.eval_ref, shell);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [accountId, 'canary:run', 'shell=' + shellKey + ' ref=' + row.eval_ref + (r.skipped ? ' skipped(' + (r.reason || '') + ')' : ' passed=' + r.passed + '/' + r.total + (auto ? ' auto' : ''))]);
    return r;
  } catch (e) {
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [accountId, 'canary:run', 'shell=' + shellKey + ' error=' + String(e.message).slice(0, 200)]).catch(() => {});
    return { skipped: true, reason: '运行异常: ' + String(e.message).slice(0, 200) };
  }
}
// 手动跑（装配向导 step8 冒烟/Agent 页卡可点；审计 canary:run）
app.post('/api/shells/:key/canary', requireAuth, async (req, res) => {
  try {
    const r = await runShellCanaryAndAudit(req.params.key, req.user.id);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 壳导入/克隆后：若配置了金标集 → 行为级"变更即跑"（装配冒烟自动接金标；异步不阻塞返回）
async function maybeAutoCanary(key, accountId) {
  try {
    const row = await getShellByKey(key);
    if (row && row.eval_ref && loadGoldenItems(row.eval_ref)) {
      runShellCanaryAndAudit(key, accountId, { auto: true }).catch(() => {});
    }
  } catch { /* 自动 canary 失败不影响主流程 */ }
}

// ---------- ⑤ 模型观测数据面 API（复测 reviews 读写 + telemetry 视图查询；§8） ----------
// 复测记录写入：result ∈ pass|bug；bug 必填 bug_reason（§6.4 打回必填原因）
app.post('/api/reviews', requireAuth, async (req, res) => {
  try {
    const { conversationId, result, bugReason } = req.body || {};
    if (!conversationId || !['pass', 'bug'].includes(result)) return res.status(400).json({ ok: false, message: 'conversationId 与 result(pass|bug) 必填' });
    if (result === 'bug' && !String(bugReason || '').trim()) return res.status(400).json({ ok: false, message: '打回(bug)必须填写原因' });
    const conv = (await db.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [conversationId, req.user.id]))[0];
    if (!conv) return res.status(404).json({ ok: false, message: '会话不存在' });
    const r = await db.query('INSERT INTO reviews (conversation_id, account_id, result, bug_reason) VALUES (?,?,?,?)', [conversationId, req.user.id, result, result === 'bug' ? String(bugReason).trim() : null]);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'review:' + result, 'conversation=' + conversationId + (result === 'bug' ? ' reason=' + String(bugReason).trim().slice(0, 200) : '')]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 复测记录读取：GET /api/reviews?conversation_id=N（该会话全部复测记录，倒序）
app.get('/api/reviews', requireAuth, async (req, res) => {
  try {
    const cid = Number(req.query.conversation_id) || 0;
    if (cid) {
      const rows = await db.query('SELECT id, conversation_id, result, bug_reason, created_at FROM reviews WHERE conversation_id=? AND account_id=? ORDER BY id DESC', [cid, req.user.id]);
      return res.json({ ok: true, reviews: rows });
    }
    const rows = await db.query('SELECT id, conversation_id, result, bug_reason, created_at FROM reviews WHERE account_id=? ORDER BY id DESC LIMIT 100', [req.user.id]);
    res.json({ ok: true, reviews: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// telemetry 每日视图：GET /api/telemetry/daily?days=30[&shell_id=&provider=&model=]（§6.4 归集：模型×难度×档案、按壳、按天）
app.get('/api/telemetry/daily', requireAuth, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const conds = ['d >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
    const params = [days];
    if (Number(req.query.shell_id)) { conds.push('shell_id = ?'); params.push(Number(req.query.shell_id)); }
    if (req.query.provider) { conds.push('provider = ?'); params.push(String(req.query.provider)); }
    if (req.query.model) { conds.push('model = ?'); params.push(String(req.query.model)); }
    const rows = await db.query(`SELECT shell_id, provider, model, d, execs, tokens_in, tokens_out, cost, duration_ms FROM v_model_telemetry_daily WHERE ${conds.join(' AND ')} ORDER BY d DESC, cost DESC`, params);
    // 附：总览行（同口径合计，便于前端首屏）
    const ov = (await db.query(`SELECT COALESCE(SUM(execs),0) execs, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost),0) cost, COALESCE(SUM(duration_ms),0) duration_ms FROM v_model_telemetry_daily WHERE ${conds.join(' AND ')}`, params))[0] || {};
    res.json({ ok: true, days, total: ov, rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- ④ 知识库管理 API（§6.3/§8：管理视图按账号展示；会话可见语义由 F19/kb_* 各自生效） ----------
// 列表：GET /api/knowledge?scope=global|shell|conv[&kind=fact|progress|guide|skill|lesson][&shell_id=&q=]；scope=空=全部（管理视图）
app.get('/api/knowledge', requireAuth, async (req, res) => {
  try {
    const conds = ['k.account_id=?'];
    const params = [req.user.id];
    const scope = String(req.query.scope || '');
    if (['global', 'shell', 'conv'].includes(scope)) { conds.push('k.scope=?'); params.push(scope); }
    if (scope === 'shell' && Number(req.query.shell_id)) { conds.push('k.shell_id=?'); params.push(Number(req.query.shell_id)); }
    // 2026-09-09 文档型升级：kind 过滤（管理 Tab 用；缺省=全部，不改变默认查询语义）
    const kind = String(req.query.kind || '');
    if (kind && /^(fact|progress|guide|skill|lesson)$/.test(kind)) { conds.push('k.kind=?'); params.push(kind); }
    if (req.query.q) { const like = '%' + String(req.query.q).trim() + '%'; conds.push('(k.title LIKE ? OR k.body LIKE ?)'); params.push(like, like); }
    const rows = await db.query(
      `SELECT k.id, k.scope, k.shell_id, s.skey AS shell_key, k.conversation_id, k.kind, k.title, LEFT(k.body, 200) AS body_preview, k.created_at
       FROM knowledge k LEFT JOIN shells s ON s.id = k.shell_id
       WHERE ${conds.join(' AND ')} ORDER BY k.id DESC LIMIT 500`, params);
    res.json({ ok: true, knowledge: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 上传导入：POST /api/knowledge/import { name, data(base64), scope: global|shell|conv, shellKey?, conversationId?, kind? }
// 解析后批量入库：同 (账号,scope,shell_id/会话,kind) 下 title 已存在 → 更新 body（幂等覆盖），否则新增
app.post('/api/knowledge/import', requireAuth, async (req, res) => {
  try {
    const { name, data, scope, shellKey, conversationId } = req.body || {};
    if (!name || !data) return res.status(400).json({ ok: false, message: 'name 与 data(base64) 必填' });
    const sc = ['global', 'shell', 'conv'].includes(scope) ? scope : 'global';
    // 2026-09-09 kind：fact 运行事实[默认]/progress 进化进度/guide 平台规范/skill 技能/lesson 错题本（文档型升级，默认不改旧行为）
    const kind = /^(fact|progress|guide|skill|lesson)$/.test(String(req.body.kind || '')) ? String(req.body.kind) : 'fact';
    let shellId = null;
    if (sc === 'shell') {
      const sh = shellKey ? (await db.query('SELECT id FROM shells WHERE skey=? AND status="enabled"', [String(shellKey)]))[0] : null;
      if (!sh) return res.status(400).json({ ok: false, message: 'scope=shell 需要有效的 shellKey（启用中的壳）' });
      shellId = sh.id;
    }
    let convId = null;
    if (sc === 'conv') {
      if (!conversationId) return res.status(400).json({ ok: false, message: 'scope=conv 需要 conversationId' });
      const own = (await db.query('SELECT id FROM conversations WHERE id=? AND account_id=?', [conversationId, req.user.id]))[0];
      if (!own) return res.status(404).json({ ok: false, message: '会话不存在' });
      convId = conversationId;
    }
    const hasHeader = req.body.hasHeader !== false;
    const { rows } = await parseKnowledgeUpload(name, data, { hasHeader });
    if (!rows.length) return res.status(400).json({ ok: false, message: '文件解析后无可导入条目（全空或格式不符）' });
    let inserted = 0, updated = 0;
    for (const r of rows) {
      const exist = await db.query('SELECT id FROM knowledge WHERE account_id=? AND scope=? AND (shell_id<=>?) AND (conversation_id<=>?) AND kind=? AND title=? ORDER BY id DESC LIMIT 1',
        [req.user.id, sc, shellId, convId, kind, r.title]);
      if (exist.length) { await db.query('UPDATE knowledge SET body=?, created_at=NOW() WHERE id=?', [r.body, exist[0].id]); updated++; }
      else { await db.query('INSERT INTO knowledge (account_id, scope, conversation_id, shell_id, kind, title, body) VALUES (?,?,?,?,?,?,?)', [req.user.id, sc, convId, shellId, kind, r.title, r.body]); inserted++; }
    }
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'knowledge:import', 'scope=' + sc + (shellKey ? ' shell=' + shellKey : '') + ' kind=' + kind + ' file=' + String(name).slice(0, 120) + ' inserted=' + inserted + ' updated=' + updated]);
    res.json({ ok: true, scope: sc, shellKey: shellKey || null, kind, inserted, updated, total: rows.length });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 删除：DELETE /api/knowledge/:id（仅本账号条目）
app.delete('/api/knowledge/:id', requireAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM knowledge WHERE id=? AND account_id=?', [Number(req.params.id) || 0, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ ok: false, message: '知识条目不存在或无权删除' });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'knowledge:delete', 'id=' + req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- ⑥ 任务模板库 API（§6.5/D9 半成品：templates/<key>/tpl.json 随仓库 git；只读服务端，装配动作下发到壳） ----------
// 列表
app.get('/api/templates', requireAuth, async (req, res) => {
  try { res.json({ ok: true, templates: listTemplates() }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 详情
app.get('/api/templates/:key', requireAuth, async (req, res) => {
  const t = getTemplate(req.params.key);
  if (!t) return res.status(404).json({ ok: false, message: '模板不存在' });
  res.json({ ok: true, template: t });
});
// 开任务指令（壳内"从模板开任务"入口的提示文本；goal=本次具体目标可空）
app.post('/api/templates/:key/prompt', requireAuth, async (req, res) => {
  const t = getTemplate(req.params.key);
  if (!t) return res.status(404).json({ ok: false, message: '模板不存在' });
  const prompt = buildLaunchPrompt(t, (req.body || {}).goal || '');
  await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'template:prompt', req.params.key]);
  res.json({ ok: true, prompt });
});
// 共用：把 profile 片段 + skills 装配进指定壳（templates apply / apps launch 共用；同 key 覆盖、异 key 追加、技能 allow 去重）
async function ensureProfileOnShell(shellKey, frag, skills) {
  const sh = (await db.query('SELECT id, skey, task_profiles, skills_allow FROM shells WHERE skey=? AND status="enabled"', [shellKey]))[0];
  if (!sh) return { error: '壳不存在或未启用' };
  let profiles = [];
  try { profiles = typeof sh.task_profiles === 'string' ? JSON.parse(sh.task_profiles) : (sh.task_profiles || []); } catch { profiles = []; }
  if (!Array.isArray(profiles)) profiles = [];
  if (frag) {
    const idx = profiles.findIndex((p) => p && p.key === frag.key);
    if (idx >= 0) profiles[idx] = { ...profiles[idx], ...frag }; else profiles.push(frag);
  }
  let skillsAllow = [];
  try { skillsAllow = typeof sh.skills_allow === 'string' ? JSON.parse(sh.skills_allow) : (sh.skills_allow || []); } catch { skillsAllow = []; }
  if (!Array.isArray(skillsAllow)) skillsAllow = [];
  for (const s of (Array.isArray(skills) ? skills : [])) if (!skillsAllow.includes(s)) skillsAllow.push(s);
  await db.query('UPDATE shells SET task_profiles=?, skills_allow=?, updated_at=NOW() WHERE id=?',
    [JSON.stringify(profiles), JSON.stringify(skillsAllow), sh.id]);
  return { shellId: sh.id, profiles: profiles.length, skills: skillsAllow.length };
}

// 应用至壳：模板的 taskProfile（+skills.allow 并入）装配到指定壳 → 壳内会话点名该档案即按模板生效
app.post('/api/templates/:key/apply', requireAuth, async (req, res) => {
  try {
    const t = getTemplate(req.params.key);
    if (!t) return res.status(404).json({ ok: false, message: '模板不存在' });
    const frag = toProfileFragment(t);
    if (!frag) return res.status(400).json({ ok: false, message: '模板缺少可用 taskProfile' });
    const shellKey = String((req.body || {}).shellKey || '').trim();
    if (!isTplKeyOk(shellKey)) return res.status(400).json({ ok: false, message: 'shellKey 非法' });
    if (shellKey === 'default') return res.status(400).json({ ok: false, message: 'default 保留壳不可装配' });
    const r = await ensureProfileOnShell(shellKey, frag, t.skills);
    if (r.error) return res.status(404).json({ ok: false, message: r.error });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'template:apply', 'template=' + req.params.key + ' shell=' + shellKey + ' profile=' + frag.key]);
    res.json({ ok: true, shellKey, profile: frag.key, profiles: r.profiles, skills: r.skills });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- A2：任务模板 export/import/clone（§7.5 目标能力：模板=文件权威随 git，导出=下载 tpl.json；导入/克隆=写盘+自动 git 提交推送同步 origin） ----------
// 模板库 git 同步：模板目录是仓库文件权威；运行时导入/克隆直接写 ROOT/templates 后立即 add+commit+push origin main，
// 保持"本地=服务器=origin"三端一致（guard-deploy 要求服务器工作树干净、无未推送提交——导入后不推送会在下次部署被拦）。
async function syncTemplateGit(relPath, msg) {
  const { execFileSync } = await import('node:child_process');
  const opts = { cwd: ROOT, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] };
  execFileSync('git', ['add', relPath], opts);
  let committed = true;
  try {
    execFileSync('git', ['commit', '-m', msg], opts);
  } catch (e) {
    const out = String(e && e.stdout || '');
    if (/nothing to commit|no changes added/.test(out)) committed = false;
    else throw new Error('git commit 失败: ' + out.slice(0, 200));
  }
  if (committed) execFileSync('git', ['push', 'origin', 'main'], opts);
  return committed;
}

// 导出（下载完整 tpl.json；只读）
app.get('/api/templates/:key/export', requireAuth, async (req, res) => {
  try {
    const t = getTemplate(req.params.key);
    if (!t) return res.status(404).json({ ok: false, message: '模板不存在' });
    const content = JSON.stringify(t, null, 2);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'template:export', req.params.key]);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(t.key)}.tpl.json"`);
    res.type('application/json');
    res.send(content);
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 导入（新建/覆盖同 key；写盘后 git 提交推送，保持仓库同步）
app.post('/api/templates/import', requireAuth, async (req, res) => {
  try {
    const t = (req.body || {}).template;
    if (!t || typeof t !== 'object') return res.status(400).json({ ok: false, message: 'body.template 必填' });
    const v = validateTemplate(t);
    if (!v.ok) return res.status(400).json({ ok: false, message: '模板校验失败: ' + v.errors.join('; ') });
    const existed = fs.existsSync(templateFilePath(t.key));
    const r = writeTemplateFile(t);
    if (!r.ok) return res.status(400).json({ ok: false, message: r.errors.join('; ') });
    const committed = await syncTemplateGit(path.join('templates', t.key), (existed ? 'template:update ' : 'template:import ') + t.key);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, existed ? 'template:update' : 'template:import', t.key + (committed ? ' (git 已推送)' : ' (无变更)')]);
    res.json({ ok: true, key: t.key, mode: existed ? 'updated' : 'created', gitSynced: committed });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 克隆（源目录整体复制 + 改写 key；写盘后 git 提交推送）
app.post('/api/templates/:key/clone', requireAuth, async (req, res) => {
  try {
    const fromKey = req.params.key;
    const newKey = String((req.body || {}).newKey || '').trim();
    const name = String((req.body || {}).name || '').trim();
    if (!isTplKeyOk(newKey)) return res.status(400).json({ ok: false, message: 'newKey 需为小写字母数字连字符' });
    if (newKey === fromKey) return res.status(400).json({ ok: false, message: 'newKey 不能与源相同' });
    const r = cloneTemplate(fromKey, newKey, { name });
    if (!r.ok) {
      const code = r.exists ? 409 : 400;
      return res.status(code).json({ ok: false, message: r.errors ? r.errors.join('; ') : '目标模板已存在' });
    }
    const committed = await syncTemplateGit(path.join('templates', newKey), 'template:clone ' + fromKey + '->' + newKey);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'template:clone', fromKey + '->' + newKey + (committed ? ' (git 已推送)' : '')]);
    res.json({ ok: true, key: newKey, gitSynced: committed });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- D9 应用形态 v1 API（壳内启动式应用；§6.5/D9：apps/<key>/app.json 随仓库 git） ----------
app.get('/api/apps', requireAuth, async (req, res) => {
  try { res.json({ ok: true, apps: listApps() }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.get('/api/apps/:key', requireAuth, async (req, res) => {
  const a = getApp(req.params.key);
  if (!a) return res.status(404).json({ ok: false, message: '应用不存在' });
  res.json({ ok: true, app: a });
});
// 启动应用：可选把 entryProfile+skills 装配到目标壳 → 建挂壳会话（title=应用名）→ 返回 conversationId + 启动草稿
// （草稿由前端填入对话页输入框供用户编辑后发送 = 应用语境进入本轮；不建第二套会话体系）
app.post('/api/apps/:key/launch', requireAuth, async (req, res) => {
  try {
    const a = getApp(req.params.key);
    if (!a) return res.status(404).json({ ok: false, message: '应用不存在' });
    // 目标壳：body.shellKey > app.targetShell；default 壳语义=不装配档案、会话不挂壳
    let shellKey = String((req.body || {}).shellKey || '').trim() || (a.targetShell || '');
    shellKey = shellKey && shellKey !== 'default' ? shellKey : '';
    let shellId = null;
    if (shellKey) {
      if (!isAppKeyOk(shellKey)) return res.status(400).json({ ok: false, message: 'shellKey 非法' });
      const frag = toAppProfileFragment(a);
      const r = await ensureProfileOnShell(shellKey, frag, a.skills);
      if (r.error) return res.status(404).json({ ok: false, message: r.error });
      shellId = r.shellId;
    }
    const c = await db.query('INSERT INTO conversations (account_id, title, permission, preset, shell_id) VALUES (?,?,?,?,?)',
      [req.user.id, String(a.name || a.key).slice(0, 60), 'full', 'all', shellId]);
    const draft = buildLaunchDraft(a, (req.body || {}).goal || '');
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'app:launch', 'app=' + a.key + (shellKey ? ' shell=' + shellKey : '') + ' conv=' + c.insertId]);
    res.json({ ok: true, conversationId: c.insertId, shellKey: shellKey || null, draft });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- A0 扩展中心数据载体 API（2026-09-11，总方案 §9.3 载体①②④⑤；插件/MCP/应用统一注册、壳装载、需求反馈） ----------
const EXT_STATUS_CN = { dev: '研发', test: '测试', published: '已上架', retired: '退役' };
const DEMAND_KIND_CN = { hard: '硬信号', soft: '软信号', manual: '主动' };
function extToApi(e) {
  return {
    type: e.asset_type, key: e.akey, name: e.name, version: e.version,
    status: e.status, statusCn: EXT_STATUS_CN[e.status] || e.status,
    scope: e.scope, capability: safeJson(e.capability), manifestRef: e.manifest_ref || '',
    meta: safeJson(e.meta), loadedShells: Number(e.loaded_shells || 0), openDemands: Number(e.open_demands || 0),
    createdAt: e.created_at, updatedAt: e.updated_at,
  };
}
// 资产列表（可 type/关键词过滤；带装载壳数与待审需求计数）
app.get('/api/extensions', requireAuth, async (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const q = String(req.query.q || '').trim();
    const rows = await db.query(
      `SELECT e.*,
         (SELECT COUNT(*) FROM shell_extensions se WHERE se.asset_type=e.asset_type AND se.asset_key=e.akey) AS loaded_shells,
         (SELECT COUNT(*) FROM extension_demands d WHERE d.asset_key=e.akey AND d.status='待审') AS open_demands
       FROM extensions e
       WHERE (?='' OR e.asset_type=?) AND (?='' OR e.name LIKE ? OR e.akey LIKE ?)
       ORDER BY e.updated_at DESC`, [type, type, q, `%${q}%`, `%${q}%`]);
    res.json({ ok: true, extensions: rows.map(extToApi) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 注册资产（平台研发/上架入口；审计 ext:register）
app.post('/api/extensions', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.type || '').trim(); const key = String(b.key || '').trim();
    if (!['plugin', 'mcp', 'app'].includes(type)) return res.status(400).json({ ok: false, message: 'type 需为 plugin|mcp|app' });
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) return res.status(400).json({ ok: false, message: 'key 需为小写字母数字连字符' });
    const status = ['dev', 'test', 'published', 'retired'].includes(b.status) ? b.status : 'dev';
    const scope = b.scope === 'shell' ? 'shell' : 'global';
    await db.query('INSERT INTO extensions (asset_type, akey, name, version, status, scope, capability, manifest_ref, meta) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), version=VALUES(version), status=VALUES(status), scope=VALUES(scope), capability=VALUES(capability), manifest_ref=VALUES(manifest_ref), meta=VALUES(meta), updated_at=NOW()',
      [type, key, String(b.name || key).slice(0, 128), String(b.version || '0.1.0').slice(0, 32), status, scope,
       b.capability != null ? JSON.stringify(b.capability) : null, String(b.manifestRef || '').slice(0, 255), b.meta != null ? JSON.stringify(b.meta) : null]);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:register', 'type=' + type + ' key=' + key + ' status=' + status]);
    res.json({ ok: true, type, key, status });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 需求列表与审（进化集审批台；审计 ext:demand_status）——须先于 /:type/:key/status 匹配（路由顺序）
app.get('/api/extensions/demands', requireAuth, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const rows = await db.query('SELECT id, asset_key, kind, source, content, status, created_at FROM extension_demands WHERE (?=\'\' OR status=?) ORDER BY created_at DESC LIMIT 200', [status, status]);
    res.json({ ok: true, demands: rows.map((d) => ({ ...d, kindCn: DEMAND_KIND_CN[d.kind] || d.kind })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
app.patch('/api/extensions/demands/:id/status', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id); const status = String((req.body || {}).status || '').trim();
    if (!['待审', '采纳', '驳回', '升级'].includes(status)) return res.status(400).json({ ok: false, message: 'status 需为 待审|采纳|驳回|升级' });
    const r = await db.query('UPDATE extension_demands SET status=? WHERE id=?', [status, id]);
    if (!r.affectedRows) return res.status(404).json({ ok: false, message: '需求不存在' });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:demand_status', 'id=' + id + ' status=' + status]);
    res.json({ ok: true, id, status });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 变更资产状态（平台上架/退役等；审计 ext:status）
// A3 发布闸门：转 published 需已声明能力（capability 或 manifest_ref），防"空壳上架"（§8.8 插件需注册 manifest）
app.patch('/api/extensions/:type/:key/status', requireAuth, async (req, res) => {
  try {
    const type = req.params.type, key = req.params.key;
    const status = String((req.body || {}).status || '').trim();
    if (!['dev', 'test', 'published', 'retired'].includes(status)) return res.status(400).json({ ok: false, message: 'status 需为 dev|test|published|retired' });
    const [e] = await db.query('SELECT capability, manifest_ref FROM extensions WHERE asset_type=? AND akey=?', [type, key]);
    if (!e) return res.status(404).json({ ok: false, message: '资产不存在' });
    if (status === 'published' && !e.capability && !e.manifest_ref) {
      return res.status(400).json({ ok: false, message: '发布闸门：上架需先声明能力（capability 或 manifest_ref），请先补全资产信息' });
    }
    const r = await db.query('UPDATE extensions SET status=?, updated_at=NOW() WHERE asset_type=? AND akey=?', [status, type, key]);
    if (!r.affectedRows) return res.status(404).json({ ok: false, message: '资产不存在' });
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:status', 'type=' + type + ' key=' + key + ' status=' + status]);
    res.json({ ok: true, type, key, status });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 单资产详情（含装载壳与需求列表）
app.get('/api/extensions/:type/:key', requireAuth, async (req, res) => {
  try {
    const { type, key } = req.params;
    const [e] = await db.query('SELECT * FROM extensions WHERE asset_type=? AND akey=?', [type, key]);
    if (!e) return res.status(404).json({ ok: false, message: '资产不存在' });
    const loaded = await db.query('SELECT shell_id, asset_type, asset_key, enabled_at FROM shell_extensions WHERE asset_type=? AND asset_key=? ORDER BY enabled_at DESC', [type, key]);
    const demands = await db.query('SELECT id, asset_key, kind, source, content, status, created_at FROM extension_demands WHERE asset_key=? ORDER BY created_at DESC LIMIT 50', [key]);
    res.json({ ok: true, extension: extToApi({ ...e, loaded_shells: loaded.length, open_demands: demands.filter((d) => d.status === '待审').length }), loadedShells: loaded, demands: demands.map((d) => ({ ...d, kindCn: DEMAND_KIND_CN[d.kind] || d.kind })) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 壳的装载列表（装配向导/壳详情）
app.get('/api/shells/:key/extensions', requireAuth, async (req, res) => {
  try {
    const key = req.params.key;
    const [sh] = await db.query('SELECT id FROM shells WHERE skey=?', [key]);
    if (!sh) return res.status(404).json({ ok: false, message: '壳不存在' });
    const rows = await db.query('SELECT se.asset_type, se.asset_key, se.enabled_at, e.name, e.status FROM shell_extensions se LEFT JOIN extensions e ON e.asset_type=se.asset_type AND e.akey=se.asset_key WHERE se.shell_id=? ORDER BY se.enabled_at DESC', [sh.id]);
    res.json({ ok: true, shellKey: key, extensions: rows });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 壳装载/卸载（整表替换 = 装配向导 step6 产物；审计 ext:load）
app.put('/api/shells/:key/extensions', requireAuth, async (req, res) => {
  try {
    const key = req.params.key;
    const [sh] = await db.query('SELECT id FROM shells WHERE skey=?', [key]);
    if (!sh) return res.status(404).json({ ok: false, message: '壳不存在' });
    const list = Array.isArray((req.body || {}).extensions) ? req.body.extensions : [];
    for (const it of list) if (!it || !['plugin', 'mcp', 'app'].includes(it.type) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(it.key || ''))) return res.status(400).json({ ok: false, message: 'extensions 项需含合法 type/key' });
    await db.query('DELETE FROM shell_extensions WHERE shell_id=?', [sh.id]);
    for (const it of list) await db.query('INSERT IGNORE INTO shell_extensions (shell_id, asset_type, asset_key) VALUES (?,?,?)', [sh.id, it.type, it.key]);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:load', 'shell=' + key + ' count=' + list.length + ' ' + list.map((i) => i.type + ':' + i.key).join(',')]);
    res.json({ ok: true, shellKey: key, count: list.length });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 需求/升级反馈提交（软信号轻确认/💡按钮/日报；审计 ext:demand）
// A3 单一 intake（§8.8 收敛与分层①）：fields={scene 触发场景, effect 期望效果, shells 涉及壳, actionType 代码动作类型} 字段齐才立项
app.post('/api/extensions/:key/demand', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key || '').slice(0, 64);
    const b = req.body || {};
    const kind = ['hard', 'soft', 'manual'].includes(b.kind) ? b.kind : 'manual';
    let content = String(b.content || '').trim();
    if (b.fields && typeof b.fields === 'object') {
      const f = b.fields;
      const scene = String(f.scene || '').trim(); const effect = String(f.effect || '').trim();
      const shells = String(f.shells || '').trim(); const actionType = String(f.actionType || '').trim();
      if (!scene || !effect || !shells || !actionType) {
        return res.status(400).json({ ok: false, message: '需求采集字段需齐备：触发场景/期望效果/涉及壳/代码动作类型' });
      }
      content = `【触发场景】${scene}\n【期望效果】${effect}\n【涉及壳】${shells}\n【代码动作类型】${actionType}`;
    }
    if (!content) return res.status(400).json({ ok: false, message: 'content 或 fields 必填' });
    const source = String(b.source || '扩展中心').slice(0, 24);
    const r = await db.query('INSERT INTO extension_demands (asset_key, kind, source, content) VALUES (?,?,?,?)', [key || null, kind, source, content.slice(0, 2000)]);
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:demand', 'asset=' + (key || '通用') + ' kind=' + kind + ' id=' + r.insertId]);
    res.json({ ok: true, id: r.insertId, kindCn: DEMAND_KIND_CN[kind] });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- A3 扩展中心批：MCP 资产化 + 指标 v1 两层 + 发布闸门（§8.8/§9.3 载体） ----------
// MCP 资产化：把 settings mcp_servers（已配置/已连接）登记进 extensions(type=mcp)。
// akey=server id（与工具名前缀 mcp_<id>_ 对齐）；meta 快照工具数与连接态；提示注入防线触发注（外部不可信输入）。
app.post('/api/extensions/mcp-sync', requireAuth, async (req, res) => {
  try {
    const mcp = await import('./mcp.js');
    const cfg = await getSetting('mcp_servers', []);
    if (!Array.isArray(cfg)) return res.status(400).json({ ok: false, message: 'settings mcp_servers 非数组' });
    const clients = new Map((mcp.listMcpClients() || []).map((c) => [c.id, c]));
    const out = [];
    for (const s of cfg) {
      if (!s || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(String(s.id || ''))) continue;
      const cl = clients.get(s.id);
      const tools = (cl && cl.tools) || [];
      const meta = {
        mcpServerId: s.id, toolCount: tools.length, connected: !!cl,
        untrustedInput: true, // §11.4 提示注入防线触发条件：外部 MCP=不可信输入
        note: 'MCP 资产化（A3）：settings mcp_servers 自动登记；连接态工具快照于 meta',
      };
      const cap = { type: 'mcp', tools: tools.map((t) => t.name), serverId: s.id };
      const existing = (await db.query('SELECT id, status FROM extensions WHERE asset_type="mcp" AND akey=?', [s.id]))[0];
      // 已有资产保留其状态（防止 sync 覆盖研发/退役等人工状态）；新增默认 published（已配置可用）
      const status = existing ? existing.status : (cl ? 'published' : 'dev');
      await db.query('INSERT INTO extensions (asset_type, akey, name, version, status, scope, capability, manifest_ref, meta) VALUES ("mcp",?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), version=VALUES(version), status=VALUES(status), capability=VALUES(capability), manifest_ref=VALUES(manifest_ref), meta=VALUES(meta), updated_at=NOW()',
        [s.id, String(s.name || s.id).slice(0, 128), '0.1.0', status, 'global', JSON.stringify(cap), null, JSON.stringify(meta)]);
      out.push({ id: s.id, status, tools: tools.length, connected: !!cl });
    }
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [req.user.id, 'ext:mcp_sync', 'count=' + out.length + ' ' + out.map((x) => x.id + ':' + x.status).join(',')]);
    res.json({ ok: true, synced: out.length, items: out });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});
// 指标 v1 两层（健康度+活跃度；§8.8 监控四层①②）：MCP 资产按 mcp_<id>_ 前缀聚合 tool_calls（status/duration_ms/shell_id）；
// 插件/应用尚无调用维度（tool_calls 缺 asset 维度，§9.3 载体③ 后置）→ 返回占位并注明。需求数/装载数始终给。
app.get('/api/extensions/metrics', requireAuth, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const type = String(req.query.type || '').trim();
    const q = String(req.query.q || '').trim();
    const conds = ['1=1']; const params = [];
    if (type) { conds.push('asset_type=?'); params.push(type); }
    if (q) { conds.push('(name LIKE ? OR akey LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    const assets = await db.query(`SELECT id, asset_type, akey, name, status, meta FROM extensions WHERE ${conds.join(' AND ')} ORDER BY asset_type, akey`, params);
    const out = [];
    for (const a of assets) {
      const base = { type: a.asset_type, key: a.akey, name: a.name, status: a.status };
      const loaded = (await db.query('SELECT COUNT(*) c FROM shell_extensions WHERE asset_type=? AND asset_key=?', [a.asset_type, a.akey]))[0].c;
      const openDemands = (await db.query('SELECT COUNT(*) c FROM extension_demands WHERE asset_key=? AND status="待审"', [a.akey]))[0].c;
      base.loadedShells = Number(loaded); base.openDemands = Number(openDemands);
      if (a.asset_type === 'mcp' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(String(a.akey))) {
        // 健康度：30d 调用/失败/均耗时；活跃度：活跃壳会话数/调用次数（含轻量会话维度）
        const agg = (await db.query(
          `SELECT COUNT(*) c, SUM(status="fail") fails, COALESCE(AVG(duration_ms),0) avgMs,
                  COUNT(DISTINCT shell_id) shells, COUNT(DISTINCT conversation_id) convs
           FROM tool_calls WHERE tool_name LIKE ? AND created_at > NOW() - INTERVAL ? DAY`,
          ['mcp\\_' + a.akey + '\\_%', days]))[0] || {};
        base.dim = 'tool_calls(mcp 前缀)';
        base.days = days;
        base.calls = Number(agg.c || 0); base.fails = Number(agg.fails || 0);
        base.failRate = base.calls ? Math.round((base.fails / base.calls) * 100) / 100 : 0;
        base.avgMs = Math.round(Number(agg.avgMs || 0));
        base.activeShells = Number(agg.shells || 0); base.activeConvs = Number(agg.convs || 0);
      } else {
        base.dim = null; // tool_calls 无 asset 维度 → 插件/应用调用统计随留痕维度批（§9.3 载体③）
        base.note = '调用维度待 tool_calls 增 asset 留痕（后置）；当前给出需求/装载计数';
      }
      out.push(base);
    }
    res.json({ ok: true, days, metrics: out });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

// ---------- 静态前端 ----------
const webDist = path.join(ROOT, 'web', 'dist');
app.use(express.static(webDist));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
});
// Express 错误中间件（须在全部路由之后）：async 路由 rejection → 500 而非进程崩溃
app.use((err, req, res, next) => {
  console.error('[rw] 路由错误:', err && (err.stack || err.message));
  if (res.headersSent) { res.end(); return; }
  res.status(500).json({ ok: false, message: '服务内部错误: ' + String((err && err.message) || err).slice(0, 200) });
});

// ---------- 启动 ----------
async function main() {
  await initSchema();
  await ensureAdmin();
  // 初始化 providers 表（同步硬编码 9 家）+ 默认模型 + 每日市场刷新
  try {
    const pCount = await db.query('SELECT COUNT(*) c FROM providers');
    if (!pCount[0]?.c) {
      for (const p of allProviders(config.keys)) {
        const r = await db.query('INSERT INTO providers (provider_key, name, base_url, api_key_env, enabled, sort_order) VALUES (?,?,?,?,1,?)', [p.id, p.name, p.base, p.keyEnv, p.id === 'deepseek' ? 0 : 10]);
        if (p.defaultModel) {
          await db.query('INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1',
            [r.insertId, p.defaultModel, p.name + ' 默认模型', JSON.stringify(p.capabilities || ['chat'])]);
        }
      }
    }
  } catch { /* 初始化失败不阻塞 */ }
  // 存量库修正：主默认模型统一 deepseek-v4-flash（reasoning 透传/思考可见），停用 deepseek-chat 别名
  try {
    const dpr = await db.query('SELECT id FROM providers WHERE provider_key=?', ['deepseek']);
    if (dpr[0]) {
      await db.query('INSERT INTO models (provider_id, model_id, name, capabilities, enabled, added_at, last_seen_at) VALUES (?,?,?,?,1,NOW(),NOW()) ON DUPLICATE KEY UPDATE enabled=1',
        [dpr[0].id, 'deepseek-v4-flash', 'DeepSeek V4 Flash（默认）', JSON.stringify(['chat', 'code', 'reasoning'])]);
      await db.query('UPDATE models SET enabled=0 WHERE provider_id=? AND model_id=?', [dpr[0].id, 'deepseek-chat']);
    }
  } catch { /* 修正失败不阻塞 */ }
  // 模型目录同步：各厂商 chatModels（主对话模型清单）入库供菜单可选；已存在不覆盖人工开关状态
  try {
    const prow = await db.query('SELECT id, provider_key FROM providers');
    let synced = 0;
    for (const row of prow) synced += await syncChatModels(db, row);
    if (synced > 0) console.log(`[catalog] 模型目录同步完成：${synced} 个厂商目录已核对`);
  } catch (e) { console.error('[catalog] 同步失败:', e.message); }
  // 重启自检：遗留 running 现场 → interrupted（断点恢复外壳）
  try { await interruptStaleOnBoot(); } catch (e) { console.error('[runtrack] 重启自检失败:', e.message); }
  // D5 启动清理：24h 前仍 running 的后台任务标记 stale（父进程可能已退出/僵尸残留；不 kill 防误伤新 pid，仅显式标记便于 job_list 识别）
  // E4 修正：先探测日志文件活跃度——若日志 24h 内仍在写入（任务实际仍在产出）则不标 stale，避免误标合法长任务
  try {
    const staleCandidates = await db.query("SELECT job_id, log_file FROM long_jobs WHERE status='running' AND started_at < NOW() - INTERVAL 24 HOUR");
    let staleN = 0, aliveN = 0;
    for (const row of staleCandidates) {
      try {
        const st = await fs.promises.stat(row.log_file);
        const mtimeMs = st.mtimeMs;
        const active = Date.now() - mtimeMs < 24 * 3600 * 1000; // 日志 24h 内有新写入 = 仍活跃
        if (active) { aliveN++; continue; }
      } catch { /* 日志文件缺失/不可读：无产出依据，按陈旧处理 */ }
      await db.query("UPDATE long_jobs SET status='stale', updated_at=NOW() WHERE job_id=?", [row.job_id]);
      staleN++;
    }
    if (staleN > 0 || aliveN > 0) console.log(`[jobs] 启动清理：标记 ${staleN} 个陈旧 running 任务为 stale，保留 ${aliveN} 个日志仍活跃的任务`);
  } catch (e) { console.error('[jobs] 启动清理失败:', e.message); }
  scheduleMarketRefresh();
  // 定时任务调度器（F14）
  try { startScheduler(); } catch (e) { console.error('[scheduler] 启动失败:', e.message); }
  // 任务契约驱动器（外部驱动：无人值守责任循环）
  try { startDriver(); } catch (e) { console.error('[driver] 启动失败:', e.message); }
  // P11 MCP client（2026-09 批5）：按 settings mcp_servers 连接外部 MCP server（异步不阻塞启动）
  (async () => {
    try {
      const mcp = await import('./mcp.js');
      const { syncMcpExtras } = await import('./tools/index.js');
      const r = await mcp.connectConfiguredMcps();
      const clients = mcp.listMcpClients();
      const n = syncMcpExtras(clients);
      console.log('[mcp] 连接结果: ' + JSON.stringify(r) + ' → 注册 MCP 工具 ' + n + ' 个');
    } catch (e) { console.error('[mcp] 启动连接失败(可稍后配置 mcp_servers):', e.message); }
  })();
  // P11 MCP 看门狗（2026-09 安全修复随行）：配置了 mcp_servers 时，任一 client 意外退出（进程重启/子进程死亡）
  // 后 60s 内自动重连并同步工具（否则会话静默缺 mcp_* 工具直到手动 reload）
  const mcpWatchdog = setInterval(async () => {
    try {
      const mcp = await import('./mcp.js');
      const { syncMcpExtras } = await import('./tools/index.js');
      const cfg = await getSetting('mcp_servers', []);
      if (!Array.isArray(cfg) || cfg.length === 0) return;
      const connected = mcp.listMcpClients();
      const missing = cfg.filter((s) => s && s.id && !connected.some((c) => c.id === s.id));
      if (missing.length === 0) return;
      const r = await mcp.connectConfiguredMcps(); // 已连接的自动跳过（connectMcp 幂等）
      const n = syncMcpExtras(mcp.listMcpClients());
      console.log('[mcp] 看门狗重连 ' + missing.map((s) => s.id).join(',') + ' → ' + JSON.stringify(r) + ' 注册工具 ' + n);
    } catch (e) { console.error('[mcp] 看门狗失败:', e.message); }
  }, 60000);
  if (mcpWatchdog.unref) mcpWatchdog.unref(); // 不阻塞进程退出
  // 微信渠道（W1-W6，默认启动；复用 iLink 登录态）
  if (process.env.RW_WECHAT !== '0') {
    startWechatChannel().catch((e) => console.error('[wechat] 启动异常:', e.message));
  }
  // 飞书 webhook（F1-F5，需公网 HTTPS 回调；PROD 域名阶段启用，TEST 可用隧道）
  if (process.env.RW_FEISHU_WEBHOOK === '1') {
    registerFeishuWebhook(app);
  }
  app.listen(config.port, () => {
    console.log(`[RW] Roni Workbench 启动: http://localhost:${config.port} (env=${process.env.NODE_ENV || 'dev'})`);
  });
}

main().catch((e) => {
  console.error('[RW] 启动失败:', e.message);
  process.exit(1);
});
