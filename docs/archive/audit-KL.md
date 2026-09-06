# 审计报告：域 K（配置与可调性）+ 域 L（集成生态）—— 蓝图↔代码 / 蓝图↔成熟 CLI 双重对照

> 审计人：代码审计 agent · 日期：2026-09（蓝图 v2.6）
> 蓝图：`docs/平台开发全集清单-v1.md`（K 域 L119-124；L 域 L126-134；决策行 P3=L198 / P5=L200 / P9=L204 / P11=L206 / C5=L191；单用户假设注 L18；渠道无流媒体注 L260）
> 判定图例：✅=闭环且与蓝图一致 · 🔶=部分/待完善（与蓝图一致或蓝图已标❓）· ⬜=未做 · 📝=文档/轻微问题 · 🐛=缺陷/不一致候选 · 🔍=待核
> 结论先读：**行级判定 9 行 = ✅×5（K1/K3/L1/L4/L5）· 🔶×2（K2/L6）· ⬜×2（L2/L3）；证据级附加 📝×8、🐛候选 ×1（L1 只读逃逸，🔍待核）、🔍待核 ×2**

---

## 一、代码对照（蓝图行 → 代码证据 → 判定）

### K. 配置与可调性（蓝图 L119-124）

| 设计点（蓝图行） | 判定 | 代码证据（file:行） | 审计附加发现 |
|---|---|---|---|
| **分层配置**（L122：✅ settings schema+预设；❓ profile 层；效果=一处定义三处生效） | ✅（与蓝图一致）+ 📝 | schema 单源：`server/settingsSchema.js:1`（"一处声明→API 校验/UI 渲染/默认值同源"）、`:5-23` SETTINGS_SCHEMA（15 键 runtime/budget/context 三组）、`:25-38` validateSetting（未登记键放行 `:31`）<br>API：`server/index.js:735-741` GET /api/settings（返回 schema）、`:742-753` PUT（runtime 组护栏键 bump rev `:744-750`）<br>预设（会话级 all/standard/minimal）：`index.js:150/160/347` 白名单校验；`server/tools/meta.js:2` tier 体系；`server/tools/index.js:945-975` toolDefs 按 expose 过滤（`:946`）；执行层 `server/tools/hooks.js:157-169` preset_tier_guard<br>工具启用集：`index.js:113-138` GET/PUT /api/toolset（toolset_enabled） | ① 📝 "预设"实际语义=**工具暴露档（tier）**，非"一组设置的配置档"——蓝图用词含混但代码语义清晰，与"profile 层❓"是两回事<br>② 📝 **"一处定义三处生效"消费面不齐**：Web /api/chat 路径读 temperature/systemPrompt/default_models（`index.js:336`、`:414-417`、`:330-331`），但渠道/定时路径不读（见 L4 行证据）——schema 同源仅对"设置面板渲染+校验+默认值"成立 |
| **配置版本化**（L123：🔶 schema+rev；❓ 导入导出） | 🔶（与蓝图一致）+ 📝 | schema：见上<br>rev：`server/db.js:27-33` bumpPolicyRev（__policy_rev 自增）、`:307` 种子=1；每轮读取 `server/agent.js:140/157` 并注入快照 `:239-254`（`:251` 显示 rev）；写入侧 `index.js:282-285` setSetting（noBump 语义 `:284`）<br>导入导出：**无任何 endpoint**（grep /api/settings/export 无果）；settings 存 MySQL JSON 列（`db.js:173-177`） | ① 📝 有 rev 计数**但无单键变更历史/回滚**：PUT /api/settings（`index.js:742-753`）不写 audit_log；仅工具侧 set_limits/reload 经 execTool 留痕（`tools/index.js:1073-1075`）<br>② ❓导入导出缺口属实（蓝图如实）；跨实例迁移只能手工；M 域 packs/apply-pack 为另条雏形（`scripts/apply-pack.mjs`，🔍待核 是否覆盖 settings） |
| **热更新**（L124：✅ settings 实时+reload 协议（批2 防撞）；效果=改设置即生效） | ✅（与蓝图一致）+ 📝 | 即时写：PUT /api/settings（`index.js:742-753`）；护栏值 5s 缓存、**每轮重读**：`server/agent.js:136-162` agentLimits、`:343` 每轮读、`:355-360` 判定（预算/轮次/循环）<br>set_limits 工具直写 settings+bump：`server/tools/index.js:772-792`（`:787-789` 直插 DB、`:790` bumpPolicyRev）<br>reload_platform+F2 防撞：`tools/index.js:793-811`（`:800-806` 其他活跃任务检查）；`server/restart.js:1-2`；`index.js:38-53` maybeSelfRestart、`:643-644` 收尾触发 | 📝 **消费面边界**：护栏（limits）经 runAgent 每轮读取，故微信/飞书/定时/驱动路径**同样生效**；但 temperature/systemPrompt/default_models 只在 Web 请求组装时读一次（`index.js:336` 等），**渠道与定时任务不读**（见 L4/L6 CLI 对照）——"改设置即生效"对渠道不完整成立 |

