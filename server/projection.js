// server/projection.js —— 确定性投影：运行态 = 事件账本的**纯函数投影**（架构增量二）
//
// 为什么要有它（2026-09-15）：
//   `events` 表已经是只追加、有顺序、可回放的账本（增量一），但"运行态"此前只活在内存与业务表里——
//   run 的轮次/工具面/结局各写各的列（agent_runs / tool_calls / usage_stats），**没有一处是账本的函数**。
//   对不上的时候无法回答"是账本缺事件，还是业务表写错了"。本模块把运行态定义成 `apply(状态, 事件)` 的折叠，
//   于是同一段账本任何时刻折出来的结果都相同（确定性），也就能与业务表逐项对账。
//
// 口径（照 DSH `dsh-session-projection` 的做法，不自己发明）：
//   · 注册表：`register({key, stateVersion, init, apply})` + 按 key 折叠，对应 DSH 的
//     `ctx.sessionProjections.register({key, stateVersion, stateSchema, init, apply})` 与 `stateOf(session, key)`；
//   · `apply` 是**纯函数**：不改入参、不抛错（未知事件类型原样返回状态）、幂等（同一事件重复 apply 不重复计数）。
//     幂等靠"已处理过的行 id / seq"去重 —— 账本里每帧一行，重放同一行两次不得多算一次。
//   · 投影只**读**账本：本模块不写任何表、不 import db（对账要的数据库句柄由调用方传进来，便于夹具替换）。

// ── 投影定义 ────────────────────────────────────────────────────────────────────────────────
// 每个定义：key（唯一名）/ stateVersion（改了折叠语义就要 +1，否则旧状态会被当成新的用）/
//           init() 空状态 / apply(状态, 事件) 纯折叠。

/** run 标识：优先事件里带的 runId；没有（轻量问答不登记现场）就归到 perRun 的 key。 */
const DEFAULT_RUN = 'run:-';
// 账本行 → 投影入参。`runId` 在两种来源里位置不同：账本行把它存在 payload 里（eventRow 把除
// seq/at/type 之外的全部字段都塞进 payload），而夹具/别的源可能直接给在顶层 —— 两处都认。
const toEvent = (raw) => {
  const p = (raw.payload && typeof raw.payload === 'object') ? raw.payload : {};
  return { type: String(raw.type || ''), runId: raw.runId != null ? raw.runId : p.runId, payload: p };
};

const runKeyOf = (runId) => (runId == null || runId === '' ? DEFAULT_RUN : 'run:' + runId);
/** 取当前活动 run：显式 runId 优先（done/run_end 带），否则用 run_start 开的那个。 */
const activeRun = (state, ev) => (ev.runId != null ? runKeyOf(ev.runId) : state.current);

const bump = (obj, k) => ({ ...obj, [k]: (obj[k] || 0) + 1 });

/**
 * runStats：每个 run 的轮次 / 工具调用数（按状态分）/ 各类失败码计数 / 重试次数。
 * 与业务表的对应：轮次 ↔ usage_stats(kind='round') 行数；工具调用 ↔ tool_calls 行数与 status。
 * 与业务表**无**对应：重试次数（llm_retry 只在账本与事件流里，没有表）。
 */
