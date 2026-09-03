// server/tools/index.js - RW Agent 工具注册表（v2.0 文档 B1-B29）
// 每个工具：name / description / permission(read|write|full|global) / params / run(args, ctx)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { extractPdf, extractDocx, extractXlsx, extractPptx } from './extract.js';
import { db, bumpPolicyRev } from '../db.js';
import { feishuConfigured, readFeishuDoc, readFeishuSheet, readFeishuBitable } from './feishu.js';
import { createApproval, cancelApproval } from '../approval.js';
import { requestRestart } from '../restart.js';
import { createAsk, cancelAsk } from '../asks.js';
import { TOOL_META } from './meta.js';

// F20 受控工具：guard 权限会话中执行前必须经用户批准（默认 full 权限不受影响）
const GUARDED_TOOLS = new Set(['delete_file', 'db_write', 'git_pull_push', 'run_command', 'kill_process']);

// 计划模式（plan_mode）禁用的改动类工具：会话 mode=plan 时直接拒绝（只读）
const MUTATING_TOOLS = new Set([
  'write_file', 'append_file', 'edit_file', 'delete_file', 'mkdir', 'copy_move',
  'run_command', 'run_long_task', 'kill_process', 'db_write',
  'git_commit', 'git_pull_push', 'skill_save', 'set_limits', 'reload_platform',
]);

// 路径安全：write 级限定工作区（limitPath 时检查）
export const WORKSPACE = process.env.RW_WORKSPACE || '/srv/rw-workspace';
// 技能根目录（F15）：skills/<名称>/SKILL.md
export const SKILLS_ROOT = process.env.RW_SKILLS || path.join(WORKSPACE, 'skills');

// SKILL.md frontmatter 极简解析（--- 块内 name:/description:/version:）
function parseSkillFront(full) {
  const m = String(full).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: m ? String(full).slice(m[0].length) : String(full) };
}

function inside(p, root) {
  const r = path.resolve(root);
  return path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep);
}

function runCmd(cmd, args, opts = {}, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || '').slice(0, 8000), err: String(stderr || '').slice(0, 2000) });
    });
  });
}

const readTxt = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { throw new Error('读取失败: ' + e.message); } };

// 后台任务注册表（run_long_task 写入，job_list/job_output 读取）
export const jobs = new Map();
// 长期运行护栏：已退出任务保留 12 小时；总量超 200 淘汰最老的已完成项
const JOB_TTL_MS = 12 * 60 * 60 * 1000;
const JOB_MAX = 200;
function pruneJobs() {
  const now = Date.now();
  let doneCount = 0;
  for (const [id, j] of jobs) {
    if (j.status === 'exited' && now - (j.started || 0) > JOB_TTL_MS) jobs.delete(id);
    else if (j.status === 'exited') doneCount++;
  }
  if (doneCount > JOB_MAX) {
    const finished = [...jobs.entries()].filter(([, j]) => j.status === 'exited')
      .sort((a, b) => (a[1].started || 0) - (b[1].started || 0));
    for (const [id] of finished.slice(0, doneCount - JOB_MAX)) jobs.delete(id);
  }
}
// 会话任务清单（F9：plan_tasks/plan_done 使用；key=conversationId）
export const plans = new Map();

function planOf(ctx) {
  const key = String(ctx.conversationId || 'g');
  if (!plans.has(key)) plans.set(key, { steps: [], done: 0 });
  return plans.get(key);
}

