// server/tools/repomap.js - P2-3 repo_map：代码库结构感知（借鉴 Aider tree-sitter repo map 的轻量版）
// 目的：给长代码库任务一张"地图"——目录树 + 每文件行数/imports/顶层符号摘要，让 Agent 一次看清结构，
//       少做盲目 list_dir/find/grep 探测。不引入完整 tree-sitter（工程重），用逐行轻量扫描，够用且快。
// 输出纪律：容量受控（MAX_FILES / 符号与 imports 条数 / 总字符截断），避免地图本身撑爆上下文。
import fs from 'node:fs';
import path from 'node:path';

// 忽略的目录（噪音/依赖/产物/元数据）
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache', '.parcel-cache',
  '.rw-checkpoints', '.runtime', '.venv', 'venv', '__pycache__', '.pytest_cache', '.idea', '.vscode',
  'target', '.gradle', '.terraform', 'Pods', '.svn', '.hg', 'logs', 'tmp', '.turbo', '.yarn',
]);
// 计入地图的源码/文本扩展名（其余视为资源文件，仅目录树计数不扫描符号）
const SRC_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.java',
  '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.php', '.swift', '.sh', '.sql', '.vue', '.svelte']);
const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env', '.css', '.scss', '.html', '.htm', '.xml', '.csv']);

const MAX_FILES = 400;        // 扫描文件上限（超出仅计数不再进明细，防大仓库爆炸）
const MAX_SYMBOLS = 80;       // 每文件符号条数上限
const MAX_IMPORTS = 30;       // 每文件 imports 条数上限
const MAX_TEXT = 30000;       // 输出文本总字符上限（地图不是全文）
const DEPTH_TREE = 5;         // 目录树最大深度（超出折叠为 "…"）

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function countLines(p) {
  try {
    const buf = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch { return -1; }
}

// 顶层符号行提取（按语言取主要声明形态；逐行轻量正则，非 AST，够用于地图）
const LANG_SYM = [
  { ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue'], re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)|^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)|^\s*export\s*\{|^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(?[^=]*=>/ },
  { ext: ['.py'], re: /^(?:(?:async\s+)?def\s+([A-Za-z0-9_]+)|class\s+([A-Za-z0-9_]+))\s*[:(]/ },
  { ext: ['.go'], re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)|^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/ },
  { ext: ['.rs'], re: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z0-9_]+)|^\s*(?:pub\s+)?(?:struct|enum|trait|mod)\s+([A-Za-z0-9_]+)|^\s*impl\b/ },
  { ext: ['.java', '.kt'], re: /^\s*(?:public|private|protected|internal)?\s*(?:abstract\s+|final\s+|static\s+)*(?:class|interface|enum)\s+([A-Za-z0-9_]+)|^\s*(?:public|private|protected)\s+[\w<>,.?\[\] ]+\s+([a-zA-Z][A-Za-z0-9_]*)\s*\(/ },
  { ext: ['.c', '.h', '.cc', '.cpp', '.hpp'], re: /^[A-Za-z_][\w*& ]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{|^\s*typedef\s+.*\b([A-Za-z_][A-Za-z0-9_]*)\s*;/ },
  { ext: ['.rb'], re: /^\s*(?:class|module)\s+([A-Za-z0-9_:]+)|^\s*def\s+([A-Za-z0-9_!?=]+)/ },
  { ext: ['.php'], re: /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z0-9_]+)|^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z0-9_]+)/ },
  { ext: ['.swift'], re: /^\s*(?:public|private|internal|fileprivate)?\s*(?:final\s+|class|struct|enum|protocol|extension)\s+([A-Za-z0-9_]+)|^\s*(?:public|private|internal)?\s*func\s+([A-Za-z0-9_]+)/ },
];

function extractSymbols(p, ext, n) {
  if (n > 4000) return []; // 超长文件只统计行数，不做符号扫描（省 IO）
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rule = LANG_SYM.find((r) => r.ext.includes(ext));
  if (!rule) return [];
  const out = [];
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS; i++) {
    const l = lines[i];
    if (!l.trim() || l.trimStart().startsWith('//') || l.trimStart().startsWith('#') || l.trimStart().startsWith('*')) continue;
    const m = l.match(rule.re);
    if (m) {
      const name = m.slice(1).find((x) => x);
      if (name) out.push(name + (l.includes('=>') || l.includes('= async') ? '' : '') + '@' + (i + 1));
    }
  }
  return out;
}

