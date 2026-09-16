// test/storage.test.mjs - 存储接口契约一致性（v0.3 §7.1 ⑦「存储抽象」/ §4.1「存储走接口」）
//
// 为什么这么测（判据先定，再写用例）：
//   ⑦ 的价值全在"**换实现不改调用方**"这一件事上，所以判据不能是"某个实现能跑通"，而是：
//     ① **两个实现跑同一组用例**（方法面一致 → 增删查改行为一致 → 事务语义一致 → 并发写不丢）；
//     ② **端到端**：一轮对话（真调用方模块 `deliveries.js`/`eventlog.js` × 注入的实现）跑通 ——
//        2026-09-16 的真实故障就在这个组合上（带 Idempotency-Key 的一轮在 jsonfile 下 500）；
//     ③ **能力缺失时如实抛错**：契约里的实体两个实现都必须服务（漏一个方法，方法面用例当场判红）；
//        实在没有的能力（原生动词 / 走它的归档）必须报"该实现不支持"，不许返回空结果糊过去；
//     ④ 迁移示范真的断了 `db` 直连（源码级：`deliveries.js`/`eventlog.js` 不再 import db）；
//     ⑤ 选择点唯一（全仓只有 storage/index.js 读 RW_STORAGE）。
//   ⑤ 是本条与"再加一层包装"的区别：只要有人绕过选择点自己 new 一个实现，"可替换"就名存实亡。
//
// 为什么不连真库（交付口径明确要求）：
//   MySQL 侧注入**假 pool/db**（只认这份实现发出的那几种语句形状 —— 实现改了形状，假 pool 会当场抛，
//   逼着来改夹具，而不是悄悄放宽）；JSON 侧用临时目录里的**真文件**（真行为都在这边验）。
//   MySQL 的**真实语义**由既有夹具在真库上盖住（`test/deliveries.test.mjs`、`test/eventlog-archive.test.mjs`），
//   本夹具不重复造一个"迷你 MySQL"去假装验过它。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT, contractMethods, createStorage, FIELDS, STORAGE_INVALID_FIELD, STORAGE_UNSUPPORTED } from '../server/storage/index.js';
import { createJsonFileStorage } from '../server/storage/jsonfile.js';
import { createMysqlStorage } from '../server/storage/mysql.js';
import { beginDelivery, finishDelivery, listDeliveries, requestHash } from '../server/deliveries.js';
import { persistEvent, readEvents, archiveOldEvents } from '../server/eventlog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-store-test-'));
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
const tmpFile = (tag) => path.join(TMP, tag + '-' + Math.random().toString(36).slice(2) + '.json');

