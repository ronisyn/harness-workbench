// src/eventstream.js - RA-37 事件流客户端重建器（纯函数，零依赖；浏览器与 Node 共用）
// 依据《RW-Agent 架构 v1.1》§14.9：
//   RA-37 **事件契约成文**（事件类型/语义/版本）；**任一客户端仅靠事件流可重建全过程**；
//          断线重连不丢现场、停/挂/续可用
//
// 为什么要有这个文件（而不是只写一份契约文档）：
//   "仅靠事件流重建"是**可证伪**的主张——要么有一个消费者真能从帧里拼出全过程，要么没有。
//   本模块就是那个消费者：它只吃 `{type, ...}` 事件对象，不碰 HTTP、不碰 DOM、不碰数据库，
//   因此可以在夹具里被喂合成流、也可以被真实 SSE 抓包喂，用同一段代码验证两种输入。
//
// 契约要点（详见 docs/事件契约.md）：
//   · 判别字段是 `type`；帧为 `data: <json>\n\n`，带序号的事件另有 `id: <seq>` 行。
//   · `run_start` 开段，`run_end` 收段并给出**落库回执**（messageId 等）——两者构成执行边界。
//   · 正文重建 = 顺序拼接全部 `delta`。服务端保证这个拼接结果与 `messages.content` 一致（补流对账，见 index.js）。
//   · 事件载荷含 `v`（协议版本）；未知 type 必须被忽略而不是让消费方崩掉（契约只增不改）。

export const EVENT_PROTOCOL_VERSION = 1;

/** 解析 SSE 原始文本 → 事件对象数组（只取 data: 行；id: 行作为 _seq 挂在事件上）。 */
export function parseSse(text) {
  const out = [];
  let id = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('id:')) { id = Number(line.slice(3).trim()) || null; continue; }
    if (line.startsWith(':')) continue; // 注释/心跳帧（`: ping`）
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    let obj = null;
    try { obj = JSON.parse(payload); } catch { continue; }
    if (id != null) obj._seq = id;
    out.push(obj);
    id = null;
  }
  return out;
}

export function createRunView() {
  return {
    protocol: EVENT_PROTOCOL_VERSION,
    runId: null, conversationId: null, provider: null, model: null, light: null,
    status: 'idle',           // idle | running | done | stopped | error
    endReason: null,          // run_end.reason（user | disconnect | exception | saved）
    answer: '',               // delta 顺序拼接 —— 应与 messages.content 逐字一致
    thoughts: [],             // think 片段
    tools: [],                // [{ seq, name, args, status, durationMs, result, sub }]
    plans: [],                // 最近一次 plan 快照
    approvals: [],            // 待确认清单（RA-26：与"执行中"是两个状态）
    asks: [],                 // 待答复清单
    wait: null,               // 当前等待项 { kind:'approval'|'ask', id, round }（null=不在等待）
    waitedMs: 0,              // 等待累计时长（RA-26 四面④：不算执行用时）
    lastWait: null,
    warnings: [],             // fake_done_warn 等如实告知类
    rounds: 0,
    usage: null,              // 最后一轮
    totals: null,             // 全量（RA-37 G4）
    spentYuan: null,
    messageId: null,          // 落库回执（run_end.messageId）
    contentLength: null,
    unknownTypes: [],         // 契约只增不改：未知事件被忽略但留痕，便于发现版本漂移
    gaps: [],                 // 序号跳变（断线/丢帧）
  };
}