export const runStats = {
  key: 'runStats',
  stateVersion: 1,
  init: () => ({ runs: {}, current: null }),
  apply(state, ev) {
    const p = ev.payload || {};
    const blank = () => ({ rounds: 0, roundSeen: {}, toolStarted: 0, toolDone: 0, toolFail: 0, llmRetries: 0, failureCodes: {} });
    const at = (key) => state.runs[key] || blank();
    const put = (key, patch) => ({ ...state, runs: { ...state.runs, [key]: { ...at(key), ...patch } } });
    const cur = state.current || DEFAULT_RUN;
    switch (ev.type) {
      case 'run_start': {
        const key = runKeyOf(p.runId);
        return { ...put(key, {}), current: key }; // 已有就沿用（重放同一条 run_start 不重开）
      }
      case 'thinking': {
        const key = activeRun(state, ev);
        // 轮次按 `round` 去重（同一轮多条 thinking 只算一轮；重放同一事件也不重算）
        const roundSeen = { ...at(key).roundSeen, [p.round]: 1 };
        return put(key, { roundSeen, rounds: Object.keys(roundSeen).length });
      }
      case 'tool_start':
        return put(cur, { toolStarted: at(cur).toolStarted + 1 });
      case 'tool_done': {
        const fail = (p.tool || {}).status === 'fail';
        const code = (p.tool || {}).code; // 与 tool_calls.error_code 同源（agent.js 落的是 result.code）
        const next = put(cur, { toolDone: at(cur).toolDone + (fail ? 0 : 1), toolFail: at(cur).toolFail + (fail ? 1 : 0) });
        if (!code) return next;
        return { ...next, runs: { ...next.runs, [cur]: { ...next.runs[cur], failureCodes: bump(next.runs[cur].failureCodes, String(code)) } } };
      }
      case 'llm_retry':
        return put(cur, { llmRetries: at(cur).llmRetries + 1 });
      default:
        return state; // 未知/不关心的事件类型：原样返回状态，绝不抛错
    }
  },
};

/**
 * toolFace：本会话出现过（被**调用**）的工具集合与顺序 + 计数。
 * ⚠️ 与 `usage_stats.prefix_tools_hash` 的关系如实说清（这条容易想当然）：
 *   那个哈希的输入是**该轮发给模型的完整工具定义集**（几十个 defs 拼出来的 JSON），
 *   而投影只能看见**真被调用过**的工具（tool_start/tool_done 事件）。两者**不同源**：
 *   调用集是可用集的子集，覆盖全量才可能相等。所以对账时：
 *     · 能判的是包含关系（调用过的工具必须在当时的面上）→ 真不一致就是真发现；
 *     · 哈希只在**同一个 run 内两次调用之间**可比（本 run 内工具面是冻结的）。
 *   `order` 是**首次出现**顺序（会话内跨 run 累积），与 defs 的装配顺序无关，别拿它当 defs 顺序。
 */
export const toolFace = {
  key: 'toolFace',
  stateVersion: 1,
  init: () => ({ order: [], counts: {}, calls: 0 }),
  apply(state, ev) {
    if (ev.type !== 'tool_start') return state;
    const name = String(((ev.payload || {}).tool || {}).name || '');
    if (!name) return state;
    const seen = Object.prototype.hasOwnProperty.call(state.counts, name);
    return {
      order: seen ? state.order : [...state.order, name],
      counts: bump(state.counts, name),
      calls: state.calls + 1,
    };
  },
};

/**
 * outcomes：每次 run 的**终结状态**（来自 done / stopped / error / run_end）。
 * 业务表对应：`agent_runs.status`（completed / interrupted / paused）——两边口径不同，映射见 verifyProjection。
 * 护栏挂起也走 done（`run_end.guard`），所以 guard 单列一栏：状态是 saved 但结局是"挂起"。
 */
export const outcomes = {
  key: 'outcomes',
  stateVersion: 1,
  init: () => ({ runs: {}, current: null }),
  apply(state, ev) {
    const p = ev.payload || {};
    const blank = { status: null, reason: null, guard: null, terminal: null };
    const at = (key) => state.runs[key] || blank;
    const put = (key, patch) => ({ ...state, runs: { ...state.runs, [key]: { ...at(key), ...patch } } });
    switch (ev.type) {
      case 'run_start':
        return { ...put(runKeyOf(p.runId), {}), current: runKeyOf(p.runId) };
      case 'stopped':
        return put(state.current || DEFAULT_RUN, { terminal: 'stopped' }); // 停下来但没落定：status/reason 由 run_end 给（契约 §4）
      case 'error':
        return put(state.current || DEFAULT_RUN, { terminal: 'error' });
      case 'done':
        return put(activeRun(state, ev), { terminal: 'done' });
      case 'run_end':
        // 只写**非空**字段（run_end 缺 reason/guard 时不把已有值抹掉）；没有 runId 就落到当前 run
        return put(activeRun(state, ev) || DEFAULT_RUN, {
          status: p.status != null ? String(p.status) : undefined,
          reason: p.reason != null ? String(p.reason) : undefined,
          guard: p.guard != null ? String(p.guard) : undefined,
        });
      default:
        return state;
    }
  },
};

