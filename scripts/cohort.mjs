// scripts/cohort.mjs - RA-35 复测口径：把 usage_stats 的行切成「探针 / 真实 / 孤儿」三档（只读 SQL 片段，不碰 DB）
// 为什么必须是可复用的口径而不是一次性 SQL：
//   `scripts/baseline-cost.mjs` 是改造前后同一把尺（M1 步1 起就用它），而"改造后首次实测 C1 87.72%"
//   其实是**探针会话**的成绩。口径不固化，复测就会反复把探针当真实流量读，指标永远不可判。
//
// 三档定义（判据全部来自本库实测，不是推测）：
//   探针 = ① 会话标题命中命名族 `__*__` / `ST-*` / `B<数字>` / `PROBE`
//          ② 或该会话出现过 `audit_log.action LIKE 'prefix:%'`（C4/C5 账本只在改造批的探针会话里落过；
//             这条同时覆盖**已被清理、conversations 里已不存在**的探针会话 528–569）
//   孤儿 = conversation_id 在 conversations 里查不到的行（删会话留下的用量残行）
//   真实 = 其余
// ⚠️ 关键词判据（messages 里出现"探针/probe"）**不可用**：会话 #184 是真实长会话（占全量成本约 59%），
//    只是正文里讨论过"探针"；用关键词会把最贵的真实会话误杀。
// ⚠️ 时间窗一律按**库本地时间**：本库 `@@session.time_zone=SYSTEM`＝UTC+8（已实测 TIMEDIFF=08:00:00）。
//    历史文档里写的"06:30Z"按字面执行只剩 1 行——引用窗口时必须写明是库本地时间。

export const PROBE_TITLE_RE = '^(__.*__|ST-|B[0-9]|PROBE$)';

/** 探针行判据（可直接拼进 WHERE；假定查询里 usage_stats 未被别名，或用 alias 前缀） */
export const PROBE_WHERE = (alias = '') => {
  const p = alias ? alias + '.' : '';
  return `(${p}conversation_id IN (SELECT id FROM conversations WHERE title REGEXP '${PROBE_TITLE_RE}')
           OR ${p}conversation_id IN (SELECT conversation_id FROM audit_log WHERE action LIKE 'prefix:%' AND conversation_id IS NOT NULL))`;
};
export const ORPHAN_WHERE = (alias = '') => `${alias ? alias + '.' : ''}conversation_id NOT IN (SELECT id FROM conversations)`;
export const REAL_WHERE = (alias = '') => `NOT ${PROBE_WHERE(alias)} AND NOT ${ORPHAN_WHERE(alias)}`;

export const COHORTS = [
  ['全量', () => '1=1'],
  ['真实流量', (a) => REAL_WHERE(a)],
  ['探针', (a) => PROBE_WHERE(a)],
  ['孤儿', (a) => ORPHAN_WHERE(a)],
];
