// server/selfeval/propose.js —— 自进化②「把三源读数转成提案」的那一半（v0.3 §7.1 ㉒收集 / ㉓流水线）
//
// ── 铁律（v0.3 §0.4，本文件按它写死，不提供开关）──────────────────────────────────────────
//   「产出的是**提案**，改自己代码仍需人工审批，铁律不松」（风险②自我放行）。
//   ⇒ 本模块**只产出提案对象**；落库在 `write.js`（且只允许落 `extension_demands` / `evo_goals`）。
//   ⇒ 提案文本里出现"自动执行/自动提交"这类**要求机器自己动手**的动作，一律拦下（`checkIronLaw`）。
//      注意区分："禁止自动提交"是**合规**表述（在说必须人工），不是违规——见 `hasAutomationIntent`。
//   ⇒ 每条提案强制带 `verification`（验证方式）；缺了就拒（夹具锁住）。
//
// ── 三源各做到什么程度（**如实登记，不吹**）──────────────────────────────────────────────
//   ① 自我体检：**全自动**（`collect.js` 从真库读 C1–C5/失败率/金标/载体水位，规则命中即产提案）。
//   ② 外部对标：**半自动**——没有"读 DS/CD 变化"的机制，也**不硬造抓取器**（会造出未经验证的
//      外部事实）。做法＝人工/文档输入 + 采集入口：把 `docs/` 下的借鉴清单与实测报告当输入，
//      解析出"候选对标项"，每项一条提案（进 `extension_demands` 待审），**逐项判适配性交人**。
//      ⚠️ 文档自身自述"已不再维护"（`docs/Codex与主流CLI-机制借鉴清单-v1.md` 顶部），
//      所以这一源产出的提案**依据是文档、不是活的外部变化**——这一点在提案正文里明写。
//   ③ 业务反馈：**人工半自动**——现有 `intake_submit` 采的是插件/应用开发需求，
//      **不采岗位绩效与痛点**（《符合性核对》§1.4）。本模块提供一个"人在环"的采集入口：
//      一份文本（每条一行）→ 每条一条提案 → `extension_demands` 待审。
//      真正的"岗位绩效自动采集"未做，如实登记在交付说明里。
import fs from 'node:fs';
import path from 'node:path';
import { CRITERIA, evaluatePriority, sortProposals, CRITERIA_CN } from './priority.js';
import { fingerprint, METRIC_STATUS } from './collect.js';

/** v0.3 的引用前缀：每条提案的 `basis` 都要能指到条款或实测数据，不许"凭空觉得"。 */
export const V03 = 'proposals/RW-Agent引擎架构优化方案-v0.3.md';

export const SOURCE_CN = { selfeval: '自我体检', benchmark: '外部对标', feedback: '业务反馈' };

/**
 * 去向规则（**写清楚，才能被审**）：一张提案只能进两张表之一。
 *   · `evo_goals`（人力优化事项，`server/index.js` 的 A7 进化集）= ①②③判据指向"引擎自己变好"的事项；
 *   · `extension_demands`（扩展需求，审批台）= 能力/业务诉求（对外部对标项与业务反馈项）。
 * 判据：**产出物是引擎改动 ⇒ evo_goals；产出物是能力/资产诉求 ⇒ extension_demands。**
 * 两张表都没有内容指纹列（`server/db.js` 只给了业务列，本轮不许改表）⇒ 幂等靠指纹写进文本
 * （`fprint:<hash>`），按它 EXISTS 查一次再插。
 */
export const ROUTING = {
  selfeval: { table: 'evo_goals', kind: 'engine-improvement', reason: '引擎自身的优化事项（人控事项）：判据①②③指向"引擎自己变好"' },
  benchmark: { table: 'extension_demands', kind: 'manual', reason: '外部对标项＝能力诉求：须逐条判适配性，从"需求"入口进审批台（不是先立项）' },
  feedback: { table: 'extension_demands', kind: 'manual', reason: '业务反馈＝岗位绩效/痛点转化出的能力诉求，同名入口（intake 同表）' },
};

// ── 铁律检查 ─────────────────────────────────────────────────────────────────────────────
/** 要求"机器自己动手改代码/提交"的措辞（**黑名单**） */
export const AUTOMATION_PATTERNS = [
  /自动提交/i, /自动\s*commit/i, /自动\s*push/i, /auto[- ]?commit/i, /git\s*commit/i, /git\s*push/i,
  /自动执行/i, /自动运行/i, /自动改建/i, /自动修改代码/i, /自动改自己/i, /无人值守下(自行|自动)/,
  /自行\s*(提交|推送|上线|发布|合并|部署)/, /直接改代码/i, /直接提交/i, /自行落地/i,
];
/** 否定语境：出现这些词说明说的是"必须人工/禁止自动"，是**合规**表述 */
const NEGATION = /(不得|禁止|不许|不可|不能|仍需|必须|一律|只允许|只在|不自行|禁止自动|不得自动)/;
const NEG_WINDOW = 14;

