# RW 蓝图 A/B 域双重对照审计（A=会话与状态管理 / B=上下文与提示工程）

> 审计时间：2026（会话内）。基线蓝图：docs/平台开发全集清单-v1.md（v2.6）。
> 判定符号：✅=蓝图所述真实现且无缺陷 · 🐛=实现了但有 bug/与蓝图文字不符 · 📝=代码里有但未接入/未启用（写了没做）· 🔶=部分实现 · ⬜=未实现 · 🔍=待核（本次未能逐行核完，附已确认要点）。
> 证据一律 file:行。CLI 参照：Claude Code / Codex / opencode / Aider / DSH-harness(3080)。

---

## 代码对照

### A 域：会话与状态管理

| 蓝图行 | 蓝图现状声明 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|---|
| 会话生命周期 | ✅ 增删查；❓ 归档/回收 UI、跨会话搜索 | ✅（蓝图如实；归档有"内容级"实现但无 UI） | CRUD：server/index.js:141-178（GET/POST/PATCH/DELETE）；前端列表/新建/删除 src/Chat.jsx:191-194,287-304 | 增删查+重命名全部真实存在。归档**内容管线**已超蓝图：conv_summarize 工具 server/tools/index.js:865-905、scheduler 每10分钟自动归档 24h 无消息且>60 条会话 server/scheduler.js:107-124——但**无会话隐藏/回收 UI、无检索入口**，归档结果仅在 >40 条历史时以【早期对话摘要】system 注入（index.js:357-370），跨会话搜索 ⬜ 属实。 |
| 断点与现场 | ✅ agent_runs/resumeHint+undo；❓ 唤醒包 | 🐛（蓝图行滞后：唤醒包 P16 已实施；undo 为文件快照式） | ensureRun/checkpoint/markRun：server/runtrack.js:31-56；resumeHint 含 git 摘要（=唤醒包）：runtrack.js:9-24,66-78；注入点 index.js:429-432；undo_checkpoint：server/tools/index.js:1081-1096 + tools/checkpoint.js（写前自动快照 snapshotBeforeWrite tools/index.js:1059）；重启自检 interruptStaleOnBoot index.js:1032 | "❓唤醒包"文字与实现不符——P16（resume 注入工作区 git 状态摘要）批1 已落地并实现在 resumeHint 内（runtrack.js:71）。undo 是"写类工具自动快照→回滚文件"，非 Claude 式每步 checkpoint/时间旅行。仅任务路径登记 run（light 问答不登记，index.js:527-531），恢复依赖模型+resumeHint 续跑，无"回卷"。 |
| 自动压缩 | 🔶 折叠+conv_summaries（阈值调优 F3） | ✅（F3 已实施；蓝图状态列滞后） | 语义折叠 maybeCollapseEarly：server/agent.js:291-334；轻归档 archiveEarlyContext：agent.js:113-135；会话摘要 generateSummary→conv_summaries：index.js:246-272、注入 index.js:357-370；F3 阈值键：agent.js:140,151-155 + settingsSchema.js:15-18 | 折叠（run 内）+conv_summaries（>40 条懒生成）+scheduler 自动归档三层都在且可配（collapse_min_gap/keep_msgs/trigger_chars/input_chars 0=默认）。蓝图行括号内"阈值调优 F3"属批1 已完成项，行状态未刷新。 |
| 多会话/队列 | 🔶 并发=设置项（C1：默认5/0不限） | 🔶（上限✅，但"超限进可见队列"名不副实） | max_concurrent_chats：index.js:337-344（默认5/0不限）；schema settingsSchema.js:22；超限 429 提示"当前另有 N 个在跑" index.js:341-343；inflight 计账 index.js:344,639；前端输入队列（busy 时排队）Chat.jsx:476-510、面板 857-878 | 服务端**无排队**：超限即 429 拒绝（仅文本可见队列数）。前端"队列"是 busy 期间输入消息排队（Chat.jsx:480-486），与并发上限是两个机制。蓝图效果列"超限进可见队列"夸大了。 |
| 导出/分享 | ✅ md 导出（含思考轨迹）；❓ JSONL | ✅（蓝图如实） | 服务端 md 导出（含 reasoning🧠+工具🔧）：index.js:186-207；前端本地 Blob 导出（含 think/traces）：Chat.jsx:331-347（Ctrl+E 354） | 双实现均含思考与轨迹。JSONL 全仓库无（grep 无匹配）→ ❓ 属实。无分享链路。 |
| 命名/搜索 | ❓ 自动标题+重命名 | 🔶（自动标题=朴素截断在跑、LLM 版形同虚设=📝；重命名✅；搜索 UI⬜） | 朴素标题：index.js:353-355（首条消息 LEFT(content,24)，仅当 title 为'新对话'/空）；LLM 版 autotitle.js:5-27 + 端点 index.js:169-172 + 触发 Chat.jsx:455；重命名 UI：Chat.jsx:306-318,755-765 | 🐛/📝 要点：朴素截断先于 LLM 触发——第一条用户消息即把标题改成 24 字符截断，此后 autotitle.js:8 `title!=='新对话' → skipped`，LLM 自动标题**正常流程永不触发**（Chat.jsx:455 每轮空调用一次 HTTP 即 skip），标题质量=生硬截断（可能断句）；仅 force API 可救。跨会话搜索 UI 无。 |

