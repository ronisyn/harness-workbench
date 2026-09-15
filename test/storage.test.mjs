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
    // WHERE 里的条件是 ` AND ` 连起来的（不是逗号），每个条件恰好一个 `?`，顺序即参数顺序
    const conds = raw.split(/\s+AND\s+/i).map((c) => {
      const m = /^(\w+)\s*(<=>|=|>)\s*\?$/.exec(c.trim());
      if (!m) throw new Error('假 pool 不认识的 WHERE 条件：' + c);
      return { col: m[1], op: m[2], val: params.shift() };
    });
    return (row) => conds.every(({ col, op, val }) => {
      const v = row[col] === undefined ? null : row[col];
      if (op === '<=>') return v === (val === undefined ? null : val);   // NULL 安全等（deliveries 的幂等键靠它）
      if (op === '>') return Number(v) > Number(val);
      return v === val;
    });
  };

  function exec(store, sql, params) {
    const p = [...(params || [])];
    const q = String(sql).trim();
    let m;
    if ((m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \((.*?)\)(?: ON DUPLICATE KEY UPDATE (.+))?$/i.exec(q))) {
      const [, table, colsRaw, valsRaw, dupRaw] = m;
      const cols = colsRaw.split(',').map((c) => c.trim());
      const vals = splitTop(valsRaw).map((v) => {
        if (v === '?') return p.shift();
        if (/^NOW\(\)$/i.test(v)) return new Date();
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
      // 真库的 `DEFAULT NOW()`：假库照做，否则 toRecord 的 created_at/updated_at 映射没人验
      if (!('created_at' in row)) row.created_at = new Date();
      if (!('updated_at' in row)) row.updated_at = new Date();
      const keyed = table === 'settings';                 // 主键是字符串（skey），其余是自增 id
      const key = keyed ? row.skey : (store.counters.set(table, (store.counters.get(table) || 0) + 1), store.counters.get(table));
      const rows = rowsOf(store, table);
      if (keyed && rows.has(key)) {
        const cur = rows.get(key);
        for (const item of splitTop(dupRaw)) {
          const mm = /^(\w+)\s*=\s*(?:VALUES\((\w+)\)|NOW\(\))$/i.exec(item);
          if (!mm) throw new Error('假 pool 不认识的 ON DUPLICATE 项：' + item);
          cur[mm[1]] = mm[2] ? row[mm[2]] : new Date();
        }
        return { insertId: 0, affectedRows: 2 };
      }
      if (!keyed) row.id = key;
      rows.set(key, row);
      return { insertId: keyed ? 0 : key, affectedRows: 1 };
    }

    if ((m = /^SELECT (.+?) FROM (\w+)\b(.*)$/i.exec(q))) {
      const [, colsRaw, table] = m;
      let rest = m[3];
      let limit = null; let desc = false; let orderCol = 'id'; let whereRaw = null;
      let mm;
      if ((mm = /\s+LIMIT (\d+)\s*$/i.exec(rest))) { limit = Number(mm[1]); rest = rest.slice(0, mm.index); }
      if ((mm = /\s+ORDER BY (\w+)( DESC)?\s*$/i.exec(rest))) { orderCol = mm[1]; desc = !!mm[2]; rest = rest.slice(0, mm.index); }
      if ((mm = /^\s+WHERE (.+)$/i.exec(rest))) whereRaw = mm[1];
      else if (rest.trim()) throw new Error('假 pool 不认识的 SELECT 尾巴：' + rest);
      let rows = [...rowsOf(store, table).values()];
      if (whereRaw) { const f = whereOf(whereRaw, p); rows = rows.filter(f); }
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
        let mm;
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
