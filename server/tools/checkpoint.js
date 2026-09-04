// server/tools/checkpoint.js - 文件写自动 checkpoint + undo（P1-2 安全网）
// 借鉴：Claude Code 文件时间线 / Aider 自动 commit（docs/Codex与主流CLI-机制借鉴清单-v1.md §2 P1-2）
// 机制：execTool 执行文件修改类工具（write/append/edit/delete_file）【前】，自动把将被改动/删除的
//       已存在文件快照到 工作区/.rw-checkpoints/<会话>/<ts>-<seq>-<工具>/；模型可用 undo_checkpoint 回滚
//       （恢复操作前一刻内容；新建文件则删除之）。undo 成功后消费该快照（撤销栈语义：再次 undo 回滚更早一次）；
//       个别文件恢复失败则保留快照可重试。undo 永不阻断主流程。
// 原则：快照永不阻断主流程（任何失败返回 null）；单次最多 20 文件、单文件 >5MB 不快照；
//       每会话保留最近 KEEP_DIRS 个快照，超出自动淘汰最旧。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CP_ROOT = path.join(process.env.RW_WORKSPACE || '/srv/rw-workspace', '.rw-checkpoints');
const SNAPSHOT_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'delete_file']);
const MAX_FILES = 20;
const MAX_BYTES = 5 * 1024 * 1024; // 单文件 >5MB 不快照（平台代码/文本远小于此）
const KEEP_DIRS = 60;

function safeId(v) { return String(v || 'anon').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); }
function hashAbs(abs) { return crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16); }
function convRoot(convId) { return path.join(CP_ROOT, safeId(convId)); }

// 各写工具要改动/删除的路径参数
function targetPaths(name, args = {}) {
  if (!args || typeof args !== 'object') return [];
  switch (name) {
    case 'write_file': case 'append_file': case 'edit_file': case 'delete_file':
      return args.path ? [String(args.path)] : [];
    default: return [];
  }
}

function listDirSorted(convId) {
  const root = convRoot(convId);
  const items = [];
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      try { items.push({ name: d.name, dir, mtime: fs.statSync(dir).mtimeMs }); } catch { /* skip */ }
    }
  } catch { /* 尚无快照 */ }
  return items.sort((a, b) => b.mtime - a.mtime);
}

// 写前自动快照：成功返回 {dir, files}；任何失败返回 null（安全网不当绊脚索）
export function snapshotBeforeWrite(name, args, ctx = {}) {
  try {
    if (!SNAPSHOT_TOOLS.has(name)) return null;
    const convId = safeId(ctx.conversationId || ctx.accountId || 'anon');
    const cands = targetPaths(name, args).slice(0, MAX_FILES);
    if (!cands.length) return null;
    const files = [];
    for (const p of cands) {
      let st = null;
      try { st = fs.statSync(p); } catch { /* 不存在 = 新建 */ }
      if (st && st.isFile() && st.size > MAX_BYTES) continue;
      files.push({ abs: path.resolve(p), existed: !!(st && st.isFile()) });
    }
    if (!files.length) return null;
    const seq = String(Date.now()) + '-' + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
    const dir = path.join(convRoot(convId), seq + '-' + name);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    for (const f of files) {
      if (f.existed) fs.copyFileSync(f.abs, path.join(dir, 'files', hashAbs(f.abs)));
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ts: Date.now(), tool: name, files }));
    // 每会话保留最近 KEEP_DIRS 个快照
    for (const it of listDirSorted(convId).slice(KEEP_DIRS)) fs.rmSync(it.dir, { recursive: true, force: true });
    return { dir: path.basename(dir), files: files.length };
  } catch { return null; }
}

// 列出某会话最近快照（undo_checkpoint {list:true} 用）；rank 1 = 最近一次
export function listCheckpoints(convId, limit = 10) {
  return listDirSorted(convId).slice(0, Math.max(1, Number(limit) || 10)).map((it, i) => {
    let info = { tool: '?', files: 0, ts: null };
    try {
      const m = JSON.parse(fs.readFileSync(path.join(it.dir, 'manifest.json'), 'utf8'));
      info = { tool: m.tool || '?', files: (m.files || []).length, ts: m.ts || null };
    } catch { /* manifest 缺失仍列目录 */ }
    return { rank: i + 1, name: it.name, ...info };
  });
}

// 回滚第 n 新的快照（n=1 最近一次）：existed=true → 恢复操作前内容；existed=false(新建) → 删除
export function undoCheckpoint(convId, n = 1) {
  const all = listDirSorted(convId);
  const hit = all[(Number(n) || 1) - 1];
  if (!hit) return { error: '没有可回滚的快照' + (all.length ? '（共 ' + all.length + ' 个，n 超出范围）' : '') };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(hit.dir, 'manifest.json'), 'utf8')); }
  catch { return { error: '快照 manifest 损坏：' + hit.name }; }
  const done = [];
  for (const f of manifest.files || []) {
    try {
      if (f.existed) {
        const src = path.join(hit.dir, 'files', hashAbs(f.abs));
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(f.abs), { recursive: true });
          fs.copyFileSync(src, f.abs);
          done.push({ abs: f.abs, action: 'restored' });
        } else done.push({ abs: f.abs, action: 'skipped(no snapshot file)' });
      } else {
        fs.rmSync(f.abs, { force: true });
        done.push({ abs: f.abs, action: 'removed(was newly created)' });
      }
    } catch (e) { done.push({ abs: f.abs, action: 'failed: ' + e.message }); }
  }
  const failed = done.filter((d) => d.action.startsWith('failed') || d.action.startsWith('skipped'));
  if (!failed.length) {
    try { fs.rmSync(hit.dir, { recursive: true, force: true }); } catch { /* 目录清理失败不影响 */ }
    return { undone: hit.name, tool: manifest.tool, files: done, consumed: true };
  }
  return { undone: hit.name, tool: manifest.tool, files: done, consumed: false, note: '部分文件未恢复，快照已保留可重试（再 undo 将重试本次并优先回滚其前的快照）' };
}
