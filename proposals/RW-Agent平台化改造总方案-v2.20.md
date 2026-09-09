# RW-Agent 平台化改造总方案

> 版本：v2.20（2026-09-09 对话页设置抽屉去冗余回填：附录 D 增"设置入口退役（后台=唯一设置中心）"记录——用户验收反馈对话页⚙设置仍是旧版且与后台高度重合；仅收录已达成共识，不含讨论过程）
> 状态：✅ 基线定稿（B1/B2/B3/④知识库/⑤观测/M1/M2/⑥模板库/D9 应用 v1/全面自检修复/R1R2R5 重构/终审修复批 5–6/设置入口去冗余已完成）
> 单一权威：本文为平台化改造唯一方案文档；修订=直接修订本文件并升版本号，不另立同层文档。
> 约束：**未获用户明确指令，不进行任何代码/网页改动**；本文只描述方案。

---

## 1. 目标与验收

- **目标**：把 RW 封装为可复用的"无身份 Agent 核心"——壳主不改核心代码，编写一份"壳定义"并一键装配后，该壳内的 RW 即以壳的语境与能力工作，对话/思考/工具/护栏/计量/审计机制全部照常。
- **"无身份"界定**：核心不携带业务 persona；保留现状的最小系统自述行（不改内核、不删除）；壳 persona 仅作上下文扩展。即"无身份"=无业务人设，非删除系统自述。
- **验收一（新壳）**：克隆现有壳→修改 5 处（persona/工具/模型/域名/权限）→ 10 分钟内新壳可用。
- **验收二（回归）**：880 实测指南 A–E、selfcheck 12/12、老会话/导出/审批等既有路径不回退。

## 2. 总体架构

```
运行时面（现有 RW）：架构与机制不改（runAgent/工具集/hooks·审批·审计/计量/驱动器/SSE）
决策层（薄垫片，受控新增）：意图识别 → 任务路由 → 灰字回显
壳定义层（核心新增）：shellpacks/<key>/pack.json（schema + git 版本管理）
```

- B 系列变更=在既有接缝上新增薄层（垫片，复用 hooks/policy_rev/approval/access_rules/MCP），**受控扩展而非重写**；一切动工需用户逐项授权（见 §9）。
- 引擎与壳完全分层：一个引擎可同时以多壳身份运行；壳间只共享引擎、不共享定义。
- 自托管差异点（保持并强化）：数据不出域（D5）、审批可精确到工具/命令参数、全量审计、无供应商锁定（壳只声明模型偏好）。
- 参考范式：OpenAI GPTs、Claude CLAUDE.md/Skills、Agentforce 声明式元数据（仅作启示）。

## 3. 壳定义（Shell-pack）Schema v1

### 3.1 字段集（v1 冻结；扩展只增不改，向后兼容）

| 组 | 字段 | 说明 |
|---|---|---|
| 基础 | shellPackVersion / key / name / description | `default`=系统保留（中性壳） |
| identity | persona(可空) / tone / forbidden | 空=保持现状中性自述；有壳才扩展语境；受长度与占位符检疫约束 |
| domain | agendsText / terms | 领域说明（可引用 AGENTS 文件） |
| modelPolicy | defaultProvider / defaultModel / allowModels / budgetYuan / qualityCostBias(0-10) | 壳声明偏好，引擎解析 |
| tools | presetBase(minimal/standard/all) / forceOn / forceOff / mcps / connectors | 高危工具默认 forceOff，可人工放开 |
| knowledge | scopes(global/shell/project) / importRefs | 知识源显式绑定 |
| skills | allow / defaultsAutoLoad | 白名单 + 开工自动载入；技能解析路径=全局技能目录（RW_SKILLS，实测 `/srv/rw-workspace/skills`）+ 壳自带目录（壳级技能随 pack） |
| guardrails | accessRules / approvalMode / sensitiveDefaults | 护栏与审批策略随包 |
| channels / uiBrand | domainHosts / bindings；名称/图标/主题 | 入口与品牌（uiBrand 可选） |
| eval | goldenSetRef | 金标评测集引用（canary） |
| intentRules（v1.1 可选） | do / highRisk / readonly / chatOnly | 每壳意图词表 |
| taskProfiles（v1.2 可选） | 见能力定义节 | 命名任务模板 |
| credentials（v1.2 可选，后置） | 凭证引用（连接器/渠道用） | 不存明文、只存引用（规则见 §8） |

### 3.2 版本管理（git）

- `shellpacks/`=git 仓库，一壳一目录，`pack.json` 为权威副本；支持 diff/tag/revert/branch/多机同步；审计记录装配 commit。
- 运行态=DB 镜像（文件为权威、DB 为现况，双写）；变更生效=装配/重载触发（import 或档2 watch，新会话最快约 5s 生效）——**壳定义变更不走 policy_rev**（policy_rev 仅覆盖 settings 护栏/规则变更，见 §8"触发范围说明"）。
- 渐进：档1=导出/导入+手动 git；档2=文件为源+自动 reload；档3=多实例共享/版本钉住/PR 评审。

### 3.3 默认壳与迁移

- `default` 壳=现状行为（无 persona）；现 `TOOL_INTENT_RE` 兜底常量迁移为 **default 壳 pack 的内置 intentRules**（文件权威），运行时读 DB 镜像——迁移后老对话行为由回归基线守护（§1 验收二）。

### 3.4 装配流程

`import → schema 校验 → upsert 壳行/壳设置/壳工具三态 → 会话携带 shell_key → 按包执行（身份/知识/技能/工具面/模型/护栏）→ 冒烟 → 装配报告`

## 4. 隔离与权限规则

- 壳间不共享定义与业务数据：涉及会话/知识/任务/契约/用量/审计的查询**服务端强制带 shell_id**（统一 scope 助手，防漏 WHERE）。
- 知识 scope：默认"壳私有 + 全局共享"；shell 知识仅该壳会话可见。
- 文件边界：read/write 会话工作区按壳目录隔离（复用现有 limitPath 语义）；full 权限语义不变。
- 权限与审批：permission 四档与 guard/审批语义不变；高危意图/工具映射见 §6.1。
- 审计：usage/audit/tool_calls 落 shell（及档案/难度）字段，按壳可对账。
- 并发护栏：v1 保持全局共享上限（`max_concurrent_chats` 默认 5，0=不限），**不按壳拆分**；单核心多壳共享进程，多壳并行受该全局上限约束（2 核小机不建议放开）。

## 5. 决策记录（已定稿）

| 编号 | 结论 |
|---|---|
| D1 部署形态 | 方案 D：单核心多逻辑壳；先 D 后 A（壳可一键升级为独立实例） |
| D2 首个壳 | code 壳落 885 位置、对外 `code.ronisyn.com`；880 保留为测试/staging；正式域名上线另议 |
| D3 后台入口 | 统一后台=`ronisyn.com/console/*`（基础域加路径；壳名不加在 console 前）；同站同账号、仅 admin 可见；子菜单用二级路径 |
| D4 界面形态 | 登录先见总览首页，聊天为单独"对话页"；880 为该形态测试环境 |
| D5 数据边界 | 知识库 L2 先行、默认不出服务器；向量检索（如启用）用服务器自托管开源 embedding |
| D6 评测口径 | 观测式：不做同任务 A/B 双跑；按任务自然积累 |
| D7 图谱 | 仅项目级知识图谱（记录需求/修订/变更链路与原因）；不做全局图谱 |
| D8 进化机制 | 每日自我进化任务自动汇总信号→提出修订提案→admin 审批放行 |
| D9 命名 | 壳=部署容器；应用（Agent 应用）=业务单元；任务档案/技能/验收=应用的组成件 |
| D10 试点 | Shopify / 易仓连接器试点：当前不做、推迟（何时启动由用户指令） |
| D11 多角色 | 多角色/账号体系后置（现状单账号=admin）；"壳管理员"不进入 v1 |

## 6. 能力定义 v1

### 6.1 意图识别 v1（②）
- 输出标签：要动手·普通／要动手·高危（先审批）／只读规划／闲聊·收尾；未判定时询问用户（不猜、不假答应）。
- 高危→审批的落地映射：高危词表命中 → 会话 permission=guard 或写入 access_rules 规则，**复用现有 hooks/审批链路**，不新造审批系统。
- 机制：每壳词表（intentRules）+ 灰字意图回显；纠正沉淀为 intentSamples。
- 回显语义：系统级灰字行，**不入消息正文、不入导出**，仅入 audit（带 shell/档案字段）。
- LLM 兜底默认关；任务类型识别不在 v1（v2：词表命中率 <90% 或"拿不准"频次高时启用）。

