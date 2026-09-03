# RW 撑竿跳方案 1.0（唯一总纲 · 活文档）

> 状态：v1.0 全盘 🟢 → **执行完成**：WS0–WS9 全部 ✅（批1–批7+收尾；本地提交与服务器部署记录见附录C"执行记录"）。
> 已融合《3080环境教学包与RW起跳设计-v1》(docs/3080环境教学包与RW起跳设计-v1.md 保留为基准源) · 已过 18 维自审（附录E，含 8 处修正）。
>
> **目标宣言**：让 RW 成为优秀的 Web 智能体——一名从 1 米起跳的撑竿跳运动员。杆不是任何外部限制，而是
> 「观察自己→定目标→用方法→验证→复盘→沉淀→下次自动更好」这套循环本身；终局是它能自我成长、不断超越、不断挑战。
> 原则三条：给完整的环境、可复制的方法、诚实的纪律——而不是一格格扶着它长高。
>
> **高跷判定（用户定稿，适用于本方案一切条款与未来一切新增限制）**：任何限制加入前必须过三问——
> ① 它是"防失控/保诚实"类的**准则**（如 harness 也有行为准则，工程师设计时发现必须有），还是能力天花板类的**高跷**？
> ② 它可调/可关/可解释吗（含自我解除通道）？③ 它会随表现证据自动放开吗（脚手架式，跑顺即拆）？
> 任一不过 = 高跷 = 不加。"不能超 200 轮 / 20 秒 / 10 块钱"式死限是高跷；"诚实、验证、完成定义、卡住就说"是准则。
> 护栏（防失控保险丝）≠ 高跷，前提是：默认宽、可调可关（0=不限）、触发即解释并给解除通道、现场保留可恢复。
>
> 取代：本文档取代自身 v0.3；git 历史可回退。修订记录见附录C；改进点对账见附录A。

---

## 0. 愿景、路线与成功判据

### 0.1 成长路线（脚手架式，随证据放开）
- **L0 现状（1 米）**：有工具/账本/护栏/现场恢复/驱动器，但无度量闭环、61 工具无分级契约、无准则文件、方法未技能化、规则陈旧风险未解。
- **L1 立杆（本方案）**：度量仪表（WS0）+ 工具契约分级（WS1）+ 运行时快照（WS2）+ 准则文件（WS3）+ 设置 schema（WS4）+ 记忆分层（WS5）+ 技能与自改纪律（WS6）+ 信任契约（WS7）+ 外部模式收口（WS8）+ 验证件（WS9）。
- **L2 自主进阶**：自我升级循环跑顺（打回率下降+沉淀增长持续 N 周）→ 训练轮（预算/自改范围约束）按证据逐级放开。
- **L3 优秀 Web 智能体**：新领域、长任务、自我优化照常成立——准则仍在，高跷全拆。

### 0.2 成功判据（先立度量，再谈执行；口径于 v1.0 自审修正）
- KPI1 **复测打回率**：finish_task 后 7 天内同会话用户消息命中强词 `/打回|重做|重新做|推翻|返工|不通过|没达到|再来一遍/` 记打回（弱词"不对/不行/这不行/不是我要的"易误伤日常否定，不计入）。
- KPI2 **步数/成本**：每任务轮数与 cost 的中位/均值（账本已全量计量）。
- KPI3 **自审闭环率**：打回会话中存在 `kb_add(title=打回复盘:*)` 数 / 打回数。
- KPI4 **沉淀增长率**：skills/知识条目新增数 + 按周复用次数（skill_load/kb_search 计数）。
- KPI5 **事故率**：仅计"失控类"=paused（连续重复无进展挂起）占比与静默收工（空答兜底触发）次数；guard（预算/轮次达限挂起，现场保留可恢复）为**正常挂起不计事故**；高危工具（db_write/git_pull_push/delete_file）调用次数单列供周报人工判读。
- 执行前建立基线快照（WS0），每批后对照；**进步判据=打回率下降 + 沉淀增长 + 事故不增**（教学包 Part V 口径）。

---

## 1. 工作项总表（WS0–WS9，全部 🟢）

### WS0 度量与基线 🟢
- 问题：无"进步"定义与仪表；账本齐但每任务不可归集（usage_stats 未挂 run）。
- 实现清单：
  1. `server/db.js` 启动段加 `ensureColumn()`（information_schema 探测后 ALTER，幂等）：`usage_stats.agent_run_id INT NULL`。
  2. `server/agent.js` L130 INSERT 增列 run_id（`ctx.__runId` 已有）；driver.js/scheduler.js 路径若无 runId 先 ensureRun 注入 ctx.__runId（批1 核对 driver.js ctx 构造，防契约任务成本悬空）。
  3. 新增 `scripts/kpi.mjs`（复用 server/config.js 连库）：按 agent_runs 归集轮数/token/成本/状态；按 tool_name 聚合 tool_calls（次数/失败/均耗时）；按 §0.2 口径出 5 KPI + 工具健康度榜（附录B SQL）。
  4. 基线：批次前后各跑一次落 `docs/metrics/baseline-<日期>.json`，对比入批报告。
