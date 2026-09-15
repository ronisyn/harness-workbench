// server/tools/spill.js - 工具结果溢出（spill）：进上下文装不下的大结果落盘，上下文只留"预览 + 定位符 + 精确省略量"
// 依据《RW-Agent 架构 v1.1》§5.4：spill 发生在"工具刚返回时"，计数单位按**字节**；
// 折叠/修剪（prune）是另一个时刻的事，不在本模块。
// 三条设计约束（步6 验收 RA-05/RA-06/RA-07）：
//   1) 触发 = 超内联上限：字符数 > cap，或字节数 > cap×SPILL_BYTES_PER_CHAR（字节天花板按 cap 派生，
//      原因见下面 SPILL_BYTES_PER_CHAR 注释 —— 固定常量 32768 在普通路径上几何上不可能触发）
//   2) 落盘 best-effort：存盘失败**不改工具成败**，降级为"内联截断 + 如实提示"（信息不静默丢失）
//   3) 文件读取类工具不落盘：全文就是那个文件，定位符直接指向源路径（§5.4 "read 跳过"）
// OP-17（2026-09-15）：本模块另负责溢出文件的**保留与清理**（cleanupSpill），此前只增不减。
import fs from 'node:fs';
import path from 'node:path';
import { RW_WORKSPACE } from '../env.js';

export const SPILL_DIR = path.join(RW_WORKSPACE, 'spill');
// ── 字节天花板（RA-05b 拍板，2026-09-15）────────────────────────────────────────────────
// 旧写法是一个固定常量 `SPILL_BYTES = 32768`，而普通路径 cap=4000 字符 ⇒ 字节数 ∈ [4000, 12000]，
// **恒定小于 32768** ⇒ 这个天花板在普通路径上**永不参与判定**（标定脚本实测：3,884 行里超阈值 0 行）。
// 一个不参与判定的旋钮就是负债，但直接删掉会丢掉"中文字节成本更高"这层保护。改成**按 cap 派生**：
//   天花板 = cap × SPILL_BYTES_PER_CHAR（取 2：ASCII 1 字节/字符、CJK 3 字节/字符 ⇒ 两倍是"贵一倍就该收"的界）
// · cap=4000 → 8,000 字节（实测当前全量 max=4,333 字节 ⇒ **对现有流量零影响**，但对将来的 CJK 重结果会生效）
// · cap=12000（子代理族）→ 24,000 字节
// 这样"字符上限"管短文本、"字节上限"管同样字符数但更贵的中文重结果 —— 两个触发器都真的在判定里。
export const SPILL_BYTES_PER_CHAR = 2;
export const byteCeiling = (cap) => Math.max(1, Number(cap) || 0) * SPILL_BYTES_PER_CHAR;
// 兼容旧引用（标定脚本按"普通路径的实际天花板"读它）：等价于 byteCeiling(4000)
export const SPILL_BYTES = byteCeiling(4000);
// 源文件即全文的读取类工具：它们的结果不复制落盘，定位符指向源路径（args.path）
const READER_TOOLS = new Set(['read_file', 'read_file_range']);