/** 注册表（照 DSH：按 key 注册，key 唯一；同 key 重复注册直接报错，而不是悄悄覆盖）。 */
export const PROJECTIONS = [runStats, toolFace, outcomes];
export const REGISTRY = new Map(PROJECTIONS.map((d) => [d.key, d]));

/**
 * 折叠一段账本。纯函数：不改 events、不碰 DB、任何事件类型都不抛。
 * @param {Array<{id?:number, seq?:number, type:string, payload?:object}>} events 账本行（升序）
 * @param {string[]} [keys] 要算的投影 key；缺省=全部
 * @returns {Record<string, any>} key → 状态（另附 `__applied`：实际折叠进去的事件条数）
 */
export function project(events, keys = PROJECTIONS.map((d) => d.key)) {
  const defs = keys.map((k) => {
    const d = REGISTRY.get(k);
    if (!d) throw new Error('未知投影 key：' + k + '（已注册：' + [...REGISTRY.keys()].join(', ') + '）');
    return d;
  });
  const states = {};
  for (const d of defs) states[d.key] = d.init();
  // 幂等去重：**按账本行 id**（账本唯一键；重放同一行不得多算）。
  // 没有 id 的合成事件（夹具/将来别的源）退回按 seq 去重 —— 但 seq≤0 视为"没有序号可用"，
  // 否则账本里那些 seq=0 的行会被整段吃掉（真库实测：events.seq 目前全是 0，见 docs 与报告）。
  const seenIds = new Set();
  const seenSeqs = new Set();
  let applied = 0;
  for (const raw of Array.isArray(events) ? events : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = Number(raw.id) || 0;
    const seq = Number(raw.seq) || 0;
    if (id > 0) { if (seenIds.has(id)) continue; seenIds.add(id); }
    else if (seq > 0) { if (seenSeqs.has(seq)) continue; seenSeqs.add(seq); }
    const ev = toEvent(raw);
    for (const d of defs) states[d.key] = d.apply(states[d.key], ev);
    applied += 1;
  }
  states.__applied = applied;
  return states;
}

// ── 与数据库现值对账 ────────────────────────────────────────────────────────────────────────
// 为什么对账比对账本身重要：投影对了却没人核过，等于多了一份"看起来对"的数据；而不一致时**如实报出**，
// 才是发现分叉（账本缺事件 / 业务表写错 / 投影口径错）的唯一手段。所以本函数只做判断与陈述，不改任何数据。

/** 取最后一次出现的值（键可能为空）。 */
const groupCount = (rows, pick) => {
  const out = {};
  for (const r of rows || []) {
    const k = pick(r);
    if (k == null || k === '') continue;
    out[String(k)] = (out[String(k)] || 0) + 1;
  }
  return out;
};
/** 计数对象逐键比对，返回人可读差异（一致则空数组）。 */
const diffCounts = (eventSide, dbSide) => {
  const keys = [...new Set([...Object.keys(eventSide), ...Object.keys(dbSide)])].sort();
  const out = [];
  for (const k of keys) {
    const a = eventSide[k] || 0, b = dbSide[k] || 0;
    if (a !== b) out.push(`${k}: 投影 ${a} / 库 ${b}`);
  }
  return out;
};
const fmt = (o) => Object.entries(o).map(([k, v]) => k + '×' + v).join('、') || '（空）';

/**
 * 逐项对账：投影结果 vs 数据库现值。**只读**。
 * @param {{conversationId:number, states:object, db:{query:Function}, ctx?:Map<number,{permission:string,preset:string,light:boolean}>}} args
 *        ctx：会话内见过的 run 级上下文（由调用方从账本的 run_start 收集），用于复算"当时的工具面"。
 * @returns {Promise<{checks:Array<{name:string, ok:(boolean|null), detail:string}>, notes:string[]}>}
 *          ok=true 一致 / false 不一致（detail 写差异）/ null 无法判定（detail 写为什么）
 */