- 验收：`node scripts/kpi.mjs` 出 5 KPI 与工具榜；存量数据可跑；启动幂等无错。
- P0 · 依赖：无 · 风险：低（只读+一列幂等迁移）。

### WS1 工具层重构（契约/分级/软门禁/健康度）🟢 ← 最高杠杆
- 问题：61 工具全量暴露；契约=一句话+string/number；无 when/not/example；无健康度反馈环。
- 实现清单：
  1. `server/tools/index.js`：
     a. 字段扩展：`when/not/ex`（toolDefs() 拼进 description：`何时用:…；勿用:…；例:…`）；params 支持 `enum/items/min/max` 白名单透传。
     b. `TOOLS` 每项增 `tier:'core'|'pro'|'expert'`；`toolDefs(expose)` 按 tier 过滤。**过滤只影响"被提供"，不影响"可执行"**（execTool 原名仍可执行）——分级暴露是用户选择的会话界面（all 默认），**不是 RW 能力上限**（高跷三问②通过）。隐藏工具被调用 → 指引性错误（原因+替代+ask_user 切 preset），不静默。
     c. 分组：core(21)=read_file/read_file_range/write_file/append_file/edit_file/list_dir/mkdir/copy_move/find_file/grep_search/web_search/fetch_url/syntax_check/run_test/plan_tasks/plan_done/finish_task/ask_user/set_goal/get_goal/update_goal；expert(9)=delete_file/db_write/git_pull_push/reload_platform/run_command/kill_process/set_limits/plan_mode/exit_plan_mode（仅 all 暴露）；其余 31=pro。暴露语义：minimal=core(21)；standard=core+pro(52)；all=全部 61（默认，零回归）。
     d. run_command 软门禁：preset≠all 且首词 ∈ {cat,ls,grep,sed,head,tail,find,cd,echo} → 指引用专门工具；preset=all 不拦（命令纪律=准则类，非能力上限）。
     e. when/not/ex 全量表（附录D）=批1 首个子步产出，每条过"给 agent 什么眼/手"评审（X1 借鉴，§1.5）。
  2. `server/db.js`：ensureColumn 加 `conversations.preset VARCHAR(8) DEFAULT 'all'`。
  3. `server/agent.js` L125：`toolDefs()` → `toolDefs(ctx.preset)`；driver/subagent/channels 从会话行带 preset。
  4. `server/index.js`：POST /api/conversations 支持 preset；GET /api/settings 返回 preset 选项与 schema。
  5. `src/Chat.jsx`：新建会话三档下拉（all/standard/minimal）带说明。
- 验收：① 默认 all 零回归（selfcheck.mjs+2 条旧代表任务）② standard schema 不含 expert ③ minimal 调 expert 工具收指引错误 ④ enum 非法值报参错 ⑤ 工具健康度榜可出。
- P0 · 依赖：WS0 基线先行 · 风险：中——子步 syntax_check→reload_platform，回归闸门 ①，异常回滚该子步。

### WS2 运行时上下文快照（看见钱包+看见规则变化）🟢
- 问题：ENV_MAP 静态（agent.js L60）；每轮看不见成本/护栏现值/政策版本；中途改规则旧认知仍在；预算按 run 起始冻结。
- 实现清单：
  1. `server/agent.js` sysContent()（L90-94）→ ENV_MAP + 动态快照块每轮重建：`[运行快照] 第N轮|已用X分钟|护栏现值:budget/round/loop/parallel（每轮读 settings）|本任务累计 token/cost ¥Y|会话 mode/permission/preset|政策版本 rev N`。
  2. agentLimits 读入循环每轮：预算用最新值判定（t0 不变）；roundCap 取起始值并在快照注明；5s 缓存仅防 DB 风暴。
  3. `server/db.js`：ensureColumn 加 `settings.revision INT NOT NULL DEFAULT 1`；PUT /api/settings 与 set_limits 写值时 revision+1。
  4. resume 续账：恢复路径（index.js L328 一带）把上次 rounds+成本带入首轮快照（ctx.__resumeStats）。
  5. 成本透出：emit agent_thinking 加 {round, costCum}。
  - **护栏哲学（防"高跷"误读，写入代码注释与 ENV_MAP）**：护栏=防失控保险丝，不是能力上限。默认已宽（120min/2000 轮/连续 6 次判循环），全部可调可关（set_limits 0=不限，ENV_MAP L75 已有通道）；触发=挂起非销毁，现场保留可恢复，回复必解释原因与解除方式；模型任务确需更长时间/轮次时可主动解释并申请调大——这是准则，不是 200 轮式高跷。
