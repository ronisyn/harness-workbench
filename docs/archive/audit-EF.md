# RW 平台 E/F 域审计（蓝图↔代码 / 蓝图↔成熟 CLI 双重对照）

> 审计基线：蓝图 `docs/平台开发全集清单-v1.md`（E 域 L65-71、F 域 L73-81；决策 P10 L205 / P14 L209 / P17 L212；O-2 L158 / O-12 L168）
> 代码基线：`E:\projects\harness-workbench\server\*.js`（2026-09 版本实测行号）
> 判定符号：✅=闭环且代码匹配 · 🐛=缺陷/蓝图标称与实现不一致 · 📝=现象差异/口径待对齐 · 🔶=部分/待完善 · ⬜=未做（含按决策挂起/否决）· 🔍=待核
> 结论计数（代码对照表 4 节合计）：✅×23 · 🔶×6 · 📝×2 · 🐛×1 · ⬜×1（E 表 3✅1🔶；F 表 4✅2🔶；决策/缺陷 4✅1⬜；部件机制 12✅3🔶2📝1🐛）

## 代码对照

### 1. 域 E（记忆与持续学习）逐行

| 蓝图行 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|
| E-长期记忆 ✅ kb global/conv 跨对话记得偏好 | ✅ | 工具 `tools/index.js:573-619`（kb_add/kb_search/kb_del）；注入 `index.js:388-399`（前 5 条带 300 字正文、LIMIT 12 其余仅标题）；表 `db.js:230-239` | kb_add 同账号+scope(+会话) 按 title 去重覆盖 `index.js`(tools):585；Jaccard<0.35 拒覆盖防误冲高价值记忆 588-597；kb_search 可见范围=自身 conv+全部 global 610；正文 8000 截断 579。会话级注入仅 web SSE 路径（见 📝-1 不对称） |
| E-技能/插件 ✅ 5 技能 SKILL.md；❓管理/回流 UI | 🔶 | 工具 `tools/index.js:814-855`（skills_list/skill_load/skill_save）；F15 注入 `index.js:376-387`；表 `db.js:222-228`（conv_skills）；5 技能实证 `packs/rw-core/skills/{explore-discipline,self-audit,task-approach,subagent-prompt,acceptance-builder}/SKILL.md` | 机制闭环：skill_load 全文入 ctx.skills→每轮系统提示 `agent.js:215-223`，且持久化 conv_skills（重启后续会话恢复注入）；内容实时读盘（改文件即生效）835。缺管理/回流 UI（蓝图自标 ❓）→ 判 🔶 |
| E-复盘回流 ✅ 模板+打回复盘 | ✅ | 模板 `docs/复盘模板.md`（打回=强制完整复盘并 kb_add 前缀"打回复盘:"）；打回执行 `driver.js:164-168`（acceptance_fail→打回继续）；复测拒收 `index.js:957-961`（reject→queued）；meta 指引 `tools/meta.js:52`（复盘条目标题加"打回复盘:"前缀） | 打回→数据回流闭环在位（KPI3 度量依赖前缀）；度量脚本 🔍待核 `scripts/kpi.mjs` |
| E-语义检索 ❓远期（LIKE 够用则不做） | ✅ | P12 否决（蓝图 L207）；检索实现=LIKE `tools/index.js:610`；无向量/RAG 代码 | 与 P12 ✖ 决策一致：不做=RW 明确决策（对齐 Claude/Codex 不靠 RAG 的论证） |

### 2. 域 F（任务执行）逐行

