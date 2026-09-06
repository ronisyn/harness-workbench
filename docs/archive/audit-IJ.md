# RW 平台蓝图"蓝图↔代码"与"蓝图↔成熟CLI"双重对照审计：域 I（模型与提供方）+ 域 J（交互与 UX）

> 审计对象：`docs/平台开发全集清单-v1.md`（v2.6）域 I（L101-107）、域 J（L109-117）、P6/P7 决策行（L201-202）、台账 O-3/O-8/O-9/O-14/O-16/O-19（L159/164/165/170/172/175）。
> 代码取证：`server/llm/providers.js`、`server/llm/gateway.js`、`server/llm/market.js`、`server/index.js`、`server/agent.js`、`src/Chat.jsx`、`src/api.js`、`docs/RW行为准则-服务器版.md`。
> 审计方式：read/grep 逐行取证（file:行），不修改代码。行号以 2026-09 现网代码为准。
> 判定图例：✅=与蓝图一致且已闭环 · 🔶=部分/待完善（通常指向批6 待修项）· 🐛=与蓝图描述不符或实为缺陷 · 📝=注释漂移/现象差异/待完善（非阻断）· ⬜=未做 · 🔍待核=证据不足需实测/原始材料核对。

## 代码对照

### I 域：模型与提供方（蓝图 L101-107 共 4 行）

| 蓝图行 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|
| I-1 统一适配层（多厂商可切换） | ✅（注1：蓝图标 🔶 GLM 取证 F6，批3 已闭环落地） | `server/llm/providers.js:5-56`（PROVIDERS 共 10 家，每家 defaultModel/chatModels/capabilities；openrouter 特例 `defaultModel:'' chatModels:[]` L53-55）· `providers.js:77-90` syncChatModels 启动同步目录 · `gateway.js:33-39` resolve（未知厂商/未配 Key 即抛错）· `gateway.js:42-57/128-167/170-177` 三形态+fetchModels · `market.js:7-12` MARKET_SOURCES（4 聚合源）· `index.js:289-312` resolveRoute | 统一 OpenAI 兼容层成立：10 厂商直连 base+4 市场源聚合；GLM reasoning_content 非标字段已由 F6a（`agent.js:475-484` 空正文诚实报告）与 `gateway.js:162` 显式取出兜底。openrouter 无默认模型/目录（模型走市场勾选），行为一致 |
| I-2 显式模型=绝对锁（C4） | ✅ | `index.js:289-300`（注释"显式厂商即锁定，5.2 都不行"；provider 非 auto → 锁定，model 显式→原样用，缺省→厂商默认 L297-299）· `index.js:321-332`（解析优先级=body 显式→会话保存值→默认；注释自证 O-14 修复 L323-326）· 前端会话级持久化 `Chat.jsx:227-234` saveModelSel + `Chat.jsx:273-282` openConv 恢复 · 失败诚实报错 `gateway.js:53/157`（含厂商名+model+status） | O-14 修复（会话保存值优先+显式厂商锁死）与代码一致：`wantProvider = provider \|\| convProvider`（L327），会话里 GLM 不会被自动路由/回退覆盖。模型绝对锁 = 会话级（跟对话走，非全局），符合蓝图 C4 |
| I-3 任务型路由（P7：default_model 可配，不做自动分类） | ✅（附 📝 一处） | `index.js:79-81`（/api/models 应用 settings default_models 覆盖）· `index.js:329-331`（/api/chat 读 default_models 注入 defOverrides）· `resolveRoute` 显式厂商分支用 `defOverrides[provider] \|\| p.defaultModel`（L297-299）· 自动分支仅"视觉→ark、其余→deepseek"两条硬编码（L304-305）+目标厂商未配 Key 回落（L307-310） | 📝：auto 分支（L304-305）硬编码 `doubao-seed-2-0-mini-260428`/`deepseek-v4-flash`，**不读 defOverrides**——用户选"自动路由"（`Chat.jsx:781` 有该选项）时，设置的 default_model 不生效；且视觉分支硬编码模型与 `providers.js:19` ark defaultModel `doubao-seed-2-1-pro-260628` 不一致。另 `index.js:1002` 注释"同步硬编码 9 家"与实际 10 家漂移（📝 注释漂移，不影响行为） |
| I-4 Reasoning 处理（思考提取/透出/计费口径） | ✅（透出与落库）+ 🔶（非增量，O-16 批6）+ 🔍待核（B1 计费口径） | 透出：`gateway.js:162`（非流 message.reasoning_content）· `agent.js:388`（每轮整块 emit think）· `index.js:560-561`（thinkBuf 累积）· `index.js:609-610`（reasoning 落库 messages，上限 2 万字符）· 前端折叠 `Chat.jsx:418-420`（onThink 累积）+ `Chat.jsx:1191-1206`（ThinkBox：流式中 open+贴底、结束可开合）· 活动环 think 3s 合并+2000 截断 `agent.js:25-34` | 🔶：工具轮/最终轮 thinking 为**轮完成后整块后置**（非流 `agent.js:372` 一次性返回 → L388 单次 emit），无增量透传 → O-16 属实、P21 待批6。🔍：usage 计费口径（B1 批6 项）：现网非流取 `j.usage`（`gateway.js:159/165`，chatStream 的 `include_usage` L75 是死代码），各厂商 usage 字段差异（GLM thinking token 计入口径、cache 拆分）需实测矩阵核对，代码面无法终判 |