const safeName = (s) => String(s || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
// 会话归属：溢出文件一律落在 <SPILL_DIR>/<会话>/ 之下（写出与取回两处共用同一个算式，不许各写一份）。
// 这条目录约定同时是 v0.3 §4.4「溢出文件的权限」的判据（取回时校验归属，见 readSpill）。
export const spillOwnerDir = (conversationId) => path.join(SPILL_DIR, safeName(conversationId || 'anon'));
// 同毫秒内多次落盘必须落到不同文件：并行工具调用里若没有 callId（工具内部落盘就是这种），
// 只用 Date.now() 会互相覆盖（后写的把先写的顶掉，定位符指向别人的内容）。序号只用于消歧，不参与任何判定。
let spillSeq = 0;
const spillFileName = (tool, callId) => safeName(tool) + '-' + safeName(callId || Date.now().toString(36) + '-' + (++spillSeq)) + '.txt';

// 预览几何：头 60% + 尾 30%（余下 10% 给省略提示本身）；按字符切，Unicode 码点安全
// ⚠️ 调用方必须保证 budget ≤ s.length，否则头尾会重叠、省略量变成负数、输出比原文还长
//    （2026-09-15 实测踩到：见 spillToolResult 里的预算计算与兜底）。
function splitPreview(s, budget) {
  const b = Math.max(0, Math.min(Number(budget) || 0, s.length));
  const head = s.slice(0, Math.floor(b * 0.6));
  const tail = s.slice(-Math.floor(b * 0.3));
  return { head, tail, omittedChars: s.length - head.length - tail.length, omittedBytes: Buffer.byteLength(s, 'utf8') - Buffer.byteLength(head + tail, 'utf8') };
}

// ── 按行对齐的预览（2026-09-15，给 read_file 用）───────────────────────────────────────────
// 通用字符切有两个毛病：① 切在行中间，代码文件被拦腰截断；② 中段**静默丢失**，只给一个"源文件路径"，
// 模型得自己换算字符偏移（实际做法就是再整读一遍）。这里改成按行切，并把省略区间写成**行号**——
// grep_search 返回的也是行号，read_file_range 现在支持 fromLine/toLine，闭环就合上了。
export const READ_INLINE_CHARS = 4000; // 与 execTool 给普通工具的 msgCap 保持一致（单一出处）

/**
 * 文件内容 → 按行对齐的预览（仅当超限时才用）。
 * @returns {{text:string, omittedFromLine:number, omittedToLine:number, totalLines:number, full:boolean}}
 */
export function lineAlignedPreview(text, cap = READ_INLINE_CHARS) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  const totalLines = lines.length;
  if (s.length <= cap) return { text: s, omittedFromLine: 0, omittedToLine: 0, totalLines, full: true };
  const headBudget = Math.floor(cap * 0.6), tailBudget = Math.floor(cap * 0.3);
  let headChars = 0, hEnd = 0;
  while (hEnd < lines.length && headChars + lines[hEnd].length + 1 <= headBudget) { headChars += lines[hEnd].length + 1; hEnd++; }
  let tailChars = 0, tStart = lines.length;
  while (tStart > hEnd && tailChars + lines[tStart - 1].length + 1 <= tailBudget) { tStart--; tailChars += lines[tStart - 1].length + 1; }
  if (hEnd === 0 && tStart === lines.length) { // 极端：单行巨长，按行切不动 → 退回字符切（但如实标注）
    const p = splitPreview(s, cap);
    return { text: p.head + '\n…[已省略 ' + p.omittedBytes + ' 字节；本文件是单行超长内容，无法按行切]…\n' + p.tail, omittedFromLine: 1, omittedToLine: 1, totalLines, full: false };
  }
  const omittedFromLine = hEnd + 1;
  const omittedToLine = tStart; // 1 起，含
  const marker = omittedToLine >= omittedFromLine
    ? '\n…[已省略第 ' + omittedFromLine + '–' + omittedToLine + ' 行（共 ' + totalLines + ' 行 / ' + Buffer.byteLength(s, 'utf8')
      + ' 字节）；要看这段用 read_file_range {path, fromLine:' + omittedFromLine + ', toLine:' + Math.min(totalLines, omittedFromLine + 199) + '}，或 force:true 取全文]…\n'
    : '\n…[中间无省略行]…\n';
  return {
    text: lines.slice(0, hEnd).join('\n') + marker + lines.slice(tStart).join('\n'),
    omittedFromLine, omittedToLine, totalLines, full: false,
  };
}

function compose(parts, locator) {
  return parts.head + '\n…[已省略 ' + parts.omittedBytes + ' 字节（' + parts.omittedChars + ' 字符）；' + locator + ']…\n' + parts.tail;
}

// ── 「大结果」工具的明细落盘（v0.3 §6.1 通则：任何大结果工具都必须遵守溢出规范）────────────────
// 背景（v0.3 §6.1 点名的 Excel 那一条）：工具**自己**先 slice(0, 20000) 再进上下文，进上下文后又被外层裁到 4000 ——
// **中间数据丢了、token 照烧**，而被切掉的那段既无定位符也不落盘（符合性核对 §3.2 列出 5 个这样的工具）。
// 通则：明细一律落盘，上下文只留「结构摘要 + 行列/行数信息 + 溢出路径」，需要明细时用 fetch_spill 按范围二次取数。
// 下面两个函数是这条通则的唯一出处（spillToolResult 管的是"已经生成好的最终文本"那一层，两件事不要混）。
export const DETAIL_PREVIEW_CHARS = Math.floor(READ_INLINE_CHARS / 2); // 预览占内联上限的一半：另一半留给摘要字段与定位符，
// 免得"摘要"自身又超 4000 被外层 spill 再切一次（那会把定位符挤到预览之外，模型反而读不到路径）。

