# 审计：RW 蓝图 M/N 域双重对照 + O-1..O-20 台账复核

> 审计对象：`docs/平台开发全集清单-v1.md`（v2.6）M 域（部署发行运维，136-143 行）、N 域（度量与自我改进，145-151 行）、O 台账（O-1..O-20，153-176 行）、P15 决策行（210 行）。
> 方式：代码取证（read/grep，证据=file:行），不改代码。审计时间：蓝图 v2.6 定稿后、批6 实施前。
> 判定符号：✅=属实/在位 · 🐛=缺陷/不一致 · 📝=观察/注释级问题 · 🔶=部分/需注意 · ⬜=未做/不存在 · 🔍待核=未核完。
> 结论速览：O-1..O-20 共 20 行 **全部核完（0 行 🔍待核）**；其中 ✅已修复 声称 11 项 **全部属实（行为级 0 项不符）**；发现 3 处注释/文档级不同步（非行为级）。

---

## 代码对照

### 1. 发行/运维脚本族（P15 批5）

| 对象 | 核对点 | 代码证据 | 判定 |
|---|---|---|---|
| scripts/release.mjs | 发布流水线雏形 | 流程实为：①工作区干净(28-31)→②语法全检 server+scripts(34-46)→2.5 安全基线(49-53)→③vite build(57-61)→④C5 受控部署说明(64)；只读+构建，不自动 reload（与 P15"受控部署延后"一致） | ✅ |
| release.mjs 头注释 vs 实现 | 头注释称"③selfcheck 冒烟" | scripts/release.mjs:4 写"③selfcheck 冒烟（需服务器+账号）"，但代码 26-64 无任何 selfcheck.mjs 调用（仅 71-76 行部署提示里建议人工跑） | 🐛 注释与实现不符（selfcheck 未入流水线，只入提示语） |
| scripts/security-check.mjs | "11 项自检"计数 | step() 调用恰 11 处：.env gitignore 覆盖(25)、密钥 gitignore(26)、.env 未跟踪(29)、danger_command_guard 在位(35)、system_write_guard 6 写工具(36)、access_rules_guard(37)、GUARDED_TOOLS 7 项(45)、plan 退役(46)、占位符检疫(52)、无硬编码密钥(70)、C4 绝对锁(76)；引用的 server/tools/hooks.js、tools/index.js 均在位 | ✅ 11 项属实 |
| security-check 弱项 | 测试强度 | ①gitignore 密钥测试 `/key|secret|credential/i` 被注释行 "# Environment & secrets" 即命中（scripts/security-check.mjs:26）——通过不代表真正覆盖；②硬编码密钥扫描只走 server/（69 行 walk(server)），不含 scripts/src | 📝 弱断言，仅作基线哨兵可接受 |
| scripts/selfcheck.mjs | "12/12"冒烟步骤 | 恰 12 步：health(33)/login(37)/7 个 GET API(41-44 循环)/create conversation(47)/普通对话 SSE 真流(53-75)/delete(78)；需运行中服务器+真实 LLM+账号（默认 /root/.rw-keys.env，12-16） | ✅ 12 步结构与声称一致；"12/12"为运行结论非静态可核 |
| scripts/kpi.mjs | 五 KPI+工具健康+周报 | usage+cache hit 率(27-29)、KPI2 任务级步数/成本+orphan 防悬空归集(32-52)、KPI1 打回率强词口径(55-69)、KPI3 自审闭环(72-77)、KPI4 沉淀(80-89)、KPI5 事故率+假继续近似检测(92-116)、工具榜(119-122)；`--json`/`--save` 基线(125-144) | ✅ |
| scripts/verify.mjs | 统一验证入口 | syntax/test/selfcheck/kpi 四子命令 + 退出码（20-38 行），供 agent/driver 复用 | ✅ |
| packs/rw-core + scripts/apply-pack.mjs | 发行与调教包 | packs/rw-core 存在且含 5 技能（packs/rw-core/skills/{acceptance-builder,explore-discipline,self-audit,subagent-prompt,task-approach}/SKILL.md）；apply-pack 复制 7 规则文档+验收模板+技能树（scripts/apply-pack.mjs:50-59） | ✅ 基础形态在位 |
| apply-pack 引用缺失文件 | RULE_DOCS 完整性 | RULE_DOCS 含 'RW撑竿跳方案.md'（apply-pack.mjs:52），但 docs/ 根无此文件（仅 docs/archive/RW撑竿跳方案-执行史-v1.0.md）→ existsSync 静默跳过（54 行） | 🐛 发行物清单引用缺失目标，静默不报错 |
| apply-pack 范围 | 调教包=什么 | 仅复制文档+技能；无 pack 清单/版本/哈希校验；.env/DB/settings 差异位明确"不复制、随代码版本"（apply-pack.mjs:62 自证） | 📝 自证范围有限：实例差异位（settings/DB schema/视图）仍需手工 |
| mkviews.mjs 引用 | v_usage 视图重建入口 | docs/sql/usage_views.sql:2 提示 `node /srv/rw-workspace/mkviews.mjs`，该文件不在本仓库（服务器侧） | 📝 视图重建依赖服务器侧脚本，仓库无备份 |
| /api/health | 健康端点 | server/index.js:922-924 返回 `{ok:true,service:'rw',ts}`；不探 DB/磁盘/资源 | ✅ 存在但极简（自检级） |
| boot_log | 启动自检留痕 | 仓库代码无任何 boot_log 写/读（全库 grep 仅 docs/archive/daily-evolve-log.md:58 提及"boot_log 无异常"） | ⬜ 服务器侧运维概念，仓库无实现/无表/无文件 |
| /api/usage/stats | 用量统计端点 | server/index.js:648-667：按会话或按账号聚合 rounds/steps/llmMs/tokens/cost（usage_stats） | ✅ |
| v_usage 视图/报表 | D3 可视化视图 | docs/sql/usage_views.sql：v_usage_daily / v_usage_by_round / v_usage_by_conversation 三视图（CREATE OR REPLACE VIEW，5-21 行）——人工/服务器执行，非 db.js schema 一部分 | ✅ 视图 SQL 在位（外置） |
| audit_log | 审计留痕 | 表 db.js:86-92；写入 3 处：ask 裁决 index.js:679、approval 裁决 index.js:701、工具执行留痕 tools/index.js:1073（工具级含 args/result/ms） | ✅ 写入闭环 |
| audit_log 读取 | "随时回查" | 全库无 SELECT FROM audit_log / /api/audit 端点（grep 仅 3 处 INSERT + 建表） | 🐛 只写不读：无查询 API/UI，回查需直连 DB |