### L. 集成生态（蓝图 L126-134）

| 设计点（蓝图行） | 判定 | 代码证据（file:行） | 审计附加发现 |
|---|---|---|---|
| **Git 深度集成**（L129：✅ git 工具+纪律；❓ push 前预检；效果=少踩分叉坑） | ✅（与蓝图一致）+ 📝/🐛候选 | 工具 4 件：`server/tools/index.js:324-335` git_status/git_commit/git_branch/git_pull_push；tier 分级 `server/tools/meta.js:39-41/67`；入默认启用集 `meta.js:79`；高危门禁 GUARDED_TOOLS 含 git_pull_push `tools/index.js:21`；纪律钩子覆盖 git_commit/git_pull_push `hooks.js:182-186`<br>**P5 auto-commit 判定位置**：`tools/index.js:642-676` finish_task 内（`:650-668`）——ws=ctx.root‖RW_WORKSPACE，platformDir=RW_PLATFORM_DIR‖/srv/harness-workbench，`isPlatform` 判定（`:655`）→ 平台目录跳过走 C5（`:668`），业务区 git 仓库 + 有未提交改动 → add -A + commit（`:663-664`）<br>git 状态注入上下文：`index.js:400-412` buildGitBlock、`:472-475`（C1 尾部追加保缓存） | ① 📝 **push 前预检缺口属实**：git_pull_push 单条命令无 status/diff/upstream 预检（`tools/index.js:334-335`）；git_commit 一律 add -A 全量提交（`:327`），与"小步提交"纪律存在张力<br>② 🐛候选（🔍待核）：finish_task 声明 permission='read'（`tools/index.js:642`）却内嵌 git add -A+commit——**read 会话理论上可经 finish_task 产生本地提交（只读逃逸）**；readonly_intent_guard 名单（`hooks.js:182-186`）不含 finish_task；`ctx.__skipAutoCommit` 由谁注入 🔍待核<br>③ 📝 git 深度=4 工具+run_command 兜底：merge/rebase/reset/diff/log 无专用工具（meta.js:39 not 明示"看历史用 run_command git log"） |
| **终端/脚本化 CLI**（L130：⬜ 未做（新增择优项）；成熟=dsh headless / codex exec） | ⬜（与蓝图一致；详见 CLI 对照专项） | 无 headless/非交互同步入口：全部 API requireAuth（`server/auth.js:65-75`，仅账号密码换 Bearer token `:22-42`）；对话=SSE /api/chat（`index.js:316+`、`:477-500` 流式头）<br>现有"机器入口"仅为**异步**：定时任务 API（`index.js:885-919` + `server/scheduler.js:54-99`）、任务契约 API+驱动器（`index.js:927-983` + `server/driver.js`，验收/复测闭环 `driver.js:147-183`） | 🔍待核 产品判断：契约/定时异步通道是否已覆盖主要"无人值守"诉求；同步 exec 型入口（见 CLI 对照建议）若做，需补 API-key 认证与 __autonomous 审批排队复用 |
| **IDE/LSP**（L131：⬜ 远期） | ⬜（与蓝图一致） | 无 LSP 相关代码（grep 无）；最接近的替代=repo_map 结构地图（`tools/index.js:1110-1123`、repomap.js）、grep/find 工具族 | —（远期项，无缺口） |
| **IM 渠道**（L132：✅ 飞书/微信在位；🔶 测试覆盖） | ✅（在位，与蓝图一致）+ 📝 | 微信：`server/channels/wechat.js:39-85` startWechatChannel（`index.js:1084-1086` env RW_WECHAT!=='0' 启动）、`:53-77` 消息处理、`:29-37` 会话（account_id=NULL + RW_CHANNEL_PERMISSION 默认 read）、`:67` runAgent<br>飞书：`server/channels/feishu-webhook.js:59-106` webhook（`index.js:1088-1090` env RW_FEISHU_WEBHOOK==='1' 启用）、`:62-102` 收消息、`:49-57` 会话、`:36-47` 发送 | ① 📝 渠道硬编码 provider/model=deepseek/deepseek-v4-flash（`wechat.js:67`、`feishu-webhook.js:94`），**不读 settings default_models/temperature/systemPrompt/toolset_enabled**（对 K 域"一处定义三处生效"的直接反例）<br>② 📝 飞书仅文本且回包截 4000（`feishu-webhook.js:41,84-87`）；微信无截断<br>③ 🔶 测试覆盖：repo 未见渠道自动化测试（scripts/verify|selfcheck 无渠道断言，🔍待核 具体脚本内容未逐行核）<br>④ 无流媒体=蓝图 L260 已注明（批6 范围外），与代码一致 |
| **MCP**（L133：✅ P11（批5）：client 框架（stdio JSON-RPC）+管理 API；首批 GitHub 需配 token 由 settings mcp_servers 接入） | ✅（与蓝图一致）+ 📝 | 框架：`server/mcp.js` 全 109 行——spawn stdio client（`:40-73`）、握手 protocolVersion 2024-11-05（`:68`）、tools/list（`:70`）、RPC 15s 超时（`:29`）、notifications 忽略（`:62-64`）、callMcpTool（`:86-94`，image 展平为占位 `:91`）、connectConfiguredMcps（`:97-109`）<br>注册：`server/tools/index.js:920-943` MCP_EXTRA+syncMcpExtras、`:974` 拼接进 toolDefs、`:978-996` execTool mcp_ 前缀转发（按 write 级评估 `:979` 注）<br>管理 API：`index.js:816-833` GET /api/mcp + POST /api/mcp/reload（断连→重连→同步 `:828-830`）<br>配置/安全：settings mcp_servers（`index.js:749` 回存、`:708-734` 密钥脱敏 REDACT）；启动连接 `index.js:1055-1065`；60s 看门狗重连 `:1066-1082`；实战记录 `docs/MCP接入状态.md`（github 26 工具已连接） | 📝 能力子集（P11 最小闭环成立）：stdio-only（无 HTTP/SSE transport）；仅 tools 能力（无 resources/prompts/sampling）；通知丢弃；协议版本钉死；MCP 工具统一 write 级+管理员信任（`:974` 注）——与 CLI（.mcp.json 多 server、HTTP/SSE 可选）相比属可选增强，非缺陷 |
| **自改流水线（C5）**（L134：🔶 P3（批4）：proposals 分支+面板；业务自主） | 🔶（与蓝图一致）+ 📝 | P3 落地：`index.js:774-813` proposals API（GET 列表 `:778-792`、GET 单篇 `:793-800`、POST 新建 `:801-813`）；PROPOSALS_DIR=ROOT/proposals（`:776`，当前**空目录仅 .gitkeep**）；模板 `docs/templates/提案模板.md` 在位；前端 client `src/api.js:38-40`<br>业务自主：P5 auto-commit 跳过平台目录（`tools/index.js:650-668`） | ① 📝 **"分支"实为目录**：P3 决策行（蓝图 L198）写"proposals 分支"，实现=平台仓库内 `proposals/` 目录+git 版本化（`index.js:776` 注释），**非独立 git 分支、无隔离合入**<br>② 📝 **无状态机/审批动作 API**：只有 list/get/create（`index.js:778-813`）；"状态"靠正文正则 `状态：` 识别（`:786`）；无 PATCH 批准/驳回——审查=人工改文件<br>③ 📝 **C5 合入无代码门禁**：full 会话可直接改平台代码（`agent.js:167` ENV_ENV 明示平台目录可写）；无 git hook/CI 强制"先提案"；纪律在提示词/行为准则层（G 域自审钩子仅提示，`hooks.js:230-241`）<br>④ 目录为空=尚无提案实践（2026-09-06） |

