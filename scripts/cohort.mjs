// scripts/cohort.mjs - 口径单一来源已迁到 `server/cohort.js`（服务端接口与脚本共用同一套判据）
//
// 为什么迁：2026-09-15 的缓存双轨指标要**同时**出现在 ①首页状态带（server/index.js 的
// `/api/cache-hit/summary`）和 ②复跑脚本（c1-ceiling / c1-dsh-parity / cache-perrequest …）。
// 若各写一份 WHERE，两处口径必然漂移 —— 而这份口径本身就是"复测结果可不可信"的前提
// （历史上正是探针会话被当成真实流量，才让 C1 反复不可判）。
//
// 保留本文件为**转发层**：所有既有脚本的 `import ... from './cohort.mjs'` 一律不用改。
export * from '../server/cohort.js';