### 6.2 任务档案与路由 v1（③）
- 档案=命名任务模板（taskProfiles）：name / match(用户点名或 UI 选择) / modelHint{default, qualityCostBias}，可加"强制只读"。
- 预置（code 壳）：small-fix／refactor-plan／feature-delivery。
- 路由三级：显式指定（绝对锁）> 档案建议 > 壳默认；结果灰字回显（语义同 §6.1）、可一键退回默认。
- 观测位：档案命中落审计与观测表（档案×模型×难度）。
- 难度：v1 由用户人工勾选（小/中/大）；自动估算挂 v2。
- v2：用户频繁手动换模型时启用自动匹配。

### 6.3 知识库 v1（④，L2）
- scope：global / shell / project（预留）；默认"壳私有 + 全局共享"。
- 上传链：UI 上传→解析→入库；xlsx 按行结构化优先。
- 检索：关键词 + 命中溯源（原文摘录与出处）。（L3 向量：默认关、触发后再评估。）

### 6.4 模型观测 v1（⑤）
- 指标（锁定）：一次通过率／bug 数（打回必填原因）／任务时长／token／费用；不含自测。
- 归集维度：执行模型 × 难度 × 任务档案；展示=趋势 + 可下钻流水。
- 异常仅提示换模型建议，不自动改路由；跨壳对比归统一后台。

### 6.5 任务模板库 v1（⑥）
- 模板包= taskProfile＋技能 SKILL.md＋验收模板＋说明；随仓库 git 版本管理；支持导出/导入/克隆。
- 入口：壳内"从模板开任务"＋统一后台模板库；不做商店/审核/分成。
- 与"应用"的关系：模板库=应用的"半成品"；可执行的应用形态（D9）属于 M 系列之后的产物，不进入 v1 批次。

## 7. 统一后台

### 7.1 入口与导航
- `ronisyn.com/console/*`；同站同账号；仅 admin 可见（D11）；子菜单二级路径。
- 工作台与后台互相跳转；不设第二站点、第二登录。
- 普通账号视角（现状不存在；未来引入时）仅见各自工作台，不可见后台——随 D11 一并后置。

### 7.2 板块结构（4 组 8 项）
| 组 | 板块 |
|---|---|
| 模型 | 1.1 模型广场 · 1.2 模型观测 |
| Agent | 1.3 Agent 开发（壳）· 1.4 Agent 能力 · 1.5 Agent 进化 · 1.6 Agent 广场（应用） |
| 知识库 | 1.7 知识库 |
| 系统 | 1.8 设置 |

- 1.1 模型广场：厂商发现（官方+市场快照源）→ 预置 base URL 自动匹配 → 输入 key 测试连通 → 拉取模型并按能力/厂商/价格/上下文筛选 → 启停 → 分配壳 → 设置壳默认模型。
- 1.6 Agent 广场：应用可独立运行／挂入壳内页面／共享（应用为后置形态，见 §6.5）。

### 7.3 总览首页（工作台首屏）
组成：迷你对话 + 每日日报/进化说明 + 每周周报入口 + 数据看板 + 壳预览与迭代 + 待加入新模型卡片。
说明：首页"迷你对话"与对话页为**同一会话体系、两种视图**（均走现有 /api/chat），不产生第二套会话。

## 8. 数据与接口增量（数据面载体）

**新增表**（幂等迁移）：
- shells / shell_tools（三态）/ shell_settings —— 壳定义运行态（§3）；
- issues 镜像（GitHub issue 缓存，885 相关后置使用）；
- reviews（复测记录：issue/会话、结果、bug 原因必填、放行人）——支撑 ⑤模型观测 与 D8 信号；
- model_telemetry（观测事实表：会话/执行模型/难度/档案/时长/token/费用/一次过/打回）＋视图（按模型×难度×档案、按壳、按天）——统一 §6.2/§6.4 与 D8 信号的数据来源；
- intent_samples（意图回显/纠错样本：原文、命中结果、用户纠正、壳）——②"词表命中率/拿不准率"信号的数据来源。

**存量表扩展字段**：conversations.shell_id/issue_id/kind(exec)；usage_stats/audit_log/tool_calls 增 shell_id（档案/难度主落 usage_stats，audit/tool_calls 可带）；knowledge 增 shell_id/scope=shell（与 §4 壳私有知识一致）；scheduled_tasks/task_contracts 增 shell_id（其专用会话 external_id 带壳前缀防跨壳撞键，B 系列实现）。

**新增接口**：/api/shells CRUD、/api/shells/:id/import·export·clone、复测 reviews 读写、模型观测查询（telemetry 视图）。

**前端**：意图/路由灰字回显共用组件（系统行，不入历史）；首页与对话页导航。

**预算分层**：全局 settings 现值（time/round/loop/cost）保持不变；壳级预算=pack `modelPolicy.budgetYuan` 叠加生效（壳上限可收紧、不高于全局语义），避免双轨冲突。

**凭证存放规则（并入现状边界）**：壳/连接器凭证**不进 DB 明文、不入对话上下文**；当前密钥体系=config.keys 单键、启动载入——v1 壳/渠道沿用 env 单键、壳 pack 不携带密钥；"壳×连接器分存"属**连接器机制（D10 试点后置）**实现时的运行时密钥库（服务端读取、按需加载、审计只记引用）；schema `credentials` 字段（v1.2 可选）为该机制预留引用。

**提案与审批落点（D8）**：修订提案=仓库 `proposals/` 文件 + 现有 `/api/proposals` 端点与设置"提案"页（现成机制）；每日自我进化产出提案文件→通知 admin→对话/提案页审批通过→按 §11 升版并受控合并；不新造审批系统（工具级审批卡语义不变）。

**触发范围说明**：policy_rev（最快 5s）覆盖 settings 护栏/规则变更，**不覆盖壳定义**；壳定义变更=pack 装配/重载触发（import 或档2 watch），两者分开管理。

**工具面按壳过滤（含 MCP/连接器）**：B 系列在工具解析处新增"注册/启用层"，按壳返回 preset∩force∩已勾选插件（MCP/连接器）——MCP 按壳启用需该新注册层，不复用现状全局注册。

**审计脱敏**：审计/落库沿用现状 `redactSecrets` 规则（sk-/ghp_/Bearer 等），壳与档案字段不含敏感值。

## 9. 实施规划

- **总体约束**：任何内核或网页改动均需用户逐项授权（当前未授权）；每次改动过质量门禁：selfcheck + 随壳包考题集 + 880 E2E（回归基线见 §1 验收二）。
- **前置 P0 · 代码基线对齐（已执行 2026-09-08）**：本地仓库与服务器运行版已同步至同一 main HEAD=**b2910c2**（=origin/main）；服务器工作树干净；运行版 selfcheck **12/12 通过**（记录见 附录 C）。此后所有实施与回归以此基线为对照；动工前须保持本地=origin/main。
- **运行环境说明**：真实护栏=**settings 体系 + 代码常量**（time/round/loop/cost、`max_concurrent_chats`（index.js:402，默认 5）、token 输出上限等），运行时按需读取；`.env` 中另有 **AGENT_*/BG_*/RW_AUTO_RESUME/LLM_MAX_OUTPUT_TOKENS 等参数在代码中无读取点（疑似遗留，2026-09-08 全库核验 0 命中）**——不得误依赖，按"前置 Q0"处理。
- **前置 Q0 · 参数清点（随 B1 执行，属实施前置）**：逐项核对 env/settings 与代码消费点，输出"参数-消费对照表"；未消费参数=删除或正式接入二选一，杜绝死配置。
- **批次（内核侧）**：B1 壳基座（pack 校验→壳行/三态→会话生效→10 分钟验收）；B2 意图 v1（intentRules+回显+默认壳兜底迁移）；B3 档案路由 v1（taskProfiles+三级路由+回显+观测落表）。
- **网页层**：M1 880 增加总览首页（`/`）、现有 RW 页改对话页（`/chat`）、页间导航；M2+ `/console/*` 各板块（随 B 系列数据接口落地；缺接口先占位记录）。
- **当前状态**：B/M 均待用户单独指令；应用形态（D9/1.6）后置于试点与 M 系列。