### 决策行锚点核对（P3/P5/P9/P11/C5 与代码）

| 决策 | 蓝图行 | 代码落点 | 核验 |
|---|---|---|---|
| P3 提案系统 | L198（批4 ✅） | `index.js:774-813` + proposals/ 目录 | 🔶 面板/目录/模板在；分支与审批动作未兑现（见 L6） |
| P5 业务区 auto-commit | L200（批4 ✅） | `tools/index.js:650-668`（平台目录跳过） | ✅ 判定位置与范围限定如实；permission='read' 逃逸候选见 L1 |
| P9 会话自动标题 | L204（批4 ✅） | `server/autotitle.js:5-28`、`index.js:169-172`（API）、`:353-355`（首条消息廉价标题） | ✅ 在位；旁路 LLM 用 p.defaultModel（`autotitle.js:18`）不读 default_models settings——与 P23（批6 折叠/摘要/标题跟随会话模型）同族，非 K/L 缺口 |
| P11 MCP client | L206（批5 ✅） | mcp.js + tools/index.js + index.js（见 L5） | ✅ 落地闭环 |
| C5 铁律 | L191 | 行为准则/ENV 提示 + proposals | 🔶 无代码强制门禁（见 L6 ③） |

---

## 二、CLI 对照（成熟 CLI → RW → 优劣势 → 建议 a/b/c）

