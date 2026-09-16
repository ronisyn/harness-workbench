// server/selfeval/knowledge-sink.js —— 「受限自动沉淀」（v0.3 §4.3「记忆」行）的**提案那一半**（2026-09-16）
//
// ── 这一版为什么是"提案式"，而不是"自动写库" ─────────────────────────────────────────────
// v0.3 §4.3 的记忆行写着「全文检索（FTS5）打底 + 分层召回 + **受限自动沉淀**」，而 M3 铁律（§0.4 风险②
// 自我放行）要求"产出物只能是提案，改自己/写自己的事仍需人工审批"。两者并存的唯一合法形态就是本文件：
//   · 引擎在**合适的时机**产出"建议沉淀为知识"的**待审条目**（本文件只产出对象，**不写库**）；
//   · 待审条目走**既有**问询/审批流（`server/asks.js` 的 `createAsk` → GUI 的 `ask` 事件 / 渠道的
//     `onCard`，回答入口 `server/cards.js` 的 `answerCard` —— 与 `ask_user` 工具**同一条路**，没有第二套问答 API）；
//   · **人确认之后**才调 `writeKnowledge` 往 `knowledge` 表插一条（唯一写点，见下）。
// ⇒ 本模块的结构性保证：`proposeKnowledge` 里**没有**任何 INSERT（夹具锁这条）；
//    写库只可能发生在 `writeKnowledge`，而它的前置是"有人答了这张卡"。
//
// ── 挂在哪个时机（判断与理由，交付报告里同段说明）────────────────────────────────────────
//   选点：**会话收尾 / 复盘路径**——一轮活儿干完、摘要已经生成（`conv_summaries`）之后，那正是"这段经历里
//   哪些值得留下"最清楚、且不需要额外烧 token 去重读长历史的时刻。
//   不在**会话中途**挂：中途产条目会把还没定论的东西当经验沉淀（v0.3 §0.4 风险①"自我表演"）；
//   也不挂在"每轮"上：那等于给每一轮都加一次问询打断。
//   ✅ **接线状态（2026-09-17 已接）**：两个接线点都接上了，用的就是下面那句 `sinkSessionKnowledge(...)`：
//       · `/api/chat` 收尾处（成功分支，`run_end` 之后）：`await sinkSessionKnowledge({ conversationId, storage, dbc: db, emit: (card) => send(card) })`
//       · `scheduler.js` 自动归档处（`summarizeConversation` 之后，与"摘要刚生成"同一时机）：同一句，不传 `emit`
//         （那一端没有连着的客户端；卡片落在既有待答队列里，GUI 照常轮询得到）。
//     两处都包在自己的 try/catch 里：**失败/无候选一律静默跳过**，不许打扰（更不许弄坏）已经跑完的收尾。
//     （原文留痕：本模块此前如实登记"本批不动这两个文件"——那写的是当时的状态，接线由此行兑现。）
//
// ── 与既有知识写入的关系（口径只有一份，别抄第二遍）──────────────────────────────────────
//   · 工具 `kb_add`（`server/tools/index.js`）：模型在会话里主动写入的通道 —— 保持原样，本文件**不改它**；
//   · `POST /api/knowledge/import`：人上传导入的通道 —— 保持原样；
//   · 本文件：**引擎产出待审条目**的通道 —— 人确认后才 INSERT。三条通道都汇到同一张 `knowledge` 表，
//     列形状（account_id/scope/conversation_id/shell_id/kind/title/body/status）与 `kb_add` 逐字一致。
import { createAsk } from '../asks.js';
import { fingerprint } from './collect.js';
import { V03 } from './propose.js';

/** 待审条目的 kind：与 `knowledge.kind` 的既有枚举（fact/progress/guide/skill/lesson）同一份取值域。 */
export const SINK_KINDS = Object.freeze(['lesson', 'fact', 'guide', 'skill', 'progress']);
/** 沉淀去向的 scope：默认**壳私有**（本会话所属壳），没有壳才退到会话私有——不默认进全局。 */
const DEFAULT_SCOPE = 'shell';

/** 条目正文里必须能看出来的"这是提案、经人确认"的痕迹（与写库内容同源，便于事后对账）。 */
export const SINK_TAG = '受限自动沉淀（提案式，人确认后写入）';

