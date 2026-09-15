// server/selfeval/priority.js —— v0.3 §0.4「M3 的优先级判据」的**判据那一半**（㉔ 的前半）
//
// ── 判据原文（v0.3 §0.4，逐字引用，不许改写、不许加权重）────────────────────────────────
//   ① 能减少 C4 失效 / 降成本
//   ② 能提高交付速度
//   ③ 能减少人工介入
//   —— **三者优先于"加新功能"**。
//
// ── 实现口径（三条，都是"不发明"）────────────────────────────────────────────────────────
//   1. **不做加权公式、不做打分**：v0.3 只说了"三者优先于加新功能"，**没有**在①②③之间排序，
//      也没有给过任何权重。所以本模块只输出"**逐条判成了什么**"（true/false/null 三值），
//      比较器只做一件事：**三条里任何一条判为 true 的排在前面；判不出来的排最后交人看**。
//   2. **判不出来就如实说判不出来**（null），并给出 `needsHuman`——不许用关键词猜。
//      猜错的判据比没有判据更坏：它会让人以为排序有依据。
//   3. **关键词只做"喂进来的信号"的识别**，不是判据本身。信号从两个地方来：
//      · `proposal.evidence`（机器可核）：selfeval 自己从快照里读出来的事实（字符串）
//      · `proposal.expectedBenefit`（人写的收益描述）：对外部对标/业务反馈这两源，收益只有文字
//      识别到信号后：**机器可核的 → 直接判 true；只有文字的 → null（需人确认）**。
//      这一条同时挡住 v0.3 §0.4 风险①"自我表演"——机器没有实测数据时不许给自己发高分。

/** 判据键（唯一出处；顺序＝ v0.3 §0.4 原文顺序，**不代表权重**） */
export const CRITERIA = ['c4-or-cost', 'delivery-speed', 'manual-effort'];

/** 判据的中文名（报表/提案文本用） */
export const CRITERIA_CN = {
  'c4-or-cost': '①减少 C4 失效/降成本',
  'delivery-speed': '②提高交付速度',
  'manual-effort': '③减少人工介入',
};

/**
 * 关键词表：**这是"什么样的话算在说哪条判据"的登记处**，不是打分表。
 * 每条都指向 §0.4 的原词（C4/失效/成本/交付/速度/人工/介入），同义扩展限于 RW 自己用过的说法。
 * ⚠️ 只收**指向明确**的词：像"自动"这种既能说"少人工"也能说"少人工但多花钱"的模糊词一律不收
 *   （收进来就是替人下结论）。命中多条判据时本模块照样只标"判不了"——关键词只负责提醒人去看。
 */
export const CRITERIA_KEYWORDS = {
  'c4-or-cost': ['C4', '前缀失效', '缓存失效', 'prefix:invalidate', '整段作废', '降成本', '成本', 'token', '命中率', 'C1', 'C2', 'C3', '未命中', 'miss'],
  'delivery-speed': ['交付速度', '交付', '速度', '提速', '更快', '耗时', '时延', '等待', '轮次', '返工', '打回'],
  'manual-effort': ['人工介入', '人工', '手动', '值守', '减少操作', '省事'],
};

const norm = (s) => String(s == null ? '' : s);

