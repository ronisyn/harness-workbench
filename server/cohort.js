// server/cohort.js - RA-35 复测口径：把 usage_stats 的行切成「探针 / 真实 / 孤儿」三档（只读 SQL 片段，不碰 DB）
// 2026-09-15 从 scripts/cohort.mjs 迁到这里：服务端 `/api/cache-hit/summary` 与复跑脚本必须用同一套判据，
// 否则首页显示的数与脚本复跑的数会各说各话。`scripts/cohort.mjs` 保留为转发层（export *），既有脚本零改动。
// 为什么必须是可复用的口径而不是一次性 SQL：
//   `scripts/baseline-cost.mjs` 是改造前后同一把尺（M1 步1 起就用它），而"改造后首次实测 C1 87.72%"
//   其实是**探针会话**的成绩。口径不固化，复测就会反复把探针当真实流量读，指标永远不可判。
//
// ── 定稿判据（2026-09-15 用"逐会话审计"定稿：tmp 审计脚本列出全部 79 个会话逐条判定）──────────
// 探针 = ① 会话标题命中命名族（见 PROBE_TITLE_RE）
//        ② 或该会话出现过 `audit_log.action LIKE 'prefix:%'`（改造批的 C4/C5 账本只在探针会话里落过；
//           这条同时覆盖**已被清理、conversations 里已不存在**的探针会话）
// 孤儿 = conversation_id 在 conversations 里查不到的行（删会话留下的用量残行）
// 真实 = 其余
//
// 审计结论（可复查）：本库 79 个会话中，**有 usage 行的一律落进"探针"或"真实"，没有第三个去处**——
//   即不存在"看起来像真实、其实是探针"的漏网会话。零用量的 24 个会话（标题多为"新对话"）不进 C1/C2 口径。
//
// ⚠️ 两条**已被证伪**的判据，别再走回头路：
//   · 关键词判据（messages 里出现"探针/probe"）不可用：会话 #184 是真实长会话（占全量成本约 59%），
//     只是正文里讨论过"探针"；用关键词会把最贵的真实会话误杀。
//   · 前缀账本 `prefix:*` **不能**单独当探针判据：真实定时任务会话 #185 每天也落 `first-round` 豁免。
//     它只能作 ①（命名族）的**补充**——用来捞已被删除的探针会话。
// ⚠️ 时间窗一律按**库本地时间**：本库 `@@session.time_zone=SYSTEM`＝UTC+8（已实测 TIMEDIFF=08:00:00）。
//    历史文档里写的"06:30Z"按字面执行只剩 1 行——引用窗口时必须写明是库本地时间。

// 命名族（严格版）：`__xxx__` / `ST-` / `B1`…`B7` 的四种写法（`B1`、`B1-x`、`B2C`）/ `PROBE`
// 收紧原因：原写法 `B[0-9]` 会把将来任何以 "B2…" 开头的**真实**标题（如"B2 方案对比"）误判成探针；
// 现在要求数字后紧跟连字符/结束/大写字母（`B2C`/`B2D` 这类历史命名也保留）。
export const PROBE_TITLE_RE = '^(__.*__|ST-|B[1-7](-|[A-Z]|$)|PROBE$)';

/** 探针行判据（可直接拼进 WHERE；假定 usage_stats 未被别名，或用 alias 前缀） */
export const PROBE_WHERE = (alias = '') => {
  const p = alias ? alias + '.' : '';
  // ⚠️ 账本那一支必须限定 `conversation_id NOT IN (SELECT id FROM conversations)`（=会话已删除）。
  // 为什么（2026-09-15 实测踩到）：`prefix:*` 是本轮改造引入的**归因账本**，**任何**新会话都会落它；
  // 不限定的话，改造后的真实会话会被判成探针 —— 实测：人造样本会话 conv=625（15 轮、C1 86.70%）
  // 就这么被从"真实流量"里踢了出去，导致 RA-35 的"新段真实流量"永远是 0。
  // 收窄后仍是原来那条有用的判据：捞回**已被清理**的探针会话（早期探针会话 528–569 已不在 conversations 里）。
  return `(${p}conversation_id IN (SELECT id FROM conversations WHERE title REGEXP '${PROBE_TITLE_RE}')
           OR ${p}conversation_id IN (SELECT conversation_id FROM audit_log
                                      WHERE action LIKE 'prefix:%' AND conversation_id IS NOT NULL
                                        AND conversation_id NOT IN (SELECT id FROM conversations)))`;
};
// 孤儿 = 会话已删的残行 **∪** `conversation_id IS NULL` 的无主行
//   · 前者是删会话留下的（曾实测到 5 个会话 10 行）；
//   · 后者是无会话上下文的执行（如 headless/探针直调 runAgent）留下的——`NOT IN (SELECT id …)` 对 NULL **不成立**
//     （NULL 比较结果是 UNKNOWN），所以必须显式写出来，否则它会悄悄混进"真实流量"分母里。
export const ORPHAN_WHERE = (alias = '') => {
  const p = alias ? alias + '.' : '';
  return `(${p}conversation_id IS NULL OR ${p}conversation_id NOT IN (SELECT id FROM conversations))`;
};
export const REAL_WHERE = (alias = '') => `NOT ${PROBE_WHERE(alias)} AND NOT ${ORPHAN_WHERE(alias)}`;

