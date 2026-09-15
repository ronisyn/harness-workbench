#!/usr/bin/env node
// scripts/ledger-export.mjs —— ⑱「本地兜底（预算/审计/离线导出）」里缺的**账本导出**（v0.3 §4.8 / §7.1 ⑱）
//
// 为什么要有它（见《v0.3 符合性核对-20260916》§1.3 ⑱）：
//   会话级导出早已有（`rw-session`，`GET /api/conversations/:id/export-full` + `scripts/session-export.mjs`），
//   但**账本级没有**：审计只能经 `GET /api/audit` 读（上限 500 行）、`events` 只有 stdout 回放脚本。
//   客户机无外网、要离线对账/留证/交第三方时，这两本账就带不走。
//
// 做的是什么（简单优先：一个 CLI + 一个稳定格式，**不加 HTTP 端点**——端点要改 `server/index.js`，
// 那不属于账本导出这件事；导出是"读库写文件"，CLI 就够，也不必给线上多开一个读库面）：
//   · `audit_log` + `audit_log_archive`（**按 `archived` 口径**，与 `/api/audit` 同款：
//      current=只看主表 / archive=只看归档表 / all=两表合并，逐行标 `archived:0|1`）；
//   · `events`（事件账本，只追加、可回放；归档表 `events_archive` 同样按 archived 口径并入）。
//   输出 **JSONL**（每行一条、可流式读、可 `grep`；JSON 数组要先整体解析，大账本不友好）。
//
// 行为口径（三条）：
//   ① **只读**：本脚本只 SELECT，不写任何表、不改任何行；
//   ② **不脱敏**：`/api/audit` 走 `redactSecrets`，这里**原样**导出 —— 本脚本在**库所在的那台机器**上跑，
//      导出物与被导出的库同权限级（`rw-session` 导出同样原样带正文）。对外发之前请自行脱敏；
//   ③ **时间过滤就是字面时间**：`--since/--until` 直传 `created_at` 比较（交给库的时区），
//      已在归档表里的行按原 `created_at` 过滤（不是按 `archived_at`）—— 归档只搬位置，不改变事实时间。
//
// 用法：
//   node scripts/ledger-export.mjs                                  # 两本账全量 → tmp/ledger-<时间戳>.jsonl
//   node scripts/ledger-export.mjs --since 2026-09-01 --until 2026-10-01
//   node scripts/ledger-export.mjs --conversation 432 --ledger audit
//   node scripts/ledger-export.mjs --archived all --out D:\rw-ledger.jsonl
// 退出码：0=成功（含 0 行）；1=运行错误；2=用法错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../server/config.js';
import { db, pool } from '../server/db.js';

/** 表口径：主表 + 归档表（`archived` 列的含义与 `/api/audit?archived=` 一致） */
export const LEDGER_TABLES = {
  audit: { current: 'audit_log', archive: 'audit_log_archive' },
  events: { current: 'events', archive: 'events_archive' },
};

/** 时间戳 → ISO（mysql2 给 DATETIME 是 Date；假库/字符串原样转成 ISO 形状） */
function isoAt(v) {
  if (v instanceof Date) return v.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (v == null) return null;
  return String(v).replace(' ', 'T');
}

/** 只留值和顺序都稳定的键：库里没值的列不写进 JSONL（避免一堆 null 噪声，也让夹具能比对象） */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * 审计行 → 导出行（**纯函数**）。
 * `type:'audit'` 是这个混合 JSONL 流的判别键（与 events 的 `type` 同键不同域）。
 */
export function auditExportRow(r, archived) {
  return compact({
    id: r.id, type: 'audit', at: isoAt(r.created_at),
    archived: archived ? 1 : 0, action: r.action, detail: r.detail,
    account_id: r.account_id, conversation_id: r.conversation_id, shell_id: r.shell_id,
    ...(archived && r.archived_at ? { archived_at: isoAt(r.archived_at) } : {}),
  });
}

/** 事件行 → 导出行（`type` 是事件类型本身，`source` 标出这是账本那一支） */
export function eventExportRow(r, archived) {
  let payload = r.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* 坏 JSON 原样带走，别丢账 */ } }
  return compact({
    source: 'event', id: r.id, type: r.type, at: isoAt(r.created_at),
    archived: archived ? 1 : 0, conversation_id: r.conversation_id, seq: r.seq,
    ...(payload == null ? {} : { payload }),
    ...(archived && r.archived_at ? { archived_at: isoAt(r.archived_at) } : {}),
  });
}

/** 时间/会话条件（SQL 片段 + 参数）：`--since/--until/--conversation` 三个过滤器的唯一出处 */
export function ledgerConds({ since = null, until = null, conversation = null } = {}) {
  const conds = [], params = [];
  if (since) { conds.push('created_at >= ?'); params.push(since); }
  if (until) { conds.push('created_at <= ?'); params.push(until); }
  if (conversation !== null && conversation !== undefined && conversation !== '') { conds.push('conversation_id = ?'); params.push(Number(conversation)); }
  return { where: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params };
}

/** 一张表的取数（升序 by id：账本按写入顺序读出来才对得上） */
async function fetchTable(dbc, table, conds) {
  return await dbc.query('SELECT * FROM ' + table + conds.where + ' ORDER BY id', conds.params) || [];
}