/** 文本是否在**要求**自动化（否定语境里的黑名单词不算） */
export function hasAutomationIntent(text) {
  const t = String(text == null ? '' : text);
  const re = new RegExp(AUTOMATION_PATTERNS.map((r) => r.source).join('|'), 'gi');
  let m;
  while ((m = re.exec(t)) !== null) {
    const around = t.slice(Math.max(0, m.index - NEG_WINDOW), m.index + m[0].length + 2);
    if (!NEGATION.test(around)) return { hit: true, text: m[0], around: around.trim() };
  }
  return { hit: false };
}

/** 提案必填字段（缺一个都不许写库） */
export const REQUIRED_FIELDS = ['id', 'source', 'title', 'basis', 'action', 'expectedBenefit', 'risk', 'verification', 'priority', 'kind', 'route'];

/**
 * 铁律 + 必填检查（纯函数，夹具直测）。
 * @returns {{ok:boolean, violations:string[], missing:string[]}}
 */
export function checkIronLaw(p) {
  const violations = [];
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    const v = p ? p[f] : null;
    const empty = v === null || v === undefined || (typeof v === 'string' && !v.trim())
      || (Array.isArray(v) && !v.length) || (f === 'priority' && (!v || typeof v !== 'object'));
    if (empty) missing.push(f);
  }
  if (missing.length) return { ok: false, violations, missing };
  // 铁律①：任何字段都不许要求机器自己动手（不止 action —— 验证方式里塞"改完自己 commit"同样违规）
  const scanned = [['title', p.title], ['basis', p.basis], ['action', p.action], ['expectedBenefit', p.expectedBenefit],
    ['risk', p.risk], ['verification', p.verification], ['locator', p.locator]];
  for (const [field, val] of scanned) {
    const r = hasAutomationIntent(val);
    if (r.hit) violations.push(`${field} 出现要求自动化的措辞「${r.text}」（上下文：…${r.around}…）——v0.3 §0.4：产出物只能是提案，改自己代码仍需人工审批`);
  }
  // 铁律②：每条提案都必须声明"需人工审批"（这是提案对象的本义，漏了就说明它想跳过审批）
  if (p.manualApprovalRequired !== true) violations.push('manualApprovalRequired 必须为 true（v0.3 §0.4 风险②：不许自我放行）');
  if (p.autoApply === true || p.autoExecute === true || p.autoCommit === true) violations.push('提案不得带 autoApply/autoExecute/autoCommit（v0.3 §0.4 铁律）');
  return { ok: violations.length === 0, violations, missing };
}

// ── ② 外部对标：文档 → 候选对标项（**半自动**）────────────────────────────────────────────
/**
 * 归一化标题：归一后用于**同文件去重**。
 * 实测：同一项会在 §2 与 §4 各写一遍（§4 那份还带"P2-4 "前缀与一句拍板说明），
 * 不去重就会产出两条一模一样的提案 —— 审批台上会显得像两条独立需求。
 * 做法：剥掉 markdown 强调、成对括号、分隔号与空白，再砍掉**尾部的拍板/出处附注**
 * （"— 主会话 2026-…"、"—— 见 §4" 这类），最后取前 60 字当 key。
 */
export function normalizeCandidateTitle(s) {
  return String(s || '')
    .replace(/\*\*/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    // 开头的批次/路线图编号（'P2-4 '、'A3 '…）：只影响 key，**不改展示标题**（人还要看它指哪一段）
    .replace(/^[PA]\d+(?:[-.]\d+)?\s+/, '')
    .replace(/[—–-]{1,}\s*主会话[\s\S]*$/, '')
    .replace(/[—–-]{1,}\s*见\s*§[\s\S]*$/, '')
    .replace(/[：:；;，,。.\s—–-]+/g, '')
    .slice(0, 60)
    .trim();
}
/**
 * 文档里已明说"不做/暂缓/价值低"的项**不进候选**：三源里的外部对标本来就要防"照搬"，
 * 把文档自己否掉的项提出来只会制造噪音（实测：借鉴清单 §2 的第 6 项写着"服务器版价值低，不做"）。
 * ⚠️ 词表**不**收"不再维护"这类**文档级**判断（那会把文档里所有候选一起误杀）——
 *    文档"不再维护"这件事由 `BENCHMARK_SOURCES[].note` 如实带进提案正文。
 */
const REJECTED_ITEM = /(不做|不实现|暂缓|暂不|价值低|已放弃|不考虑)/;
const isRejected = (title) => REJECTED_ITEM.test(String(title || ''));

/**
 * 解析借鉴清单（`kind:'list'`）：只认 **未做** 的条目（✅ 已落地的不再提）。
 * 形如：`3. **⬜ 多模型交叉验证（可选）**（主会话…）` → 取 `⬜`/`[ ]` 开头标记的那一行。
 */
export function parseListDoc(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    // ⬜ / [ ] / TODO 开头的清单项（行首序号可有可无）
    const m = line.match(/^(?:[-*]\s*)?(?:\d+\.\s*)?(?:\*\*)?\s*(?:⬜|\[\s\]|TODO)\s*[:：]?\s*(.+)$/i);
    if (!m) continue;
    const title = m[1].replace(/\*\*/g, '').replace(/[:：]\s*$/, '').trim();
    if (!title || isRejected(title)) continue;
    const key = normalizeCandidateTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title.slice(0, 160), note: '', line });
  }
  return out;
}