// ── 假 pool / 假 db（MySQL 侧）────────────────────────────────────────────────────────────
// 它只做两件事：把本实现发出的语句**按形状**执行掉、把语句与事务动作按顺序记下来。
// 不认识任何一条语句就抛 —— 夹具比实现宽松＝这条用例白写。
function fakeMysql() {
  const state = {
    tables: new Map(),      // 表名 -> Map(主键 -> 行)
    counters: new Map(),    // AUTO_INCREMENT
  };
  const calls = [];
  const rowsOf = (s, t) => { if (!s.tables.has(t)) s.tables.set(t, new Map()); return s.tables.get(t); };
  const cloneState = (s) => ({
    tables: new Map([...s.tables].map(([t, rows]) => [t, new Map([...rows].map(([id, row]) => [id, { ...row }]))])),
    counters: new Map(s.counters),
  });
  // 按顶层逗号切：`COALESCE(?, request_hash)` 里的逗号不算
  const splitTop = (str) => {
    const out = []; let depth = 0; let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim());
  };
  const whereOf = (raw, params) => {
    const t = String(raw).trim();
    // 特例①：会话列表的"我的 ∪ 渠道侧无主会话"（`server/index.js:321` 那条条件，逐字）
    if (/^account_id=\? OR \(channel != "web" AND account_id IS NULL\)$/i.test(t)) {
      const acc = params.shift();
      return (row) => (row.account_id ?? null) === (acc ?? null)
        || (row.channel !== null && row.channel !== undefined && String(row.channel).toLowerCase() !== 'web' && (row.account_id ?? null) === null);
    }
    // 特例②：知识库的"会话可见范围"那一段（`server/knowledge.js` 的 `kbVisibleWhere({includeConv:true})`
    // **逐字**生成的形状）：账号 + (global ∪ 本壳 shell ∪ 本会话 conv) + 仅 active。
    // 为什么必须按整段认：它是 `kb_del` 的安全判据，拆成若干条通用条件去糊＝把"这条 SQL 到底怎么判"
    // 从夹具里抹掉，那正是这段代码最需要被钉住的地方。参数顺序＝account_id, shell_id, conversation_id。
    if (/^account_id=\? AND \(scope="global" OR \(scope="shell" AND shell_id<=>\?\)( OR \(scope="conv" AND conversation_id=\?\))?\)( AND status="active")?$/i.test(t)) {
      const acc = params.shift();
      const shell = params.shift();
      const conv = params.length ? params.shift() : undefined;
      const needActive = /status="active"/i.test(t);
      return (row) => (row.account_id ?? null) === (acc ?? null)
        && (!needActive || row.status === 'active')
        && (row.scope === 'global'
          || (row.scope === 'shell' && (row.shell_id ?? null) === (shell ?? null))
          || (conv !== undefined && row.scope === 'conv' && (row.conversation_id ?? null) === (conv ?? null)));
    }
    // 其余条件用 ` AND ` 连起来；每个条件消费 0/1/N 个参数，顺序即参数顺序
    const conds = t.split(/\s+AND\s+/i).map((c) => {
      const s = c.trim();
      let m;
      if ((m = /^(\w+)\s+IN\s+\(([?\s,]+)\)$/i.exec(s))) {
        const n = (m[2].match(/\?/g) || []).length;
        return { col: m[1], in: Array.from({ length: n }, () => params.shift()) };
      }
      if ((m = /^(\w+)\s*(<=>|=|>)\s*NOW\(\)$/i.exec(s))) return { col: m[1], op: m[2], now: true };
      if ((m = /^(\w+)\s*(<=>|=|>)\s*\?$/.exec(s))) return { col: m[1], op: m[2], val: params.shift() };
      throw new Error('假 pool 不认识的 WHERE 条件：' + s);
    });
    return (row) => conds.every((c) => {
      const v = row[c.col] === undefined ? null : row[c.col];
      if (c.in) return c.in.includes(v);
      if (c.now) return new Date(v).getTime() > Date.now();      // 会话到期判据就在 SQL 里（`expires_at > NOW()`）
      if (c.op === '<=>') return v === (c.val === undefined ? null : c.val);   // NULL 安全等（deliveries 的幂等键靠它）
      if (c.op === '>') return Number(v) > Number(c.val);
      // 字符串比较照 MySQL 的默认排序规则（utf8mb4 不区分大小写）：假库若按 === 比，
      // "大小写不同的用户名也要能查到"这条用例在 mysql 侧就成了假红（而真库是能查到的）
      if (typeof v === 'string' && typeof c.val === 'string') return v.toLowerCase() === c.val.toLowerCase();
      return v === c.val;
    });
  };

  function exec(store, sql, params) {
    const p = [...(params || [])];
    const q = String(sql).trim();
    let m;
    let mm;   // 各分支共用的"局部再匹配"变量（在 INSERT 的 VALUES 解析里也要用）
    if ((m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \((.*?)\)(?: ON DUPLICATE KEY UPDATE (.+))?$/i.exec(q))) {
      const [, table, colsRaw, valsRaw, dupRaw] = m;
      const cols = colsRaw.split(',').map((c) => c.trim());
      const vals = splitTop(valsRaw).map((v) => {
        if (v === '?') return p.shift();
        if (/^NOW\(\)$/i.test(v)) return new Date();
        // 会话到期：`DATE_ADD(NOW(), INTERVAL ? DAY)`（照 `server/auth.js:29` 那条语句）
        if ((mm = /^DATE_ADD\(NOW\(\),\s*INTERVAL\s+\?\s+DAY\)$/i.exec(v))) return new Date(Date.now() + Number(p.shift()) * 86400000);
        throw new Error('假 pool 不认识的 VALUES 项：' + v);
      });
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      // 唯一键 uk_deliveries_idem (account_id, idem_key)：真库会拒，假库照拒（幂等键为 NULL 时不受约束，
      // MySQL 的唯一索引不对 NULL 去重）—— 少了这条，"并发重发只进一个"在两个实现下就不是同一件事
      if (table === 'deliveries' && row.idem_key !== null && [...rowsOf(store, table).values()]
        .some((r) => (r.account_id ?? null) === (row.account_id ?? null) && r.idem_key === row.idem_key)) {
        const e = new Error(`Duplicate entry '${row.idem_key}' for key 'uk_deliveries_idem'`);
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      // accounts.username 也是唯一键（`server/db.js` 建表里那句 `username VARCHAR(64) UNIQUE`）
      if (table === 'accounts' && [...rowsOf(store, table).values()].some((r) => String(r.username).toLowerCase() === String(row.username).toLowerCase())) {
        const e = new Error(`Duplicate entry '${row.username}' for key 'username'`);
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      // 真库的 `DEFAULT NOW()`：假库照做，否则 toRecord 的 created_at/updated_at 映射没人验
      if (!('created_at' in row)) row.created_at = new Date();
      if (!('updated_at' in row)) row.updated_at = new Date();
      // 主键是字符串的表：settings(skey) / sessions(token)；其余是自增 id
      const keyedCol = { settings: 'skey', sessions: 'token' }[table] || null;
      const key = keyedCol ? row[keyedCol] : (store.counters.set(table, (store.counters.get(table) || 0) + 1), store.counters.get(table));
      const rows = rowsOf(store, table);
      if (keyedCol && rows.has(key)) {
        if (!dupRaw) {   // 主键冲突（sessions.token）：真库抛 ER_DUP_ENTRY，假库照抛
          const e = new Error(`Duplicate entry '${key}' for key 'PRIMARY'`);
          e.code = 'ER_DUP_ENTRY';
          throw e;
        }
        const cur = rows.get(key);
        for (const item of splitTop(dupRaw)) {
          const mm2 = /^(\w+)\s*=\s*(?:VALUES\((\w+)\)|NOW\(\))$/i.exec(item);
          if (!mm2) throw new Error('假 pool 不认识的 ON DUPLICATE 项：' + item);
          cur[mm2[1]] = mm2[2] ? row[mm2[2]] : new Date();
        }
        return { insertId: 0, affectedRows: 2 };
      }
      if (!keyedCol) row.id = key;
      rows.set(key, row);
      return { insertId: keyedCol ? 0 : key, affectedRows: 1 };
    }

    // 会话校验（`server/auth.js:38` 那条 JOIN + 到期判据）：JOIN 与 `expires_at > NOW()` 是语句形状的一部分，
    // 所以这里按形状分派（本仓既有做法），而不是把 JOIN 拆成两次查询 —— 拆了就不是同一条语义了
    if ((m = /^SELECT a\.id, a\.username, a\.role FROM sessions s JOIN accounts a ON a\.id=s\.account_id WHERE s\.token=\? AND s\.expires_at > NOW\(\) LIMIT 1$/i.exec(q))) {
      const token = p.shift();
      const sess = [...rowsOf(store, 'sessions').values()].find((s) => s.token === token && new Date(s.expires_at).getTime() > Date.now());
      if (!sess) return [];
      // 账号表的 Map 键是自增数字，而 account_id 从会话里取出来可能是字符串 ⇒ 两边都按字符串比
      const acc = [...rowsOf(store, 'accounts').values()].find((a) => String(a.id) === String(sess.account_id)) || null;
      return acc ? [{ id: acc.id, username: acc.username, role: acc.role }] : [];
    }

    // DELETE：一条或两条等值条件（原来只认一条——`server/auth.js:45` 的退出登录；
    // 2026-09-17 起 knowledge.remove 发的是 `id=? AND account_id=?`，两条都要认）。
    if ((m = /^DELETE FROM (\w+) WHERE (\w+)=\?(?: AND (\w+)=\?)?$/i.exec(q))) {
      const rows = rowsOf(store, m[1]);
      let removed = 0;
      for (const [k, row] of [...rows]) {
        if (row[m[2]] !== p[0]) continue;
        if (m[3] !== undefined && row[m[3]] !== p[1]) continue;
        rows.delete(k); removed++;
      }
      return { insertId: 0, affectedRows: removed };
    }

    // 知识管理视图的展示列（`knowledge.adminList`）：LEFT JOIN shells 拿 shell_key + LEFT(body,200) 截预览。
    // 按**整段形状**认（与上面那条 kbVisibleWhere 同一个理由）：这几个列名是前端在读的对外形状，
    // 拆成通用条件去糊，等于把"前端读什么"这件事从夹具里抹掉。
    if (/^SELECT k\.id, k\.scope, k\.shell_id, s\.skey AS shell_key, k\.conversation_id, k\.kind, k\.status, k\.related_component, k\.title, LEFT\(k\.body, 200\) AS body_preview, k\.created_at\s+FROM knowledge k LEFT JOIN shells s ON s\.id = k\.shell_id\s+WHERE (.+?) ORDER BY k\.id DESC(?: LIMIT (\d+))?$/i.test(q)) {
      const mm = /^SELECT [\s\S]*?WHERE (.+?) ORDER BY k\.id DESC(?: LIMIT (\d+))?$/i.exec(q);
      let where = mm[1]; const limit = mm[2] ? Number(mm[2]) : null;
      const conds = where.split(/\s+AND\s+/i).map((c) => c.trim());
      const filters = conds.filter((c) => !/^k\.id IN \(/i.test(c)).map((c) => {
        const m2 = /^k\.(\w+)\s*(<=>|=)\s*\?$/i.exec(c);
        if (!m2) throw new Error('假 pool 不认识的管理面条件：' + c);
        const val = p.shift();
        return { col: m2[1], op: m2[2], val };
      });
      let rows = [...rowsOf(store, 'knowledge').values()];
      for (const f of filters) {
        rows = rows.filter((row) => (f.op === '<=>' ? (row[f.col] ?? null) === (f.val ?? null) : row[f.col] === f.val));
      }
      // `k.id IN (?,?,…)`：按出现顺序消费剩下的参数（上面那些等值条件已各自 shift 过）
      const inClause = conds.find((c) => /^k\.id IN \(/i.test(c));
      if (inClause) {
        const n = (inClause.match(/\?/g) || []).length;
        const ids = Array.from({ length: n }, () => Number(p.shift()));
        rows = rows.filter((row) => ids.includes(Number(row.id)));
      }
      rows.sort((a, b) => Number(b.id) - Number(a.id));
      if (limit) rows = rows.slice(0, limit);
      // left join shells：假库里没有 shells 表 ⇒ shell_key 恒 null（与 JSON 介质同一事实）
      return rows.map((k) => ({
        id: k.id, scope: k.scope, shell_id: k.shell_id ?? null, shell_key: null,
        conversation_id: k.conversation_id ?? null, kind: k.kind ?? null, status: k.status ?? null,
        related_component: k.related_component ?? null, title: k.title ?? null,
        body_preview: String(k.body ?? '').slice(0, 200), created_at: k.created_at ?? null,
      }));
    }

    // 审计的 GROUP BY 计数（`audit.countByAction`，C4/C5 仪表用）：按**整段形状**认（前面的理由同）。
    if ((m = /^SELECT action, COUNT\(\*\) n FROM audit_log WHERE action IN \(([?\s,]+)\) GROUP BY action$/i.exec(q))) {
      const n = (m[1].match(/\?/g) || []).length;
      const want = new Set(Array.from({ length: n }, () => p.shift()));
      const counts = new Map();
      for (const row of rowsOf(store, 'audit_log').values()) {
        if (!want.has(row.action)) continue;
        counts.set(row.action, (counts.get(row.action) || 0) + 1);
      }
      return [...counts.entries()].map(([action, c]) => ({ action, n: c }));
    }

    // 审计的"首词分布"（`audit.countByFirstToken`，C5 豁免原因）：SUBSTRING_INDEX 的形状按整段认。
    if ((m = /^SELECT SUBSTRING_INDEX\(detail, ' ', 1\) r, COUNT\(\*\) n FROM audit_log WHERE action=\? GROUP BY r ORDER BY n DESC$/i.exec(q))) {
      const action = p.shift();
      const counts = new Map();
      for (const row of rowsOf(store, 'audit_log').values()) {
        if (row.action !== action) continue;
        const w = String(row.detail ?? '').split(' ')[0] || '?';
        counts.set(w, (counts.get(w) || 0) + 1);
      }
      return [...counts.entries()].map(([r, n]) => ({ r, n })).sort((a, b) => b.n - a.n);
    }

    // `/trace` 的三条读法（2026-09-17）：审计的 OR-LIKE 形状 + 用量聚合的形状，按整段认。
    if ((m = /^SELECT id, action, detail, shell_id, created_at FROM audit_log WHERE conversation_id=\? OR detail LIKE \? ORDER BY id DESC LIMIT (\d+)$/i.exec(q))) {
      const cid = Number(p.shift()); const like = String(p.shift()); const lim = Number(m[1]);
      const needle = like.replace(/%/g, '');
      return [...rowsOf(store, 'audit_log').values()]
        .filter((r) => Number(r.conversation_id) === cid || String(r.detail ?? '').includes(needle))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, lim)
        .map((r) => ({ id: r.id, action: r.action, detail: r.detail ?? null, shell_id: r.shell_id ?? null, created_at: r.created_at ?? null }));
    }
    if ((m = /^SELECT COUNT\(\*\) n, COALESCE\(SUM\(cost\),0\) cost, COALESCE\(SUM\(tokens_in\),0\) tin, COALESCE\(SUM\(tokens_out\),0\) tout FROM usage_stats WHERE conversation_id=\?$/i.exec(q))) {
      const cid = Number(p.shift());
      const rows = [...rowsOf(store, 'usage_stats').values()].filter((r) => Number(r.conversation_id) === cid);
      const sum = (k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
      return [{ n: rows.length, cost: sum('cost'), tin: sum('tokens_in'), tout: sum('tokens_out') }];
    }

    if ((m = /^SELECT COALESCE\(SUM\(cost\),0\) total, COUNT\(DISTINCT agent_run_id\) runs, COUNT\(DISTINCT conversation_id\) convs FROM usage_stats WHERE account_id=\?$/i.exec(q))) {
      const acc = Number(p.shift());
      const rows = [...rowsOf(store, 'usage_stats').values()].filter((r) => Number(r.account_id) === acc);
      const uniq = (k) => new Set(rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined)).size;
      return [{ total: rows.reduce((a, r) => a + Number(r.cost || 0), 0), runs: uniq('agent_run_id'), convs: uniq('conversation_id') }];
    }

    // `/api/audit` 活表分支（`audit.adminList`）：条件串由调用方拼（`1=1` 起头），按整段认
    if (/^SELECT id, account_id, action, detail, conversation_id, shell_id, created_at FROM audit_log WHERE (.+?) ORDER BY id DESC LIMIT \?$/i.test(q)) {
      const where = /WHERE (.+?) ORDER BY id DESC LIMIT \?$/i.exec(q)[1];
      const lim = Number(p.pop());
      const conds = where.split(/\s+AND\s+/i).map((c) => c.trim()).filter((c) => c !== '1=1');
      let rows = [...rowsOf(store, 'audit_log').values()];
      for (const c of conds) {
        let m2;
        if ((m2 = /^\(action LIKE \? OR detail LIKE \?\)$/i.exec(c))) {
          const a = String(p.shift() || '').replace(/%/g, ''); const b = String(p.shift() || '').replace(/%/g, '');
          rows = rows.filter((r) => String(r.action || '').includes(a) || String(r.detail || '').includes(b));
        } else if ((m2 = /^created_at > NOW\(\) - INTERVAL \? DAY$/i.exec(c))) {
          const days = Number(p.shift()) || 0; const floor = Date.now() - days * 86400000;
          rows = rows.filter((r) => new Date(r.created_at || 0).getTime() > floor);
        } else if ((m2 = /^action IN \(([?\s,]+)\)$/i.exec(c))) {
          const k = (m2[1].match(/\?/g) || []).length;
          const want = new Set(Array.from({ length: k }, () => String(p.shift())));
          rows = rows.filter((r) => want.has(String(r.action)));
        } else if ((m2 = /^(\w+)=\?$/.exec(c))) {
          const col = m2[1]; const val = p.shift();
          rows = rows.filter((r) => Number(r[col]) === Number(val));
        } else throw new Error('假 pool 不认识的审计条件：' + c);
      }
      return rows.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, lim)
        .map((r) => ({ id: r.id, account_id: r.account_id ?? null, action: r.action ?? null, detail: r.detail ?? null, conversation_id: r.conversation_id ?? null, shell_id: r.shell_id ?? null, created_at: r.created_at ?? null }));
    }

    // 裁定 A 的两次读法：某动作前缀涉及过哪些会话（DISTINCT + IS NOT NULL），按整段认
    if ((m = /^SELECT DISTINCT conversation_id cid FROM audit_log WHERE action LIKE \? AND conversation_id IS NOT NULL$/i.exec(q))) {
      const pfx = String(p.shift()).replace(/%$/, '');
      const out = new Set();
      for (const r of rowsOf(store, 'audit_log').values()) {
        if (!String(r.action || '').startsWith(pfx)) continue;
        if (r.conversation_id === null || r.conversation_id === undefined) continue;
        out.add(Number(r.conversation_id));
      }
      return [...out].map((cid) => ({ cid }));
    }
    // 逐轮读数（C1/C2 来源；裁定 A 的第二次读法）：account + kind='round' + 窗口 + 可选 IN (…)
    if (/^SELECT u\.cache_hit_tokens h, u\.cache_miss_tokens m, u\.conversation_id cid\s+FROM usage_stats u\s+WHERE u\.account_id=\? AND u\.kind='round' AND u\.created_at >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)(?: AND u\.conversation_id IN \(([?\s,]+)\))?$/i.test(q)) {
      const acc = Number(p.shift()); const days = Number(p.shift());
      const inRaw = /IN \(([?\s,]+)\)/i.exec(q);
      const ids = inRaw ? new Set(Array.from({ length: (inRaw[1].match(/\?/g) || []).length }, () => Number(p.shift()))) : null;
      const floor = Date.now() - days * 86400000;
      return [...rowsOf(store, 'usage_stats').values()]
        .filter((r) => Number(r.account_id) === acc && r.kind === 'round' && new Date(r.created_at || 0).getTime() >= floor)
        .filter((r) => !ids || ids.has(Number(r.conversation_id)))
        .map((r) => ({ h: Number(r.cache_hit_tokens || 0), m: Number(r.cache_miss_tokens || 0), cid: r.conversation_id ?? null }));
    }

    // 按天读数（仪表 30 天线）：`GROUP BY DATE(created_at)` 的形状，按整段认
    if (/^SELECT DATE_FORMAT\(created_at, '%Y-%m-%d'\) d, COALESCE\(SUM\(cache_hit_tokens\),0\) hit, COALESCE\(SUM\(cache_miss_tokens\),0\) miss, COUNT\(\*\) n\s+FROM usage_stats u WHERE u\.account_id=\? AND u\.kind='round' AND u\.created_at >= DATE_SUB\(NOW\(\), INTERVAL \? DAY\)\s+GROUP BY DATE_FORMAT\(created_at, '%Y-%m-%d'\) ORDER BY d$/i.test(q)) {
      const acc = Number(p.shift());
      const byDay = new Map();
      for (const r of rowsOf(store, 'usage_stats').values()) {
        if (Number(r.account_id) !== acc || r.kind !== 'round') continue;
        const at = r.created_at instanceof Date ? r.created_at : new Date(r.created_at || 0);
        const d = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0');
        const cur = byDay.get(d) || { d, hit: 0, miss: 0, n: 0 };
        cur.hit += Number(r.cache_hit_tokens || 0);
        cur.miss += Number(r.cache_miss_tokens || 0);
        cur.n += 1;
        byDay.set(d, cur);
      }
      return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
    }

    // DELETE + 组合条件（`knowledge.removeVisible`：id + 由 kbVisibleWhere 生成的可见范围段）
    if ((m = /^DELETE FROM (\w+) WHERE (\w+)=\? AND (.+)$/i.exec(q))) {
      const rows = rowsOf(store, m[1]);
      const id = p.shift();
      const keep = whereOf(m[3], p);
      let removed = 0;
      for (const [k, row] of [...rows]) if (row[m[2]] === id && keep(row)) { rows.delete(k); removed++; }
      return { insertId: 0, affectedRows: removed };
    }

    if ((m = /^SELECT (.+?) FROM (\w+)\b(.*)$/i.exec(q))) {
      const [, colsRaw, table] = m;
      let rest = m[3];
      let limit = null; let desc = false; let orderCol = 'id'; let whereRaw = null;
      if ((mm = /\s+LIMIT (\d+)\s*$/i.exec(rest))) { limit = Number(mm[1]); rest = rest.slice(0, mm.index); }
      // `ORDER BY` 两种方向都要认：`ASC` 此前没人发过，`knowledge.all` 是第一条（2026-09-17 加写口时补上）
      if ((mm = /\s+ORDER BY (\w+)( DESC| ASC)?\s*$/i.exec(rest))) { orderCol = mm[1]; desc = String(mm[2] || '').trim().toUpperCase() === 'DESC'; rest = rest.slice(0, mm.index); }
      if ((mm = /^\s+WHERE (.+)$/i.exec(rest))) whereRaw = mm[1];
      else if (rest.trim()) throw new Error('假 pool 不认识的 SELECT 尾巴：' + rest);
      let rows = [...rowsOf(store, table).values()];
      if (whereRaw) { const f = whereOf(whereRaw, p); rows = rows.filter(f); }
      // COUNT(*) 是聚合：先筛再数（`ORDER BY`/`LIMIT` 在这两条语句里都没有）
      const cm = /^COUNT\(\*\)\s+(\w+)$/i.exec(colsRaw.trim());
      if (cm) return [{ [cm[1]]: rows.length }];
      rows.sort((a, b) => (desc ? Number(b[orderCol]) - Number(a[orderCol]) : Number(a[orderCol]) - Number(b[orderCol])));
      if (limit !== null) rows = rows.slice(0, limit);
      const cols = colsRaw.trim() === '*' ? null : colsRaw.split(',').map((c) => c.trim());
      return cols ? rows.map((row) => Object.fromEntries(cols.map((c) => [c, row[c]]))) : rows.map((row) => ({ ...row }));
    }

    if ((m = /^UPDATE (\w+) SET (.*?) WHERE (.*)$/i.exec(q))) {
      const [, table, setRaw, whereRaw] = m;
      // 参数顺序＝语句里的出现顺序：SET 的 `?` 在 WHERE 之前，所以先取 SET 的参数再解析 WHERE
      const assigned = [];
      for (const item of splitTop(setRaw)) {
        if ((mm = /^(\w+)=\?$/.exec(item))) assigned.push({ col: mm[1], val: p.shift() });
        else if ((mm = /^(\w+)=NOW\(\)$/i.exec(item))) assigned.push({ col: mm[1], val: new Date() });
        else if ((mm = /^(\w+)=\1\+1$/.exec(item))) assigned.push({ col: mm[1], inc: true });
        else if ((mm = /^(\w+)=COALESCE\(\?,\s*(\w+)\)$/i.exec(item))) assigned.push({ col: mm[1], val: p.shift(), keep: mm[2] });
        else throw new Error('假 pool 不认识的 SET 项：' + item);
      }
      const rows = [...rowsOf(store, table).values()].filter(whereOf(whereRaw, p));
      for (const row of rows) {
        for (const a of assigned) {
          if (a.inc) row[a.col] = Number(row[a.col] || 0) + 1;
          else if (a.keep && a.val === null) { /* COALESCE(?, col)：NULL 就保留原值（不覆盖） */ }
          else row[a.col] = a.val;
        }
      }
      return { insertId: 0, affectedRows: rows.length };
    }
    throw new Error('假 pool 不认识的语句：' + q);
  }

  const deps = {
    db: {
      query: async (sql, params) => { calls.push({ sql, params }); return exec(state, sql, params); },
      run: async (sql, params) => { calls.push({ sql, params }); return exec(state, sql, params); },
    },
    pool: {
      getConnection: async () => {
        const draft = cloneState(state);
        return {
          query: async (sql, params) => { calls.push({ sql, params, inTx: true }); return [exec(draft, sql, params), []]; },
          execute: async (sql, params) => { calls.push({ sql, params, inTx: true }); return [exec(draft, sql, params), []]; },
          beginTransaction: async () => { calls.push({ tx: 'BEGIN' }); },
          commit: async () => { calls.push({ tx: 'COMMIT' }); state.tables = draft.tables; state.counters = draft.counters; },
          rollback: async () => { calls.push({ tx: 'ROLLBACK' }); },
          release: () => { calls.push({ tx: 'RELEASE' }); },
        };
      },
    },
  };
  return { deps, calls, state };
}

