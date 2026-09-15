// server/channels/run-turn.js - 渠道（飞书/微信）「跑一轮并落账」的**共享入口**（2026-09-16）
//
// 为什么要有这个文件（v0.3 §4.7 的 G5 四要素之一「**跨端一致**（GUI/飞书/API 同一套语义）」，对应核对报告
// `proposals/v0.3-符合性核对-20260916.md` §3.5 缺陷①）：
//   改前，飞书（`feishu-webhook.js:110-128`）与微信（`wechat.js:54-73`）各自拼历史、**直调 runAgent 且不传 emit**，
//   于是渠道会话：没有 run_start/run_end/工具事件/审批/问询/成本事件（**可观测**缺）、不能停也不能续订
//   （**可控制**缺）、没有投递记录（**可信**缺，失败无处落账），还各自硬编码
//   `provider:'deepseek', model:'deepseek-v4-flash'`。三端当时只共用 `runAgent` 一个内核。
//   现在两个渠道都走这里：**适配器薄（只做平台协议与转发）、语义统一在核**——这正是 DSH 的分法
//   （`dsh-webhook` 是进程内 fire-and-forget 的核，每个来源一个薄适配器如 `dsh-webhook-github`；
//   其 README 明确"不存在队列、重放或重试"）。所以这里**刻意不加队列/重试/去重**：那是 v0.3 §7.1 ㉒㉓㉔ 的范围。
//
// 与 `POST /api/chat` 的关系（**不复制、也不改它**）：
//   · 相同：会话归属、消息落库顺序（先 user、再拼历史、再跑）、`runAgent` 的 emit 契约与事件形状、
//     事件账本（`server/eventlog.js` 的 `persistEvent`，唯一写入点）、投递记录（`beginDelivery`/`finishDelivery`）、
//     现场登记（`runtrack` 的 ensureRun/markRun）、失败码口径（`server/failures.js`）、
//     run_end 的 status 判据（saved/stopped/paused/guard，与 `server/index.js` 同判据）。
//   · 不同（**如实说明，别当成同一个东西**）：
//     ① 渠道是请求-响应（飞书 webhook 3 秒内必须回 200 / 微信 on('message')），**没有长连接**，
//        所以没有 SSE、没有 `done` 帧、没有"流终结"语义；这里的"结果"就是函数的返回值。
//     ② 因此**没有 `seq`**：`seq` 是 `server/agent.js` 内存事件环的计数器，那个环只服务 SSE 与 /activity；
//        渠道事件直接落账本（`events` 表），不带 seq。账本对 seq 没有唯一约束，缺失是允许的。
//     ③ **不做** /api/chat 的组装侧逻辑：前缀指纹落账、早期摘要、意图/路由灰字、知识/技能/错题注入、
//        壳 schema 裁剪、并发槽位、幂等键回放、model_telemetry 归集。（渠道现在也没有这些，
//        本轮只补"语义"，不改既有对外行为。）`failures.js` 的 `INTERNAL` 覆盖了 500 类故障那一族，
//        所以这里**不新造失败码**（不往那张表里加词——它是唯一出处，加词要另一处一起改）。
//     ④ `__light`：渠道**始终全量工具面**（改前未传 `__light` 即 falsy，就是全量）。本轮不动它，也不搬
//        /api/chat 的 `needsTools` 判据过来：那会改渠道行为，而"工具面会话内冻结"（§4.4.1 规则3）要求的是别来回翻。
//
// 依赖注入（`db`/`runAgent`/`persistEvent`/… 都可传）：与 `scripts/rw-run.mjs` 的 `runHeadless` 同一做法，
// 夹具因此可以**不碰真库、不调模型**就把这段语义钉死。
import { db as realDb } from '../db.js';
import { persistEvent as realPersistEvent } from '../eventlog.js';
import { beginDelivery, finishDelivery } from '../deliveries.js';
import { ensureRun, markRun, resumeHint } from '../runtrack.js';
import { config } from '../config.js';
import { findProvider, PROVIDERS } from '../llm/providers.js';
import { fail } from '../failures.js';
import { RW_WORKSPACE } from '../env.js';

// 平台侧的兜底模型（**不是渠道自己的硬编码**）：只有会话与会话属主都给不出模型时才落到这里。
// 出处是厂商注册表里 DeepSeek 的 `defaultModel`（`server/llm/providers.js:8`），注册表里取不到才退到这个名字。
const PLATFORM_FALLBACK_PROVIDER = 'deepseek';
const PLATFORM_FALLBACK_MODEL = (PROVIDERS.find((p) => p.id === PLATFORM_FALLBACK_PROVIDER) || {}).defaultModel || 'deepseek-v4-flash';

