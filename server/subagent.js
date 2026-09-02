// server/subagent.js - 子代理（F16/F17）：主代理可派生子代理独立执行任务
// 设计：子代理复用 runAgent 完整循环（自带工具 + 完成度判断 + 护栏）；
//       同步模式=等结果；异步模式=立即返回 id，用 subagent_output 轮询取结果。
//       子代理内部工具步骤实时转发给前端（事件名前缀 "子:"），并落 tool_calls 留痕。
import { runAgent } from './agent.js';

export const subs = new Map(); // id -> { status: running|done|error, prompt, name, result, error, createdAt }
let subSeq = 0;

// 长期运行护栏：finished 记录保留 2 小时；超过 300 条时淘汰最老的已完成项
const SUB_TTL_MS = 2 * 60 * 60 * 1000;
const SUB_MAX = 300;
export function pruneSubs() {
  const now = Date.now();
  let doneCount = 0;
  for (const [id, s] of subs) {
    if (s.status !== 'running' && now - new Date(s.createdAt).getTime() > SUB_TTL_MS) subs.delete(id);
    else if (s.status !== 'running') doneCount++;
  }
  if (doneCount > SUB_MAX) {
    const finished = [...subs.entries()].filter(([, s]) => s.status !== 'running')
      .sort((a, b) => new Date(a[1].createdAt) - new Date(b[1].createdAt));
    for (const [id] of finished.slice(0, doneCount - SUB_MAX)) subs.delete(id);
  }
}

export function makeSubId() {
  subSeq += 1;
  return 'sub-' + subSeq + '-' + Date.now().toString(36);
}

function cap(s, n) { return String(s || '').slice(0, n); }

// 转发子代理内部事件给前端（前缀标记，展示为 "子:工具名"，与 3080 子卡等效的直播效果）
function childEmit(parentEmit, subId, label) {
  if (!parentEmit) return null;
  return (ev) => {
    if (ev.type === 'tool_start') parentEmit({ type: 'tool_start', tool: { name: '子:' + ev.tool.name, args: ev.tool.args, seq: ev.tool.seq, status: 'running', sub: subId } });
    else if (ev.type === 'tool_done') parentEmit({ type: 'tool_done', tool: { ...ev.tool, name: '子:' + ev.tool.name, sub: subId } });
    else if (ev.type === 'think') parentEmit({ type: 'think', text: '[' + label + '思考] ' + ev.text });
    else if (ev.type === 'approval') parentEmit({ type: 'approval', id: ev.id, desc: '[' + label + '] ' + ev.desc });
    else if (ev.type === 'agent_thinking') parentEmit({ type: 'agent_thinking', round: ev.round, sub: subId });
  };
}

export async function spawnSubagent({ prompt, name, provider, model, permission = 'full', parentCtx = {}, keys, temperature = 1.0, depth = 0 }) {
  pruneSubs();
  const id = makeSubId();
  const record = { id, status: 'running', prompt: cap(prompt, 2000), name: name || '子代理', createdAt: new Date().toISOString(), depth };
  subs.set(id, record);
  // 子代理上下文：继承会话与账号，禁止再无限套娃（depth>=3 时子代理不暴露子代理工具）
  const childCtx = {
    ...parentCtx,
    permission,
    depth: (parentCtx.depth || 0) + 1,
    skills: parentCtx.skills || {},
    noSubagent: (parentCtx.depth || 0) + 1 >= 3,
  };
  const t0 = Date.now();
  const runPromise = runAgent({
    provider, model, permission,
    messages: [{ role: 'user', content: prompt }],
    ctx: childCtx, keys, temperature,
    emit: childEmit(parentCtx.__emit, id, record.name),
  });
  const settle = async () => {
    try {
      const r = await runPromise;
      record.status = 'done';
      record.durationMs = Date.now() - t0;
      record.result = r.content;
      record.usage = r.usage || {};
      record.toolLog = (r.toolLog || []).slice(-15).map((t) => ({ name: t.name, status: t.status }));
    } catch (e) {
      record.status = 'error';
      record.error = e.message;
    }
    return record;
  };
  // 后台静默结算（不 await 也保证 record 最终更新）
  const done = settle();
  return { id, promise: done };
}

export async function waitSub(id, ms = 900000) {
  const rec = subs.get(id);
  if (!rec) throw new Error('子代理不存在: ' + id);
  const t0 = Date.now();
  while (rec.status === 'running' && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 800));
  }
  return rec;
}
