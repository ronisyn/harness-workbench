// scripts/prefix-attribution-lib.mjs - prefix-attribution.mjs 的**纯函数部分**（不连库、不读 argv、不打印）
//
// 为什么判据要单独一个文件：判据必须能被夹具钉住（test/prefix-attribution.test.mjs）。
// 判据留在脚本里时，`import` 它就等于执行一遍 SQL（该脚本是顶层直跑的），夹具没法只测判据；
// 在夹具里照抄一份判据又会出现**两个出处**——锁住的不是脚本真正在跑的那份。所以判据只有这一个出处：
// 脚本负责取数与打印，夹具锁这里的行为。
//
// 两个判据（都是**机检**判据，都不含猜测）：
//   classify(r)                    —— 既有类别口径：真·首见 / 换纪元 / 久未用（**会话内**判据，语义一字未改）
//   judgeability(r, epochLedgerN)  —— 可判性：这一轮**有没有**可用来判断"是否跨纪元"的机检锚点
//   sessionAnchor(r)               —— 会话内可比性：类别判据在本会话里到底有没有可比对的前序指纹
//
// ⚠️ 可判性判据的说法沿用 scripts/c1c2-forensics.mjs 的既有口径（`nofp` = 指纹列不全 ⇒ 机检判不了）：
//    "看不见"不等于"没发生"，机检判不了就如实标"不可判"，**不拿"未命中大"倒推成因**。

/** 既有类别口径（2026-09-15 定稿）：**会话内**判据，逐字沿用原脚本里的 `cls`。
 *  · 真·首见 —— 本会话从未出现过这枚指纹 ⇒ 这是它的第一次请求（冷启动不可免）
 *  · 换纪元 —— 本会话出现过这枚指纹，且紧邻的上一轮是另一枚 ⇒ 前缀面变了（翻转/部署/MCP 漂移）
 *  · 久未用 —— 指纹就是上一轮那枚 ⇒ 这时才轮到"缓存过期"这个解释
 *  三态全部是"会话内"判据：一次性会话（本会话只此一轮）时它只能给出"真·首见"，
 *  不能读成"没换纪元"——换纪元要看 prefix:epoch-change 账本或跨会话指纹（见 judgeability）。
 */
export function classify(r) {
  return Number(r.seen_before) === 0 ? '真·首见' : (r.prev_tools && r.prev_tools !== r.tools ? '换纪元' : '久未用');
}

/** 类别字符串（回归锁用：这三枚字符串是既有口径，不许改名） */
export const CATEGORIES = ['真·首见', '换纪元', '久未用'];

const has = (v) => v != null && String(v) !== '';

/**
 * 可判性：这一轮**能否机检判断是否跨纪元**。只回答"有没有判据"，不回答"到底换没换"（那是账本/指纹比对的事）。
 *   · 本行带前缀指纹（sys 或 tools 任一）  ⇒ 有可比对的机检锚点 ⇒ 可判
 *   · 本行无指纹，但账本里有 prefix:epoch-change 记录 ⇒ 有账本锚点 ⇒ 可判
 *   · 两者都没有 ⇒ **不可判**（机检判不了，如实标出）
 * @param {object} r 一行 usage_stats（只用到 sys/tools）
 * @param {number} epochLedgerN 窗口内 audit_log 的 prefix:epoch-change 条数
 * @returns {{judgeable:boolean, basis:'fingerprint'|'epoch-ledger'|'none', label:'可判'|'不可判', cell:string, why:string}}
 */
export function judgeability(r, epochLedgerN) {
  const ledger = Number(epochLedgerN) || 0;
  if (has(r && r.sys) || has(r && r.tools)) {
    return { judgeable: true, basis: 'fingerprint', label: '可判', cell: '可判/指纹',
      why: '本行带前缀指纹，有可比对的机检锚点' };
  }
  if (ledger > 0) {
    return { judgeable: true, basis: 'epoch-ledger', label: '可判', cell: '可判/账本',
      why: `本行无指纹，但账本里有 prefix:epoch-change 记录（窗口内 ${ledger} 条）可判` };
  }
  return { judgeable: false, basis: 'none', label: '不可判', cell: '不可判',
    why: '本行无指纹、账本亦无 prefix:epoch-change 记录 ⇒ 机检判不了（不拿"未命中大"倒推成因）' };
}

/**
 * 会话内可比性：类别判据（classify）在本会话里**有没有可比对的前序指纹**。只用已取到的两个字段，机器可判：
 *   · gap_since_prev == null ⇒ 本会话此前没有任何轮次（一次性会话）⇒ 会话内判据无从适用
 *   · prev_tools 为空        ⇒ 有前序轮次，但上一轮没有指纹 ⇒ 会话内无从比对
 *   · 否则                   ⇒ 上一轮带指纹，会话内可比对
 * 注意间隔用 `== null` 判而不是真值判：间隔 0 秒是"有前序轮次"，不是"没有"。
 */
export function sessionAnchor(r) {
  if (r.gap_since_prev == null) {
    return { kind: 'no-prior-round', why: '本会话此前没有任何轮次（一次性会话）⇒ 会话内判据无从适用' };
  }
  if (!has(r.prev_tools)) {
    return { kind: 'prior-round-no-fingerprint', why: '有前序轮次但上一轮没指纹 ⇒ 会话内无从比对' };
  }
  return { kind: 'prior-fingerprint', why: '上一轮带指纹，会话内可比对' };
}

/**
 * 汇总：**可判轮数 / 不可判轮数**（夹具锁这两个计数），
 * 外加口径披露用的 noSessionAnchor（会话内没有可比对前序指纹的轮数）。
 */
export function summarizeJudgeability(rows, epochLedgerN) {
  const out = { total: 0, judgeable: 0, unjudgeable: 0, byBasis: { fingerprint: 0, 'epoch-ledger': 0, none: 0 }, noSessionAnchor: 0 };
  for (const r of rows || []) {
    const j = judgeability(r, epochLedgerN);
    out.total += 1;
    if (j.judgeable) out.judgeable += 1; else out.unjudgeable += 1;
    out.byBasis[j.basis] = (out.byBasis[j.basis] || 0) + 1;
    if (sessionAnchor(r).kind !== 'prior-fingerprint') out.noSessionAnchor += 1;
  }
  return out;
}