| 蓝图行 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|
| F-意图规划（C3）🔶 意图挡位；高成本自荐；plan 工具退役 | 🔶 | 只读意图=请求级挡位 `index.js:433-447`；高成本自荐（P4 批1 已实现）`index.js:448-457`；plan_mode/exit_plan_mode 退役注释 `tools/index.js:678-681`；保留 plan_tasks/plan_done 344-361 | 蓝图行"高成本自荐待做"与代码已做有出入（实际已实现）；但挡位无持久态、自荐=软提示非门禁；蓝图 F 行现状滞后于实现 → 🔶（另见 🔶-plan） |
| F-步骤级 checkpoint ✅ 心跳+留痕+undo；🔶无时间旅行 | ✅ | agent_runs 现场 `runtrack.js:26-78`（ensureRun 复用 31-46 / checkpoint 49-52 / markRun 54-56 / 重启标 interrupted 59-63 / resumeHint+git 状态 66-78）；每轮落心跳 `agent.js:500-505`；resume 注入 `index.js:429-432`；文件级 undo `tools/index.js:1082-1096`+自动快照 1058-1059（checkpoint.js）；stop/断连留痕 `index.js:615-631` | "无时间旅行"为蓝图自注远期项（非缺陷）；恢复语义：短指令"继续任务"复用原 goal `runtrack.js:36-40`（P16 唤醒包=git 状态摘要） |
| F-自动 commit 🔶 P5（批4）业务区已决策 | ✅ | finish_task 内 auto-commit `tools/index.js:649-669`：非平台目录+git 仓库+有脏区→git add -A+commit；平台目录走 C5 排除 655 | P5 范围限定落地（P17 由 P5 覆盖一致）；非 Aider 式"改即提交"，是"任务收尾一次提交"（CLI 对照见 §CLI） |
| F-失败策略 ✅ loop 护栏；F4 连续失败入批1 | ✅ | loopGuard soft→挂起 `agent.js:507-527`；F4 连续失败计数/软提示/挂起 564-580；预算护栏 348-360（时间/轮次/总账）+成本知情阈值 383-386；全部 settings 可调（5s 生效 136-162） | 护栏现值随【运行时快照】每轮注入 239-254（P8 尾部快照防缓存击穿）；挂起 paused→现场保留可恢复 |
| F-长任务编排 ✅ ralph/fanout/契约驱动器 | ✅ | subagent 族 `tools/index.js:426-570`（8 工具）；spawn/fork 实现 `subagent.js:51-100`；fanout 分批 549-565；ralph 循环 684-732（轮次上限 10、共享记忆文件 .ralph-*.md、STATUS DONE/BLOCKED 判定 726-727、noSubagentOverride 718）；契约驱动器 `driver.js` 全（15s 扫描 212-216、并发≤2 200、验收 DSL 55-93）；后台任务 run_long_task `tools/index.js:222+72-108`；完成通知注入 `agent.js:256-285` | 驱动器=无人值守状态机（见 🔶-driver）；子代理完成事件回注父轮（5.2） |
| F-目标系统 ✅ goal 族跨轮注入 | 🔶 | goal 族工具 `tools/index.js:364-393`（set_goal/update_goal/get_goal）；goals 表 `db.js:201-210`；跨轮注入 `index.js:371-375` | 注入仅 objective 无 progress（371-375 SELECT objective）；update_goal/get_goal 未入 DEFAULT_TOOLSET（meta.js:75-83）但注入文本指示"完成时调用 update_goal"（374）→ 默认启用集下模型可能看不到该工具；注入文本用"completed"非合法状态（工具 desc 为 active/done/abandoned，run 无校验 382）；goal 仅会话级无账号级 → 🔶 |

### 3. 决策/缺陷行对照（P10/P14/P17/O-2/O-12）

| 蓝图行 | 判定 | 证据 | 说明 |
|---|---|---|---|
| P10 子代理输出契约（注入式） | ✅ | `subagent.js:66-79`：SUB_CONTRACT 模板 68-75；spawn 默认注入 prompt 尾部 76-79；调用方可传 contract 覆盖/关闭 76 | 提示契约（非硬 schema/无服务端校验）；配套技能 `packs/rw-core/skills/subagent-prompt/SKILL.md` 教父代理构造 prompt |
| P14 任务=对话（挂起） | ⬜ | 无"任务=对话"实体实现；agent_runs 现场复用=`runtrack.js:34-41` 是"会话即任务外壳"雏形 | 按决策挂起（合并线），代码无违反；试点出现需求再设计（蓝图 L209） |
| P17 业务 auto-commit 覆盖（不单独立项时间旅行） | ✅ | auto-commit 收口 finish_task `tools/index.js:649-669`；文件级回滚 undo_checkpoint 1082-1096 提供近期时间旅行 | 决策落实：无独立"时间旅行"立项，undo 安全网+auto-commit 已覆盖近期回退诉求 |
| O-2 高消耗 | ✅ | 快照移尾部 `agent.js:239-254`；P8 hit 率测量 233/381；工具参数瘦身 slimToolCallForContext 87-109 + 归档压缩 113-135；语义折叠 F3 291-334（成本入账 kind=collapse 315-324，O-10）；工具结果分级修剪 contextResultPrune 65-72；轻量 schema LIGHT_TOOLSET `tools/meta.js:92-97` | O-2 是缺陷台账（现象：avg 4.6 万/轮），批1 相关治理均已在位；度量验证 🔍待核（KPI/周报） |
| O-12 B6b 假开始（自身观察） | ✅ | taskish 判定=最近 4 条用户消息扫描 `agent.js:435-440`+大正则 434；A+D 反转结构性检测 451-473；软打回 2 次后强制加注 466-473 | 与 O-12 台账描述（4 条扫描+大正则、误伤防线自评）一致；运行验证 📌待持续观察 |

