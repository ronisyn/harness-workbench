// server/readcache.js - 同会话重复读去重（RA-35 措施②：压每轮新增）
//
// 问题（实测）：read 类调用里 **41.7% 是重复读同一个文件**——同一个 `daily-evolve-log.md` 被读 56 次
// （单次 3,799 字节）、`RW行为准则-服务器版.md` 23 次、`cohort.mjs` 8 次（单次 6,665 字节）。
// 这些内容**上一轮就已经进过上下文**，再原样注入一遍：既花 input token（虽然大部分能命中缓存，
// 但每次仍要按"新增内容"计费一小段），又挤占上下文、推高折叠频率。
//
// 策略：**同会话内、同一个文件、内容未变、同一区域** → 第二次起返回极短回执（几十字节），
// 告诉模型"内容已在上文、需要请用 force 重取"。文件一旦被改动（mtime/size 变了）就照常返回全文——
// 新内容必须看得见。调用方也可显式 `force:true` 强制重取。
//
// 为什么状态放内存：重启后状态丢失 = 下次读返回全文，属**安全方向**（宁可多给一次，也不误省），
// 且天然避免"跨会话误用别人的缓存"。会话删除时由调用方 clear()，不长期占内存。

const state = new Map(); // conversationId -> Map(key -> { mt, size, hash, at, n })

const keyOf = (kind, absPath, off = null, len = null) => `${kind}|${absPath}|${off == null ? '' : off}|${len == null ? '' : len}`;

function bucket(cid) {
  const k = String(cid == null ? 'g' : cid);
  if (!state.has(k)) state.set(k, new Map());
  return state.get(k);
}

/**
 * 判定"这次读能否只回执"。
 * @param {object} p
 *   cid 会话 id · kind 'read_file'|'read_file_range' · absPath 绝对路径
 *   mt/size 文件的 mtimeMs/size（用于识别"改动过"）· hash 内容指纹（可选，用于识别"同 mtime 不同内容"）
 *   off/len 分段参数（read_file_range 用）· force 调用方强制重取
 * @returns {{hit:boolean, times?:number, bytes?:number, ageMs?:number}}
 */
export function checkRepeat(p) {
  if (p.force) return { hit: false };
  const k = keyOf(p.kind, p.absPath, p.off, p.len);
  const b = bucket(p.cid);
  const prev = b.get(k);
  if (!prev) return { hit: false };
  const unchanged = prev.mt === p.mt && prev.size === p.size && (p.hash == null || prev.hash === p.hash);
  if (!unchanged) return { hit: false };   // 文件变了 → 必须给全文
  return { hit: true, times: prev.n, bytes: p.size, ageMs: Date.now() - prev.at };
}

/** 记下"这次给了全文"，供后续去重使用 */
export function noteReadFull(p) {
  const k = keyOf(p.kind, p.absPath, p.off, p.len);
  const b = bucket(p.cid);
  const prev = b.get(k);
  b.set(k, { mt: p.mt, size: p.size, hash: p.hash == null ? null : p.hash, at: Date.now(), n: (prev ? prev.n : 0) + 1 });
  return b.get(k).n;
}

/** 会话结束/删除时清理（调用方负责） */
export function clearReadCache(cid) { state.delete(String(cid == null ? 'g' : cid)); }

/** 极短回执文案：必须让模型明白"内容在上下文里"，否则它会以为读失败而反复重试 */
export function repeatNotice(tool, absPath, info) {
  const kb = (info.bytes / 1024).toFixed(1);
  return `（${tool} 已跳过重复读取：${absPath} 的内容在本会话上文已完整给出，文件未改动，共 ${info.bytes} 字节 / ${kb}KB，`
    + `本会话第 ${info.times + 1} 次读。需要重新查看请带 force:true，或改用 read_file_range 读特定片段。）`;
}

/** 测试用：查看内部状态大小 */
export function _sizeOf(cid) { const b = state.get(String(cid == null ? 'g' : cid)); return b ? b.size : 0; }