## 10. 发行与实例化

- 三物关系：仓库=代码模板；packs/rw-core/=调教资产（apply-pack 展开）；壳包=壳定义；instance-pack=壳升级为独立实例（方案 A）。
- 实例差异位：PORT / DB_NAME / RW_ADMIN / 模型 Key / RW_WORKSPACE / 渠道开关。
- 回流：某壳/实例验证过的技能/档案/模板 → 回流 packs/模板库 → 其它实例获取。

## 11. 版本回补策略

- 每能力分 v1（基础，先行）与 v2（完整，由数据信号触发，非时间表）。
- 新能力默认关；schema 版本化=扩展即新增、不推翻。
- 实践信号经"每日自我进化 + 周报信号栏 + 两周触发清单对照"采集（数据来源=§8 telemetry/reviews/纠错样本）；修订=提案→admin 审批→升版本。
- 采集载体=既有定时任务：每日自我进化=`scheduled_tasks#4`（cron `0 5 * * *`）、周报=`scheduled_tasks#3`（KPI，cron `0 9 * * 0`，0=周一）；扩展其 prompt 为"信号汇总+修订提案"属待授权 DB 变更（非代码）。

## 12. 待实践校准项与后置项

- **待实践校准**（参数级，等真实数据）：打回原因分类标签、意图词表考题集阈值、L3 向量触发阈值、难度自动估算。
- **后置项**：Shopify/易仓连接器试点（用户暂缓，D10）；885 业务数据并入与 code 壳上线细节（用户主导）；本地模型部署投入（以 ⑤观测月成本信号决定，当前结论=不投入）；多角色/账号体系（D11）；应用形态（D9）。
- **实施期细节（随 B/M 承接，不另立正文）**：壳生命周期状态机与"文件-镜像"双写一致性细则；reviews 与既有契约复测链路（candidate_done→人工确认）的字段映射；"改核心边界"冻结名单（核心文件清单）于 B 系列启动时评审；880 实测指南 A–E 原文作为验收附件引用（不内嵌正文）。

## 附录 A：本地模型部署评估摘要

- 现状（实测）：服务器为 KVM 虚机，无 GPU、2 核 CPU、3.4G 内存 → 不可承载本地大模型。
- 候选（若将来投入）：24G 卡=32B 档（如 R1-Distill-Qwen-32B）；48G 卡=Qwen3-Next-80B-A3B 档；embedding 用 bge-m3（CPU 可跑）；引擎 Ollama→vLLM。
- 经济：云 API 月成本约 ¥1500–5700 时接近单卡自购/租用盈亏平衡；当前结论=不投入、维持云 API 主力；投入与否由用户决定。

## 附录 B：来源与归档

- 前身文档已归档：`proposals/_archive-四文档合并-20260908/`。
- 保留的细节参考：`proposals/壳核分层总体架构-{需求文档,技术方案,测试用例}-v0.1.md`、`proposals/意图识别-v1-收口.md`、`packs/rw-core/`。
- UI 讨论原型（prototype/）为历史讨论稿，不构成本方案内容。

## 附录 C：服务器实测基线（2026-09-08，root@47.106.205.196 只读侦察）

| 维度 | 实测 |
|---|---|
| 运行代码 | `/srv/harness-workbench` @ main **188bbc7**（B1+B2+B3 实施后；=origin/main=本地）；服务器工作树干净（代码部分） |
| 服务/端口 | rw-test running（880）· 885=hello · nginx/mysql running · Node v22.23.2 |
| 自检 | `node scripts/selfcheck.mjs` **12/12 通过**（回归基线） |
| 数据库 | 29 张表 + 3 用量视图；会话 43 / 消息 169 / 知识 8 / 用量当日 39 行 ≈¥3.5 |
| 模型 | enabled 55：deepseek2·glm10·ark6·moonshot4·dashscope7·tokenhub4·qianfan7·minimax5·siliconflow10 |
| 模型市场 | openrouter 434 · dashscope 250 · siliconflow 96 · tokenhub 125 |
| 定时任务 | id3 KPI周报（en=1）；id4 每日自我进化-05:00（en=1）——§11 采集载体 |
| 技能目录 | `/srv/rw-workspace/skills`：acceptance-builder/explore-discipline/rw-dev-audit/self-audit/subagent-prompt/task-approach |
| 壳相关 | B1 已实施上线（见 附录 D）：`server/{shells,shellstore}.js`、三张壳表、default+code 壳启用；会话 shell 接线、persona 注入（非 default 带 persona 才扩展）、force_off 拦截、usage/tool_calls/audit 落 shell_id 均经全面自测；密钥文件 /root/.rw-keys.env 权限 600 |

## 附录 D：B1 实施记录与全面自测（2026-09-08）

- **提交（origin/main，均已部署 880）**：`5dda4b3`(壳基座①表+种子+校验+库+API+会话接线) → `103d822`(mode 列长修正) → `6418386`(null 校验兼容) → `fcd1b98`(④埋点+force_off 拦截+管理审计) → `f282aba`(JSON 列 jsafe 兼容修复)；当前运行 HEAD=f282aba。
- **实施内容**：§8 新增表 shells/shell_tools/shell_settings + conversations.shell_id + default 中性壳种子；`/api/shells*`（list/get/import/clone/disable/patch）+ 会话可选 shell 建会话 + 壳 persona/domain 注入（非 default 且带 persona） + execTool force_off 执行前拦截（平台豁免除外） + usage(round/续写/折叠)/tool_calls/audit_log 落 shell_id + 壳管理动作审计。
- **自测结果（880 真机，exit=0）**：功能套件 14/14 通过（import/拒绝非法/元数据/三态/克隆继承/带壳建会话/回落 NULL/chat 冒烟/停用）；execTool 确定性验证：read_file 成功落库 shell_id、run_command 被 force_off 拦截；selfcheck **12/12**；本地单测通过。
- **过程中发现并修复的缺陷**：① shell_tools.mode 列长截断 force_off（扩 12+幂等迁移）；② 校验器不兼容 qualityCostBias=null；③ **JSON 列二次解析**：mysql2 已反序列化对象再 JSON.parse → clone 丢三态（jsafe 兼容，含单测）。
- **边界说明**：usage 的 shell 落库发生在"工具轮"执行路径（纯问答不入 usage round，属既有计量语义）；runAgent 工具面暴露层的 preset∩force 全量过滤与 ⑤观测视图等属后续批次。

## 附录 D 续：B2 意图识别 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`68916eb`（B2 意图识别 v1）；当前运行 HEAD=68916eb。
- **实施内容**：新增 `server/intent.js`（纯函数分类：高危>只读>动手>兜底 ask；词表可壳级覆盖，默认=default 壳兜底）；壳词表持久化 `shells.intent_rules`（列+import/update/rowToPack；`shellpacks/code/pack.json` 含示例 intentRules）；对话 SSE 新增 **`intent` 灰字事件**（label/echo/hit；不入消息正文与导出）并按 `intent:<label>` 落审计（带 shell_id）。
- **验收（880 真机）**：readonly／act-high／act／chat 四标签逐案正确（code 壳词表+default 兜底）；intent_rules 已落库（JSON_EXTRACT 核验）；intent 审计 8 行；selfcheck **12/12**；本地单测 19/19。
- **边界（按 §6.1 分期）**：LLM 兜底与任务类型识别=默认关后置；高危→审批强制执行（guard/access_rules 映射）与灰字 UI 渲染随 M 系列/后续批次；现有 needsTools/工具面行为路径未改动（回归由 selfcheck 与既有 E2E 守护）。

## 附录 D 续：B3 任务档案与路由 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`188bbc7`（B3 任务档案路由 v1）；当前运行 HEAD=188bbc7。
- **实施内容**：新增 `server/profile.js`（点名解析：仅显式点名/关键词，**不自动猜**；去空白容忍）；壳档案持久化 `shells.task_profiles`（列+import/update/rowToPack；`shellpacks/code/pack.json` 预置 small-fix／refactor-plan／feature-delivery）；三级路由应用=**无显式模型时**按档案 modelHint 生效（C4 显式=绝对锁不被覆盖；档案供应商无 Key 则跳过回落既有默认）；对话 SSE 新增 **`route` 灰字事件**（档案/建议模型）+ `route:<档案>` 审计（带 shell_id）。
- **验收（880 真机）**：点名"按小修档案…"→ route 事件 small-fix 且生效 ✓；未点名"帮我修一下…"→ **none（不自动猜）** ✓；route 审计 1 行 ✓；selfcheck **12/12** ✓；本地单测 23/23。
- **边界**：难度人工勾选与"一键退回默认"回显按钮随 M/UI；自动匹配档案=v2（触发：用户常手动换模型）；档案×模型观测归集已由 ⑤model_telemetry 批次落地（见下）。