### 2. server/db.js（表清单 + boot 自检）

| 核对点 | 证据 | 判定 |
|---|---|---|
| 表数量 | db.js:39-283 SCHEMA 数组 = **23 张表**（accounts/sessions/invites/conversations/messages/audit_log/capabilities/providers/models/market_snapshot/usage_stats/tool_calls/price_table/settings/conv_summaries/scheduled_tasks/goals/long_jobs/conv_skills/knowledge/agent_runs/task_contracts/contract_events），非 28；另有 8 条 ALTER 迁移(290-300)+3 个 settings 种子(306-310) | 📝 实为 23 表；28 为误记（或含服务器侧手工建的视图/表） |
| boot 自检 | initSchema 幂等建表+迁移+种子（db.js:285-315）→ main()：ensureAdmin、providers/模型目录同步、重启自检 interruptStaleOnBoot 遗留 running→interrupted（index.js:1031-1032）、long_jobs 24h stale 清理+日志活跃探测(1033-1049)、scheduler/driver/MCP client+60s 看门狗(1050-1082)、微信/飞书渠道(1083-1090) | ✅ 启动自检闭环在位（无落库自检清单，仅 console 日志） |
| 种子值注释不一致 | db.js:304-305 注释"任务总账默认 30"，实际 SEEDS task_budget_total='100'（db.js:309），agent.js 回退值 budgetTotal:100（agent.js:159） | 🐛 注释过期（30 vs 100） |

---

## O台账复核（O-1..O-20 逐行）