### J 域：交互与 UX（蓝图 L109-117 共 6 行）

| 蓝图行 | 判定 | 证据（file:行） | 说明 |
|---|---|---|---|
| J-1 实时流式/思考 | 🔶（SSE/事件环/心跳 ✅；正文与思考真流式 ✗ = O-16） | SSE 头+X-Accel-Buffering `index.js:477-483` · O-8 心跳 15s `index.js:484-495`（arm/stop L494-495，send 复位 L498）· 事件环 ACT_MAX=300 `agent.js:12-38`（L16 常量）· activity API `index.js:216-224` · 前端轮询 2.5s `Chat.jsx:512-542`（L523 api.activity）· **非流式**：每轮 `agent.js:372` chatOnceWithTools（`gateway.js:148` stream:false）→ 轮完成后 `index.js:595` 才有 answer → `index.js:598-603` 8 字分块模拟（L598 注释自证）· chatStream `gateway.js:60-125` 全仓零调用 | 蓝图 J-1 描述与代码一致：SSE 通道、思考/工具卡实时事件、活动条全在位；缺口=正文/思考非真流（8 字假分块 + think 整块后置），即 O-16，批6 目标态"每轮真流式"方向吻合。事件环"旁观轮询 2.5s/300 条上限"与蓝图文末六维自审注②一致 |
| J-2 输出紧凑（准则 6.1） | ✅（提示层，同 CLI）+ 📝（无格式强校验） | `server/agent.js:196`（系统提示指向行为准则文件）· `docs/RW行为准则-服务器版.md:47`（6.1 完成汇报含交付物/验证证据/步数成本/未做声明） | 准则 6.1 以系统提示引用落地（需要时 read_file 读全文），与成熟 CLI（Claude 简洁纪律=提示层）一致；代码无强制长度/结构校验（靠 B6/B6b 打回做"声称完成"侧证，`agent.js:425-473`）——这与 CLI 同为提示纪律，非缺陷 |
| J-3 轨迹/审计视图 | ✅ | tool_calls 落库+回填 message_id `index.js:611-612` · 轨迹 API `index.js:210`（/api/conversations/:id/toolcalls）· 历史轨迹挂载 `Chat.jsx:236-258` · 抽屉实时刷新 `Chat.jsx:538` · 轨迹卡 TracePanel/TraceCard `Chat.jsx:1209-1225`+`Chat.jsx:1086-1104`（含 diff 视图 L1100-1102）· O-11 修复（args JSON 统一格式化）`Chat.jsx:1090-1093` · 工具名中文化 TRACE_LABEL `Chat.jsx:1157-1169` | 蓝图 J-3 的"🔶 [object Object] O-11"已修复（批4，`Chat.jsx:1090` 注释自证）。轨迹视图=实时卡（流式中 open）+历史可折叠面板，比蓝图书面更完整 |
| J-4 内联审批/问询 | ✅ | 服务端挂起表+SSE 事件 `index.js:568-571`（emit approval/ask）· 审批 API `index.js:694-705`（GET pending/POST decide，审计留痕 L699-703）· 问询 API `index.js:670-683` · 断连/刷新恢复入口 fetchPending `Chat.jsx:284`+`Chat.jsx:520-522`（每 ~7.5s）· 卡片渲染 `Chat.jsx:814-836`（审批卡/选项卡）+顶部待处理条 `Chat.jsx:788-797` | 对话内弹卡闭环；断连恢复补答也闭环。蓝图 J-4 ✅ 属实。diff 预览缺口属 D 域（蓝图 D 行自标 🔶），不在此域 |
| J-5 可中断保存（stop 即存） | ✅（轮间）+ 🔶（调用内不可掐，O-20 相邻缺口） | actrl 建表 `index.js:506-512`（abortMap + onDisconnect abort('disconnect')）· /api/chat/stop `index.js:686-691`（abort('user')）· 轮头停止检查 `agent.js:339-341` · 中断现场标记 `index.js:576-588`（markRun interrupted+原因）· 中断占位消息（原因+已做进度）`index.js:615-631` · 前端 stopGen `Chat.jsx:360-376`（先 stopChat 后本地断流 300ms，事后拉库对齐 L375）· 队列语义（停止后保留、不自动续发）`Chat.jsx:472`+`Chat.jsx:857-877` | 停止在"轮间"即时生效、现场/占位消息不丢=✅。缺口：当前轮 in-flight 非流 fetch（`gateway.js:154` AbortSignal.timeout）**不接 actrl.signal** → GLM thinking 长轮内点停止最多要等该轮自然结束（最长 180s）才响应；即 O-20"中止透传缺口"在实际主路径（chatOnceWithTools）同样存在，批6 A5 需覆盖非流调用或改真流注入 signal，详见发现 3 |
| J-6 输入状态语义（conv184 残留输入） | 🔶（行为已在，定义未定稿 → 🔍待核 conv184 原文） | 会话草稿隔离（切走存/切回恢复）`Chat.jsx:260-265`+`Chat.jsx:292-294` · 发送即清空草稿 `Chat.jsx:398` · 发送失败恢复输入 `Chat.jsx:471` · 新会话不继承草稿 `Chat.jsx:294` · 输入队列显式语义（执行中入队/停止后保留+手动续发）`Chat.jsx:476-499`+`Chat.jsx:855-891` | 代码已实现"草稿按会话隔离、发送清空、失败恢复、停止不清输入"等合意行为；但蓝图该行仍标 ❓（conv184 残留输入=定义待定稿），无法从代码核 conv184 原始场景 → 标记 🔍待核（需 conv184 对话原文核对"残留输入"具体所指后再定稿定义） |