const makeMysql = () => { const f = fakeMysql(); return { storage: createMysqlStorage(f.deps), probe: f }; };
const makeJsonFile = () => { const file = tmpFile('store'); return { storage: createJsonFileStorage({ file }), probe: { file } }; };

/**
 * 一轮对话在存储面上留下的轨迹 —— **用真的调用方模块**（`deliveries.js` 的幂等门、`eventlog.js` 的账本）。
 * 为什么非要有这一段：契约用例只证明"方法对得上"，而 2026-09-16 的真实故障是**调用方 × 实现**的组合
 * —— 带 `Idempotency-Key` 的 `POST /api/chat` 在 jsonfile 下直接 500（`beginDelivery` 撞上"不支持"）。
 * 顺序照 `server/index.js` 的 `/api/chat`：幂等门 → 落消息/现场 → 记账 → 收尾。
 */
async function oneTurn(store, { accountId = 1, idemKey = 'turn-1', content = '你好' } = {}) {
  const begun = await beginDelivery({ accountId, conversationId: null, idemKey, hash: requestHash({ content }), store });
  const { id: convId } = await store.conversations.create({ accountId, title: '一轮对话' });
  await store.messages.append({ conversationId: convId, role: 'user', content });
  const { id: runId } = await store.agentRuns.create({ conversationId: convId, accountId, goal: content });
  persistEvent(convId, { seq: 1, at: 1, type: 'run_start', provider: 'stub', model: 'stub' }, store);
  await store.toolCalls.append({ conversationId: convId, toolName: 'read_file', args: { p: 'a.txt' }, status: 'done', resultBytes: 5 });
  persistEvent(convId, { seq: 2, at: 2, type: 'tool_done', tool: { name: 'read_file', status: 'done' } }, store);
  const { id: messageId } = await store.messages.append({ conversationId: convId, role: 'assistant', content: '收到' });
  await store.agentRuns.update(runId, { status: 'completed', rounds: 1 });
  persistEvent(convId, { seq: 3, at: 3, type: 'run_end', status: 'done' }, store);
  await finishDelivery(begun.id, { state: 'succeeded', messageId, runId, response: { messageId, runId, content: '收到' }, store });
  // 账本是 fire-and-forget（persistEvent 不返回 promise）：等一拍再回放（本仓既有夹具同款做法）
  await new Promise((r) => setTimeout(r, 30));
  return { conversationId: convId, deliveryId: begun.id, runId, messageId };
}