/**
 * 抽取"收益/成本"标注（两种写法都收——真文档两种都有）：
 *   · 括号式：`（收益高、成本低）`
 *   · 句尾无括号式：`。收益最高、成本最低（一次提示词装配分层）`
 * ⚠️ 不许像第一版那样写成 `（[^）]*(?:收益|成本)[^）]*）`：它会贪婪吞下整句，
 *    实测把 "收益最高、成本最低（一次提示词装配分层）" 一整个当成标注。所以两种写法都限定**短语长度**。
 */
export function gainOf(body) {
  const s = String(body || '');
  const paren = s.match(/（([^）]{0,12}(?:收益|成本)[^）]{0,12})）/);
  if (paren) return paren[1];
  const tail = s.match(/(收益[^，。；]{0,6}[，、]\s*成本[^，。；（]{0,6})/);
  return tail ? tail[1] : null;
}

/**
 * 解析实测报告（`kind:'report'`）：只在"可移植/可借鉴"类小节里，取形如
 * `1. **把动态内容从 system prompt 里赶出去**：…（收益最高、成本最低）` 的编号条目。
 */
export function parseReportDoc(text) {
  const out = [];
  const seen = new Set();
  let inSection = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) { inSection = /可移植|可借鉴|借鉴|适配|建议/.test(h[1]); continue; }
    if (!inSection) continue;
    const m = line.match(/^(\d+)[.、]\s+(.+)$/);
    if (!m) continue;
    const body = m[2].trim();
    const title = (body.match(/^\*\*(.+?)\*\*/) || [null, body.slice(0, 80)])[1].replace(/[：:]\s*$/, '').trim();
    if (!title || isRejected(title)) continue;
    const key = normalizeCandidateTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const gain = gainOf(body);
    out.push({ title: title.slice(0, 160), gain, note: gain ? `文档标注：${gain}` : '', line });
  }
  return out;
}

/**
 * 采集入口：读一批**人工/文档输入**，产出候选对标项。
 * 文件缺失/不可读 → 如实返回 `errors`（**不许**把读不到当成"没有对标项"）。
 */
export function collectBenchmarkCandidates({ root = process.cwd(), sources = [] } = {}) {
  const items = [];
  const errors = [];
  for (const s of sources) {
    if (!s || !s.path) continue;
    const abs = path.isAbsolute(s.path) ? s.path : path.join(root, s.path);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); }
    catch (e) { errors.push(`${s.path}: 读不到（${String(e.message || e)}）`); continue; }
    const parsed = s.kind === 'report' ? parseReportDoc(text) : parseListDoc(text);
    for (const c of parsed) {
      items.push({
        sourceId: s.id || s.path, docPath: s.path, docNote: s.note || '',
        title: c.title, gain: c.gain || null, note: c.note || '',
        originLine: c.line.slice(0, 200),
        // 适配性**未判**：v0.3 §2.6 要求逐条判"适配性"并说明理由，这一步是人的活
        adaptability: '未判（需人看源码/条款后逐条给结论）',
      });
    }
  }
  return { items, errors };
}

// ── ③ 业务反馈：人工输入（每条一行）──────────────────────────────────────────────────────
/** 解析反馈文本：`- 事项（可选|来源）`；忽略空行与 `#` 注释行 */
export function parseFeedback(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const body = line.replace(/^[-*]\s*/, '').replace(/^\d+[.、]\s*/, '').trim();
    if (!body) continue;
    // 支持 `事项 | 来源/岗位` 与 `事项【来源】` 两种写法
    const m = body.match(/^(.*?)\s*(?:\|\s*(.+)|【(.+?)】)\s*$/);
    out.push({ title: (m ? m[1] : body).trim().slice(0, 160), origin: (m ? (m[2] || m[3]) : '').trim().slice(0, 60) || null });
  }
  return out;
}
export function readFeedbackFile({ root = process.cwd(), file }) {
  if (!file) return { items: [], errors: [] };
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  try { return { items: parseFeedback(fs.readFileSync(abs, 'utf8')), errors: [], path: abs }; }
  catch (e) { return { items: [], errors: [`反馈文件读不到：${file}（${String(e.message || e)}）`], path: abs }; }
}

// ── ① 自我体检：快照 → 提案（规则命中即产；**不做阈值判断**）──────────────────────────────
const fmt = (n) => (n == null ? '未取到' : Number(n).toLocaleString('en-US'));

/**
 * 从快照派生提案（纯函数）。规则的设计口径：**只用"有/无/结构性事实"当触发条件，
 * 不用自造阈值**。例如"某会话成本占比最高"是结构性事实（一定能算出），
 * 而"占比 > 25% 才提案"就是自造阈值 —— 后者一律不做（v0.3 §0.3 只报数不设线）。
 */
