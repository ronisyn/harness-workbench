# 变更说明（CHANGELOG）

> **依据**：《RW-Agent 引擎架构优化方案 v0.3》§4.1 运行面 —— "提示词/工具集/模型/存储/工作区**全部外部注入**；
> 存储走接口；单进程可启动；**有版本号与变更说明**。→ 验收 G1。
> 本文件就是那句话里的"**变更说明**"：**当前版本号**（单一出处＝`package.json` 的 `version`，经 `server/env.js`
> 的 `RW_VERSION` 暴露到 MCP 握手 `serverInfo`、JSON-RPC `system.capabilities` 与启动日志）与**逐条改了什么**。
>
> **纪律（照 07-文档写作规范"一处事实源、过时即错误"）**：
> · 只写**实际发生**的变更，每条附**提交号**，可逐条 `git show <短号>` 核对；**不预告、不编造**没做的改动。
> · 版本号**只在这里引用、不在这里定义**——定义在 `package.json`；本文件写的是"这一版包含哪些提交"。
> · 新条目加在**最上面**；条目格式：`## <版本> — <日期>` + 逐条 `- （短号）一句话说清做了什么`。
> · 只增不删：已发布的条目不再改写（历史写错了就在新条目里更正，不回头改）。

当前版本：**0.1.0**（＝`package.json` 的 `version`；本文件与它同源，不另写一份）。

---

## 0.1.0 — 2026-09-16

> 本批 commit 之前**没有版本号接线**：`package.json` 里有 `version`，但全仓零读取点，对外形态
> （MCP 握手 / JSON-RPC 握手 / 启动日志）都不报版本；`/api/health` 也只回 `{ok,service,ts}`。
> 本节记录的正是"把版本号接上"这一批改动（**未发布**：尚未 commit，故不附提交号）。

### 运行面：版本号接线 + 本文件（v0.3 §4.1"有版本号与变更说明"）

- 版本号**唯一出处**＝`package.json` 的 `version`；`server/env.js` 新增 `RW_VERSION`（读不到／不是合法 JSON
  时**如实**报 `'0.0.0'` 并告警，不猜、不编）。
- 暴露到三处对外形态：`server/mcp-server.js` 的 `SERVER_INFO.version`（MCP `initialize` 握手要报版本）、
  `server/jsonrpc.js` 的 `system.capabilities`（握手方法表逐条带 `version`）、启动日志一行（只加版本字段）。
- **`/api/health` 本次未动**：该文件的改动与另一个代理并行，按约定留给集成时补。

### 契约面：`permission` 进能力清单（v0.3 §7.1 ⑤"审批/权限/并行/超时声明化"）

- 65 条工具的 `permission` 从实现（`server/tools/index.js` 的每条工具定义）**搬进清单**
  （`server/tools/manifest.js` 的 `TOOL_PERMISSIONS`）；值逐条与改造前**一模一样**，档位不变。
- `server/tools/registry.js` 的装配期校验增加**交叉核对**：清单声明的 `permission` 与实现不一致**当场抛错**
  （与既有"cacheImpact 与事实不符就抛"同款做法）；`checkPerm` 改为**从清单读**，实现里那份副本删掉。
- 工具面（模型可见形状）**零漂移**：`test/fixtures/tools-snapshot.json` 与 `scripts/tools-face-diff.mjs`
  仍为漂移 0（快照只比 `description` / `parameters` / `permission`，三者的值都没变）。

### 读数自相矛盾：自我体检快照的金标集身份

- `server/selfeval/collect.js` 把 DB 行（字段名 `eval_ref`）传给了读 `s.ref` 的 `goldenSetIdentities()`
  ⇒ 快照里 `metrics.canary.goldenSets` **恒为 `{exists:false,count:0}`**，与同一份报告顶层的
  `golden`（`code@7a7cc14e7251`，9/9）自相矛盾。现改为传该函数的入参形状（`{ref}`），
  使快照里的 `goldenSets` 与顶层 `golden` 指向**同一套金标**（身份一致）。
- 新增夹具钉住这条一致性，并做过反向核对（改回错字段 ⇒ 夹具红）。

### 上下文面：溢出文件的权限（v0.3 §4.4"溢出文件的权限与保留期"）

- `server/tools/spill.js` 的明细落盘 `writeFileSync` 补 `mode: 0o600`（与 `server/credentials.js` 同款做法：
  权限在**创建时**就给，不靠事后 chmod；Windows 上 POSIX 模式无效，不做平台分支）。
- 新增夹具：POSIX 上真断言 `0600`，Windows 上按仓库既有跳过口径如实 skip。

---

## v0.3 §7.1 ⓪–㉔ 主体落地（提交 `17c74e9`）— 2026-09-16

- （`17c74e9`）**v0.3 §7.1 ⓪–㉔ 主体落地**：执行后端 / 存储抽象 / headless 形态 / 沙箱接线 / 交付面 /
  自进化（三源采集 → 提案流水线 → 优先级判据与指标回归门禁）逐项落地，各带夹具与本机真机验证。
- 同批带来的新文件含：`scripts/golden-report.mjs`、`scripts/ledger-export.mjs`、`scripts/metrics-gate.mjs`、
  `scripts/metrics-report.mjs`、`scripts/migration-rehearsal.mjs`、`.github/workflows/ci.yml` 等（逐条见该提交 diff）。

## v0.3 收尾批次（提交 `856ff90`）— 2026-09-16

- （`856ff90`）**v0.3 收尾批次**：⑫ 账本同源 · ⑯ argv 级执行后端 · ⑲+㉔ 双门禁 · ⑪ 升级演练 ·
  沙箱接线（夹具 + 真机验证）；涉及 `server/exec/local.js`、`server/exec/index.js`、`server/deliveries.js`、
  `server/driver.js`、`server/projection.js`、`server/runtrack.js`、`server/tools/hooks.js`、
  `server/tools/index.js`、`server/selfeval/regression-gate.js` 与对应夹具（逐条见该提交 diff）。

> 更早的历史（v0.3 之前的步 1–步 8 等）尚未整理进本文件；本文件从 v0.3 落地批次起逐条登记。