// imports 提取（JS/TS 的 import/require；Python/Go/Rust 的 import/use；轻量行匹配）
const IMP_RE = [
  { ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue'], re: /^\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|^\s*(?:const|let|var)\s+[\w$]+\s*=\s*require\(['"]([^'"]+)['"]\)/ },
  { ext: ['.py'], re: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/ },
  { ext: ['.go'], re: /^\s*import\s+([\w./-]+)|^\s*import\s*\(/ },
  { ext: ['.rs'], re: /^\s*use\s+([\w:{}*]+)\s*;/ },
  { ext: ['.java', '.kt'], re: /^\s*import\s+([\w.]+)\s*;/ },
  { ext: ['.php'], re: /^\s*(?:use\s+([\w\\]+)\s*;|require_once?\s*\(?['"]([^'"]+)['"]\)?)/ },
  { ext: ['.c', '.h', '.cc', '.cpp', '.hpp'], re: /^\s*#\s*include\s*[<"]([^>"]+)[>"]/ },
  { ext: ['.rb'], re: /^\s*(?:require|require_relative)\s+['"]([^'"]+)['"]/ },
];
function extractImports(p, ext, n) {
  if (n > 4000) return [];
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const rule = IMP_RE.find((r) => r.ext.includes(ext));
  if (!rule) return [];
  const out = [];
  for (const l of txt.split('\n')) {
    const m = l.match(rule.re);
    if (m) {
      const v = m.slice(1).find((x) => x);
      if (v && !out.includes(v)) { out.push(v); if (out.length >= MAX_IMPORTS) break; }
    }
  }
  return out;
}

// 目录树（文本）：目录后跟 [n files]；源文件标注行数
function treeText(root, dirs, filesByDir, maxFiles) {
  const lines = [];
  const rel = (p) => path.relative(root, p) || '.';
  const pushTree = (dir, depth, prefix) => {
    if (depth > DEPTH_TREE) { lines.push(prefix + '  …'); return; }
    const sub = dirs.filter((d) => path.dirname(d) === dir).sort();
    const fsHere = filesByDir.get(dir) || [];
    const shown = fsHere.slice(0, Math.max(0, maxFiles - lines.length * 2)).slice(0, 40);
    for (const d of sub) {
      const dFiles = filesByDir.get(d) || [];
      lines.push(prefix + '📁 ' + path.basename(d) + '/ (' + dFiles.length + ' files)');
      pushTree(d, depth + 1, prefix + '  ');
    }
    for (const f of shown) {
      const ext = path.extname(f).toLowerCase();
      const meta = SRC_EXT.has(ext) ? ' · ' + countLines(f) + ' 行' : '';
      lines.push(prefix + '  📄 ' + path.basename(f) + meta);
    }
    if (fsHere.length > shown.length) lines.push(prefix + '  … (+' + (fsHere.length - shown.length) + ' files)');
  };
  lines.push('📁 ' + rel(root) + '/');
  pushTree(root, 1, '');
  return lines.join('\n');
}

// 主入口：buildRepoMap(dir) -> { ok, root, tree, files, dirs, summary, truncated }
export function buildRepoMap(dir) {
  const root = path.resolve(dir || '.');
  if (!isDir(root)) return { ok: false, error: '目录不存在: ' + root };
  const dirs = [];
  const filesByDir = new Map();
  const fileMeta = [];
  let skipped = 0;
  const walk = (d, depth) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (SKIP_DIRS.has(it.name) || it.name.startsWith('.rw-')) { skipped++; continue; }
      const p = path.join(d, it.name);
      if (it.isDirectory()) {
        if (fileMeta.length >= MAX_FILES && depth >= DEPTH_TREE) continue; // 已超限，浅层继续数目录
        dirs.push(p);
        walk(p, depth + 1);
      } else if (it.isFile()) {
        if (!filesByDir.has(d)) filesByDir.set(d, []);
        filesByDir.get(d).push(p);
        const ext = path.extname(it.name).toLowerCase();
        if (SRC_EXT.has(ext)) {
          const lines = countLines(p);
          fileMeta.push({
            path: path.relative(root, p),
            ext, lines,
            symbols: extractSymbols(p, ext, lines),
            imports: extractImports(p, ext, lines),
          });
        } else if (TEXT_EXT.has(ext)) {
          fileMeta.push({ path: path.relative(root, p), ext, lines: countLines(p), symbols: [], imports: [] });
        }
      }
    }
  };
  walk(root, 1);
  dirs.sort();
  // 输出文本组装（受容量约束）
  const totalFiles = fileMeta.length;
  const tree = treeText(root, dirs, filesByDir, totalFiles);
  const parts = ['repo_map: ' + root, '', tree, '', '── 文件明细（前 ' + Math.min(fileMeta.length, 200) + '，共 ' + totalFiles + ' 源/文本文件） ──'];
  let shown = 0;
  let truncated = false;
  for (const f of fileMeta) {
    if (shown >= 200) { truncated = true; break; }
    let block = '\n▪ ' + f.path + (f.lines > 0 ? '  (' + f.lines + ' 行)' : '');
    if (f.imports.length) block += '\n  imports: ' + f.imports.slice(0, 15).join(', ') + (f.imports.length > 15 ? ', …' : '');
    if (f.symbols.length) block += '\n  symbols: ' + f.symbols.join(', ');
    if ((parts.join('\n').length + block.length) > MAX_TEXT) { truncated = true; break; }
    parts.push(block);
    shown++;
  }
  const text = parts.join('\n') + (truncated ? '\n…（已达容量上限 ' + MAX_TEXT + ' 字符，地图截断）' : '');
  return {
    ok: true,
    root,
    text,
    summary: { files: totalFiles, dirs: dirs.length, skipped, truncated },
    files: fileMeta.slice(0, 200).map((f) => ({ path: f.path, lines: f.lines, symbols: f.symbols.length, imports: f.imports.length })),
  };
}
