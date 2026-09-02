// server/approval.js - F20 审批：guard 权限会话中，高风险工具先暂停并请求用户确认
// 流程：execTool 发现 guard 会话+受控工具 → 生成待审批项 → emit('approval') → 前端 SSE 弹确认卡
//       → 用户 POST /api/approvals/:id {decision} → 工具继续执行/被拒
const pending = new Map(); // id -> { desc, resolve }
let seq = 0;

export function createApproval(desc) {
  seq += 1;
  const id = 'ap-' + seq + '-' + Date.now().toString(36);
  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  pending.set(id, { desc, resolve: resolveFn, createdAt: Date.now() });
  // 超时兜底：5 分钟后自动拒绝（防止 SSE 断开后永远悬挂）
  setTimeout(() => {
    const p = pending.get(id);
    if (p) { pending.delete(id); p.resolve({ decision: 'timeout', desc }); }
  }, 5 * 60 * 1000);
  return { id, promise };
}

export function decideApproval(id, decision) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve({ decision, desc: p.desc });
  return true;
}

export function cancelApproval(id, decision = 'aborted') {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  p.resolve({ decision, desc: p.desc });
  return true;
}

export function listPending() {
  return [...pending.entries()].map(([id, p]) => ({ id, desc: p.desc, createdAt: p.createdAt }));
}
