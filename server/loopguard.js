// server/loopguard.js - 重复调用纪律（RA-39）：第 3/5 次相同调用**提醒但不阻止**；挂起由 loop_guard 阈值独立承担。
// 抽成纯函数是为了可被门禁测试（运行期由 agent.js 每轮调用）。

/** 第 3/5 次重复 → 返回提醒文本（各发一次）；其余情况返回 null（不打扰） */
export function repeatReminder(noProgressCount, reminded) {
  if (noProgressCount !== 3 && noProgressCount !== 5) return null;
  if (reminded && reminded.has(noProgressCount)) return null;
  if (reminded) reminded.add(noProgressCount);
  return '提示（第 ' + noProgressCount + ' 次相同调用）：同一工具与参数已连续重复，若无新进展请换策略——这不阻止你继续调用，只是提醒别把预算花在原地打转。';
}

/** 是否达到挂起阈值（loopGuardN=0 → 关闭）。语义＝**连续 N 次**重复后挂起——与提示文案"连续 N 次重复调用"一致；
 *  取 N 而非 N-1，是为了让"第 3/5 次只提醒不阻止"（RA-39）成立（原实现 N-1 会在第 5 次就挂起）。 */
export function shouldPauseOnRepeat(noProgressCount, loopGuardN) {
  return loopGuardN > 0 && noProgressCount >= loopGuardN;
}
