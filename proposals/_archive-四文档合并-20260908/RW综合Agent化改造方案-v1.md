# 提案：把 Roni Workbench 升级为「综合 Agent 平台」——多厂商多模型 × 按任务能力自动分派（开发 / 视频 / 商业模式…）

> 状态：🆕 待审
> 提交：2026-09-07 · 作者：RW（880 TEST 环境盘点 + 桌面分析）
> 分支建议：proposals/rw-agent-hub
> 参照：智谱 BigModel 模型中心（open.bigmodel.cn/console/modelcenter/square）四大区块——**模型广场 / 模型测评 / 知识库 / 应用空间**；以及 OpenRouter、Coze、百炼等综合 Agent 平台形态。
> 本文档为优化方向提案（蓝图级，P 池新增候选），不直接改码。落地需逐阶段走 C5 审查 + 880 E2E。
>
> 📎 关联讨论文档（2026-09-07 起，状态 🟡 讨论中）：「壳-核分层总体架构」三件套见 `proposals/壳核分层总体架构-需求文档-v0.1.md` / `-技术方案-v0.1.md` / `-测试用例-v0.1.md`（D1=方案 D 先 D 后 A、D2=885 即 code.ronisyn.com 已拍板，其余决策点见需求文档 §5）。

---

## 0. 一句话结论

RW 当前是一座**机制极其完整、但入口仍是"单会话聊天"的通用 Agent 引擎**：10 家厂商网关、63 工具、契约驱动器、技能/知识/记忆、权限审批审计、发行物调教包都已就绪；缺的是**把"模型能力 × 任务类型 × 工具链"结构化并自动匹配的那一层**，以及让用户"从任务出发"而不是"从对话出发"的入口（模型广场式目录、模型测评、知识库 2.0、任务/技能广场）。

本方案建议新增 4 个平台层能力（能力卡与任务档案数据模型、任务画像路由器、知识库 2.0、模型测评间与任务广场 UI），把 RW 从"聊天+能干活的 agent"升级为"**自托管综合 Agent 平台**"：用户下达"做一个商业模式分析 / 剪一段视频 / 修这个 bug"，平台自动选定最合适的厂商模型与工具链、按任务域模板执行、过程可观测、成本可控、结论可测评可沉淀。

---

## 1. 现状盘点：RW 是什么、已经有什么

（依据：2026-09-07 对 880=TEST 环境对应代码库 server/ src/ docs/ packs/ 的只读盘点；证据均带 文件:行号。）

### 1.1 定位与业务
- 自托管 AI 智能体 Web 平台：Express+MySQL+React/Vite，单管理员+邀请码（server/auth.js），太阳大地色对话界面（src/styles.css:2-14）。
- 三环境：DEV 本机 :3000 / TEST 服务器 :880（rw_test 库，当前 .env 指向）/ PROD 域名 443（README.md:5-12）。
- 价值主张（docs/archive/roni-workbench-需求规格-v1.0.md §一）：把"能对话、能切模型、能动手干活、能挂技能"做成**自己服务器上随时可用的 Web 应用**；Agent 在服务器真实读写文件/跑命令（默认 full）。
- 已形成治理体系：平台开发蓝图（docs/平台开发全集清单-v1.md，A-N 14 能力域 + O 台账 31 + P 决策池 26 + C 共识 7）、行为准则/信任契约/工具契约 62 条、每日 05:00 无人值守自我进化（docs/archive/daily-evolve-log.md）、KPI 周报、880 实测指南 32 步。