/** 事件 → 新视图（纯函数：不改入参，返回新对象）。未知 type 一律忽略并记录。 */
export function applyEvent(view, ev) {
  const v = { ...view };
  if (!ev || typeof ev !== 'object') return v;
  v.tools = view.tools; v.thoughts = view.thoughts; v.approvals = view.approvals; v.asks = view.asks;
  v.warnings = view.warnings; v.gaps = view.gaps; v.unknownTypes = view.unknownTypes;
  // 序号连续性（只对有 _seq 的事件判定；无序号的事件不参与，避免把心跳算成丢帧）
  if (ev._seq != null) {
    const last = v.__lastSeq;
    if (last != null && ev._seq !== last + 1) v.gaps = [...view.gaps, { from: last, to: ev._seq }];
    v.__lastSeq = ev._seq;
  }
  switch (ev.type) {
    case 'run_start':
      v.runId = ev.runId ?? null; v.conversationId = ev.conversationId ?? null;
      v.provider = ev.provider ?? null; v.model = ev.model ?? null; v.light = ev.light ?? null;
      v.status = 'running'; v.answer = ''; v.thoughts = []; v.unknownTypes = [];
      return v;
    case 'delta':
      v.answer = view.answer + String(ev.delta ?? '');
      return v;
    case 'think':
      v.thoughts = [...view.thoughts, String(ev.text ?? '')];
      return v;
    case 'thinking':
      v.rounds = Number(ev.round) || view.rounds;
      return v;
    case 'tool_start':
      v.tools = [...view.tools.filter((t) => !(t.seq === ev.tool.seq && t.name === ev.tool.name)), { ...ev.tool, status: ev.tool.status || 'running' }];
      return v;
    case 'tool_done': {
      const key = (t) => t.seq === ev.tool.seq && t.name === ev.tool.name;
      const others = view.tools.filter((t) => !key(t));
      v.tools = [...others, { ...ev.tool }].sort((a, b) => (a.seq || 0) - (b.seq || 0));
      return v;
    }
    case 'plan':
      v.plans = Array.isArray(ev.plan) ? ev.plan : [];
      return v;
    case 'approval':
      // RA-26：等待人工确认 —— 这是一种**状态**，不是"还在跑"
      v.approvals = [...view.approvals.filter((a) => a.id !== ev.id), { id: ev.id, desc: ev.desc }];
      v.status = 'waiting-approval';
      return v;
    case 'ask':
      v.asks = [...view.asks.filter((a) => a.id !== ev.id), { id: ev.id, question: ev.question, options: ev.options }];
      v.status = 'waiting-answer';
      return v;
    case 'wait_start':
      // RA-26：等待人工确认/答复 = 独立状态。进入即离开"执行中"，退出即恢复。
      v.wait = { kind: (ev.wait && ev.wait.kind) || 'unknown', id: ev.wait && ev.wait.id, round: ev.wait && ev.wait.round };
      v.status = v.wait.kind === 'ask' ? 'waiting-answer' : 'waiting-approval';
      return v;
    case 'wait_end':
      v.waitedMs = (view.waitedMs || 0) + (Number(ev.wait && ev.wait.ms) || 0);
      v.lastWait = { ...(ev.wait || {}) };
      v.wait = null;
      v.status = 'running';
      return v;
    case 'fake_done_warn':
      v.warnings = [...view.warnings, String(ev.text ?? '')];
      return v;
    case 'done':
      v.usage = ev.usage || null;
      v.totals = ev.totals || null;
      v.runId = ev.runId ?? v.runId;
      v.messageId = ev.messageId ?? v.messageId;
      v.status = v.status === 'waiting-approval' || v.status === 'waiting-answer' ? v.status : 'done';
      return v;
    case 'stopped':
      v.status = 'stopped';
      return v;
    case 'error':
      v.status = 'error'; v.endReason = String(ev.message ?? '');
      return v;
    case 'run_end':
      v.status = ev.status === 'saved' ? 'done' : (ev.status || v.status);
      v.endReason = ev.reason || ev.status || null;
      v.messageId = ev.messageId ?? v.messageId;
      v.contentLength = ev.contentLength ?? v.contentLength;
      if (ev.totals) v.totals = ev.totals;
      if (ev.usage) v.usage = ev.usage;
      if (ev.spentYuan != null) v.spentYuan = ev.spentYuan;
      v.runId = ev.runId ?? v.runId;
      return v;
    case 'intent':
    case 'route':
      // 灰字提示类：不影响重建，客户端可显示；契约里明确它们是"提示"，不承载事实
      v[ev.type] = ev;
      return v;
    case 'llm_retry':
      // 2026-09-16：厂商侧失败后的重试（统一失败分类/重试）。它**是事实**（这次执行真的重试过），
      // 但不改变重建出的答案/状态——记进 retries 供界面与复盘看，避免落进 unknownTypes（那会掩盖真实漂移）。
      v.retries = [...(v.retries || []), ev.retry];
      return v;
    default:
      v.unknownTypes = [...view.unknownTypes, String(ev.type)];
      return v;
  }
}

/** 从任意事件数组（或 SSE 原文）重建运行视图。 */
export function rebuild(input) {
  const events = typeof input === 'string' ? parseSse(input) : (Array.isArray(input) ? input : []);
  let view = createRunView();
  for (const ev of events) view = applyEvent(view, ev);
  return view;
}

/**
 * RA-37 保真判定：把"事件流重建出来的东西"与服务端事实对账。
 * 纯函数——ground truth 由调用方提供（夹具用合成真值，实测脚本用 DB 查出来的真值）。
 * @param {object} view rebuild() 的结果
 * @param {{storedContent?:string, messageId?:number|null, usageRounds?:number, usageCost?:number}} truth
 * @returns {{ok:boolean, checks:Array<{name:string, ok:boolean, detail:string}>}}
 */
export function verifyRebuild(view, truth = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail) });
  add('开段事件', view.runId !== null || view.conversationId !== null, 'run_start 是否给了执行边界（runId=' + view.runId + '）');
  add('收段事件', view.contentLength !== null, 'run_end 是否给了落库回执（messageId=' + view.messageId + '）');
  if (truth.storedContent != null) {
    add('正文逐字一致', view.answer === truth.storedContent,
      '重建 ' + view.answer.length + ' 字符 / 落库 ' + String(truth.storedContent).length + ' 字符');
  }
  if (truth.messageId !== undefined) add('落库 id 对账', view.messageId === truth.messageId, '事件 ' + view.messageId + ' / 库 ' + truth.messageId);
  if (truth.usageRounds != null) add('轮次对账', view.rounds === truth.usageRounds, '事件 ' + view.rounds + ' / 库 ' + truth.usageRounds);
  if (truth.usageCost != null && view.totals) {
    add('全量成本对账', Math.abs(Number(view.totals.cost) - Number(truth.usageCost)) < 0.02 + Number(truth.usageCost) * 0.2,
      '事件累计 ¥' + view.totals.cost + ' / 库累计 ¥' + truth.usageCost);
  }
  add('无丢帧', view.gaps.length === 0, view.gaps.length ? JSON.stringify(view.gaps) : '序号连续');
  add('无未知事件类型', view.unknownTypes.length === 0, view.unknownTypes.join(',') || '契约内');
  if (truth.waitedMs != null) {
    add('等待时长对账', Math.abs((view.waitedMs || 0) - Number(truth.waitedMs)) < 1000,
      '事件累计 ' + (view.waitedMs || 0) + 'ms / 账上 ' + truth.waitedMs + 'ms（RA-26 四面④）');
  }
  return { ok: checks.every((c) => c.ok), checks };
}