export function rulesFromSnapshot(snapshot) {
  const m = (snapshot && snapshot.metrics) || {};
  const c1c2 = m.c1c2 || {};
  const real = (c1c2.cohorts && c1c2.cohorts.real) || {};
  const ledger = m.c4c5 || {};
  const failures = m.failures || {};
  const c3 = m.c3 || {};
  const pipeline = m.pipeline || {};
  const canary = m.canary || {};
  const win = ((snapshot && snapshot.window) || {}).days;
  const out = [];
  const ref = (s) => `${V03} ${s}`;

  // R1 · C1/C2 不可判（新段真实流量不足）—— v0.3 §0.3.1 第 3 条 + §0.4 风险①（防"拿探针成绩顶判据"）
  const judgeable = real.status === METRIC_STATUS.OK && Number(real.rounds) >= 30;
  if (!judgeable) {
    out.push({
      rule: 'R1-unjudgeable-window',
      title: `本窗口真实流量不足以判 C1/C2（${Number(real.rounds) || 0} 轮）：请如实标"不可判"，不要用探针成绩或旧数据顶判据`,
      basis: `${ref('§0.3.1 第 3 条')}（累计 C1 被历史锁死；新段才是机制是否生效的证据）＋实测：本批次窗口 ${win} 天内真实流量 ${Number(real.rounds) || 0} 轮、探针 ${Number((c1c2.cohorts && c1c2.cohorts.probe && c1c2.cohorts.probe.rounds) || 0)} 轮`,
      action: `按 §0.3.1 的口径执行：① 报表/提案一律分开列"真实 / 探针 / 孤儿"三档，探针成绩只作机制级取证；② 需要判据时先攒够真实流量（人发起或定时任务），或按 §0.3.1 用 RA35_CUTOFF 重新切段后再读。`,
      locator: 'scripts/ra35-report.mjs（切段读数）· scripts/cohort.mjs（分档口径）· 未定位（"候选对标项/体检读数进入提案"这一步本轮才建）',
      expectedBenefit: '让"机制是否生效"的结论有据可依，避免把探针成绩当成真实流量成绩（历史上正是这样让 C1 反复不可判）',
      risk: '若真实流量长期不足，这条提案会反复出现；处置是攒流量或明确声明不可判，**不是**给它编一个阈值',
      verification: '在服务器上跑 `node scripts/selfeval-collect.mjs --days 7 --json`，看 `metrics.c1c2.cohorts.real.rounds`；再用 `node scripts/ra35-report.mjs` 复跑同一窗口，两处轮数与档位必须一致',
      judged: { 'c4-or-cost': null, 'delivery-speed': false, 'manual-effort': null },
      evidence: 'C1/C2 读数（仅报数；判定线在 §0.3.1/RA-35，不在本模块）',
    });
  }

  // R2 · C4 非预期失效（v0.3 §0.3：目标 0；每次失效必须能说出触发原因）
  const c4 = ledger.c4Invalidate;
  if (Number(c4) > 0) {
    const rows = (ledger.recent || []).filter((r) => r.action === 'prefix:invalidate').slice(0, 5);
    out.push({
      rule: 'R2-c4-invalidate',
      title: `C4 出现 ${c4} 次非预期前缀失效：逐条归因并消除（目标 0）`,
      basis: `${ref('§0.3 C4 行')}（非预期失效次数，目标 0；不含首轮/切模型/折叠边界/长空闲/工具面变更）＋实测：窗口 ${win} 天内 \`audit_log.action='prefix:invalidate'\` 共 ${c4} 行`,
      action: '逐条读账本明细，把触发原因归到"允许的那几类"之外：' + (rows.length ? rows.map((r) => `conv=${r.conversationId ?? '-'} ${String(r.detail || '').slice(0, 60)}`).join('；') : '（近期无明细，查 audit_log）') + '。归因后给出最小修法（典型是"会话内改写前缀"，见 §4.4.1 规则1）。',
      locator: 'server/agent.js:571-577（C4 落账点，isUnexpectedBreak）· server/prefix-participants.js（PREFIX_LEDGER）',
      expectedBenefit: 'C4 每减一次就是一段前缀不再整段重算：v0.3 §0.3 的潜在收益测算为输入成本 ¥242 → ¥13（命中到 99% 时）',
      risk: '可能把"预期失效"误判成非预期（切模型/工具面变更/首轮/长空闲/折叠边界都不计）——先把账本明细读全再动手',
      verification: '改动后在服务器上跑 `node scripts/selfeval-collect.mjs --days 7 --json`，看 `metrics.c4c5.c4Invalidate` 归零；再用 `node scripts/baseline-cost.mjs` 复核"失效账本（audit_log）"一行同口径',
      judged: { 'c4-or-cost': true, 'delivery-speed': null, 'manual-effort': null },
      evidence: `C4 机检读数 ${c4} 行（v0.3 §0.3 的 C4 机检口径）`,
    });
  }

  // R3 · 失败码 TOP（口径＝failure-report：真实会话；**不给失败率设线**，只按次数排）
  const codes = (failures.byCode || []).filter((c) => Number(c.n) > 0);
  if (failures.status === METRIC_STATUS.OK && codes.length) {
    const top = codes[0];
    const toolHint = (failures.byTool || []).filter((t) => t.code === top.code).map((t) => `${t.tool}×${t.n}`).join('、');
    out.push({
      rule: 'R3-failure-code',
      title: `失败码最高的是「${top.code}」（${top.n} 次 / 涉及 ${top.tools} 个工具）：归因并给出可重试或可预防的修法`,
      basis: `${ref('§4.8')}（横切 A：评测与可观测；失败如实上报）＋实测（口径＝scripts/failure-report.mjs，排除夹具哨兵会话）：窗口 ${win} 天工具调用 ${fmt(failures.calls)} 次、失败 ${fmt(failures.fails)} 次` + (toolHint ? `，该码集中于 ${toolHint}` : ''),
      action: `用 \`node scripts/failure-report.mjs ${win}\` 看全量分布与码表（server/failures.js 的 retryable/note）；对「${top.code}」判断属于"可重试（重试即消失）"还是"可预防（提示/参数/前置校验）"，择一改造并在清单里补上声明。`,
      locator: 'server/failures.js（码表单一出处）· server/tools/index.js（错误码落账）· 未定位（具体修法要看归因结果）',
      expectedBenefit: '减少"失败→重试→再失败"的空转轮次；失败率本身**不作为判据**（本仓口径是只报数不设线），判据落在"减少人工介入/提高交付速度"',
      risk: '失败码可能集中在夹具/探针会话——本口径已排除 `conversation_id<=0`，但若哨兵会话用了正数 id 会混入；动手前先抽查两条明细',
      verification: `改动后同窗口复跑 \`node scripts/failure-report.mjs ${win}\`，看「${top.code}」次数与 \`node scripts/selfeval-collect.mjs --days ${win} --json\` 的 \`metrics.failures.byCode\` 一致下降；两侧数字必须相等（同口径）`,
      judged: { 'c4-or-cost': false, 'delivery-speed': true, 'manual-effort': null },
      evidence: `失败码读数（只报数；不设线）`,
    });
  }

  // R4 · 成本集中度（**结构性事实**：占比最高的会话；不设阈值，占比多少都如实报）
  const top = (c3.topConversations || [])[0];
  if (c3.status === METRIC_STATUS.OK && top && Number(c3.total) > 0) {
    out.push({
      rule: 'R4-cost-concentration',
      title: `成本集中在 conv=${top.conversationId}（占本窗口真实流量 ¥${Number(top.cost).toFixed(2)} / ¥${Number(c3.total).toFixed(2)}）：先归因再决定动不动`,
      basis: `${ref('§0.3 C3 行与基线说明')}（成本高度集中：三个长会话占 ¥238/¥255.9）＋实测：窗口 ${win} 天真实流量成本 ¥${Number(c3.total).toFixed(2)}，` +
        (c3.topConversations || []).slice(0, 3).map((t) => `conv=${t.conversationId} ¥${Number(t.cost).toFixed(2)}（${t.share == null ? '-' : (t.share * 100).toFixed(1) + '%'}）`).join('、'),
      action: '读这几个会话的逐轮 miss 构成与前缀失效账本，判断浪费来自"整段重建/换纪元/长空闲"哪一类，再决定改机制还是改用法。**不要**先改上下文策略。',
      locator: 'server/agent.js（前缀冻结与失效归因）· server/prefix-participants.js（组件声明）',
      expectedBenefit: 'v0.3 §0.3：输入成本 ¥242 → 命中到 99% 时约 ¥13（降约 95%）；集中度越高，改一处收益越大',
      risk: '单会话读数会被它自己的历史锁死（§0.3.1 第 2 条）——结论必须结合分段读数，不能只看累计',
      verification: '同窗口先后跑两次 `node scripts/selfeval-collect.mjs --days ' + win + ' --json`，比较 `metrics.c3.topConversations[0].cost` 与 `metrics.c3.perRun`；再跑 `node scripts/ra35-report.mjs` 看新段真实流量的 C1/C2 是否同向变化',
      judged: { 'c4-or-cost': true, 'delivery-speed': false, 'manual-effort': false },
      evidence: 'C3 读数（只报数）',
    });
  }

  // R5 · 金标读数缺失/跑不起来（v0.3 §0.4 的 M3 **准入前置**：金标回归必须在位）
  const canaryMissing = canary.status !== METRIC_STATUS.OK || !canary.available || !(canary.shells || []).length;
  const canaryBad = (canary.shells || []).filter((s) => s.error || (s.total != null && s.passed !== s.total) || s.skipped);
  if (canaryMissing || canaryBad.length) {
    out.push({
      rule: 'R5-canary-not-in-place',
      title: '金标回归读数不完整：准入前置未满足，本轮提案只能"待审"不能自动进入落地',
      basis: `${ref('§0.4 M3 准入前置')}（"金标回归 + 失效监控（C4）必须在位，否则自进化=盲改"）＋实测：` +
        (canaryMissing ? '本窗口未取到任何启用金标的壳（`shells.eval_ref` 为空或 `server/canary.js` 跑不起来）' : canaryBad.map((s) => `${s.skey}: ${s.error ? 'error' : s.skipped ? 'skipped' : `${s.passed}/${s.total}`}`).join('、')),
      action: '先在壳上配 `eval_ref` 指向 eval/ 下的金标文件，并确认 `node scripts/golden-report.mjs --only <壳>` 能跑出 passed/total；把结果导出留档（§4.8"评测结果可导出"）。**指标回归门禁（㉔ 后半）不在本轮范围**，此处只确保读数在位。',
      locator: 'server/canary.js（runGoldenChecks）· scripts/golden-report.mjs（门禁判定与导出）· eval/code.json',
      expectedBenefit: '满足 §0.4 的准入前置；没有它，任何"改完指标变好了"的说法都没有回归依据',
      risk: '把"读不到库/壳上没有 eval_ref"当成"金标通过"是最危险的假绿——本模块只用 `skipped`/`error` 如实上报，不给绿色',
      verification: '`node scripts/selfeval-collect.mjs --days 7 --json` 的 `metrics.canary.shells` 每项都有 total/passed，且与 `node scripts/golden-report.mjs --quiet` 的结论一致（同源 server/canary.js）',
      judged: { 'c4-or-cost': null, 'delivery-speed': null, 'manual-effort': true },
      evidence: '金标读数（skipped/error 一律如实上报，不当通过）',
    });
  }

  // R6 · 载体空转（提案链断点：㉓ 的症状——四张表各 0 行）
  const dStatus = (pipeline.demandsByStatus || []).reduce((s, r) => s + Number(r.n || 0), 0);
  const empty = Number(pipeline.evoGoals || 0) === 0 && Number(pipeline.evoGoalTasks || 0) === 0 && dStatus === 0;
  if (pipeline.status === METRIC_STATUS.OK && empty) {
    out.push({
      rule: 'R6-pipeline-empty',
      title: '提案载体全空（evo_goals / evo_goal_tasks / extension_demands 均 0 行）：链断在"产出提案"，本轮首次接线',
      basis: `${ref('§7.1 ㉓')}（提案流水线复用进化集：目标×任务 + 审批台）＋实测：` +
        `evo_goals=${pipeline.evoGoals}、evo_goal_tasks=${pipeline.evoGoalTasks}、extension_demands=${dStatus}、evo_memos=${pipeline.evoMemos}`,
      action: '本轮已接上线（server/selfeval/ + scripts/selfeval-*.mjs）：先跑一次 `node scripts/selfeval-collect.mjs`，再 `node scripts/selfeval-propose.mjs --write` 落提案，然后在进化集审批台逐条审。**空转不是靠改代码治好的，是靠有人审**。',
      locator: 'server/selfeval/propose.js（三源 → 提案）· server/selfeval/write.js（只允许写这两张表）· server/index.js 的 /api/evo/goals 与 /api/extensions/demands（审批台，只读引用）',
      expectedBenefit: '让三源第一次真的产出提案；M3 出口要求"连续两个周期产出并落地提案，≥1 条来自外部对标、≥1 条来自自我体检"',
      risk: '为凑数产出低价值提案（§0.4 风险①自我表演）——判据①②③未满足的项必须留在"待审"，不许被当成落地',
      verification: '跑 `node scripts/selfeval-propose.mjs --write` 后查 `extension_demands`/`evo_goals` 行数；同一批次日再跑一次，行数**不得增加**（幂等）',
      judged: { 'c4-or-cost': null, 'delivery-speed': null, 'manual-effort': true },
      evidence: '载体水位读数（结构性事实）',
    });
  }

  // R7 · 口径自检：快照自己报出的采集错误（读不到库/某档查询失败）
  const errs = (snapshot && snapshot.collectErrors) || [];
  if (errs.length) {
    out.push({
      rule: 'R7-collect-error',
      title: `采集本身有 ${errs.length} 处未取到：先修采集，再谈指标（缺数不许当 0）`,
      basis: `${ref('§4.8')}（横切 A：可观测；账本落账在引擎）＋实测：` + errs.slice(0, 5).join('；'),
      action: '按错误逐条排查（典型：库不可达、表为存量库形状、Shells 未配 eval_ref）。修好后重跑采集，确认 `collectErrors` 为空。',
      locator: 'server/selfeval/collect.js（collect* 各函数的 errors 汇总）',
      expectedBenefit: '避免"缺数被读成 0"这类最贵的误判（no-denominator 与 0 是两件事）',
      risk: '把采集失败当"指标很好"——本模块对分母为 0 一律给 null 并标 status，不返回 0',
      verification: '`node scripts/selfeval-collect.mjs --days 7 --json | Select-String collectErrors`（PowerShell）或 `| grep collectErrors`，应为空数组',
      judged: { 'c4-or-cost': null, 'delivery-speed': null, 'manual-effort': true },
      evidence: '采集错误清单',
    });
  }

  return out;
}