### 1.2 已实现的能力基线（"能干什么"）
- **多厂商多模型**：server/llm/providers.js 内置 10 家全 OpenAI 兼容厂商（DeepSeek/智谱 GLM/豆包 ark/Kimi/通义/腾讯 TokenHub/百度千帆/MiniMax/硅基流动/OpenRouter），每家带 defaultModel/capabilities/chatModels；.env 现配 9 个 Key（缺 OpenRouter）→ 9 家 active；启动同步约 54 个模型入 models 表（providers.js:77-90）。
- **统一网关**：chatOnce/chatStream/chatOnceWithTools/chatStreamWithTools（P20 流式工具调用、首字节+空闲双看门狗、外部 AbortSignal 贯穿、思考增量透出、三档真实计费 calcCost，llm/gateway.js）。
- **模型市场雏形**：4 聚合源（OpenRouter/硅基流动/TokenHub/百炼）快照入库 + 每日刷新 + 勾选接入（llm/market.js）；能力仅按域名粗判单标签 domainToCap（:105-112）。
- **Agent 执行循环**（server/agent.js runAgent）：意图挡位 → 护栏（时间/轮次/循环/成本四类，5s 缓存、可调可关）→ 运行时快照注入（轮次/钱包/rev）→ 语义折叠/压缩 → 流式工具调用 + 计量 → 服务端强制行为检测（假完成/假开始/循环/连续失败）→ checkpoint 断点 → 子代理编排（8 并发/3 层嵌套/fanout/fork/ralph）。
- **工具 63 个**（server/tools/index.js）：文件族/Git/命令与后台任务/联网/文档解析 pdf·docx·xlsx·pptx/OCR·视觉/数据库/规划·目标/子代理 8 件/知识 kb×3/飞书×3/技能×3/契约×2/平台管理×4；core/pro/expert 三级 + preset 三档 + 默认启用 28 + 4 项平台豁免。
- **安全与治理**：权限四档 read/write/full/guard、hooks 纪律层（危险命令/系统写入 fail-closed 守卫、access_rules、只读意图门禁）、guard 审批卡（7 高危工具、5 分钟超时）、写前自动 checkpoint/undo、占位符检疫、密钥脱敏留痕；无 OS 级沙箱（full=整台服务器）。
- **任务体系**：goals 目标系统、plan_tasks 计划、scheduled_tasks 定时任务（并发≤2）、**task_contracts 外部驱动器**（driver.js：无人值守白天立项→到点驱动 runAgent→finish_task→验收 DSL 自动核验 cmd/file-exists/grep/node/kpi→candidate_done→用户复测确认）、agent_runs 断点恢复现场。
- **记忆/知识/技能**：四层记忆架构（docs/记忆架构.md）；knowledge 表 kb_add/search/del（scope=conv/global，标题+正文关键词，Jaccard 防误覆盖）；技能系统 5 个 SKILL.md（task-approach/explore-discipline/self-audit/subagent-prompt/acceptance-builder），skill_load 全文入会话跨轮生效、conv_skills 持久化、packs/rw-core 随仓库版本化 + apply-pack.mjs 一键展开（发行物/调教包设计见 docs/RW发行物与调教包设计-v1.md）。
- **MCP 客户端**（server/mcp.js）：stdio JSON-RPC、配置 settings mcp_servers、动态注册 mcp_<id>_<tool>、看门狗 60s 重连、P24 后并入 execTool 统一权限/审批/审计；已接 GitHub 1 个（26 工具）。
- **外部渠道**：微信（ilink 轮询）与飞书 webhook 入站问答（收→Agent→回文本），双向但仅文本、硬编码 deepseek-v4-flash。
- **数据底座**（server/db.js，23 表）：accounts/sessions/invites、conversations/messages(+reasoning/model/tokens)、conv_summaries、providers/models(capabilities JSON)/market_snapshot、usage_stats（三档 cache hit/miss/out + kind=request/round/title/summary + cost）、tool_calls、audit_log、price_table（建表未用）、settings、scheduled_tasks、goals、agent_runs、task_contracts(+events)、knowledge、conv_skills、long_jobs、capabilities（账号级平台开关）。用量视图 docs/sql/usage_views.sql（v_usage_daily/by_round/by_conversation）。

### 1.3 交互形态（"用户怎么用"）
- 单页无路由：登录（Login.jsx）↔ 主界面 Chat.jsx（1231 行）：左栏会话列表 + 中央对话流，无右侧栏（src/App.jsx:36-38）。
- 顶栏：会话权限下拉（只读/读写/完全/需审批）+ 工具预设下拉（全量/标准/精简）+ 导出（Ctrl+E）。
- 会话级模型选择：厂商（含"自动路由"）→ 模型，切换即 PATCH 持久化、跟会话走（Chat.jsx:216-234）。
- 轨迹直播：思考折叠区 / 工具卡（中文名、路径摘要、耗时、diff 着色、失败红标、📂 文件内联预览）/ 计划卡 / 审批卡 / 问询卡（api.js:63-102 SSE 事件：delta/thinking/think/tool_start/tool_done/plan/approval/ask/done/error）。
- "设置"= 全屏覆盖页 9 标签：能力 / 厂商 / 模型市场 / 工具 / 规则 / 提案 / MCP / 轨迹 / 定时（Chat.jsx:908-916）。
- 输入：多行 textarea + 停止生成 + 草稿按会话隔离 + 执行中输入自动排队（单条前台队列）。
- 无：任务看板、会话归档/搜索、文件上传 UI（api.upload 无调用方）、技能选择 UI、模型"能力徽标"、任务模板入口。