/**
 * 取一个账本的行（主表/归档表/两表合并）。
 * @returns {Promise<Array<{row:object, archived:0|1, table:string}>>}
 */
export async function fetchLedgerRows(ledger, { dbc = db, since = null, until = null, conversation = null, archived = 'current' } = {}) {
  const t = LEDGER_TABLES[ledger];
  if (!t) throw new Error('未知账本：' + ledger + '（只支持 ' + Object.keys(LEDGER_TABLES).join('/') + '）');
  const conds = ledgerConds({ since, until, conversation });
  const want = archived === 'all' ? ['current', 'archive'] : archived === 'archive' ? ['archive'] : ['current'];
  const out = [];
  for (const kind of want) {
    const rows = await fetchTable(dbc, t[kind], conds);
    // archived 标志与 /api/audit?archived= 同口径：这一行是从主表还是归档表读出来的
    for (const r of rows) out.push({ row: r, archived: kind === 'archive' ? 1 : 0, table: t[kind] });
  }
  return out;
}

/** 取两本账的全部行（audit 在前、events 在后；各自内部按 id 升序） */
export async function exportLedgerRows({ dbc = db, since = null, until = null, conversation = null, archived = 'current', ledgers = ['audit', 'events'] } = {}) {
  const out = [];
  for (const ledger of ledgers) {
    const rows = await fetchLedgerRows(ledger, { dbc, since, until, conversation, archived });
    for (const r of rows) out.push({ ledger, ...r });
  }
  return out;
}

/** 一行 → JSONL 字符串（判别键在这里定：audit 走 auditExportRow，events 走 eventExportRow） */
export function toJsonl(row) {
  return JSON.stringify(row.ledger === 'events' ? eventExportRow(row.row, row.archived) : auditExportRow(row.row, row.archived));
}

/** 默认输出路径：`tmp/`（已 gitignore）+ 时间戳（连续导出不互相覆盖） */
export function defaultLedgerPath(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return path.join(ROOT, 'tmp', 'ledger-' + stamp + '.jsonl');
}

/** 把行写成 JSONL 文件（流式逐行写：账本可能很大，不在内存里拼一整个字符串） */
export function writeLedgerJsonl(rows, outPath) {
  const p = path.resolve(outPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  try {
    for (const r of rows) fs.writeSync(fd, toJsonl(r) + '\n');
  } finally { fs.closeSync(fd); }
  return p;
}

const USAGE = '用法：node scripts/ledger-export.mjs [--since <时间>] [--until <时间>] [--conversation <id>] '
  + '[--archived current|archive|all] [--ledger audit|events] [--out <文件>] [--quiet]';

async function main() {
  const argv = process.argv.slice(2);
  const o = { since: null, until: null, conversation: null, archived: 'current', out: null, ledgers: [], quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since') o.since = argv[++i];
    else if (a === '--until') o.until = argv[++i];
    else if (a === '--conversation') o.conversation = argv[++i];
    else if (a === '--archived') o.archived = argv[++i];
    else if (a === '--ledger') o.ledgers.push(argv[++i]);
    else if (a === '--out' || a === '-o') o.out = argv[++i];
    else if (a === '--quiet') o.quiet = true;
    else { console.error('未知参数：' + a + '\n' + USAGE); process.exitCode = 2; return; }
  }
  if (!['current', 'archive', 'all'].includes(o.archived)) { console.error('--archived 只支持 current|archive|all\n' + USAGE); process.exitCode = 2; return; }
  const ledgers = o.ledgers.length ? o.ledgers : ['audit', 'events'];
  for (const l of ledgers) { if (!LEDGER_TABLES[l]) { console.error('--ledger 只支持 audit|events（收到 ' + l + '）\n' + USAGE); process.exitCode = 2; return; } }

  const rows = await exportLedgerRows({ since: o.since, until: o.until, conversation: o.conversation, archived: o.archived, ledgers });
  const file = writeLedgerJsonl(rows, o.out || defaultLedgerPath());
  const stat = fs.statSync(file);
  // 计数按"账本×主表/归档表"分列：一眼看出归档有没有并进来
  const counts = {};
  for (const r of rows) { const k = r.ledger + (r.archived ? '(归档)' : ''); counts[k] = (counts[k] || 0) + 1; }
  if (!o.quiet) {
    console.log('账本导出完成（只读，未改动库）：');
    console.log('  过滤：since=' + (o.since || '不限') + ' until=' + (o.until || '不限')
      + ' conversation=' + (o.conversation === null ? '不限' : o.conversation) + ' archived=' + o.archived);
    console.log('  行数：' + (rows.length ? Object.entries(counts).map(([k, v]) => k + '=' + v).join(' · ') : '0（该条件下没有行）'));
    console.log('  产物：' + (path.relative(ROOT, file) || file) + '（' + stat.size + ' 字节，JSONL 每行一条）');
  } else {
    console.log('账本导出：' + rows.length + ' 行 → ' + (path.relative(ROOT, file) || file));
  }
}

// 直接执行才是 CLI（判定写法照 scripts/migrate-c18.mjs）
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith(SELF)) {
  try { await main(); } catch (e) { console.error('[' + (e.name || 'Error') + '] ' + String((e && e.message) || e)); process.exitCode = 1; }
  try { await pool.end(); } catch { /* 池子已经关了就算了 */ }
}