### 4. 部件机制核验（tools/subagent/scheduler/driver/runtrack/agent/db/index）

| 机制 | 判定 | 证据 | 说明 |
|---|---|---|---|
| kb 去重+防激进覆盖 | ✅ | `tools/index.js:581-600` | title 精确去重；Jaccard 字符集相似度 588-594；overwrite:true 显式放行 595 |
| kb_search LIKE+上限 | ✅ | `tools/index.js:605-613` | 关键词空格拆 LIKE；LIMIT 8；body 截 1200 |
| skill_load 实时读盘+持久化 | ✅ | `tools/index.js:828-843`（SKILLS_ROOT 35；frontmatter 38-48）；`db.js:222-228` | conv_skills 唯一键 (conversation_id, skill_name) |
| conv_summarize/归档成本 | 🔶 | 工具 `tools/index.js:866-905`；自动归档 `scheduler.js:108-124` | 任务内折叠已入账（agent.js:315-324 kind=collapse）；但 conv_summarize/自动归档路径走 chatOnce 不经 usage_stats（summarizeConversation 872-905 无入账）→ O-10 仅部分闭环 |
| subagent 记录持久化 | 🔶 | `subagent.js:7`（subs Map 纯内存）、prune TTL 2h/300 条 10-25；无 DB 落盘 | 重启后 subagent_report/join/output 不可用（进程内）；执行明细仍在 tool_calls 可查（tools/index.js:1074）→ 复盘留痕不丢、编排态丢 |
| plan_tasks/plan_done 载体 | 🔶 | `tools/index.js:110-116`（plans 内存 Map）+344-361；事件流展示 `agent.js:556-559` | 纯展示载体：无 DB 持久化、重启即失、无跨轮状态注入（模型靠工具结果自持步骤）→ 与"进度可见"效果弱绑定 |
| finish_task 自审+提测 | ✅ | `tools/index.js:642-676` | summary/selfCheck 必填语义；驱动器验收钩子驱动（driver.js:156-168） |
| ralph 循环 | ✅ | `tools/index.js:684-732` | 每轮无历史全新视角、共享 .ralph 记忆文件、DONE/BLOCKED 正则收口、单轮 10 步克制提示 710 |
| driver 状态机 | ✅ | `driver.js:112-196`：queued→running→candidate_done / need_input / 打回 queued / blocked；runAcceptance 95-104；崩溃恢复 202；MAX_AUTO_ROUNDS=60 186-189；复测确认 API `index.js:948-962`；问询答复 963-983；contract_events 全部 kind 21-23 | 契约验收 DSL（cmd/file-exists/grep/node/kpi）55-93；复测 candidate_done→done 才真完成（蓝图"机器验收真过"闭环） |
| driver/scheduler 无记忆注入 | 📝 | driver ctx `driver.js:141-146`、scheduler ctx `scheduler.js:70-71` 均无 knowledge/goals/conv_skills 查询；注入仅 web 路径 `index.js:371-399` | 无人值守任务不自动带"用户偏好/global 记忆"（可主动 kb_search，但无人提示）→ 交互路径与自动路径记忆不对称；⚠️蓝图标 E 行"跨对话记得偏好"在自动路径打折 |
| 完成度判定 COMPLETION_HINT | ✅ | 定义 `agent.js:204-208`；每轮尾部去重注入 582-587；完成判定=无工具调用即最终答 390-497 | 平台级 B6/B6b 打回 425-473（防"声称完成无执行"）；F6a 空正文诚实报告 477-484；空答自动摘要兜底 486-496 |
| loopGuard/F4/budget 护栏 | ✅ | `agent.js:507-527`（loop soft→paused）、564-580（F4 2N 挂起）、348-360（budget-total/min/cap）、383-386（budget-yuan 先停再问）；set_limits 工具 `tools/index.js:773-792` | 护栏全部 settings 可调 0=不限（防失控保险丝语义，agent.js:3-4） |
| agent_runs/resumeHint（P16） | ✅ | `runtrack.js:26-78`；注入 `index.js:429-432`；轻问答不登记现场 `index.js:527-531` | 纯问答（light）不产生 run 噪音 |
| goals 注入口径 | 📝 | `index.js:371-375` vs `tools/index.js:375-385` vs `tools/meta.js:27-29,75-83` | 注入只带 objective；update_goal 指示状态"completed"非法；update_goal/get_goal 不在默认启用集（见 F6） |
| O-17 失败不留痕 | 🐛 | catch 路径 `index.js:633-636`：仅 send error+markRun，**不落任何 assistant 消息**（对照成功/中断路径 606-631 均留痕） | 与蓝图 O-17 台账一致（conv184/246 铁证）；批6 待修"异常必落占位消息+已做进度" |
| O-18 空正文兜底 | ✅ | 三层兜底：F6a 诚实报告 `agent.js:477-484`；工具后空答自动摘要 486-496；入库 '（无输出）' `index.js:595` | 当前已防；批6"最终防线"为增强项非当前缺陷 |
| 表结构 | ✅ | goals `db.js:201-210` / knowledge 230-239 / conv_skills 222-228 / task_contracts 256-274 / contract_events 275-282 / agent_runs 240-255 / conv_summaries 179-183 / long_jobs 212-220 | 8 表全部在场；task_contracts 含 attempts/last_ask/conv_id/model；knowledge 无 title 唯一约束（应用层去重） |
| /api/tasks + /api/contracts | ✅ | `index.js:885-919`（scheduled_tasks CRUD）、927-983（contracts 列表/事件/立项/复测确认/答复） | contracts 支持 accept→done / reject→queued / judge continue；前端面板 🔍待核（web/ 未逐行核） |

