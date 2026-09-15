#!/usr/bin/env node
// scripts/session-export.mjs —— 会话导出/导入的命令行入口（server/session-export.js 的薄壳）
//
// 用法：
//   node scripts/session-export.mjs export <convId> [--out file]   # 只读导出（默认写 tmp/session-<convId>.json）
//   node scripts/session-export.mjs import <file> [--dry-run]      # 校验+统计；**只有 --dry-run 才不写库**
// 为什么默认写到 tmp/：导出物可能很大（一个会话可上千条工具调用），打到 stdout 只会被截断；tmp/ 已 gitignore。
// 为什么打印的是"结构摘要"而不是正文：这个命令的输出是给人核对结构的，正文在文件里。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { pool } from '../server/db.js';
import { exportConversation, importConversation } from '../server/session-export.js';

const USAGE = '用法：node scripts/session-export.mjs export <convId> [--out file] | import <file> [--dry-run]';

/** 结构摘要：字段名 + 条数 + 字节数（不打印正文） */
function summarize(obj, file, bytes) {
  const colsOf = {
    conversation: Object.keys(obj.conversation || {}),
    messages: obj.messages[0] ? Object.keys(obj.messages[0]) : [],
    toolCalls: obj.toolCalls[0] ? Object.keys(obj.toolCalls[0]) : [],
    events: obj.events[0] ? Object.keys(obj.events[0]) : [],
    usage: obj.usage.rows[0] ? Object.keys(obj.usage.rows[0]) : [],
  };
  const lines = [
    file + '（' + bytes + ' 字节）',
    '  format=' + obj.format + ' formatVersion=' + obj.formatVersion + ' exportedAt=' + obj.exportedAt,
    '  conversation : 1 行 × ' + colsOf.conversation.length + ' 列 [' + colsOf.conversation.join(', ') + ']',
  ];
  for (const [name, rows] of [['messages', obj.messages], ['toolCalls', obj.toolCalls], ['events', obj.events], ['usage.rows', obj.usage.rows]]) {
    const key = name === 'usage.rows' ? 'usage' : name;
    lines.push('  ' + name.padEnd(13) + ': ' + rows.length + ' 行 × ' + colsOf[key].length + ' 列 [' + colsOf[key].join(', ') + ']');
  }
  return lines.join('\n');
}

async function main() {
  const [cmd, target] = process.argv.slice(2);
  if (cmd === 'export') {
    const outIdx = process.argv.indexOf('--out');
    const out = path.resolve(outIdx < 0 ? path.join(ROOT, 'tmp', 'session-' + target + '.json') : process.argv[outIdx + 1]);
    const obj = await exportConversation(target);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const json = JSON.stringify(obj, null, 2);
    fs.writeFileSync(out, json);
    console.log('导出成功（只读，未改动库）：');
    console.log(summarize(obj, path.relative(ROOT, out), Buffer.byteLength(json)));
    return;
  }
  if (cmd === 'import') {
    const dryRun = process.argv.includes('--dry-run');
    const obj = JSON.parse(fs.readFileSync(path.resolve(target), 'utf8')); // 坏 JSON 在这里就炸，不会走到库
    const r = await importConversation(obj, { dryRun });
    console.log((dryRun ? '[dry-run] 校验通过，一行未写：' : '导入完成：')
      + '源会话 #' + r.sourceId + (dryRun ? '' : ' → 新会话 #' + r.newId)
      + ' · messages ' + r.counts.messages + ' · toolCalls ' + r.counts.toolCalls
      + ' · events ' + r.counts.events + ' · usage ' + r.counts.usage);
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

try {
  await main();
} catch (e) {
  // 显式报错：版本不认识 / 字段缺失 / 引用不一致 都要把**原因**打出来（不吞、不半途而废）
  console.error('[' + (e.name || 'Error') + '] ' + e.message);
  process.exitCode = 1;
}
await pool.end();
