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

// Word (.docx)：解压 document.xml 提取文本
export async function extractDocx(file) {
  const { unzipSync } = await import('fflate');
  const buf = fs.readFileSync(file);
  const zip = unzipSync(new Uint8Array(buf));
  const xml = new TextDecoder().decode(zip['word/document.xml']);
  const text = xml.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:p[^>]*>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim();
  return text;
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

// PPT (.pptx)：解压 ppt/slides/slide*.xml
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