> 成熟参照：Claude Code / Codex / opencode / Aider / DSH(3080)（蓝图 L14-15 骨架）；历史映射见 `docs/archive/3080机制对照与RW适配方案.md:8-18`（dsh web/headless≈定时/渠道 的旧主张）。

| 设计点 | 成熟 CLI 做法 | RW 现状 | 优劣势 | 建议（a 采纳调整 / b 不调整+原因 / c 现象差异） |
|---|---|---|---|---|
| **K1 分层配置** | 3080：机器级 patch → profile patch → home patch → CLI flag 四层叠加（`docs/3080环境教学包与RW起跳设计-v1.md:33`）；Claude/Codex：settings.json/config.toml + CLAUDE.md/AGENTS.md 项目层；--dump-config 可见合并结果 | env(.env `config.js:29-59`) + settings 表（schema 单层全局 `settingsSchema.js`）+ 会话级 preset/permission/provider/model（`index.js:150,347`）；**无 per-profile/per-project 配置层**（单管理员假设，蓝图 L18） | 优：DB 集中=Web 单点管理、热改、schema 同源校验（一处声明三处消费=API/UI/默认值）；劣：不可按项目/账号分层打包、不可随仓库 diff、无 CLI flag 覆盖式调试、"一处定义三处生效"仅 agent 路径全量（渠道例外见 K3/L4） | a) **轻量 profile 层**（若要）：settings 增 profile=<JSON bundle>，会话级选择复用现有 schema 校验——复用 packs/apply-pack（`scripts/apply-pack.mjs`）思想；b) 若坚持单管理员：**不调整**，但需在蓝图中把"生效面=Web+agent 路径、渠道部分生效"写明；c) 现象差异：CLI 每项目改文件、新开会话生效；RW 改设置后进行中任务最快 5s 内下一轮生效（`agent.js:136-162,343`），快于多数 CLI |
| **K2 配置版本化** | 配置=文本文件进 git：diff 可见、可回滚、拷文件即迁移；3080 --dump-config 导出合并值 | 无导入导出；rev 仅为"模型知悉变更"计数（`db.js:27-33`）；单键无历史、PUT 无审计（`index.js:742-753`） | 优：DB 即时无文件冲突、写路径统一（set_limits/PUT 同写 settings 表）；劣：改错不可回滚单键（只能手动改回）、多实例迁移靠手工、无"谁在何时改了什么"留痕（工具侧有 `tools/index.js:1073`，UI 侧无） | a) **采纳调整（低成本高收益）**：PUT /api/settings 落 audit_log（键+旧值+新值）+ 提供 GET /api/settings/export 与 POST /api/settings/import（JSON 打包、过 validateSetting）——迁移与回滚双解决；c) 现象差异：CLI 改配置走 git（天然 diff/回滚），RW 走 API/UI（当前无痕、无 diff） |
| **K3 热更新** | CLI 多为启动时读配置；部分支持热载入（/config 命令、watcher）；改代码需重启会话/进程 | settings PUT 即写即生效；护栏每轮读（5s 缓存 `agent.js:136-162`）；policy rev 让运行中模型感知"规则已更新"（`agent.js:251`）；代码热载=reload_platform 自动重启（防撞 F2 `tools/index.js:793-811`） | 优：**RW 热更新强于多数 CLI**（常驻服务+轮内读+rev 通知）；self-reload 免人工 systemctl；劣：进程级重启仍需防撞窗口；渠道路径不消费参数类设置 | a) 保持 ✅；补 L4 渠道读取对齐后，热更新即全域成立；c) 现象差异：CLI 改 flag 常需重启/新会话，RW 下一轮即变；代码改动 CLI 手动重启，RW 对话内 reload_platform 自动完成（自我开发闭环，CLI 无对应物） |
| **L1 Git 深度** | Aider：每改即 auto-commit（改一行提一次）；Codex：git 感知+PR 工作流（plan→apply→PR）；Claude：checkpoint 文件时间线+git 状态注入 | 4 工具（status/commit/branch/pull_push `tools/index.js:323-335`）+ P5 业务区 finish_task auto-commit（平台目录走 C5 手动）+ git log 事实源注入（`index.js:400-412`）+ undo_checkpoint 快照安全网（`tools/index.js:1081-1096`） | 优：P5 范围限定（业务自动/平台手动）比 Aider 全自动更贴 C5 铁律；checkpoint 快照不污染 git 历史（`docs/Codex与主流CLI-机制借鉴清单-v1.md:47`）；劣：无 push 预检（蓝图 ❓ 属实 `tools/index.js:334-335`）；merge/rebase/reset/diff 无专用工具（run_command 兜底）；commit 无 diff 预览直接 add -A | a) **采纳调整（最小）**：push 前预检小工具（status/diff --stat/upstream 检查后执行）——蓝图已列 ❓，成本低；merge/rebase 类可继续 run_command+meta 指引（b）；c) 现象差异：CLI 在仓库内以全功能 git 子进程干活，RW 用"4 工具+纪律指引+run_command 兜底"——能力不缺但工具化浅，且 RW 有 CLI 没有的文件级 undo 快照 |
| **L2 终端/脚本化 CLI ⬜** | 全部成熟 CLI 均有：dsh headless/web、codex exec -c 非交互、claude -p print、opencode run——一次调用：prompt 入（stdin/参数）→ 最终文本/结构化出 + 退出码，供 CI/批处理/流水线 | ⬜ 无同步非交互入口；唯一机器面=异步契约/定时 + SSE Web（见代码对照 L2）；认证=账号密码 Bearer（`auth.js:22-42`） | 优（若做）：复用 agent 全能力（护栏/打回/验收/记账），接 CI/监控/批处理，下游结构化消费；劣（不做理由）：RW 核心价值=Web UI+人工审批护栏（介入度光谱 C7），纯 headless 与审批/打回冲突需无人值守降级（可复用 __autonomous 排队机制 `tools/index.js:750-753,1031-1034`）；单管理员场景脚本需求低（蓝图 L130 标"新增择优项"）；**已有异步契约通道**（driver 验收/复测闭环）覆盖多数无人值守诉求 | a) **采纳最小版（推荐，如排期）**：POST /api/headless（同步、非 SSE、复用 runAgent、默认 __autonomous）返回 {content, toolLog, usage}；配套：API-key 认证（现无）、会话 auto 建/复用 channel=headless、复用 inflight 并发与 limits、审批/问询 202 排队或拒绝；预估复用 90% 现有件，成本低收益实（CI/自测/脚本化编排）<br>b) 若近期无脚本诉求：**不调整**，契约+定时已为"半 headless"，现象差异写明即可；c) 现象差异：CLI exec=终端进程内一次往返；RW 若补 headless=HTTP 一次往返（需 token），不做=只能 Web/渠道/异步任务三入口 |
| **L3 IDE/LSP ⬜** | opencode 接 LSP（跳转/补全）；Claude/Codex 靠编辑器插件或终端 | ⬜ 无（repo_map/grep/find 为轻替代 `tools/index.js:1110-1123`） | 优（远期做）：编辑器内联体验；劣：RW=服务端 Web 平台，本地 IDE 集成天然弱（浏览器沙箱无本地文件句柄），LSP 需服务端 langserver 会话，成本高 | b) **不调整**（蓝图已定远期）；Web 轨迹/diff/审批 UI 是 CLI+编辑器组合没有的等价面；repo_map 已补"大库地图"需求；c) 现象差异：本地 IDE 内联 vs 浏览器全功能工作台（各有所长） |
| **L4 IM 渠道** | 成熟 CLI **自身无 IM 渠道**（Slack/微信/飞书=网关/编排工具层的事，如 3080 wechat-bridge 经 DSH_WORKBENCH_API 调后端） | 原生常驻双渠道（wechat/feishu，env 开关 `index.js:1084-1090`）；同一 agent/记忆/DB；会话 account_id=NULL 共享展示（`index.js:143`） | 优：渠道=复用同一 agent 循环与护栏（CLI 需外挂编排桥）；劣：无流媒体整包回发（蓝图 L260）；硬编码模型/参数不随设置（`wechat.js:67`、`feishu-webhook.js:94`）；飞书仅文本截 4000；默认 permission=read（env 可调） | a) **采纳调整（小）**：渠道路径补读 settings 的 provider/model/temperature/default_models（或显式"渠道固定用会话/默认配置"文档化）——消除 K 域"一处定义三处生效"反例；测试覆盖补冒烟（蓝图 🔶 属实）；c) 现象差异：CLI 在你终端里，RW 渠道在你微信/飞书里（手机可用=CLI 无） |
| **L5 MCP** | Claude Code：多 server .mcp.json（stdio/HTTP/SSE），工具映射权限；Codex：MCP 支持 | stdio JSON-RPC client 最小闭环（mcp.js）+ settings 集中配置+管理 API+60s 看门狗（`index.js:1066-1082`）+密钥脱敏（`:708-734`）+统一权限/纪律层约束（`tools/index.js:974,979`） | 优：与 LLM 流无关（蓝图对照表 #14）；集中配置比 .mcp.json 更适服务端；脱敏/看门狗为 CLI 少有的加固；劣：stdio-only、协议钉死 2024-11-05、无 resources/prompts、通知丢弃（`mcp.js:62-64`） | a) 保持 ✅ 最小闭环（首批 github/playwright 均 stdio 够用）；HTTP/SSE transport 与资源能力列远期；c) 现象差异：CLI .mcp.json 项目级、随仓库；RW settings 全局、服务器集中、密钥永不出服务器（更强） |
| **L6 自改流水线（C5/P3）** | 成熟 CLI **无平台内建提案系统**：自改靠"模型自觉+git 工具"（Codex 的 PR 模式=模型自己开分支提 PR；无强制审查面板） | proposals 目录+面板+模板（`index.js:774-813`）+ P5 平台目录禁自动提交（`tools/index.js:655,668`）；"审查"=人工+状态正则（`:786`），无状态机 API、无分支、无代码门禁（全证据见代码对照 L6） | 优：**RW 独有**（比 CLI 更结构化的受控演进痕迹：文档/目录/面板三重留痕，可审计性＞CLI"模型自觉"）——对应蓝图对照表 #9"CLI 没有的 RW 特色"同类哲学；劣：审查/合入未机械化，full 会话仍可直改 main（纪律在提示词层） | a) **采纳调整（低成本，可选）**：① proposals API 补 PATCH status（待审/已批准/已否决）状态机，面板可点批；② G 域钩子加"平台目录写类后提示先提案/自审"（现有 syntax/finish 钩子 `hooks.js:212-241` 同型可扩展）；b) 若坚持单管理员自审模式：**不调整**——机械门禁会拖慢自我开发节奏，准则+G 域钩子够用，写明边界即可；c) 现象差异：CLI 改自己=静默提交；RW 改自己=要过提案/自审/复测轨迹（更重但更稳，符合 C5 铁律） |