// ── 共享契约用例（同一份代码，两个实现各跑一遍）────────────────────────────────────────────
function contractSuite(label, make, caps) {
  const T = (n) => `[${label}] ${n}`;

  test(T('方法面与接口契约逐项一致（"换实现不改调用方"的前提）'), () => {
    const { storage: s } = make();
    for (const p of contractMethods()) {
      const [a, b] = p.split('.');
      assert.equal(typeof (b ? (s[a] || {})[b] : s[a]), 'function', `缺方法 ${p}（契约里有、实现里没有）`);
    }
    assert.equal(typeof s.impl, 'string', '两个实现都要自报实现名（排障第一眼）');
    // 契约里每个实体都要有字段清单（写错字段名＝静默丢数据，见下面那条用例）；settings 是键值，不是记录
    for (const entity of Object.keys(CONTRACT.entities)) {
      if (entity === 'settings') continue;
      assert.ok(FIELDS[entity] && FIELDS[entity].length, `契约声明了 ${entity} 却没有字段清单（校验会退化成"什么都不许写"）`);
    }
  });

  test(T('会话：增 → 查 → 改；没改的字段不许被清掉'), async () => {
    const { storage: s } = make();
    const { id } = await s.conversations.create({ accountId: 7, channel: 'web', title: '原题' });
    assert.ok(id > 0, 'create 要回自增主键（调用方下一步就要用它）');
    const rec = await s.conversations.get(id);
    assert.equal(rec.accountId, 7);
    assert.equal(rec.title, '原题');
    assert.notEqual(rec.createdAt, undefined, '介质时间戳要如实回读');
    await s.conversations.update(id, { title: '改名' });
    const after = await s.conversations.get(id);
    assert.equal(after.title, '改名');
    assert.equal(after.accountId, 7, '部分更新不是整行覆盖');
    assert.equal(await s.conversations.get(999999), null, '查不到＝null，不是异常');
  });

  test(T('读出来的是快照：改返回值不许改到库里（两个实现必须一样）'), async () => {
    const { storage: s } = make();
    const { id } = await s.conversations.create({ accountId: 1, title: '原标题' });
    const rec = await s.conversations.get(id);
    rec.title = '被调用方改掉的值';
    assert.equal((await s.conversations.get(id)).title, '原标题', '读出去的对象若与介质内部共享引用，调用方就"改了库但没落盘"');
  });

  test(T('消息：追加 → 按会话升序读回，limit 由调用方给'), async () => {
    const { storage: s } = make();
    await s.messages.append({ conversationId: 1, role: 'user', content: '甲' });
    await s.messages.append({ conversationId: 1, role: 'assistant', content: '乙', tokensOut: 3 });
    await s.messages.append({ conversationId: 2, role: 'user', content: '别的会话' });
    assert.deepEqual((await s.messages.list(1, 10)).map((r) => r.content), ['甲', '乙'], '按写入顺序读回，且只含本会话');
    assert.equal((await s.messages.list(1, 1)).length, 1, 'limit 生效');
    assert.equal((await s.messages.list(1)).length, 2, '不给 limit ＝ 如实全量（接口不替调用方发明默认条数）');
  });

  test(T('工具调用：追加落一行（v0.3 §6.2 的账本口径）'), async () => {
    const { storage: s } = make();
    const { id } = await s.toolCalls.append({ conversationId: 1, toolName: 'read_file', args: { path: 'a' }, status: 'done', resultBytes: 12 });
    assert.ok(id > 0);
  });

  test(T('设置：读不到＝null；写＝覆盖（幂等 upsert）'), async () => {
    const { storage: s } = make();
    assert.equal(await s.settings.get('没见过这个键'), null);
    await s.settings.set('task_budget_total', 100);
    assert.equal(await s.settings.get('task_budget_total'), 100);
    await s.settings.set('task_budget_total', 50);
    assert.equal(await s.settings.get('task_budget_total'), 50, '第二次写是覆盖，不是又插一行');
  });

  test(T('运行现场：建档 → 取最近一条 → 更新状态'), async () => {
    const { storage: s } = make();
    const { id } = await s.agentRuns.create({ conversationId: 5, accountId: 1, goal: '跑一轮' });
    const run = await s.agentRuns.getLatest(5);
    assert.equal(run.id, id);
    assert.equal(run.status, 'running', '新建默认 running（断点恢复要靠它）');
    await s.agentRuns.update(id, { status: 'completed', rounds: 3 });
    const after = await s.agentRuns.getLatest(5);
    assert.equal(after.status, 'completed');
    assert.equal(Number(after.rounds), 3);
    assert.equal(after.goal, '跑一轮', '没改的字段不动');
    assert.equal(await s.agentRuns.getLatest(999), null);
  });

  test(T('事件：追加 → 回放（升序 / afterId 增量 / payload 回读为对象）'), async () => {
    const { storage: s } = make();
    const a = await s.events.append({ conversationId: 3, seq: 1, type: 'run_start', payload: { n: 1 } });
    const b = await s.events.append({ conversationId: 3, seq: 2, type: 'tool_done', payload: { tool: 'x' } });
    await s.events.append({ conversationId: 4, seq: 1, type: 'run_start', payload: {} });
    const all = await s.events.read(3, {});
    assert.deepEqual(all.map((r) => r.type), ['run_start', 'tool_done'], '升序回放，且只含本会话');
    assert.deepEqual(all[1].payload, { tool: 'x' }, 'payload 回读成对象（不是 JSON 字符串）');
    assert.equal(all[0].id, a.id);
    assert.deepEqual((await s.events.read(3, { afterId: a.id, limit: 10 })).map((r) => r.id), [b.id], 'afterId 是增量读的游标');
  });

  // ── 登录链（2026-09-16 扩）：账号 / 会话 —— 没有 MySQL 的机器要能进门，就得先有这两样 ──────────
  test(T('账号：建 → 按用户名查（大小写不敏感，对齐 MySQL 默认排序规则）→ 唯一键冲突 → 查不到＝null'), async () => {
    const { storage: s } = make();
    assert.equal(await s.accounts.findByUsername('查无此人'), null, '查不到＝null，不是异常');
    const { id } = await s.accounts.create({ username: 'Alice', passHash: 'h1' });
    assert.ok(id > 0);
    const a = await s.accounts.findByUsername('Alice');
    assert.equal(a.id, id);
    assert.equal(a.username, 'Alice');
    assert.equal(a.passHash, 'h1', '登录要拿它比对密码（bcrypt 串）');
    assert.equal(a.role, 'user', '不给 role＝默认 user（与建表 DEFAULT 同值，两个实现都一样）');
    const upper = await s.accounts.findByUsername('ALICE');
    assert.ok(upper && upper.id === id, '大小写不同的用户名也要命中（MySQL 的 utf8mb4 默认排序规则不区分大小写）');
    await assert.rejects(() => s.accounts.create({ username: 'alice', passHash: 'h2' }),
      (e) => e.code === 'ER_DUP_ENTRY', 'username 是唯一键：重名必须抛（调用方据此回"用户名已存在"）');
  });

  test(T('会话：建 → 校验（带账号信息）→ 过期即无效 → 退出登录幂等'), async () => {
    const { storage: s } = make();
    const { id: accId } = await s.accounts.create({ username: 'Bob', passHash: 'h', role: 'admin' });
    await s.sessions.create({ token: 'tok-1', accountId: accId, days: 5 });
    const who = await s.sessions.findValid('tok-1');
    assert.deepEqual(who, { id: accId, username: 'Bob', role: 'admin' }, '校验要连账号信息一起取回（requireAuth 就靠它填 req.user）');
    assert.equal(await s.sessions.findValid('不存在的 token'), null, '查不到＝null');
    await assert.rejects(() => s.sessions.create({ token: 'tok-1', accountId: accId, days: 5 }),
      (e) => e.code === 'ER_DUP_ENTRY', 'token 是主键：重复必须抛');

    // 过期：TTL＝0 ⇒ 到期时间就是此刻，`expires_at > NOW()` 不再成立（判据在介质里，不靠调用方比时间）
    await s.sessions.create({ token: 'tok-expired', accountId: accId, days: 0 });
    assert.equal(await s.sessions.findValid('tok-expired'), null, '过期的 token 必须当场失效');

    await s.sessions.remove('tok-1');
    assert.equal(await s.sessions.findValid('tok-1'), null, '退出登录后 token 不再有效');
    await s.sessions.remove('tok-1');   // 幂等：再删一次不许抛
    await s.sessions.remove('从没存在过');
  });

  test(T('会话列表：我的 ∪ 渠道侧无主会话；按账号读会话/改会话不许越界'), async () => {
    const { storage: s } = make();
    const mine = await s.conversations.create({ accountId: 11, title: '我的' });
    const other = await s.conversations.create({ accountId: 22, title: '别人的' });
    const chan = await s.conversations.create({ accountId: null, channel: 'feishu', title: '渠道侧无主' });
    await s.conversations.create({ accountId: null, channel: 'web', title: '无主但不是渠道' });

    const list = await s.conversations.listByAccount(11);
    const ids = list.map((r) => r.id);
    assert.ok(ids.includes(mine.id), '我自己的会话必须在列表里');
    assert.ok(ids.includes(chan.id), '渠道侧无主会话（account_id IS NULL 且 channel != web）也在——那是共享会话');
    assert.equal(ids.includes(other.id), false, '别人的会话不许出现在我的列表里');
    assert.equal(list.length, 2, '`channel="web" AND account_id IS NULL` 那种不该被带出来（MySQL 里 `channel != "web"` 遇 NULL 不成立）');

    assert.ok(await s.conversations.findOwned(mine.id, 11), '按账号取自己的会话：能取到');
    assert.equal(await s.conversations.findOwned(mine.id, 22), null, '换个账号就取不到（会话归属是边界）');
    assert.equal(await s.conversations.findOwned(999999, 11), null, '不存在＝null');

    await s.conversations.updateOwned(other.id, 11, { title: '越界改名' });
    assert.equal((await s.conversations.get(other.id)).title, '别人的', '不许改到别人的会话');
    await s.conversations.updateOwned(mine.id, 11, { title: '改名了', permission: 'read' });
    const after = await s.conversations.get(mine.id);
    assert.equal(after.title, '改名了');
    assert.equal(after.permission, 'read');
    assert.equal(after.accountId, 11, '没改的字段不动');

    const before = (await s.conversations.get(mine.id)).updatedAt;
    await new Promise((r) => setTimeout(r, 5));   // 让时间戳真的前进（同毫秒内比较会骗人）
    await s.conversations.touch(mine.id);
    assert.notEqual((await s.conversations.get(mine.id)).updatedAt, before, 'touch 只推进 updated_at');
  });

  test(T('消息：最近 N 条（倒序、可按角色筛）+ 计数（可按角色）'), async () => {
    const { storage: s } = make();
    for (const [role, content] of [['user', 'u1'], ['assistant', 'a1'], ['user', 'u2'], ['tool', 't1'], ['assistant', 'a2']]) {
      await s.messages.append({ conversationId: 7, role, content });
    }
    await s.messages.append({ conversationId: 8, role: 'user', content: '别的会话' });

    const recent = await s.messages.recent(7, { limit: 3 });
    assert.deepEqual(recent.map((r) => r.content), ['a2', 't1', 'u2'], '最近 3 条、最新在前（与调用点的 ORDER BY id DESC 同向）');
    const clean = await s.messages.recent(7, { limit: 2, roles: ['user', 'assistant'] });
    assert.deepEqual(clean.map((r) => r.content), ['a2', 'u2'], 'roles 过滤：tool 那条不进"干净历史"');
    assert.equal((await s.messages.recent(7, {})).length, 5, '不给 limit＝全量（默认值属于调用方）');
    assert.deepEqual((await s.messages.recent(999, {})), [], '没有消息＝空数组');

    assert.equal(await s.messages.count(7), 5, '整会话条数');
    assert.equal(await s.messages.count(7, { role: 'user' }), 2, '按角色计数（轮次就是这么数的）');
    assert.equal(await s.messages.count(999), 0, '空会话＝0（COUNT 恒有行，不许是 null/undefined）');
  });

  test(T('设置：全量读 + 按键批量读（缺的键不补 null）'), async () => {
    const { storage: s } = make();
    await s.settings.set('guard_a', 1);
    await s.settings.set('guard_b', { nested: true });
    const all = await s.settings.all();
    assert.equal(all.guard_a, 1);
    assert.deepEqual(all.guard_b, { nested: true }, '值按 JSON 解析回来（不是字符串）');
    const many = await s.settings.getMany(['guard_a', '没有这个键']);
    assert.deepEqual(many, { guard_a: 1 }, '只回存在的键（调用方按"没这个键"兜默认值）');
    assert.deepEqual(await s.settings.getMany([]), {}, '空集合不查库，也不许炸');
  });

  // ── 知识库的写口（2026-09-17）：干净机器上"攒记忆"（kb_add 去重/覆盖、kb_del 可见范围删除）────
  test(T('知识：同名去重 → 覆盖（touch 刷新时间戳）→ 只有同一条；body 可为空、身份字段不许从修订改'), async () => {
    const { storage: s } = make();
    const base = { accountId: 1, scope: 'conv', conversationId: 7, shellId: null, kind: 'fact', status: 'active' };
    const add = await s.knowledge.append({ ...base, title: '部署口径', body: '蓝绿部署' });
    assert.ok(add.id > 0, 'append 要回主键（调用方拿它回显/再次定位）');
    assert.equal(await s.knowledge.findByTitle({ accountId: 1, scope: 'conv', conversationId: 7, shellId: null, kind: 'fact', title: '部署口径' }).then((r) => r && r.body), '蓝绿部署');
    // 同名不同会话/不同账号：都**不是**同一条（去重判据的六个条件一个都不能少）
    assert.equal(await s.knowledge.findByTitle({ accountId: 1, scope: 'conv', conversationId: 8, shellId: null, kind: 'fact', title: '部署口径' }), null, '别的会话不算同名');
    assert.equal(await s.knowledge.findByTitle({ accountId: 2, scope: 'conv', conversationId: 7, shellId: null, kind: 'fact', title: '部署口径' }), null, '别的账号不算同名');
    assert.equal(await s.knowledge.findByTitle({ accountId: 1, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '部署口径' }), null, '别的 scope 不算同名');
    // 覆盖：只有一条（不是又插一条），且 touch 刷新时间戳（A6：覆盖视为最新当前事实）
    const before = (await s.knowledge.all(1))[0].createdAt;
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(await s.knowledge.update(add.id, { body: '改成灰度发布', touch: true }), { updated: true });
    const rows = await s.knowledge.all(1);
    assert.equal(rows.length, 1, '覆盖不许变成第二条');
    assert.equal(rows[0].body, '改成灰度发布');
    assert.equal(rows[0].status, 'active');
    assert.ok(new Date(rows[0].createdAt).getTime() > new Date(before).getTime(), 'touch 要把时间戳往前推（两个实现的时钟源各自不同，但语义一致）');
    // 身份字段不许从"修订"这条路改（否则等于换条目、绕过同名判定）
    for (const bad of ['accountId', 'scope', 'conversationId', 'shellId', 'kind', 'titled']) {
      await assert.rejects(() => s.knowledge.update(add.id, { [bad]: 1 }), (e) => e.code === STORAGE_INVALID_FIELD, bad + ' 不该可修订');
    }
    assert.deepEqual(await s.knowledge.update(999999, { body: 'x' }), { updated: false }, '改不存在的行＝false，不是异常');
    // body 可为空（建表里它可空，"标题即全部内容"是合法记忆）
    const bare = await s.knowledge.append({ accountId: 1, scope: 'global', conversationId: null, shellId: null, kind: 'fact', title: '只有标题', body: '', status: 'active' });
    assert.ok(bare.id > 0);
    // 缺必需字段：当场报错，不静默写半条
    await assert.rejects(() => s.knowledge.append({ scope: 'global', title: '没账号' }), (e) => e.code === STORAGE_INVALID_FIELD);
    await assert.rejects(() => s.knowledge.append({ accountId: 1, scope: 'global' }), (e) => e.code === STORAGE_INVALID_FIELD, '缺 title');
  });

  test(T('知识：可见范围删除（global ∪ 本壳 ∪ 本会话、仅 active）与账号边界，两个实现同一条判据'), async () => {
    const { storage: s } = make();
    const mk = (fields) => s.knowledge.append({ kind: 'guide', status: 'active', body: 'b', ...fields });
    const g = await mk({ accountId: 1, scope: 'global', conversationId: null, shellId: null, title: 'g' });
    const mine = await mk({ accountId: 1, scope: 'conv', conversationId: 7, shellId: null, title: 'mine' });
    const otherConv = await mk({ accountId: 1, scope: 'conv', conversationId: 8, shellId: null, title: 'otherConv' });
    const otherShell = await mk({ accountId: 1, scope: 'shell', conversationId: null, shellId: 3, title: 'otherShell' });
    const otherAcc = await mk({ accountId: 2, scope: 'global', conversationId: null, shellId: null, title: 'otherAcc' });
    const dead = await mk({ accountId: 1, scope: 'global', conversationId: null, shellId: null, title: 'dead', status: 'superseded' });
    const vis = (id) => s.knowledge.removeVisible(id, { accountId: 1, shellId: 3, conversationId: 7 });
    assert.deepEqual(await vis(otherAcc.id), { removed: false }, '别人的条目不许删');
    assert.deepEqual(await vis(otherConv.id), { removed: false }, '别的会话私有不许删');
    assert.deepEqual(await vis(dead.id), { removed: false }, '非 active（superseded/obsolete）不在可见范围内，不许删');
    assert.deepEqual(await vis(otherShell.id), { removed: true }, '本壳私有在可见范围内（本例 shellId=3）');
    assert.deepEqual(await vis(mine.id), { removed: true }, '本会话私有可删');
    assert.deepEqual(await vis(g.id), { removed: true }, 'global（同账号）可删');
    assert.equal((await s.knowledge.all(1)).length, 2, '该账号还剩 otherConv + dead 两条');
    // 账号级删除（管理面口径）：只保证不许删到别人的
    assert.deepEqual(await s.knowledge.remove(otherConv.id, { accountId: 9 }), { removed: false });
    assert.deepEqual(await s.knowledge.remove(otherConv.id, { accountId: 1 }), { removed: true });
    assert.deepEqual(await s.knowledge.remove(otherConv.id, { accountId: 1 }), { removed: false }, '删第二次＝false（幂等可判）');
  });

  // ── 用量记账写口（2026-09-17）：v0.3 §4.6「预算与审计：本地兜底」────────────────────────────
  test(T('用量：五处记账共用一条写口（逐轮/折叠/标题/摘要/预热），created_at 由介质盖、kind 必填'), async () => {
    const { storage: s } = make();
    // 逐轮：字段最全的一条（含前缀指纹与壳）
    const round = await s.usage.append({
      accountId: 7, conversationId: 42, agentRunId: 9, providerId: 'deepseek', modelId: 'deepseek-v4-flash',
      tokensIn: 1200, tokensOut: 30, cacheHit: 900, cacheMiss: 300, cost: 0.0042, durationMs: 810,
      shellId: 2, prefixSysHash: 'abcdef012345', prefixToolsHash: 'fedcba543210', kind: 'round',
    });
    assert.ok(round.id > 0, 'append 要回主键：' + JSON.stringify(round));
    // 折叠：**特意不给 durationMs**（迁移前那条直连 SQL 就是"列了 duration_ms 却没给值"⇒ 12 占位符 / 11 实参、
    // mysql2 当场抛、被 catch 吞掉 ⇒ 折叠花费静默丢账）。具名字段下"少给一个字段"＝那一列走默认值，结构上不会错位。
    const collapse = await s.usage.append({
      accountId: 7, conversationId: 42, agentRunId: 9, providerId: 'deepseek', modelId: 'deepseek-v4-flash',
      tokensIn: 800, tokensOut: 260, cacheHit: 0, cacheMiss: 800, cost: 0.0031, shellId: null, kind: 'collapse',
    });
    assert.ok(collapse.id > round.id, '两次记账各占一行（不是覆盖）');
    // 预热：账号/会话/运行都为空（无人会话的维护性花费），只有 provider/model + 指纹 + kind
    const warm = await s.usage.append({ providerId: 'deepseek', modelId: 'deepseek-v4-flash', tokensIn: 40, tokensOut: 2, cacheHit: 40, cacheMiss: 0, cost: 0.0001, prefixSysHash: 'abcdef012345', prefixToolsHash: 'fedcba543210', kind: 'warmup' });
    assert.ok(warm.id > collapse.id);
    // 判据：kind 必填（漏了它这条账会退回默认值 'request'，混进"真实轮次"——C1–C5 的口径全按 kind 过滤）
    await assert.rejects(() => s.usage.append({ conversationId: 42, tokensIn: 1 }), (e) => e.code === STORAGE_INVALID_FIELD, '缺 kind 必须当场拒写');
    // 字段白名单：拼错的字段名不许静默吞掉
    await assert.rejects(() => s.usage.append({ kind: 'round', tokenIn: 1 }), (e) => e.code === STORAGE_INVALID_FIELD, '拼错字段名必须报错');
    // 会话用量合计（`/trace` 的 usage 段）：只有挂了会话的两条算进来（预热那条没有会话归属 ⇒ 不计）
    const sum1 = await s.usage.summaryByConversation(42);
    assert.equal(sum1.calls, 2, '预热那条不带 conversationId ⇒ 不进这个会话的合计：' + JSON.stringify(sum1));
    assert.equal(sum1.tokensIn, 2000);
    assert.equal(sum1.tokensOut, 290);
    assert.ok(Math.abs(sum1.cost - 0.0073) < 1e-9, 'cost = 0.0042 + 0.0031：' + sum1.cost);
    assert.deepEqual(await s.usage.summaryByConversation(999), { calls: 0, cost: 0, tokensIn: 0, tokensOut: 0 }, '空会话＝全 0（不是 null）');
    // 账号口径三件套（C3 仪表）：总花费 + 去重后的执行次数/会话数（agentRunId 相同只算一次）
    const sumA = await s.usage.summaryByAccount(7);
    assert.equal(sumA.runs, 1, '两条 round/collapse 记的是同一个 agentRunId ⇒ 只算 1 次执行：' + JSON.stringify(sumA));
    assert.equal(sumA.convs, 1, '同一个会话');
    assert.ok(Math.abs(sumA.total - 0.0073) < 1e-9, '总花费 = 两条之和：' + sumA.total);
    assert.deepEqual(await s.usage.summaryByAccount(12345), { total: 0, runs: 0, convs: 0 }, '没有记账的账号＝全 0');
  });

  // ── 审计账写口（2026-09-17）：v0.3 §4.6「预算与审计：本地兜底」────────────────────────────
  test(T('审计：两种写口形状（三列 / 五列）都能落，账号可空、action 必填、created_at 由介质盖'), async () => {
    const { storage: s } = make();
    // 三列形状（最常见的形状：账号 + 动作 + 说明）
    const three = await s.audit.append({ accountId: 7, action: 'model:default', detail: 'x=1' });
    assert.ok(three.id > 0, 'append 要回主键：' + JSON.stringify(three));
    // 五列形状（挂会话/壳的那一类：前缀账、工具账、审计面板可归因）
    const five = await s.audit.append({ accountId: 7, action: 'prefix:assemble', detail: 'fp=abc cnt=1 peak=1 lane=def', shellId: 2, conversationId: 42 });
    assert.ok(five.id > three.id, '两次记账各占一行');
    // 账号可空：系统级动作（预热/清理/声明错误）本来就没有账号 —— 把它登记成必需会把这一类合法账挡在门外
    const sys = await s.audit.append({ accountId: null, action: 'spill:cleanup', detail: '{"removed":3}' });
    assert.ok(sys.id > five.id, '系统级动作（accountId=null）必须能写');
    await assert.rejects(() => s.audit.append({ accountId: 7, detail: '没动作' }), (e) => e.code === STORAGE_INVALID_FIELD, '缺 action 必须当场拒写');
    await assert.rejects(() => s.audit.append({ action: 'x', detail: 'y', accountID: 1 }), (e) => e.code === STORAGE_INVALID_FIELD, '拼错字段名不许静默吞');
  });

  // ── 知识管理面（2026-09-17）：管理视图的展示列 + 账号边界内的修订 + 每轮注入的可见范围读法 ──────
  test(T('知识管理面：展示列（含 shell_key/body_preview）、账号内修订、可见范围列表'), async () => {
    const { storage: s } = make();
    const add = (f) => s.knowledge.append({ kind: 'fact', status: 'active', body: '', ...f });
    await add({ accountId: 1, scope: 'global', conversationId: null, shellId: null, title: 'g1', body: 'x'.repeat(300) });
    await add({ accountId: 1, scope: 'conv', conversationId: 7, shellId: null, title: 'c1' });
    await add({ accountId: 1, scope: 'conv', conversationId: 8, shellId: null, title: 'c2' });
    await add({ accountId: 1, scope: 'global', conversationId: null, shellId: null, title: 'old', status: 'superseded' });
    await add({ accountId: 2, scope: 'global', conversationId: null, shellId: null, title: '别人的' });

    // ① 管理视图＝**账号内**的治理视图：能看到 superseded（治理要能改回来），但看不到别人的
    const all = await s.knowledge.adminList({ accountId: 1 });
    assert.deepEqual(all.map((r) => r.title), ['old', 'c2', 'c1', 'g1'], 'id DESC 且含 superseded（治理视图是历史视图）');
    assert.equal(all[0].shell_key, null, 'JSON 介质没有 shells 表 ⇒ shell_key 如实 null（不编假值）');
    assert.equal(all[0].body_preview.length, 0);
    assert.equal(all[3].body_preview.length, 200, 'body_preview 截到 200 字（与 MySQL 的 LEFT(body,200) 同口径）');
    assert.equal(all.some((r) => r.title === '别人的'), false, '账号边界：别人的条目一条都不许出现');
    // 过滤（与路由那套同名同义）：注意管理面**不按会话过滤**（治理视图是账号级的，路由也没有这个参数）
    assert.deepEqual((await s.knowledge.adminList({ accountId: 1, scope: 'conv' })).map((r) => r.title), ['c2', 'c1']);
    assert.deepEqual((await s.knowledge.adminList({ accountId: 1, kind: 'fact', status: 'superseded' })).map((r) => r.title), ['old']);
    // 按 id 取（带 q 命中后补展示列那条路）
    const ids = await s.knowledge.adminList({ accountId: 1, ids: [all[1].id, all[3].id] });
    assert.deepEqual(ids.map((r) => r.title), ['c2', 'g1']);
    assert.deepEqual(await s.knowledge.adminList({ accountId: 1, ids: [] }), [], '空 id 列表＝空结果（不查库、也不许变成"没有条件"）');

    // ② 可见范围列表（每轮注入的读法）：global + 本会话 conv，看不到别的会话与别人的
    const vis = await s.knowledge.visibleList({ accountId: 1, conversationId: 7 });
    assert.deepEqual(vis.map((r) => r.title), ['c1', 'g1'], 'id DESC：本会话 + global（不含别的会话/别人的/非 active）');
    assert.deepEqual(Object.keys(vis[0]).sort(), ['body', 'id', 'scope', 'title'], '注入读法只要这四列（与改造前那条 SQL 同形）');

    // ③ 管理面修订：账号边界 + 白名单
    assert.deepEqual(await s.knowledge.updateOwned(all[3].id, 1, { status: 'obsolete', relatedComponent: 'agent' }), { updated: true });
    assert.equal((await s.knowledge.adminList({ accountId: 1, ids: [all[3].id] }))[0].status, 'obsolete');
    assert.equal((await s.knowledge.adminList({ accountId: 1, ids: [all[3].id] }))[0].related_component, 'agent', 'related_component 要真的写进去（治理视图读它）');
    assert.deepEqual(await s.knowledge.updateOwned(all[3].id, 999, { status: 'active' }), { updated: false }, '别人的账号改不动');
    await assert.rejects(() => s.knowledge.updateOwned(all[3].id, 1, { accountId: 2 }), (e) => e.code === STORAGE_INVALID_FIELD, '身份字段不许从管理面改');
  });

  // ── 审计读法（2026-09-17）：C4/C5 仪表要的两条（各动作计数 + 某动作最后一行） ────────────────────
  test(T('审计读法：countByAction（C4/C5 计数）与 lastByAction（最近一次失效）'), async () => {
    const { storage: s } = make();
    await s.audit.append({ accountId: 1, action: 'prefix:invalidate', detail: 'fp=a cnt=1' });
    await s.audit.append({ accountId: 1, action: 'prefix:exempt', detail: 'first-round' });
    await s.audit.append({ accountId: 1, action: 'prefix:exempt', detail: 'idle' });
    await s.audit.append({ accountId: 1, action: 'tool:read_file', detail: '{}' });
    const counts = await s.audit.countByAction({ actions: ['prefix:invalidate', 'prefix:exempt', 'prefix:collapse'] });
    const asMap = Object.fromEntries(counts.map((r) => [r.action, r.n]));
    assert.deepEqual(asMap, { 'prefix:invalidate': 1, 'prefix:exempt': 2 }, '只数点名的三个动作（没出现的动作不补 0——与 GROUP BY 的语义一致）');
    assert.deepEqual(await s.audit.countByAction({ actions: [] }), [], '空名单＝空结果（不查库、也不许变成"数全部"）');
    // lastByAction：最后一行（同一 action 多条时取 id 最大的那条）
    const last = await s.audit.lastByAction('prefix:exempt');
    assert.equal(last.detail, 'idle', '要最后落的那条（id DESC LIMIT 1）');
    assert.ok(last.createdAt, '要带介质时间戳（C4 仪表报"最近一次什么时候"）');
    assert.equal(await s.audit.lastByAction('prefix:collapse'), null, '没发生过的动作＝null（不是空对象）');
    // countByFirstToken：C5 的"豁免原因"分布（detail 的首词），多的在前
    assert.deepEqual(await s.audit.countByFirstToken('prefix:exempt'), [{ reason: 'first-round', n: 1 }, { reason: 'idle', n: 1 }], '首词分布（同数时顺序不保证，这里两条各 1）');
    assert.deepEqual(await s.audit.countByFirstToken('prefix:invalidate'), [{ reason: 'fp=a', n: 1 }], '首词＝detail 里第一个空格前那段');
    assert.deepEqual(await s.audit.countByFirstToken('没有这个动作'), [], '没发生过＝空数组');
    // 按会话回溯（`/trace`）：挂在会话上的 **＋** detail 里带 conv=<id> 的（后者没有会话归属）
    await s.audit.append({ accountId: 1, action: 'skill:save', detail: 'name=x conv=7', conversationId: null });
    const trace = await s.audit.traceByConversation({ conversationId: 7, limit: 50 });
    assert.equal(trace.some((r) => r.detail === 'name=x conv=7'), true, 'detail 里点了会话的行也要回溯得到（既有口径）');
    assert.deepEqual(Object.keys(trace[0]).sort(), ['action', 'created_at', 'detail', 'id', 'shell_id'], '列名与改造前那条 SQL 逐字一致（前端读它们）');
    assert.ok(trace.length <= 50, 'limit 生效');
    assert.deepEqual(await s.audit.traceByConversation({ conversationId: 999, limit: 5 }), [], '没这个会话＝空数组');
    // 审计管理视图（`GET /api/audit` 活表分支）：条件串由调用方按既有口径拼，列名与改造前逐字一致
    await s.audit.append({ accountId: 1, action: 'tool:db_query', detail: '{"sql":"SELECT 1"}', conversationId: 7, shellId: null });
    const adm = await s.audit.adminList({ conds: ['1=1', 'conversation_id=?'], params: [7], limit: 10 });
    assert.deepEqual(adm.map((r) => r.action), ['tool:db_query'], '按会话过滤：' + JSON.stringify(adm.map((r) => r.action)));
    assert.deepEqual(Object.keys(adm[0]).sort(), ['account_id', 'action', 'conversation_id', 'created_at', 'detail', 'id', 'shell_id'], '列名与改造前那条 SQL 逐字一致');
    assert.equal(adm.length <= 10, true, 'limit 生效');
    const like = await s.audit.adminList({ conds: ['1=1', '(action LIKE ? OR detail LIKE ?)'], params: ['%prefix:exempt%', '%prefix:exempt%'] });
    assert.equal(like.every((r) => r.action === 'prefix:exempt'), true, 'LIKE 条件按既有口径过滤');
    // 看不懂的条件：两个实现都必须**如实抛**（JSON 侧带 STORAGE_UNSUPPORTED 码，MySQL 侧由介质自己报错）
    await assert.rejects(() => s.audit.adminList({ conds: ['有些不认识的条件'] }), /不认识/, '看不懂的条件必须如实抛（绝不"当没条件"把整表放出去）');
  });

  // ── 裁定 A 的两次读法（2026-09-17）：前缀账涉及过哪些会话 + 按 id 列表取逐轮读数 ──────────────────
  test(T('裁定 A：conversationIdsByActionPrefix 与 roundRowsByAccount（按 id 列表过滤、空列表＝空结果）'), async () => {
    const { storage: s } = make();
    await s.audit.append({ accountId: 1, action: 'prefix:assemble', detail: 'fp=a', conversationId: 11 });
    await s.audit.append({ accountId: 1, action: 'prefix:exempt', detail: 'first-round', conversationId: 11 });
    await s.audit.append({ accountId: 1, action: 'prefix:assemble', detail: 'fp=b', conversationId: 12 });
    await s.audit.append({ accountId: 1, action: 'tool:read_file', detail: '{}', conversationId: 12 });
    await s.audit.append({ accountId: 1, action: 'spill:cleanup', detail: '{}' });   // 无主行：不是会话，不许进名单
    const ids = await s.audit.conversationIdsByActionPrefix('prefix:');
    assert.deepEqual([...ids].sort((a, b) => a - b), [11, 12], '只回前缀命中的会话、去重、排除无主行：' + JSON.stringify(ids));
    assert.deepEqual(await s.audit.conversationIdsByActionPrefix('没有这个前缀:'), [], '没命中＝空数组');
    // 逐轮读数：窗口内 kind='round'，只取点名的那批会话
    await s.usage.append({ accountId: 1, conversationId: 11, kind: 'round', cacheHit: 900, cacheMiss: 100 });
    await s.usage.append({ accountId: 1, conversationId: 12, kind: 'round', cacheHit: 0, cacheMiss: 1000 });
    await s.usage.append({ accountId: 1, conversationId: 13, kind: 'round', cacheHit: 500, cacheMiss: 500 });
    await s.usage.append({ accountId: 1, conversationId: 11, kind: 'title', cacheHit: 0, cacheMiss: 5 });   // 非 round：不算
    const rows = await s.usage.roundRowsByAccount({ accountId: 1, days: 7, conversationIds: [11, 12] });
    assert.deepEqual(rows.map((r) => r.cid).sort((a, b) => a - b), [11, 12], '只取点名会话的 round 行：' + JSON.stringify(rows));
    assert.equal(rows.find((r) => r.cid === 11).h, 900, '命中数如实回：' + JSON.stringify(rows));
    assert.equal((await s.usage.roundRowsByAccount({ accountId: 1, days: 7, conversationIds: [11, 12] })).length, 2, 'title 那条不算 round');
    assert.deepEqual(await s.usage.roundRowsByAccount({ accountId: 1, days: 7, conversationIds: [] }), [], '空名单＝空结果（不是"没有条件"⇒ 不许变成全量）');
    const all = await s.usage.roundRowsByAccount({ accountId: 1, days: 7 });
    assert.equal(all.length, 3, '不传名单＝不加会话条件（保留原来那条形状）：' + JSON.stringify(all.map((r) => r.cid)));
    // 按天读数（仪表 30 天线）：同一天的多条要合起来（hit/miss 求和、n 计数），只算 round
    const daily = await s.usage.dailyByAccount({ accountId: 1, days: 30 });
    assert.equal(daily.length, 1, '这一批都是同一天 ⇒ 一天一行：' + JSON.stringify(daily));
    assert.equal(daily[0].n, 3, '三条 round 行合到一天（title 那条不算）');
    assert.equal(daily[0].hit, 900 + 0 + 500, '命中数按天求和');
    assert.equal(daily[0].miss, 100 + 1000 + 500, '未命中数按天求和');
    assert.match(daily[0].d, /^\d{4}-\d{2}-\d{2}$/, 'd 是 YYYY-MM-DD（与路由算"今天"的口径一致）');
    assert.deepEqual(await s.usage.dailyByAccount({ accountId: 12345, days: 30 }), [], '没有记账的账号＝空数组');
  });

  test(T('事务：提交后全部可见（tx 的返回值要透出来）'), async () => {
    const { storage: s } = make();
    const mid = await s.tx(async (t) => {
      const m = await t.messages.append({ conversationId: 9, role: 'user', content: '事务内' });
      await t.settings.set('tx_probe', 'v');
      return m.id;
    });
    assert.ok(mid > 0, 'fn 的返回值要能拿到（调用方拿它当回执）');
    assert.deepEqual((await s.messages.list(9, 10)).map((r) => r.content), ['事务内']);
    assert.equal(await s.settings.get('tx_probe'), 'v');
  });

  test(T('事务：中途抛错 ⇒ 整批回滚（事务内一条都不许留下）'), async () => {
    const { storage: s } = make();
    await s.messages.append({ conversationId: 10, role: 'user', content: '事务前' });
    await assert.rejects(
      () => s.tx(async (t) => {
        await t.messages.append({ conversationId: 10, role: 'user', content: '该回滚的' });
        throw new Error('业务中途失败');
      }),
      /业务中途失败/, '失败必须原样抛出去（不许吞掉）');
    assert.deepEqual((await s.messages.list(10, 10)).map((r) => r.content), ['事务前'], '回滚要真回滚');
  });

  test(T('能力缺失必须如实抛错（不支持 ≠ 空结果；v0.3 §4.6 禁止静默降级）'), async () => {
    const { storage: s } = make();
    if (caps.rawSql) {
      const rows = await s.query('SELECT * FROM settings WHERE skey=? LIMIT 1', ['没有这个键']);
      assert.ok(Array.isArray(rows), '原生动词要透传到介质（返回行数组）');
    } else {
      for (const verb of ['query', 'one', 'run']) {
        await assert.rejects(async () => s[verb]('SELECT 1'),
          (e) => e.code === STORAGE_UNSUPPORTED && /该实现不支持/.test(e.message), verb + ' 必须如实抛"不支持"');
      }
    }
    // deliveries 两个实现都必须有：带 Idempotency-Key 的一轮 chat 第一件事就是 beginDelivery
    // （2026-09-16 真机故障：jsonfile 缺它 ⇒ 整轮 500）。空表＝空数组，不是"不支持"。
    assert.deepEqual(await s.deliveries.list({ limit: 5 }), []);
  });

  test(T('投递记录：占位 → 按键查 → 抢重发 → 收尾 → 死信列表（幂等语义的存储面）'), async () => {
    const { storage: s } = make();
    const { id } = await s.deliveries.insert({ accountId: 1, conversationId: 2, idemKey: 'k1', hash: 'h1' });
    const hit = await s.deliveries.findByKey(1, 'k1');
    assert.equal(hit.id, id);
    assert.equal(hit.state, 'running');
    assert.equal(hit.requestHash, 'h1');
    assert.equal(await s.deliveries.claimRetry(id, 'h1'), false, '还在跑 ⇒ 抢不到（这就是并发闸门）');
    await s.deliveries.finish(id, { state: 'failed', lastError: '连接断开', lastErrorCode: 'CLIENT_DISCONNECTED' });
    assert.equal(await s.deliveries.claimRetry(id, 'h1'), true, '失败 ⇒ 允许抢回重发');
    assert.equal(Number((await s.deliveries.findByKey(1, 'k1')).attempts), 2, 'attempts 如实累加');
    await s.deliveries.finish(id, { state: 'succeeded', messageId: 5, runId: 6, response: { ok: true } });
    const done = await s.deliveries.findByKey(1, 'k1');
    assert.equal(done.state, 'succeeded');
    assert.deepEqual(done.response, { ok: true }, '响应体按 JSON 回读（幂等回放要用）');
    assert.deepEqual((await s.deliveries.list({ state: 'succeeded', limit: 5 })).map((r) => r.id), [id]);
    await s.deliveries.insert({ accountId: 1, conversationId: 3 });   // 无幂等键：每次一行
    assert.equal((await s.deliveries.list({ limit: 5 })).length, 2);
    await s.deliveries.insert({ accountId: null, conversationId: 4, idemKey: 'kn' });   // account_id 为 NULL 的键
    assert.ok(await s.deliveries.findByKey(null, 'kn'), '<=> 是 NULL 安全等：NULL 账号也要能命中自己那条');
  });

  test(T('唯一键：同一个（账号+幂等键）第二次插入必须抛错（并发重发只进一个的介质保证）'), async () => {
    const { storage: s } = make();
    await s.deliveries.insert({ accountId: 3, conversationId: 1, idemKey: 'same', hash: 'h' });
    await assert.rejects(() => s.deliveries.insert({ accountId: 3, conversationId: 1, idemKey: 'same', hash: 'h' }),
      (e) => e.code === 'ER_DUP_ENTRY', '唯一键冲突要以 ER_DUP_ENTRY 的形状抛出来（deliveries.js 靠它判"进行中"）');
    // 调用方（真模块）在这一步必须得到"进行中"，而不是"又开了一条"
    const again = await beginDelivery({ accountId: 3, conversationId: 1, idemKey: 'same', hash: 'h', store: s });
    assert.equal(again.conflict, 'in_progress', '同一刻的第二个重发只能是"进行中"');
    assert.equal((await s.deliveries.list({ limit: 10 })).length, 1, '只许有一行');
  });

  test(T('并发写不丢：同一刻 24 个追加一条不少、顺序不乱（真机踩过 ENOENT/丢更新）'), async () => {
    const { storage: s } = make();
    await Promise.all(Array.from({ length: 24 }, (_, i) => s.messages.append({ conversationId: 77, role: 'user', content: 'm' + i })));
    const rows = await s.messages.list(77, 100);
    assert.equal(rows.length, 24, '并发追加不许丢');
    assert.deepEqual(rows.map((r) => r.content), Array.from({ length: 24 }, (_, i) => 'm' + i), '读出顺序＝写入顺序');
    // 账本是最容易被并发砸中的那条路：persistEvent 是逐帧 fire-and-forget
    for (let i = 0; i < 24; i++) persistEvent(77, { seq: i + 1, at: i + 1, type: 'tool_done', i }, s);
    await new Promise((r) => setTimeout(r, 60));   // 等 fire-and-forget 落地（本仓既有夹具同款做法）
    assert.equal((await s.events.read(77, { limit: 100 })).length, 24, '并发追加的事件一条不少');
  });

  test(T('端到端：一轮对话跑通（真调用方模块 × 本实现），落账可回放、幂等可重放'), async () => {
    const { storage: s } = make();
    const turn = await oneTurn(s);
    assert.deepEqual((await s.messages.list(turn.conversationId, 10)).map((r) => r.role + ':' + r.content),
      ['user:你好', 'assistant:收到'], '一轮的对话内容按序落下来了');
    const events = await readEvents(turn.conversationId, { dbc: s });
    assert.deepEqual(events.map((e) => e.type), ['run_start', 'tool_done', 'run_end'], '账本可回放（投影的源）');
    assert.deepEqual(events[1].payload.tool, { name: 'read_file', status: 'done' }, 'payload 回读成对象');
    assert.equal((await s.agentRuns.getLatest(turn.conversationId)).status, 'completed', '运行现场收尾');
    const again = await beginDelivery({ accountId: 1, idemKey: 'turn-1', hash: requestHash({ content: '你好' }), store: s });
    assert.deepEqual(again.replay, { messageId: turn.messageId, runId: turn.runId, content: '收到' },
      '同一幂等键再来一次 ⇒ 回放原始接受结果（不重跑一轮）');
    assert.equal((await listDeliveries({ state: 'succeeded', limit: 10, store: s })).length, 1, '死信列表能看到这条投递');
  });

  test(T('未知字段 / 缺必需字段当场抛错（不许静默丢数据）'), async () => {
    const { storage: s } = make();
    await assert.rejects(async () => s.messages.append({ conversationId: 1, role: 'user', content: 'x', 拼错的字段: 1 }),
      (e) => e.code === STORAGE_INVALID_FIELD, '拼错的字段若被默默丢掉，就是静默丢数据');
    await assert.rejects(async () => s.events.append({ type: 'run_start' }),
      (e) => e.code === STORAGE_INVALID_FIELD, '没有会话归属的事件＝没有意义');
  });
}

