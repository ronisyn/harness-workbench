// server/readcache.js - 同会话重复读去重（RA-35 措施②：压每轮新增）
//
// 问题（实测）：read 类调用里 **41.7% 是重复读同一个文件**——`daily-evolve-log.md` 被读 56 次、
// `RW行为准则-服务器版.md` 23 次、`cohort.mjs` 8 次（单次 6,665 字节）。这些内容**上一轮就已经进过上下文**，
// 再原样注入：既按"新增"计费，又挤占上下文、推高折叠频率。
//
// ⚠️ 第一版按"整文件 + 是否读过"去重，**实测一次都没触发**：模型第二次改用 `read_file_range` 读了
//    同一文件的不同区间（6,665 字节全文 vs 5,711 字节分段，内容高度重叠但键不同）。
//    所以去重必须做在**区间一级**：记录本会话已经给过哪些段，只补"真正没给过"的部分。
//
// 口径：
//   · 键 = (会话, 文件)。文件**改动过**（mtime/size 变）→ 全部记录作废，下次照常给全文（新内容必须看得见）。
//   · 记录 = 已给出的字符区间集合；请求区间与之求差 → 只返回未覆盖的部分，并附一行说明。
//   · 完全被覆盖 → 返回极短回执（<200 字符），提示"已在上文、可用 force 重取"。
//   · `force:true` → 该次请求不参与去重（强制给全）。
//   · 跨会话不串用；会话删除时由调用方 clear()。
//
// 纯函数部分（mergeIntervals/subtractIntervals/planRead）可单测；状态放内存：重启即失效 →
// 下次读返回全文，属**安全方向**（宁可多给一次，也不误省）。

const state = new Map(); // conversationId -> Map(absPath -> { mt, size, iv: [[s,e),...] })

function bucket(cid, absPath) {
  const c = String(cid == null ? 'g' : cid);
  if (!state.has(c)) state.set(c, new Map());
  const b = state.get(c);
  if (!b.has(absPath)) b.set(absPath, { mt: null, size: null, iv: [] });
  return b.get(absPath);
}

/** 合并重叠/相邻区间（输入不改动，返回新区间数组，按起点排序） */
export function mergeIntervals(list) {
  const arr = (list || []).filter((x) => Array.isArray(x) && x[1] > x[0]).slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of arr) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** 求差：target 中**未被 covered 覆盖**的部分 */
export function subtractIntervals(target, covered) {
  const [ts, te] = target;
  const cov = mergeIntervals(covered);
  const out = [];
  let cur = ts;
  for (const [cs, ce] of cov) {
    if (ce <= cur) continue;
    if (cs >= te) break;
    if (cs > cur) out.push([cur, Math.min(cs, te)]);
    cur = Math.max(cur, ce);
    if (cur >= te) break;
  }
  if (cur < te) out.push([cur, te]);
  return out;
}

/**
 * 规划一次读：返回未覆盖的区间 + 是否"完全重复"。
 * @param {object} p { cid, absPath, mt, size, span:[start,end), force }
 *   p.nearRatio 可选：把"与已给区间高度重叠（未覆盖部分占比 < nearRatio）"也判为重复。
 *   为什么需要它：实测模型会**偏移几字节**地重复读同一段（如 offset=0/len=3745 与 offset=3/len=3745），
 *   严格区间相减只会补出几字节，等于没省。此时返回极短回执更划算（内容上文刚给过）。
 * @returns {{duplicate:boolean, gaps:Array<[number,number]>, coveredChars:number, seenBefore:boolean, reason?:string}}
 */
export function planRead(p) {
  const b = bucket(p.cid, p.absPath);
  const changed = b.mt !== p.mt || b.size !== p.size;
  const covered = changed ? [] : b.iv;              // 文件变了 → 旧记录作废
  if (p.force) return { duplicate: false, gaps: [p.span], coveredChars: 0, seenBefore: covered.length > 0 };
  const gaps = subtractIntervals(p.span, covered);
  const spanLen = p.span[1] - p.span[0];
  const gapLen = gaps.reduce((a, [s, e]) => a + (e - s), 0);
  const coveredChars = spanLen - gapLen;
  if (gapLen === 0) return { duplicate: true, gaps: [], coveredChars, seenBefore: covered.length > 0, reason: 'fully-covered' };
  const near = Number(p.nearRatio) > 0 && spanLen > 0 && (gapLen / spanLen) < Number(p.nearRatio);
  if (near) return { duplicate: true, gaps: [], coveredChars, seenBefore: covered.length > 0, reason: 'near-duplicate' };
  return { duplicate: false, gaps, coveredChars, seenBefore: covered.length > 0 };
}

/** 记录"这次确实给出去了"的区间（只记实际提供的部分） */
export function noteServed(p) {
  const b = bucket(p.cid, p.absPath);
  if (b.mt !== p.mt || b.size !== p.size) { b.iv = []; b.mt = p.mt; b.size = p.size; } // 文件变更 → 从头记
  b.iv = mergeIntervals([...b.iv, ...p.spans]);
  return b.iv.length;
}

/** 完全重复时的极短回执：必须让模型明白"内容在上下文里"，否则它会以为读失败而反复重试 */
export function repeatNotice(tool, absPath, info) {
  const kb = (info.size / 1024).toFixed(1);
  const why = info.reason === 'near-duplicate'
    ? `本次请求区间 ${info.span[0]}–${info.span[1]} 与上文已给出的内容几乎相同（仅差少量字符）`
    : `本次请求区间 ${info.span[0]}–${info.span[1]} 已覆盖`;
  return `（${tool} 已跳过重复读取：${absPath} 的这段内容在本会话上文已给出且文件未改动`
    + `（共 ${info.size} 字节 / ${kb}KB，${why}）。`
    + `需要重新查看请带 force:true，或换一个区间读没看过的部分。）`;
}

/** 部分重复时的说明（贴在给出去的新内容前面） */
export function partialNotice(tool, absPath, info) {
  return `（${tool} 提示：${absPath} 本次请求区间 ${info.span[0]}–${info.span[1]} 中有 ${info.coveredChars} 字符`
    + `在本会话上文已给出，下面只补未读过的部分。）\n`;
}

export function clearReadCache(cid) { state.delete(String(cid == null ? 'g' : cid)); }

/** 测试用：看某会话已记录的文件数 */
export function _filesOf(cid) { const b = state.get(String(cid == null ? 'g' : cid)); return b ? b.size : 0; }
/** 测试用：看某文件已覆盖的区间 */
export function _ivOf(cid, absPath) { const b = state.get(String(cid == null ? 'g' : cid)); return b && b.get(absPath) ? b.get(absPath).iv : []; }