### 1.4 演进史与当前健康度
- 里程碑：hello 项目合并基线 → 撑竿跳 L1（WS0-WS9 全绿）→ 蓝图 v2.10（P20-P26 已实施回填）→ 22 项平台能力 E2E → v0.2-platform-layer tag。自审口径：服务端无差距，剩余为"待人工 UI/渠道验收"。
- 健康：selfcheck 12/12；回归测试 11/11（node:test）；最近 24h 用量成本收敛（09-06 日志 ¥55/633 次、缓存命中 7.7% 回升）；已知遗留：流式改造批 6 未定案、880 全量走查与微信/飞书真机待人工、audit 少数 🔍 项。

### 1.5 与优化方向相关的现状缺口（详见 §2）

---

## 2. 差距分析：距离「综合 Agent」还差什么

### G1 模型能力元数据"存而不读"，路由只分视觉/非视觉
- providers.capabilities 是**厂商级粗标签**（chat/code/reasoning/tool/image/vision/video/ocr），随 syncChatModels 存入 models.capabilities JSON，但**任何路由都不读它**（llm 层盘点 §7）。
- auto 路由 = 关键词正则 VISION_RE 命中→ark 豆包，否则→deepseek-v4-flash（server/index.js:345-374），与能力元数据零关联；模型级信息（上下文窗口/函数调用质量/价格档/是否流式工具/思考型）无处表达。
- 渠道与定时任务硬编码 deepseek-v4-flash（channels/wechat.js:67、feishu-webhook.js:94），不看会话已存 provider/model、无渠道级配置。
- price_table 建表无任何读写；成本走 gateway.js 硬编码 PRICE（10 家缺 openrouter），市场接入模型也套估档——**无法回答"这个任务用哪个模型最划算"**。

### G2 无"任务域"抽象：模型选择与任务类型脱钩
- 蓝图 P7 明确"不做自动分类路由"（docs/平台开发全集清单-v1.md:219、:109 注"未显式选择时才自动分类"——即成熟 CLI 参照是会分类的，RW 暂缓）。
- P14 "任务=对话模型"挂起（:226）。
- 无任务模板库：acceptance-builder 只有 web/代码/文档/配置 4 类验收骨架，无"开发任务/视频任务/商业模式任务"整套模板（步骤+验收 DSL+工具链+默认模型策略）。
- 工具启用集是全局预设（meta.js DEFAULT_TOOLSET + preset 三档），无**域级工具链绑定**（做视频不该出现 git push？做商业模式不该出现 run_command？——应可配置）。
- 无域技能包：packs 只有 rw-core（5 技能）；RW发行物-v1 §4 设想过 code/media/book 各工作台自治 + 域状态机示例（todo→方案→用例→编码→自测→复测 / 选题→脚本→分镜→素材→剪辑包→发布 / 大纲→…→终稿），但那是"每实例自治"，**非平台级"一实例多域"**。

### G3 知识库停留在关键词表，无文档级 RAG
- knowledge 表 = title+body 关键词检索（kb_search），无切片/向量/重排；用户上传 pdf/docx/xlsx 只能靠 Agent 手动 extract_* 后写 kb。
- 蓝图 P12 语义检索已否决（v2.5 :9）——需决策是否以"可选 embedding 供应商"方式重启（成本/隐私可控）。
- 前端无上传 UI，无法"拖一个 PPT 进知识库"。