| O-id | 台账声称（验证列） | 结论 | 代码证据 |
|---|---|---|---|
| O-1 | ✅已修复（批1 统一通道：无工具路径结构性消除） | ✅ 属实（行为级）；附注：过期注释残留 | 统一通道注释 index.js:516-519"删除 needsTools 双路径——所有对话统一走 runAgent"；agent.js:367-368"删 needsTools 双路径后…结构性消除"；needsTools 仅降级为 schema 宽度选择 index.js:519 `light=!needsTools(content)`。附注：index.js:238-240 仍留"对话（双路径）普通对话不带 tools…检测到工具意图时走 Agent"过期注释，未随 P1 清理 |
| O-2 | 高消耗 ⚠️已取证 | 📝 取证级状态，非修复声称；批1 缓解措施在位 | 折叠阈值 4 旋钮 settingsSchema.js:15-18 + agent.js:291-334；历史超长截断 index.js:462-466；自动续写上限 agent.js:397-398；141 轮/¥28 属运行取证（archive 文档）非代码可核 |
| O-3 | 中断 ✅已修复（F2 防撞+GLM 180s 超时批3） | ✅ 属实 | reload 防撞=自会话豁免+他任务 running 即拒 tools/index.js:795-811（注释 797-798 提及 O-3 曾 2 次 reload 撞任务）；GLM timeoutMs=180000 providers.js:14（注释 O-3）；按厂商超时 gateway.js:45/154（注释 O-3）；用户停 abort('user') index.js:689 |
| O-4 | hooks danger 守卫失效 ✅已修复（批2 读 args.cmd） | ✅ 属实 | hooks.js:118-127；119 行注释"O-4 修复…实参键是 cmd…此前读 args.command → 从未触发"；120 行 `args.cmd ?? args.command` |
| O-5 | system_write_guard 误拦读 ✅已修复（批2 改挂 6 写类工具） | ✅ 属实 | hooks.js:129-149；129-130 注释"O-5 修复…只挂【写类工具】不挂 '*'…此前 '*' 使 read_file 读 /etc 被误拦"；WRITE_PATH_TOOLS 6 项 hooks.js:134；循环注册只挂 6 写工具 135-148 |
| O-6 | undo/hooks_list 与启用集冲突 ✅已修复（批2 入 PLATFORM_EXEMPT） | ✅ 属实 | meta.js:87 PLATFORM_EXEMPT=['reload_platform','set_limits','hooks_list','undo_checkpoint']；启用集门禁豁免 hooks.js:175；启用集过滤豁免 index.js:123/134 |
| O-7 | 服务器 HEAD 漂移 ⚠️已处置 | 🔶 本地可证、服务器不可核 | 本地 git HEAD=dbfa3af 含批1-5 全部提交（8106499 批5 收官在历史中）+后续 MCP 修复；工作区仅 7 个 docs 未提交（无代码改动）；服务器侧 git 状态仓库内无法核验（按文档记为已处置） |
| O-8 | SSE 偶断 ✅已修复（批3：15s 心跳+X-Accel-Buffering:no） | ✅ 属实 | index.js:482 X-Accel-Buffering:no；484-495 注释帧心跳（armSseHeartbeat 15s 保活，活动即重置）；641 stopSseHeartbeat |
| O-9 | GLM 无法返回 ✅已修复（批3：诚实报告+180s+实测） | ✅ 属实 | F6a 诚实报告 agent.js:475-484（content 空+reasoning>40 → 如实报告，480 行 GLM 提示"thinking 吃输出预算可改选 glm-4.5"）；GLM timeoutMs 180s providers.js:14；glm-5.3 真实返回属运行实测（archive 文档） |
| O-10 | 折叠/归档成本未入账 ✅已修复（批1 kind=collapse 入账） | ✅ 属实 | agent.js:313-322：注释"O-10 折叠成本入账…此前不经 usage_stats 导致钱包虚低"，321-322 INSERT usage_stats kind="collapse" 挂 agent_run_id |
| O-11 | 轨迹参数 [object Object] ✅已修复（批4 JSON 解析展示） | ✅ 属实 | src/Chat.jsx:1090-1093：注释"O-11 修复…统一格式化展示，避免 '[object Object]'"，JSON.stringify(v,null,1) |
| O-12 | B6b 自身观察 📌运行验证 | 📝 描述属实（状态=运行验证非修复） | agent.js:434 大正则 _taskishRe；435-440 扫最近 4 条用户消息判任务语境；457 promiseRe、462 hasSubstance、465 B6b 判定——与"taskish 4 条扫描+大正则"一致 |
| O-13 | 占位符检疫 📌观察 | 📝 描述属实 | hasPh/rejectPh 定义 tools/index.js:30-31；入口全参数检疫 1006；写类工具二次 rejectPh 126/129/134 |
| O-14 | 显式模型被冒充 ✅已修复（批3：会话保存值优先+显式厂商锁死） | ✅ 属实 | index.js:323-334 注释自证 O-14 修复（"原实现只读 body…完全忽略会话保存值 → 切 GLM 后 body 丢参即静默回 deepseek=冒充"）；wantProvider=provider\|\|convProvider index.js:327；显式非 auto 锁死 resolveRoute index.js:292；conversations 表存 provider/model（db.js:298-299 迁移列，index.js:148-156 读写） |
| O-15 | guard 审批未覆盖契约档位要求工具 ✅已修复（批2 补全 7 项） | ✅ 属实 | tools/index.js:19-21 注释"O-15…补齐契约第二章档位表…reload_platform/set_limits 此前不在集内"；GUARDED_TOOLS 恰 7 项（delete_file/db_write/git_pull_push/run_command/kill_process/reload_platform/set_limits）tools/index.js:21；guard 审批门禁 1030 |
| O-16 | 工具轮/最终轮非流式 🔍待修（批6） | ✅ 描述准确（含两处证据点全部命中） | index.js:598-599 注释"统一路径分块模拟流式（真实逐字流式对工具模式不适用；分块保持近实时体验）"+`chunkSize=8`→"8字假分块"属实；chatStream 定义 gateway.js:60-125（与台账行号精确一致）、**零调用**（全库 import 仅 agent.js:5 chatOnceWithTools/chatOnce/calcCost、tools/index.js:8 chatOnce，均不含 chatStream）→ 死代码确认 |
| O-17 | 失败路径不留痕（②）🔍待修（批6） | ✅ 描述准确 | catch 路径 index.js:633-636：send error + markRun interrupted，**不 INSERT 任何 assistant 消息**；对照：正常路径落库 606-614、中断路径已有占位消息+进度 615-632——唯独 catch 异常路径缺口，描述精确；附注：light 问答无 run 时（agentRunId=null）连 run 状态记录都没有 |
| O-18 | 空正文入库（③）🔍待修（批6） | ✅ 描述准确，3 层兜底在位 | ①F6a agent.js:477（content 空+reasoning>40 诚实报告）；②自动摘要 agent.js:486-496（toolLog>0 空答→"（任务执行完成）本轮共…"491 行）；③'（无输出）' 兜底 index.js:595。台账引用的 477/486 行号精确命中；"最终防线+历史清库"批6 未做（无此代码） |
| O-19 | 总时限一刀切误杀 thinking 🔍待修（批6） | ✅ 描述准确 | 非流式总时限 AbortSignal.timeout：chatOnceWithTools gateway.js:154（p.timeoutMs\|\|90000）、chatOnce 45-51；GLM=180s providers.js:14；主路径无空闲看门狗（chatStream 虽有 firstByte+idle 60-69 行但属死代码未用）；"成熟 CLI 无总时限只有空闲看门狗"对照成立 |
| O-20 | 中止透传缺口（A5）🔍待修（批6） | ✅ 描述准确 | gateway.js:67-77：chatStream 内部自建 `new AbortController()`(67)、fetch 用自建 ac.signal(76)，签名无外部 signal 参数；当前零调用故缺口潜伏，批6 每轮流式后放大——与台账判断一致 |