- 验收：① 中途 set_limits 改 loop_guard→下一轮快照含新值 ② 中途改 time_budget_min→本轮即按新值 ③ PUT settings 后 revision+1 且快照版本变化 ④ msgs[0] 每轮含成本行 ⑤ 打断/恢复回归不坏。
- P0 · 依赖：无 · 风险：低-中（每轮约 +250 token）。

### WS3 《RW 行为准则（服务器版）》🟢（内容生产=首批执行子步）
- 问题：3080 的 37 条含本地条款（pwsh/沙箱/ACL/EPERM/命名管道），RW 不能照抄；无成文准则文件。准则=把反复踩过的坑固化成规则（教学包 L4），非高跷。
- 实现清单：
  1. 基准源：`docs/3080机制对照与RW适配方案.md`（37 条对照）、`docs/3080环境教学包与RW起跳设计-v1.md`（L2 工具手册/L4 准则/Part II 20 条元方法）、`docs/hello项目复盘与合并基线.md`。
  2. 产出 `docs/RW行为准则-服务器版.md`：① 同源条款平移（诚实/验证/完成定义/清单/小步打包/成本可见/卡住就说/打回不辩解/复盘沉淀/怀疑自己的完成）② 服务器本地化命令层（/srv/harness-workbench 路径体系、systemd/journalctl、mysql 客户端、端口/ufw、reload_platform 重启礼节、curl 冒烟、后台进程纪律）③ 工具与护栏使用（引用 WS2 护栏哲学：护栏可调可关，禁用"死限式"条款）④ 汇报/收尾模板 ⑤ 附录：与 3080 逐条差异表（平移/改写/删除+原因）⑥ 方法附录：**只引用**教学包 Part II 20 条元方法（单一出处，不复制全文防双源漂移）。
  3. 注入：ENV_MAP（L60-78）增"准则文件路径+关键 10 条内联"；create_contract boundaries 默认附"违反准则第 X 节视为打回"。
  4. 编写纪律：完成后 `grep -i 'pwsh|命名管道|EPERM|windows'` 自检=0；准则新增条款须过高跷三问。
- 验收：差异表逐条有结论；grep 零残留；每条执行条款在现有工具集有落点。
- P1 · 依赖：WS1/WS2 · 风险：低。

### WS4 可调规则层统一（schema 驱动/一处声明）🟢（UI 渲染分包 P2）
- 问题：护栏默认值散落（agent.js L13 DEFAULT_LIMITS 等）；settings 键无 schema/版本/分组。核心洞察（教学包 L3）：**"能调的"都应做成配置层而非写死在对话/代码里**——这是稳定可信的根因，也是护栏不沦为高跷的机制保障。
- 实现清单：
  1. 新增 `server/settingsSchema.js`：`SETTINGS_SCHEMA=[{key,label,group:'runtime|permission|retention|misc',type:'number|bool|enum',def,min,max,hint}]` + validate()；DEFAULT_LIMITS 迁入 def，agent.js 改 import。**schema 规则：护栏键一律支持 0=不限/关 语义，禁止登记不可调的死限键。**
  2. `server/index.js`：GET /api/settings → {schema, values}；PUT 校验+upsert+revision+1；set_limits 走 validate()。
  3. 前端（P2）：设置抽屉由 schema 渲染（先运行时 4 键表单，其余只读展示）。
  4. 并表结论：preset=暴露面 / permission=边界 / mode=plan 只读，三属性各司其职；审计模板与报告格式走 skills 不走 settings。
- 验收：改 schema 一处→API 与 UI 同步生效；revision 递增；grep DEFAULT_LIMITS 仅剩 import 处。
- P1 · 依赖：WS1 · 风险：中（迁移用回归闸门）。

### WS5 记忆架构（注入/按需/沉淀/归档）🟢
- 问题：机制零散存在（ENV_MAP/skill_load F15/kb 家族/conv_summaries 表/resumeHint），分层与写入/归档者未定义（conv_summaries 无写入方）。
- 实现清单：
  1. 分层定义（写定 docs/记忆架构.md）：
     a. 每任务注入=运行时快照（WS2）+ 目标/契约（ensureRun goal、driver 注入、resumeHint L328）+ 项目说明（c）。
     b. 按需读取：技能 skill_load（会话级注入已有）；知识 kb_search（knowledge 表 scope=global|conv）；用户提"方法/记住"时先 skills_list/kb_search（ENV_MAP 已提示）。
     c. 项目自我说明（类 AGENTS.md，对应教学包杆1"自我认知包"的按需全文层）：约定 `/srv/rw-workspace/projects/<project>/AGENTS.md`，存在则 sysContent() 注入（index.js 取 project 传 ctx）。
     d. 沉淀回路：skill_save 落 skills/<名>/SKILL.md；kb_add 落 knowledge；复盘统一标题"打回复盘:"（KPI3 依赖）。
     e. 归档：新增工具 `conv_summarize`（pro；**注册后附录B 计数 61→62**）写 conv_summaries；resume 路径追加：跨 >48h 且有摘要 → 摘要入首轮提示。自动触发=P2（scheduler 扫 24h 无消息会话）。
  2. 依赖表核对：knowledge/conv_summaries/conversations(project) 均在 db.js SCHEMA（21 表）。
