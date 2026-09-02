// server/tools/extract.js - 多格式文档文本提取（PDF/Word/Excel/PPT）
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
export async function extractXlsx(file) {
  const XLSX = await import('xlsx');
  const wb = XLSX.readFile(file);
  const parts = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 });
    parts.push('【' + name + '】\n' + rows.map((r) => r.join('\t')).join('\n'));
  }
  return parts.join('\n\n');
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
