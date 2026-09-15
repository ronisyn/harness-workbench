# 15 · harness 复用评估

> 状态：调研记录，**结论待用户确认**。
> 来源：本机实际读取 `@deepseek-ai/dsh` 的 `package.json`、`LICENSE`、`lib/`、`config/`、`node_modules/@deepseek-ai/*` 的包描述。非二手信息。
> 用途：支撑 Tier 1 ① 的决定（引擎用现成还是自研），以及 ADR-5 的修订提议。

---

## 0. 结论先行

**harness（`@deepseek-ai/dsh`）不只是"一个引擎"，它是一个 MIT 开源的模块化 agent 平台，且其架构与我们独立设计的方案几乎逐条收敛。**

→ 建议：**通用件复用 harness，业务件自研。**（即：不重造沙箱/压缩/会话/审批，只做多租户/计费/连接器/岗位包/产品化。）

---

## 1. 已验证的事实（直接读文件确认）

| 项 | 值 |
|---|---|
| 许可 | **MIT**（读了 `LICENSE` 和 `package.json`） |
| 版本 | `0.1.0-rc.7`（早期候选版，**不是为多租户 SaaS 打磨过的成品**） |
| 自身定位 | `dsh CLI: profile boot, plugin management, and the browser UI alias` |
| `lib/` 是什么 | 只是**启动器**（解析 profile / patch / 插件），不是 agent 本体 |
| agent 本体在哪 | `node_modules/@deepseek-ai/*` 的一百多个独立包 |

---

## 2. harness 的架构形态（和我们的"岗位包"高度同构）

harness 本身是**配置驱动**的：

```
profile（预设，如 code / cordis / minimal / standard）
   + patch overlay（yaml 覆盖层，可叠加）
   + plugin（插件，可增删）
   + skill（技能，可挂载）
```

**这恰好就是"岗位包 + 覆盖层 + 技能/插件"的活样本。** 我们设计的"客户改配置不改内核"，harness 的 `patch overlay` 就是同一个思想。

---

## 3. 逐条映射：我们设计的 ↔ harness 真实存在

包描述原文（翻译）逐条对上：

| 我们文档里的设计 | harness 包（真实存在） | 原文要点 |
|---|---|---|
| 05 · 沙箱"规格与实现分离" | `dsh-sandbox` | 「**SandboxProvider contract**，同一套隔离词汇表」 |
| 05 · 沙箱策略按会话解析 | `dsh-sandbox-policy` | 「每次调用解析沙箱策略，含**部署回退 + 会话模式 + 工作区根**」 |
| 06 · 无权限/超时**默认拒绝** | `dsh-user-approval` | 「一次性权限决定，**fail-closed by default**」 |
| 08 · **大结果落盘只留引用** | `dsh-spill` | 「**保存超大的工具文本，返回一个检索定位符**」 |
| 08 · 工具结果截断 | `dsh-compaction-tool-result-pruner` | 「对工具结果做 **head/middle/tail 修剪**，免模型」 |
| 08 · 压缩由 token 驱动 | `dsh-compaction-basic` | 「**token 计量驱动**的压缩策略 + LLM 摘要后端」 |
| 08 · 缓存/token 精确计量 | `dsh-token-meter` | 「**replay-aware** 的 token 计量」 |
| 07 · 引擎可换、适配器 | `dsh-llm` | 「**厂商无关的 LLM 服务接口**」 |
| 01 · 凭证永不进沙箱 | `dsh-credentials` | 「配置只存**引用**，**provider 持有真正的值**」 |
| 01 · 会话绑定工作区 | `dsh-workspace` | 「持久的工作区记录 + **校验过的会话挂载**」 |
| 13 · 检查点 | `dsh-session-checkpoint-policy` | 「在模型请求和工具副作用**之前**做检查点」 |
| 05 · 规格是少数几个预设 | `dsh-permission-presets` | 「一个权限选择器，**打包沙箱模式和审批策略两个旋钮**」 |
| 09 · 子 agent 统一接口 | `dsh-subagent` | 「**命名 provider 注册表**，委托给子 agent」 |
| 目标/多轮驱动 | `dsh-goal` / `dsh-goal-round-driver` | 「事件溯源的目标状态 + 竞态防护的轮次驱动」 |
| 模型网关 | `dsh-llm-deepseek` / `dsh-llm-pi-ai` / `dsh-llm-retry` | 多厂商 + 重试 |