## 附录 D 续：B2–B3 综合自测记录（2026-09-08）

- **结果**：880 真机综合套件 **15/15 PASS** + selfcheck **12/12** + 本地单测 23/23，**无产品 BUG**。
- 覆盖：B1 回归（import/三态/克隆继承/会话接线）＋B2 四标签（readonly/act-high/act/chat，壳词表与默认兜底）＋B3 路由（点名 small-fix 生效／未点名 none／未知档案 none／**显式模型=绝对锁 route none**）＋**回显不入消息**（intent/route 仅事件+审计）。
- 过程中暴露的 3 处均为测试/验证方法问题并已解决：① 早前 E2E 对 mysql2 已反序列化 JSON 二次 parse（产品侧 jsafe 修复已有单测）；② 套件早停条件漏读 route 事件（改为读到 route/thinking 才停）；③ 一次 selfcheck 瞬时 11/1（取消流并发占用，复测 12/12）。
- 审计底数：intent 审计 18 行、route 审计 2 行（随用例累积）。
| 运行时参数（有消费） | settings：time_budget_min=120·round_cap=2000·loop_guard=6·max_parallel_tools=10(默认)·task_budget_yuan=0(关)·task_budget_total=0(不限)·max_concurrent_chats=5(默认, index.js:402)·temperature=0.4·systemPrompt=空·__policy_rev=1；env：PORT=880·DB_NAME=rw_test·SESSION_DAYS=5·FEISHU_WEBHOOK=1 |
| env 未消费参数（疑似遗留，0 代码命中） | AGENT_TIME_BUDGET_MS=0·AGENT_ABSOLUTE_CAP=600·AGENT_STALL_WINDOW=6·MAX_REPEAT=3·RECOVER=3·BG_ABSOLUTE_CAP=1500·BG_STALL_RECOVER=3·RW_AUTO_RESUME=1·LLM_MAX_OUTPUT_TOKENS=8192 → **前置 Q0：已按用户确认删除（2026-09-08；备份 .env.bak-20260908-q0；重启后 selfcheck 12/12，行为零变化）** |

## 附录 D 续：⑤ 模型观测数据面 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`a284758`（B-obs 数据面：model_telemetry 表+reviews 表+按日视图；chat 收尾按执行快照落观测；/api/reviews 读写+telemetry/daily 查询）→ `c28411e`（会话删除级联补 model_telemetry/reviews 防孤儿）；当前运行 HEAD=c28411e。
- **实施内容（§6.4/§8 ⑤）**：
  - `model_telemetry` 执行事实表：conversation_id/account_id/shell_id/provider/model/profile_key/difficulty(预留,人工勾选随 M)/tokens_in/out/cache_hit/miss/cost/duration_ms/created_at + 索引(created_at)、(shell_id,provider,model)；`reviews` 复测表：result(pass|bug)/bug_reason(打回必填)/created_at + 会话索引；视图 `v_model_telemetry_daily`（壳×厂商×模型×日聚合，CREATE OR REPLACE 幂等）。
  - **执行快照口径（防重复计入）**：chat 收尾在 runAgent 前取 `usage_stats MAX(id)` 为快照，执行后仅归集 `id>快照 且 kind∈(round,collapse)` 的行——同会话 1 小时内多次执行不会把历史消耗重复计入观测；summary/title 等旁路（摘要/自动标题）不入执行口径；护栏前置拦截/零消耗不产生空行（COUNT>0 才落）。
  - **新接口**：`POST /api/reviews`（result=bug 必须 bug_reason；校验会话归属；审计 review:<result>）、`GET /api/reviews?conversation_id=`（本账号倒序）、`GET /api/telemetry/daily?days=&shell_id=&provider=&model=`（视图行 + 同口径合计）。
  - 会话删除级联清单扩展至 12 张表（新增 model_telemetry/reviews）。
- **验收（880 真机，exit=0）**：selfcheck **12/12**（其中一次 plain chat 即产出 telemetry 行并随删会话清空）；E2E 观测套件全过：chat 200→落 1 行观测；reviews bug 无原因→400 必填提示；bug 带原因→200；pass→200；按会话读取回两条；telemetry/daily 返回 total+rows 与 usage_stats 口径一致；不存在会话打回→404；删会话后 orphan-reviews=0 / orphan-telemetry=0（级联生效）。本地单测 29/29。
- **边界**：daily 视图暂为全账号聚合（单账号实例现状；多账号后台隔离随 D11）；difficulty/一次过率需 reviews+UI 联动展示（M 系列）；回显灰字（模型观测入口在统一后台 1.2）待 M2。

## 附录 D 续：④ 知识库 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`9e7a03d`（④知识库 v1：scope=shell + 上传链 + 前端上传入口）；当前运行 HEAD=9e7a03d。
- **实施内容（§6.3/§8 ④）**：
  - `knowledge` 表增 `shell_id`（幂等迁移 + idx_kb_shell）；scope 语义=global(全部) / shell(仅所属壳会话可见，§4 壳私有+全局共享) / conv(本会话，存量不变)；default 保留壳=中性，不承载壳私有。
  - 新纯函数模块 `server/knowledge.js`（单测 8 绿）：`kbVisibleWhere`（会话可见 SQL 统一出口，防漏 WHERE——F19 注入/kb_search/kb_del 共用）+ 上传解析（xlsx/xls/csv 按行结构化：首列=title、整行"列名: 值"拼 body、可带表头；txt/md 空行分段；json 数组）。
  - F19 会话知识注入、kb_add（scope=shell 需会话在真壳内，default/无壳拒绝）、kb_search、kb_del（仅删当前会话可见范围条目）全部按壳过滤；agentCtx 增 shellKey。
  - **上传链 API**：`GET /api/knowledge`（scope/shell_id/q 过滤列表）、`POST /api/knowledge/import`（base64 文件→解析→批量幂等入库 inserted/updated，审计 knowledge:import）、`DELETE /api/knowledge/:id`（归属校验+审计）。
  - **前端（本批次授权范围）**：顶栏新增"📚 知识"面板（`src/Knowledge.jsx`）：上传（global/壳私有目标选择、表头开关）+ 范围/关键词过滤列表 + 删除。
- **验收（880 真机，exit=0）**：selfcheck **12/12**；知识 E2E **13/13 PASS**（convA 无壳/convB code 壳建会话；import global txt→1；shell 缺 shellKey→400；shell import(code)→1；xlsx 3 行结构化→3；list global 前缀≥4 且不含 shell 行；list scope=shell=1 带 shell_key=code；**DB 可见性：code 壳会话可见含 shell 私有行、无壳会话仅 global**；delete→ok、重复 delete→404）；前端 bundle 含面板入口；E2E 残留 0（知识/会话全清）。本地单测 37/37。
- **边界**：列表接口为管理视图（本账号全量）；对话侧注入上限仍 12 条/前 5 带摘要（含壳私有后可能挤占，v2 再调）；命中溯源=关键词+body 片段（L3 向量默认关）；上传 UI 未做批量文件夹/大文件分片（express json 2MB 上限内）。