contractSuite('mysql（假 pool）', makeMysql, { rawSql: true });
contractSuite('jsonfile（真文件）', makeJsonFile, { rawSql: false });

// ── MySQL 侧额外：语句形状与事务控制（真库夹具不管这些，而它们正是"搬家"时最容易走样的地方）──
test('[mysql] 命名方法发的是参数化语句：值走参数、不拼进 SQL', async () => {
  const { storage: s, probe } = makeMysql();
  const evil = "'; DROP TABLE conversations; --";
  const { id } = await s.conversations.create({ accountId: 42, title: evil });
  const ins = probe.calls.find((c) => /^INSERT INTO conversations/.test(c.sql));
  assert.ok(ins, '没发出 INSERT（语句形状变了？假 pool 会抛，这里兜底给个明确断言）');
  assert.ok(!ins.sql.includes('DROP TABLE'), 'SQL 文本里不许出现值（拼字符串＝注入面）');
  assert.deepEqual(ins.params, [42, evil], '参数顺序＝字段顺序');
  await s.conversations.get(id);
  const sel = probe.calls.find((c) => /^SELECT \* FROM conversations WHERE id=\?/.test(c.sql));
  assert.ok(sel, '按主键读要走参数化 SELECT ... WHERE id=?');
});

test('[mysql] 事务：借一条连接 BEGIN → COMMIT / ROLLBACK，且连接必须归还', async () => {
  const { storage: s, probe } = makeMysql();
  await s.tx(async (t) => { await t.settings.set('a', 1); });
  assert.deepEqual(probe.calls.filter((c) => c.tx).map((c) => c.tx), ['BEGIN', 'COMMIT', 'RELEASE']);
  const before = probe.calls.length;
  await assert.rejects(() => s.tx(async () => { throw new Error('失败'); }), /失败/);
  assert.deepEqual(probe.calls.slice(before).filter((c) => c.tx).map((c) => c.tx), ['BEGIN', 'ROLLBACK', 'RELEASE'],
    '失败必须 ROLLBACK，且连接照样归还（漏归还＝池子被占满）');
});

