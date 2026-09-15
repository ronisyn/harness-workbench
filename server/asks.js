// server/asks.js - 结构化问询（ask_user）：Agent 需要用户决策时发选项卡片，等待用户选择
// 流程：工具 ask_user → 建 pending → emit SSE {type:'ask', id, question, options}
//       → 前端渲染选项按钮 → POST /api/asks/:id {option: value} → 工具返回所选 value
const pending = new Map();
let seq = 0;

export function createAsk(question, options, { conversationId = null } = {}) {
  seq += 1;
  const id = 'ask-' + seq + '-' + Date.now().toString(36);
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  // `conversationId` 是**归属**（不是显示字段）：跨端一致要求"按会话找得到这张卡"
  // ——渠道侧据此把卡片发到人所在的端、也据此把人在渠道里的回答对回这一张卡（见 server/cards.js）。
  const convId = conversationId == null ? null : Number(conversationId);
  pending.set(id, { question, options, resolve: resolveFn, createdAt: Date.now(), conversationId: Number.isFinite(convId) ? convId : null });
  // 10 分钟无应答按超时处理（不销毁，允许稍后补答：见 decideAsk 对 timeout 的处理）
  setTimeout(() => {
    const p = pending.get(id);
    if (p && !p.answered) { pending.delete(id); p.resolve({ option: null, reason: 'timeout' }); }
  }, 10 * 60 * 1000);
  return { id, promise, options };
}

export function decideAsk(id, option) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.answered = true;
  p.resolve({ option, reason: 'answered' });
  return true;
}

export function cancelAsk(id) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve({ option: null, reason: 'aborted' });
  return true;
}

export function listPendingAsks() {
  // `conversationId` 一并带出（可能为 null：老调用方/无人值守路径没有会话归属）：`GET /api/asks` 靠它
  // 补上"属于哪个会话、在哪一端等回答"（server/cards.js 的 attachCardRoutes）。
  return [...pending.entries()].map(([id, p]) => ({ id, question: p.question, options: p.options, createdAt: p.createdAt, conversationId: p.conversationId ?? null }));
}