/**
 * 明细全文落盘（best-effort）。路径 = <SPILL_DIR>/<会话>/<工具>-<callId|时间戳>.txt。
 * @param {string} text 明细全文
 * @param {{tool?:string, conversationId?:*, callId?:string, redact?:Function}} meta
 * @returns {{path:string, bytes:number}}
 */
export function writeSpill(text, meta = {}) {
  const s = String(text ?? '');
  const dir = spillOwnerDir(meta.conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, spillFileName(meta.tool, meta.callId));
  const body = typeof meta.redact === 'function' ? meta.redact(s) : s; // 与落库同口径脱敏（密钥不入盘）
  fs.writeFileSync(file, body, 'utf8');
  return { path: file, bytes: Buffer.byteLength(s, 'utf8') };
}

/** 头部按行预览（按字符预算；切不动时退回字符切并如实标注，绝不静默给半行后说"完整"） */
function headLines(s, budget) {
  const totalLines = String(s).split('\n').length;
  if (s.length <= budget) return { text: s, shownLines: totalLines, omittedChars: 0, charCut: false };
  const lines = String(s).split('\n');
  const out = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget) break;
    out.push(l);
    used += l.length + 1;
  }
  if (!out.length) return { text: s.slice(0, budget), shownLines: 1, omittedChars: s.length - budget, charCut: true };
  const text = out.join('\n');
  return { text, shownLines: out.length, omittedChars: s.length - text.length, charCut: false };
}

/**
 * 「结构摘要 + 溢出路径」型工具的统一收口：明细落盘 + 头部预览 + 量。
 * **调用方不得先截断**：先 slice 再传进来 = 中段静默丢失（这正是 v0.3 §6.1 要治的写法）。
 * 落盘失败不静默丢：返回 degraded 原因，调用方必须如实带出去（信息不丢优先于省 token）。
 * @param {string} text 明细全文
 * @param {{tool?:string, conversationId?:*, callId?:string, redact?:Function}} meta
 * @param {{previewChars?:number, force?:boolean}} opts
 * @returns {{preview:string, previewLines:[number,number], totalLines:number, omittedChars:number,
 *            chars:number, bytes:number, spillPath:string|null, degraded:string|null}}
 */
export function detailSummary(text, meta = {}, opts = {}) {
  const s = String(text ?? '');
  const budget = Number(opts.previewChars) > 0 ? Number(opts.previewChars) : DETAIL_PREVIEW_CHARS;
  const bytes = Buffer.byteLength(s, 'utf8');
  const totalLines = s.split('\n').length;
  const preview = headLines(s, budget);
  const over = opts.force === true || s.length > budget;
  const base = {
    preview: preview.text,
    previewLines: [1, Math.max(1, preview.shownLines)],
    totalLines,
    omittedChars: preview.omittedChars,
    chars: s.length,
    bytes,
    spillPath: null,
    degraded: null,
  };
  if (!over) return base;
  try {
    const { path: file } = writeSpill(s, meta);
    logSpill(meta.tool, meta.conversationId, bytes, 'detail-stored', file);
    return { ...base, spillPath: file };
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    logSpill(meta.tool, meta.conversationId, bytes, 'detail-degraded', msg);
    return { ...base, degraded: msg };
  }
}

// 溢出事件留痕（与 [collapse] 同风格）：三条路径（读取类/已落盘/降级）都能在 journalctl 取证，C2 归因也用它
function logSpill(tool, conv, bytes, outcome, extra) {
  console.log('[spill] tool=' + (tool || '-') + ' conv=' + (conv || '-') + ' bytes=' + bytes + ' outcome=' + outcome + (extra ? ' ' + extra : ''));
}

/**
 * 工具结果 → 进上下文的文本。
 * @param {string} text   工具结果（调用方已 JSON.stringify）
 * @param {number} cap    内联字符上限（普通 4000 / 子代理族 12000）
 * @param {object} meta   { tool, args, conversationId, callId, redact }
 * @returns {string}      原样（未超限）或 "预览 + 省略量 + 定位符"
 */