// 真实流量内部再分「人发起」与「定时任务」：定时任务是平台自己每天跑的（`定时任务：` 前缀），
// 它不是"用户真实使用"，但也不是探针 —— 混在一起会让"真实流量"这个说法失真。分开展示、合并不隐藏。
export const SCHEDULED_WHERE = (alias = '') => {
  const p = alias ? alias + '.' : '';
  return `${p}conversation_id IN (SELECT id FROM conversations WHERE title LIKE '定时任务：%')`;
};
export const SAMPLE_TASK_PREFIX = 'RA35样本-';
export const SAMPLE_WHERE = (alias = '') => {
  const p = alias ? alias + '.' : '';
  return `${p}conversation_id IN (
            SELECT c.id FROM conversations c JOIN scheduled_tasks t ON t.id = CAST(SUBSTRING_INDEX(c.external_id, '-', -1) AS UNSIGNED)
            WHERE c.external_id LIKE 'task-%' AND t.name LIKE '${SAMPLE_TASK_PREFIX}%')`;
};
// ⚠️ 「人发起」必须显式排掉样本：样本也是 channel='task' 的定时任务，但它不满足 SCHEDULED_WHERE
// （它的标题是"定时任务：RA35样本-…"，其实满足…）——真正的问题是样本由 task 会话承载、
// 同时满足 REAL_WHERE，若不显式排除就会被**同时算进人发起与样本**（加总自检当场报"不一致"）。
export const HUMAN_WHERE = (alias = '') => `(${REAL_WHERE(alias)}) AND NOT (${SCHEDULED_WHERE(alias)}) AND NOT (${SAMPLE_WHERE(alias)})`;

export const COHORTS = [
  ['全量', () => '1=1'],
  ['真实流量', (a) => REAL_WHERE(a)],
  ['  ├ 人发起', (a) => HUMAN_WHERE(a)],
  ['  ├ 定时任务', (a) => `(${SCHEDULED_WHERE(a)}) AND NOT (${PROBE_WHERE(a)}) AND NOT (${SAMPLE_WHERE(a)})`],
  ['  └ 样本(人造任务)', (a) => SAMPLE_WHERE(a)],
  ['探针', (a) => PROBE_WHERE(a)],
  ['孤儿', (a) => ORPHAN_WHERE(a)],
];
// 三个子档互斥且合起来 = 真实流量（人发起 + 定时任务 + 样本）。这句是给"分档表能不能加总"的自检口径：
// 若哪天某档写重了，c1-ceiling.mjs 的合计行会与"真实流量"行对不上，一眼可见。

// ── 自造会话的统一声明（2026-09-17）：**一处出处**；上面的判据一个字没改 ─────────────────────────
// 判据仍是那两条（命名族 / prefix 账本）。这里只回答另一半问题：**我们自己发起的会话怎么落进探针族**。
// 为什么必须有它（实测，不是洁癖）：`rw-run` / JSON-RPC / MCP 三个自造路径原先各自起 `rw-run: …`、
// `JSON-RPC: …`、`MCP: …` 这类**人读标题**，标题里没有任何族标识 ⇒ 按第 ① 条判据它们属于"真实流量"。
// 2026-09-16 的归因实测量到后果：新段 50 轮里 46 轮（92%）是我们自己发的、占全部未命中 97%，
// 扣掉它们只剩 4 轮 ⇒ 按既有判据"不可判"——C1/C2 的读数被自造流量污染，且是**口径问题不是引擎缺陷**。
// 正确做法是**让自造会话自己表明身份**（落进既有探针族），不是改判据、也不是加第三档。
// `__probe__` 属既有族 `__xxx__`；说明部分照旧写人读信息（`rw-run: <任务>`），与族前缀用空格分隔。
export const PROBE_TITLE_PREFIX = '__probe__';
/** 自造会话的标题：`__probe__ <说明>`。说明只做人读识别，**不得反过来当判据**（判据只有上面两条）。 */
export const probeTitle = (label) => {
  const note = String(label ?? '').trim();
  return note ? PROBE_TITLE_PREFIX + ' ' + note : PROBE_TITLE_PREFIX;
};