// ── 「可停」的最小实现（进程内，与 DSH 的 fire-and-forget 同寿命）──────────────────────────────
// 一个渠道轮次 = 一个 AbortController；abort 的原因走 signal.reason，与 /api/chat 的 'user' 同一口径。
// 边界如实写在契约文档里：**进程重启即失去中止能力**（activeTurns 是内存 Map），且本轮**没有**
// HTTP 停止入口——`POST /api/chat/stop` 读的是 `server/index.js` 的私有 abortMap（键 = `accountId:conversationId`，
// 渠道会话的 account_id 为 NULL），本文件按"外科手术式改动"的约束不去改它，故渠道会话的
// "点停止"入口留待接线（见契约文档「已知限制」）。
const activeTurns = new Map(); // conversationId → { controller, channel, startedAt }

/** 运行中的渠道轮次（诊断/自检用；只读快照） */
export function activeChannelTurns() {
  return [...activeTurns.entries()].map(([conversationId, t]) => ({ conversationId, channel: t.channel, startedAt: t.startedAt }));
}

/**
 * 中止指定会话正在跑的那一轮（渠道会话"停止"的**进程内**入口）。
 * @returns {boolean} 是否真的找到并中止了一个在跑的轮次（没找到不算错——轮次可能刚好跑完）。
 */
export function abortChannelTurn(conversationId, reason = 'user') {
  const t = activeTurns.get(conversationId);
  if (!t) return false;
  t.controller.abort(reason);
  return true;
}

// ── 模型解析：渠道**不硬编码模型** ────────────────────────────────────────────────────────────
// 口径与 /api/chat 的优先级**前两级**一致（`server/index.js:754-765`）：会话保存的 provider/model 优先，
// 未设才落到平台侧默认。刻意**不搬**后两级（任务档案点名 / 壳默认）——那要读壳与档案，正是"复制 /api/chat 一大段"。
// `'auto'` / `'__auto__'` 是前端"自动路由"哨兵，与平台侧同样归一为"未设"。
// `settings.default_models`（P7/F6c）也读：那是平台**配置的**默认，不算渠道发明的数。
async function resolveModel(conv, db) {
  const convProvider = (conv.provider === 'auto') ? null : (conv.provider || null);
  const convModel = (conv.model === '__auto__') ? null : (conv.model || null);
  let overrides = null;
  try {
    const rows = await db.query('SELECT svalue FROM settings WHERE skey=?', ['default_models']);
    if (rows[0]) { const v = JSON.parse(rows[0].svalue); if (v && typeof v === 'object') overrides = v; }
  } catch { overrides = null; } // 读不到就不覆盖：下面还有厂商默认
  const provider = convProvider || PLATFORM_FALLBACK_PROVIDER;
  const p = findProvider(provider);
  const model = convModel || (overrides && overrides[provider]) || (p && p.defaultModel) || PLATFORM_FALLBACK_MODEL;
  return { provider, model };
}

/** 拿得到 key 的厂商才敢用（与 /api/chat 的"未配 Key → 回落 DeepSeek"同口径，且**出声**，不静默换模型）。 */
function withKeyGuard(provider, model, keys) {
  const p = findProvider(provider);
  if (!p) return { provider: PLATFORM_FALLBACK_PROVIDER, model: PLATFORM_FALLBACK_MODEL, note: '未登记的厂商 ' + provider + ' → 回落平台默认' };
  if (keys && keys[p.keyEnv]) return { provider, model, note: null };
  if (provider === PLATFORM_FALLBACK_PROVIDER) return { provider, model, note: null }; // 兜底厂商本就没 key：照跑，由 LLM 层如实报错
  return { provider: PLATFORM_FALLBACK_PROVIDER, model: PLATFORM_FALLBACK_MODEL, note: '厂商 ' + provider + ' 未配置 Key → 回落平台默认（如实告知，不冒充）' };
}

/**
 * 渠道一轮：**取会话 → 落用户消息 → 拼历史 → 带 emit 跑一轮 → 落 assistant → 事件账本 + 投递记录**。
 *
 * @param {object} o
 * @param {string} o.channel           渠道名（'feishu' | 'wechat'；写进账本与结果，便于对账）
 * @param {number} o.conversationId    会话 id（归属口径由渠道自己的 findOrCreateConv 决定，本函数不建会话）
 * @param {string} o.text              用户消息原文
 * @param {string} [o.permission]      权限档；缺省用会话上存的（渠道既有口径就是会话权限）
 * @param {object} o.deps              依赖（生产入口传 makeChannelTurnDeps()，夹具传假的）
 * @returns {Promise<object>} 结构化结果（形状见 buildResult）
 */