export function spillToolResult(text, cap, meta = {}) {
  const s = String(text ?? '');
  const bytes = Buffer.byteLength(s, 'utf8');
  const overChars = s.length > cap;
  const overBytes = bytes > byteCeiling(cap);
  if (!overChars && !overBytes) return s;
  // 预览预算（决定"能看到多少"）：
  //   · 字符超限：还是 cap —— **老行为一点不变**（这类结果本来就比 cap 长，收成 cap 一定是变小）
  //   · 只有字节超限（字符数没超）：按 60% 收。这里是 2026-09-15 修掉的真 bug：
  //     原先一律用 cap 当预算，而字节超限这一档满足 `s.length ≤ cap` ⇒ 头尾直接重叠，
  //     实测中文 2667 字符会输出 3803 字符（**比原文还长**）并声称"已省略 -933 字符"。
  //     改成按比例收之后，"溢出"这两个字才名副其实。
  const budget = overChars ? cap : Math.max(1, Math.floor(s.length * 0.6));
  const parts = splitPreview(s, budget);
  const tool = meta.tool || '';
  // 3) 读取类：全文=源文件，不落盘
  const srcPath = meta.args && meta.args.path;
  const build = (locator) => compose(parts, locator);
  // 兜底护栏（防这一类问题再回来）：溢出后没变小，就**干脆不溢出**。
  // 宁可让上下文多占一点，也不能让它变大 —— "省空间"的动作不能反而占更多空间。
  const smaller = (out) => (out.length < s.length ? out : s);
  if (READER_TOOLS.has(tool) && typeof srcPath === 'string' && srcPath) {
    logSpill(tool, meta.conversationId, bytes, 'reader', srcPath);
    return smaller(build('全文即源文件 ' + srcPath + '（共 ' + bytes + ' 字节）；用 read_file_range 带 offset/length 分段读'));
  }
  // 1)+2) 落盘取回；失败降级（落盘实现与 detailSummary 共用 writeSpill：一个落盘口径只留一处）
  try {
    const { path: file } = writeSpill(s, meta);
    const out = smaller(build('全文已存 ' + file + '（' + bytes + ' 字节），取回：fetch_spill {path:"' + file + '", offset:0, length:20000}'));
    if (out === s) { logSpill(tool, meta.conversationId, bytes, 'skipped-not-smaller', file); return s; }
    logSpill(tool, meta.conversationId, bytes, 'stored', file);
    return out;
  } catch (e) {
    logSpill(tool, meta.conversationId, bytes, 'degraded', e && e.message ? e.message : String(e));
    return smaller(build('⚠️ 全文未能存盘（' + (e && e.message ? e.message : e) + '），已按内联截断降级：请改用分段/过滤参数缩小结果，或自行落盘后再读'));
  }
}

/**
 * 按范围取回溢出文件（仅供 fetch_spill 使用）。
 * 两道围栏：① 路径必须落在 SPILL_DIR 内；② **必须是本会话自己写的**那份（v0.3 §4.4「溢出文件的权限」）。
 * 第②条此前缺失（符合性核对 §3.5 缺陷②）：溢出文件按会话分目录存，但取回只查了第①条 ⇒ 任意会话
 * （含 read 档）能读别的会话的溢出文件。归属判据就是目录名（写出时用 spillOwnerDir，两边同一个算式）。
 * 取不到（或不归属）一律**如实报错**，不返回空内容——静默返回空会让模型以为"文件是空的"。
 * @param {string} p 溢出文件路径（上下文里的定位符）
 * @param {number} [offset] 起始字符偏移
 * @param {number} [length] 读取字符数
 * @param {*} [conversationId] 请求方会话 id（缺省按 'anon'，与写出侧同口径）
 */
