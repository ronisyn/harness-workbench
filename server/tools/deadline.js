// server/tools/deadline.js —— 工具调用截止（架构对齐 DSH：`dsh-timeout` + `dsh-tool-call-timeout-policy`）
//
// DSH 的原文口径（`dsh-tool-call-timeout-policy/lib/index.js` 注释）：
//   "A tool declares `timeoutMs` and promises to honor `exec.signal`; this wrapper arms that deadline
//    and maps its own expiry to `TOOL_TIMEOUT` **without racing or abandoning the tool promise**."
// 两条关键设计，我们照抄（理由在本仓库都踩过）：
//   ① **不抢跑、不丢弃工具 promise**：到点只是把 signal 置为 aborted，工具自己收口；调用方照常 await 完。
//      抢跑（Promise.race 后丢下工具）会让"调用方以为结束了"与"工具还在写盘/写网"分叉——本仓库
//      在 spill 那次踩过同一类问题（输出与被截断的原文不一致，比慢更糟）。
//   ② **分类码**：上游先中止（用户点停止）≠ 本截止到期。两者必须能分开，否则"用户停了"会被
//      误报成"工具超时"，模型的下一步判断就错了。DSH 用一个自有 code 给 signal 打标来区分嵌套截止。
//
// 本模块只有"派生一个到点即中止的 signal"这一件事；判定与改写结果在 execTool（唯一执行收口）。

/** 本接口自有的截止分类码（与 DSH 同名）：用于把"本工具的声明界限到期"从其它中止里认出来。 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT';

/**
 * 派生调用截止。`upstream`（会话级 signal：用户停止/断连）先中止时**不带**本分类码——
 * 这样调用方读 `reason.code` 就能区分"用户停了"与"工具越界"。
 * @param {AbortSignal|null|undefined} upstream 上游 signal（可为空）
 * @param {number} timeoutMs 工具声明的界限（毫秒）；非正数/非法 → 返回 null（= 未声明，不设线）
 * @returns {{signal: AbortSignal, deadlineAt: number, expired: () => boolean, dispose: () => void}|null}
 */
export function armDeadline(upstream, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return null; // 未声明就是未声明：不替工具编一个数
  const ac = new AbortController();
  let expiredAt = 0;
  const timer = setTimeout(() => {
    expiredAt = Date.now();
    const reason = new Error('工具调用超出声明的界限 ' + ms + 'ms');
    reason.code = TOOL_TIMEOUT;
    reason.timeoutMs = ms;
    ac.abort(reason);
  }, ms);
  if (timer.unref) timer.unref(); // 挂着的截止计时器不该拖住进程退出
  const onUpstream = () => ac.abort(); // 上游中止：不带 TOOL_TIMEOUT 分类
  if (upstream) {
    if (upstream.aborted) ac.abort();
    else upstream.addEventListener('abort', onUpstream, { once: true });
  }
  return {
    signal: ac.signal,
    deadlineAt: Date.now() + ms,
    /** 本截止是否已到期（上游中止不算到期） */
    expired: () => expiredAt > 0,
    dispose: () => {
      clearTimeout(timer);
      if (upstream) { try { upstream.removeEventListener('abort', onUpstream); } catch { /* ignore */ } }
    },
  };
}

/**
 * 工具越界后才返回时的替换结果（DSH `toolTimeoutResult` 同构：面向模型的中文 + 结构化 code）。
 * 语义：**不是假装工具没跑过**——工具确实执行了、副作用可能已发生；这里如实说明"超出声明界限"，
 * 并让模型知道可以改用更小的粒度重试。留痕走正常通道（result.error → tool_calls.status='fail'）。
 * @param {string} name 工具名
 * @param {number} timeoutMs 声明的界限
 */
export function toolTimeoutResult(name, timeoutMs) {
  return {
    error: '工具 ' + name + ' 超时：本次调用超出该工具声明的执行界限 ' + timeoutMs + 'ms，工具已不再等待（其内部收尾可能仍在进行）。'
      + '请改用更小的粒度重试（例如分段读/收窄查询范围），或换用其它工具。',
    code: TOOL_TIMEOUT,
    timeoutMs,
  };
}
