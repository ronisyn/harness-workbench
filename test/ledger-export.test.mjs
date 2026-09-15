// test/ledger-export.test.mjs —— ⑱「离线导出」的账本导出（夹具，**不碰真库**）
//
// 为什么锁这几条（v0.3 §4.8「账本落账在引擎、对账在平台」/ §7.1 ⑱，见核对 §1.3 ⑱）：
//   账本此前只能经 `GET /api/audit` 读（**上限 500 行**）或 stdout 回放，客户机无外网时带不走 ——
//   本夹具锁住导出的**行形状**（每行必须自带 `type/id/at`，不然离线对账要先猜字段）与**过滤参数**
//   （`--since/--until/--conversation`，以及 `archived` 口径与 `/api/audit` 一致）。
//   用假库：真实账本是别人的数据，只读验证放在手跑里（见交付说明的"服务器上手工验证"）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditExportRow, eventExportRow, ledgerConds, fetchLedgerRows,
  exportLedgerRows, toJsonl, writeLedgerJsonl, defaultLedgerPath,
} from '../scripts/ledger-export.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 假库：只认本模块发出的那一种语句（SELECT * FROM <表> [WHERE …] ORDER BY id）──────────────
// 只认那一种，是为了让"模块换了表名/换了列"立刻在这里炸出来，而不是静默返回空集合。
const TABLES = ['audit_log', 'audit_log_archive', 'events', 'events_archive'];
const cmp = (a, b) => { const t = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime()); return t(a) - t(b); };
function fakeDb(seed) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const m = /^SELECT \* FROM (\w+)(?: WHERE (.+))? ORDER BY id$/.exec(sql);
      if (!m) throw new Error('假库不认识的语句：' + sql);
      const t = m[1];
      if (!TABLES.includes(t)) throw new Error('假库没有这张表：' + t);
      let rows = [...(seed[t] || [])];
      if (m[2]) {
        // 条件用 AND 连起来：**逐条**求值（第一版只算了第一条，于是 conversation 过滤在夹具里是假的——
        // 那种"夹具比实现宽松"的写法会让测试假装通过，宁可在这里多写十行）
        m[2].split(' AND ').forEach((cond, i) => {
          const [left, op] = cond.split(' ');
          const v = params[i]; // 不 shift：调用方记录的 params 要能原样核对（别把断言对象改掉）
          if (op === '>=') rows = rows.filter((r) => cmp(r[left], v) >= 0);
          else if (op === '<=') rows = rows.filter((r) => cmp(r[left], v) <= 0);
          else if (op === '=') rows = rows.filter((r) => String(r[left]) === String(v));
          else throw new Error('假库不认识的过滤：' + cond);
        });
      }
      return rows.sort((a, b) => a.id - b.id);
    },
  };
}

const d = (s) => new Date(s);
// 形状照真库列名（information_schema 口径），不是照抄建表语句
const seed = () => ({
  audit_log: [
    { id: 11, account_id: 1, action: 'canary:run', detail: 'shell=code ref=code passed=9/9', conversation_id: null, shell_id: 2, created_at: d('2026-09-01T10:00:00Z') },
    { id: 12, account_id: 1, action: 'tool:read_file', detail: '{"args":"{}"}', conversation_id: 7, shell_id: 2, created_at: d('2026-09-02T10:00:00Z') },
    { id: 13, account_id: null, action: 'prefix:invalidate', detail: 'epoch-changed', conversation_id: 9, shell_id: null, created_at: d('2026-09-03T10:00:00Z') },
  ],
  audit_log_archive: [
    { id: 1, account_id: 1, action: 'tool:web_search', detail: 'old', conversation_id: 7, shell_id: 2, created_at: d('2026-01-01T00:00:00Z'), archived_at: d('2026-08-01T00:00:00Z') },
  ],
  events: [
    { id: 101, conversation_id: 7, seq: 1, type: 'run_start', payload: { run: 1 }, created_at: d('2026-09-02T10:00:00Z') },
    // payload 给**字符串**：驱动给对象还是字符串随版本而异（JSON 列），两条分支都要覆盖
    { id: 102, conversation_id: 7, seq: 2, type: 'tool_done', payload: '{"tool":{"name":"read_file"}}', created_at: d('2026-09-02T10:00:01Z') },
    { id: 103, conversation_id: 9, seq: 1, type: 'done', payload: {}, created_at: d('2026-09-03T10:00:00Z') },
  ],
  events_archive: [
    { id: 50, conversation_id: 7, seq: 1, type: 'run_end', payload: { run: 1 }, created_at: d('2026-02-01T00:00:00Z'), archived_at: d('2026-08-01T00:00:00Z') },
  ],
});

const lines = (rows) => rows.map(toJsonl);

