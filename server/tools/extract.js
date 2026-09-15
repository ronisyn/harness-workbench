// server/tools/extract.js - 多格式文档文本提取（PDF/Word/Excel/PPT）
// 契约（2026-09-16，v0.3 §6.1）：本模块只负责"把文件变成**完整**文本"，**不做任何截断**。
// 上限与溢出是上层的事（tools/index.js 的 extractToolResult → spill.js 的 detailSummary）：
// 在这里 slice 一次、在上下文层再裁一次，就会变成"中间数据丢了、token 照烧"（§6.1 点名的 Excel 那条）。
import fs from 'node:fs';
import path from 'node:path';

// PDF
export async function extractPdf(file) {
  const { default: pdfParse } = await import('pdf-parse');
  const buf = fs.readFileSync(file);
  const data = await pdfParse(buf);
  return data.text || '';
}

// Word (.docx)：mammoth 提取（html→text 简化）
export async function extractDocx(file) {
  const mammoth = await import('mammoth');
  const r = await mammoth.extractRawText({ path: file });
  return (r.value || '').trim();
}

// Excel (.xlsx)
// ⚠️ 取 API 必须先经 `default`：xlsx 是 CJS 包，Node 的 ESM 互操作对它的具名导出探测不到
// （实测 `await import('xlsx')` 的命名空间只有 default/find/parse/read/utils/version/write/writeFile，
//  **没有 readFile**）⇒ 原写法 `(await import('xlsx')).readFile(...)` 必然抛 "XLSX.readFile is not a function"。
// 这是一处**既有 bug**（不是本次改出来的）：符合性核对显示 extract_* 在真实流量里调用 0 次，所以一直没暴露。
async function xlsxApi() {
  const m = await import('xlsx');
  return (m.default && typeof m.default.readFile === 'function') ? m.default : m;
}
// 返回 { text, sheets }：text = 完整 TSV 明细（**不截断**，交给上层落 spill）；
// sheets = 结构摘要（每个表的名字/行数/列数）＋该表在 text 里的**字符区间与行区间**——
// 有了它，模型才能"按范围二次取数"（fetch_spill {path, offset, length} 或按行号），这正是 §6.1 的处置。
export async function extractXlsx(file) {
  const XLSX = await xlsxApi();
  const wb = XLSX.readFile(file);
  const parts = [];
  const sheets = [];
  let text = '';
  let lineCursor = 1; // 1 起的全局行号（text 里第几行）
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
    const body = '【' + name + '】\n' + rows.map((r) => r.join('\t')).join('\n');
    const offset = text.length === 0 ? 0 : text.length + 2; // 表之间以空行（'\n\n'）分隔
    const cols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    sheets.push({
      name,
      rows: rows.length,
      cols,
      offset,
      length: body.length,
      fromLine: lineCursor,
      toLine: lineCursor + body.split('\n').length - 1,
    });
    parts.push(body);
    text += (text.length === 0 ? '' : '\n\n') + body;
    lineCursor += body.split('\n').length + 1;
  }
  return { text, sheets };
}

// PPT (.pptx)：解压 ppt/slides/slide*.xml（依赖 fflate）
export async function extractPptx(file) {
  const { unzipSync } = await import('fflate');
  const buf = fs.readFileSync(file);
  const zip = unzipSync(new Uint8Array(buf));
  const parts = [];
  const slideNames = Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  for (const name of slideNames) {
    const xml = new TextDecoder().decode(zip[name]);
    const text = xml.replace(/<a:p[^>]*>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n---\n');
}