test('[mysql] 原生动词各自对应 db.js 的哪一面（迁移中的调用方靠它过渡）', async () => {
  const { storage: s } = makeMysql();
  await s.run('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,?,NOW())', ['k', '"v"']);
  assert.deepEqual(await s.query('SELECT * FROM settings WHERE skey=? LIMIT 1', ['没有']), [], 'query＝读多行（空＝空数组）');
  assert.equal(await s.one('SELECT svalue FROM settings WHERE skey=? LIMIT 1', ['没有']), null, 'one＝读一行（没有＝null）');
});

// ── JSON 侧额外：真文件、格式版本、持久性 ───────────────────────────────────────────────────
test('[jsonfile] 真文件：写进去的东西在文件里，格式带 format/version（v0.3 §4.9）', async () => {
  const { storage: s, probe } = makeJsonFile();
  await s.settings.set('k', { a: 1 });
  const doc = JSON.parse(fs.readFileSync(probe.file, 'utf8'));
  assert.equal(doc.format, 'rw-store-json');
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.tables.settings.k.value, { a: 1 });
});

test('[jsonfile] 换一个实例读同一个文件：数据还在（重启不掉账）', async () => {
  const file = tmpFile('persist');
  await createJsonFileStorage({ file }).messages.append({ conversationId: 1, role: 'user', content: '重启前' });
  const second = createJsonFileStorage({ file });
  assert.deepEqual((await second.messages.list(1, 10)).map((r) => r.content), ['重启前']);
});