// ---------------- ① 行形状 ----------------
test('行形状：每行一条、自带 type/id/at；审计与事件各有判别键，null 列不写空壳', async () => {
  const rows = await exportLedgerRows({ dbc: fakeDb(seed()) });
  const ls = lines(rows).map((s) => JSON.parse(s));
  assert.equal(ls.length, 6, '默认 archived=current：审计主表 3 + events 主表 3（归档表口径见下面单独一条）');
  // 每个导出行的最小契约：type/id/at 三件套（离线对账/第三方解析的锚）
  for (const l of ls) {
    assert.equal(typeof l.id, 'number', 'id 必须是数字：' + JSON.stringify(l));
    assert.ok(typeof l.type === 'string' && l.type, 'type 必须是非空字符串：' + JSON.stringify(l));
    assert.match(l.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'at 必须是 ISO 形状（不是库里的原地格式）：' + JSON.stringify(l));
    assert.ok('archived' in l, '必须标出这行来自主表还是归档表（archived 口径与 /api/audit 一致）');
  }
  const audit = ls.find((l) => l.id === 11);
  assert.deepEqual(audit, {
    id: 11, type: 'audit', at: '2026-09-01T10:00:00Z', archived: 0,
    action: 'canary:run', detail: 'shell=code ref=code passed=9/9', account_id: 1, shell_id: 2,
  });
  assert.equal('conversation_id' in audit, false, '库里的 NULL 不写进 JSONL（少一堆 null 噪声，形状更稳）');
  const ev = ls.find((l) => l.id === 101);
  assert.equal(ev.source, 'event', '审计与事件混在一个 JSONL 流里，必须有判别键');
  assert.equal(ev.type, 'run_start', '事件行的 type 就是事件类型本身（不再包一层）');
  assert.equal(ev.seq, 1);
  assert.deepEqual(ev.payload, { run: 1 });
  assert.deepEqual(ls.find((l) => l.id === 102).payload, { tool: { name: 'read_file' } }, 'JSON 列是字符串时要解析成对象');
  // 审计行的 type 固定为 'audit'，事件行带 source='event' —— 两支互不冒充
  assert.equal(ls.filter((l) => l.type === 'audit').length, 3);
  assert.equal(ls.filter((l) => l.source === 'event').length, 3);
});

test('纯函数层：auditExportRow / eventExportRow 只认行 + archived 标志', () => {
  const a = auditExportRow({ id: 1, action: 'x', detail: 'y', created_at: d('2026-09-01T00:00:00Z') }, 1);
  assert.equal(a.type, 'audit');
  assert.equal(a.archived, 1);
  assert.equal(a.at, '2026-09-01T00:00:00Z');
  assert.equal('archived_at' in a, false, '主表行没有 archived_at 就不写这个键');
  const e = eventExportRow({ id: 2, type: 'done', payload: '不是 JSON', created_at: '2026-09-01 00:00:00' }, 0);
  assert.equal(e.payload, '不是 JSON', '坏 JSON 原样带走，不丢账（账本导出不许因为一行脏数据整份失败）');
  assert.equal(e.at, '2026-09-01T00:00:00', '驱动给字符串时间戳时也要转成 ISO 形状（T 分隔），别把库的原地格式漏出去');
});

// ---------------- ② archived 口径（与 /api/audit 同款） ----------------
test('archived 口径与 /api/audit 一致：current=主表 / archive=归档表 / all=两表合并且逐行标注', async () => {
  const dbc = () => fakeDb(seed());
  const cur = await fetchLedgerRows('audit', { dbc: dbc(), archived: 'current' });
  assert.deepEqual(cur.map((r) => r.row.id), [11, 12, 13]);
  assert.equal(cur.every((r) => r.archived === 0), true);
  assert.equal(cur.every((r) => r.table === 'audit_log'), true);
  const arc = await fetchLedgerRows('audit', { dbc: dbc(), archived: 'archive' });
  assert.deepEqual(arc.map((r) => r.row.id), [1]);
  assert.equal(arc[0].archived, 1);
  assert.equal(arc[0].table, 'audit_log_archive');
  const all = await fetchLedgerRows('audit', { dbc: dbc(), archived: 'all' });
  // 顺序＝先主表后归档表（各自按 id 升序）——与 /api/audit?archived=all 的"两表取回再合并"同款；
  // 两边 id 各自自增，所以这里不断言"全局有序"（真库上同样做不到）
  assert.deepEqual(all.map((r) => r.row.id), [11, 12, 13, 1], 'all＝两表都取回');
  // 归档行进 JSONL 要带 archived_at（"什么时候被搬走的"是归档账的一部分）
  const archRow = all.find((r) => r.archived === 1);
  const j = JSON.parse(toJsonl({ ledger: 'audit', ...archRow }));
  assert.equal(j.id, 1);
  assert.equal(j.archived, 1);
  assert.equal(j.archived_at, '2026-08-01T00:00:00Z');
  // events 的归档表同样并入
  const evAll = await fetchLedgerRows('events', { dbc: dbc(), archived: 'all' });
  assert.deepEqual(evAll.map((r) => r.row.id), [101, 102, 103, 50]);
  // 不认识的账本名：显式报错（不静默返回空）
  await assert.rejects(() => fetchLedgerRows('nope', { dbc: dbc() }), /未知账本/);
});

