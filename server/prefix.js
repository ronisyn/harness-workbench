// server/prefix.js - 前缀不变式机检（架构 §3.5 第①条硬机检）：只追加 / 前缀冻结 / 工具面冻结
// 拆成纯函数是为了**可被门禁测试**：运行期在 agent.js 循环里调用，测试里用"故意破坏"证明它真的会报红。
// 语义：比对"非 system 消息序列"是否逐条同一对象（对象同一性 = 未被就地改写）——system 消息是随轮提示，不参与。
import { createHash } from 'node:crypto';

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

// ── 纪元（epoch）指纹：把"固定前缀面"变成可比对的短串 ───────────────────────────────────────
// 为什么需要（2026-09-15 实测）：前缀缓存按**逐字节前缀**匹配，前缀面任何改动都会让所有会话整段重建。
// 最刺眼的一次实证：会话 185 每天 05:00 复用同一会话跑一次，十天里空闲时长恒为 23.9~24.0 小时，
//   前缀**逐字节没变**的 4 天首轮未命中 ≤142；**变了**的 5 天未命中 ≥8,964 —— 其中 09-09 只差 **+46 个
//   token** 就吃掉了 92.8% 的重建。9/9 与"前缀变没变"完全一致，与空闲时长完全无关。
// 而在此之前，sys/tools 哈希**只在 `RW_PREFIX_DEBUG=1` 的日志里**，事后查不出"是谁打破了前缀"。
// 这里把它做成可落库、可比对、可门禁测试的纯函数。

/** 文本指纹（12 位十六进制，够短可落列，够长不撞）。 */
export const prefixHash = (text) => createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, 12);

/**
 * 纪元键 = 固定前缀面（系统提示文本 + 工具面 JSON）的指纹。
 * 两者任一变化即换纪元 —— 换纪元意味着**所有会话**的缓存前缀作废，必须整段重建。
 */
export const epochKey = (envText, toolsHash) => prefixHash(String(envText || '') + '\u0000' + String(toolsHash || ''));

/** 泳道标签：同一份代码在不同 (permission, preset) 下是**不同的前缀**（身份层随 permission 变）。
 *  第三个轴 light 也不能漏：`light` 是按每条消息内容算的，工具面会在轻量面/全量面之间翻，
 *  两面是**两条不同的前缀**（实测同一会话两轮：输入 10,735（全量面）vs 5,130（轻量面））。 */
export const laneKey = (permission, preset, light = false) =>
  String(permission || 'full') + '/' + String(preset || 'all') + (light ? '#light' : '');

/**
 * 纪元是否变了。`prev` 为空 = 首次记录（不是变更，不报警）；任一为空串 = 数据不可用，按"不变"处理。
 */
export const isEpochChange = (prev, cur) => !!prev && !!cur && prev !== cur;

/**
 * **要不要为这个面发一次预热**。比 `isEpochChange` 宽一档：**没有记录也要预热**。
 * 依据：没有记录 = 我们从没为这个面做过保温 —— 它的前缀多半是冷的，而"冷"意味着下一次真实请求要
 * 整段重建。此时预热的花费上界就是那笔重建（本来也要付），下界几乎是 0（若它其实是热的，走命中价）。
 * 反例（为什么要留 `isEpochChange` 单独一个函数）：**没变化时绝不能预热** —— 那会在每次重启都白花钱，
 * 实测第二次重启的日志就是 `前缀面无变化（已核对 4 条泳道×面，未产生任何调用）`。
 */
export const needsWarm = (prev, cur) => (!!cur) && (prev == null || prev === '' || prev !== cur);