## 附录 D 续：M1 网页层 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`9a41b3f`（M1 A+B+C：路由双页+总览首页+灰字回显+一键退回默认）→ `3fdf0bb`（修正：一键退回默认前端直接置自动路由显示）；当前运行 HEAD=3fdf0bb。
- **实施内容（§7.3/§9/§8/D4）**：
  - **A 路由与导航**：不引路由库，`App.jsx` 按 location.pathname 分发——登录后默认落**总览首页 `/`**（D4），`💬 对话页` 进 `/chat`（支持 `?conv=<id>` 直达会话，convs 加载后自动打开）；logo/🏠首页回总览。SPA 回退（`/chat` 可刷新）由既有 `app.get(/^(?!\/api).*/)` 承担，**零服务端改动**。
  - **B 总览首页 `src/Dashboard.jsx`**：迷你对话（同一会话体系=复用最近会话/现场建，均走现有 `/api/chat`；最近会话一键跳对话页）+ 用量看板（usage/stats）+ 壳预览（/api/shells，default 不计）+ 知识条目数（/api/knowledge）+ 日报/周报入口（定时任务 #4/#3 最近结果摘要）+ 待加入新模型卡（未配 Key 厂商数 + 市场模型快照数）。
  - **C 灰字回显 + 一键退回默认**：`api.js` 补解析 SSE `intent`/`route` 事件；Chat 消息区下新增灰字系统行（意图/路由标签+echo，仅当轮展示，不入历史/导出——§8 回显语义）；route 行旁 **↩ 退回默认**：PATCH 会话 provider/model 置 null（清除显式选择，回落自动路由；C4 显式锁语义不破坏）。
- **验收（880 真机，exit=0）**：selfcheck **12/12**；M1 E2E **6/6 PASS**：code 壳+显式 glm 会话问答 SSE 含 intent 事件、无 route（未点名）✓；无显式模型的 code 壳会话点名"small-fix 档案"→ route 事件 profile=small-fix ✓（B3 显式=绝对锁路径未破坏）；PATCH provider/model=null → DB 双列 NULL ✓。SPA 三路由 `/` `/chat` `/chat?conv=1` 均 200；bundle 含"工作台总览"与"退回默认"；E2E 残留 0。本地单测 37/37。
- **边界**：M2+ 统一后台 `/console/*`（1.1 模型广场…1.8 设置）未做（接口就绪，占位记录）；总览首页为单页工作台形态（迷你对话未做完整工具轨迹视图——展开由"对话页"承担）；灰字当前仅 intent/route 两类，纠错/意图样本（intentSamples）沉淀随 M2。