- 验收：① 新会话 kb_search 命中旧会话 conv 条目 ② 建临时 projects/x/AGENTS.md 后该 project 会话首轮含其内容 ③ 跨周 resume 首轮含摘要 ④ conv_summarize 后 conv_summaries 有行。
- P1 · 依赖：WS2 · 风险：低。

### WS6 方法论技能与自我升级循环 🟢
- 问题：方法只存于对话与文档；技能目录已通但首批技能与自改纪律未定。
- 实现清单：
  1. 首批技能（写 /srv/rw-workspace/skills/<名>/SKILL.md；内容=教学包 Part II 20 条元方法的浓缩实现，技能头注明"依据：教学包 Part II"以保单一出处）：
     - `explore-discipline`（治"全查病"，**试点先行**）：先地图后进城（README/索引/结构文件优先）；定向检索优于通读；抽样定深度；检索有上限、查过即记；用差异驱动探索。
     - `self-audit`（口径融合修正）：交付/提测前必跑两段——A 覆盖五维（**场景/业务/逻辑/数据/交互** + 证据行号，教学包 S05 口径，审视交付物是否完整覆盖）；B 诚实五问（做过吗（没做的不说做）/证据（行号与命令输出）/反方检验（先找推翻自己的证据）/范围声明（未覆盖处显式列出）/置信度）。A 审物、B 审话，缺一不可。
     - `task-approach`：澄清目标→验收先于编码→5–15 项检查清单→一轮打包多个独立小动作→每 N 步小结→对照验收→finish_task。
  2. 复盘模板：产出 docs/复盘模板.md：[目标][实际轮数/成本 vs 预期][差异根因][打回原因与避免条款][沉淀去向:技能/知识/规则]；打回后 kb_add(title="打回复盘:…")。
  3. 自我修改分层纪律（入准则第 4 章；**训练轮语义=随证据放开，非永久限制**）：
     - 阶段1 技能/知识层：随时可改（可回滚=可删条目）。
     - 阶段2 自改平台代码：小步→**先 git_commit 当前状态**（保证可回滚；"1 亿 token 事故"条款=凡自改必有提交点，禁跨 commit 堆积）→syntax_check→reload_platform；成本知情阈值（settings `selfchange_budget_yuan`，默认宽如 ¥20，0=关）：超阈值=暂停并问用户（先停再问=教学包杆4，不是死限）；次日晨验=kpi.mjs 快照对照。
     - 阶段3 结构性改动（agent.js 执行循环/权限与护栏模型/工具门禁语义）：create_contract 立项+用户确认。
  4. 晨验/批执行定时：复用 scheduled_tasks+调度器（已有），不新建机制。
- 验收：① explore-discipline 试点：代表探索任务轮数/成本低于基线 ② 打回会话存在"打回复盘:"条目（KPI3>0）③ 阶段2 自改 audit_log 事件流含 commit→syntax_check→reload_platform 序列。
- P1 · 依赖：WS0/WS1/WS2 · 风险：中（自改纪律靠 WS0 度量兜底）。

### WS7 信任契约与授权边界（文档件+cap 映射）🟢
- 问题：信任条款散在对话；full 权限无成文边界表与可关闭开关（capabilities 表+PUT /api/capabilities 已存在未用此语义）。
- 实现清单：
  1. 产出 docs/信任契约-v1.md（教学包杆5 定稿）：承诺表——RW：卡住就说原因/不假装完成/不自改需求/超界先问/打回不辩解只修复/动自身代码先申报；你：验收标准开工前成文（create_contract 化）/打回给具体证据（文件+期望-实际）；双向：RW 有权质疑与建议，你确认后才进执行人格，契约不可随意改。
  2. 授权边界表（契约附录三档）：自主=读/查/工作区文件/git_commit(本仓)/测试/技能与知识沉淀；晨间确认（或先问）=reload_platform/db_write/git_pull_push/set_limits 改护栏/delete_file 越工作区；禁止（默认）=删库重置/动工作区外用户文件/外网发布/改用户其他服务。**明示：默认状态=现状全开（cap 全 enable），本表是"可收不可放"的开关位与承诺基线，不是已生效的强制禁止**——收紧只在你显式关 cap 后生效，防"文档承诺与运行时行为落差"的误导。
  3. cap_key 三枚 `rw_autonomy/rw_confirm/rw_forbidden` 说明进契约，UI=设置→能力（已有）。
  4. 成本知情：`task_budget_yuan`（走 WS4 schema，默认宽 ¥20，0=关）超阈值→运行中 ask_user 确认继续（先停再问；复用 approval/ask 机制）。