**这不是巧合。** 我们昨天独立推出来的架构，和一个正在运行的平台的实际架构**收敛到几乎逐条一致**。

含义有两层：
1. **设计方向是对的**——不是"我说对"，是"它和现实对上了"。
2. **重写量比想象少一大半**——这些通用件已经 MIT 开源、能读、能改、能商用。

---

## 4. harness **没有**的（= 你真正的护城河）

| harness 已有（复用） | harness 没有（自研） |
|---|---|
| 引擎循环、压缩、会话、子 agent、审批、token 计量、权限预设、凭证、工作区 | **多租户隔离**（它是单用户本地 agent） |
| | **计费**（无多客户账单） |
| | **连接器**（无 ERP / Shopify / Amazon 对接，只有 MCP 客户端） |
| | **业务岗位包**（它的 preset 是 code/minimal/standard 这类通用开发预设，不是"供应链计划员"） |
| | **产品化对外接口**（多租户的 API + 嵌入） |
| | ⚠️ **内核级隔离（gVisor/microVM）**（见下） |

> ⚠️ **Day 4 第 3 轮自审修正：把"沙箱"从上表的"已有（复用）"里拿出来了。**
> **实读 dsh 0.1.5-rc.2**：`dsh-sandbox-local` = **bwrap / landlock-run / macOS Seatbelt / Windows ACL**，描述里明写 **same-world confinement**，且 **functionally probed, fail-closed**；**README 里没有 gVisor / runsc / microVM / kata**。
> **判据**：harness 的"沙箱"是**同世界进程约束**（限制 agent 自己的权限）；
> 我们要的是**把 agent 当不可信工作负载**（ADR-1），必须**另一个内核**。
> **所以**：**接口借（`SandboxProvider` 契约），实现自研（gVisor）**；harness 那边唯一能借的做法是 **fail-closed + 功能探针**（`20` §1.1.1）。
>
> **这条修正很重要**，因为它直接改变工作量估计——**沙箱从"移植"变成"自研 + 运维"**（含 gVisor 的生产化、版本跟进、性能调优）。

**一句话：你不是"造一个 agent 平台"，你是"在 harness 上做一个多租户的行业 agent 平台"。**

---

## 5. 由此提议修订 ADR-5（✅ 已执行，结论演进过）

| 阶段 | ADR-5 的表述 |
|---|---|
| 原文 | 引擎可换、**壳自研** |
| 本文当时的提议 | 引擎用 harness（MIT）；壳在 harness 通用件之上扩展 |
| **最终定稿**（见 [`19`](./19-platform-vs-agent-boundary.md)） | **平台（Ronisyn）自研 + 三个 agent 可插拔**（roni / DS harness / codex harness） |

"壳自研"不是错，是**太宽**——壳确实由你掌控、维护，但通用件不重造。

> 🔔 **后来的认识更进一步**：**"壳"这个概念本身被拆成了"平台"和"agent 运行时"两层**，见 [`19`](./19-platform-vs-agent-boundary.md)。本文的映射表（§3）仍然有效——它证明了我们的设计与一个成熟平台的实现**逐条收敛**。

---

## 6. 诚实边界

- 以上对包的判断来自**包名 + 官方描述**，**没有逐行读实现**。质量和深度未验证。
- harness 是 `rc.7` 早期版本，**未针对多租户 SaaS 做生产化**；它的"单用户本地"前提和你"多租户服务"目标之间的差距，是自研工作量真正的所在。
- "复用"不等于"拿来就能跑"：harness 的隔离是**本地单用户**级别的，要升级成**跨客户硬隔离**仍需改造——这正是 01/05 两份文档还在的原因。
