// 步6 系统级验证：工具结果溢出（spill）+ fetch_spill 取回闭环
// 用法：node /tmp/rw-step6-spill.mjs [normal|degraded]
// 判据：
//   normal   → repo_map 结果超内联上限 → 上下文留预览+定位符；全文落盘；fetch_spill 可取回
//   degraded → 溢出目录不可写 → 工具仍 status=done，日志出现 outcome=degraded
import { db } from 'file:///srv/harness-workbench/server/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { readSpill, SPILL_DIR } from 'file:///srv/harness-workbench/server/tools/spill.js';

const MODE = process.argv[2] || 'normal';
const BASE = 'http://127.0.0.1:880';
const log = (...a) => console.log('[' + MODE + '] ' + a.join(' '));

const lg = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }), signal: AbortSignal.timeout(20000) })).json();
const H = { Authorization: 'Bearer ' + lg.token, 'Content-Type': 'application/json' };

const c = await (await fetch(BASE + '/api/conversations', { method: 'POST', headers: H, body: JSON.stringify({ title: '__step6_spill_' + MODE + '__', permission: 'read' }), signal: AbortSignal.timeout(20000) })).json();
const cid = c.id || (c.conversation && c.conversation.id);
log('conv=' + cid);

const MSG = '【平台自检】严格按序：① 调用一次 repo_map {dir:"/srv/harness-workbench"}；'
  + '② 若①的结果里出现"全文已存 <路径>"，就用 fetch_spill {path:"<那个路径>", offset:0, length:40} 取回开头 40 个字符；'
  + '③ 一句话报告：①结果里是否有"已省略…全文已存"字样，以及②取回的前 40 个字符。';
let answer = '';
try {
  const r = await fetch(BASE + '/api/chat', { method: 'POST', headers: H, body: JSON.stringify({ conversationId: cid, content: MSG }), signal: AbortSignal.timeout(240000) });
  answer = await r.text();
} catch (e) { log('chat 失败/超时: ' + e.message); }
const tools = [...answer.matchAll(/"type":"tool_done","tool":\{"name":"([^"]+)","args":\{[^}]*\},"result":"((?:[^"\\]|\\.){0,120})/g)].map((m) => m[1] + ' → ' + m[2].replace(/\\n/g, ' ').slice(0, 100));
log('工具事件(' + tools.length + '):');
for (const t of tools) log('   ' + t);
const text = answer.replace(/\\n/g, '\n');
const tail = /\{"type":"done"[^]*?"content":"((?:[^"\\]|\\.)*)"/.exec(text);
log('最终答复片段: ' + (tail ? tail[1].slice(0, 300) : '（未取到）'));

const rows = await db.query('SELECT tool_name, status, LEFT(result_summary,90) rs FROM tool_calls WHERE conversation_id=? ORDER BY id', [cid]);
log('落库工具调用:');
for (const r of rows) log('   ' + r.tool_name + ' | ' + r.status + ' | ' + String(r.rs).replace(/\s+/g, ' ').slice(0, 80));

// 溢出文件（独立于模型，直接证明"全文在盘、可按范围取回"）
const dir = path.join(SPILL_DIR, String(cid));
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir)) {
    const abs = path.join(dir, f);
    const raw = fs.readFileSync(abs, 'utf8');
    log('溢出文件: ' + abs + ' (' + fs.statSync(abs).size + ' 字节, ' + raw.length + ' 字符)');
    try {
      const got = readSpill(abs, 0, 40);
      log('readSpill 前40字符: ' + JSON.stringify(got.content) + '  一致=' + (got.content === raw.slice(0, 40)) + ' total=' + got.total);
    } catch (e) { log('readSpill 失败: ' + e.message); }
  }
} else log('溢出目录不存在: ' + dir);

// 卫生：清掉本会话的库内痕迹与溢出文件（不污染基线）
for (const t of ['messages', 'tool_calls', 'usage_stats', 'model_telemetry', 'agent_runs', 'audit_log']) await db.query('DELETE FROM ' + t + ' WHERE conversation_id=?', [cid]);
await db.query('DELETE FROM conversations WHERE id=?', [cid]);
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
log('清理完成；残留会话=' + (await db.query('SELECT COUNT(*) n FROM conversations WHERE id=?', [cid]))[0].n);
process.exit(0);