**O 台账复核结论**：20/20 行核完，0 行 🔍待核。✅已修复 声称 11 项（O-1/3/4/5/6/8/9/10/11/14/15）**行为级全部属实，无"声称已修但代码不符"项**；📌/⚠️ 状态行（O-2/7/12/13）描述与代码一致；🔍待修行（O-16..O-20）5 项描述与代码逐点吻合（行号引用精确命中）。注释/文档级不同步 3 处（非行为级）：O-1 双路径过期注释 index.js:238-240、release.mjs:4 头注释自检项与实际不符、db.js:304-309 种子注释 30 vs 100。

---

## CLI对照

> 按蓝图规则：成熟 CLI 怎么做 → RW 现状（含代码证据）→ 优劣势 → 建议 a)采纳调整 / b)不调整+原因 / c)现象差异。

### M 域：部署、发行与运维

| 蓝图行 | 成熟 CLI | RW 现状（代码证据） | 优劣势 | 建议 |
|---|---|---|---|---|
| M1 发行与调教包（✅ packs+apply-pack+发行设计） | CLI 以模板+配置包/预设分发（dsh bundle、opencode presets、settings 导出导入） | packs/rw-core 5 技能 + apply-pack.mjs 复制 7 规则文档+技能（scripts/apply-pack.mjs:50-59） | 优：clone+一键应用规则与技能；代码内默认（schema/启用集/ENV_MAP）随版本一致免复制。劣：无 pack 清单/版本/哈希/差异位迁移；引用缺失文件静默跳过（RW撑竿跳方案.md）；.env/DB/视图/周报排程全部手工 | a)采纳调整：补 pack.json（文件清单+hash+目标路径）+ --dry-run/diff 输出；把 mkviews.mjs 视图重建纳入发行物或仓库；修正 RULE_DOCS 缺失引用 |
| M2 安全基线（❓ 发布前专项 → P15 ✅ 批5 已实施，按状态读取约定以决策表为准） | Claude Code permissions/Hooks fail-closed、Codex sandbox modes、secret 不入库惯例、防火墙/备份清单 | security-check.mjs 11 项（scripts/security-check.mjs:25-76）+ release.mjs 集成（49-53）：密钥不进 git/危险命令守卫/系统写守卫/access rules/GUARDED 7 项/plan 退役/占位符检疫/硬编码密钥/C4 锁 | 优：只读可重复、覆盖代码级危险面与 C4 诚实锁；fail-closed 内置钩子 hooks.js:58-60。劣：无防火墙/备份/依赖更新/密钥轮换检查；两处弱断言（26 行注释即命中、70 行只扫 server/）；release 无版本号/git tag | a)采纳调整：M2 域行状态应更新 ✅（批5，与 v2.5.5 一致）；安全基线可增"服务器项"（systemctl 服务存活/备份目录/端口）提示性检查；b)不调整：代码级危险面已够单用户场景 |
| M3 监控告警（🔶 health+日志；⬜ 告警） | CLI 自报健康/遥测端点（dsh /api/health）；Codex/Claude telemetry 面板 | /api/health 极简 index.js:922-924（不探 DB/资源）；SSE 15s 心跳保活 index.js:484-495；护栏在轮内"先停再问"（预算/轮次 agent.js:348-360）；audit_log 只写不读 | 优：心跳+X-Accel-Buffering 解决中间代理断连；护栏即"成本告警"的轮内替代。劣：健康端点无 DB/磁盘探针；boot 自检无清单落库；无主动告警通道（微信/飞书在位但未接告警） | b)不调整：单用户场景告警价值低、护栏已兜成本；a)轻量可采纳：/api/health 加 db ping+uptime，成本超限走现有渠道为二期 |
| M4 升级回滚（✅ git 回滚+基线；❓ 受控 reload 窗口） | CLI 版本化发布+回滚（版本号/基线、受控 reload 窗口、CI 门） | 提交点即回退点（git）；release.mjs 只读校验不自动部署（64 行）；C5 受控合入；reload 防撞 tools/index.js:795-811；重启自检遗留现场标 interrupted index.js:1031-1032；long_jobs stale 清理 1033-1049 | 优：git 天然时间旅行；reload 不打断他任务（O-3 教训固化）。劣：无语义版本号/tag 管理；DB 迁移是幂等 ALTER 手工清单（db.js:290-300）无版本序；"受控 reload 窗口"仍未达排期级 | b)不调整核心：单实例无多版本并行需求，git 回滚够用；c)现象差异：成熟 CLI 由发布工具管理版本号，RW 以 git 提交为版本（无 semantic version） |
| M5 账单对账（❓ 定期对账，已校准一次） | 厂商控制台账单 vs 本地估算（CLI 显示每步成本） | PRICE 三档计费 gateway.js:8-18（deepseek 注释为真实账单加权单价 6-7）；逐轮入账 kind=round/collapse agent.js:378/321；kpi 成本中位 kpi.mjs:41-45；验收 DSL 已支持 kpi:usage.cost<X driver.js:79-91 | 优：账本细、含折叠成本（O-10 后无悬空）、可机器断言。劣：无自动对账排程（周报不含对账项；"已校准一次"为人工） | a)采纳调整：复用 driver kpi DSL 排一个"对账契约"（周/月），把人工校准变定时机器核验 |

