# hello 项目复盘与合并基线（调研版 v1 · 2026-09-03）

> 调研方式：3 个子代理只读并行（代码/数据模型、知识库/规范/验收链、UI/渠道/集成面），
> 以**服务器版为准**（/srv/projects/harness-hello，885 线上）；本机 E:\projects\harness-hello 为第一代插件原型副本，仅供对照。
> 目的：RW 与 hello 未来合并前，摸清 hello 已有什么、别重造；术语对齐；待办重排。

## 1. 两代演进与运行拓扑（先建立坐标系）
- **第一代**：DSH 插件 dsh-project-workbench（3080 内全屏面板；纯文件制：`#p0` 待办、`_knowledge`）→ 本机仓库即其源码/原型。
- **第二代（现行线上）**：独立 Web 应用（"脱 DSH 插件"，`/srv/projects/harness-hello`，885=hh-server，单文件 server/server.js ~4009 行 + webapp/ 原生 SPA + MySQL 双写）。
- 兄弟项目 RW = /srv/harness-workbench（880，React 版，本目标主线）。
- 渠道宿主曾经是服务器 DSH(3080, dsh-web) + wechat-bridge；现 dsh-web/3345 均 inactive；nginx：`/`→885、`/api/feishu/`→880。
- 数据：harness_workbench 主库 20 表（business 按 project_id 分层）；hb_p* 独立库已建未用(0 行)；rw_prod/rw_test 为 RW 体系。