// ── 组装提案 ─────────────────────────────────────────────────────────────────────────────
function toProposal(seed, { source, batchId }) {
  const route = ROUTING[source] || ROUTING.selfeval;
  const id = `${source}:${seed.rule || fingerprint(seed.title)}:${fingerprint(batchId, source, seed.rule || seed.title)}`;
  const fp = fingerprint(batchId, source, seed.rule || seed.title);
  const proposal = {
    id,
    fingerprint: fp,
    batchId,
    source,
    sourceCn: SOURCE_CN[source] || source,
    rule: seed.rule || null,
    title: String(seed.title || '').trim(),
    basis: String(seed.basis || '').trim(),
    action: String(seed.action || '').trim(),
    locator: String(seed.locator || '').trim() || '未定位',
    expectedBenefit: String(seed.expectedBenefit || '').trim(),
    risk: String(seed.risk || '').trim(),
    // 验证方式**必填**：没有它就没法做"前后指标对比"（v0.3 §0.4 风险①的对策）
    verification: String(seed.verification || '').trim(),
    // 铁律：任何提案都要人工审批
    manualApprovalRequired: true,
    kind: route.kind,
    route: { table: route.table, reason: route.reason },
    extra: seed.extra || null,
  };
  proposal.priority = evaluatePriority({ judged: seed.judged, evidence: seed.evidence, expectedBenefit: proposal.expectedBenefit });
  return proposal;
}