- 验收：① 契约落库 docs/ ② 边界表每行有 cap_key/工具集合/UI 入口 ③ 设 task_budget_yuan=0.01 跑任务→出现 need_input/approval 事件证据。
- P1 · 依赖：WS0/WS2/WS4 · 风险：低。

### WS8 外部模式采纳对照收口 🟢（Claude Code 已核 + 见 §1.5 公开借鉴表）
- 清单（实施逐行打勾）：
  1. 少而精+高契约工具 → WS1。
  2. 计划-执行分离：plan_mode/exit_plan_mode 已有；补 diff 审阅准则条款（git_commit 前汇报 `git diff --stat` 与关键 diff 行）入准则第 3 章。
  3. checkpoint/resume：agent_runs+resumeHint 已有；续账=WS2.4。结构对照 Claude Code agent-loop 公开文档（§1.5 X2）=同构已确认。
  4. 委派子代理隔离上下文：subagent 家族已有（独立 runAgent+独立上下文+"子:"直播留痕）；补 prompt 模板技能 `subagent-prompt`（目标/已给事实/禁碰/输出格式/完成定义；融合 X3 规格化）。
  5. 每轮成本/权限可见 → WS2。
  6. 拒绝给原因+替代指引 → execTool blocked 文案已有 + WS1 指引补全。
  7. 轨迹/审计可查 → tool_calls/audit_log/contract_events 全量；UI diff 视图=P2 另线。
  8. 预算-确认循环 → WS7.4。
- 验收：逐行 E2E 各 1 例（plan→批准→执行含 diff 汇报→中断→resume 续账→委派→读成本行）。

### WS9 验证工具箱与验收件 🟢
- 问题：验收/自检每次现写（driver.js runAcceptance 只吃裸 bash 行）；无统一入口与模板库。
- 实现清单：
  1. 新增 scripts/verify.mjs：`syntax <paths…>` / `test <dir>` / `selfcheck` / `kpi`（复用 WS0）。
  2. 验收行 DSL（driver.js runAcceptance L60-74 区扩展）：无前缀/`cmd:`=bash（向后兼容）；`file-exists:<path>`；`grep:<re>|<path>`；`node:<script>`；`kpi:<metric><op><threshold>`。逐行 detail 上报保留。
  3. 模板库 docs/templates/验收模板.md（web/纯代码/文档/配置迁移 4 类）；技能 `acceptance-builder`（WS6 批次）：create_contract 前生成 acceptance 并展示确认。
  4. finish_task 前自审=WS6 self-audit 两段（准则条款）；打回失败详情已具备（runAcceptance→contract_events）。
  5. 回归基线=kpi.mjs 快照对比（WS0.4）。
- 验收：① verify.mjs 三子命令可跑且退出码正确 ② DSL 契约判定正确、失败有行级原因 ③ 旧验收字符串零改动兼容。
- P1 · 依赖：WS0/WS1/WS6 · 风险：低。

---

## 1.5 外部借鉴评审表（只取必要，求精不求多；每季采纳 ≤2 项，其余入观察）

> 原则：借鉴解决的是"RW 缺什么"，不是"别人有什么"；来源可核、落地可回滚、逐项过自审与高跷三问；不采纳也记录原因。
> 治理：新借鉴需提案（来源/解决什么问题/取什么不取什么/落点/风险/验证/高跷三问），季度复审观察清单。

| ID | 来源（公开可核） | 候选要点 | 评估结论（v1.0） | 落点/状态 |
|---|---|---|---|---|
| X1 | Anthropic《Seeing like an agent: how we design tools in Claude Code》(claude.com/blog/seeing-like-an-agent) | 工具要按"agent 的眼和手"设计：每个工具回答"给 agent 什么信息/能力、何时用、何时不用"；数量克制优于堆叠 | **采纳（强化）**：与 WS1 同向；契约字段 when/not/ex 与附录D 施工图评审项=落地 | WS1e+附录D；实施后按健康度榜验证 |
| X2 | Claude Code Docs《How the agent loop works》(code.claude.com/docs/en/agent-sdk/agent-loop) | agent 循环=直到完成/护栏/用户中断；工具结果进上下文供继续决策 | **采纳（对照确认）**：runAgent 已同构（完成度判断+护栏+stop 信号+结果回填）——无需新实现，写入 WS8.3 对照证据 | WS8.3 ✅对照 |
| X3 | OpenAI《Codex Symphony》开源编排规范 (openai.com/…/open-source-codex-orchestration-symphony) | 多 agent 编排的任务规格化（目标/上下文/边界/输出契约） | **部分采纳（必要项）**：RW 已有等价编排件（subagent/fanout/join/ralph/契约驱动器），仅取"任务规格模板"并入 subagent-prompt | WS8.4 |
| X4 | Kimi K2 Thinking / 智谱 GLM 系列公开资料 | 模型侧长程 agentic 能力报告 | **不采纳（框架层无可搬项）**：RW 已有多模型市场路由；列为模型选型观察项 | 观察（季度复审） |
| X5 | Work Buddy 等国产智能体公开资料 | —（本轮取证未获可核的框架级设计文档） | **不采纳，不阻塞**：入观察清单，取证后按提案流程评审 | 观察（季度复审） |