### O-16 / O-19（及顺带 O-3/O-8/O-9/O-14）描述与代码一致性核实

| ID | 蓝图描述 | 代码核实 | 结论 |
|---|---|---|---|
| O-16 | "index.js:598 '分块模拟流式' 注释自证；chatStream(gateway.js:60-125) 成死代码零调用；问答并入非流轮环" | `index.js:598` 注释原文 `// 统一路径分块模拟流式（真实逐字流式对工具模式不适用；分块保持近实时体验）` + L599-603 chunkSize=8 循环 send delta —— **注释位置与行号精确命中**；chatStream 定义 `gateway.js:60-125`，全仓 grep `chatStream` 仅此 1 处（零 import/零调用）；问答并流非流轮环：`index.js:515-519`（P1 统一通道注释：删 needsTools 双路径，needsTools 仅降级为 schema 宽度 L519 light）→ 每轮 `agent.js:372` 走非流 chatOnceWithTools | ✅ 描述与代码 1:1 一致；"待修（批6）"属实 |
| O-19 | "非流式被迫设总时限 AbortSignal.timeout(180s)；GLM thinking 7-156s 波动 → 必被误杀；成熟 CLI 无总时限只有空闲看门狗" | 180s 墙钟总时限在位：`gateway.js:154`（chatOnceWithTools `signal: AbortSignal.timeout(p.timeoutMs \|\| 90000)`）· `providers.js:14`（GLM 唯一 timeoutMs=180000）→ GLM 每轮总时限 180s；chatOnce 同理 L45/50。非流请求=服务器响应须等 thinking+output 全完成才返回，无"首字节续命"语义 → 机制上支持"thinking 长则必被误杀"结论（运行侧铁证 agent_runs #109 属 DB 取证，代码面一致）。**补充发现**：同文件 chatStream 已内置"首字节+流空闲"看门狗雏形 `gateway.js:63-69`（firstByteMs=min(60s,timeoutMs/3)、idleMs），但因 chatStream 死代码而未上线 | ✅ 描述与代码一致；且批6 修复有现成雏形可复用（非从零写），见发现 2 |
| O-3（顺带） | GLM 90s→180s 超时 | `providers.js:14` timeoutMs 180000 + `gateway.js:45/154` 消费；主轮路径无 90s 残留（agent.js:311 collapse 60s、L408 续段 120s 为旁路业务调用自定，非主轮） | ✅ 描述一致（GLM 超时=厂商级 180s） |
| O-8（顺带） | 15s 心跳+X-Accel-Buffering:no | `index.js:482`（X-Accel-Buffering）+ `index.js:484-495`（15s 注释帧保活，活动复位） | ✅ 描述一致 |
| O-9（顺带） | thinking 吃预算→content 空→诚实报告 | `agent.js:475-484`（F6a：只思考无正文→如实报告+GLM 提示，不编造）+ `gateway.js:162` reasoning 取出 | ✅ 描述一致 |
| O-14（顺带） | 路由改会话保存值优先+显式厂商锁死 | `index.js:321-332`（注释自证 O-14）+ `resolveRoute` L292-299 显式锁死 | ✅ 描述一致 |