export function readSpill(p, offset, length, conversationId) {
  const abs = path.resolve(String(p || ''));
  const root = path.resolve(SPILL_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('只能读取溢出目录内的文件：' + SPILL_DIR);
  const owner = path.basename(path.dirname(abs));
  if (owner !== safeName(conversationId || 'anon')) {
    throw new Error('只能取回本会话自己的溢出文件：该文件由别的会话写出（溢出定位符只在写出它的那个会话里有效）。请用本会话自己的工具结果定位符，或重新取数。');
  }
  const off = offset == null ? 0 : Number(offset);
  const len = length == null ? 20000 : Number(length);
  if (!Number.isFinite(off) || off < 0) throw new Error('offset 必须为非负数字: ' + offset);
  if (!Number.isFinite(len) || len <= 0) throw new Error('length 必须为正数字: ' + length);
  const c = fs.readFileSync(abs, 'utf8');
  return { path: abs, offset: off, length: len, total: c.length, content: c.slice(off, off + len) };
}

// ── OP-17 溢出文件保留与清理策略（2026-09-15 补齐）────────────────────────────────────────
// 旧状态：`spill/` **只增不减**——只有写出（mkdirSync/writeFileSync）与读取（readSpill），没有任何删除路径。
// 实测当时 5 个文件 / 72KB、磁盘 20%，尚未成灾；但"靠运维手工清"不是策略，架构 §15 `OP-17` 因此挂着。
// 两步策略（都是**保守**的，宁可少删）：
//   ① 按龄：mtime 早于 maxAgeDays 的删掉（默认 7 天 —— 溢出文件是**当期取回**用的，过期即无引用价值）；
//   ② 按量：仍超过 maxTotalBytes 时，从最旧开始删到额度内（默认 64MB）。
// 安全边界：只走 `dir` 之下的两级（`<conv>/<file>`），逐项 `path.resolve` 复核前缀，
//   目录本身与任何越界路径一律不删；单个文件删除失败只记账不抛。
export const SPILL_MAX_AGE_DAYS = 7;
export const SPILL_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * 清理溢出目录。
 * @param {{dir?:string, maxAgeDays?:number, maxTotalBytes?:number, now?:number}} opts
 * @returns {{scanned:number, totalBytes:number, deletedAge:number, deletedQuota:number, freedBytes:number, kept:number, errors:string[]}}
 */
export function cleanupSpill(opts = {}) {
  const root = path.resolve(opts.dir || SPILL_DIR);
  const maxAgeDays = Number(opts.maxAgeDays) > 0 ? Number(opts.maxAgeDays) : SPILL_MAX_AGE_DAYS;
  const maxTotal = Number(opts.maxTotalBytes) > 0 ? Number(opts.maxTotalBytes) : SPILL_MAX_TOTAL_BYTES;
  const now = Number(opts.now) || Date.now();
  const cutoff = now - maxAgeDays * 86400000;
  const out = { root, scanned: 0, totalBytes: 0, deletedAge: 0, deletedQuota: 0, freedBytes: 0, kept: 0, errors: [] };
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; } // 目录不存在 = 无事可做
  const files = [];
  for (const e of entries) {
    const d = path.join(root, e.name);
    if (path.resolve(d) === root) continue; // 防御：不处理根本身
    if (e.isDirectory()) {
      let subs = [];
      try { subs = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const s of subs) {
        if (!s.isFile()) continue;
        const f = path.join(d, s.name);
        if (!path.resolve(f).startsWith(root + path.sep)) continue; // 越界不碰
        files.push(f);
      }
    } else if (e.isFile()) {
      const f = path.join(root, e.name);
      if (path.resolve(f).startsWith(root + path.sep)) files.push(f); // 兼容直接放在根下的历史文件
    }
  }
  const rm = (f, size) => {
    try { fs.unlinkSync(f); out.freedBytes += size; return true; }
    catch (err) { out.errors.push(path.basename(f) + ': ' + (err && err.message ? err.message : String(err))); return false; }
  };
  // ① 按龄
  const survivors = [];
  for (const f of files) {
    out.scanned++;
    let st = null;
    try { st = fs.statSync(f); } catch { continue; } // 已被别人删掉/不可读：跳过
    out.totalBytes += st.size;
    if (st.mtimeMs < cutoff) {
      if (rm(f, st.size)) { out.deletedAge++; out.totalBytes -= st.size; continue; }
    }
    survivors.push({ f, size: st.size, mtimeMs: st.mtimeMs });
  }
  // ② 按量（从最旧开始）
  if (out.totalBytes > maxTotal) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const s of survivors) {
      if (out.totalBytes <= maxTotal) break;
      if (rm(s.f, s.size)) { out.deletedQuota++; out.totalBytes -= s.size; }
    }
  }
  out.kept = out.scanned - out.deletedAge - out.deletedQuota;
  // 清理空的会话目录（不清根本身）
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const d = path.join(root, e.name);
    try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* 忽略 */ }
  }
  if (out.deletedAge || out.deletedQuota || out.errors.length) {
    console.log('[spill-cleanup] 扫描 ' + out.scanned + ' · 按龄删 ' + out.deletedAge + ' · 按量删 ' + out.deletedQuota
      + ' · 释放 ' + out.freedBytes + ' 字节 · 保留 ' + out.kept + ' · 现存 ' + out.totalBytes + ' 字节'
      + (out.errors.length ? ' · 失败 ' + out.errors.length : ''));
  }
  return out;
}