export const TOOLS = [
  // ---------- B1-B10 文件 ----------
  { name: 'read_file', description: '读取文本文件内容（max 50KB）', permission: 'read',
    params: { path: { type: 'string', required: true, desc: '文件绝对路径' } },
    run: async (a) => ({ content: readTxt(a.path).slice(0, 50000) }) },
  { name: 'write_file', description: '写入文件（创建/覆盖）', permission: 'write',
    params: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.path, ctx.root)) throw new Error('路径超出工作区'); fs.mkdirSync(path.dirname(a.path), { recursive: true }); fs.writeFileSync(a.path, a.content, 'utf8'); return { saved: true, bytes: a.content.length }; } },
  { name: 'append_file', description: '追加内容到文件', permission: 'write',
    params: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.path, ctx.root)) throw new Error('路径超出工作区'); fs.appendFileSync(a.path, a.content, 'utf8'); return { saved: true }; } },
  { name: 'edit_file', description: '精确增量修改文件：把 old 原文替换为 new 新文（只改局部，避免整文件重写；old 必须与文件现有内容完全一致）', permission: 'write',
    params: { path: { type: 'string', required: true, desc: '文件路径' }, old: { type: 'string', required: true, desc: '要替换的原文（必须完全匹配文件内容）' }, new: { type: 'string', desc: '新内容（默认删除 old）' } },
    run: async (a, ctx) => {
      if (ctx.limitPath && !inside(a.path, ctx.root)) throw new Error('路径超出工作区');
      const content = fs.readFileSync(a.path, 'utf8');
      if (!content.includes(a.old)) throw new Error('未找到要替换的原文（old 须与文件内容完全匹配，可用 read_file 先确认）');
      const updated = content.split(a.old).join(a.new ?? '');
      fs.writeFileSync(a.path, updated, 'utf8');
      return { edited: true, diff: '- ' + String(a.old).slice(0, 500) + '\n+ ' + String(a.new ?? '').slice(0, 500) };
    } },
  { name: 'list_dir', description: '列出目录内容', permission: 'read',
    params: { path: { type: 'string', required: false, desc: '默认工作区' } },
    run: async (a, ctx) => { const p = a.path || ctx.root; return { entries: fs.readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })).slice(0, 200) }; } },
  { name: 'mkdir', description: '创建目录', permission: 'write',
    params: { path: { type: 'string', required: true } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.path, ctx.root)) throw new Error('路径超出工作区'); fs.mkdirSync(a.path, { recursive: true }); return { created: true }; } },
  { name: 'copy_move', description: '复制或移动文件/目录（mode: copy|move）', permission: 'write',
    params: { src: { type: 'string', required: true }, dst: { type: 'string', required: true }, mode: { type: 'string', enum: ['copy', 'move'], desc: 'copy=复制 | move=移动' } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.dst, ctx.root)) throw new Error('目标超出工作区'); if (a.mode === 'move') fs.renameSync(a.src, a.dst); else fs.copyFileSync(a.src, a.dst); return { ok: true }; } },
  { name: 'delete_file', description: '删除文件（高危，留痕）', permission: 'full',
    params: { path: { type: 'string', required: true } },
    run: async (a) => { fs.rmSync(a.path, { recursive: true, force: true }); return { deleted: true }; } },
  { name: 'find_file', description: '按文件名子串查找文件（name 无需通配符，如找 index.html 传 "index.html" 或 "html" 即可；不支持 * 通配）', permission: 'read',
    params: { path: { type: 'string', required: false }, name: { type: 'string', required: true } },
    run: async (a, ctx) => {
      const root = a.path || ctx.root; const out = [];
      const walk = (d) => { let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) { const f = path.join(d, it.name); if (it.isDirectory()) { if (!['node_modules', '.git'].includes(it.name)) walk(f); } else if (it.name.includes(a.name)) out.push(f); } };
      walk(root); return { matches: out.slice(0, 100) };
    } },
  { name: 'grep_search', description: '在目录中按正则搜索文件内容', permission: 'read',
    params: { path: { type: 'string', required: false }, pattern: { type: 'string', required: true } },
    run: async (a, ctx) => {
      const root = a.path || ctx.root; const re = new RegExp(a.pattern); const out = [];
      const walk = (d) => { let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) { const f = path.join(d, it.name); if (it.isDirectory()) { if (!['node_modules', '.git'].includes(it.name)) walk(f); } else if (/\.(js|ts|jsx|tsx|md|json|yaml|yml|txt|html|css)$/.test(it.name)) { try { if (re.test(fs.readFileSync(f, 'utf8'))) out.push(f); } catch { } } } };
      walk(root); return { matches: out.slice(0, 100) };
    } },
  { name: 'read_file_range', description: '分段读取大文件（offset 字符偏移）', permission: 'read',
    params: { path: { type: 'string', required: true }, offset: { type: 'number' }, length: { type: 'number' } },
    run: async (a) => { const c = readTxt(a.path); const off = a.offset || 0; return { content: c.slice(off, off + (a.length || 10000)) }; } },

  // ---------- B20 OCR（视觉模型文字识别：稳定可用；tesseract CDN 语言包在国内不可靠已弃用） ----------
  { name: 'ocr_image', description: '图片文字识别/OCR：调用视觉模型提取图中文字与内容（支持本地图片路径或 http(s) URL）', permission: 'read',
    params: { path: { type: 'string', required: true, desc: '图片文件路径或 URL' } },
    run: async (a) => {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error('未配置 DeepSeek key');
      let dataUrl;
      if (/^https?:\/\//.test(a.path)) dataUrl = a.path;
      else {
        const buf = fs.readFileSync(a.path);
        const ext = path.extname(a.path).toLowerCase().replace('.', '') || 'png';
        const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }[ext] || 'png';
        dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
      }
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: 'deepseek-v4-flash-vision-exp',
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: '请识别这张图片中的所有文字并原样输出（OCR）。如果图中有版式，按从上到下、从左到右排列；没有文字就说没有文字。' }] }],
          max_tokens: 1200,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('OCR 视觉调用失败: ' + (j.error?.message || res.status));
      return { text: (j.choices?.[0]?.message?.content || '').slice(0, 8000) };
    } },

  // ---------- B11-B13 命令 ----------
  { name: 'run_command', description: '执行 shell 命令（**最后手段**，仅在无专门工具时用：读文件请用 read_file、列目录用 list_dir、搜索用 grep_search、查找用 find_file、查文件信息用 list_dir；本工具只用于专门工具覆盖不了的操作，如安装依赖 npm install、启动服务、系统管理等。注意 shell 引号与管道易出错，尽量用专门工具避免）', permission: 'full',
    params: { cmd: { type: 'string', required: true, desc: '命令（如 npm install）' }, timeout: { type: 'number', desc: '超时秒数 5-300，默认 30' } },
    run: async (a, ctx) => {
      if (ctx.limitPath) {
        const allow = ['ls', 'cat', 'node --check', 'git status', 'npm test', 'pwd', 'echo', 'find', 'grep'];
        if (!allow.some((p) => a.cmd.startsWith(p))) throw new Error('write 级仅允许工作区常用命令，此命令需 full 权限');
      }
      const [cmd, ...args] = a.cmd.split(/\s+/);
      const t = Math.min(300, Math.max(5, Number(a.timeout) || 30)) * 1000;
      const r = await runCmd(cmd, args, { cwd: ctx.root }, t);
      return { ok: r.ok, stdout: r.out, stderr: r.err, code: r.code };
    } },
  { name: 'run_long_task', description: '后台运行长任务（不阻塞），返回 jobId；用 job_output 查看输出，kill_process 终止', permission: 'full',
    params: { cmd: { type: 'string', required: true } },
    run: async (a) => {
      pruneJobs();
      const [cmd, ...args] = a.cmd.split(/\s+/);
      const { spawn } = await import('node:child_process');
      const logDir = '/tmp/rw-jobs';
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, 'job-' + Date.now() + '.log');
      const fd = fs.openSync(logFile, 'a');
      const child = spawn(cmd, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      jobs.set(String(child.pid), { pid: child.pid, cmd: a.cmd, log: logFile, started: Date.now(), status: 'running' });
      child.on('exit', (code) => { const j = jobs.get(String(child.pid)); if (j) { j.status = 'exited'; j.code = code; } });
      return { jobId: String(child.pid), cmd: a.cmd, log: logFile };
    } },
  { name: 'kill_process', description: '终止进程（后台任务用 jobId/pid）', permission: 'full',
    params: { pid: { type: 'number', required: true } },
    run: async (a) => { try { process.kill(a.pid, 'SIGTERM'); return { killed: true }; } catch (e) { throw new Error('终止失败: ' + e.message); } } },
  { name: 'job_list', description: '列出全部后台任务（jobId/命令/状态/日志路径）', permission: 'full',
    params: {},
    run: async () => ({ jobs: [...jobs.entries()].map(([id, j]) => ({ jobId: id, cmd: j.cmd, status: j.status, code: j.code ?? null, started: new Date(j.started).toISOString(), log: j.log })) }) },
  { name: 'job_output', description: '查看后台任务输出日志（最近 8000 字符）', permission: 'full',
    params: { jobId: { type: 'string', required: true } },
    run: async (a) => {
      const j = jobs.get(String(a.jobId));
      if (!j) throw new Error('job 不存在: ' + a.jobId + '（可用 job_list 查看）');
      let out = ''; try { out = fs.readFileSync(j.log, 'utf8'); } catch { /* ignore */ }
      return { jobId: a.jobId, status: j.status, output: out.slice(-8000) };
    } },

  // ---------- B14 联网搜索（SearXNG） ----------
  { name: 'web_search', description: '联网搜索（SearXNG 自托管）', permission: 'read',
    params: { query: { type: 'string', required: true }, limit: { type: 'number' } },
    run: async (a) => {
      const base = process.env.SEARXNG_URL || 'http://127.0.0.1:8888';
      const url = `${base}/search?q=${encodeURIComponent(a.query)}&format=json`;
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('搜索服务不可用 ' + r.status);
      const j = await r.json();
      return { results: (j.results || []).slice(0, a.limit || 8).map((x) => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 200) })) };
    } },

  // ---------- B15 读网页 ----------
  { name: 'fetch_url', description: '读取网页正文（简易提取）', permission: 'read',
    params: { url: { type: 'string', required: true } },
    run: async (a) => {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await r.text();
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return { title: (html.match(/<title>(.*?)<\/title>/i) || [])[1] || '', text: text.slice(0, 8000) };
    } },

  // ---------- B16-B19 文档解析 ----------
  { name: 'extract_pdf', description: '提取 PDF 文本', permission: 'read', params: { path: { type: 'string', required: true } }, run: async (a) => ({ text: (await extractPdf(a.path)).slice(0, 20000) }) },
  { name: 'extract_docx', description: '提取 Word 文本', permission: 'read', params: { path: { type: 'string', required: true } }, run: async (a) => ({ text: (await extractDocx(a.path)).slice(0, 20000) }) },
  { name: 'extract_xlsx', description: '提取 Excel 内容', permission: 'read', params: { path: { type: 'string', required: true } }, run: async (a) => ({ text: (await extractXlsx(a.path)).slice(0, 20000) }) },
  { name: 'extract_pptx', description: '提取 PPT 文本', permission: 'read', params: { path: { type: 'string', required: true } }, run: async (a) => ({ text: (await extractPptx(a.path)).slice(0, 20000) }) },

  // ---------- B21/B22 数据库（全局权限） ----------
  { name: 'db_query', description: '数据库只读查询（SELECT）', permission: 'global',
    params: { sql: { type: 'string', required: true } },
    run: async (a) => {
      if (!/^\s*select\b/i.test(a.sql)) throw new Error('仅允许 SELECT');
      const rows = await db.query(a.sql);
      return { rowCount: rows.length, rows: rows.slice(0, 50) };
    } },
  { name: 'db_write', description: '数据库写入（高危，留痕）', permission: 'global',
    params: { sql: { type: 'string', required: true } },
    run: async (a) => { const r = await db.run(a.sql); return { affected: r.affectedRows, insertId: r.insertId }; } },

  // ---------- B23-B26 Git ----------
  { name: 'git_status', description: '查看 git 状态', permission: 'read', params: { dir: { type: 'string', required: true } },
    run: async (a) => { const r = await runCmd('git', ['-C', a.dir, 'status', '--short']); return { status: r.out, ok: r.ok }; } },
  { name: 'git_commit', description: 'git 提交', permission: 'write', params: { dir: { type: 'string', required: true }, message: { type: 'string', required: true } },
    run: async (a) => { await runCmd('git', ['-C', a.dir, 'add', '-A']); const r = await runCmd('git', ['-C', a.dir, 'commit', '-m', a.message]); return { ok: r.ok, out: r.out }; } },
  { name: 'git_branch', description: 'git 分支操作（list|create|checkout）', permission: 'write', params: { dir: { type: 'string', required: true }, action: { type: 'string', enum: ['list', 'create', 'checkout'] }, branch: { type: 'string' } },
    run: async (a) => {
      if (a.action === 'create') { const r = await runCmd('git', ['-C', a.dir, 'branch', a.branch]); return { ok: r.ok }; }
      if (a.action === 'checkout') { const r = await runCmd('git', ['-C', a.dir, 'checkout', a.branch]); return { ok: r.ok }; }
      const r = await runCmd('git', ['-C', a.dir, 'branch', '-a']); return { branches: r.out };
    } },
  { name: 'git_pull_push', description: 'git 拉取/推送', permission: 'write', params: { dir: { type: 'string', required: true }, action: { type: 'string' } },
    run: async (a) => { const r = await runCmd('git', ['-C', a.dir, a.action === 'push' ? 'push' : 'pull']); return { ok: r.ok, out: r.out }; } },

  // ---------- B27/B28 代码检查 ----------
  { name: 'syntax_check', description: 'JS 语法检查（node --check）', permission: 'read', params: { path: { type: 'string', required: true } },
    run: async (a) => { const r = await runCmd('node', ['--check', a.path]); return { ok: r.ok, err: r.err }; } },
  { name: 'run_test', description: '运行测试（write 级仅工作区内）', permission: 'write', params: { dir: { type: 'string', required: true } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.dir, ctx.root)) throw new Error('目录超出工作区'); const r = await runCmd('npm', ['test'], { cwd: a.dir }); return { ok: r.ok, out: r.out, err: r.err }; } },

  // ---------- F9 动态任务清单（多步任务规划与进度展示） ----------
  { name: 'plan_tasks', description: '为当前多步任务创建任务清单（复杂任务先规划步骤，让用户看到进度；每完成一步用 plan_done 标记，全部完成后再总结）', permission: 'read',
    params: { tasks: { type: 'string', required: true, desc: '任务步骤列表，用换行或分号分隔' } },
    run: async (a, ctx) => {
      const steps = String(a.tasks || '').split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean).map((text) => ({ text: text.slice(0, 120), done: false }));
      if (!steps.length) throw new Error('任务步骤为空');
      const plan = planOf(ctx);
      plan.steps = steps; plan.done = 0;
      return { plan: plan.steps.map((s) => s.text), total: steps.length };
    } },
  { name: 'plan_done', description: '标记任务清单中第 N 步已完成（从 1 开始）', permission: 'read',
    params: { index: { type: 'number', required: true, desc: '步骤序号（从 1 开始）' } },
    run: async (a, ctx) => {
      const plan = planOf(ctx);
      const i = (Number(a.index) || 1) - 1;
      if (!plan.steps[i]) throw new Error('步骤不存在: ' + a.index);
      if (!plan.steps[i].done) { plan.steps[i].done = true; plan.done++; }
      return { plan: plan.steps.map((s) => ({ text: s.text, done: s.done })) };
    } },

  // ---------- F10 目标系统（跨轮持续推进的长期目标） ----------
  { name: 'set_goal', description: '设定本会话的长期目标（用户要求持续推进一件大事时用；目标会跨轮持续注入提醒，直到完成/放弃）', permission: 'read',
    params: { objective: { type: 'string', required: true, desc: '目标描述' } },
    run: async (a, ctx) => {
      const cid = ctx.conversationId;
      if (!cid) throw new Error('无会话上下文');
      const obj = String(a.objective).trim().slice(0, 2000);
      const existing = (await db.query('SELECT id FROM goals WHERE conversation_id=? AND status="active" ORDER BY id DESC LIMIT 1', [cid]))[0];
      if (existing) await db.query('UPDATE goals SET objective=?, progress=NULL, status="active", updated_at=NOW() WHERE id=?', [obj, existing.id]);
      else await db.query('INSERT INTO goals (conversation_id, account_id, objective, status) VALUES (?,?,?,"active")', [cid, ctx.accountId || null, obj]);
      return { goal: obj, status: 'active' };
    } },
  { name: 'update_goal', description: '更新当前活动目标的进度或状态（progress=进展说明；status=done 完成 / abandoned 放弃）', permission: 'read',
    params: { progress: { type: 'string' }, status: { type: 'string', desc: 'active|done|abandoned' } },
    run: async (a, ctx) => {
      const cid = ctx.conversationId;
      if (!cid) throw new Error('无会话上下文');
      const g = (await db.query('SELECT id FROM goals WHERE conversation_id=? AND status="active" ORDER BY id DESC LIMIT 1', [cid]))[0];
      if (!g) throw new Error('当前无活动目标（先用 set_goal 设定）');
      await db.query('UPDATE goals SET progress=?, status=?, updated_at=NOW() WHERE id=?', [a.progress !== undefined ? String(a.progress).slice(0, 2000) : null, a.status || 'active', g.id]);
      const row = (await db.query('SELECT objective, progress, status FROM goals WHERE id=?', [g.id]))[0];
      return row;
    } },
  { name: 'get_goal', description: '查看当前会话的活动目标与进度', permission: 'read',
    params: {},
    run: async (a, ctx) => {
      const cid = ctx.conversationId;
      if (!cid) return { goal: null };
      const g = (await db.query('SELECT objective, progress, status FROM goals WHERE conversation_id=? AND status="active" ORDER BY id DESC LIMIT 1', [cid]))[0];
      return g || { goal: null };
    } },

  // ---------- 图片理解（视觉模型分析图片） ----------
  { name: 'view_image', description: '用视觉模型理解图片内容（支持本地图片路径或 http(s) URL），返回图片描述', permission: 'read',
    params: { path: { type: 'string', required: true, desc: '本地图片路径或 URL' } },
    run: async (a) => {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) throw new Error('未配置 DeepSeek key');
      let dataUrl;
      if (/^https?:\/\//.test(a.path)) {
        dataUrl = a.path;
      } else {
        const buf = fs.readFileSync(a.path);
        const ext = path.extname(a.path).toLowerCase().replace('.', '') || 'png';
        const mime = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp' }[ext] || 'png';
        dataUrl = `data:image/${mime};base64,${buf.toString('base64')}`;
      }
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: 'deepseek-v4-flash-vision-exp',
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: '请详细描述这张图片的内容（中文）' }] }],
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('视觉调用失败: ' + (j.error?.message || res.status));
      return { description: (j.choices?.[0]?.message?.content || '').slice(0, 3000) };
    } },

  // ---------- 子代理（F16/F17：主代理派生独立代理执行任务，复用完整 Agent 循环） ----------
  { name: 'subagent', description: '启动一个子代理独立执行任务并返回结果。mode=sync(默认)：等待子代理完成后返回其结论；mode=async：立即返回 sub_id（适合并行：一条消息里发多个 async 子代理调用会并行启动，随后用 subagent_output 逐个取结果再汇总）。子代理内部工具执行会实时显示（"子:"前缀）并留痕。', permission: 'read',
    params: {
      prompt: { type: 'string', required: true, desc: '给子代理的完整任务指令（自包含，含目标与验收标准）' },
      name: { type: 'string', desc: '子代理名称（用于展示，默认 子代理）' },
      model: { type: 'string', desc: '子代理模型，默认与主代理相同' },
      mode: { type: 'string', enum: ['sync', 'async'], desc: 'sync=等结果(默认) | async=立即返回id' },
    },
    run: async (a, ctx) => {
      if (ctx.noSubagent) throw new Error('子代理嵌套已达 3 层上限，请自己直接完成任务');
      const { spawnSubagent, waitSub, subs } = await import('../subagent.js');
      const running = [...subs.values()].filter((s) => s.status === 'running').length;
      if (running >= 8) throw new Error('当前并发子代理已达上限(8)，稍后再试或减少并行数');
      const prompt = String(a.prompt || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      const { id } = await spawnSubagent({
        prompt, name: String(a.name || '').slice(0, 30) || undefined,
        provider: ctx.__provider || ctx.provider || 'deepseek',
        model: a.model || ctx.__model || ctx.model || 'deepseek-v4-flash',
        permission: ctx.permission, parentCtx: ctx, keys: ctx.__keys || {}, temperature: ctx.__temperature,
      });
      if (a.mode === 'async') return { sub_id: id, status: 'running', tip: '用 subagent_output 查询结果（id=' + id + '）' };
      const rec = await waitSub(id);
      if (rec.status === 'error') throw new Error('子代理失败: ' + rec.error);
      return {
        sub_id: id, status: rec.status, durationMs: rec.durationMs,
        toolSteps: (rec.toolLog || []).length,
        lastSteps: (rec.toolLog || []).slice(-8),
        result: String(rec.result || '').slice(0, 6000),
      };
    } },
  { name: 'subagent_output', description: '查询异步子代理(subagent 的 mode=async)的结果：running=仍在执行，done=取回结果。未完成就继续查询/等一会。', permission: 'read',
    params: { id: { type: 'string', required: true, desc: 'sub_id（subagent async 返回）' } },
    run: async (a) => {
      const { subs: subMap } = await import('../subagent.js');
      const rec = subMap.get(String(a.id));
      if (!rec) throw new Error('子代理不存在: ' + a.id);
      if (rec.status === 'running') return { sub_id: rec.id, status: 'running', tip: '仍在执行，稍后重试' };
      if (rec.status === 'error') return { sub_id: rec.id, status: 'error', error: rec.error };
      return { sub_id: rec.id, status: 'done', durationMs: rec.durationMs, toolSteps: (rec.toolLog || []).length, lastSteps: (rec.toolLog || []).slice(-8), result: String(rec.result || '').slice(0, 6000) };
    } },
  { name: 'subagent_report', description: '调取已完成子代理的完整报告（任务、状态、全部工具步骤明细、结论），用于复盘与审计', permission: 'read',
    params: { id: { type: 'string', required: true, desc: 'sub_id' } },
    run: async (a) => {
      const { subs: subMap } = await import('../subagent.js');
      const rec = subMap.get(String(a.id));
      if (!rec) throw new Error('子代理不存在: ' + a.id);
      if (rec.status === 'running') return { sub_id: rec.id, status: 'running', tip: '尚未结束，结束后再取报告' };
      const steps = (rec.toolLog || []).map((t) => ({ name: t.name, status: t.status, durationMs: t.durationMs, args: t.args, result: String(t.result || '').slice(0, 400) }));
      return {
        sub_id: rec.id, name: rec.name, kind: rec.kind || 'spawn', status: rec.status, error: rec.error || null,
        task: rec.prompt, durationMs: rec.durationMs, toolSteps: steps.length, steps, result: String(rec.result || '').slice(0, 8000),
      };
    } },
  { name: 'subagent_join', description: '等待一个或多个异步子代理全部完成并汇总返回（并行编排收口：一次等完所有 sub_id）', permission: 'read',
    params: { ids: { type: 'string', required: true, desc: '逗号分隔的 sub_id 列表' } },
    run: async (a) => {
      const { subs: subMap, waitSub } = await import('../subagent.js');
      const ids = String(a.ids).split(',').map((s) => s.trim()).filter(Boolean);
      const out = [];
      for (const id of ids) {
        if (!subMap.has(id)) { out.push({ sub_id: id, error: '不存在' }); continue; }
        const rec = await waitSub(id);
        out.push({ sub_id: id, status: rec.status, durationMs: rec.durationMs, toolSteps: (rec.toolLog || []).length, result: rec.status === 'done' ? String(rec.result || '').slice(0, 5000) : rec.error });
      }
      return { joined: out };
    } },
  { name: 'subagent_list', description: '列出当前平台内全部子代理及其状态（id/名称/类型 spawn|fork/状态/深度/耗时），用于编排与排查', permission: 'read',
    params: {},
    run: async () => {
      const { subs: subMap } = await import('../subagent.js');
      const arr = [...subMap.values()].slice(-60).map((s) => ({
        id: s.id, name: s.name, kind: s.kind || 'spawn', status: s.status, depth: s.depth || 0,
        createdAt: s.createdAt, durationMs: s.durationMs || null,
        toolSteps: (s.toolLog || []).length,
      }));
      return { total: subMap.size, subs: arr };
    } },
  { name: 'subagent_fork', description: '派生一个"延续本会话上下文"的子代理（fork）：携带本会话最近的对话历史作为种子，适合让子代理接着当前任务的分析继续深挖/分头论证。mode=async 返回 sub_id（可 subagent_join/Output 收口）', permission: 'read',
    params: {
      prompt: { type: 'string', required: true, desc: '给子代理的独立任务（它会同时看到本会话最近对话）' },
      name: { type: 'string' },
      mode: { type: 'string', desc: 'sync(默认)=等结果 | async=立即返回id' },
    },
    run: async (a, ctx) => {
      if (ctx.noSubagent) throw new Error('子代理嵌套已达 3 层上限');
      const { spawnSubagent, waitSub } = await import('../subagent.js');
      const prompt = String(a.prompt || '').trim();
      if (!prompt) throw new Error('prompt 必填');
      // 种子：本会话最近历史（排除"触发本次 fork 的最新用户指令"，避免子代理照指令递归套娃），各截断 500 字
      let seed = [];
      try {
        const rows = await db.query('SELECT role, content FROM messages WHERE conversation_id=? AND role IN ("user","assistant") ORDER BY id DESC LIMIT 12', [ctx.conversationId]);
        let list = rows.reverse();
        // 丢弃最新一条用户消息（即当前触发指令本身）
        if (list.length && list[list.length - 1].role === 'user') list = list.slice(0, -1);
        seed = list.slice(-10).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) }));
      } catch { /* 无种子也可 fork */ }
      const { id } = await spawnSubagent({
        prompt, name: String(a.name || '').slice(0, 30) || undefined,
        provider: ctx.__provider || 'deepseek', model: a.model || ctx.__model || 'deepseek-v4-flash',
        permission: ctx.permission, parentCtx: ctx, keys: ctx.__keys || {}, temperature: ctx.__temperature,
        seedMessages: seed,
      });
      if (a.mode === 'async') return { sub_id: id, status: 'running', tip: '用 subagent_join/subagent_output 收口' };
      const rec = await waitSub(id);
      if (rec.status === 'error') throw new Error('子代理失败: ' + rec.error);
      return { sub_id: id, status: rec.status, durationMs: rec.durationMs, toolSteps: (rec.toolLog || []).length, result: String(rec.result || '').slice(0, 6000) };
    } },
  { name: 'subagent_fanout', description: '批量编排：对多个条目并行各派一个子代理执行同一任务模板，全部完成后统一汇总（模板中用 {{item}} 占位符代表每条目）。适用于批量处理：如对 10 个文件逐一做同类检查/转换/摘要', permission: 'read',
    params: {
      template: { type: 'string', required: true, desc: '子代理任务模板，其中 {{item}} 会被替换为具体条目' },
      items: { type: 'string', required: true, desc: '条目数组的 JSON，如 ["a.txt","b.txt"]（或逗号分隔字符串）' },
      name: { type: 'string', desc: '子代理名前缀，默认 批量' },
    },
    run: async (a, ctx) => {
      if (ctx.noSubagent) throw new Error('子代理嵌套已达 3 层上限');
      let items = [];
      try { items = Array.isArray(a.items) ? a.items : JSON.parse(a.items); } catch { items = String(a.items || '').split(',').map((s) => s.trim()); }
      items = items.filter(Boolean).slice(0, 12);
      if (!items.length) throw new Error('items 为空');
      const { spawnSubagent, waitSub, subs } = await import('../subagent.js');
      const results = [];
      const batchOf = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
      for (const batch of batchOf(items, 6)) {
        const spawned = [];
        for (const item of batch) {
          const running = [...subs.values()].filter((s) => s.status === 'running').length;
          if (running >= 8) throw new Error('并发子代理已达上限(8)');
          const prompt = String(a.template).split('{{item}}').join(item);
          spawned.push(await spawnSubagent({
            prompt, name: (a.name || '批量') + '-' + (results.length + spawned.length + 1),
            provider: ctx.__provider || 'deepseek', model: ctx.__model || 'deepseek-v4-flash',
            permission: ctx.permission, parentCtx: ctx, keys: ctx.__keys || {}, temperature: ctx.__temperature,
          }));
        }
        for (const sp of spawned) {
          const rec = await waitSub(sp.id);
          results.push({ status: rec.status, error: rec.error || null, result: rec.status === 'done' ? String(rec.result || '').slice(0, 2500) : null });
        }
      }
      // 条目与结果对齐
      const aligned = items.map((item, idx) => ({ item, ...(results[idx] || { status: 'missing' }) }));
      const doneCount = aligned.filter((r) => r.status === 'done').length;
      return { total: items.length, done: doneCount, results: aligned };
    } },

  // ---------- 知识库（F19：global 全会话可见 / conv 仅本会话；正文大段用 kb_search 取） ----------
  { name: 'kb_add', description: '写入一条知识/长期记忆（scope=global 对所有会话生效；scope=conv 仅当前会话）。title 简短概括，body 为内容。用户交代"记住/以后都按…"时用', permission: 'read',
    params: { title: { type: 'string', required: true }, body: { type: 'string' }, scope: { type: 'string', enum: ['global', 'conv'], desc: 'global=全会话 | conv=仅当前会话(默认)' } },
    run: async (a, ctx) => {
      if (!ctx.accountId) throw new Error('缺少账号上下文');
      const scope = a.scope === 'global' ? 'global' : 'conv';
      const title = String(a.title || '').trim().slice(0, 200);
      if (!title) throw new Error('title 必填');
      const r = await db.query('INSERT INTO knowledge (account_id, scope, conversation_id, title, body) VALUES (?,?,?,?,?)',
        [ctx.accountId, scope, scope === 'conv' ? (ctx.conversationId || null) : null, title, String(a.body || '').slice(0, 8000)]);
      return { saved: true, id: r.insertId, scope, title };
    } },
  { name: 'kb_search', description: '搜索知识库/长期记忆（标题+正文关键词，当前会话可见范围=自己scope=conv + 全部global）。记得相关约定、历史决策、用户偏好时先搜这里', permission: 'read',
    params: { q: { type: 'string', required: true, desc: '关键词' } },
    run: async (a, ctx) => {
      if (!ctx.accountId) return { items: [] };
      const like = '%' + String(a.q).split(/\s+/).filter(Boolean).join('%') + '%';
      const rows = await db.query('SELECT id, scope, title, body, created_at FROM knowledge WHERE account_id=? AND (scope="global" OR (scope="conv" AND conversation_id=?)) AND (title LIKE ? OR body LIKE ?) ORDER BY id DESC LIMIT 8',
        [ctx.accountId, ctx.conversationId || -1, like, like]);
      return { items: rows.map((r) => ({ id: r.id, scope: r.scope, title: r.title, body: String(r.body || '').slice(0, 1200), createdAt: r.created_at })) };
    } },
  { name: 'kb_del', description: '删除一条知识/记忆（按 kb_search 得到的 id）', permission: 'write',
    params: { id: { type: 'number', required: true } },
    run: async (a, ctx) => {
      const r = await db.query('DELETE FROM knowledge WHERE id=? AND account_id=?', [a.id, ctx.accountId]);
      return { deleted: r.affectedRows > 0 };
    } },

  // ---------- 任务契约（外部驱动器：讨论达成共识后立项 → 无人值守执行） ----------
  { name: 'create_contract', description: '创建任务契约并立项（讨论达成共识后使用；驱动器会在 run_at 到点后无人值守执行，直到验收通过并等待用户复测）。goal=目标（完整）；acceptance=验收清单 JSON 字符串数组（驱动器逐条跑 shell 命令核验，如 ["grep -q X /path"]）；boundaries=边界约束；runAt=可空 ISO 时间（空=立即排队）。', permission: 'write',
    params: {
      goal: { type: 'string', required: true, desc: '任务目标（完整、含交付物）' },
      title: { type: 'string', desc: '简短标题' },
      acceptance: { type: 'string', desc: '验收 shell 命令 JSON 数组字符串，如 ["grep -q OK /srv/rw-workspace/a.txt"]；空=仅自检' },
      boundaries: { type: 'string', desc: '边界/约束（不许动什么、注意什么）' },
      runAt: { type: 'string', desc: 'ISO 时间；空=立即执行' },
    },
    run: async (a, ctx) => {
      const goal = String(a.goal || '').trim().slice(0, 3000);
      if (!goal) throw new Error('goal 必填');
      let acc = [];
      try { acc = Array.isArray(a.acceptance) ? a.acceptance : JSON.parse(a.acceptance || '[]'); } catch { acc = []; }
      if (!Array.isArray(acc)) acc = [];
      let runAt = null;
      if (a.runAt) { const d = new Date(a.runAt); if (!Number.isNaN(d.getTime())) runAt = d; }
      const r = await db.query('INSERT INTO task_contracts (account_id, title, goal, acceptance, boundaries, run_at, status) VALUES (?,?,?,?,?,?,"queued")',
        [ctx.accountId ?? null, String(a.title || goal.slice(0, 40)).slice(0, 200), goal, JSON.stringify(acc.slice(0, 10)), String(a.boundaries || '').slice(0, 1000), runAt]);
      return { contract_id: r.insertId, status: 'queued', note: (runAt ? ('将于 ' + runAt.toISOString() + ' 执行') : '已排队，驱动器将尽快无人值守执行') + '；完成后会生成你的复测任务等待确认。' };
    } },
  { name: 'finish_task', description: '任务完成自检提交：把任务标记为"已完成候选"。summary=完成总结；selfCheck=你对照验收标准自检的说明。调用后驱动器会自动跑验收钩子，通过后任务进入"待用户复测"。', permission: 'read',
    params: {
      summary: { type: 'string', required: true, desc: '完成总结（做了什么、结果如何）' },
      selfCheck: { type: 'string', desc: '对照验收标准的自检说明' },
    },
    run: async (a) => ({
      accepted: true,
      note: '已登记完成自检。驱动器将运行验收钩子核验；全部通过后任务进入【待复测】等待你确认，未通过会被打回。',
      summary: String(a.summary || '').slice(0, 2000),
    }) },

  // ---------- 计划模式（plan_mode / exit_plan_mode，会话级只读规划） ----------
  { name: 'plan_mode', description: '进入会话级计划模式（只读）：此后所有写/改/执行类工具会被平台拒绝，直到调用 exit_plan_mode 提交计划成功。用于用户要求"先规划、只调研、别动手"的场景', permission: 'read',
    params: {},
    run: async (a, ctx) => {
      if (!ctx.conversationId) throw new Error('无会话上下文');
      await db.query('UPDATE conversations SET mode="plan" WHERE id=?', [ctx.conversationId]);
      return { plan_mode: true, tip: '已进入只读规划模式；探索完成后调用 exit_plan_mode 提交计划' };
    } },
  { name: 'exit_plan_mode', description: '提交计划并退出计划模式（模式回到普通对话，改动类工具恢复可用）。plan=完整计划 Markdown（目标/步骤/涉及文件/风险/验证）；提交后请把计划原文作为你的最终回答完整展示给用户等待批准', permission: 'read',
    params: { plan: { type: 'string', required: true, desc: '完整实施计划（Markdown）' } },
    run: async (a, ctx) => {
      if (!ctx.conversationId) throw new Error('无会话上下文');
      await db.query('UPDATE conversations SET mode="chat" WHERE id=?', [ctx.conversationId]);
      const plan = String(a.plan || '').slice(0, 12000);
      return { exited: true, tip: '已退出计划模式。请把上面的计划作为最终回答展示给用户；用户批准（说"开始/按计划执行"）后即可实施。', planLength: plan.length };
    } },

  // ---------- ralph 循环（多轮全新 Agent 共享工作区记忆推进同一目标，至完成/阻塞/达轮次上限） ----------
  { name: 'ralph', description: '对同一目标运行多轮"全新视角"Agent 循环（每轮子代理不带对话历史、只共享工作区记忆文件），直到某轮报告完成、阻塞或达到轮次上限。适合需要反复试错/多角度逼近的难题。返回各轮结论汇总。', permission: 'read',
    params: {
      objective: { type: 'string', required: true, desc: '不可变的目标' },
      rounds: { type: 'number', desc: '轮次上限（默认 5，最大 10）' },
    },
    run: async (a, ctx) => {
      if (ctx.noSubagent) throw new Error('子代理嵌套已达上限');
      const { spawnSubagent, waitSub } = await import('../subagent.js');
      const objective = String(a.objective || '').trim().slice(0, 1000);
      if (!objective) throw new Error('objective 必填');
      const maxRounds = Math.min(10, Math.max(1, Math.floor(Number(a.rounds) || 5)));
      const memRoot = ctx.root && ctx.root !== '/' ? ctx.root : '/srv/rw-workspace';
      fs.mkdirSync(memRoot, { recursive: true });
      const mem = path.join(memRoot, '.ralph-' + Date.now().toString(36) + '.md');
      fs.writeFileSync(mem, '### 任务目标\n' + objective + '\n');
      const roundLogs = [];
      let status = 'rounds-exhausted';
      let lastRoundDone = false;
      for (let i = 1; i <= maxRounds; i++) {
        let prior = '';
        try { prior = fs.readFileSync(mem, 'utf8').slice(-4000); } catch { /* ignore */ }
        const childPrompt = [
          '你是一次全新尝试（Ralph 循环第 ' + i + '/' + maxRounds + ' 轮），没有对话历史，但有一份共享工作记忆文件，请先读它：' + mem,
          '不可变目标：' + objective,
          '执行规则：以全新视角继续推进；执行完把 本轮进展/新发现/下一步 以追加方式写入 ' + mem + '（用 append_file 工具，UTF-8，不要覆盖历史）；',
          '若判定目标已达成，请在文件末尾追加一行 STATUS: DONE；若遇到无法逾越的阻塞则追加 STATUS: BLOCKED 并写明原因。',
          '【重要：快速模式】本工具是多轮探索，单轮请克制：工具调用总步数控制在 10 步以内、优先用已有信息与轻量查询给出增量结论，不要穷举检索或重复验证。',
          prior ? '【共享工作记忆当前内容（尾段）】\n' + prior : '',
          '最后用不超过 300 字汇报本轮结果。',
        ].join('\n');
        const { id } = await spawnSubagent({
          prompt: childPrompt, name: 'Ralph-第' + i + '轮',
          provider: ctx.__provider || 'deepseek', model: ctx.__model || 'deepseek-v4-flash',
          permission: ctx.permission, parentCtx: ctx, keys: ctx.__keys || {}, temperature: ctx.__temperature,
          noSubagentOverride: true, // ralph 子代禁止再套娃/改码，只做本轮分析与记忆写入
        });
        const rec = await waitSub(id);
        const rep = String(rec.result || rec.error || '').slice(0, 600);
        roundLogs.push({ round: i, status: rec.status, result: rep, durationMs: rec.durationMs });
        if (rec.status === 'error') { status = 'blocked'; break; }
        let memTail = '';
        try { memTail = fs.readFileSync(mem, 'utf8'); } catch { /* ignore */ }
        if (/STATUS:\s*DONE/i.test(memTail)) { status = 'done'; break; }
        if (/STATUS:\s*BLOCKED/i.test(memTail)) { status = 'blocked'; break; }
      }
      let memoryTail = '';
      try { memoryTail = fs.readFileSync(mem, 'utf8').slice(-2500); } catch { /* ignore */ }
      return { status, roundsRun: roundLogs.length, memoryFile: mem, perRound: roundLogs.map((r) => r.round + ':' + r.status), finalMemoryTail: memoryTail, note: '记忆文件保留在工作区，可 read_file 查看全量；如需继续可再次 ralph 同一目标。' };
    } },

  // ---------- 结构化问询（ask_user：需要用户做选择时发选项卡片，等用户点选后继续） ----------
  { name: 'ask_user', description: '向用户提出一个结构化问题并等待其点选答案（仅在真正需要用户决策时使用：如二选一/方案选择/需要用户拍板；不要用于可自行查证的事实）。question=问题；options=选项。用户点选后返回所选 value。', permission: 'read',
    params: {
      question: { type: 'string', required: true, desc: '要问用户的问题' },
      options: { type: 'string', required: true, desc: '选项：JSON 数组字符串，如 [{"label":"方案A","value":"a"},{"label":"方案B","value":"b"}]；value 会作为返回值' },
    },
    run: async (a, ctx) => {
      let options = [];
      try { options = Array.isArray(a.options) ? a.options : JSON.parse(a.options); } catch { options = []; }
      if (!Array.isArray(options) || !options.length) throw new Error('options 需要是选项数组');
      const normalized = options.slice(0, 8).map((o, i) => ({
        label: String(o.label || o.value || '选项' + (i + 1)).slice(0, 80),
        value: String(o.value ?? o.label ?? i).slice(0, 60),
      }));
      const q = String(a.question || '').slice(0, 500);
      // 无人值守（驱动器）模式：不阻塞等待，把问题排进契约的"待用户"队列
      if (ctx.__autonomous) {
        const payload = { kind: 'ask', question: q, options: normalized };
        if (ctx.__needInput) await ctx.__needInput(payload);
        throw new Error('【无人值守】需要用户决策，问题已排队（' + q.slice(0, 60) + '…）。请停止当前任务并输出阶段性总结。');
      }
      const ap = createAsk(q, normalized);
      if (ctx.__emit) ctx.__emit({ type: 'ask', id: ap.id, question: q, options: normalized });
      let verdict = null;
      while (!verdict) {
        const race = await Promise.race([
          ap.promise.then((v) => ({ done: true, v })),
          new Promise((r) => setTimeout(() => r({ done: false }), 800)),
        ]);
        if (race.done) { verdict = race.v; break; }
        if (ctx.__signal && ctx.__signal.aborted) { cancelAsk(ap.id); verdict = { option: null, reason: 'aborted' }; break; }
      }
      if (!verdict || verdict.option == null) {
        throw new Error(verdict && verdict.reason === 'aborted' ? '用户停止了操作' : '用户未在时限内选择（可稍后重新问）');
      }
      return { chosen: verdict.option, note: '用户已选择。请按该选择继续执行。' };
    } },

  // ---------- 运行护栏（set_limits）与平台自重启（reload_platform） ----------
  { name: 'set_limits', description: '调整平台 Agent 运行护栏（写入 settings，立即生效、无需重启）：minutes=单轮时间预算分钟（0=不限）；rounds=最大工具轮次（0=不限）；loop=循环检测的连续相同次数（0=关闭）；parallel=同一步内并行工具数（0=串行，默认10）。用户要求"取消10分钟护栏/取消轮次限制/放开限制/要跑长任务"时用它，并汇报调整后的值。', permission: 'write',
    params: {
      minutes: { type: 'number', desc: '时间预算(分钟)，0=不限' },
      rounds: { type: 'number', desc: '轮次上限，0=不限' },
      loop: { type: 'number', desc: '循环检测连续次数，0=关闭' },
      parallel: { type: 'number', desc: '并行工具数，0=串行' },
    },
    run: async (a) => {
      const ups = [];
      if (a.minutes !== undefined) ups.push(['time_budget_min', Math.max(0, Math.floor(Number(a.minutes) || 0))]);
      if (a.rounds !== undefined) ups.push(['round_cap', Math.max(0, Math.floor(Number(a.rounds) || 0))]);
      if (a.loop !== undefined) ups.push(['loop_guard', Math.max(0, Math.floor(Number(a.loop) || 0))]);
      if (a.parallel !== undefined) ups.push(['max_parallel_tools', Math.max(0, Math.floor(Number(a.parallel) || 0))]);
      if (!ups.length) throw new Error('至少提供 minutes/rounds/loop/parallel 之一');
      for (const [k, v] of ups) {
        await db.query('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()', [k, JSON.stringify(v)]);
      }
      await bumpPolicyRev(); // 政策版本自增（WS2：护栏变化须让运行中模型看到）
      return { applied: Object.fromEntries(ups), note: '已写入 settings 并自增政策版本；进行中任务每轮读取最新护栏（最快 5s 生效）。0=不限/串行。默认参考值：120分钟/2000轮/连续6次/并行10。' };
    } },
  { name: 'reload_platform', description: '让平台加载你刚修改的自身代码：先 syntax_check 确认无误再调用。平台会安排在【当前对话回复结束后】自动重启（约3-4秒），重启后代码改动生效。不要手动 systemctl restart（会中断你自己的执行）；仅改配置/数据时无需调用。', permission: 'full',
    params: { note: { type: 'string', desc: '改动说明（改了什么，便于审计回看）' } },
    run: async (a) => {
      const note = String(a.note || '').slice(0, 300);
      requestRestart(note || 'platform code change');
      return { scheduled: true, note, tip: '本回复发送完后平台将自动重启（约3-4秒），随后刷新页面即可。' };
    } },

  // ---------- 技能系统（F15：机制=挂载 SKILL.md；内容由用户/服务器自定，平台不预设） ----------
  { name: 'skills_list', description: '列出可用技能（skills/技能目录名/SKILL.md，含名称与简介），用户提到"技能/skill/按照某方法做"时先查这里', permission: 'read',
    params: {},
    run: async () => {
      if (!fs.existsSync(SKILLS_ROOT)) return { skills: [], root: SKILLS_ROOT };
      const out = [];
      for (const d of fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = path.join(SKILLS_ROOT, d.name, 'SKILL.md');
        if (!fs.existsSync(p)) continue;
        const { meta } = parseSkillFront(fs.readFileSync(p, 'utf8'));
        out.push({ name: d.name, description: meta.description || '(无简介)', version: meta.version || '1.0.0' });
      }
      return { skills: out, root: SKILLS_ROOT };
    } },
  { name: 'skill_load', description: '载入技能：该技能 SKILL.md 全文进入系统提示，本会话后续轮次持续生效（跨轮记忆）；重复载入即更新', permission: 'read',
    params: { name: { type: 'string', required: true, desc: '技能目录名（skills_list 查得）' } },
    run: async (a, ctx) => {
      const name = String(a.name).trim();
      if (!/^[\w-]{1,64}$/.test(name)) throw new Error('技能名非法（仅字母数字-_）');
      const p = path.join(SKILLS_ROOT, name, 'SKILL.md');
      if (!fs.existsSync(p)) throw new Error('技能不存在: ' + name + '（可先用 skill_save 创建）');
      const full = fs.readFileSync(p, 'utf8').slice(0, 16000);
      const { meta, body } = parseSkillFront(full);
      ctx.skills = ctx.skills || {};
      ctx.skills[name] = { name, description: meta.description || '', content: full };
      if (ctx.conversationId) {
        await db.query('INSERT INTO conv_skills (conversation_id, skill_name) VALUES (?,?) ON DUPLICATE KEY UPDATE skill_name=VALUES(skill_name)', [ctx.conversationId, name]);
      }
      return { loaded: name, description: meta.description || '', bodyLength: body.length, head: body.slice(0, 800) };
    } },
  { name: 'skill_save', description: '创建/更新技能：写入 skills/<名称>/SKILL.md（frontmatter: name/description/version，正文为执行指令），之后可用 skill_load 载入', permission: 'write',
    params: { name: { type: 'string', required: true }, description: { type: 'string', desc: '一句话说明何时用该技能' }, content: { type: 'string', required: true, desc: 'SKILL.md 正文指令' } },
    run: async (a, ctx) => {
      const name = String(a.name).trim();
      if (!/^[\w-]{1,64}$/.test(name)) throw new Error('技能名非法（仅字母数字-_）');
      if (ctx.limitPath && !inside(SKILLS_ROOT, ctx.root)) throw new Error('技能目录超出当前权限工作区');
      const fm = ['---', 'name: ' + name, 'description: ' + String(a.description || '').replace(/\n/g, ' '), 'version: 1.0.0', '---', ''].join('\n');
      const p = path.join(SKILLS_ROOT, name, 'SKILL.md');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, fm + String(a.content), 'utf8');
      return { saved: name, path: p };
    } },

  // ---------- 飞书文档（F7/F9/F10/F11，v2.0 渠道一期） ----------
  { name: 'feishu_doc_read', description: '读取飞书云文档/知识库文档内容（docx/wiki 链接）', permission: 'read', params: { url: { type: 'string', required: true, desc: '飞书文档链接或 ID' } },
    run: async (a) => feishuConfigured() ? await readFeishuDoc(a.url) : { error: '未配置飞书凭证' } },
  { name: 'feishu_sheet_read', description: '读取飞书电子表格内容', permission: 'read', params: { url: { type: 'string', required: true }, range: { type: 'string' } },
    run: async (a) => feishuConfigured() ? await readFeishuSheet(a.url, a.range) : { error: '未配置飞书凭证' } },
  { name: 'feishu_bitable_read', description: '读取飞书多维表格记录', permission: 'read', params: { appToken: { type: 'string', required: true }, tableId: { type: 'string', required: true } },
    run: async (a) => feishuConfigured() ? await readFeishuBitable(a.appToken, a.tableId) : { error: '未配置飞书凭证' } },

  // ---------- 会话归档（WS5e：conv_summarize → conv_summaries；结构化存档 v1，后续可接 LLM 语义摘要） ----------
  { name: 'conv_summarize', description: '归档本/指定会话：把会话要点写入 conv_summaries（统计+首主题+尾部近况），供跨周/长会话恢复时注入首轮提示。长会话收尾或用户要求"总结这个对话"时用', permission: 'read',
    params: { conversationId: { type: 'number', desc: '目标会话 id，缺省=当前会话' } },
    run: async (a, ctx) => {
      const cid = a.conversationId || ctx.conversationId;
      if (!cid) throw new Error('缺少会话 id');
      const ms = await db.query('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 200', [cid]);
      if (!ms.length) throw new Error('会话无消息');
      const total = await db.query('SELECT COUNT(*) c FROM messages WHERE conversation_id=?', [cid]);
      const first = ms[ms.length - 1]; // 最旧
      const recent = ms.slice(0, 3).reverse(); // 最近 3 条（时间序）
      const theme = String(first.content || '').replace(/\s+/g, ' ').slice(0, 120);
      const tail = recent.map((m) => (m.role === 'user' ? '我: ' : 'AI: ') + String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n');
      const summary = [
        '【会话归档 v1】消息总数 ' + total[0].c + '（本次取样后 200 条）',
        '主题(首条用户): ' + theme,
        '最近动态:\n' + tail,
        '（需要完整历史用 db_query 查 messages/tool_calls；语义级摘要为 P2）',
      ].join('\n');
      await db.query('INSERT INTO conv_summaries (conversation_id, summary, updated_at) VALUES (?,?,NOW()) ON DUPLICATE KEY UPDATE summary=VALUES(summary), updated_at=NOW()', [cid, String(summary).slice(0, 6000)]);
      return { archived: true, conversationId: cid, summaryHead: summary.slice(0, 200) };
    } },
];

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