### G4 无模型测评：选模型靠直觉，无同任务对比
- usage_stats/tool_calls/agent_runs 已积累大量"真实任务回放"素材，但无 A/B 界面：同 prompt 双模型跑、结果并排、打点成本/首字延迟/打回率。
- KPI1 打回率（kpi.mjs）是现成质量信号，可反向喂给模型画像。

### G5 无"应用/任务广场"发布形态
- 调教包 packs/rw-core 是"给实例的初始化资产"，不是"可浏览、可一键进入、可复制改造的任务入口"。
- 用户每次要用 RW 做"商业模式分析"，都要从空白对话开始，自己描述上下文/约束/格式——**没有从任务出发的模板化开工**。
- 技能/知识不跨实例同步（RW发行物-v1 §6 明示边界）——若做"一实例多域"，需要域技能/域知识在同一实例内按 project 隔离（有雏形：conversations.project + AGENTS.md 注入）。

### G6 前端与交互的结构性缺口
- 单会话线性 + 页面级单 busy + 全局队列打在"当前会话"（Chat.jsx:143-153,486-505）：并行任务只能靠轮询旁观。
- 无任务视图/运行历史/失败重跑；定时任务只有 cron 清单。
- 断连恢复横幅是死路径：api.asks 未导出却于 Chat.jsx:323 被调用（try/catch 吞错）。
- 模型下拉无能力徽标；能力 A/B/C 开关是平台全局项，与模型画像无关；死代码死样式并存（.rw-side-model 等）。

---

## 3. 参照：智谱 BigModel 模型中心四区块 → RW 落点

用户点名参照 open.bigmodel.cn/console/modelcenter/square 的四大区块。控制台 UI 需登录（未能直接逐屏核验），以下映射基于官方文档与官方发布稿。**四个区块本质是一条用户决策链：「看模型 → 选模型 → 备知识 → 做应用」——这第一性结构正是 RW 新导航可抄的骨架。**