## 附录 D 续：M2 统一后台 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880，分 4 组部署验证）**：`79b6bae`（M2-① 服务端最小接口集）→ `0431eef`（M2-② console 框架+1.2/1.7/1.8，含重建 dist）→ `765fb90`（M2-③ 1.1/1.3 实板块）→ `58e89cc`（M2-④ 1.4/1.5 实板块+1.6 占位）；当前运行 HEAD=58e89cc。
- **实施内容（§7.1/§7.2 四组八项 /console/*，同站同账号三角互跳）**：
  - **服务端最小接口集（M2-①，用户批准）**：`PUT /api/models/:id`（models.enabled 启停=菜单闸门；C4 显式会话锁不受影响；审计 model:enable/disable）；`POST /api/providers/test`（baseUrl+key 临时调 chat/completions 最小探测连通，**不落库**——§8 凭证不入 DB；400 模型名被拒但鉴权过=判定连通）；`PATCH /api/shells/:key` 扩 `modelPolicy`（壳默认模型/allowModels/budgetYuan 归一落 JSON）+ `GET /api/shells/:key/export`（DB 镜像→pack 导出，§3.2 双写）。
  - **前端**：`App.jsx` 加 `/console/*` 分发；`src/console/` 布局（顶栏+四组导航+内容区）+ 板块注册表。**1.1 模型广场**（厂商连接态/key 临时测试/模型启停勾选/市场快照展示）；**1.2 模型观测**（telemetry 按日表 + reviews 复测表 + 合计卡）；**1.3 壳开发**（列表/详情/工具三态/persona+描述编辑/默认模型设置/import/export/克隆/停用）；**1.4 Agent 能力**（A/B/C 能力开关 + 工具启用集勾选 + 规则只读）；**1.5 Agent 进化**（进化/周报定时任务卡 + 提案文件查看与新建 + audit 流水脱敏）；**1.6 Agent 广场**=占位（D9 应用后置）；**1.7 知识库**（复用 ④ Knowledge embedded 模式：上传链+列表）；**1.8 设置**（schema 驱动护栏/预算/上下文+温度+系统提示词）。Dashboard/对话页顶栏加 🎛 后台入口。
- **验收（880 真机，exit=0）**：selfcheck **12/12**（各组部署后复测）；M2-① E2E 8/8（models 启停翻转+还原、providers/test 真 key→ok 假 key→拒绝、shells export pack 结构、patch modelPolicy 落库+还原）；M2 最终回归 **11/11**（八板块读接口 + caps 开关往返 + chat 主链路）；8 板块路由 `/console/*` 全 200；bundle 含全部板块；本地单测 37/37。
- **边界**：1.4 规则为只读视图（编辑在对话页⚙设置→规则，共用 access-rules 键）；1.6 广场占位=按 D9 后置形态；能力"多角色仅 admin 可见后台"随 D11（现状单账号=admin 全可见）；模型启停只影响菜单不影响已保存显式会话（C4）。

## 附录 D 续：⑥ 任务模板库 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`7046f21`（⑥模板库 v1：D9 半成品载体）；当前运行 HEAD=7046f21。
- **实施内容（§6.5 ⑥/D9）**：
  - **文件权威**：新 `templates/<key>/tpl.json`（随仓库 git 管理）：含 key/name/description、targetShell、taskProfile（同壳档案结构：key/name/match/modelHint[+readonlyOnly]）、skills（技能引用）、acceptanceTemplate（checks 验收要点 + verifyCmds 样例 + note）、guide（从模板开任务说明）。示例：`small-fix`（低档模型、单技能 task-approach、3 验收点）、`feature-delivery`（高档模型、技能 task-approach+acceptance-builder+self-audit）。
  - 纯函数模块 `server/templates.js`（单测 6 绿）：isTplKeyOk/validateTemplate/listTemplates（目录扫描摘要）/getTemplate/buildLaunchPrompt（开任务指令装配：档案点名+技能载入+验收要点+本次目标）/toProfileFragment。
  - **新接口（§8 增量）**：`GET /api/templates`、`GET /api/templates/:key`、`POST /api/templates/:key/prompt`（开任务指令，审计 template:prompt）、`POST /api/templates/:key/apply`（模板 taskProfile+技能 allow 并入指定壳，同 key 覆盖/异 key 追加；default 保留壳拒装；审计 template:apply）。
  - **前端**：1.6 Agent 广场占位升级为**模板库**（浏览卡片 + 详情（档案/技能/验收/guide）+「装配到该壳」+「生成开任务指令→复制到对话页发送」）。
- **验收（880 真机，exit=0）**：selfcheck **12/12**；模板 E2E **9/9 PASS**：list 含两示例；摘要含档案/技能/验收数；detail 含 guide/acceptanceTemplate；不存在→404；prompt 含档案名+任务目标；apply 到 code 壳→task_profiles 含 feature-delivery 且技能 allow 并入（3 档案 3 技能）；apply default→400；**壳 task_profiles 已还原**（E2E 不残留）。本地单测 43/43（新增 templates 6）。1.6 路由 200、bundle 含模板库。
- **边界**：v1 承载=模板"半成品"（档案+技能引用+验收模板+说明）；**可执行应用形态（独立运行/挂壳/共享）仍按 D9 后置于 M 系列后**；技能为引用（内容在 packs/rw-core/skills，模板不内嵌 SKILL.md 副本——导入模板的技能 allow 后壳会话可 skill_load）；不做商店/审核/分成（§6.5）。

## 附录 D 续：D9 应用形态 v1 实施与验收（2026-09-08）

- **提交（origin/main，已部署 880）**：`014454a`（D9 应用形态 v1：壳内启动式应用=业务单元入口包）；当前运行 HEAD=014454a。
- **实施内容（§6.5/§7.2-1.6/D9，经用户确认形态）**：
  - **形态定界**：可执行应用 v1=**壳内启动式**——应用=一个业务单元入口包（文件权威 `apps/<key>/app.json` 随仓库 git）；"运行"=从 1.6 Agent 广场点「启动应用」→ 目标壳下建会话（title=应用名，可选装配 entryProfile+技能入壳）→ 返回开场草稿 → 前端跳 `/chat?conv=&` 预填输入框（sessionStorage 传递）→ 用户补充目标按 Enter 即在本会话按应用语境工作。**复用现有对话链路，不建第二套会话体系**；无人值守执行（契约 driver 跑到验收）=后续形态。
  - **app.json 结构**：appVersion/key/name/description/targetShell(可空)/persona（开场人格）/entryProfile（同壳档案结构，可装配入目标壳）/skills（技能引用）/acceptance.checks（验收要点）/openingPrompt（引导开场）。示例：`biz-eval`（商业模式评估，非代码域跨壳应用）。
  - 纯函数模块 `server/apps.js`（单测 6 绿）：isAppKeyOk/validateApp/listApps/getApp/buildLaunchDraft（人格+开场+约定+目标合成）/toAppProfileFragment。
  - **新接口**：`GET /api/apps`、`GET /api/apps/:key`、`POST /api/apps/:key/launch`（body {goal?, shellKey?}；targetShell 或 shellKey 启用的非 default 壳→ensureProfileOnShell 装配档案+技能；建会话；返回 {conversationId, shellKey, draft}；审计 app:launch）。**共用 `ensureProfileOnShell`**（templates apply 与应用 launch 共用：同 key 档案覆盖/异 key 追加、技能 allow 去重）。
  - **前端**：1.6 Agent 广场实化为**应用启动页**（浏览应用卡→详情（人格/档案/验收）+目标壳选择+目标输入→🚀 启动→跳对话页草稿预填）；页内折叠区保留模板库（⑥ 半成品）。/chat 支持应用启动草稿经 sessionStorage 预填（autoOpen 后 setInput）。
- **验收（880 真机，exit=0）**：selfcheck **12/12**；D9 E2E **11/11 PASS**：apps list 含 biz-eval；detail 含 persona/entryProfile/acceptance/opening；不存在→404；launch 无壳→返回 convId+draft（draft 含应用人格+开场+目标），会话已建（title=商业模式评估、permission=full、shell=null）；审计 app:launch +1；launch 到 code 壳→会话挂壳且 code task_profiles 含 biz-eval 档案；**壳已还原**（E2E 不残留）。本地单测 49/49（新增 apps 6）。1.6 路由 200、bundle 含 Agent 广场。
- **边界**：应用=壳内启动的会话入口（persona/档案/验收为组成件，随 app.json git 管理）；**独立运行（无人值守自动跑到验收）与"挂入壳内页面/独立 URL"仍为 D9 后续形态**（基础设施=契约 driver/cron 已就绪）；应用间共享=git + 回流（§10），无商店/审核/分成；技能引用语义同模板（packs/rw-core/skills 不内嵌副本）。

## 附录 D 续：全面自检 v1（2026-09-08，4 路独立审计 + 2 批修复）

- **审计报告**（`proposals/_audit/`）：audit-api-contract（API 契约，24 项）、audit-db-schema（DB schema/迁移/查询，24 项）、audit-frontend-ui（前端页面/交互，32 项）、audit-business-semantics（业务语义 vs 方案 v2.16，16 项+冗余/未实现清单）、findings-self（人工交叉核查）、matrix-pages（页面↔数据表闭环矩阵）。
- **修复批1（`925efc9`，P1/P2 为主，已部署）**：
  - **前端**：`/chat?conv=` 直达断链（App path 混入 query 致恒显 Dashboard——M1/D9 核心链路）修复 + mount 初始化 convParam（深链/刷新可用）+ 1.6 板块注入 onGoChat（应用启动跳转生效）；EvoBoard 提案对象渲染修复；ShellDev 切壳 key 重挂载 + 默认模型改读 detail；market 接入跨源串号隔离（selModels 带源前缀）；输入队列按会话隔离（防跨会话误发/删会话清队列/面板隔离展示）；审批横幅"暂不处理"30s 后可再提醒；工具豁免(平台恒开)禁勾关；SettingsBoard 温度滑块加宽+debounce 保存+number 数值归一；Knowledge 文件框 ref 清空（embedded/弹层双形态）。
  - **服务端**：`api.asks` 补封装（断连补答横幅恢复可用）；providers/test 失败 note 透传前端（不再显示"请求失败 200"）；删会话级联补 contract_events、移除幽灵表 bg_tasks；迁移失败记日志（非 Duplicate 类）+ 启动关键列自检；`consecutive_fail_guard=0`(关闭)语义修复（0||3 缺陷）；messages/toolcalls 读接口归属校验；intent/route 审计脱敏（redactSecrets 覆盖非工具类）。
  - 验收：单测 49/49、selfcheck 12/12、修复 E2E 11 项全过（级联/JSON persona/测试连通 note/归属 404/0 值写读/审计脱敏复测）。
- **修复批2（`014609c`，业务语义，已部署）**：
  - **F1 壳 modelPolicy 运行接线**：三级路由"壳默认"补位（无显式且档案未命中时按壳 modelPolicy.defaultProvider/Model 路由）；壳级 budgetYuan 叠加收紧段预算（§8 min(全局,壳上限,会话剩余)）；SSE `route`(shellDefault) 灰字 + `route:shell-default` 审计；壳行一次读取共享（persona/intent/task_profiles/model_policy/tools）。
  - **F2 pack 往返保真**：`shells.pack_extra` 列（幂等迁移）存 DB 无列承载的 pack 扩展字段；import 写入、export/clone 合并还原（tone/forbidden/domainTerms/mcps/connectors/kbImportRefs/defaultsAutoLoad/approvalMode/sensitiveDefaults/channelBindings/credentials/uiBrand/version）；round-trip 单测。
  - 验收：单测 50/50（新增 round-trip）、selfcheck 12/12、修复 E2E 9 项全过（pack_extra 列/往返保真 6 字段/壳默认路由 shell-default 生效且灰字）。
- **数据清理**：历史测试残留孤儿（usage 67/tool_calls 100/messages 8/残留壳 tmpcode+b1dup）已清（=0）。
- **已标注后置（未在本轮接线，见《壳包字段运行接线状态表》草案）**：guardrails 审批策略（当前仅 settings 全局 access_rules 生效）、skills.allow 白名单与 defaultsAutoLoad、tools.presetBase/forceOn 运行时过滤、knowledge.scopes/importRefs、`intent_samples` 沉淀链路、telemetry 按账号隔离（D11）、视图/difficulty 接线；另剩余前端 P3 体验项（空态/加载/冗余组件抽取）列待办。

## 附录 D 续：R1/R2/R5 单一事实源重构（2026-09-08）

- **提交（origin/main，已部署 880）**：`db469f5`（R1/R2/R5 前端双实现重构）；当前运行 HEAD=db469f5。
- **背景**：全面自检审计 R1/R2/R5 指出同一数据在"对话页⚙设置抽屉"与"统一后台 console 板块"存在两套实现且已分叉（能力开关/工具集/规则/提案/高级参数/轨迹渲染）。
- **实施（原则：抽共享组件为单一事实源，两入口引用同一实现，数据组件自管）**：
  - 新 `src/shared/` 五个共享组件：`SettingsPanel`（R2 高级参数：温度/系统提示词/运行护栏/预算/上下文，schema 驱动，blur/debounce 归一保存）、`CapSwitches`（R1 能力开关 A/B/C，groupNames 可选，失败回滚+提示）、`ToolsetEditor`（R1 工具启用集，豁免 defaultOn 恒开不可关）、`RulesEditor`（R1 规则 JSON 编辑——1.4 由只读表升级为同编辑器）、`ProposalsManager`（R1 提案列表/查看/新建）。
  - **对话页**：⚙设置→能力 tab=SettingsPanel+CapSwitches；工具/Rules/提案 tab 分别渲染共享组件；openDrawer 移除重复预载（只保留仍需 Chat 侧状态的 providers/market/trace/tasks/mcp）；删除 Chat 本地重复 state（caps/toolList/rules/proposals/prop*/temperature/sysPrompt/lim*/settingsSchema/sval 等）与 handler（toggleCap/toggleTool/saveRules/viewProposal/submitProposal/setTemp/saveSysPrompt/saveLim/debounce）。
  - **console**：1.4 CapsBoard=组合 CapSwitches+ToolsetEditor+RulesEditor；1.5 EvoBoard 提案区改用 ProposalsManager（保留进化/周报卡与审计表）；1.8 SettingsBoard=SettingsPanel 薄壳。
  - **R5 轨迹**：抽屉"轨迹"tab 复用消息流内 TraceCard（tool_calls DB 行→TraceCard shape 映射，共用中文化/折叠/diff/文件打开），删除抽屉专用第二套内联渲染；补前端 safeJson 兜底。
