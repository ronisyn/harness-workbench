// server/progress.js - 进展判据（2026-09-15）：把"轮次上限/时间预算"这两个数字换成一条结构判据
//
// ── 为什么 ────────────────────────────────────────────────────────────────────────────
// 我们原先有两条粗暴的缰绳：轮次上限 2000、时间预算 120 分钟。它们的毛病是**粒度不对**：
//   · 正常的长任务（读 50 个文件、改 20 处代码）会被时间预算误杀 —— 保险丝接在了用户身上；
//   · 而真正该被拦的"原地打转"（同一调用反复重试、反复读同一个文件、poll 一个永远不变的输出）
//     只要没跑满 2000 轮就照样烧钱。
// DS harness 的主循环**没有这类数字**（实测：dsh-agent-loop 里 limit/exceed 零命中），
// 它靠的是"结构上有界 + 人在场"。我们把它那条路补上的一半，就是这个模块：
//   **不问"跑了多久/多少轮"，只问"这一轮有没有产生新的、可验证的东西"。**
//
// ── 什么算"进展"（五条，都可从已有事实判出，不需要额外 LLM 调用）────────────────────────
//   1. 状态变更：写/改/删文件、写库、提交、存技能、勾掉计划步骤等"改变世界"的工具成功
//   2. 新调用：这次 (工具+参数) 组合在本任务里从没出现过（探索新东西算进展）
//   3. 转成功：以前失败过的同一个调用这次成功了（说明环境/思路变了）
//   4. 结果变了：同一个调用两次返回的内容不同（说明外部世界在推进，poll 长任务属这一类）
//   5. 其余一律不算 —— 同一调用、同一参数、同一结果、又什么都没改，就是原地打转
//
// 连续 K 轮没有进展才停（K 默认 10，可配）；停下时**如实说清在重复什么**，用户回一句"继续"就走。
// 纯函数 + 可夹具：`judgeRound` 只吃"本轮工具结果"，不碰 DB、不碰网络。

/** 成功即视为"改变了世界/推进了任务"的工具（含任务自身的记账动作）。 */
export const STATE_CHANGING_TOOLS = new Set([
  'write_file', 'append_file', 'edit_file', 'delete_file', 'mkdir', 'copy_move',
  'db_write', 'git_commit', 'git_pull_push', 'git_branch',
  'skill_save', 'kb_add', 'kb_del', 'set_limits', 'reload_platform', 'undo_checkpoint',
  'plan_tasks', 'plan_done', 'create_contract', 'finish_task', 'intake_submit',
]);

/** 签名：工具名 + 参数指纹（稳定序列化，避免键序影响）。 */
export function callSignature(name, args) {
  let a = '';
  try { a = JSON.stringify(args || {}, Object.keys(args || {}).sort()); } catch { a = String(args); }
  return String(name || '?') + '|' + a.slice(0, 500);
}

/** 结果指纹（只看内容，不看耗时）。 */
function resultHash(item) {
  const s = String((item && (item.result != null ? item.result : item.error)) || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}

export function newProgressState() {
  return { seen: new Map(), failed: new Set(), stalled: 0, rounds: 0, lastWhy: null };
}

/**
 * 判定一轮是否取得进展，并维护连续无进展计数。
 * @param {object} state newProgressState() 的返回（会被就地更新）
 * @param {Array<{name:string,args?:object,status?:string,result?:any,error?:any}>} roundItems 本轮的工具有痕
 * @returns {{progress:boolean, stalled:number, why:string[], repeats:string[]}}
 */
export function judgeRound(state, roundItems) {
  state.rounds += 1;
  const why = [];
  const repeats = [];
  const items = Array.isArray(roundItems) ? roundItems : [];
  for (const it of items) {
    const name = String((it && it.name) || '?');
    const done = !it || it.status !== 'fail';
    const sig = callSignature(name, it && it.args);
    const rh = resultHash(it);
    const prev = state.seen.get(sig);
    if (done && STATE_CHANGING_TOOLS.has(name)) why.push('状态变更:' + name);
    if (!prev) why.push('新调用:' + name);
    else if (!prev.ok && done) why.push('转成功:' + name);
    else if (prev.rh !== rh) why.push('结果变了:' + name);
    else repeats.push(name + (prev.n > 1 ? '×' + (prev.n + 1) : ''));
    if (prev) { prev.n += 1; prev.ok = done; prev.rh = rh; }
    else state.seen.set(sig, { n: 1, ok: done, rh });
    if (!done) state.failed.add(sig); // 失败也算"见过"，但不算进展
  }
  // 一轮里没有任何工具调用：不算进展（模型没动手），也不算"重复"
  const progress = why.length > 0;
  state.stalled = progress ? 0 : (items.length ? state.stalled + 1 : state.stalled);
  state.lastWhy = why;
  return { progress, stalled: state.stalled, why, repeats };
}

/** 停下时的如实说明（用户看得懂，也能据此判断该不该让继续）。 */
export function stallMessage(state, round, limit, repeats) {
  const uniq = [...new Set(repeats || [])].slice(0, 5);
  return '（已连续 ' + state.stalled + ' 轮没有任何新进展，先停下来问你：既没有改动任何东西，也没有拿到新信息、'
    + '同一个调用反复返回同样的结果' + (uniq.length ? '（在重复：' + uniq.join('、') + '）' : '') + '。'
    + '——如果你在等一个长任务，回复"继续"我就接着跑；如果我确实卡住了，给我一句提示或换个做法。'
    + '本次已执行 ' + (round + 1) + ' 轮。）';
}

/**
 * 熔断判定（纯函数，便于夹具）：把"什么时候该停"从散落的 if 收成一处。
 * 关键规则：**轮次/时间只在无人值守时生效** —— 人在场的会话不该被墙钟和轮数掐断（2026-09-15 用户拍板）。
 * @param {{unattended:boolean, interactiveFuse:boolean, budgetMin:number, roundCap:number, round:number, elapsedMs:number}} o
 */
export function fuseDecision(o) {
  const on = o.unattended || o.interactiveFuse;
  if (!on) return null; // 交互式且未显式开启 ⇒ 两条数字熔断都不生效
  if (o.budgetMin > 0 && o.elapsedMs > o.budgetMin * 60000) return { guard: 'budget', why: '达到 ' + o.budgetMin + ' 分钟时间预算' };
  if (o.roundCap > 0 && o.round >= o.roundCap) return { guard: 'cap', why: '达到 ' + o.roundCap + ' 轮护栏上限' };
  return null;
}