---

## 2. 执行流程、总闸与确认边界（用户流程 1→5 定稿）

1. **流程**：讨论改进点 → 回流附录A → 修订方案 → 全维度自审（附录E 模板）→ 3.1 全绿则执行开发；3.2 发现问题则修订 → 再自审（循环直至全绿）→ 执行开发。执行中再发现矛盾：停止该子步→回流→修订→重审受影响维度→继续。
2. **需确认准则（仅下列两类停下确认，其余自主推进）**：① 会造成服务器安全、性能隐患的事项；② 会造成 RW 或服务器重大缺陷、崩盘的事项。常规开发、文档、技能、非结构代码改动均自主推进，不逐项请示。
3. **批次顺序**：批1=WS0（度量与基线：ensureColumn+kpi.mjs+agent.js 挂 run+跑基线）→ 批2=WS1（工具分级契约，子步推进）→ 批3=WS2（快照）→ 批4=WS3（准则文件）→ 批5=WS6（技能三件+试点）→ 批6=WS4/WS5/WS7（并行）→ 批7=WS8/WS9 收口。
4. **回滚纪律**：每批前 git_commit 当前状态+基线快照；批后 kpi 对照；异常立即回滚该批（git revert 或恢复提交点）。
5. **高跷闸门**：任何批内新增限制（参数/阈值/门禁/预设）须在三问通过后才进入代码，并在批报告中标注"准则/护栏/脚手架"类型。
6. **部署通道**：本地仓库 → git push origin main → 服务器 `/srv/harness-workbench` `git pull` 后 reload（RW 侧执行或约定定时）；批报告记录部署触发与验证结果。

## 3. 修订规程
- 本文件为唯一活总纲；新改进点先入附录A 再并入对应节；🟡→🟢 门槛=实现清单+验收+风险回滚+高跷三问。
- 自审=附录E 18 维模板；任何结构性修订触发受影响维度重审。
- 外部借鉴按 §1.5 治理执行。

---

## 附录A · 改进点对账（须全部落入正文）
| # | 改进点 | 归属 |
|---|---|---|
| 1-22 | v0.1–v0.3 全部 22 项（五件套度量/脚手架/工具分级契约/软门禁/健康度/服务器版准则/37条差异表/规则层 schema/快照/陈旧规则/记忆分层/技能化/复盘模板/自改纪律/信任契约/成本可见/Claude 模式/验证件/KPI/总闸回滚/差异表产出/设计题合并线） | §1 WS0–WS9/§2 |
| 23 | 教学包 Part IV 六问结论落地（结论见附录F） | 附录F/WS5-7 |
| 24 | self-audit 口径冲突（教学包五维 vs 草稿五问）→ 融合为两段（A 覆盖五维/B 诚实五问） | WS6.1 修正 |
| 25 | 元方法 20 条单一出处（教学包 Part II；准则只引用不复制） | WS3.2-⑥ |
| 26 | 外部借鉴层（只取必要/求精不求多/季度复审） | §1.5 |
| 27 | 需确认准则+自主执行范围（用户流程定稿） | §2.2 |
| 28 | KPI1 误伤修正（弱词剔除）/KPI5 事故口径（guard 非事故） | §0.2/WS0 |
| 29 | conv_summarize 使工具计数 61→62（附录B/附录D 随注册同步） | WS5.1e |
| 30 | 目标宣言：优秀 Web 智能体/自我成长路线 L0-L3 | §0.1 |
| 31 | 高跷判定三问（用户定稿）+护栏哲学+全条款适用 | 头部/§2.5/WS2/WS4/WS6/WS7 |
| 32 | 18 维自审报告（含 8 处修正） | 附录E |
| 33 | 教学包融合映射（Part0–V→方案落点） | 附录F |
| 34 | 部署通道确认（git push origin main→服务器 pull） | §2.6/附录C |