/**
 * 从一段会话经历里抽"建议沉淀为知识"的候选（**纯函数**，不碰库、不碰文件、不调模型）。
 *
 * 为什么不做成"调模型总结"：那会让本模块变成一条**自动产出知识**的路径（M3 铁律要防的正是自动），
 * 而且会给每条候选都加一次模型成本。这里只用**结构性事实**当判据（与 `propose.js` 的规则同一口径：
 * 能用"有/无"判的，绝不拍一个阈值）：
 *   · 会话里出现过**完整复盘**（`复盘模板.md` 的小节标题）⇒ 复盘结论就是首选候选；
 *   · 失败后转成功（同一会话里先有 `status='fail'` 的工具调用、后有成功的）⇒ 这类"踩过的坑"是 lesson；
 *   · 用户明确说过"记住/以后都按/别再" ⇒ 这是约定类事实（fact）。
 * 抽不到就返回空数组——**空不是失败**，如实表示"这段经历里没有够格的候选"。
 *
 * @param {{conversationId?:number|string, messages?:Array, toolCalls?:Array, summary?:object|null, now?:Date}} input
 *   `messages`：`[{role, content}]`（会话消息；缺省空）；`toolCalls`：`[{tool_name, status}]`；
 *   `summary`：`conv_summaries` 的一行（有 `summary`/`content` 文本即可）。
 * @returns {Array<{kind, title, body, reason}>}
 */