### CLI 对照小结（K/L 合计）

| 对照轴 | 结论 |
|---|---|
| RW 领先处 | 服务端热更新（每轮读+rev 通知）；渠道原生接入；密钥脱敏/看门狗；业务 auto-commit 范围限定（P5）+ undo 快照；提案三重留痕 |
| RW 落后处 | ⬜ 同步 headless 入口（L2）；profile 层（K1）；配置导入导出/单键回滚/审计（K2）；push 预检与 git 深度（L1）；渠道不消费参数类设置（K3/L4 交界）；proposals 状态机与门禁（L6） |
| 建议优先级 | ① L2 headless 最小版（若排期）② K2 导入导出+审计 ③ L4 渠道设置对齐 ④ L1 push 预检 ⑤ L6 proposals 状态机（均可独立小批） |

---

## 三、最重要发现（Top 5）

1. **L2 ⬜ 终端/脚本化 CLI 是 K/L 最大空档（与蓝图一致）**：全平台无同步非交互入口，认证=账号密码 Bearer（`auth.js:65-75`），对话=SSE Web（`index.js:477+`）；唯一机器面=异步契约/定时（driver/scheduler）。成熟 CLI 全部具备 headless/exec。建议最小版 POST /api/headless（复用 runAgent+__autonomous 排队，约复用 90% 现有件）或维持现状并文档化"半 headless=契约通道"。
2. **K"一处定义三处生效"消费面不齐**：护栏值全域生效（runAgent 每轮读 `agent.js:136-162`），但渠道/定时路径硬编码 provider/model（`wechat.js:67`、`feishu-webhook.js:94`、`scheduler.js:71`），不读 temperature/systemPrompt/default_models/toolset_enabled——"改设置即生效"（K3 ✅）只对 Web/agent 路径全真。
3. **L6 自改流水线"分支+审查"未兑现为代码机制**：proposals=平台仓库内目录（`index.js:776`，非 git 分支），API 仅 list/get/create 无状态机（`:778-813`），目录当前为空；C5 合入门禁=提示词/准则层，无 git hook/CI 强制（full 会话可直改平台代码 `agent.js:167`）——🔶 名副其实。
4. **P5 auto-commit 只读逃逸候选（🐛，🔍待核）**：finish_task permission='read'（`tools/index.js:642`）内嵌 git add -A+commit（`:650-668`），read 会话理论上可经它产生本地提交；readonly 名单（`hooks.js:182-186`）不含 finish_task；`__skipAutoCommit` 注入方未核。
5. **K2 配置版本化缺"可回滚性"**：有 schema（`settingsSchema.js:5-23`）与 __policy_rev 计数（`db.js:27-33`）但无导入导出、无单键变更历史、PUT /api/settings 无审计（`index.js:742-753`）——蓝图 🔶/❓ 缺口全部属实；低成本补 audit+export/import 即闭环。