### 判定计数（代码对照）

- 域 I（4 行）：✅ 3（I-1/I-2/I-3，其中 I-3 附 📝 1 处）· 🔶 1（I-4，含 🔍待核 1 处）
- 域 J（6 行）：✅ 4（J-2/J-3/J-4/J-5 主体）· 🔶 2（J-1、J-6；J-5 附 🔶 注 1 处，J-6 附 🔍待核 1 处）
- O-16/O-19（及顺带 4 项）一致性：全部 ✅（描述与代码相符，待修状态属实）
- 合计 10 行：✅ 7 / 🔶 3（复合标记另计 📝 2 处、🔍待核 2 处、🐛 0 处）

## CLI对照

> 规则（蓝图 L224）：每条标注"成熟 CLI 怎么做 → RW 是否照做 → 不照做原因 / 现象差异"。参照：Claude Code（thinking 块流式/权限提示/Hooks）、OpenAI Codex（approvals、推理仅摘要）、opencode（多 provider+models.dev 目录）、Aider（--model 显式、auto-commit）、DeepSeek CLI/dsh（终端直写流）。建议代号：a) 采纳调整 b) 不调整+原因 c) 现象差异。

### I 域逐行 CLI 对照

| 蓝图行 | 成熟 CLI 做法 | RW 现状 | 优劣势 | 建议 |
|---|---|---|---|---|
| I-1 统一适配层（多 provider 适配） | opencode/Codex 走 OpenAI 兼容多 provider，模型目录动态（models.dev）；Claude Code 官方限 Anthropic+Bedrock/Vertex；Aider 单厂商多模型靠 --model | 10 厂商 OpenAI 兼容直连（`providers.js:5-56`）+4 聚合市场（`market.js:7-12`），无自动分类、绝对锁优先 | 优：国内厂商直连免代理、单套 OpenAI 兼容层切换成本低；劣：chatModels 目录人工维护（注释已说明按厂商 /models 实测人工剔除，`providers.js:2-4`），新模型靠市场勾选补，不如 models.dev 动态目录全量 | b) 不调整主路径（兼容层策略与 CLI 一致，市场勾选=可选动态补充）。c) 现象差异：CLI 目录=全量动态滚动，RW=精选清单+市场快照（每日 0 点刷新 `market.js:115-124`）——人工清单有利"菜单只给能用的对话模型"，这是 RW 有意的取舍 |
| I-2 模型绝对锁 | CLI 用户所选即锁（Claude --model / Aider --model / Codex 会话选择），失败直接报错到终端 | 会话级绝对锁（`index.js:292-299`）+会话保存值优先（`index.js:327-332`）+失败诚实报错含厂商/model（`gateway.js:53/157`） | 优：会话级锁定+DB 持久化（切对话恢复所选模型 `Chat.jsx:273-282`）比 CLI 更"粘"；劣：无（O-14 已闭环） | a) 采纳调整——已照做（批3）。补充建议：auto 路由分支模型硬编码不随 default_models（发现 4）宜顺手修齐，保持"锁=绝对、auto=诚实默认"语义干净 |
| I-3 任务型路由/默认模型 | CLI 无按内容自动分类路由；opencode 有 default/cheap/fast/high 别名=显式挑选，非自动 | default_model 可配（settings default_models，`index.js:79-81/329-331`）；自动仅视觉→ark 一条（`index.js:304-305`）；P7 明确不做自动分类 | 优：可配默认+单一视觉特判，比 CLI 别名更简单直接；劣：auto 分支硬编码模型绕过 defOverrides（发现 4）；视觉分支模型与 ark defaultModel 不一致 | b) 不调整（与 P7 收敛一致：自动分类不可信，保留视觉特判即可）。📝 建议把 L304-305 硬编码改为读 defOverrides/厂商 defaultModel，一行成本消语义裂缝 |
| I-4 Reasoning 呈现与计费 | Claude thinking 块**流式**默认折叠可展开；Codex 只给推理摘要（隐藏原始链，安全策略）；DeepSeek/智谱 web 直接渲染可折叠块；usage 流末帧（Anthropic message_stop / OpenAI include_usage），客户端从流末取数 | 透出+前端折叠 ThinkBox（`Chat.jsx:1191-1206`）=与 Claude 观感一致 ✅；**工具轮/最终轮整块后置**（`agent.js:388` 单次 emit）=现与 CLI"思考增量实时"差距最大处（O-16/P21）；reasoning 落库可回看（`index.js:609-610`）=RW 特有审计增强（Codex 反而刻意不留原始链）；usage 无流末帧（非流一次性带回），计费口径待厂商矩阵（B1，🔍） | 优：思考落库+回看优于 Codex（安全顾虑不同——RW 单用户信任场景可留痕）；劣：整块后置=长 thinking 轮用户只看到"🤔 思考中"占位（`Chat.jsx:838`）无内容增量 | a) 采纳调整=批6 P21（增量透传+全局合帧+前端折叠）；CLI 对照表 #2 已定"按块进折叠区、非逐字刷屏"，与 Claude 观感一致、又规避事件风暴。b) 不调整项：落库留痕保留（RW 审计契约），此点不照 Codex 的"隐藏原始链" |