## 附录B · 工具盘点与分级基线（实测 TOOLS=61；conv_summarize 注册后 62）
- 结论：不硬删（grep/read 与 run_command 重复由软门禁+描述解决；read_file_range 独立用例；find_file=名字/grep_search=内容职责已清）。策略=暴露分级+描述升级+健康度榜裁剪（比删除更可回滚）。
- tier：core=21 / pro=31 / expert=9（分组名单见 WS1.1c）；conv_summarize→pro（并入后 pro=32）。
- when/not/ex 示例模板（read_file/run_command/db_query 见 v0.3 附录B，全量=附录D 施工图）。
- 健康度榜 SQL：`SELECT tool_name, COUNT(*) n, SUM(status='fail') fails, ROUND(AVG(duration_ms)) avg_ms FROM tool_calls WHERE created_at > NOW()-INTERVAL 7 DAY GROUP BY tool_name ORDER BY n DESC;`

## 附录C · 修订记录
- **执行记录（2026-09-04，本地 commit → 服务器验证，全部 ✅）**：
  - 批1 WS0 度量基线：`44cb947`（+修复 `b048ec1`）——迁移 MIG_OK、列验证、reload、归集闭环 A45→B46；基线 docs/metrics/baseline-2026-09-04.json。
  - 批2a WS1 施工图：`7a732fa`（docs/tool-contracts-v1.md，62 条）；批2b WS1 代码 `b649cd1`；批2c UI `53cea11`——三档 preset 验证 minimal=21/standard=52/all=61（6/6 断言通过）。
  - 批3 WS2 运行时快照：`b80868d`——快照六类信息验证 ✅（轮次/用时/护栏现值/累计成本/会话属性/rev）。
  - 批4 WS3 准则：`d43e067`（docs/RW行为准则-服务器版.md+ENV 引用）。
  - 批5 WS6：三技能落服务器（explore-discipline/self-audit/task-approach）+docs/复盘模板.md；批7 补 subagent-prompt/acceptance-builder（共 5 技能 ✅）。
  - 批6 WS4/5/7：`abb8c45`——server/settingsSchema.js、conv_summarize（冒烟 ✅ conv_summaries 有行）、项目 AGENTS.md 注入、docs/记忆架构.md、docs/信任契约-v1.md、task_budget_yuan 先停再问。
  - 批7 WS8/9：`6538909`——scripts/verify.mjs、driver 验收 DSL（向后兼容）、docs/templates/验收模板.md；selfcheck 12/12 ✅。
  - 收尾：`a06f907` settings 种子（__policy_rev=1/task_budget_yuan=20，幂等）；服务器 HEAD=a06f907、工作区干净、分叉收敛。
  - 全程验证方式：HTTP(880) 驱动 RW 在服务器执行（rw-drive.mjs）；无触碰需确认准则事项，均自主执行并记录。
- **v1.0（融合版）**：融合教学包 v1（映射见附录F）；新增目标宣言与 L0–L3 路线；新增高跷判定三问与护栏哲学；修正 8 处（附录E）；新增 §1.5 外部借鉴表（X1 采纳/X2 对照/X3 部分采纳/X4-5 观察）；流程改按用户 1→5 定稿（需确认准则两类）；自审 18 维全绿 → 进入执行开发。部署通道确认（git push origin main → 服务器 git pull）。
- v0.3：WS5–WS9 升 🟢；附录B 实测重写（TOOLS=61）。
- v0.2：WS0–WS4 升 🟢；附录B 实测盘点；侦察事实记录（ENV_MAP 静态/DEFAULT_LIMITS/toolDefs 无参/5s 缓存/无 preset 列/usage_stats 无 run 归属/settings 无 revision）。

## 附录D · 工具契约施工图 ✅（已交付 docs/tool-contracts-v1.md，62 条含 X1 评审）
- 产出：docs/tool-contracts-v1.md —— 62 工具（61 实测+conv_summarize）逐条 when/not/ex/tier/schema 建议；core 21 全表先行，pro 32、expert 9；含 X1 三问口径与实施检查清单（批2b 用）。
- 待办：WS1 实施时把 when/not/ex 回填 server/tools/index.js TOOLS 条目 + enum 落地首批（copy_move.mode / git_branch.action / kb_add.scope / subagent.mode）；计数 62 与附录B 同步。