/**
 * 三源 → 提案数组（纯函数；不碰库、不写文件）。
 * @param {{snapshot:object, benchmark?:{items:Array,errors?:Array}, feedback?:{items:Array,errors?:Array}}} input
 */
export function buildProposals({ snapshot, benchmark, feedback } = {}) {
  const batchId = (snapshot && snapshot.batchId) || 'selfeval-unknown';
  const list = [];
  const notes = [];

  for (const seed of rulesFromSnapshot(snapshot)) list.push(toProposal(seed, { source: 'selfeval', batchId }));

  // 外部对标：**逐条**产提案（每条都要人判适配性），但上限截断并如实标注（防一次刷屏几百条）
  const bItems = (benchmark && benchmark.items) || [];
  const BMAX = 20;
  for (const it of bItems.slice(0, BMAX)) {
    list.push(toProposal({
      rule: `benchmark:${it.sourceId}:${fingerprint(it.title, it.docPath)}`,
      // 源标签只由 `formatProposals` 打一次（`[外部对标]`）——标题里不再自带，否则会打成 `[外部对标] [外部对标] …`
      title: it.title,
      basis: `${V03} §2（参考基线 DS/CD）＋§2.6（不照搬的两件事）＋§0.4 M3 三源之一「外部对标」。依据文档：\`${it.docPath}\`${it.docNote ? '（' + it.docNote + '）' : ''}；原句：\`${it.originLine}\``,
      action: `逐条判适配性后再决定做不做（v0.3 §2.6 要求给出"为什么不照搬"的理由）。${it.gain ? '文档标注收益/成本：' + it.gain + '。' : ''}适配性结论：${it.adaptability}。**未判适配性前不得立项**。`,
      locator: '未定位（对标项要落到具体改造点，须先读源码定位）',
      expectedBenefit: it.gain ? `文档标注：${it.gain}` : '待判（须结合本仓实测；文档标注只是候选）',
      risk: '照搬与现环境不适配的机制（§2.6 已明确两件不照搬）——这类"抄了就坏"的风险必须由人判',
      verification: `先在沙箱/探针会话里小样验证该机制在本仓的效果，再跑 \`node scripts/selfeval-collect.mjs --days 7 --json\` 做前后对比；\`${it.docPath}\` 的勾选状态随落地更新`,
      judged: { 'c4-or-cost': null, 'delivery-speed': null, 'manual-effort': null },
      evidence: `文档输入（半自动源）：${it.docPath}`,
      extra: { docPath: it.docPath, originLine: it.originLine, adaptability: it.adaptability },
    }, { source: 'benchmark', batchId }));
  }
  if (bItems.length > BMAX) notes.push(`外部对标候选 ${bItems.length} 条，本次只取前 ${BMAX} 条（其余留待下一批；截断如实登记，不静默丢弃）`);
  if (benchmark && (benchmark.errors || []).length) notes.push(...benchmark.errors.map((e) => '外部对标输入错误：' + e));

  // 业务反馈：逐条
  const fItems = (feedback && feedback.items) || [];
  for (const it of fItems) {
    list.push(toProposal({
      rule: `feedback:${fingerprint(it.title, it.origin)}`,
      // 同上看：标签由 formatProposals 统一打，标题保持原样（人工录入的痛点原句）
      title: it.title,
      basis: `${V03} §0.4 M3 三源之三「业务反馈（岗位实际绩效与痛点）」。来源：${it.origin || '人工录入（未注明岗位/来源）'}。` +
        `⚠️ 如实登记：现有 \`intake_submit\`（server/tools/index.js:1139-1158）采的是**插件/应用开发需求**，**不采岗位绩效与痛点**；本条来自人工采集入口。`,
      action: '把痛点翻译成"可交付的能力诉求"（触发场景/期望效果/涉及壳/代码动作类型齐备才够立项，口径同 intake），然后走审批台；采纳后由平台立项，**不是**引擎自己改。',
      locator: '未定位（须先澄清场景与涉及壳）',
      expectedBenefit: '直接对应岗位真实痛点（这是三源里唯一"外部真实需求"的信号）',
      risk: '单条反馈可能是个人偏好而非共性痛点——判据③"减少人工介入"要落到可计量的操作次数上',
      verification: '落地后在同岗位复采一轮反馈，看同一痛点是否不再出现；涉及操作次数的指标用工作台/会话账本计数前后对比',
      judged: { 'c4-or-cost': null, 'delivery-speed': null, 'manual-effort': null },
      evidence: `业务反馈（人工采集）：${it.origin || '未注明'}`,
      extra: { origin: it.origin },
    }, { source: 'feedback', batchId }));
  }
  if (feedback && (feedback.errors || []).length) notes.push(...feedback.errors.map((e) => '业务反馈输入错误：' + e));

  const sorted = sortProposals(list);
  // 逐条铁律/必填自检：不合格的**不进结果**（宁缺毋滥——写了没验证方式的提案等于没有提案）
  const rejected = [];
  const ok = [];
  for (const p of sorted) {
    const chk = checkIronLaw(p);
    if (chk.ok) ok.push(p); else rejected.push({ id: p.id, title: p.title, ...chk });
  }
  return {
    batchId, proposals: ok, rejected, notes,
    counts: { total: ok.length, bySource: ok.reduce((s, p) => { s[p.source] = (s[p.source] || 0) + 1; return s; }, {}) },
  };
}