### J 域逐行 CLI 对照

| 蓝图行 | 成熟 CLI 做法 | RW 现状 | 优劣势 | 建议 |
|---|---|---|---|---|
| J-1 实时流式/思考 | CLI 每轮 stream:true，思考增量/正文增量实时写终端；超时=空闲看门狗无总时限（CLI 对照表 #1/#5） | SSE 事件环+活动条+8 字假分块（`index.js:598-603`）+think 整块后置；180s 墙钟总时限（`gateway.js:154`+`providers.js:14`） | 劣（相对 CLI）：长轮体验=转圈+突然整块（发现 5）；180s 误杀 thinking（O-19） | a) 采纳调整=批6 P20 每轮真流式+O-19 空闲看门狗（复用 `gateway.js:63-69` 已写好的 firstByte/idle 逻辑，非从零）。c) 现象差异（批6 后仍存）：CLI 终端逐 token 直写，RW 按全局合帧推送+活动环 300 条上限（蓝图自审注②：正文不进活动环，旁观以"刷新取最终+事件卡"为准） |
| J-2 输出紧凑 | Claude 简洁纪律=系统提示层约束 | 准则 6.1 提示层引用（`agent.js:196`+行为准则文档:47），B6/B6b 打回做"声称完成"侧证 | 优：与 CLI 同为提示纪律，成本为零；劣：无强制（CLI 亦然，非差距） | b) 不调整（CLI 也没有平台级强校验；强校验=假完成打回体系 B6b 已 RW 独有，蓝图对照表 #9 已定"不照做=保留 RW 特色护栏"） |
| J-3 轨迹/审计视图 | CLI 无 RW 式结构化轨迹卡：Claude 靠 Pre/PostToolUse hooks 事件+usage 摘要；Codex 终端回显命令/编辑；opencode 会话可查 tool 消息——均为终端文本，不落"每步可点开"的审计 UI | 轨迹卡（流式中实时）+历史折叠面板+diff 视图+工具名中文化+抽屉（`Chat.jsx:1209-1225/1086-1104`），tool_calls 全量落库（`index.js:611-612`） | 优：审计粒度与可读性显著高于各 CLI（参数/结果/diff 每步可查，O-11 后无 [object Object]）；劣：无 | b) 不调整（轨迹留痕是 RW 审计契约核心，CLI 终端场景本无此需求）。c) 现象差异：CLI=终端纯文本回显，RW=Web 折叠卡片+DB 可回查 |
| J-4 内联审批/问询 | Claude 权限提示（参数预览后批准/拒绝，可持久化规则）；Codex approvals UI；均对话内联 | 审批/ask 卡+顶部待处理条+断连恢复补答（`Chat.jsx:814-836/788-797`+`index.js:694-705/670-683`），P6 allow/deny 命中免拦/免审批 | 优：对话内联+规则层（P6 完整版）与 Claude 规则持久化对齐；劣：审批卡无参数/diff 预览（蓝图 D 域自标 🔶 缺口，非 I/J 缺陷） | a) 采纳调整——已照做（P6/P19 对齐 Claude modes 与放行规则）。D 域 diff 预览补齐属域外建议（此处仅提示） |
| J-5 可中断保存 | CLI Ctrl+C/stop → 单 AbortController 贯穿 → 同 signal 传内层 fetch → 连接断开厂商即停 + reader.cancel（CLI 对照表 #4） | 轮间停止即时生效（`agent.js:339`+`index.js:686-691`），现场保留+占位消息（`index.js:615-631`）=**优于 CLI 的"中断留痕"**；但轮内 in-flight 非流 fetch 不接 actrl.signal（`gateway.js:154` 只用 AbortSignal.timeout）→ 长 thinking 轮内按停止最迟 180s 才生效 | 优：中断=占位消息+已做进度+可恢复现场（CLI 中断=终端裸报错，RW 留痕更强，对照表 #10）；劣：中止不贯穿内层调用（O-20，且实际缺口在 chatOnceWithTools 而非死代码 chatStream，见发现 3） | a) 采纳调整=批6 A5（run signal 贯穿+reader.cancel）；必须同时覆盖现主路径非流调用，或随 P20 改真流后 signal 注入流 fetch——只修 chatStream 不解决线上缺口 |
| J-6 输入状态语义 | CLI 无对应物：终端即输即发、无多会话草稿/输入队列概念 | 草稿按会话隔离+发送清空+失败恢复+执行中入队/停止后保留（`Chat.jsx:260-265/398/471/476-499`） | 优：Web GUI 多会话场景的合理增强（队列显式语义=停止不静默丢消息，`Chat.jsx:472/876`）；劣：无 | b) 不调整 CLI 对照（CLI 无此交互，无从照做）。c) 现象差异：这是 Web 平台相对 CLI 的**新增交互维度**。🔍 conv184"残留输入"定义需对 conv184 原文核清后定稿（蓝图该行仍 ❓） |