- **验收**：本地单测 50/50、selfcheck 12/12、build 通过；JS bundle 456→448KB（去重约 8KB）；/console/agent-caps、agent-evo、settings、/chat 路由 200；bundle 含共享组件文案。共享组件数据链路=既有 /api/capabilities|toolset|access-rules|proposals|settings（无新接口）。
- **边界**：仍保留的本地面板（providers 展示/market/tasks 定时/mcp）在 console 无对应板块，非双实现不抽；统一后对话页"高级参数"比原抽屉多展示 schema 中 fake_continue_warn/consecutive_fail_guard/max_concurrent_chats 等键（一致性优先，行为不变）。

## 附录 D 续：终审 v1——今日全部交付（场景/业务/逻辑/数据/交互）审计与修复批 5/5b/6（2026-09-08~09）

- **范围**：对今日交付（B1/B2/B3/④/⑤/M1/M2/⑥/D9/全面自检修复/R1R2R5 重构）做第二遍全面自检——场景完整、业务语义、逻辑一致、数据无孤儿、交互闭环，查冗余/冲突/缺陷。审计报告（`proposals/_audit/`）：final-regression-audit（12 点清单 40/40 呈现核对 + 新发现 A–F）、final-frontend-audit（P1=0、P2=1、P3=9，前端逐项定位）。编号接续首次全面自检批 1–4（925efc9/014609c/67e7a6a/b856edb，见 v2.17/v2.18 回填），本次为批 5 起。
- **修复批 5（`6ca5601`，终审 A–F + P2-1 前端 + P3 前端收尾，已部署）**：
  - **A provider 哨兵归一**：Web 主对话发送 `provider:'auto'`/`model:'__auto__'` 前端哨兵（此前直通服务端被当作"显式选择"，挡住 F1 壳默认/档案路由）——服务端在 body 与会话列两处将 `auto`/`__auto__` 归一为 null=未显式，壳默认（第三级）/档案（第二级）路由对 Web 主对话生效（修复 014609c×67e7a6a 接线冲突）。
  - **C modelPolicy 部分更新保真**：patchShell 对 modelPolicy 做部分更新时读旧行合并，保留旧 budgetYuan/allowModels/qualityCostBias（此前整对象覆盖丢失预算/白名单）。
  - **D 启动关键列自检**补 shells.pack_extra（与 F2 迁移列一致，防旧库缺列运行崩）。
  - **E PATCH /api/conversations 404 口径**：非本人/不存在会话返回 404（原 200 ok:true 与 DELETE 口径不一致，掩盖越权/幻影更新）。
  - **F 删执行中会话先停流**：前端 delConv 先 stopChat+abort 再删，防残留 agent 继续烧 token。
  - **P2-1 提案首部语义还原（前端）**：create 组装 `# 提案：标题\n\n> 状态：待审\n\n`（状态行不带 emoji，防状态正则误捕 `🆕 待审`）；新建后清查看区旧内容。
  - **P3 前端收尾**：共享组件成功清 err + console 无 onToast 也可见成功 msg（P3-1/2）；历史轨迹 args safeJson 与 R5 一致（P3-3）；caps 传 onToast（P3-4）；CapSwitches chips 紧凑模式（P3-5）；EvoBoard err 实捕（P3-7）；SettingsBoard 去重复 note（P3-8）；去嵌套层 + 死 CSS 清理（P3-9）。
  - 验收：单测 50/50、selfcheck 12/12。
- **修复批 5b（`5420ac9`，服务端，已部署）**：提案列表标题解析剥 `提案：` 前缀——create 正文首行 `# 提案：X`，列表应显示纯标题 X（旧实现带冗余前缀，与 fx3 E2E 断言一致；旧 `# 提案：` 文件同步受益）。
  - 验收：fx3 E2E **6/6 PASS**（A1 body auto→壳默认、A2 无 body→壳默认、C 保留 budget/allowModels、E 404、P2-1 标题解析）。
- **修复批 6（`a0dfb90`，孤儿防护，已部署）**：删会话 × agent 收尾竞态——SSE 断连后 agent 若已完成计算、收尾落库（assistant/telemetry）与客户端"删会话"并发时，先删后写产生孤儿（实测孤儿 telemetry 指向已删会话 conv375/376/377）。修复：DELETE /api/conversations/:id 先 abort 该会话 inflight agent 再删；先删 conversations 行（存在校验即刻关门）后清子表；telemetry/assistant/error 占位落库改**原子 `INSERT…SELECT … WHERE EXISTS(会话)`**（会话已删则假→不插），stopped 占位加 convAlive 预检。
  - 验收：孤儿清理后全绿重跑——e2e-final **18/18 PASS**（含"无孤儿残留"t=0/rv=0/k=0/c=0）、selfcheck 12/12、单测 50/50；fx3 6/6 复测仍全过。
- **终审基线**：本地=origin/main=`a0dfb90`，服务器 880 运行同 HEAD（bundle 部署 + `git push origin main`）；无残留测试孤儿。

## 附录 D 续：设置入口退役——后台=唯一设置中心（2026-09-09，`f831a41` 已部署）

- **用户验收反馈**：对话页左下角 ⚙ 设置入口仍打开老版抽屉，未呈现今日改善；其九 tab（能力/厂商/模型市场/工具/规则/提案/MCP/轨迹/定时）与「🎛 后台」功能高度重合。结论：有了后台就不需从对话页进设置——**后台即 RW 设置中心**。
- **去冗余原则（零回归约束）**：仅收敛入口，不动任何服务端接口/会话数据/对话能力；能力/工具/规则/提案在抽屉中本就是后台 1.4/1.5 同一共享组件（R1 已统一）→ 直接退役无迁移成本；厂商展示后台 1.1 有更强版（key 测试+模型启停+市场）→ 覆盖。
- **缺口补齐（抽屉独有、后台原无的能力先迁入后台再退役）**：
  - **1.1 模型广场**：市场区由"只读快照"升级为可操作——🔄 刷新市场 + 按源勾选模型 + 接入（迁移抽屉"模型市场"的 loadMarket/refreshMarket/connectMarket 全逻辑与跨源前缀隔离勾选）；厂商模型行保留 key 测试/启停。
  - **1.8 设置**（原 SettingsPanel 薄壳扩展为系统组三区）：高级参数（SettingsPanel）+ **MCP 管理**（JSON 配置/保存并重连/连接状态，迁移抽屉 mcp）+ **定时任务管理**（列表/新建/启停/删除，迁移抽屉 tasks；进化载体 #3/#4 亦在此管理）。
- **对话页收敛**：Chat.jsx 移除 ⚙ 设置按钮与 9-tab 抽屉全部 JSX/state/handlers（drawer/drawerTab/mcpText/mcpStatus/market/marketBusy/selModels/tasks/newTask/toolcalls 轨迹平铺等），减 ~340 行；**对话会话能力零改动**——模型栏/权限/预设/导出/知识面板(📚)/消息内轨迹 TracePanel/灰字意图路由/审批问询/队列 全部保留。
- **指路同步**：Dashboard「日报/周报」与「待加入新模型」卡片 foot 由「设置→…」改指「🎛 后台 → 1.8 设置 / 1.1 模型广场」并加直达按钮；共享组件头注释同步为后台消费方。
- **验收**：单测 50/50、selfcheck 12/12、build 通过（JS 448.9→444.9KB，净删冗余）；e2e-final **18/18**（孤儿 0）、fx3 6/6 复测全过；/chat、/console/settings、/console/models-plaza 路由 200 且 bundle 含新板块文案。
- **基线**：本地=origin/main=`f831a41`，服务器 880 运行同 HEAD（bundle 部署 + `git push origin main`）。

## 附录 D 续：Excel 收发能力恢复 + 输入区/后台/知识库 UI 优化（2026-09-09，`cc95ffdb`/`5f3ad88` 已部署）