// ── 渲染（落库文本 / 打印）───────────────────────────────────────────────────────────────
const prioLine = (p) => {
  const parts = [];
  for (const c of CRITERIA) {
    const v = p.priority.criteria[c];
    parts.push(`${CRITERIA_CN[c]}=${v === true ? '是' : v === false ? '否' : '判不了'}`);
  }
  return parts.join(' · ');
};

/** `extension_demands.content`（TEXT，按 2000 字截断——口径同 index.js:2643 的 content.slice(0,2000)） */
export function renderDemandContent(p) {
  return [
    `【批次】${p.batchId}`, `【来源】${p.sourceCn}`, `【指纹】${p.fingerprint}`,
    `【依据】${p.basis}`, `【建议改动】${p.action}`, `【涉及位置】${p.locator}`,
    `【预期收益】${p.expectedBenefit}`, `【风险】${p.risk}`, `【验证方式】${p.verification}`,
    `【优先级】${prioLine(p)}（v0.3 §0.4：①②③优先于"加新功能"；无加权公式）`,
    `【人工审批】必需（v0.3 §0.4 风险②：产出物只能是提案，改自己代码仍需人工审批）`,
  ].join('\n');
}

/** `evo_goals.name` / `evo_goals.descr`（VARCHAR(200)/VARCHAR(1000)，超长截断） */
export function renderGoal(p) {
  return {
    name: p.title.slice(0, 200),
    descr: [
      `【批次】${p.batchId}`, `【来源】${p.sourceCn}`, `【指纹】${p.fingerprint}`,
      `【依据】${p.basis}`, `【建议改动】${p.action}`, `【涉及位置】${p.locator}`,
      `【预期收益】${p.expectedBenefit}`, `【风险】${p.risk}`, `【验证方式】${p.verification}`,
      `【优先级】${prioLine(p)}`,
    ].join('\n').slice(0, 1000),
  };
}