### CLI 对照要点结论

1. 域 I 与成熟 CLI 的差距已收敛到 **reasoning 呈现方式**（整块后置→P21 增量）与 **usage 计费口径**（B1 矩阵 🔍）两项，其余（多 provider/绝对锁/默认模型）与 CLI 语义一致或更优。
2. 域 J 与成熟 CLI 的差距集中在**真流式**（O-16/P20）、**中止贯穿**（O-20/A5）、**总时限→空闲看门狗**（O-19）三项，全部已入批6 且蓝图对照表 #1/#4/#5 结论成立。
3. RW 相对 CLI 的**有意差异**（不照做）：假完成打回（对照表 #9）、失败/空答平台兜底留痕（对照表 #10）、轨迹/审计落库 UI、Web 特有输入队列与草稿隔离——均为 RW 信任契约/单用户 Web 场景的合理增强，建议保留。
4. 现象差异（非差距）：思考按合帧进折叠区 vs CLI 终端逐字；正文不进活动环（旁观取最终+事件卡）；渠道（微信/飞书）无流媒体整包回发（蓝图自审注①）。
5. 未核完项：I-4 B1 计费口径（需 10 厂商 include_usage/usage 字段实测矩阵）、J-6 conv184 原始场景（需对话原文）——已标 🔍待核，不阻塞批6 阶段一其余项。