## CLI对照

规则（蓝图 L224）：每条标注 成熟 CLI 怎么做 → RW 是否照做 → 不照做原因/现象差异 → 建议 a)采纳调整 b)不调整+原因 c)现象差异。

| 蓝图行 | 成熟 CLI 做法 | RW 做法（证据） | 优/劣势 | 建议 |
|---|---|---|---|---|
| E-长期记忆 | Claude Code memory/CLAUDE.md+AGENTS.md 文件级；Codex AGENTS.md；3080 knowledge | knowledge 表 + 每请求注入前 12 条（前 5 带正文）+ kb 工具 LIKE 检索（index.js:388-399; tools/index.js:605-613） | 优：注入式"每轮必带"比 Claude 的"文件存在但要模型记得去读"更显性；DB 可审计/可删。劣：无目录级记忆（蓝图 B 域另标 ❓）；自动路径（driver/scheduler/subagent）不带记忆（📝-1） | a)采纳调整：无人值守路径（driver/scheduler ctx）注入 account 级 global 记忆标题清单（与 web 同款 LIMIT 12），成本≈零；c)现象差异：Claude 的记忆是"文件树+@引用"，RW 是"注入+工具检索"双通道 |
| E-技能/插件 | Claude skills 目录（SKILL.md frontmatter）+市场；Codex skills；opencode | skills/ 目录 SKILL.md + skill_load 全文入系统提示+conv_skills 跨轮持久（tools/index.js:814-855; agent.js:215-223; index.js:376-387） | 优：与 Claude skills 同构（frontmatter name/description/version）；载入=注入（比 Claude 的"按需读入"更强制）；改文件即生效。劣：无市场/管理 UI（蓝图自标）；无全局 auto-load（每次需模型想起 skill_load） | b)不调整：与成熟 CLI 机制等价且已 5 技能实证；市场/UI 属蓝图 ❓ 远期。c)现象差异：Claude 会话外全局技能自动发现，RW 需模型先 skills_list 再 skill_load（meta.js when 提示已缓解） |
| E-复盘回流 | CLI 无平台强制（纪律靠提示+hooks 订阅；无"声称完成即打回"机制） | 打回强制完整复盘+kb_add"打回复盘:"前缀（docs/复盘模板.md）；driver 验收打回循环（driver.js:164-168）；复测拒收（index.js:957-961） | 优：RW 信任契约核心（B6/B6b+验收驱动），把"用户复测反馈"变成结构化数据（KPI3）。劣：无 CLI 参照（⚠️ 不照做保留项，蓝图专项表 #9 同结论） | b)不调整：保留 RW 特色护栏（蓝图专项表 #9 ⚠️ 已论证：放弃打回失去纪律兜底）；批6 需适配"已上屏文本替换"语义 |
| E-语义检索 | Claude/Codex 不靠 RAG（文件检索/上下文）；3080 knowledge 无向量 | LIKE 检索（tools/index.js:610）；P12 ✖ 否决向量（蓝图 L207） | 与成熟 CLI 一致：不用向量库；LIKE 对记忆条目（短文本）足够 | b)不调整：P12 决策与 CLI 实践一致 |
| F-意图规划 | Claude Code plan mode（用户显式切换、只读、批准后执行）；Codex plan | 请求级只读意图（index.js:433-447）+高成本自荐（448-457）；无会话持久 plan；plan_tasks 仅展示 | 优：零切换（用户下句"开始"即恢复）；自荐让大活先亮方案。劣：无"跨多轮规划态"（复杂方案无法分 3 轮只读调研后一并批准）；蓝图 C6 已认定 plan 核心价值=方向对齐 | a)采纳调整（轻量）：只读意图支持"多轮延续"（如注入"上轮只读规划未放行"标记直到放行），成本低；c)现象差异：Claude plan 是持久模式开关，RW 是逐请求挡位——前者"先规划后执行"结构性分界，后者靠每句措辞 |
| F-步骤 checkpoint | Claude checkpoint+time travel（文件时间线+终端重放）；Codex resume | agent_runs 每轮心跳+last_step+tool_counts（runtrack.js:49-52）；undo_checkpoint 文件快照回滚（tools/index.js:1082-1096）；resumeHint+git 摘要（P16） | 优：恢复=现场+历史+git 状态三件套（比 Codex resume 信息更足）；写前自动快照（1058-1059）任意步可回滚。劣：无终端重放/跨会话时间旅行（蓝图远期） | b)不调整：近期回退诉求已被 undo+auto-commit 覆盖；时间旅行远期再评 |
| F-自动 commit | Aider 改即提交；Claude Code 可选 auto-commit | 仅 finish_task 收尾时业务区一次提交（tools/index.js:649-669） | 优：提交点=任务完成点，粒度语义清晰；防中间态垃圾提交。劣：任务中途崩溃=改动未提交（现场在，但需恢复后补交）；无逐编辑 checkpoint | a)采纳调整（可选）：长任务中模型可显式 git_commit 小步提交（工具已可用 tools/index.js:326），无需平台强制；b)不调整默认收尾提交语义 |
| F-失败策略 | CLI 无硬 loop/fail 护栏（模型自愈；失败直接报错终端；用户 Ctrl+C） | loopGuard+F4+预算三护栏，soft 提示→paused 挂起问用户（agent.js:507-527/564-580/348-360） | 优：防无脑重试烧 token（O-2 场景）；护栏可调 0=不限=保险丝非能力上限。劣：偶发误挂需用户"继续任务"解锁（成本低） | b)不调整：护栏=防失控保险丝是 RW 必要适配（平台侧成本闸门，CLI 终端无此问题）；现象差异：CLI 重复失败=终端红字，RW=挂起+现场 |
| F-长任务编排 | Claude subagents（per-task 配置）；Codex exec；DSH subagent/subagent_fork/workflow/ralph | subagent 族 8 工具（tools/index.js:426-570）+ralph+fanout+契约驱动器（driver.js）+定时（scheduler.js） | 优：能力面≥成熟 CLI（spawn/fork/fanout/join/report/list+ralph+无人值守 driver+cron）；P10 契约注入让子代理结果可稳定解析。劣：sub 记录内存态重启丢（🔶）；无 workflow 脚本式编排（DSH 有）；driver 无记忆注入（📝-1） | a)采纳调整：① sub 记录落 DB（或复用 tool_calls 重建 report）② driver/scheduler 注入 global 记忆清单（同 📝-1）；b)不调整其余（fanout 分批 6、并发 8 合理） |
| F-目标系统 | 3080 goals 跨轮注入；Claude Code 无 goals 原语（靠记忆/上下文）；DSH goal 工具（跨轮+resume 重挂） | goal 族（tools/index.js:364-393）+goals 表（db.js:201-210）+每请求注入 objective（index.js:371-375） | 优：跨轮持续提醒（注入式）。劣：①注入不带 progress（进展靠会话历史自持）②update_goal/get_goal 不在默认启用集（meta.js:75-83），注入却指示调用（index.js:374）③无状态值校验（"completed"会入库）④无账号级/跨会话目标 | a)采纳调整：①注入 SELECT 补 progress（一行 SQL）②update_goal/get_goal 入 DEFAULT_TOOLSET ③run 内校验 status ∈ {active,done,abandoned} ④（远期）账号级 goal 可选 |
| P10 子代理契约 | Claude subagents 靠 prompt 约定；DSH SUB_CONTRACT 同款注入 | SUB_CONTRACT 默认注入、可覆盖/关闭（subagent.js:66-79） | 与成熟 CLI 同向；提示契约无机器校验（结果仍靠父代理解析） | b)不调整：提示契约已够（批4 实证）；硬 schema 校验留给 create_contract/验收 DSL 路径 |
| P14 任务=对话 | Codex/Claude 任务即会话的一部分（无独立实体）；DSH 同会话 goal 多轮 | 挂起无实现（agent_runs 现场复用为雏形 runtrack.js:34-41） | 现状（会话+现场）已覆盖多数断点续跑；独立"任务"实体收益未证 | b)不调整：维持挂起（蓝图 L209 决策）；试点出现需求再设计 |
| P17 auto-commit=时间旅行 | Aider 逐步提交历史可回退 | finish_task 收尾提交+undo_checkpoint 文件快照（tools/index.js:649-669/1082-1096） | 近期回退已覆盖；无逐编辑自动提交=无逐编辑回退点 | b)不调整（同 F-自动 commit 建议，模型可显式小步提交） |
| O-2 高消耗 | CLI 无此台账（其成本控制=上下文预算/缓存设计） | P8 尾部快照+瘦身+折叠+分级修剪（agent.js:87-109/113-135/239-254/291-334；tools/index.js:60-68 命令输出修剪） | 治理在位数齐全；验证=hit 率/成本中位度量（🔍待核周报） | b)不调整；批6 usage 帧/流式落地后重测 hit 率与成本中位 |
| O-12 B6b | CLI 无假开始检测（无此概念） | taskish 4 条扫描+结构性 A+D 反转（agent.js:434-473） | RW 特色（信任契约）；误伤防线=软打回 2 次自愈 | b)不调整（蓝图专项表 #9 同结论）；运行样本持续观察 📌 |