// ---------------- ③ 过滤参数 ----------------
test('过滤参数：--since/--until/--conversation 三个都落到 SQL 条件上，且逐层生效', async () => {
  const dbc = fakeDb(seed());
  // 时间参数一律用**带 Z / 带时分秒**的字面量：库把裸日期串按库会话时区解释，夹具这边按 UTC 比较，
  // 裸 `2026-09-02` 会让"边界包不包含"随机器时区变（Asia/Shanghai 下 9-03 的行会被判进窗口）——测的是过滤逻辑，不是时区。
  const rows = await exportLedgerRows({ dbc, since: '2026-09-02T00:00:00Z', until: '2026-09-02T23:59:59Z', conversation: 7 });
  // 条件真的进了 SQL（不是我在这边内存里筛的）——先验这条：假库的过滤实现就在同样的语句上
  const auditSql = dbc.calls.find((c) => /FROM audit_log /.test(c.sql));
  assert.match(auditSql.sql, /WHERE created_at >= \? AND created_at <= \? AND conversation_id = \?/);
  assert.deepEqual(auditSql.params, ['2026-09-02T00:00:00Z', '2026-09-02T23:59:59Z', 7], '参数顺序照条件顺序，别串位');
  // 审计：只剩 9-02 那条（且会话=7）；事件：只剩 9-02 那两条
  assert.deepEqual(rows.filter((r) => r.ledger === 'audit').map((r) => r.row.id), [12]);
  assert.deepEqual(rows.filter((r) => r.ledger === 'events').map((r) => r.row.id), [101, 102]);
  assert.equal(dbc.calls.filter((c) => /WHERE/.test(c.sql)).length, 2, '两本账各自都要带上条件（漏一本就是全量导出）');
  // 单条件时的形状（不传就是不限）
  assert.equal(ledgerConds({}).where, '');
  assert.deepEqual(ledgerConds({}).params, []);
  assert.equal(ledgerConds({ since: '2026-09-02' }).where, ' WHERE created_at >= ?');
  assert.deepEqual(ledgerConds({ conversation: '432' }).params, [432], '会话 id 归一成数字（与列类型一致）');
  assert.deepEqual(ledgerConds({ conversation: 0 }).params, [0], '0 是合法会话 id，不能被当成"不限"');
  assert.deepEqual(ledgerConds({ conversation: '' }).params, [], '空串＝不限');
  // 只导一本账（--ledger audit）
  const only = await exportLedgerRows({ dbc: fakeDb(seed()), ledgers: ['audit'] });
  assert.equal(only.every((r) => r.ledger === 'audit'), true);
  assert.equal(only.length, 3);
  // 命中 0 行也是成功（客户机上"这段时间没账"必须能出空文件，而不是报错）
  const none = await exportLedgerRows({ dbc: fakeDb(seed()), conversation: 999 });
  assert.deepEqual(none, []);
});

// ---------------- ④ 落盘 ----------------
test('落盘是 JSONL：行数=条数、每行独立可解析、父目录自动建、默认落点在 tmp/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-ledger-'));
  try {
    const rows = await exportLedgerRows({ dbc: fakeDb(seed()), archived: 'all' });
    const out = path.join(dir, 'sub', 'ledger.jsonl'); // 父目录不存在也要能建
    const p = writeLedgerJsonl(rows, out);
    assert.equal(p, path.resolve(out));
    const text = fs.readFileSync(p, 'utf8');
    assert.equal(text.endsWith('\n'), true, 'JSONL 每行一条、末尾换行（cat/grep/流式读都靠它）');
    const ls = text.trim().split('\n');
    assert.equal(ls.length, rows.length);
    for (const l of ls) assert.equal(typeof JSON.parse(l), 'object', '每行必须是独立可解析的 JSON 对象');
    assert.equal(ls.every((l) => !l.includes('\n')), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const dp = defaultLedgerPath(new Date('2026-09-16T01:02:03Z'));
  assert.equal(path.basename(dp), 'ledger-20260916T010203Z.jsonl');
  assert.equal(path.dirname(dp), path.join(REPO_ROOT, 'tmp'), '默认落在 tmp/ 下（已 gitignore，不弄脏工作区）');
});

// ---------------- ⑤ 只读与不加端点 ----------------
test('本脚本只读：源码里不得出现任何写库语句，也不新增 HTTP 端点', () => {
  const src = fs.readFileSync(new URL('../scripts/ledger-export.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').map((l) => l.split('//')[0]).join('\n');
  for (const w of ['INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ']) {
    assert.equal(code.toUpperCase().includes(w), false, '导出是只读动作，不许出现 ' + w);
  }
  assert.ok(!/app\.(get|post|put|delete)\(/.test(code), '导出走 CLI：不给线上多开一个读库端点（端点在 server/index.js，归别的改动）');
});
