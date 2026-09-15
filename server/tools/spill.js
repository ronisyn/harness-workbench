// server/tools/spill.js - 工具结果溢出（spill）：进上下文装不下的大结果落盘，上下文只留"预览 + 定位符 + 精确省略量"
// 依据《RW-Agent 架构 v1.1》§5.4：spill 发生在"工具刚返回时"，计数单位按**字节**；
// 折叠/修剪（prune）是另一个时刻的事，不在本模块。
// 三条设计约束（步6 验收 RA-05/RA-06/RA-07）：
//   1) 触发 = 超内联上限：字符数 > cap，或字节数 > SPILL_BYTES（后者是字节天花板；中文下 cap 先触发）
//   2) 落盘 best-effort：存盘失败**不改工具成败**，降级为"内联截断 + 如实提示"（信息不静默丢失）
//   3) 文件读取类工具不落盘：全文就是那个文件，定位符直接指向源路径（§5.4 "read 跳过"）
import fs from 'node:fs';
import path from 'node:path';
import { RW_WORKSPACE } from '../env.js';

export const SPILL_BYTES = 32768; // 字节天花板（我方拍板值；按 C2/C4 标定见 RA-05b）
export const SPILL_DIR = path.join(RW_WORKSPACE, 'spill');
// 源文件即全文的读取类工具：它们的结果不复制落盘，定位符指向源路径（args.path）
const READER_TOOLS = new Set(['read_file', 'read_file_range']);

const safeName = (s) => String(s || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

// 预览几何：头 60% + 尾 30%（余下 10% 给省略提示本身）；按字符切，Unicode 码点安全
function splitPreview(s, cap) {
  const head = s.slice(0, Math.floor(cap * 0.6));
  const tail = s.slice(-Math.floor(cap * 0.3));
  return { head, tail, omittedChars: s.length - head.length - tail.length, omittedBytes: Buffer.byteLength(s, 'utf8') - Buffer.byteLength(head + tail, 'utf8') };
}

function compose(parts, locator) {
  return parts.head + '\n…[已省略 ' + parts.omittedBytes + ' 字节（' + parts.omittedChars + ' 字符）；' + locator + ']…\n' + parts.tail;
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
  if (s.length <= cap && bytes <= SPILL_BYTES) return s;
  const parts = splitPreview(s, cap);
  const tool = meta.tool || '';
  // 3) 读取类：全文=源文件，不落盘
  const srcPath = meta.args && meta.args.path;
  if (READER_TOOLS.has(tool) && typeof srcPath === 'string' && srcPath) {
    logSpill(tool, meta.conversationId, bytes, 'reader', srcPath);
    return compose(parts, '全文即源文件 ' + srcPath + '（共 ' + bytes + ' 字节）；用 read_file_range 带 offset/length 分段读');
  }
  // 1)+2) 落盘取回；失败降级
  try {
    const dir = path.join(SPILL_DIR, safeName(meta.conversationId || 'anon'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName(tool) + '-' + safeName(meta.callId || String(Date.now())) + '.txt');
    const body = typeof meta.redact === 'function' ? meta.redact(s) : s; // 与落库同口径脱敏（密钥不入盘）
    fs.writeFileSync(file, body, 'utf8');
    logSpill(tool, meta.conversationId, bytes, 'stored', file);
    return compose(parts, '全文已存 ' + file + '（' + bytes + ' 字节），取回：fetch_spill {path:"' + file + '", offset:0, length:20000}');
  } catch (e) {
    logSpill(tool, meta.conversationId, bytes, 'degraded', e && e.message ? e.message : String(e));
    return compose(parts, '⚠️ 全文未能存盘（' + (e && e.message ? e.message : e) + '），已按内联截断降级：请改用分段/过滤参数缩小结果，或自行落盘后再读');
  }
}

/** 按范围取回溢出文件（仅供 fetch_spill 使用；路径必须落在 SPILL_DIR 内） */
export function readSpill(p, offset, length) {
  const abs = path.resolve(String(p || ''));
  const root = path.resolve(SPILL_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('只能读取溢出目录内的文件：' + SPILL_DIR);
  const off = offset == null ? 0 : Number(offset);
  const len = length == null ? 20000 : Number(length);
  if (!Number.isFinite(off) || off < 0) throw new Error('offset 必须为非负数字: ' + offset);
  if (!Number.isFinite(len) || len <= 0) throw new Error('length 必须为正数字: ' + length);
  const c = fs.readFileSync(abs, 'utf8');
  return { path: abs, offset: off, length: len, total: c.length, content: c.slice(off, off + len) };
}
