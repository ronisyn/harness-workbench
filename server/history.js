// server/history.js - 历史组装（**只追加**）与跨轮前缀指纹判据
//
// 依据：《RW-Agent 引擎架构优化方案 v0.3》§4.4.1 规则1「只追加：禁止中途改写早期消息；折叠只在**段边界整段替换一次**」
//      与规则5「失效可数：任何进入请求前缀的组件都必须声明其缓存影响」。
//
// 为什么单独一个模块：`/api/chat` 每次请求都从 messages 表**重新组装**一遍前缀，
//   而 agent.js 的 `diffCore/prevCore` 机检只看得见**一次 run 之内**的轮次比较（`prevCore` 每 run 重置）。
//   于是"跨 run 把同一条会话的历史改短/换头"这件事**没有任何机检看得见**——核对报告 §3.5③ 正是这条。
//   这里把它做成**纯函数**（不碰 db、不碰网络），夹具才能用真实数据形状直接验证行为，
//   而不是只能 grep 源码里有没有某一行。
//
// 判据（为什么不发明阈值）：
//   · 前缀按**逐字节**匹配 ⇒ "同一会话上一轮发出去的前缀，必须逐字仍是这一轮前缀的开头"。
//     这是唯一的判据，不需要设任何数字阈值：上一轮记的条数 N 与本轮的 N 条逐字节相同 = 只追加。
//   · 车道（lane）变了就不算改写：切模型（v0.3 §0.3 的 C4 豁免项）与换壳/换档位/轻量面翻转（§4.4.1 规则3 的**新段**）
//     本来就会重建缓存，且已由 agent.js 的 `prefix:exempt` 如实归因——这里跳过，避免同一件事被计两次。
import { createHash } from 'node:crypto';
import { PREFIX_LEDGER } from './prefix-participants.js';

/** 历史条目的指纹：只看 role + content（发出去的就是这两个字段；id 不进请求，不参与比对）。 */
export function historyFingerprint(hist, count) {
  const h = createHash('sha256');
  const list = Array.isArray(hist) ? hist : [];
  const n = Math.min(Math.max(0, Number(count) | 0), list.length);
  for (let i = 0; i < n; i++) {
    const m = list[i] || {};
    h.update(String(m.role || ''));
    h.update('\u0000');
    h.update(String(m.content == null ? '' : m.content));
    h.update('\u0001');
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * 跨轮前缀改写判定（纯函数）。
 * @param {{fp:string,cnt:number,lane:string,peak?:number}|null} prev 上一轮记的（fp=指纹 / cnt=条数 / lane=车道 / peak=历史最高条数）
 * @param {Array<{role:string,content:any}>} hist      本轮从 messages 表读到的完整历史（**未被裁剪**）
 * @param {string} lane                                 本轮车道（模型 + 工具面的源件）
 * @returns {{state:'first'|'skipped-lane'|'append'|'rewrite', cnt:number, fp:string, lane:string, peak:number, lost:number}}
 *   state=first        首次记录（首轮缓存必然重建，属 C5 的 first-round，不计 C4）
 *   state=skipped-lane 车道变了（换模型/新段）：缓存本来就要重建，已在 prefix:exempt 记过，不重复计
 *   state=append       上一轮那 cnt 条逐字节还在原位 → 合规（只追加）
 *   state=rewrite      **跨轮前缀改写**：早期消息被丢弃/换头/变短 → C4 非预期失效，如实归因
 *   peak / lost        peak = 这条会话历史见过的最大条数；lost = peak − 本轮条数（**对照峰值**而不是对照上一轮：
 *                      滑窗会一轮轮往下掉，拿上一轮当基准会把"少了多少"越报越小，等于把最严重的那次藏起来）
 */
export function detectPrefixRewrite(prev, hist, lane) {
  const list = Array.isArray(hist) ? hist : [];
  const curCount = list.length;
  const curLane = String(lane == null ? '' : lane);
  const fp = historyFingerprint(list, curCount);
  const peak = Math.max(curCount, Number(prev && prev.peak) || 0, Number(prev && prev.cnt) || 0);
  const out = (state) => ({ state, cnt: curCount, fp, lane: curLane, peak, lost: Math.max(0, peak - curCount) });
  if (!prev || !Number.isFinite(Number(prev.cnt))) return out('first');
  // 车道不同 → 不算改写（见文件头"判据"第 2 条）
  if (String(prev.lane || '') !== curLane) return out('skipped-lane');
  const cnt = Math.max(0, Number(prev.cnt) | 0);
  if (curCount < cnt) return out('rewrite');                            // 历史变短：末尾被删或整段被替换
  if (historyFingerprint(list, cnt) !== prev.fp) return out('rewrite'); // 条数没少但前 cnt 条不再逐字相同
  return out('append');
}

/** 只追加不变量：上一轮发出去的（cnt 条）必须仍是本轮前缀的开头。 */
export const isAppendOnly = (state) => state === 'append' || state === 'first' || state === 'skipped-lane';

// ── 账本行的**唯一构造出口**（写与解析共用一份定义；夹具直接验这两个函数的形状）────────────────
// 为什么固定成 "fp=… cnt=… peak=… lane=…" 而不是一句中文：这条账要能被**机器读回**当下一轮的对照，
// 而 audit_log 只有一列 detail —— 写成人话就只能靠正则猜。
export const formatPrefixRecord = (r) =>
  'fp=' + r.fp + ' cnt=' + r.cnt + ' peak=' + r.peak + ' lane=' + r.lane + (r.state === 'rewrite' ? ' rewrite=1 lost=' + r.lost : '');

/** 读账用：把 detail 解析回 {fp,cnt,peak,lane,rewrite}；解析不出来返回 null（当作"无对照"，按首个记录处理）。 */
export function parsePrefixRecord(detail) {
  const s = String(detail || '');
  const fp = /(?:^|\s)fp=([0-9a-f]{6,64})(?:\s|$)/.exec(s);
  const cnt = /(?:^|\s)cnt=(\d+)(?:\s|$)/.exec(s);
  const lane = /(?:^|\s)lane=([^\s]*)/.exec(s);
  const peak = /(?:^|\s)peak=(\d+)(?:\s|$)/.exec(s);
  if (!fp || !cnt) return null;
  return {
    fp: fp[1], cnt: Number(cnt[1]), lane: lane ? lane[1] : '',
    peak: peak ? Number(peak[1]) : Number(cnt[1]), // 老账（无 peak）按 cnt 兜底，语义等价于"当时就是峰值"
    rewrite: /(?:^|\s)rewrite=1(?:\s|$)/.test(s),
  };
}

/** 账本动作名（与声明表同源：prefix-participants.js 的 PREFIX_LEDGER）。 */
export const PREFIX_RECORD_ACTION = PREFIX_LEDGER.ASSEMBLE;