- **事件与根因**：用户发现昨日会话393 验收的 Excel 收发能力（上传/下载/解析）在今日更新后消失。调查：该能力由会话393 在**服务器本地**提交 `44ea11da`（/api/download 端点 + FileAttach 上传）+ `658e8b68`（Chat FileLink 下载卡片）实现，**只存在于服务器仓库、从未合入共享 origin/main**；今日部署流程"本地 commit → bundle → 服务器 git reset --hard + push origin/main"将其移出历史（对象仍在服务器对象库，git reflog 可证 `44ea11da HEAD@{8}`/`658e8b68 HEAD@{7}`）。
- **恢复（`cc95ffdb`，零冲突）**：从服务器对象库取回两提交 → 相对服务器当前基线 `e029556a` 干净 cherry-pick（期间另一会话仅改 server/scheduler.js，与恢复文件无交集）→ 服务器 rebuild → push origin/main → 本地 reset 对齐。恢复内容：① server `/api/download/:name` 鉴权下载（requireAuth + basename 防穿越 + res.download）；② `src/FileAttach.jsx` 输入区附件上传（点击/拖拽 → /api/upload → 路径回填输入框，导出 uploadToServer 供整窗复用）；③ Chat 消息内 `/api/download/` 链接 → FileLink 下载卡片（按扩展名着色图标 XLSX 绿/PDF 红/DOC 蓝等，点击 fetch 带 Bearer → blob 下载，裸 `<a>` 会 401）；④ 整窗拖拽上传遮罩。**Excel 解析/生成侧从未丢失**（extract_xlsx 工具、/srv/rw-workspace 下 gen_sku_formatted.js/gen_interrupt_review.js、exceljs 依赖、uploads 原件均在）。
- **验收**：e2e-recover **5/5 PASS**（upload→download round-trip / 401 / 目录穿越 / 中文文件名 xlsx）；单测 50/50、selfcheck 12/12。
- **输入区 UI（随恢复合入，用户反馈）**：执行中"发送"不再变"加入队列"文案——一律显示"发送（排队）"由 send() busy 自动入队；附件按钮从"对话左下独立占位"改入**输入区工具条**（文本框内：附件/上传状态提示/停止/发送同一行），整窗拖拽保留。
- **后台 1.8 设置样式（`5f3ad88`）**：用户反馈"单元格又矮又长"——SettingsPanel 由竖排窄行（标签在上输入在下）改为**两列卡片网格**（rw-set-grid/rw-set-card：标签与输入同行、hint 常显撑高、span2 卡放温度/系统提示词）；MCP/定时任务区沿用卡片分组。
- **知识库 1.7 取长补短（`5f3ad88`，对照 885 工作台 harness-hello 知识库）**：885 形态=项目文档库（md 文档按主题分类：需求/设计/架构/错题本/skill 清单/验收总结，暖色卡片网格+类型 Tab+范围标签）；880 为 DB 条目库（上传 xlsx/csv/txt/md/json 解析入库）。本轮借鉴视觉与组织：上传区改工具条（归属/壳/文件/表头/导入一行）；条目改图标卡片（扩展名着色字母 XLSX 绿等 + 范围色标 + 正文预览两行截断 + hover 抬升）；空态给引导文案。**不改变存储模型与检索链路**（F19/kb_search 语义不动）。
- **回归**：全量绿——e2e-final 18/18（孤儿 0）、e2e-recover 5/5、fx3 6/6、selfcheck 12/12、单测 50/50；/chat 与后台各板块路由 200。
- **基线**：本地=origin/main=`5f3ad88`，服务器 880 运行同 HEAD；无残留孤儿。
- **待用户确认的方向**：① 知识库"该放什么"的范围（见上一条答复的 RW 全局知识库建议）；② 是否引入 885 式**文档型条目**（含 kind 分类/skill/文档并存）作为知识库的 v2 形态；③ 885 的"按项目/实例隔离"是否适用于 880 多壳体系。

## 附录 D 续：防重机制 + 知识库文档型 kind 升级（2026-09-09，用户全确认，`7831f1a`/`9fb9672` 已部署）

- **背景**：Excel 恢复事件复盘后，用户确认执行"防重机制四条 + 知识库文档型升级"。隔离问题（是否按壳/全局）用户明示暂不引入新权限面——**维持三 scope(global/shell/conv)，不给 RW 加锁**。
- **防重机制（孤儿/覆盖防护，根源=git_commit 只提交不推送 + 部署 hard-reset 不检查未推送提交）**：
  - **git_commit 工具自动 push 收尾**（server/tools/index.js）：commit 成功后自动 `git push origin <当前分支>`；push 失败**不撤销本地 commit**，仅在返回提示"⚠️ 提交成功但未推送…部署前先解决"。消除"对话里让 RW 开发=只落服务器本地"的盲区。
  - **scripts/guard-deploy.sh 安全部署**：部署前置检查 ①未推送本地提交（`origin/main..HEAD` 非空→中止提示先处理）②工作树干净 ③bundle 目标可 **fast-forward 才 reset**（分叉→中止人工合并，禁无脑 hard-reset）→ 最后 push。
  - **scripts/orphan-scan.sh**：未推送提交 / `git fsck --unreachable` / reflog 三路扫描，防"被 reset 剥离但仍有价值"的提交永久丢失。
- **知识库文档型 kind 升级（只加表达维度、不加隔离面、不改检索语义）**：
  - DB：knowledge 加 `kind VARCHAR(12) DEFAULT 'fact'`（幂等迁移 + 启动关键列自检）；存量行默认 fact，旧行为不变。
  - kind 五类：fact 运行事实（默认）/ progress 进化进度 / guide 平台规范 / skill 技能 / lesson 错题本（对齐 885 的文档/技能/错题分类思想）。
  - 服务端：`/api/knowledge/import` 可带 kind、list 可 `?kind=` 过滤、管理审计带 kind；`kb_add` 工具可带 kind（同 title 判重按 kind 分条）；**F19 注入与 kb_search 检索不按 kind 过滤**（会话可见语义=global+壳+本会话 conv 三 scope 原样）。
  - 前端 1.7/📚 面板：上传工具条加"分类"选择；列表加 **kind Tab 分组**（全部+五类，带计数，像 885）；条目图标/标签按 kind 着色；空态引导文案。
- **验收**：单测 50/50、selfcheck 12/12、e2e-final **21/21**（新增 13b1 import kind=skill / 13b2 缺省 fact / 13b3 list?kind 过滤 三连）、fx3 6/6、e2e-recover 5/5；/chat、/console/kb、/console/settings 路由 200。
- **基线**：本地=origin/main=`9fb9672`，服务器 880 运行同 HEAD；无残留孤儿。

## 附录 D 续：Agent 能力页真实性修正 + 后台导航重分组（2026-09-09 用户定，`8a877ee` 已部署）

- **背景**：用户指出 1.4 Agent 能力页 A/B/C 三组"能力开关"是**虚假展示**——查证属实：`/api/capabilities`(账号表)只存 DB，服务端渲染/工具/平台三处均无任何代码消费（A 组渲染开关不影响前端 ReactMarkdown；B 组不影响工具；C 组不影响平台）；真实可配面一直是**工具启用集(/api/toolset)**（模型 schema 裁剪 + hooks enabled_tools_guard 双门禁）。
- **修正（干净删除，不留垃圾）**：
  - 移除 `/api/capabilities` GET/PUT、A/B/C 三组常量与 `CapSwitches.jsx`；capabilities 账号表 `DROP TABLE` 迁移清理（models.capabilities 模型能力 JSON 是另一回事，保留）。
  - **工具启用集人读化**：`/api/toolset` 遍历实际注册 TOOLS（63 项）附 中文名(TOOL_CN)/分级 tier/用途 when/勿用 not/示例 ex/权限；ToolsetEditor 重写——中文行 + 悬停说明 + 恒开(平台豁免不可关)/默认建议(可取消)/已启用/未启用标签 + 按 core/pro/expert 分组 + 全选/清空 + 已启用计数；**修正旧语义 bug：defaultOn(默认启用) 曾当"豁免禁改"，实际仅 PLATFORM_EXEMPT 恒开、默认工具可取消**。
  - 残留清理：agent 环境提示"关键表"改列 knowledge；index.js 头注释；Dashboard/ModelPlaza 可见文案由旧编号改新分组名。
- **后台导航重分组（用户定：平台 / Agent / 应用市场）**：平台=模型广场/模型观测/知识库/设置；Agent=能力/进化；应用市场=壳开发/应用 + 插件占位（建设中说明：壳外研发→壳勾选装配→删除整体卸载范式）。板块 code 不变（URL/回退兼容），仅 group/label。
- **验收**：单测 50/50、selfcheck 12/12、e2e-capfix **5/5**（capabilities 404 / 表已 DROP / toolset 63 项中文 / 豁免恒开 / 8 导航路由）、e2e-final 20/20、fx3、recover 全过。
- **基线**：本地=origin/main=`c1c449e`，服务器 880 运行同 HEAD；无残留孤儿。








