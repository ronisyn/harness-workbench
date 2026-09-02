// server/tools/index.js - RW Agent 工具注册表（v2.0 文档 B1-B29）
// 每个工具：name / description / permission(read|write|full|global) / params / run(args, ctx)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { extractPdf, extractDocx, extractXlsx, extractPptx } from './extract.js';
import { db } from '../db.js';
import { feishuConfigured, readFeishuDoc, readFeishuSheet, readFeishuBitable } from './feishu.js';
import { createApproval } from '../approval.js';

// F20 受控工具：guard 权限会话中执行前必须经用户批准（默认 full 权限不受影响）
const GUARDED_TOOLS = new Set(['delete_file', 'db_write', 'git_push', 'run_command']);

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
    params: { src: { type: 'string', required: true }, dst: { type: 'string', required: true }, mode: { type: 'string' } },
    run: async (a, ctx) => { if (ctx.limitPath && !inside(a.dst, ctx.root)) throw new Error('目标超出工作区'); if (a.mode === 'move') fs.renameSync(a.src, a.dst); else fs.copyFileSync(a.src, a.dst); return { ok: true }; } },
  { name: 'delete_file', description: '删除文件（高危，留痕）', permission: 'full',
    params: { path: { type: 'string', required: true } },
    run: async (a) => { fs.rmSync(a.path, { recursive: true, force: true }); return { deleted: true }; } },
  { name: 'find_file', description: '按文件名/扩展名查找文件', permission: 'read',
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

  // ---------- B20 OCR ----------
  { name: 'ocr_image', description: '图片 OCR 文字识别（Tesseract.js，中英文）', permission: 'read',
    params: { path: { type: 'string', required: true, desc: '图片文件路径' } },
    run: async (a) => {
      try {
        const { createWorker } = await import('tesseract.js');
        const worker = await createWorker('chi_sim+eng');
        const { data } = await worker.recognize(a.path);
        await worker.terminate();
        return { text: (data.text || '').slice(0, 8000), confidence: Math.round((data.confidence || 0) * 10) / 10 };
      } catch (e) { throw new Error('OCR 失败: ' + e.message); }
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
  { name: 'git_branch', description: 'git 分支操作（list|create|checkout）', permission: 'write', params: { dir: { type: 'string', required: true }, action: { type: 'string' }, branch: { type: 'string' } },
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
      mode: { type: 'string', desc: 'sync=等结果(默认) | async=立即返回id' },
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
    params: { title: { type: 'string', required: true }, body: { type: 'string' }, scope: { type: 'string', desc: 'global|conv(默认)' } },
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

// 工具定义（给 LLM function calling 用）
export function toolDefs() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: 'object', properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v.type, description: v.desc }])), required: Object.entries(t.params).filter(([, v]) => v.required).map(([k]) => k) },
    },
  }));
}

// 执行工具并留痕
export async function execTool(name, args, ctx) {
  const tool = findTool(name);
  if (!tool) throw new Error('未知工具: ' + name);
  if (!checkPerm(tool, ctx.permission)) throw new Error(`工具 ${name} 需要 ${tool.permission} 权限（当前 ${ctx.permission}）`);
  const t0 = Date.now();
  let result;
  // full 权限不限制路径（limitPath=false）；write/read 级才检查工作区边界
  const eff = { ...ctx, limitPath: ctx.permission !== 'full' };
  try {
    // F20 审批门禁：guard 会话 + 受控工具 → 先发 approval 事件等用户批准（POST /api/approvals/:id 裁决）
    if (eff.permission === 'guard' && GUARDED_TOOLS.has(name)) {
      const argsDesc = JSON.stringify(args).slice(0, 300);
      const ap = createApproval(`工具 ${name} 需要确认\n参数: ${argsDesc}`);
      if (eff.__emit) eff.__emit({ type: 'approval', id: ap.id, desc: ap.desc || `工具 ${name} 需要确认\n参数: ${argsDesc}` });
      const verdict = await ap.promise;
      if (!verdict || verdict.decision !== 'approve') {
        result = { error: '用户未批准该操作' + (verdict && verdict.decision === 'timeout' ? '（审批等待超时）' : '') };
      } else {
        result = await tool.run(args, eff);
      }
    } else {
      result = await tool.run(args, eff);
    }
  } catch (e) {
    result = { error: e.message };
  }
  // 留痕（audit_log + tool_calls）
  try {
    await db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [ctx.accountId, 'tool:' + name, JSON.stringify({ args, result, ms: Date.now() - t0 }).slice(0, 1000)]);
    await db.query('INSERT INTO tool_calls (conversation_id, message_id, tool_name, args, result_summary, duration_ms, status) VALUES (?,?,?,?,?,?,?)',
      [ctx.conversationId, ctx.messageId || null, name, JSON.stringify(args).slice(0, 2000), JSON.stringify(result).slice(0, 2000), Date.now() - t0, result.error ? 'fail' : 'done']);
  } catch { /* 留痕失败不影响 */ }
  return result;
}