// 权限检查：工具所需权限 <= 会话权限（global 不受限）
export function checkPerm(tool, sessionPerm) {
  if (tool.permission === 'global') return true;
  const order = { read: 1, write: 2, full: 3, guard: 3 }; // guard=full 级别操作能力，但受控工具须经审批门禁
  return order[tool.permission] <= order[sessionPerm || 'full'];
}

// 工具定义（给 LLM function calling 用；expose=all|standard|minimal 按 tier 过滤——只影响暴露不影响执行）
export function toolDefs(expose = 'all') {
  const allow = expose === 'minimal' ? ['core'] : expose === 'standard' ? ['core', 'pro'] : ['core', 'pro', 'expert'];
  const PKEYS = ['enum', 'items', 'min', 'max']; // 参数 schema 白名单透传（防任意键注入）
  return TOOLS.filter((t) => allow.includes(TOOL_META[t.name]?.tier || 'pro')).map((t) => {
    const meta = TOOL_META[t.name] || {};
    let description = t.description;
    if (meta.when) description += '\n何时用：' + meta.when;
    if (meta.not) description += '\n勿用：' + meta.not;
    if (meta.ex) description += '\n例：' + meta.ex;
    return {
      type: 'function',
      function: {
        name: t.name,
        description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => {
            const p = { type: v.type, description: v.desc };
            for (const x of PKEYS) if (v[x] !== undefined) p[x] = v[x];
            return [k, p];
          })),
          required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k),
        },
      },
    };
  });
}