### B 域：上下文与提示工程

| 蓝图行 | 蓝图现状声明 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|---|
| 系统提示分层 | 🔶 ENV_MAP 单块偏大；❓ 分层预算 | 🔶（P13 三层已拆但仍是"一条"大消息；分层预算⬜；兼容导出冗余📝） | 三层常量：server/agent.js:167-198（ENV_ENV / ENV_IDENTITY(permission) / ENV_DISCIPLINE）；装配 buildEnv=三层 join 为**单条 system**：agent.js:212-213；权限动态身份 agent.js:175-184；旧 ENV_MAP 兼容导出 agent.js:201 无任何外部引用（仅注释 238 提及） | P13 拆三层属实且身份随 permission 变化（read/write 会话不再注入 full 能力暗示）。但三层仍在 msgs[0] 拼成**一条** ~2.4k 字符 system（纪律层最大），未按层隔离/独立刷新；"分层预算"（每层 token 预算）未实现。ENV_MAP 兼容导出成死代码。 |
| 项目记忆层级 | 🔶 projects/<p>/AGENTS.md；❓ 目录级 | 📝（代码在但不可达：项目列无任何写入路径） | 注入代码：index.js:418-427（读 RW_WORKSPACE/projects/<convProject>/AGENTS.md，≤16000 字符，且要求 project!=='default'）；project 列定义 db.js:68 DEFAULT 'default'；全 server 无任何写 project≠default 的路径（grep 'project' 仅 db.js:68、index.js:319,348,421 三处读） | 写入侧不存在：会话创建 API（index.js:147-153）/PATCH（155-167）/渠道均不接受 project 参数，UI 无项目选择器 → project 恒 'default' → 419-427 的 gate `!=='default'` 使 AGENTS.md **永不可达**（除非手工改库）。属"写了没接上"。目录级 AGENTS.md ⬜。 |
| 运行时上下文 | ✅ 快照（轮次/护栏/成本/rev） | ✅ | pushSnapshot：server/agent.js:239-254（含第 N 轮/已用分钟/护栏现值 budget/roundCap/loopGuard/parallel、累计 token in/out、¥成本、cache hit %、mode/permission/preset、policy rev、resume 标注）；append 到消息尾部 agent.js:253（P8，注释 236-238 说明缓存友好动机）；每轮重注入前先删旧快照 240-243 | 与蓝图文字一致（快照=轮次/护栏/成本/rev），且快照含缓存命中率（P8 测量）。注意快照只在 agent 执行循环注入；纯问答(light)单轮同样走 runAgent 所以有。 |
| 工具结果预算 | ✅ 4000/12000 截断；❓ 分级+落盘 | 🔶（截断✅；分级/落盘指针部分在但**指针失真**=🐛细节） | 单条结果上限 msgCap=子代理12000/其他4000：agent.js:560；contextResultPrune 头60%+尾30%+中段指针：agent.js:65-72；分级：工具参数瘦身 slimToolCallForContext agent.js:89-109、早期归档 archiveEarlyContext agent.js:113-135、历史消息截断带 id 指针 index.js:462-468 | 截断数字与蓝图一致。但"落盘指针"承诺"全文可按 tool_call_id 用 db_query 查 tool_calls.args"（agent.js:101 等）与真实落库不符：tool_calls.args/result_summary 均 **slice(0,2000)** 入库（tools/index.js:1074-1075）→ 超大 write/grep 结果的"全文"其实无全量落盘（run_command 另有日志、job 走 job_output）。指针声明>实际存储（🐛）。"分级"已有雏形但未成设置项级能力。 |
| 压缩策略 | 🔶 折叠（F3）；❓ 重复抑制 | 🔶（折叠✅；重复抑制未做——除 hint 去重） | 折叠：agent.js:291-334；唯一"重复抑制"=每轮只留一条 COMPLETION_HINT：agent.js:583-586；后台/子代理通知去重 bgNoted：agent.js:257-285；loopGuard 防相同调用：agent.js:513-527 | "同结果不重发"式的输出级重复抑制未实现；现有去重仅限评估提示与完成通知。折叠相关（成本入账 O-10/阈值 F3）已闭环见 A3。 |
| 污染防护 | 🔶 agent 路径已兜底；❓ 普通路径缺口 O-1 | ✅（比蓝图更进一步：O-1 结构性消除，行状态滞后） | P1 统一工具通道（needsTools 仅降级为 schema 宽度）：index.js:515-519、agent.js:367-371（light→LIGHT_TOOLSET）；B6 假完成打回 agent.js:425-449、B6b 假开始（taskish 最近4条扫描+大正则+hasSubstance）agent.js:451-473；只读意图门禁 hooks.js:187-194；占位符检疫=execTool 入口 hasPh（tools/index.js:1006）+写类二次 rejectPh（tools/index.js:126,129,134；正则 26-31） | 蓝图 B6 行"❓普通路径缺口 O-1"已过时——O-1 批1 已修复且无工具路径结构性消除（见 O-1 台账行 ✅）。O-13 占位符检疫双检疫在位（入口+写类 run 内），与 tools/index.js:23-25 注释一致；O-12 B6b 检测代码与台账描述吻合（误伤风险=正则广，待运行验证，属观察项非缺陷）。 |

