// server/asks.js - 结构化问询（ask_user）：Agent 需要用户决策时发选项卡片，等待用户选择
// 流程：工具 ask_user → 建 pending → emit SSE {type:'ask', id, question, options}
//       → 前端渲染选项按钮 → POST /api/asks/:id {option: value} → 工具返回所选 value
const pending = new Map();
let seq = 0;

export function createAsk(question, options) {
  seq += 1;
  const id = 'ask-' + seq + '-' + Date.now().toString(36);
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  pending.set(id, { question, options, resolve: resolveFn, createdAt: Date.now() });
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
  return [...pending.entries()].map(([id, p]) => ({ id, question: p.question, options: p.options, createdAt: p.createdAt }));
}