### N 域：度量与自我改进

| 蓝图行 | 成熟 CLI | RW 现状（代码证据） | 优劣势 | 建议 |
|---|---|---|---|---|
| N1 遥测 KPI（✅ KPI+周报+假继续；❓ 看板 UI） | CLI telemetry/面板实时展示（latency/cost/tool health） | kpi.mjs 五 KPI+工具榜+假继续近似检测（92-116）+打回率/自审闭环/沉淀（55-89）；周日周报由服务器 scheduled_tasks 排程（文档记载，仓库无种子）；driver 集成 kpi DSL 验收（driver.js:82） | 优：口径文档化（§0.2）；orphan 成本归集防悬空（kpi.mjs:47-52）；假继续检测是 CLI 没有的 RW 独有指标。劣：无看板 UI；周报排程在服务器 DB 不可移植；假继续近似口径重（扫 400 条×逐条子查询）；打回率靠强词正则（kpi.mjs:55）有漏网 | a)采纳调整：看板二期可先出 `kpi --json` 静态页；排程种子入仓库文档化；c)现象差异：CLI 面板实时、RW 周报+JSON 基线快照 |
| N2 回归测试集（❓ 5 项代表任务固化） | 每次发版跑 CI 单元+集成测试（CLI 自身） | verify.mjs 统一入口（syntax/test/selfcheck/kpi）；selfcheck 12 步含真实 LLM SSE（selfcheck.mjs:53-75）；契约驱动器+验收 DSL（cmd/file-exists/grep/node/kpi）driver.js:56-104 是半自动回归载体 | 优：selfcheck 真实冒烟；验收 DSL 表达力强（可断言成本/文件/正则）。劣：5 项代表任务未固化；无 pre-push/CI 挂载；selfcheck 依赖外部模型可达（CI 不稳定风险） | a)采纳调整：把 5 项代表任务固化为 task_contracts 种子/脚本（driver 已支持无人值守+验收行），挂 release.mjs 或 pre-push；selfcheck 分"离线结构版"与"在线冒烟版"两级 |
| N3 定期自审（✅ 排期 2026-12） | 无行业标准（团队复盘文化） | 自审排期入蓝图；self-audit 技能（packs/rw-core/skills/self-audit/SKILL.md）+复盘模板 | 优：排期入册、模板化。劣：仅文档排期，无日历/契约任务种子（scheduled_tasks 无自审项），依赖人工执行 | b)不调整：季度节奏合理；执行时用 task_contracts 排一次即可，无需代码改动 |
| N4 准则演进（✅ 附录A+高跷闸门） | CLAUDE.md/AGENTS.md 惯例沉淀；Claude Code 订阅制纪律 | 行为准则（附录A 坑位表）；打回=数据：打回复盘:沉淀 knowledge（KPI3 度量 kpi.mjs:72-77）；复盘模板；高跷三问决策门（蓝图原则） | 优：打回→复盘→沉淀→KPI3 度量形成闭环（CLI 无平台强制打回）；附录A #35 假继续被 kpi.mjs:96 引用落地为指标 | b)不调整："坑→规则"走人工纪律符合 RW 信任契约（强制自动化改写规则会过度）；可 c)现象差异：CLI 靠订阅钩子+提示词，RW 靠平台打回+复盘沉淀 |