export async function verifyProjection({ conversationId, states, db, ctx = new Map() }) {
  const checks = [];
  const notes = [];
  const statsRuns = (states.runStats || {}).runs || {};
  const face = states.toolFace || { order: [], counts: {}, calls: 0 };
  const outcomeRuns = (states.outcomes || {}).runs || {};

  // ① run 数与 run 身份：投影的 runId 集 vs agent_runs 行集
  const runIds = Object.keys(statsRuns).map((k) => k.replace(/^run:/, '')).filter((k) => k !== '-');
  const dbRuns = (await db.query('SELECT id, status, rounds FROM agent_runs WHERE conversation_id=? ORDER BY id', [conversationId])) || [];
  const dbIds = new Set(dbRuns.map((r) => String(r.id)));
  const onlyEvents = runIds.filter((id) => !dbIds.has(id));
  const onlyDb = dbRuns.map((r) => String(r.id)).filter((id) => !runIds.includes(id));
  checks.push({
    name: 'run 数（事件 run_start/done/run_end ↔ agent_runs）',
    ok: onlyEvents.length === 0 && onlyDb.length === 0,
    detail: `投影 ${runIds.length} 个 / 库 ${dbRuns.length} 个`
      + (onlyEvents.length ? `；只在账本里：${onlyEvents.join(',')}` : '')
      + (onlyDb.length ? `；只在库里：${onlyDb.join(',')}` : ''),
  });

  const dbCalls = (await db.query('SELECT tool_name, status, error_code FROM tool_calls WHERE conversation_id=?', [conversationId])) || [];

  // ② 工具调用数与成功/失败分布
  const evTool = { calls: 0, done: 0, fail: 0 };
  for (const r of Object.values(statsRuns)) { evTool.calls += r.toolStarted || 0; evTool.done += r.toolDone || 0; evTool.fail += r.toolFail || 0; }
  const dbTool = { calls: dbCalls.length, done: 0, fail: 0 };
  for (const c of dbCalls) { if (c.status === 'done') dbTool.done += 1; else if (c.status === 'fail') dbTool.fail += 1; }
  const toolDiff = diffCounts(evTool, dbTool);
  checks.push({
    name: '工具调用数与成败分布（tool_start/tool_done ↔ tool_calls）',
    ok: toolDiff.length === 0,
    detail: toolDiff.length ? toolDiff.join('；') : `各 ${evTool.calls} 次（done ${evTool.done} / fail ${evTool.fail}）`,
  });

  // ③ 失败码分布（同一批 tool_done 的 code ↔ tool_calls.error_code，含 status='done' 上的码）
  const evCodeCount = {};
  for (const r of Object.values(statsRuns)) for (const [code, n] of Object.entries(r.failureCodes || {})) evCodeCount[code] = (evCodeCount[code] || 0) + n;
  const dbCodeCount = groupCount(dbCalls, (c) => c.error_code);
  const codeDiff = diffCounts(evCodeCount, dbCodeCount);
  checks.push({
    name: '失败码分布（tool_done.code ↔ tool_calls.error_code）',
    ok: codeDiff.length === 0,
    detail: codeDiff.length ? codeDiff.join('；') : fmt(evCodeCount),
  });

  // ④ 工具面：调用过的工具必须都在"当时的可用面"里（真发现）；哈希仅作参考，不作判据
  const faced = [];
  if (ctx.size) {
    // 动态 import：复算工具面要拉起 epoch/agent/tools 一整条链，只有真需要对账时才付这个启动成本
    const { laneEpoch } = await import('./epoch.js');
    for (const c of ctx.values()) {
      try {
        const e = laneEpoch(c.permission, c.preset, c.light);
        faced.push({ lane: e.lane, names: new Set(e.defs.map((d) => d.function.name)), hash: e.toolsHash });
      } catch { /* 复算不出来就少一条参考面；不含 run_start 的会话下面按"无法判定"处理 */ }
    }
  }
  const available = new Set(faced.flatMap((f) => [...f.names]));
  const invoked = [...new Set(face.order || [])];
  if (!faced.length) {
    checks.push({
      name: '工具面（调用过的工具 ⊆ 当时的可用面）',
      ok: null,
      detail: '本会话账本里没有 run_start ⇒ 复算不出"当时的工具面"，无法判定',
    });
  } else {
    const outside = invoked.filter((n) => !available.has(n));
    checks.push({
      name: '工具面（调用过的工具 ⊆ 当时的可用面）',
      ok: outside.length === 0,
      detail: outside.length
        ? `这些工具不在复算出的面上：${outside.join('、')}`
        : `调用 ${invoked.length} 个，全部在 ${faced.length} 条面（${faced.map((f) => f.lane + '/' + f.names.size + '个').join('、')}）内`,
    });
  }
  // 参考行：不是判据 —— 面哈希的输入是**整份 defs**，投影只知道被调用过的工具，两者集合大小天然不同
  const dbFaceHashes = groupCount((await db.query('SELECT DISTINCT prefix_tools_hash FROM usage_stats WHERE conversation_id=? AND prefix_tools_hash IS NOT NULL', [conversationId])) || [], (r) => r.prefix_tools_hash);
  if (Object.keys(dbFaceHashes).length || faced.length) {
    notes.push('工具面哈希（仅参考，非判据）：库中已存 ' + fmt(dbFaceHashes)
      + '；按当前代码复算 ' + (faced.length ? faced.map((f) => f.lane + '=' + f.hash).join('、') : '（无面）')
      + '。两者不同源——存的是**整份 defs** 的指纹，投影只有**被调用过**的工具；且复算用的是当前代码与当前工具注册表，与当时不一定同版本。');
  }

  // ⑤ 每次 run 的结局：账本 run_end.status ↔ agent_runs.status（两边口径不同，映射写在下面）
  const dbRunById = new Map(dbRuns.map((r) => [String(r.id), r]));
  const outcomeDiff = [];
  const outcomeSeen = [];
  for (const key of new Set([...Object.keys(statsRuns), ...Object.keys(outcomeRuns)])) {
    const id = key.replace(/^run:/, '');
    const o = outcomeRuns[key] || {};
    if (id === '-') {
      // 轻量问答不登记现场（index.js 只在 !light 时 ensureRun），所以这里没有 agent_runs 行是**预期**的
      outcomeSeen.push('run:-（轻量问答，无现场）status=' + (o.status == null ? '—' : o.status));
      continue;
    }
    const row = dbRunById.get(id);
    if (!row) { outcomeDiff.push('run ' + id + '：账本有、agent_runs 无'); continue; }
    // 没收到 run_end 的 run（账本被截断/只流传了一段）：拦下来，不能因为它"没错"就静默放过
    if (o.status == null) { outcomeDiff.push('run ' + id + '：账本里没有 run_end（库 status=' + row.status + '，无法核对结局）'); continue; }
    // 账本 status(saved/stopped/error) → 库 status(completed/interrupted/paused) 的既有口径
    const expect = o.status === 'saved' ? ['completed'] : (o.status === 'stopped' ? ['interrupted'] : ['interrupted', 'paused']);
    if (expect.includes(String(row.status))) outcomeSeen.push('run ' + id + '=' + o.status + (o.guard ? '(guard=' + o.guard + ')' : ''));
    else outcomeDiff.push(`run ${id}：账本 ${o.status}${o.guard ? '(guard=' + o.guard + ')' : ''} / 库 ${row.status}`);
  }
  checks.push({
    name: 'run 结局（run_end.status ↔ agent_runs.status）',
    ok: outcomeDiff.length === 0,
    detail: outcomeDiff.length ? outcomeDiff.join('；') : (outcomeSeen.join('、') || '（无 run 可核）'),
  });

  return { checks, notes };
}