### 决策/台账行核对（P4/P8/P13/P16/F3/F4、O-1/O-10/O-12/O-13）

| 行 | 蓝图结论 | 判定 | 证据 | 说明 |
|---|---|---|---|---|
| P4 意图挡位 | ✅ 批1（删会话 mode+高成本自荐） | ✅ | 只读意图注入：index.js:433-447；**真实拦截**：hooks.js:187-194（READONLY_MUTATING 14 工具 readonly_intent_guard）；高成本自荐：index.js:448-457 | 只读是请求级且执行层拦截（hooks 先于审批，tools/index.js:1020-1027），非仅提示。 |
| P8 快照移位+cache hit 测量 | ✅ 批1 | ✅ | pushSnapshot append 尾部：agent.js:253（240-243 删旧）；hit 率累计 cumHit/cumMiss：agent.js:233,381；快照展示 hit%：agent.js:249 | 与注释"前缀=固定注入+增长历史稳定命中"一致（index.js:459-475 git 块也移至尾部）。 |
| P13 提示三层 | ✅ 批1 | ✅（见 B1，兼容导出冗余📝） | agent.js:167-198 | 拆层完成；见 B1 说明。 |
| P16 唤醒包 | ✅ 批1 | ✅ | runtrack.js:9-24（gitStateSummary：HEAD+脏区≤15行）、注入 resumeHint runtrack.js:66-78、index.js:429-432 | 与 A2 行"❓唤醒包"矛盾的是蓝图 A 域行未刷新，代码已实现。 |
| F3 折叠阈值 | ✅ 批1 | ✅ | agent.js:140,151-155 + settingsSchema.js:15-18 | 间隔/保留/触发字符/输入截断四键可配（0=默认）。 |
| F4 连续失败 | ✅ 批1 | ✅ | consecutive_fail_guard 默认3：settingsSchema.js:20、agent.js:156；计数/软提示/挂起：agent.js:230-231,567-580（N 次软提示、2N 次 paused 保留现场） | 与 loopGuard（同调用）互补，实现与蓝图文字一致。 |
| O-1 假开始（普通路径） | ✅已修复（批1 统一通道） | ✅ | needsTools 仅作 schema 宽度：index.js:519；统一 runAgent：index.js:515-531 | 结构性消除无工具路径；light 模式仍允许零工具直接答（问答合法）。 |
| O-10 折叠成本入账 | ✅已修复（批1 kind=collapse） | 🔶（仅 in-run 折叠入账；会话摘要类旁路仍不入账） | in-run 折叠入账 kind='collapse'：agent.js:313-324；但 generateSummary（index.js:246-272，>40 条懒摘要）与 conv_summarize/scheduler 归档（tools/index.js:872-905）用 chatOnce/裸 fetch **不写 usage_stats**；autotitle.js:15-26 同样裸 fetch 不入账 | 台账"折叠/归档成本未入账已修复"只覆盖折叠路径；会话级摘要/自动归档/标题生成三处旁路 LLM 消耗仍未入账（钱包仍虚低），批6 P23 只解决"用哪个模型"未解决"入账"。 |
| O-12 B6b 自身观察 | 📌运行验证 | ✅（代码在，验证状态维持📌） | agent.js:451-473（taskish 最近4条扫描 + promiseRe/hasSubstance/leadingPromise） | 实现与台账描述一致；误伤防线（hasSubstance 放行）在。属观察项。 |
| O-13 占位符检疫 | 📌观察 | ✅（双检疫在位） | PH_RE：tools/index.js:26-31；入口 hasPh：tools/index.js:1006；写类 run 内 rejectPh：tools/index.js:126,129,134 | 描述"入口+写类二次检疫"与代码一致；正则组合广，对"正文恰含截断/归档字样"的合法写入存在误伤面（观察项）。 |