export async function runChannelTurn({ channel, conversationId, text, permission = null, deps = {} }) {
  const {
    db = realDb, runAgent, persistEvent = realPersistEvent,
    keys = config.keys, RW_WORKSPACE: workspace = RW_WORKSPACE,
    beginDelivery: begin = beginDelivery, finishDelivery: finish = finishDelivery,
    ensureRun: ensure = ensureRun, markRun: mark = markRun, resumeHint: hintOf = resumeHint,
    now = () => Date.now(),
  } = deps;
  const t0 = now();
  if (!channel) throw new Error('runChannelTurn 缺 channel');
  if (!conversationId) throw new Error('runChannelTurn 缺 conversationId');
  if (!String(text || '').trim()) throw new Error('runChannelTurn 缺 text');
  // 引擎（`server/agent.js`）**按需动态装载**，不在模块顶部静态 import：它一路拉起工具注册表
  //（`tools/index.js` → `tools/registry.js` 启动期校验），于是"只想读这一个文件的夹具"也会被工具清单的
  // 校验连坐（2026-09-16 实测：与本次改动无关的 timeoutMs 两处声明把夹具挡在 import 阶段）。
  // 依赖注入的默认值因此在这里补上（夹具给了 runAgent 就走夹具那份，绝不装载引擎）。
  if (!runAgent) runAgent = (await import('../agent.js')).runAgent;

  const rows = await db.query('SELECT id, account_id, permission, provider, model FROM conversations WHERE id=?', [conversationId]);
  if (!rows.length) {
    return failResult('CONV_NOT_FOUND', '会话不存在：' + conversationId, { channel, conversationId, durationMs: now() - t0 });
  }
  const conv = rows[0];
  const perm = permission || conv.permission || 'read'; // 渠道既有口径：会话档位（RW_CHANNEL_PERMISSION 在建会话时决定）

  // 投递记录：渠道没有幂等键（同一条消息只到一次，没有"重发同一个键"的入口），**但照记**——
  // "这一轮跑没跑完、什么时候、失败码是什么"本身就是可信面的证据（`server/deliveries.js:39-46` 支持无键落行）。
  let deliveryId = null;
  try {
    const begun = await begin({ accountId: conv.account_id ?? null, conversationId });
    deliveryId = begun && begun.id ? begun.id : null;
  } catch (e) {
    console.warn('[channel-turn] 投递记录建行失败（不影响本轮执行）：' + ((e && e.message) || e));
  }

  const ev = (obj) => { try { persistEvent(conversationId, obj); } catch { /* 账本异常不影响对话（与 /api/chat 的 send 同口径） */ } };
  // 用户消息先落库：与 /api/chat 同序（"用户说了什么"必须在账上，哪怕引擎随后就挂）
  await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conversationId, 'user', String(text)]);
  // 历史：**只追加、不滑窗**（v0.3 §4.4.1 规则1）——2026-09-16 核对报告 §3.5③ 已把 /api/chat 的滑窗删掉；
  // 渠道这段本来就没有滑窗（改前就是全量历史），保持原样。
  const hist = await db.query('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY id', [conversationId]);
  const messages = hist.map((m) => ({ role: m.role, content: m.content }));
  // 断点现场注入：与 /api/chat 同源（`server/index.js:1005-1009`）。**如实说明**：渠道会话里它现在几乎不触发——
  // 本入口每轮都 `markRun(completed)`，最新现场不会是 interrupted/paused；只有"服务重启时那一轮正在跑"
  // （`interruptStaleOnBoot`）才可能留下可恢复现场。留着这一步是为了不把这条路掐断，不是"已经能用"。
  try {
    const hint = await hintOf(conversationId);
    if (hint) messages.push({ role: 'system', content: hint });
  } catch { /* 现场读取失败不影响本轮 */ }

  const resolved = await resolveModel(conv, db);
  const { provider, model, note } = withKeyGuard(resolved.provider, resolved.model, keys);
  if (note) console.warn('[channel-turn] ' + channel + '：' + note);

  // 长任务现场（断点恢复外壳）：渠道改前**完全没有**现场登记，所以 ensureRun 是新增的事实；
  // 它不改变对外行为（只多一行 agent_runs/轮），却是"能不能基于现场继续"的前提。
  let run = null;
  try { run = await ensure({ conversationId, accountId: conv.account_id ?? null, goal: String(text) }); } catch { /* 现场登记失败不阻塞 */ }
  const runId = run ? run.id : null;

  // 事件三件套：run_start（盖渠道/厂商/模型/权限）→ 引擎侧 emit 原样落账 → 终结事件。
  // 形状与 /api/chat 的 send 一致（`server/index.js:1171-1174`、`1359-1366`、`1390-1395`、`1422-1423`）；
  // 只多一个 `channel` 字段——G5 要的正是"哪一端"，不加就分不出三端。
  ev({ type: 'run_start', v: 1, conversationId, runId, channel, provider, model, permission: perm });

  const controller = new AbortController();
  activeTurns.set(conversationId, { controller, channel, startedAt: t0 });
  const ctx = {
    permission: perm, accountId: conv.account_id ?? null, conversationId, root: workspace,
    __signal: controller.signal, __runId: runId, __light: false,
    mode: 'chat', preset: 'all', channel,
  };

  try {
    const outcome = await runAgent({ provider, model, messages, permission: perm, ctx, keys, emit: (e) => ev(e) });
    const stopped = !!outcome.stopped;
    const paused = !!outcome.paused;
    const guard = outcome.guard || null;
    const content = String(outcome.content || '');
    const usage = outcome.usage || {};
    // 停下来/挂起的原因：与 /api/chat 的 signal.reason 口径一致（'user' / 'disconnect'），
    // 渠道多一种 'abort'（进程内停止入口没给原因时的默认值）。
    const stopReason = (controller.signal && controller.signal.reason) || 'abort';
    const stopText = stopReason === 'user' ? '用户点击停止' : stopReason === 'disconnect' ? '连接断开' : '被中止（渠道进程内停止入口）';
    const status = stopped ? 'stopped' : paused ? 'paused' : (guard ? 'guard' : 'saved');

    let messageId = null;
    if (!stopped) {
      // 落 assistant（含 usage）：与 /api/chat 同一条 INSERT 形状（`server/index.js:1342-1346`），
      // 并在落库后把本轮未关联的工具调用回填到这条消息（历史回看用）。
      // 渠道不落 reasoning（改前也不落；本轮只补语义，不扩行为）。原子守卫防"并发删会话"产生孤儿消息。
      try {
        const r = await db.query(
          'INSERT INTO messages (conversation_id, role, content, model, provider, tokens_in, tokens_out) SELECT ?,?,?,?,?,?,? FROM conversations WHERE id=?',
          [conversationId, 'assistant', content, model || provider, provider, usage.tokens_in || 0, usage.tokens_out || 0, conversationId]);
        messageId = (r && r.insertId) || null;
        if (messageId) await db.query('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [messageId, conversationId]);
      } catch (e) {
        // 落库失败必须出声：回复仍会发出去（对外行为不变），但"账上少一条"这件事不能静默
        console.warn('[channel-turn] assistant 落库失败（' + channel + ' conv=' + conversationId + '）：' + ((e && e.message) || e));
      }
    }
    try {
      if (mark) {
        if (stopped) await mark(runId, 'interrupted', stopText);
        else if (paused) await mark(runId, 'paused', outcome.reason || '挂起');
        else if (guard) await mark(runId, 'interrupted', '护栏：' + guard);
        else await mark(runId, 'completed', '');
      }
    } catch { /* 现场状态登记失败不影响结果 */ }

    if (stopped) {
      ev({ type: 'stopped', v: 1, conversationId, runId, channel, reason: stopReason, reasonText: stopText });
      ev({ type: 'run_end', v: 1, conversationId, runId, channel, status: 'stopped', reason: stopReason, reasonText: stopText, messageId: null, totals: outcome.usageTotals || null });
      await finish(deliveryId, { state: 'failed', runId, error: stopText, errorCode: stopReason === 'user' ? 'STOPPED_BY_USER' : 'ABORTED' });
      return buildResult({ ok: false, status, channel, conversationId, runId, messageId: null, content: '', provider, model, usage: {}, outcome, error: fail('ABORTED', stopText), durationMs: now() - t0 });
    }

    // 终结回执：与 /api/chat 的 run_end 同字段（`usage` 只在非 stopped 分支出现——同平台侧口径）
    ev({
      type: 'run_end', v: 1, conversationId, runId, channel, status,
      messageId, contentLength: content.length, finishReason: outcome.finishReason || '', guard,
      usage, totals: outcome.usageTotals || null, spentYuan: outcome.spentYuan ?? null,
    });
    await finish(deliveryId, {
      state: 'succeeded', messageId, runId,
      // 存**接受结果**（与 /api/chat 的 response_json 同口径）：渠道没有回放入口，但"这一轮产出了什么"要留证
      response: { messageId, runId, content, usage },
    });
    // 挂起/护栏：这一轮**没有**产出可交付的回复，渠道会照旧把内容发出去（对外行为不变），
    // 但 `ok=false` + status 让调用方分得清"干完了"与"被拦住了"。**刻意不编失败码**：
    // failures.js 里没有"护栏拦截/无进展挂起"这两族（那是 §7.1 ⑨ 的仪表口径），不在这张表外另造词。
    const halted = paused || !!guard;
    return buildResult({
      ok: !halted, status, channel, conversationId, runId, messageId, content, provider, model, usage, outcome,
      error: halted ? { error: paused ? ('任务挂起：' + (outcome.reason || '无进展')) : ('护栏拦截：' + guard), code: null } : null,
      durationMs: now() - t0,
    });
  } catch (e) {
    // 失败**如实落账 + 结构化返回**（G5「可信」）：账本里要有终结事件，投递记录里要有码，
    // 返回值里要有 `failures.js` 登记的码——三处说的是同一件事，且都不是中文散文。
    const message = String((e && e.message) || e).slice(0, 300);
    console.error('[channel-turn] 本轮执行失败（' + channel + ' conv=' + conversationId + '）：' + ((e && e.stack) || message));
    try { ev({ type: 'error', v: 1, conversationId, runId, channel, message }); } catch { /* 忽略 */ }
    try { ev({ type: 'run_end', v: 1, conversationId, runId, channel, status: 'error', reason: 'exception', reasonText: message, messageId: null }); } catch { /* 忽略 */ }
    try { if (mark) await mark(runId, 'interrupted', '执行出错: ' + message.slice(0, 200)); } catch { /* 忽略 */ }
    await finish(deliveryId, { state: 'failed', runId, error: message, errorCode: 'INTERNAL' });
    return buildResult({ ok: false, status: 'error', channel, conversationId, runId, messageId: null, content: '', provider, model, usage: {}, outcome: null, error: fail('INTERNAL', message), durationMs: now() - t0 });
  } finally {
    // 只在"还是自己那一轮"时清理（同一会话并发两轮时，不该互相把对方的现场抹掉）
    const cur = activeTurns.get(conversationId);
    if (cur && cur.controller === controller) activeTurns.delete(conversationId);
  }
}