## 2. hello 已具备能力清单（17 项 · 合并时"有，别重做"）
| # | 能力 | 落地 | 证据 |
|---|---|---|---|
| 1 | 多项目管理（目录即项目、排序） | 左栏+projects 表 | GET /api/projects (server.js:663) |
| 2 | 一键新建项目（基线+git init/remote+hb_p 库） | POST /api/projects (:715) | 目录/库自动建 |
| 3 | 全局/项目 Idea 池（渠道消息直达；状态机；confirm→建项目/转需求） | ideas 表 27 行 | /api/ideas (:2134/:2162/:2202) |
| 4 | 需求清单管理（requirements.md 解析+完整度门禁+确认/拒绝） | requirements 33 | /api/requirements/:project (:2341) |
| 5 | TODO 任务状态机（待开发→开发中→自测中→待复测→等待合并部署→已完成；卡住/已取消） | TODO.md + tasks 镜像 135 | parseWorkflow (:481) |
| 6 | AI 执行引擎（读工单→写码→语法/冒烟自审→推进阶段） | agent-engine.js | /api/agent/run (:1549) |
| 7 | **复测队列与人工放行**（mine：待复测/待确认/资源支持；pass/fail+fails 留痕） | mine_items+阶段派生 | POST /api/mine/:id (:3761) |
| 8 | 工作流 4 面板工作台 | webapp renderFlowPanels | /api/workflow (:1970) |
| 9 | 首页数据看板（统计/管线/成本/燃尽/时长卡） | dash*Card | /api/dashboard (:2979) |
| 10 | 双级知识库（global knowledge-base/ + 项目 knowledge/；docx/pdf/xlsx 上传提取；AI 搜/存） | 文件正文+documents_meta+图谱 | /api/kb/global|project/* |
| 11 | 仓库操作/代码分析（树/git 拉推/摘要/导入留痕/部署记录） | /api/repo* (:861-1478) | deploy_records 表 |
| 12 | AI 对话（多轮工具+轨迹 SSE）+ **窗格委派总线 relay** | /api/chat、/api/relay/register|poll | chat_logs |
| 13 | 登录/鉴权/会话（5 天免登） | /api/auth/* | .sessions.json |
| 14 | 厂商/模型/Agent 管理（密钥校验即写 /etc/dsh-web.env） | /api/providers|models|agents | 热生效 |
| 15 | 双写与审计（文件+DB、audit_log） | db.syncWrite | 全库审计 298 |
| 16 | issue 单向同步（拆解时建 GitHub issue=#N；运行期不回写） | scripts/task-split.mjs | 私有 repo 实测 |
| 17 | 渠道"落点"（微信/飞书→Idea/项目，带 source；channels on=1） | ideas.source | 微信9/飞书5… |

**晨报（概念修正 2026-09-03）**：用户澄清——"晨报"= hello「我的任务」三个 tab 的早晨形态：①我待复测 ②我待确认 ③资源确认(support)。hello 已有该三 tab UI 与数据（mine 派生），**缺的不是页面而是"早晨聚合推送"**（把三 tab 汇总成一条消息/卡片在早上送达）——合并期只需做聚合推送层，不重造页面。

## 3. 数据与术语对齐（合并的关键：说同一种话）
### 3.1 三层字段（hello 的"契约完整性"答案）
1. 需求层：编号 `<短名>-YYMMDD-3位` / 名称 / 状态 / 模块 / 描述 / 讨论 / **优先级(AI定)** / **类型(AI定)** / **验收标准(可测)** / 数据契约(C-061 涉及表+口径+影响面) / 关联任务 / 工单路径
2. 任务层：TODO 行（`#N 标题 [需求:][分类:][阶段:][文档:][表:][锚点:][依赖:]`）；任务抽屉 12 项（优先级/开发者 AI 自动分配、人不可改）
3. 工单层：11 节契约（范围/验收标准/失败用例/前端样式/后端/接口/联调/字段表/数据流影响面/约束与SKILL/备注）

### 3.2 验收链与术语对照（重要）
| 我们(讨论)用词 | hello 体系 | 执行者/门禁 |
|---|---|---|
| AI 自测 | 自测/自审（QC 门禁+S05 五维自审） | AI 工人 |
| AI 提测完成 | TODO `[阶段: 待复测]`+AI执行报告（C-055，AI 终点） | AI |
| rw 测试 | **harness 控制台复核**（对照验收标准，不写任务代码） | 主 harness/监控者 |
| 用户复测 | **人工复测（C-040 放行，E4 抽查≥3 项）**；"待复测清单.md"+mine 列表 | 人(所有者) |
| 发布 | S07 部署上线（复测放行不可绕过，HTTP200+smoke，失败回滚） | AI 执行 |
| 状态机 | 待开发→开发中→自测中→待复测→等待合并部署→已完成（卡住/已取消旁路） | tasks.stage |

铁律：**未经人工复测通过，AI 不得进入合并/部署/上线。**

### 3.3 知识库存取
正文=md 文件（global→knowledge-base/global 4 份唯一文档；项目→knowledge/）；元数据/版本留痕/图谱检索=DB（documents_meta v1→v2…、skills 17、graph_nodes 253）。字段权威=scripts/db-schema.mjs（C-061 防捏造）。归属规则 C-004（跨项目→全局库；项目专属→项目库）。

## 4. RW 对照与合并原则（不重造清单）
- **hello 已有 → 合并时桥接/复用，不重做**：复测面板(mine)、任务列表/看板、Idea 池、需求确认、双级知识库 UI+检索、仓库/成本/审计、看板首页、issue 单向创建、窗格委派总线(relay 雏形)。
- **RW 独有 → 合并后的新增层**：无人值守驱动器(契约/责任循环/账本/运行中压缩/审批排队)、白天讨论人格、多渠道收口新归属、晨报(空缺)。
- **对齐要求**：RW 驱动器状态语义（queued/running/need_input/candidate_done/done/blocked）需对齐 hello 词集（待复测=C-055 阶段）；验收钩子=hello 验收标准+QC 门禁+smoke；候选完成→写入 hello 待复测队列（mine）而非另起炉灶。
- 数据落点原则（延续 hello）：**业务真相=文件（requirements.md/TODO.md/工单）+ MySQL 镜像**；RW 若引入契约表，合并期应作为"调度层元数据"，与 TODO 行双向镜像，避免双真相。

## 5. 合并期待办（重排基线 · 与用户/RW 设计后执行）
- P0 文档与设计（本批）：本复盘基线（✅ 本文档）；术语/状态映射表（驱动器↔hello 词集）；字段桥设计（契约→工单 11 节→TODO 行→mine 复测队列）。
- P1 桥接件：① RW 驱动器 candidate_done→ hello 待复测（经 hello API mine/flow 或直接 TODO 行写入）；② 验收钩子对接 hello check-constraints/smoke；③ 立项双入口（对话 create_contract ↔ hello Idea/需求 confirm）；④ 知识库共用（RW 工具读 hello global/project kb）；⑤ 渠道归属重设计（微信/飞书→谁收、收后进 Idea 还是对话）。
- P2 新写（两平台都无）：**晨报=「我的任务」三 tab 的早晨聚合推送**（页面已有，缺推送层）、通知卡（飞书 A/B/C）、RW 驱动器自我改造、多窗格分包与模型评估、**RW 能力实测卡（5 项代表任务评分，验证 RW 到底能不能写码）**、**界面融合模型决策（谁为"家"：hello 母体嵌 RW vs RW 门户深链 hello vs 双入口共享数据）**。
- 观察/待确认：飞书订阅 URL 实际指向(3345 vs nginx 880)；3345 接收器是否废弃；880 wechat 回路是否真的注册成功；issue closed 来源；根目录副本同步机制。

## 6. 下一步建议（供选择）
A. 先写《状态/术语与字段桥设计》（驱动器↔hello 对齐），作为合并第一份设计文档；
B. 先补 RW 侧小实测：驱动器 need_input 端到端 + run_at 夜窗（不依赖 hello）；
C. 先开渠道归属/晨报的"合并期讨论"（涉及 RW 自我改造议题，按你"与 RW 一起设计"的节奏）。