/** 文本 → 命中的判据集合（纯函数；只看有没有在说这条，不下结论） */
export function criteriaHit(text) {
  const t = norm(text);
  const hit = new Set();
  if (!t) return [...hit];
  for (const c of CRITERIA) {
    for (const kw of CRITERIA_KEYWORDS[c]) {
      // 纯 ASCII 的标识（C1–C4/token/miss 等）必须**整词**命中：中文文本里 '介入，不用'
      // 含子串 'C3'，用 includes 会凭空命中①（实测踩到）——指标名是标识符，不是普通词。
      // 边界用显式字符类（`[A-Za-z0-9_]`），不用 `\b`：JS 的 `\b` 把汉字当非单词字符，
      // 在"介入"这类词里挡不住 C3 这种子串。
      const matched = /^[\x00-\x7F]+$/.test(kw)
        ? new RegExp(`(?<![A-Za-z0-9_])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(t)
        : t.includes(kw);
      if (matched) { hit.add(c); break; }
    }
  }
  return [...hit];
}

/** 三值：true/false/null（null＝判不了）。任何非布尔输入一律 null，绝不 "!!undefined"。 */
const tri = (v) => (v === true ? true : v === false ? false : null);

/**
 * 判据评估（纯函数 + 夹具）：把三条判据各判成 true / false / null。
 *
 * @param {{judged?:object, evidence?:string, expectedBenefit?:string}} input
 *   `judged`：**机器可核**的三值（`{ 'c4-or-cost':true, 'delivery-speed':null, 'manual-effort':false }`）。
 *             谁给的值谁负责有证据；本模块不替它猜。
 *   `evidence` / `expectedBenefit`：文字信号来源，仅在 `judged` 没给该键时用于**认定"判不了"**。
 * @returns {{criteria:object, satisfied:string[], unknown:string[], needsHuman:boolean, note:string}}
 */
export function evaluatePriority(input = {}) {
  const judged = (input && input.judged && typeof input.judged === 'object') ? input.judged : {};
  const text = norm(input.evidence) + '\n' + norm(input.expectedBenefit);
  const hits = criteriaHit(text);
  const criteria = {};
  const satisfied = [];
  const unknown = [];
  const withSignal = [];   // 有信号、但机器没有可核的三值 ⇒ **专门要人去看**的那几条
  const flagged = [];      // 同上的标记（note 里区分"有信号无实测"与"无信号无实测"）
  for (const c of CRITERIA) {
    let v = tri(judged[c]);
    if (v === null && hits.includes(c)) {
      // 有信号、但没有机器可核的三值注入 ⇒ 判不了，交人看（**不猜 true**）
      v = null;
      withSignal.push(c);
      flagged.push(c);
    }
    criteria[c] = v;
    if (v === true) satisfied.push(c);
    else if (v === null) unknown.push(c);
  }
  const parts = [];
  if (satisfied.length) parts.push('判成：' + satisfied.map((c) => CRITERIA_CN[c]).join('、'));
  if (unknown.length) parts.push('判不了：' + unknown.map((c) => CRITERIA_CN[c] + (flagged.includes(c) ? '(有信号无实测)' : '(无信号无实测)')).join('、'));
  for (const c of CRITERIA) if (criteria[c] === false && !unknown.includes(c)) parts.push('判否：' + CRITERIA_CN[c]);
  return {
    criteria, satisfied, unknown,
    // `unknown` = "没有机器可核的三值"的全部判据（如实说全，**不粉饰**）。
    // `needsHuman` / `needsHumanCriteria` = 其中**看到了文字信号**的那些：它们最容易被机器顺手判成
    // "满足"（v0.3 §0.4 风险①自我表演），所以必须有人在环里。一条信号都没看到的项属于
    // "本来就不在这次提案的射程里"，不必拿它去惊动人。
    needsHumanCriteria: withSignal,
    needsHuman: withSignal.length > 0,
    note: parts.join('；') || '三条判据均无信号也无实测：按未判处理，交人。',
  };
}

/**
 * 排序（v0.3 §0.4 口径，**无权重**）：
 *   第 0 优先：满足任一判据（判为 true）的提案；
 *   第 1 优先：**判不了**的提案（`needsHuman`）——排在"已经判否"之前，因为未判不等于没价值，
 *              它只是还缺证据；这条同时保证"未判不会被静默丢掉"。
 *   第 2 优先：三条全判否的提案。
 * 同级内**保持输入顺序**（稳定排序），不引入任何隐性权重。
 * @param {Array} proposals 每项需带 `priority`（evaluatePriority 的返回值）与 `id`
 * @returns {Array} 新数组（不改入参）
 */
export function sortProposals(proposals) {
  const arr = Array.isArray(proposals) ? proposals.slice() : [];
  const rank = (p) => {
    const pr = p && p.priority;
    if (!pr || !Array.isArray(pr.satisfied)) return 1;              // 没判过 → 按"判不了"排
    if (pr.satisfied.length > 0) return 0;
    if (Array.isArray(pr.unknown) && pr.unknown.length > 0) return 1;
    return 2;
  };
  return arr
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.p);
}

/**
 * §0.4 铁律检查的**判据侧**那一半（`propose.js` 另有一份针对提案文本的检查）：
 * 有判据支持"加新功能"却没有一条落在①②③上的提案，必须标出来——因为 v0.3 明文写"三者优先于加新功能"，
 * 不是"加新功能禁止"。这里只做标记，不拦截。
 */
export function isNewFeatureOnly(p) {
  const pr = p && p.priority;
  if (!pr || !Array.isArray(pr.satisfied)) return false;
  if (pr.satisfied.length > 0) return false;
  const text = norm(p.title) + '\n' + norm(p.expectedBenefit) + '\n' + norm(p.basis);
  return /新功能|新增能力|新增功能|feature/i.test(text);
}