/** 结构化结果：成功与失败**同层同形**（调用方永远先看 ok）；码取自 `server/failures.js`，不另造词。 */
function buildResult({ ok, status, channel, conversationId, runId, messageId, content, provider, model, usage, outcome, error, durationMs }) {
  return {
    ok, status, channel, conversationId, runId, messageId, content,
    contentLength: String(content || '').length,
    provider, model,
    finishReason: (outcome && outcome.finishReason) || '',
    guard: (outcome && outcome.guard) || null,
    reason: (outcome && outcome.reason) || null,
    toolCalls: ((outcome && outcome.toolLog) || []).map((t) => ({ name: t.name, status: t.status, code: t.code || null, durationMs: t.durationMs ?? null })),
    usage: usage || {},
    totals: (outcome && outcome.usageTotals) || null,
    spentYuan: outcome ? (outcome.spentYuan ?? null) : null,
    error: error || null,
    durationMs,
  };
}

/** 早失败（还没跑到引擎）的结果：形状与 buildResult 同层，调用方不必分两种解析。 */
function failResult(code, message, extra) {
  return {
    ok: false, status: 'failed', error: fail(code, message),
    channel: null, conversationId: null, runId: null, messageId: null, content: '', contentLength: 0,
    provider: null, model: null, finishReason: '', guard: null, reason: null, toolCalls: [], usage: {}, totals: null, spentYuan: null,
    durationMs: 0,
    ...extra,
  };
}

/**
 * 生产入口的默认依赖。存在的理由：让渠道文件里不再出现数据库/账本/投递的散装调用，语义只有这一处。
 * 引擎（`server/agent.js`）在这里**动态装载**——理由见 runChannelTurn 里的注释（不把工具注册表的
 * 启动期校验连坐到只读本文件的调用方身上）。（夹具不调它——夹具自己给假依赖。）
 */
export async function makeChannelTurnDeps(over) {
  const { runAgent } = await import('../agent.js');
  return { db: realDb, runAgent, persistEvent: realPersistEvent, keys: config.keys, ...(over || {}) };
}
