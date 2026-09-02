// server/tools/index.js - RW Agent 工具注册表（v2.0 文档 B1-B29）
// 每个工具：name / description / permission(read|write|full|global) / params / run(args, ctx)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { extractPdf, extractDocx, extractXlsx, extractPptx } from './extract.js';
import { db } from '../db.js';
import { feishuConfigured, readFeishuDoc, readFeishuSheet, readFeishuBitable } from './feishu.js';

// 路径安全：write 级限定工作区（limitPath 时检查）
export const WORKSPACE = process.env.RW_WORKSPACE || '/srv/rw-workspace';

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
  { name: 'run_long_task', description: '后台运行长任务，返回 job id', permission: 'full',
    params: { cmd: { type: 'string', required: true } },
    run: async (a) => {
      const [cmd, ...args] = a.cmd.split(/\s+/);
      const { spawn } = await import('node:child_process');
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return { jobId: String(child.pid), started: true };
    } },
  { name: 'kill_process', description: '终止进程', permission: 'full',
    params: { pid: { type: 'number', required: true } },
    run: async (a) => { try { process.kill(a.pid, 'SIGTERM'); return { killed: true }; } catch (e) { throw new Error('终止失败: ' + e.message); } } },

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
  const order = { read: 1, write: 2, full: 3 };
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
    result = await tool.run(args, eff);
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