## 最重要发现（Top 5）

1. **🐛 O-17 失败不留痕仍成立**：`index.js:633-636` catch 只发 SSE error+markRun，不落 assistant 消息——与蓝图 O-17 台账/conv184 铁证一致，批6 必修（"失败必落占位消息"）。
2. **📝/🔶 记忆注入仅覆盖 web 交互路径**：driver（driver.js:141-146）与 scheduler（scheduler.js:70-71）的无人值守执行不注入 knowledge/conv_skills/goals——"跨对话记得偏好"（E 行）在自动执行路径打折；子代理同理（只继承 skills）。
3. **🔶 目标系统口径不一致**：注入只带 objective 不带 progress（index.js:371-375）；update_goal/get_goal 不在默认启用集（meta.js:75-83）却指示调用（index.js:374）；"completed"非合法状态值（tools/index.js:382 无校验）。
4. **🔶 plan_tasks 为纯内存展示载体**（tools/index.js:110-116）：重启即失、无跨轮注入；F 行"意图规划"挡位=逐请求只读意图，无成熟 CLI 的持久 plan 态——复杂多轮规划缺结构性分界。
5. **✅ 执行核心三层闭环扎实**（对照蓝图批1-4 全兑现）：COMPLETION_HINT 完成度判定（agent.js:204-208/390-497）+B6/B6b 打回（425-473）+loopGuard/F4/预算护栏（507-580/348-386）+agent_runs 断点（runtrack.js）+P10 SUB_CONTRACT（subagent.js:66-79）+driver 验收打回（driver.js:156-168）——E/F 主骨架与蓝图一致，无重大偏离。

## 附注（🔍待核清单）

- web/ 前端 plan/goal/contracts 面板与"打回复盘"UI 未逐行核（本次仅服务端取证）。
- scripts/kpi.mjs（打回复盘 KPI3 度量）未核。
- 批6（流式/usage 帧）对 driver 无人值守轮的影响未评估。
- 蓝图 F 行"高成本自荐待做"表述滞后于代码（index.js:448-457 已实现），建议蓝图下次修订改标 ✅。