/** 控制台打印（dry-run 用；一行一条 + 详细模式展开字段） */
export function formatProposals(result, { verbose = false } = {}) {
  const L = [];
  L.push(`批次 ${result.batchId} · 提案 ${result.counts.total} 条（` +
    Object.entries(result.counts.bySource).map(([k, v]) => `${SOURCE_CN[k] || k} ${v}`).join(' / ') + '）');
  if (result.rejected.length) L.push(`⚠️ 被铁律/必填拦下 ${result.rejected.length} 条（未产出）：` + result.rejected.map((r) => r.title).join('；'));
  for (const n of result.notes || []) L.push('· ' + n);
  result.proposals.forEach((p, i) => {
    L.push('');
    L.push(`${String(i + 1).padStart(2)}. [${p.sourceCn}${p.priority.satisfied.length ? ' ★' : ''}] ${p.title}`);
    L.push(`    去向：${p.route.table}（${p.route.reason}）`);
    L.push(`    优先级：${prioLine(p)}${p.priority.needsHuman ? ' → 需人确认' : ''}`);
    if (verbose) {
      L.push(`    依据：${p.basis}`);
      L.push(`    建议改动：${p.action}`);
      L.push(`    涉及位置：${p.locator}`);
      L.push(`    预期收益：${p.expectedBenefit}`);
      L.push(`    风险：${p.risk}`);
      L.push(`    验证方式：${p.verification}`);
    }
  });
  if (!verbose && result.proposals.length) L.push('\n（默认只打摘要；加 --verbose 打印全部字段）');
  return L.join('\n');
}