---

### 审计附注（最重要发现汇总）

1. **O-16 全部证据精确命中**：chatStream 死代码（gateway.js:60-125 零调用）+"8字假分块"（index.js:598-603 chunkSize=8）均可代码取证；且死代码 chatStream 已内含首字节+空闲看门狗实现（gateway.js:63-69）——批6 可复用改造，与蓝图"chatStream 复用（非新写）"自述一致。
2. **O-17 catch 路径是唯一零留痕缺口**：index.js:633-636 只发 error+标 run，对比中断路径（615-632）已有占位消息+进度——描述精确；light 问答无 run 时连状态也无。
3. **M2 安全基线行未随批5 更新**：域行仍 ❓，但 security-check.mjs 11 项+release.mjs 已在批5 落地（P15 ✅）；蓝图"批次完成"与"域行状态"不同步（M1 已标 ✅，M2 漏）。
4. **audit_log 只写不读**：全库仅建表+3 处 INSERT（db.js:86、index.js:679/701、tools/index.js:1073），无查询端点/UI，"随时回查"需直连 DB。
5. **表清单实为 23 张（非 28）**；v_usage 三视图为外置 SQL 手动执行（docs/sql/usage_views.sql），mkviews.mjs 不在仓库——发行到新实例存在真实手工缺口（视图/周报排程/密钥文件），apply-pack 只覆盖文档+技能。