test('[jsonfile] 落盘后重启：账号与会话都读得回来（"干净机器跑通一次对话"的第一步就是登录）', async () => {
  const file = tmpFile('login-restart');
  const first = createJsonFileStorage({ file });
  const { id: accId } = await first.accounts.create({ username: 'Carol', passHash: 'h', role: 'admin' });
  await first.sessions.create({ token: 'tok-restart', accountId: accId, days: 5 });
  await first.conversations.create({ accountId: accId, title: '重启前的会话' });

  const second = createJsonFileStorage({ file });   // 新实例 ＝ 重启（内存态没了，只剩文件）
  const acc = await second.accounts.findByUsername('Carol');
  assert.equal(acc.id, accId, '账号要从文件里读回来（否则重启后没人登得进来）');
  assert.equal(acc.passHash, 'h', '密码散列要一并读回（登录要拿它比对）');
  assert.deepEqual(await second.sessions.findValid('tok-restart'), { id: accId, username: 'Carol', role: 'admin' },
    '没到期的会话重启后仍然有效（否则每次重启都要重新登录）');
  assert.deepEqual((await second.conversations.listByAccount(accId)).map((r) => r.title), ['重启前的会话']);
});

test('[jsonfile] 文件版本不认识 ⇒ 显式拒绝（不许当空库继续跑）', async () => {
  const file = tmpFile('badver');
  fs.writeFileSync(file, JSON.stringify({ format: 'rw-store-json', version: 99, tables: {} }));
  await assert.rejects(async () => createJsonFileStorage({ file }).settings.get('k'), /版本不认识/);
});

