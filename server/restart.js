// server/restart.js - 平台自我重启协作（供 reload_platform 工具与 /api/chat 收尾配合）
// Agent 改完自身代码后调用 reload_platform → 这里记下请求 → 当前对话 SSE 正常结束后，
// index.js 的 maybeSelfRestart() 检测到请求并延迟 2s 以 detached 方式 systemctl restart（不中断当前回复）
let pendingReason = null;
let scheduled = false;

export function requestRestart(reason) { pendingReason = String(reason || 'code change').slice(0, 300); }
export function takeRestart() { const r = pendingReason; pendingReason = null; return r; }
export function isRestartScheduled() { return scheduled; }
export function markRestartScheduled() { scheduled = true; }
