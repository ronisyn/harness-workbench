// server/prefix.js - 前缀不变式机检（架构 §3.5 第①条硬机检）：只追加 / 前缀冻结 / 工具面冻结
// 拆成纯函数是为了**可被门禁测试**：运行期在 agent.js 循环里调用，测试里用"故意破坏"证明它真的会报红。
// 语义：比对"非 system 消息序列"是否逐条同一对象（对象同一性 = 未被就地改写）——system 消息是随轮提示，不参与。

/**
 * 比对上一轮与本轮的 core 序列。
 * @returns {null|{broke:number, prevLen:number, curLen:number}} null = 只追加（合规）
 */
export function diffCore(prev, cur) {
  if (!prev) return null;
  const n = Math.min(prev.length, cur.length);
  for (let i = 0; i < n; i++) {
    if (prev[i] !== cur[i]) return { broke: i, prevLen: prev.length, curLen: cur.length };
  }
  if (cur.length < prev.length) return { broke: cur.length, prevLen: prev.length, curLen: cur.length };
  return null;
}

/**
 * 该断链是否属**非预期**（C4 计数口径）。段边界折叠轮次的断链是预期失效（C5，只报数），不计 C4。
 */
export function isUnexpectedBreak(diff, collapseRound, round) {
  return !!diff && collapseRound !== round;
}