---

## CLI对照

> 参照：Claude Code（[checkpointing](https://code.claude.com/docs/zh-CN/checkpointing)）、Codex（[resume](https://mintlify.wiki/openai/codex/cli/resume)）、opencode（session list/resume）、Aider（repo map/git 时间线）、DSH-harness(3080)。建议结论：a=采纳调整 / b=不调整 / c=现象不同。

| 设计点 | 成熟 CLI 怎么做 | RW 怎么做 | 差异优劣势 | 建议 |
|---|---|---|---|---|
| A1 会话生命周期 | Claude Code `--resume/--continue`+目录化会话文件；opencode TUI `/sessions` 列表+搜索+分享；Codex 进程级多会话 | Web 列表+增删改查+重命名；渠道会话混列；无固定/搜索/归档 UI | 优：Web 常驻+渠道同列；劣：无会话搜索（会话多时难找）、无 pin/归档、渠道消息与 web 混在一条 list | a) 采纳"会话搜索+固定"（低成本：GET 列表前端 filter 即可）；归档=软隐藏(archived 标志)替代删除，比 CLI 更安全；JSONL 导出（A5）用于迁移留档 |
| A2 断点与现场 | Claude checkpoint=每步 git 快照+可 diff/时间旅行恢复；resume 连同文件态恢复。Codex rollout 每步落盘、`resume` 续跑 | agent_runs 现场（目标/轮数/末步/工具计数/原因）+心跳+resumeHint（含工作区 git 摘要）+undo_checkpoint（写前文件快照回滚） | 优：恢复成本低、带 git 现场、"继续任务"外壳免重来；劣：只能"续跑"不能"回卷"——无逐消息 checkpoint/时间旅行；undo 仅文件快照级 | b) 全量时间旅行不照搬（存储/实现成本高，P17 用 auto-commit 近似覆盖）；a) 采纳"现场可见化"：把 agent_runs 卡片化（继续/查看进度按钮）对齐 Codex 逐步恢复观感；c) 现象差异=CLI 可回滚到任意历史文件态，RW 只能从断点前进 |
| A3 自动压缩 | Claude auto-compact 近窗口上限自动摘要续聊、可 /compact 手动；Codex/opencode 近限裁剪 | >40 条消息→conv_summaries 懒摘要+最近30条；任务 run 内 maybeCollapseEarly 折叠早期轮；scheduler 自动归档 24h 闲长会话；阈值 F3 全可配 | 优：三层压缩+阈值可配+折叠成本已入账（部分）；劣：触发偏保守（40 条/65000 字符才动，纯问答会话到 40 条前全量上下文）；懒生成使首触发轮仍带全量 | b) 不照搬"临窗极限才压缩"（RW 已更早干预，防顶格更主动）；a) 可选：把 40 条阈值也做成 settings 键（与 F3 一致）；c) 现象差异=CLI 压缩发生在大上下文末尾瞬间，RW 是渐进分段 |
| A4 多会话/队列 | CLI 天然多进程/多窗口并发，无平台级限流；IDE 有显式任务队列 | 同账号 max_concurrent_chats（默认5/0不限）settings 可配；超限 429 提示在跑数；前端 busy 时输入排队 | 优：单用户防资源失控、可见性文本提示；劣：服务端无真正等待队列（超限即拒）；"队列"在客户端仅限 busy 输入，两个机制易混 | a) 采纳"超限进真队列"需谨慎（Web SSE 长连占资源，排队与并发同价）；建议先把 429 文案升级为"可订阅完成通知"，或 b) 维持拒绝+计数可见（C1 已定，够用） |
| A5 导出/分享 | harness JSONL（机器可读、可回放）；Claude 无原生导出（依赖 transcript 文件） | md 导出（服务端含 reasoning+工具轨迹 / 前端 Blob 双实现）；JSONL ⬜ | 优：md 人读友好、双实现；劣：无 JSONL=不可机器回放/重灌（审计/迁移/喂给其它工具差） | a) 采纳 JSONL（低成本：messages+tool_calls 两表直接序列化；对齐 harness 便于回归回放）；md 保留 |
| A6 命名/搜索 | 各 CLI 按首条消息自动命名；Claude/opencode 会话列表可搜索/筛选 | 朴素截断命名（首条 24 字符）在跑；LLM 自动标题存在但正常流程永不触发（见代码对照）；重命名 UI 有 | 劣（🛠）：标题=生硬截断可能断句且**LLM 版形同虚设**（朴素先占位→autotitle 恒 skip，Chat.jsx:455 每轮空转一次 HTTP）；搜索无 | a) 必采纳修复：朴素命名后置为"LLM 失败兜底"（先调 autotitle 生成，失败再截断），或命名只在 LLM 生成后再替换；顺手去掉 onDone 无条件 autotitle 空调用 |
| B1 系统提示分层 | 3080 persona/inst 分层；Claude settings 文件+CLAUDE.md 独立加载；各层可单独更新 | P13 三层（身份随 permission 动态/环境/纪律）但仍 join 为单条 system ~2.4k 字符；分层预算 ⬜ | 优：身份层随权限收敛（read 会话不再被 full 暗示污染）比多数 CLI 细；劣：单条大 system 使"独立更新某层"仍是整体替换；静态层与运行时快照分离后前缀已稳 | b) 分层预算不采纳（收益低、复杂化）；a) 可选采纳"分层独立"：把纪律层/环境层拆成**多条** system（各层前缀独立=某层更新不击穿其它层缓存）——但注意当前"单条稳定前缀"缓存友好，改动需先测 hit 率 |
| B2 项目记忆层级 | CLAUDE.md/AGENTS.md 全局→项目→子目录自动发现（Claude/opencode/Aider）；开目录即读 | 代码有 AGENTS.md 注入但 **project 列无任何写入路径（恒 default）+gate !default → 实际不可达**（📝） | 劣：蓝图声称"开工自动读到项目约定"，现实项目说明永远读不到；无目录级；无全局 CLAUDE.md 等价物（仅有 settings.systemPrompt 全局自定义） | a) 必采纳修复：会话 UI/API 增加 project 选择（或默认尝试 projects/default/AGENTS.md），否则该功能形同虚设；目录级检索可随 P12 语义检索一并挂起 |
| B3 运行时上下文 | Claude 动态变量/环境注入；3080 快照覆盖（轮次/护栏/成本/rev） | 每轮重建快照 append 尾部：轮次/用时/护栏现值/累计 token/¥/hit%/permission/preset/rev，含恢复标注 | 优：护栏现值与判定同源同轮（5s 缓存）、含 cache hit 率、resume 语义；位置在尾部=缓存友好 | b) 维持；可选 a) 把 hit% 单独推给成本面板（H 域 hit 率监控缺口顺手补） |
| B4 工具结果预算 | Claude Code 大输出自动压缩为引用/摘要+落盘指针；3080 分级修剪 | 单条 4000/12000 截断（头60%尾30%）+工具参数瘦身+早期归档+历史截断指针 | 优：分级粒度细、指针丰富；劣（🛠）：指针承诺"全文在 DB"与真实落库不符——tool_calls.args/result 均 2000 字符截断（tools/index.js:1074-1075），超大结果无全量持久化（run_command 例外） | a) 必采纳修复：要么把 args/result 全量落盘（列改 MEDIUMTEXT，仅截断 result_summary），要么把指针文案改诚实（"前2000字符"）；否则模型按指针取全文会取不到 |
| B5 压缩策略 | auto-compact+工具结果重复抑制（同输出不再整份回灌） | run 内折叠+会话摘要+轻归档；重复抑制仅 COMPLETION_HINT 去重/通知去重，输出级重复抑制 ⬜ | 优：折叠保留任务语义摘要（≤260字）+DB 指针，比 CLI 纯裁剪更有脑；劣：无"同结果不重发"（同文件重复 read 整段重灌） | a) 可选采纳：读类工具结果做短时内容 hash 去重（同会话 N 秒内同路径同结果→引用旧结果），中等成本；b) 不采纳也可（token 价差靠 B1 缓存吸收） |
| B6 污染防护 | Claude/Codex 无平台级"假开始/假完成打回"（纪律靠提示+订阅钩子）；占位符污染无此问题（终端直写） | 平台强制：B6/B6b 检测打回+强制标注；统一通道结构性消除无工具路径（O-1）；占位符双检疫（入口+写类） | 优：RW 独有护栏，曾实证拦截率高，是信任契约核心；劣：正则广→误伤面（O-12/O-13 观察），打回语义在流式下需"已上屏替换"（批6 A1） | b) 不照搬 CLI"放手"（打回是 RW 特色，放弃会失去纪律兜底）；c) 现象差异=CLI 靠模型自觉，RW 靠平台强制，代价是流式/护栏 A1/A2 语义精修必须做（已在批6） |