export function candidatesFromSession({ conversationId = null, messages = [], toolCalls = [], summary = null } = {}) {
  const out = [];
  const text = (v) => String(v == null ? '' : v);
  const all = (messages || []).map((m) => text(m && m.content)).join('\n');
  const sumText = summary ? text(summary.summary || summary.content || summary.text) : '';

  // ① 复盘：会话里出现完整复盘的小节标题（docs/复盘模板.md 的三段）⇒ 首选候选
  const hasRetro = /(做得好|做得不好|改进项)/.test(all) && /(复盘|retro)/i.test(all);
  if (hasRetro || sumText) {
    const body = (sumText || all).slice(0, 4000);
    if (body.trim()) {
      out.push({
        kind: 'lesson',
        title: `会话 #${conversationId ?? '-'} 的复盘结论（待审）`,
        body,
        reason: sumText ? '会话摘要已在位（conv_summaries）' : '会话里已出现完整复盘三段',
      });
    }
  }

  // ② 失败后转成功：结构性事实（"有过失败，也有过成功"），不需要任何阈值
  const calls = toolCalls || [];
  const failed = new Set(calls.filter((c) => c && c.status === 'fail').map((c) => c.tool_name));
  const okd = new Set(calls.filter((c) => c && c.status === 'ok').map((c) => c.tool_name));
  const recovered = [...failed].filter((t) => okd.has(t));
  if (recovered.length) {
    out.push({
      kind: 'lesson',
      title: `会话 #${conversationId ?? '-'}：${recovered.slice(0, 3).join('、')} 失败后跑通了（待审）`,
      body: `这些工具在本会话里先失败后成功，值得把"踩了什么坑、怎么绕过去"记下来：${recovered.join('、')}`
        + (sumText ? `\n\n会话摘要：\n${sumText.slice(0, 2000)}` : ''),
      reason: '同一会话内出现"失败 → 成功"（结构性事实，不设阈值）',
    });
  }

  // ③ 用户下达过的长期约定（fact）：只在**用户轮**里找，且必须带明确的长期语气词
  const userLines = (messages || []).filter((m) => m && m.role === 'user').map((m) => text(m.content));
  const conventions = userLines.filter((l) => /(以后都|今后都|记住|别再|一律按|默认按|都要按)/.test(l));
  if (conventions.length) {
    out.push({
      kind: 'fact',
      title: `会话 #${conversationId ?? '-'}：用户下达的长期约定（待审）`,
      body: conventions.slice(0, 5).map((l) => '- ' + l.slice(0, 400)).join('\n'),
      reason: '用户在会话里明确说过"记住/以后都按…"这类长期约定',
    });
  }

  // 去重（同 kind + 同标题只留一条）并截断字段长度（与 knowledge 列口径一致：title 短、body 长文本）
  const seen = new Set();
  return out
    .filter((c) => { const k = c.kind + '\u0000' + c.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((c) => ({ ...c, title: c.title.slice(0, 200), body: c.body.slice(0, 8000) }));
}

/** 渲染问询卡片的题目与选项（**人看得懂的一句话 + 两个选项**）。 */
export function renderCard(candidate) {
  const question = `【受限自动沉淀·待你确认】建议把这条沉淀进知识库：\n`
    + `· 类型：${candidate.kind}\n· 标题：${candidate.title}\n· 依据：${candidate.reason}\n`
    + `（依据 ${V03} §4.3「受限自动沉淀」；**你不选就不会写入任何东西**）`;
  return {
    question: question.slice(0, 500),
    options: [
      { label: '写入知识库（global）', value: 'write:global' },
      { label: '写入知识库（本会话私有）', value: 'write:conv' },
      { label: '跳过这条', value: 'skip' },
    ],
  };
}

/**
 * 产出**待审条目**（v0.3 §4.3）：抽候选 → 建一张既有问询卡（`server/asks.js` 的 `createAsk`）→ 卡片经
 * `opts.emit` 交给**既有**的出口（GUI 的 `ask` 事件 / 渠道的 `onCard`）。
 *
 * ⚠️ 本函数**不写任何库**：返回的 `pending` 里只有条目对象与卡片 id；写库要等 `writeKnowledge`
 *    （它的前置＝有人答了这张卡）。这正是"M3 铁律：全程无自我放行"在代码上的形态。
 *
 * @param {object} o
 *   · `conversationId` —— 卡片归属（跨端一致要靠它把卡发到人所在的端、也把回答对回这张卡）；
 *   · `messages` / `toolCalls` / `summary` —— 见 `candidatesFromSession`；
 *   · `emit` —— **可选**出口（形状同 `ask_user` 工具用的那个：`emit({type:'ask', id, question, options})`）；
 *   · `createAskFn` —— 夹具缝（默认＝`server/asks.js` 的 `createAsk`，不传就动真的待答队列）；
 *   · `now` —— 评估时刻（只用于记录，不参与判据）。
 * @returns {{conversationId:number|null, pending:Array, created:Array, skipped:Array, errors:string[]}}
 */
export function proposeKnowledge({
  conversationId = null, messages = [], toolCalls = [], summary = null,
  emit = null, createAskFn = createAsk, now = new Date(),
} = {}) {
  const errors = [];
  let candidates = [];
  try { candidates = candidatesFromSession({ conversationId, messages, toolCalls, summary }); }
  catch (e) { errors.push('抽候选失败：' + String((e && e.message) || e)); }

  const pending = [];
  const created = [];
  for (const c of candidates) {
    const id = fingerprint('knowledge-sink', conversationId, c.kind, c.title);
    const card = renderCard(c);
    const entry = {
      id, conversationId, kind: c.kind, title: c.title, body: c.body,
      fingerprint: id, reason: c.reason, status: 'pending',
      // 写库时才用的字段先算好（人确认后不再重新解释一遍口径）
      scopeDefault: DEFAULT_SCOPE, tag: SINK_TAG, proposedAt: now.toISOString(),
    };
    pending.push(entry);
    try {
      const ap = createAskFn(card.question, card.options, { conversationId });
      entry.askId = ap && ap.id ? ap.id : null;
      created.push(entry.id);
      // 出口用的是**既有**的那个：`ask_user` 工具发 `{type:'ask'}`，渠道由 `run-turn.js` 换成 onCard
      if (typeof emit === 'function') emit({ type: 'ask', id: entry.askId, question: card.question, options: card.options, sink: entry.id });
    } catch (e) {
      errors.push('建卡片失败（' + c.title + '）：' + String((e && e.message) || e));
    }
  }
  return {
    conversationId: conversationId == null ? null : Number(conversationId),
    pending, created, errors,
    skipped: candidates.length ? [] : ['没有够格的候选：这段经历里没有复盘三段/失败转成功/长期约定（空不是失败，如实表示没有可沉淀的）'],
  };
}

/** 答卡结果 → 裁决（纯函数）：只认本模块给出的三个选项，**别的答案（超时/取消/杂文本）一律不写**。 */
export function decisionOf(answer) {
  const a = String(answer == null ? '' : answer).trim();
  if (a === 'skip') return { write: false, reason: '用户选择跳过' };
  if (a === 'write:global') return { write: true, scope: 'global', reason: '用户确认写入全局' };
  if (a === 'write:conv') return { write: true, scope: 'conv', reason: '用户确认写入本会话私有' };
  return { write: false, reason: a ? '答复不在选项内（' + a.slice(0, 40) + '）⇒ 不写' : '没有答复（超时/取消）⇒ 不写' };
}

/**
 * **唯一写点**：有人确认之后，把一条待审条目写进知识库。
 *
 * 为什么不复用 `kb_add` 工具的代码：那个工具的入口在 `server/tools/index.js`（本批不动，且它面向模型调用、
 * 带覆盖/冲突判定与 `source` 语义）。这里只需要最朴素的 INSERT，列形状与它**逐字一致**，
 * 且口径就在这一处——不复制它那套冲突判定（那会让"沉淀"多出第二份语义）。
 *
 * 2026-09-17：写口从"直连 SQL 的库句柄"改成**存储接口**（v0.3 §4.1「存储走接口」）——干净机器上
 * 也要能沉淀（此前只有 MySQL 一条路）。字段形状一字未改，换的只是介质入口。
 *
 * 前置（缺一个就抛，绝不静默写）：`entry.title`、`entry.body`、`decision.write===true`、`accountId`。
 *
 * @param {object} entry `proposeKnowledge` 产出的待审条目
 * @param {{answer:string}} o 人在卡片上给的答复（经 `decisionOf` 解释）
 * @param {{store:object, accountId:number, conversationId?:number, shellId?:number|null, kind?:string}} deps
 * @returns {Promise<{written:boolean, id?:number, scope?:string, reason:string}>}
 */
export async function writeKnowledge(entry, { answer, store, accountId, conversationId = null, shellId = null, kind = null } = {}) {
  const d = decisionOf(answer);
  if (!d.write) return { written: false, reason: d.reason };
  if (!entry || !String(entry.title || '').trim() || !String(entry.body || '').trim()) {
    throw new Error('拒绝写入：待审条目缺 title/body（空条目不是知识）');
  }
  if (!store || !store.knowledge || typeof store.knowledge.append !== 'function') throw new Error('拒绝写入：没有可用的存储句柄（store）');
  if (!accountId) throw new Error('拒绝写入：knowledge.account_id 需要账号（无人确认的自动写入不在此列——本函数必须由人的确认驱动）');
  const scope = d.scope;
  const kindCode = kind || entry.kind || 'lesson';
  if (!SINK_KINDS.includes(kindCode)) throw new Error('拒绝写入：kind 不在既有取值域内（' + kindCode + '）');
  // 正文带上"来源 + 待审指纹 + 确认痕迹"：事后对账要能看出这条是怎么来的（与 selfeval 的 fprint 同口径）
  const body = `> ${SINK_TAG}｜来源：会话 #${entry.conversationId ?? conversationId ?? '-'}｜依据：${V03} §4.3｜指纹：${entry.fingerprint || entry.id}\n\n${entry.body}`;
  const r = await store.knowledge.append({
    accountId,
    scope,
    conversationId: scope === 'conv' ? (entry.conversationId ?? conversationId ?? null) : null,
    shellId: scope === 'shell' ? (shellId ?? null) : null,
    kind: kindCode,
    title: String(entry.title).slice(0, 200),
    body: body.slice(0, 8000),
    status: 'active',
  });
  return { written: true, id: (r && r.id) || null, scope, reason: d.reason };
}

/** 逗号分隔的"本批挂了哪些卡"（日志/报告用；空则如实说没有候选）。 */
export function describeProposals(result) {
  if (!result) return '（无结果）';
  if (!result.pending.length) return '待审条目 0 条：' + (result.skipped[0] || '没有候选');
  return '待审条目 ' + result.pending.length + ' 条（' + result.pending.map((p) => p.kind + ':' + p.title).join('；')
    + '）· 卡片 ' + result.created.length + ' 张（人确认后才写库）'
    + (result.errors.length ? ' · ⚠️ ' + result.errors.join('；') : '');
}

// ── 接线用的两件（2026-09-17 新增；`proposeKnowledge` 与写库路径**一个字都没动**）────────────────────
// 为什么把"取数"也放这里：两个接线点（/api/chat 收尾、scheduler 自动归档）需要的是**同一份**会话经历，
// 各写一份就会长出第二套口径（哪几列算"经历"、状态词怎么对）。所以取数只有这一处，两边都调它。

/**
 * 会话经历 → 候选抽取认的三样（**只读**，全部走既有接口）。
 *   · `messages`  —— 存储接口 `messages.history(id)`（上下文口径：升序、全量）；
 *   · `toolCalls` —— 存储接口 `toolCalls.list(id)`，**只取工具名与成败**（不把结果正文读进来）；
 *   · `summary`   —— `conv_summaries` 那一行（有则当候选①的依据，没有就 null）。
 * ⚠️ 状态词的映射只在这一处：工具账本里落的是 `done|fail`（见 tools/index.js 落 tool_calls 那句），
 *    而候选抽取认的是 `ok|fail`（见 `candidatesFromSession` 的 ②）。映射只做 `done ⇒ ok`，
 *    其余状态**原样交出去**（不把 pruned/未知状态假扮成成功，它们因此不会被算进"失败后跑通"）。
 * 任一来源取不到 ⇒ 那一项如实为空、原因进 `errors`（缺不是失败：候选抽取本来就允许抽不到）。
 * @returns {Promise<{messages:Array, toolCalls:Array, summary:object|null, errors:string[]}>}
 */
export async function loadSessionForSink(conversationId, { storage = null, dbc = null } = {}) {
  const err = (e) => String((e && e.message) || e);
  const out = { messages: [], toolCalls: [], summary: null, errors: [] };
  const cid = Number(conversationId);
  if (!Number.isFinite(cid) || cid <= 0) { out.errors.push('会话 id 不合法：' + conversationId); return out; }
  try {
    if (storage && storage.messages && typeof storage.messages.history === 'function') {
      out.messages = (await storage.messages.history(cid)) || [];
    } else out.errors.push('没有可用的存储句柄（storage.messages.history）');
  } catch (e) { out.errors.push('读会话消息失败：' + err(e)); }
  try {
    if (storage && storage.toolCalls && typeof storage.toolCalls.list === 'function') {
      const rows = (await storage.toolCalls.list(cid)) || [];
      out.toolCalls = rows.map((r) => ({
        tool_name: (r && (r.toolName ?? r.tool_name)) ?? null,
        status: r && r.status === 'done' ? 'ok' : String((r && r.status) == null ? '' : r.status),
      }));
    } else out.errors.push('没有可用的存储句柄（storage.toolCalls.list）');
  } catch (e) { out.errors.push('读工具调用失败：' + err(e)); }
  try {
    if (dbc && typeof dbc.query === 'function') {
      const r = await dbc.query('SELECT summary FROM conv_summaries WHERE conversation_id=?', [cid]);
      out.summary = (Array.isArray(r) && r[0]) || null;
    } else out.errors.push('没有可用的库句柄（读 conv_summaries）');
  } catch (e) { out.errors.push('读会话摘要失败：' + err(e)); }
  return out;
}

/**
 * **接线点的那一句话**：会话收尾/复盘那一刻 → 取数 → `proposeKnowledge`（产出**待审卡片**，不写库）。
 *
 * 产出的卡片走**既有** asks 队列（`server/asks.js`），所以：有人答了卡之后才轮到 `writeKnowledge`，
 * 本函数自己**没有任何 INSERT**（夹具对整份源码锁这一条）。
 * 本函数**不抛错给收尾路径**：取数逐项 try（缺项进 `result.errors`，不中断），
 * `proposeKnowledge` 内部对每个候选也各自 try。调用方只需包一层 try/catch 记一行日志即可。
 *
 * @param {object} o
 *   · `conversationId` 必填；
 *   · `storage` / `dbc` —— 取数用的两个句柄（前者读消息与工具调用，后者读摘要）；
 *   · `emit` —— 卡片出口（GUI 的 `ask` 事件 / 渠道的 onCard；不传就只挂队列、不发帧）；
 *   · `createAskFn` —— 夹具缝（默认＝`createAsk`）；
 *   · `now` —— 记录时刻（不参与判据）。
 * @returns {Promise<object>} `proposeKnowledge` 的返回值（`errors` 里已并入取数缺项）
 */
export async function sinkSessionKnowledge({
  conversationId, storage = null, dbc = null, emit = null, createAskFn = createAsk, now = new Date(),
} = {}) {
  const data = await loadSessionForSink(conversationId, { storage, dbc });
  const result = proposeKnowledge({
    conversationId, messages: data.messages, toolCalls: data.toolCalls, summary: data.summary,
    emit, createAskFn, now,
  });
  result.errors.push(...data.errors);
  return result;
}