## 附录E · 自审报告 v1.0（18 维；3.1 结论=全绿后进入执行开发）
| 维度 | 结论 | 发现与修正 |
|---|---|---|
| 场景 | ✅ | 覆盖：普通对话/长任务/驱动器契约/自改/被打回/恢复续做/不同权限会话/多项目 |
| 业务 | ✅ | 覆盖用户真实流程：讨论→立项→执行→复测→复盘→沉淀；教学包六问逐一有结论 |
| 逻辑 | ✅→修正4 | ①KPI1 弱词误伤→强词口径 ②KPI5 guard 非事故 ③self-audit 双源口径冲突→两段融合 ④护栏/高跷边界缺失→护栏哲学+三问 |
| 功能 | ✅→修正1 | conv_summarize 计数未同步→附录B 61→62 注明 |
| 交互 | ✅ | preset 三档 UI/设置 schema 抽屉（P2）/审批卡/成本行透出均有落点；UI diff 视图=P2 显式外置 |
| 安全 | ✅→修正1 | WS7 边界表默认全开需显式声明，防"文档承诺≠运行行为"落差→已明示 |
| 环境 | ✅ | Windows 开发仓库 ↔ Linux 运行路径（/srv/…）同源；准则本地化=WS3；部署通道=git push→pull |
| 度量与基线 | ✅ | 5 KPI+基线快照+批间对照；口径修正见上 |
| 阶段与脚手架 | ✅ | L0–L3 路线；自改训练轮随证据放开（非永久限制） |
| 工具层设计 | ✅ | 61 盘点/分级/契约/软门禁/健康度闭环；过滤≠禁用（能力上限澄清） |
| 记忆架构 | ✅ | 注入/按需/沉淀/归档四层均有写入方与读取方；单一出处原则 |
| 验证工具箱 | ✅ | verify.mjs/验收 DSL/模板库/回归基线；向后兼容 |
| 规则的环境适配 | ✅ | 37 条差异表+本地化命令层；20 条元方法只引用不复制；grep 零残留纪律 |
| 冗余/重复 | ✅→修正1 | 20 条元方法原在准则候选草案中会双源→改单一出处引用；五件套内容与 WS 正文重叠以"映射表+落点"收口 |
| 冲突 | ✅→修正4 | 见"逻辑"4 处 + 计数 61/62 + 预设暴露语义（v0.3 曾矛盾，v1.0 已统一 minimal/standard/all） |
| 缺陷 | ✅ | 通读 2 遍：无未闭环引用（附录D 为执行期交付物非缺陷）；文档内部链接均存在 |
| 借鉴层 | ✅ | X1–X5 结论+治理；无一采纳项悬空 |
| 高跷自检 | ✅ | 全方案限制清单过三问：护栏（默认宽/可调可关/解释+恢复）/预算（知情阈值非死限）/暴露分级（用户界面非能力上限）/自改纪律（提交点回滚+阶段3 契约）——全部属准则或护栏或脚手架，无高跷项 |

## 附录F · 教学包融合映射（docs/3080环境教学包与RW起跳设计-v1.md → 本方案）
| 教学包部分 | 内容 | 落点 | 状态 |
|---|---|---|---|
| Part 0 心智 | 补丁=高跷；撑竿=循环；礼物=方法+自我认知+诚实 | §0 目标宣言/头部高跷判定 | ✅吸收 |
| Part I L1 身份 | 一句话身份+对自己说的话负责 | WS3 准则①+ENV_MAP（已含类似句，统一措辞） | ✅吸收 |
| L2 工具手册 | 3080 工具/命令/子代理机制族 | WS3 差异表素材；"移植语义不照搬"原则入准则附录 | ✅吸收 |
| L3 可调规则层 | 能调的做成配置层=稳定可信根因 | WS4 问题与 schema 规则（护栏键必可调可关） | ✅吸收 |
| L4 行为准则 37 条 | 坑固化成规则，每条对应真实事故 | WS3 差异表输入 | ✅吸收 |
| L5 运行时快照 | 最新快照覆盖旧快照；RW 缺"喂回自己上下文"习惯 | WS2（核心） | ✅吸收 |
| Part II 20 条元方法 | 想做/探索/验证诚实/成本/学习沉淀 | WS3 准则⑥引用+WS6 技能浓缩（单一出处） | ✅吸收 |
| Part III 杆1 自我认知包 | 常驻精简注入+按需全文 | WS5a/c+ENV_MAP（按需全文=AGENTS.md 机制） | ✅吸收 |
| 杆2 方法论技能 | 三技能（self-audit=S05 五维+证据行号） | WS6.1（口径融合两段） | ✅吸收（修正口径） |
| 杆3 自我升级循环 | 契约+预算+晨验；1 亿 token 条款 | WS6.3/§2.4 | ✅吸收 |
| 杆4 成本与诚实 | 每轮喂回/估成本/超预期先停再问 | WS2 快照成本行+WS7.4 | ✅吸收 |
| 杆5 信任契约 | 双向承诺；你确认后才执行人格 | WS7.1 | ✅吸收 |
| Part IV 六问 | 1 五件套认可→本方案；2 自我认知包位置→仓库 docs+精简注入（WS5）；3 三技能+explore 试点→WS6.1（试点先行）；4 自改范围→分层（WS6.3）；5 契约双份（RW 仓+hello 知识库）→WS7 已落 RW 侧；**hello 侧一份=合并线待办**；6 设计题不阻塞→合并线 | — | ✅除"hello 侧契约副本"待办 |
| Part V 风险边界 | 自改契约化/成本上限跑顺放开/打回率+沉淀判进步/你=定契约的校长 | §0.2/§2/WS6.3 | ✅吸收 |