官方依据：智谱平台介绍 [智谱AI开放文档](https://docs.bigmodel.cn/cn/guide/start/introduction)、模型详情页示例 [GLM-5 模型页](https://docs.bigmodel.cn/cn/guide/models/text/glm-5)、模型评测专篇 [评测工具文档](https://docs.bigmodel.cn/cn/guide/tools/evaluation) 与 [最佳实践-模型评估](https://docs.bigmodel.cn/cn/best-practice/prompt/modelevaluation)、知识库手册 [指南](https://docs.bigmodel.cn/cn/guide/tools/knowledge/guide) / [FAQ](https://docs.bigmodel.cn/cn/faq/knowledge-base) / [对话调用知识库（RAG）](https://docs.bigmodel.cn/cn/guide/tools/knowledge/retrieval)、智能体开发平台 [官方文档](https://docs.bigmodel.cn/cn/guide/platform/intelligent-agent)、Agents「应用空间 + 开拓者计划」发布 [官方公众号](https://mp.weixin.qq.com/s/h-rOdWC-lRZF5Fft11vb9A) / [媒体稿](https://www.guandian.cn/article/20250702/495339.html)。

### 3.1 模型广场（可浏览、可筛选、一键接入的模型目录）
- 平台提供：全系模型目录化展示，每模型独立详情页（能力/规格/价格/上下文），取 Key→按 endpoint/SDK 接入。
- RW 已有雏形：market.js 4 源快照 + 勾选接入 + providers/models 表。**升级点**：把"模型目录页"从运维抽屉（设置→模型市场）升级为一级页面——每模型一张**能力卡**（上下文窗口/模态/function calling/推理档/价格三档/实测质量信号），支持按任务意图筛选（"能写代码的便宜模型""能看图的模型"），一键进入该模型对话。

### 3.2 模型测评（同任务比一比）
- 平台提供：官方有"模型评测/评估工具"文档与方法论；但**竞技场式 A/B 盲测主要在第三方榜单**（Compass Arena、LMArena 式评测），控制台内是否自带同类 UI 未能验证。
- 对 RW 的启示：**不自建竞技场**（成本高、样本少无意义），引用公开榜单 + 做"任务回放式内置 A/B"：用户给一个任务（或选历史会话回放），平台用 2-N 个模型同 prompt 各跑一轮（子代理隔离），并排输出 + 差异高亮 + 成本/首字延迟/轮次/工具成功率（复用 usage_stats/tool_calls），用户打分后沉淀进模型能力卡与 default_models 建议。

### 3.3 知识库（文档进、问答出）
- 平台提供：建库/导入/管理 → 切片 → 检索（RAG）→ 与对话/应用绑定，官方有完整手册。
- RW 升级点：**知识库 2.0**——把"文件拖入→extract_*（现成）→切片→embedding（经网关可选供应商）→MySQL/向量检索→注入 kb 检索"做成产品链路，scope 从 conv/global 扩到 project（任务域），并让 kb 结果可溯源（引用原文段落）。

### 3.4 应用空间（从任务出发的 Agent 应用）
- 平台提供：智能体开发平台（模型+提示词+工具+知识库绑定成应用），2025-07 上线"应用空间 + Agents 开拓者计划"实现发布共享与商业化。
- RW 升级点：**任务/技能广场**——把"任务模板（task profile）+ 域技能 + 知识库绑定 + 默认模型策略"打包成可浏览、可一键进入、可复制改造的条目；用户首页从"任务广场选任务"开始而不是空白对话（开发/视频/商业模式/写作/研究首批 5-8 类）。共享发布=导出/导入模板文件（对应 RW 发行物机制，从"初始化资产"升级为"任务资产市场"；SaaS 商店的审核/支付/分成是重资产，自托管 v1 不做）。

### 业界补充参照（供设计取舍）
- **OpenRouter**：统一 API + 请求级多模型路由 + 自动故障转移；其 **Auto Router 的"质量 vs 成本 0-10 偏好滑杆"** 是"按需选模型"最值得抄的交互（[Auto Router 文档](https://openrouter.ai/docs/guides/routing/routers/auto-router)、[模型路由原理](https://openrouter.ai/blog/insights/model-routing/)）——RW 的 task_profile.router_rule 即其自托管版。
- **字节 Coze / 阿里百炼 / 腾讯元器**：工作流画布 + 插件/知识库 + Skill/Bot 商店 + 推荐模板（百炼"应用推荐模板"按场景组织、支持分享发布）——共同验证"**从任务/模板出发**"是综合 Agent 平台标配（[百炼应用类型](https://www.alibabacloud.com/help/zh/model-studio/application-introduction)、[推荐模板](https://help.aliyun.com/zh/model-studio/agent-template)）；RW 只借鉴"任务资产包"模式，不做画布重引擎与多租户。
- **Poe / Claude Skills / GPTs**：订阅聚合 + 创作者分成（[Poe 创作者 FAQ](https://help.poe.com/hc/zh-cn/articles/21921312368020)）、Skills 把任务打包为可分享单元、GPTs 职业模板库按"我要做什么"组织——用词各异（GPTs/Store、Skills、Skill 商店、Bot、模板），**本质都是"提示词+工具+知识库引用+触发场景"的可分享任务包**，本方案的 task_profile 对齐该本质，命名沿用 RW 自己的"任务"。
- **成熟 CLI（Codex/Claude Code）**：RW 蓝图的长期参照（docs/Codex与主流CLI-机制借鉴清单-v1.md）——其"未显式选择时才自动分类"语义即为本方案路由器的"第三级默认"。
- **结论（抄/避）**：抄=目录化模型广场、偏好式路由+failover、任务模板第一导航、一体化知识库入口、轻量模板包分发、选型引用公开榜单+内置任务回放 A/B；避=封闭 MaaS 生态复制（RW 走 BYOK 多厂商 Key+成本透明）、SaaS 商店重资产、自建盲测竞技场、纯编排框架当首页。

---

## 4. 目标架构与核心设计

### 4.1 目标形态
> RW = 自托管的**综合 Agent 平台**：一个实例内承载多个**任务域**（开发/视频/商业模式/…），每个域有自己的 能力画像路由、任务模板、工具链白名单、技能与知识库；用户以"任务"为单位发起、跟踪、验收、沉淀；平台按任务域+成本+质量自动选择厂商模型，且显式选择始终绝对优先（C4）。

在既有"会话→Agent→工具→契约"执行链**不变**的前提下，新增四块（都在现有接缝上生长，不推翻现有架构）：

### 4.2 数据模型新增/演进（全部幂等迁移，延续 db.js MIGRATIONS 风格）
```
model_profiles（模型能力卡，替代 models.capabilities 的粗标签）
  id, provider_id, model_id（FK 语义=providers+models 唯一）
  context_window INT, max_output INT
  modal JSON            -- ['chat','tool','vision','image','video','audio','ocr','embedding']
  fn_calling TINYINT, streaming_tools TINYINT, thinking TINYINT
  quality JSON          -- 任务质量分（开发/写作/分析/… 1-5，人工或测评回填）
  price JSON            -- {hit,miss,out} 元/百万（读 price_table 或自动拉取）
  latency_ms INT, notes VARCHAR(500)
  唯一键 (provider_id, model_id)

task_profiles（任务档案=应用空间的"应用"本体）
  id, key VARCHAR(64) 唯一          -- 'dev-feature','video-short','biz-model','research','write-doc',…
  name, description, icon
  domain VARCHAR(32)                -- project 绑定用
  intent_sample TEXT                -- 意图示例（训练/校准用）
  router_rule JSON                  -- 模型策略：{primary:{provider,model}|auto, budget_hint:'cheap'|'quality', min_caps:['code'], forbid:['video']}
  toolset_override JSON             -- 域工具链（null=跟随 preset；可显式增删）
  skill_refs JSON                   -- 开工自动载入技能（如 dev→task-approach+acceptance-builder）
  kb_scopes JSON                    -- 默认知识库范围 ['global', project:<domain>]
  template_prompt TEXT              -- 任务模板提示词（含交付格式/自检项，可 {{变量}}）
  acceptance_template TEXT          -- 验收 DSL 骨架
  enabled TINYINT, created_at/updated_at

eval_runs（模型测评间）
  id, account_id, task_text TEXT, provider_model JSON（参与对比的 p:m 列表）
  status, results JSON（每模型：content/tool_calls/usage/耗时/评分）, winner VARCHAR(128)
  created_at

kb_docs + kb_chunks（知识库 2.0；kb 表保留）
  kb_docs: id, account_id, scope('conv'|'global'|'project'), project, title, src_file, created_at
  kb_chunks: id, doc_id, seq, text MEDIUMTEXT, embed JSON(可选) , KEY 检索
```
说明：embedding 存储先落 MySQL 自有列（浮点数组 JSON 或 blob），向量检索 MVP 用余弦暴力扫描（自托管千级 chunk 内足够），不引入新中间件；P12 否决项以"可选供应商 embedding"口径提请决策（见 §5 P0）。

### 4.3 能力分层：模型画像路由器（resolver）
三级决议，替代 VISION_RE 一维 auto：
1. **显式**：会话/渠道/任务显式指定 provider/model → C4 绝对锁，绝不覆盖、失败报原文（沿用现状）。
2. **会话默认**：settings default_models / 会话上次选择（沿用现状）。
3. **任务画像（新增）**：意图识别层把用户请求归入 task_profile（或"未归类"→沿用旧 auto）。
   - 意图识别：先关键词/样本正则（低成本、可离线回归），未命中且需要时再走一次"轻量 LLM 分类调用"（max_tokens≈50，kind=intent 入账）——替换 TOOL_INTENT_RE 单向白名单的静默漏判（历史"假开始"根因之一，见 诊断报告-三问题根因）。
   - 路由规则：task_profiles.router_rule（min_caps 硬约束过滤 → 按 budget_hint/quality 排序可用模型 → 成本与质量权衡默认取"够用最便宜"；profile 可选携带**质量-成本偏好 0-10**（OpenRouter Auto Router 同款交互，见 §3）→ 生成候选排序），并**把选择理由写进运行时快照**（"本任务画像=商业模式分析→GLM-5.3，理由:长文推理+便宜；如需换模型请显式选择"）。
   - 渠道/定时/契约执行也走 resolver（消灭 deepseek-v4-flash 硬编码）。

### 4.4 任务执行：域模板 × 契约驱动器增强
- 新建"任务化会话"有两种方式：从任务广场选模板开任务（推荐）或在对话中说"按 XX 任务做"，Agent 匹配 task_profile 后自动：载入域技能 → 注入模板提示词 → 建 plan → 按域工具链执行 → 用 acceptance_template 生成验收 → finish_task → 复盘沉淀。
- driver.js 契约行增加 task_profile_id 列（或复用 goal 描述内嵌），无人值守执行时按画像取模型与工具链——现有 runAgent/验收 DSL 零改动。
- 域工具链白名单在 execTool 的 permission/preset 之后再加一道 task_tools_guard（hooks.js 新钩子，最干净接缝），并可显示"该域未授权此工具"提示。

### 4.5 知识库 2.0（可选阶段）
- 上传链路：前端"知识库"页（或任务会话内拖拽）→ POST /api/upload → extract_*（现成）→ 切片（按段落/固定窗口）→ embedding（经网关：dashscope/硅基等 embedding 模型，按 model_profile 记账）→ kb_chunks 入库。
- 检索注入：kb_search 增强为"关键词命中 + embedding 余弦召回 top-k 合并重排"，结果带 doc 溯源；project 级 scope 与任务域绑定。
- 与记忆架构的关系：知识=事实库（用户主动喂），记忆=沉淀回路（复盘/偏好自动进 kb），两轨并行、单一出处原则不变（docs/记忆架构.md）。

### 4.6 前端：任务工作台视图（保留对话壳，新增三个一级入口）
- 首页改为**工作台三区导航**：① 对话（现状）② 任务广场/我的任务（模板浏览+进行中任务状态卡+历史）③ 模型中心（模型广场目录 / 测评间 / 知识库）。
- 会话头显示"当前任务画像"徽标（如 🎬视频），可改选/退出画像。
- 模型下拉每个模型显示能力徽标（🛠调用/🖼看图/🎬视频/💭推理/窗口大小/价格档），hover 出模型卡。
- 修复既有死路径顺手项：api.asks 导出补齐、上传 UI、会话归档/搜索。
- 架构：Chat.jsx 已 1231 行——新增页面建议拆新组件（router 仍不引库：用顶层 tab state 切换即可，与现状一致），样式沿用太阳大地色变量。

### 4.7 与既有决策的关系（需用户确认的决策点）
| 决策 | 现状 | 本方案建议 | 理由 |
|---|---|---|---|
| P7 | 不做自动分类路由（:219） | 扩展为"三级决议，任务画像仅在未显式选择时生效" | 与成熟 CLI 语义一致（蓝图:109 注）；显式永远绝对优先（C4 不破） |
| P12 | 语义检索 ✖（v2.5） | 以"可选 embedding 供应商 + 本地余弦"重启（默认关） | 知识库 2.0 需要；成本可控、无新中间件 |
| P14 | 任务=对话模型 ⏸ | 以 task_profiles + 任务广场形态落地（对齐合并线 hello） | 用户本轮优化方向明确点名"分配开发/视频/商业模式任务" |
| C7 介入度 | 光谱 0-3 | 不变；任务域可声明默认介入度 | — |

---

## 5. 分阶段路线（每阶段可独立交付、可回滚）

### P0「地基与元数据」（约 1 周）——纯增量、低风险
- [ ] model_profiles 表 + 启动同步（从 providers.capabilities+市场 domain 初始化，人工在 UI 修正）+ /api/profiles 端点；前端厂商/市场页模型行显示能力徽标。
- [ ] price_table 接入 gateway calcCost（消灭硬编码 PRICE；openrouter 补档）。
- [ ] 意图识别升级：把 TOOL_INTENT_RE 单正则改为"样本正则表 + 可选 LLM 分类兜底"，先上线正则表重构（离线回归可测），LLM 兜底默认关。
- [ ] 修复顺手项：api.asks 导出（断连横幅复活）、渠道/定时读会话 provider/model。
- 验证：selfcheck + regression 扩展（resolver 单测）、880 走查"模型徽标/价格档显示"。
- 涉及文件：server/db.js、llm/gateway.js、llm/providers.js、server/index.js（路由/意图）、server/channels/*、src/*、docs/平台开发全集清单（回填）。

### P1「任务档案 + 路由器」（约 2 周）
- [ ] task_profiles 表 + 管理端点 + 前端"任务广场"（首批 5-8 类：开发-修缺陷/开发-新功能、视频-短视频脚本与分镜、商业模式分析、竞品研究、文档写作；每类含 router_rule/toolset_override/skill_refs/template_prompt/acceptance_template）。
- [ ] resolver 三级决议落地（auto 分支改为读 task_profile）；运行时快照输出路由理由。
- [ ] 会话"任务模式"：新建对话可选任务画像；对话中 Agent 匹配画像后自动载域技能+模板（hook：agent.js 注入点沿用 index.js:438-449 技能注入的现成位置）。
- [ ] packs/rw-domains 首个域技能包（dev：承接 task-approach/acceptance-builder 的领域化）。
- 验证：三条 E2E（开发类、商业模式类、未归类回落旧 auto）；880 指南新增"任务广场"节。
- 涉及文件：server/db.js、server/agent.js（注入点）、server/index.js、server/tools/hooks.js（task_tools_guard）、packs/、src/。

### P2「知识库 2.0 + 模型测评间」（约 3 周）
- [ ] 上传→extract→切片→embedding→kb_chunks 链路 + 知识库页（conv/global/project 三级）；kb_search 召回增强。
- [ ] eval_runs 表 + 测评间 UI：选任务文本→选 2-4 模型→并行子代理各跑一轮→并排差异+成本/延迟/工具成功率→打分→写回 model_profiles.quality。
- 验证：上传一个 PDF 建 project 知识库后问答溯源；A/B 一条开发任务给出推荐。
- 涉及文件：server/db.js、server/tools/extract.js 之上新增 kb_import/kb_embed 工具、server/llm/embed 适配、server/index.js、src/。

### P3「任务资产市场化 + 团队雏形」（约 3-4 周，可再拆）
- [ ] 任务广场"发布/导出/导入"（模板文件=调教包同构，可复制改造）；我的任务（进行中/历史/失败重跑，driver 事件可视化）。
- [ ] 会话项目树/归档搜索（对齐 prototype/home-v3 未落地构想的最小版）；首页工作台三区导航收口。
- [ ] 团队雏形（可选）：角色字段扩展+按角色 hide 工具——**不建多租户**。
- 验证：调教回流闭环（域模板回 packs → 新实例 apply-pack 可用）；880 全量走查。

治理贯穿：每阶段 commit 走 C5；蓝图 P 池新增本方案决策记录；KPI 增加"任务画像使用率/路由采纳后打回率"；README/TODO/实测指南同步。

---

## 6. 风险与边界

- **成本放大**：测评间/多模型对比天然烧钱 → 复用任务预算护栏（task_budget_total）+ 测评间单次限额；LLM 意图分类兜底入账（kind=intent）。
- **路由误判**：画像识别错误会把任务导向不合适的模型 → resolver 只影响"未显式选择"；快照明示路由理由；一键退回旧 auto（settings 开关）。
- **知识库隐私**：embedding 走外部供应商属可选默认关；文档级权限沿用 scope=project+账号。
- **"视频"域的现实约束**：文本侧（脚本/分镜/素材清单/剪辑台本/发布检查）RW 现在就能做；真正"生成视频"依赖豆包/混元等视频生成 API 与文件落盘，属模态工具增量（models.capabilities 已标 ark video），列入 P2+ 可选，不阻塞文本侧任务域。
- **明确不做**（v1）：OS 级沙箱、画布式工作流引擎、SaaS 多租户/共享空间商业化（保留"模板导出/导入"作为自托管下的共享等价物）。
- 与发行物路线的关系：本方案=**单实例多域**；RW发行物-v1=**多实例单域**。两者互补：packs/rw-domains 的域技能/模板可同时服务两条路线；不冲突。

---

## 7. 验证与关联

- 提案模板验收：语法检查 → 分阶段自测/回归 → 880 实测指南增量走查。
- 关联：蓝图 I 域（模型与提供方）、F 域（任务执行）、L 域（集成生态）；决策 P7/P12/P14 修订；决策池新增 P27 候选（本方案）；C4/C7 不变。
- 主要盘点证据索引：server/agent.js、server/index.js:288-374（意图与路由）、server/tools/index.js（63 工具）、server/llm/{providers,gateway,market}.js、server/driver.js、server/db.js、server/mcp.js、src/{Chat.jsx,api.js}、docs/平台开发全集清单-v1.md、docs/archive/daily-evolve-log.md。