// 执行工具并留痕
export async function execTool(name, args, ctx) {
  const tool = findTool(name);
  if (!tool) throw new Error('未知工具: ' + name);
  if (!checkPerm(tool, ctx.permission)) throw new Error(`工具 ${name} 需要 ${tool.permission} 权限（当前 ${ctx.permission}）`);
  const t0 = Date.now();
  let result;
  // full 权限不限制路径（limitPath=false）；read/write 级才检查工作区边界（guard=full 级能力+审批，不受限）
  const eff = { ...ctx, limitPath: ctx.permission === 'read' || ctx.permission === 'write' };
  try {
    let blocked = null;
    // 工作区边界：read/write 会话中，read 级工具带本地路径须落在工作区内（防越权读）；相对路径按工作区根解析
    if (eff.limitPath && tool.permission === 'read') {
      const key = ['path', 'file', 'dir', 'base', 'src'].find((k) => args[k] !== undefined);
      const cand = key ? args[key] : undefined;
      if (cand) {
        const abs = path.isAbsolute(String(cand)) ? String(cand) : path.join(eff.root, String(cand));
        if (!inside(abs, eff.root)) {
          blocked = '路径超出工作区（本会话权限只允许访问 ' + eff.root + '）';
        } else if (!path.isAbsolute(String(cand))) {
          args[key] = abs; // 相对路径按工作区根解释，避免落到进程 cwd
        }
      }
    }
    // WS1 preset 暴露面：非 all 会话调用未暴露层级的工具 → 指引性错误（不静默）；run_command 命令纪律软门禁
    if (!blocked && ctx.preset && ctx.preset !== 'all') {
      const allowT = ctx.preset === 'minimal' ? new Set(['core']) : ctx.preset === 'standard' ? new Set(['core', 'pro']) : null;
      const metaTier = TOOL_META[name]?.tier;
      if (allowT && metaTier && !allowT.has(metaTier)) {
        blocked = `工具 ${name}（${metaTier} 级）不在当前会话 preset=${ctx.preset} 的暴露范围。可 ask_user 请用户把 preset 切到 standard/all，或改用 core 级工具完成。`;
      }
      if (!blocked && name === 'run_command') {
        const first = String(args.command || '').trim().split(/\s+/)[0];
        if (/^(cat|ls|grep|sed|head|tail|find|cd|echo)$/.test(first || '')) {
          blocked = `run_command 软门禁：${first} 有专门工具（read_file/list_dir/grep_search/find_file 等），请改用专门工具（preset=all 会话不受此限）。`;
        }
      }
    }
    // 计划模式门禁：会话 mode=plan 时改动类工具一律只读拒绝
    if (!blocked && eff.mode === 'plan' && MUTATING_TOOLS.has(name)) {
      blocked = '计划模式（只读）：工具 ' + name + ' 已被禁用。规划完成后请调用 exit_plan_mode 提交计划；用户批准并切回普通模式后再执行。';
    }
    // F20 审批门禁：guard 会话 + 受控工具 → 先发 approval 事件等用户批准；无人值守则排队
    if (!blocked && eff.permission === 'guard' && GUARDED_TOOLS.has(name)) {
      if (eff.__autonomous) {
        const payload = { kind: 'approval', desc: '需要授权：' + name + ' ' + JSON.stringify(args).slice(0, 200) };
        if (eff.__needInput) await eff.__needInput(payload);
        blocked = '【无人值守】该操作需要你授权，已排队（' + name + '）。请停止当前任务并输出阶段性总结。';
      } else {
        const argsDesc = JSON.stringify(args).slice(0, 300);
        const ap = createApproval(`工具 ${name} 需要确认\n参数: ${argsDesc}`);
        if (eff.__emit) eff.__emit({ type: 'approval', id: ap.id, desc: ap.desc || `工具 ${name} 需要确认\n参数: ${argsDesc}` });
        let verdict = null;
        while (!verdict) {
          const race = await Promise.race([
            ap.promise.then((v) => ({ done: true, v })),
            new Promise((r) => setTimeout(() => r({ done: false }), 800)),
          ]);
          if (race.done) { verdict = race.v; break; }
          if (eff.__signal && eff.__signal.aborted) { cancelApproval(ap.id); verdict = { decision: 'aborted' }; break; }
        }
        if (!verdict || verdict.decision !== 'approve') {
          blocked = verdict && verdict.decision === 'aborted' ? '用户停止了操作' : ('用户未批准该操作' + (verdict && verdict.decision === 'timeout' ? '（审批等待超时）' : ''));
        }
      }
    }
    if (blocked) {
      result = { error: blocked };
    } else {
      result = await tool.run(args, eff);
    }
  } catch (e) {
    result = { error: e.message };
  }
  // 留痕（audit_log + tool_calls；用户"停止"中止的不留痕，避免孤儿 fail 行回填到后续消息）
  if (!eff.__signal || !eff.__signal.aborted) {
    try {
      await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [ctx.accountId, 'tool:' + name, JSON.stringify({ args, result, ms: Date.now() - t0 }).slice(0, 1000)]);
      await db.query('INSERT INTO tool_calls (conversation_id, message_id, tool_name, args, result_summary, duration_ms, status) VALUES (?,?,?,?,?,?,?)',
        [ctx.conversationId, ctx.messageId || null, name, JSON.stringify(args).slice(0, 2000), JSON.stringify(result).slice(0, 2000), Date.now() - t0, result.error ? 'fail' : 'done']);
    } catch { /* 留痕失败不影响 */ }
  }
  return result;
}
