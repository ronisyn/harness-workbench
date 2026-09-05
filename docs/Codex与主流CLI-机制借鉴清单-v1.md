# Codex 与主流 CLI · 机制借鉴清单 v1（RW 自我进化路线图）

> 性质：回答"RW 能否学习 Codex / 其他 CLI 长处优化自己"的施工蓝图。
> 依据：Codex CLI（OpenAI 开源，Apache-2.0）官方 README 与公开机制、Claude Code（Anthropic）工程实践、
> Aider（tree-sitter repo map）公开设计，对照 RW 服务器源码（server/agent.js、server/index.js、server/scheduler.js、docs/*）实测现状。
> 更新：随落地推进勾选。✅=已实现并验证 🔄=开发中 ⬜=未开始

## 0. 能力边界（先诚实说清"能学什么、不能学什么"）

| 层面 | 能否学习/改进 | 方式 |
|---|---|---|
| 模型权重本身 | ❌ 不能（权重在厂商侧，靠训练/微调） | — |
| Agent 机制/循环设计 | ✅ 能 | 改平台代码（server/*.js）+ reload_platform |
| 工具集与交互模式 | ✅ 能 | 工具注册表（server/tools/）+ 前端 |
| 上下文工程/提示策略 | ✅ 能 | agent.js 注入、ENV_MAP、技能、知识 |
| 行为纪律/流程 | ✅ 能 | docs/ 准则 + skills/ 技能 + kb 知识 |
| 观测与自我审计 | ✅ 能 | kpi.mjs、self-audit 技能、复盘 kb_add |

结论：**RW 已具备完整的自我进化闭环**（证据：docs/平台层差距清单.md 22 项能力全上线、git log batch0-9、技能库 6 个、记忆四层架构）。
下面清单是"下一批可从外部 CLI 借鉴的机制"，按价值×成本排序。

## 1. 已对齐项（Codex/Claude Code/Aider 有的，RW 已有 ✅）

| 外部机制（出自） | RW 落点 | 证据 |
|---|---|---|
| Agent 循环 + 护栏（Codex） | runAgent 循环、时间/轮次/循环检测护栏、并行上限 | server/agent.js |
| 上下文压缩 compaction（Claude Code/Codex） | >40 条摘要 + 运行中 >170 归档 + 工具结果 head/tail 修剪 | agent.js archiveEarlyContext/contextResultPrune |
| plan mode 只读规划（Codex/Claude Code） | conversations.mode=plan + plan_mode/exit_plan_mode + 改动门禁 | archive/3080机制对照 §2 |
| subagents（Claude Code） | subagent sync/async/join/fanout/fork/list/report | 平台层差距清单 F16-F18 |
| skills（Anthropic agent skills） | skills/<名>/SKILL.md + skill_load 跨轮注入 | F15 + 技能库 6 个 |
| 分层记忆 CLAUDE.md/AGENTS.md | ENV_MAP（平台级）+ projects/<p>/AGENTS.md（项目级）+ kb（用户级）+ 会话摘要 | 记忆架构 v1、index.js:331 |
| 目标/任务清单（Codex/Claude） | set_goal + plan_tasks/plan_done + 实时 PlanCard | F9/F10 |
| 审批/权限分层（Codex approval modes） | read/write/full/guard 预设 + 审批卡 + plan 只读门禁 | F20 |
| 会话恢复 resume（Codex --resume） | runtrack checkpoint + resumeHint + "现场已保存" | server/runtrack.js |
| 结构化问询（Codex/Claude） | ask_user 选项卡片 + 裁决 API | 3080对照 §2 |
| 外部驱动器/验收契约 | create_contract + 验收 shell DSL + finish_task | archive/3080机制对照 §5 |
| ralph 多轮独立视角 | 新 agent 共享工作区记忆文件推进目标 | 平台层差距清单 Parity Batch5 |

## 2. 真实差距（外部 CLI 有、RW 暂无，建议按批次落地）

### P1（高价值，推荐下一批做）
1. **✅ hooks 事件系统（Claude Code 特色）**（落地：server/tools/hooks.js 事件总线 + execTool 前/后集成 + hooks_list 工具，本批）
   - 外部：PreToolUse / PostToolUse / Stop / SubagentStop 等事件钩子，可在工具调用前后自动注入提示或执行脚本。
   - RW 现状：无 hooks；工具门禁靠 preset 静态集合（tools/index.js GUARDED/MUTATING_TOOLS）。
   - 价值：让"工具使用纪律/失败自检/停止善后"从提示词纪律变成平台强制钩子。
   - 落地记录：server/tools/hooks.js 轻量事件总线（registerHook/listHooks/clearHook/emitHooks，上限 128 条，按注册顺序执行，stop 短路）；execTool 在工具执行【前】触发 before 钩子（可 {stop,reason} 拦截或 {args} 浅合并改写参数）、【后】触发 after 钩子（观察审计，stop 仅留痕 result.hookAfter）；任何钩子抛错 warn 忽略，内置安全钩子（builtin+failClosed）异常时保守拦截，钩子永不拖垮主流程。内置 2 个强制纪律钩子：danger_command_guard（before run_command：rm -rf /与/*、fork bomb、dd 写盘、mkfs、shutdown/reboot、kill 1、chmod -R 777 / 等 fail-closed 拦截；精确路径 rm -rf 不误伤）与 system_write_guard（before 带 path 写工具：写 /etc /boot /usr/bin 等系统关键区 fail-closed 拦截；工作区/平台代码正常写）。模型侧只读 hooks_list 工具（core，已入默认启用集）排查"已被 hook 拦截"原因；清除/追加钩子仅平台管理员在配置/代码侧 registerHook 完成（不给模型动态注册，防伪纪律）。冒烟脚本 verify_hooks.mjs 16 PASS（拦截/放行不误伤/参数改写/抛错容错/stop 短路）。
2. **✅ 文件改动自动 checkpoint/undo（Claude Code checkpoint / Aider 自动 git）**（落地：server/tools/checkpoint.js + undo_checkpoint 工具 + execTool 集成）
   - 外部：每次文件修改前自动建恢复点（git 提交或快照），失败可回滚。
   - RW 现状：git_commit 工具靠 Agent 自觉 + 行为准则 4.2 纪律，无自动快照。
   - 价值：自我修改平台代码时安全网，回滚从"记得提交"变"自动留痕"。
   - 落地记录：execTool 在 write_file/append_file/edit_file/delete_file 执行【前】自动调 snapshotBeforeWrite()（try/catch 失败不阻断），快照原内容到 工作区/.rw-checkpoints/<会话>/<ts>-<seq>-<工具>/；undo_checkpoint 工具 {list:true} 列快照、{n:1} 回滚第 n 新（撤销栈语义：undo 成功即消费快照）。选快照而非 git commit：不污染提交历史，且非 git 工作区目录同样受保护。冒烟脚本 verify_cp.mjs 全 PASS（新建删除/覆盖恢复两条路径）。

### P2（中价值）
3. **✅ repo map / 代码库结构感知（Aider tree-sitter repo map）**（落地：server/tools/repomap.js + repo_map 工具，commit 211dc9b，2025-06 会话）
   - 外部：用 tree-sitter 生成仓库符号地图，让长代码库任务不迷路、少读文件。
   - RW 现状：有 find/grep/list_dir 工具，但无自动结构地图注入；Agent 靠探索纪律技能。
   - 价值：大代码库任务（如本次这类）上下文效率提升明显。
   - 落地：轻量首阶段（按建议落地）：`repo_map(dir)` 生成目录树+每文件行数/imports/顶层符号摘要，
     逐行正则提取符号（js/ts/py/go/rs/java/kt/c/cpp/rb/php/swift），容量受控（≤30K 字符、400 文件上限），
     不引入完整 tree-sitter。已注册 permission:read、tier core、入 DEFAULT_TOOLSET；15 项冒烟全过。
4. **⬜ 多模型交叉验证（可选）**
   - 外部：同一任务派 2 个不同厂商模型跑，比对关键结论（防单模型盲区）。
   - RW 现状：多厂商网关已有（models/providers），无交叉验证编排。
   - 价值：重要审计/代码评审任务可信度提升。
   - 建议落地：subagent_fanout 已有基础 → 加"双模型跑同一 prompt 再汇总"模板。

### P3（低价值/成本高，暂缓）
5. **⬜ MCP 生态接入（Codex/Claude Code 支持 MCP 工具服务器）**
   - 价值大但工程重（需 MCP 客户端+工具动态注册+鉴权），暂缓到 P1/P2 完成后再评估。
6. **⬜ watch 文件变更广播（3080 skills watch）**：服务器版价值低，不做（archive/archive/3080机制对照已注）。

## 3. 文档-实现差异（自查发现，顺手可修）
- ~~docs/记忆架构.md §4 写"自动触发（P2）：scheduler 扫 24h 无消息会话调用 conv_summarize"，~~
  ~~但 server/scheduler.js 实测只有 scheduled_tasks 表驱动，无自动归档逻辑 → 文档超前于实现。~~
  ~~处理：若保留该 P2，需在 scheduler 增加周期扫描（注意 LLM 成本，建议仅对 >40 条消息的静默会话触发）；或改文档标注"未实现"。~~
- ✅ **已解决**：server/scheduler.js 已落地 WS5e P2 自动归档（每 10 分钟扫：channel=web、24h 无消息、消息数>60、摘要落后于最后活动 → summarizeConversation，最多 3 个/轮，LLM 成本受消息数门槛约束）。文档与实现现已一致。

## 4. 执行顺序建议（1-2 已完成，剩余按序推进）
1. ✅ P1-2 自动 checkpoint（安全网，改动小，立即受益于自我修改场景）
2. ✅ P1-1 hooks 事件表（先内置 3-4 个强制钩子，验证价值后再开放注册）——已内置 2 个强制安全钩子验证价值；开放注册待 P2 repo_map 之后再评估（避免模型动态注册制造伪纪律）
3. ✅ P2-3 repo_map（大仓库任务提效）——落地 commit 211dc9b（server/tools/repomap.js + repo_map 工具，轻量符号扫描版）
4. ⬜ P2-4 双模型交叉验证（可选，配合审计需求）
每项走：git_commit 当前状态 → 改 → syntax_check → reload_platform → E2E 冒烟 → 更新本文档勾选 → **kb_add 更新 global 进度记忆**（防止"做了但记忆滞后 → 后续会话重复提议/假遗忘"——2026-09 实测根因：knowledge 表条目落后于 git 提交，导致 agent 反复说"还没做 P1-1"）。

## 5. 一句话回答（本文档的结论）
RW **有能力**学习 Codex / Claude Code / Aider 的长处来优化自己：模型权重改不了，但机制、工具、上下文工程、行为纪律全部可改、已改、正在改（22 项能力+6 技能+记忆四层即证据）。
下一批最值得抄的是 Claude Code 的 **hooks 事件系统** 与 **自动 checkpoint/undo**——它们把"纪律"变成"平台强制"，这正是主流 CLI 比提示词约束强的原因。