test('[jsonfile] 能力缺失一路传到调用方：归档在原生动词上如实抛"不支持"（不是静默跳过）', async () => {
  const { storage: s } = makeJsonFile();
  // 归档是唯一还用原生动词（SQL 面）的调用方：换到没有 SQL 面的实现时，它必须**当场报错**，
  // 让调用方（index.js）能如实打印"该存储实现不支持归档，跳过"，而不是悄悄返回 0 行。
  await assert.rejects(() => archiveOldEvents({ dbc: s }),
    (e) => e.code === STORAGE_UNSUPPORTED && /该实现不支持/.test(e.message));
});

// ── 选择点与迁移示范（源码级：这两条才是"可替换"的机检）────────────────────────────────────
test('单一选择点：全仓只有 env.js 声明、storage/index.js 选择（绕过它就等于没抽象）', () => {
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((it) => {
    const rel = dir + '/' + it.name;
    if (it.isDirectory()) return it.name === 'node_modules' ? [] : walk(rel);
    return /\.m?js$/.test(it.name) ? [rel] : [];
  });
  // 注释里提到不算使用：剥掉块注释与行注释再找标识符（否则一行说明就把判据打歪）
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S\n])\/\/[^\n]*/gm, '$1');
  const hits = walk('server').filter((f) => /\bRW_STORAGE\b/.test(code(read(f)))).sort();
  assert.deepEqual(hits, ['server/env.js', 'server/storage/index.js'], 'RW_STORAGE 只许在这两处出现，实际：' + hits.join(', '));
  assert.throws(() => createStorage('sqlite'), /未知的存储实现/, '未知实现要当场抛，不许静默回退到 mysql');
});

test('迁移示范：deliveries/eventlog 不再直接 import db，存储只经接口（v0.3 §7.1 ⑦ 的验收点）', () => {
  for (const f of ['server/deliveries.js', 'server/eventlog.js']) {
    const src = read(f);
    assert.ok(!/from '\.\/db\.js'/.test(src), f + ' 不该再直接 import db');
    assert.ok(!/\bdb\.query\(|\bdb\.run\(/.test(src), f + ' 不该再直接发 SQL');
    assert.match(src, /from '\.\/storage\/index\.js'/, f + ' 必须从接口拿存储（单一选择点）');
  }
});