---

### 判定计数统计

- 代码对照：✅×6（A1,A3,A5 + B3,B6 + 决策 P4/P8/P13/P16/F3/F4 与台账 O-1/O-12/O-13 合记）· 🔶×6（A4,A6,B1,B4,B5 + 台账 O-10）· 🐛×1（A2 行"唤醒包❓"滞后类）· 📝×1（B2 AGENTS.md 不可达）· 🔍待核×0（本次 12 行全部给出初判，均附证据与说明）
- CLI 对照：a（采纳调整）×6 · b（不调整）×4 · c（现象不同）×2；其中"必采纳修复"级 🐛/📝：A6（LLM 自动标题形同虚设）、B2（AGENTS.md 永不可达）、B4（落盘指针失真）共 3 项；O-10 为🔶级（旁路摘要未入账）。

### 最重要 5 条发现

1. **📝 B2：AGENTS.md 项目记忆是不可达死代码**——注入逻辑在 index.js:418-427，但全仓库无任何路径把 conversations.project 写成非 'default'（db.js:68 默认；会话 API/渠道均不接受 project 参数），且 gate 要求 `!=='default'` → 正常操作永远读不到项目说明。修复=会话 UI/API 暴露 project 或去掉 default 门。
2. **🐛/📝 A6：LLM 自动标题形同虚设**——index.js:353-355 首条消息即用 24 字符截断占位标题，autotitle.js:8 见 title≠'新对话' 即 skip → Chat.jsx:455 的 LLM 起名每轮空转一次 HTTP 但永不生效；标题质量=生硬截断。修复=朴素截断降级为 LLM 失败兜底。
3. **🐛 B4：截断指针承诺与落库不符**——agent.js:101 等指针声明"全文可按 tool_call_id 查 tool_calls.args"，但 tools/index.js:1074-1075 落库时 args/result_summary 均 slice(0,2000) → 超大 write/grep 结果无全量持久化，模型按指针取全文会取空/取残。
4. **🔶 O-10 修复不完整**——in-run 折叠已 kind='collapse' 入账（agent.js:313-324），但 generateSummary（index.js:246-272）、conv_summarize/scheduler 归档（tools/index.js:872-905）、autotitle（autotitle.js:15-26）三处旁路 LLM 仍绕过 usage_stats，钱包仍偏低；批6 P23 只修"模型跟随"未修入账。
5. **🔶 A4/B1 蓝图行状态滞后于实现**（A2"❓唤醒包"实为 P16 已落地、A3 F3 阈值已可配、B6 O-1 已结构性消除），A/B 域表未随批1-5 刷新——审计/排期若以域表为准会重复立项；建议 v2.7 统一刷新域表"RW 现状"列，并修正 A6/B2 两处行为缺陷。
