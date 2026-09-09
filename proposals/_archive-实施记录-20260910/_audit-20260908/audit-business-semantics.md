# 业务语义一致性审计

> 审计对象：`proposals/RW-Agent平台化改造总方案-v2.16.md`（定稿承诺）vs 代码实现（`server/`、`src/`、`shellpacks/`、`templates/`、`apps/`、`test/`）
> 方法：只读核对（read/grep/glob），未运行任何会改库/E2E 的用例，未改动任何文件。
> 严重度：P1=语义冲突/承诺落空且影响业务正确性；P2=口径分歧或文档-实现不一致但当前行为恰好一致/可后置；P3=注释/文案/次要口径。

---

## 语义冲突/不一致（P1/P2/P3）

### F1【P1】壳 `modelPolicy` 引擎零消费：三级路由的"壳默认"缺环，壳级 `budgetYuan` 叠加预算永不生效
- **文档引用**：§3.1 modelPolicy（defaultProvider/defaultModel/allowModels/budgetYuan/qualityCostBias，说明"壳声明偏好，**引擎解析**"）；§6.2 路由三级"显式指定（绝对锁）> 档案建议 > **壳默认**"；§8 预算分层"壳级预算=pack `modelPolicy.budgetYuan` **叠加生效**（壳上限可收紧、不高于全局语义）"。
- **代码位置**：
  - `/api/chat` 路由：`server/index.js:447-472`——只消费 body/会话列（provider/model）、settings `default_models`（451）、档案（454-469）；壳行查询（494）只取 `skey, persona, domain_text, intent_rules`，全程不读 `model_policy`。
  - 预算：`server/agent.js:140-162/344-401` 只读 settings `task_budget_yuan`/`task_budget_total`；`index.js:713-720` 只算会话 24h 总账。无任何壳预算参数。
  - `model_policy` 的全部写入点 = `server/shells.js:68,107`、`server/shellstore.js:82-86`（存储/导出），全库无运行期读取点。
- **不一致描述**：① 档案未命中且未显式选模型时，回落的是**引擎全局 auto 默认**（deepseek/settings 默认），不是壳声明的 defaultProvider/defaultModel——三级路由实为"显式>档案>全局自动"，"壳默认"一级缺位（code 壳因恰好与全局默认同值而未被察觉）；② 壳 `budgetYuan` 只进 JSON 不进预算判定，§8"叠加生效、壳上限可收紧"落空；③ `allowModels`/`qualityCostBias` 无任何消费点。M2 1.3"设置壳默认模型"只是 UI 存值 + 导出，不改运行行为。
- **建议**：`/api/chat` 在"无显式且档案未命中"时把壳 modelPolicy 作为第三级；预算侧把壳 budgetYuan 以 `min(壳上限, 全局/会话剩余)` 并入 `__budgetRemain` 语义；或在文档中把 modelPolicy 运行接线明确标注为后置（v2），并删除"引擎解析/叠加生效"的定稿表述。

### F2【P1】shell pack 往返（export→import→export / clone）不保真，字段静默丢失
- **文档引用**：§3.1 字段集 v1"扩展只增不改"（含 identity.tone/forbidden、domain.terms、tools.mcps/connectors、skills.defaultsAutoLoad、guardrails.approvalMode/sensitiveDefaults、channels.bindings、uiBrand、credentials）；§3.2 "文件为权威、DB 为镜像，双写"；M2-① `GET /api/shells/:key/export`（DB 镜像→pack 导出）；附录 D B1 自测"克隆继承"。
- **代码位置**：`server/shells.js rowToPack:98-116`、`packToRow:57-81`、`server/shellstore.js cloneShell:55-66 / exportShell:94-98`。
- **不一致描述**（export(code)→import→export 与原 pack 的实测差异，纯代码推演）：
  1. **`uiBrand` 整体丢失**：DB 有 `ui_brand` 列（packToRow:76 写入），但 rowToPack 的输出对象**根本不包含 uiBrand 键**——任何带 uiBrand 的 pack 经 clone/export 即永久消失。
  2. `identity.tone`（code pack 为 `"直接、结构化"`）→ 导出变 `''`；`domain.terms`、`tools.mcps/connectors`、`skills.defaultsAutoLoad`、`guardrails.approvalMode/sensitiveDefaults`、`channels.bindings`、`knowledge.importRefs` 全部被常量重置（`[]`/`'default'`/`{}`），与原 pack 的显式值不等。
  3. `shellPackVersion` 恒输出 1（rowToPack:101），导入 v>1 pack 再导出会降版本。
  4. `credentials`（v1.2 可选，§8 预留引用）：PACK_ALLOWED_KEYS 收容、validatePack 不校验、无 DB 承载、rowToPack 不输出——声明即丢弃。
- **建议**：export/clone 必须走 rowToPack 时补回 `ui_brand` 与真实 `shellPackVersion`；对无 DB 列承载的字段（tone/terms/…/credentials）在 export 输出中保留原 pack 值或明确列入"已知不保留清单"并由导入侧告警；round-trip 应有单测断言（现 shells 自测只覆盖三态继承）。

### F3【P1】壳 pack 多组字段"存储即终态"，§3.1 声明的随包语义无运行接线
- **文档引用**：§3.1 guardrails（accessRules/approvalMode/sensitiveDefaults"护栏与审批策略随包"）、skills（allow"白名单"+defaultsAutoLoad"开工自动载入"；解析路径=全局技能目录+壳自带目录）、knowledge（scopes/importRefs"知识源显式绑定"）、tools.presetBase/forceOn、channels/uiBrand；§3.4 装配"按包执行（身份/知识/技能/工具面/模型/护栏）"；§4 护栏与审批"随包"。
- **代码位置**（全库 grep 各列仅出现于 shells.js/shellstore.js 的读写，无运行消费）：
  - `guardrails` 列：无任何 hooks/execTool 消费；运行规则只有 **settings 全局** `access_rules`（`server/tools/hooks.js:78-101`、`index.js:729-731`）。
  - `skills_allow`：只被 `index.js ensureProfileOnShell:1363-1380` 追加；`skill_load`（`server/tools/index.js:852-867`）**无白名单校验**——壳 allow 之外的技能照样可载入；`defaultsAutoLoad` 无自动载入实现；壳自带技能目录（pack 级 skills 随壳）不存在第二查找根，运行时唯一技能根 `SKILLS_ROOT`（tools/index.js:39）。
  - `knowledge_scopes`/`importRefs`：只存储；会话可见性完全由 knowledge 行自身 scope+shell_id 决定（与壳声明无关）。
  - `tools_preset`：暴露面由**会话** preset（conversations.preset）决定（index.js:485、agent.js:369-371），壳级 presetBase 不参与；`forceOn` 仅存 shell_tools mode=force_on 行，`agentCtx.shellToolsOn`（index.js:732）赋值后无人读取。
- **不一致描述**：除 persona/domain/force_off/intentRules/taskProfiles 外，v1 壳包大半字段是"存储/导出/UI 值"，运行时不产生 §3.1 描述的语义（护栏、技能白名单与自动载入、工具面 preset∩force、壳知识源）。附录 D B1 边界只承认"runAgent 工具面 preset∩force 全量过滤…属后续批次"，其余字段的接线缺口文档未标注——正文承诺与实现系统性落差。
- **建议**：文档新增"壳包字段运行接线状态表"（已接线/仅存储/后置），把 guardrails 审批策略、skills 白名单+自动载入、工具面按壳过滤列入后置批次并注明依赖项；若"技能白名单"属安全语义（allow 之外不可 load），建议优先接线。

### F4【P2】意图 `ask` 标签不是"询问"：无行为门禁，模型看不到标签
- **文档引用**：§6.1"输出标签…未判定时**询问用户**（不猜、不假答应）"。
- **代码位置**：`server/intent.js:36-39`（ask 仅 echo 文案"你先说一声，我再开始"）；`server/index.js:662-671`（ask 只发 SSE `intent` 事件 + 审计，标签不写入 messages、不传给 runAgent）；runAgent/needsTools 均不感知 intent 标签。
- **不一致描述**：命中 ask（如"这个玩意能弄不"）后对话照常继续、模型照常可调工具——没有等待用户澄清的门禁，回显与实际行为脱节（用户看到"先别动"，模型可能已动手）。与"询问用户"承诺不符。
- **建议**：ask 命中时在 agent 层先产出澄清问题并暂停到用户回答（复用 ask_user/asks 机制），或将文档语义改为"仅旁路提示、v2 实现真询问"。

### F5【P2】`intentRules` schema 四组 vs 实现三组：`chatOnly` 缺失；壳级词表"按 key 回落"语义未文档化
- **文档引用**：§3.1 表 intentRules（v1.1 可选）"do / highRisk / readonly / **chatOnly**"。
- **代码位置**：`server/intent.js:20-26` 只处理 highRisk/readonly/do；`server/shells.js:78` 原样入库但不校验键；全库无 chatOnly 消费；`shellpacks/code/pack.json:39-43` 亦只三组。
- **不一致描述**：文档声明的 chatOnly 词表无实现（闲聊·收尾恒由兜底规则输出 chat，无法按壳定制"只收尾不做事"语义）。另：壳级 rules 缺某组时会**按 key 回落** DEFAULT_INTENT 对应组（intent.js:23-25），即"部分覆盖"，文档未写明是整表替换还是按 key 合并——两处对"壳覆盖默认"口径需明确。
- **建议**：补 chatOnly 或从 schema 移除；文档写明"缺省组=回落默认词表"。

### F6【P2】`kbVisibleWhere`"统一出口"未兑现：会话可见性谓词在 4 处内联手写
- **文档引用**：附录 D ④（line 272）"`kbVisibleWhere`（会话可见 SQL **统一出口，防漏 WHERE**——F19 注入/kb_search/kb_del 共用）"。
- **代码位置**：`server/knowledge.js:8-25` 定义了 kbVisibleWhere，但全 server 无 import（grep 仅 `test/knowledge.test.mjs` 引用）；实际手写同构谓词处：F19 注入 `server/index.js:544`、kb_add 去重 `server/tools/index.js:605`、kb_search `:632`、kb_del `:641`；管理列表 `index.js:1285-1294` 又是另一套条件。
- **不一致描述**：文档/模块注释声称的"共用出口"不成立。当前 4 处语义恰好一致（含 `shell_id<=>?` 与 default 壳禁私有语义），但改口径时必然漏改，防漏 WHERE 承诺落空。
- **建议**：F19/kb_* 统一改调 kbVisibleWhere（ctx 需携带 accountId/conversationId/shellKey→shellId），并让单测覆盖真实 SQL。

### F7【P2】default 壳兜底词表未按 §3.3 "迁移进 default 壳 pack（文件权威）"落位
- **文档引用**：§3.3"现 `TOOL_INTENT_RE` 兜底常量**迁移为 default 壳 pack 的内置 intentRules**（文件权威），运行时读 DB 镜像"。
- **代码位置**：`shellpacks/` 下只有 `code/`，**无 `shellpacks/default/pack.json`**；db.js:397-402 的 default 壳种子不含 intent_rules（NULL）；兜底词表常驻代码 `server/intent.js DEFAULT_INTENT:7-11`；`server/index.js:345` 的 `TOOL_INTENT_RE` 也未删除（改作 needsTools/light schema 判定，双轨并存）。
- **不一致描述**：行为语义与文档一致（无规则→默认兜底），但载体违背"pack 文件权威 + DB 镜像 + git 管理"：默认词表改一处代码即变，无法随壳 diff/版本化；TOOL_INTENT_RE 与 DEFAULT_INTENT 两词表并存是残余双轨。
- **建议**：新增 `shellpacks/default/pack.json`（intentRules=DEFAULT_INTENT 内容）并在 import 默认壳时落库；index.js:345 词表仅保留给 needsTools 或明确其职责边界。

### F8【P2】高危→guard 联动已实现，但文档（附录 B2 边界/M1 记录）未回填——文档滞后于代码
- **文档引用**：附录 D B2"边界"：**"高危→审批强制执行（guard/access_rules 映射）…随 M 系列/后续批次"**；M1/M2 记录未提及该能力。
- **代码位置**：`server/index.js:662-665/732`（act-high → `agentCtx.permission='guard'`，仅当会话原 permission='full'）；审批门禁 `server/tools/index.js:1093-1121`（GUARDED_TOOLS 7 项 + access_rules allow 短路）。
- **不一致描述**：能力先于文档落地（文档仍写"未实施/随 M"）。实现细节两个附带口径问题：① 仅 `permission==='full'` 会话降级，read/write/guard 会话命中高危无任何联动（文档未限定）；② 身份层与执行层不一致——runAgent 的 `permission` 形参仍传原 full（agent.js:175-184 注入"当前会话权限=full"），而执行判定用 ctx.permission='guard'、快照显示 guard（agent.js:250）——模型被告知 full、行为按 guard，易误判。
- **建议**：附录 D 补记 B2 高危→guard 已实施的提交与验收；guard 降级时把 ENV_IDENTITY 一并按 guard 注入；明确 read/write 会话高危命中语义。

### F9【P2】`intent_samples` 表与纠错沉淀链路缺失（§8 新增表承诺未落地）
- **文档引用**：§8 新增表列表含 **intent_samples**（意图回显/纠错样本：原文、命中结果、用户纠正、壳）；§6.1"纠正沉淀为 intentSamples"；附录 M1 边界"纠错/意图样本沉淀随 M2"。
- **代码位置**：db.js（表清单+迁移）无 intent_samples；全库无 intentSamples/intent_samples 代码；Chat.jsx 灰字行无"纠正/沉淀"交互；M2 记录（附录 D M2 部分）也未实现该功能。
- **不一致描述**：§8 把 intent_samples 列为新增表（幂等迁移），但代码既无表也无采集；唯一"承诺延期"依据是 M1 边界一行"随 M2"，而 M2 交付内容里没有它——链路（回显→用户纠正→样本→命中率信号）整体断缺，§11"纠错样本"数据源为空。
- **建议**：实现最小样本表与灰字"纠正"按钮（M2 补丁），或在文档中把 intent_samples 明确降级为"后置未排期"并从 §8 已承诺表中划出。

### F10【P2】审计脱敏规则未覆盖非工具类审计行（违反 §8"审计/落库沿用 redactSecrets 规则"）
- **文档引用**：§8"**审计脱敏**：审计/落库沿用现状 `redactSecrets` 规则（sk-/ghp_/Bearer 等）"。
- **代码位置**：`redactSecrets`（`server/tools/index.js:34-35`）只被工具审计使用（index.js 工具调用处 tools/index.js:1143-1147）；intent 审计（index.js:668-669 含原文 sample）、route 审计（676-677）、knowledge:import（1328 文件名）、review（1249 bug_reason 原文）、template:prompt/app:launch、shell ops 等 audit_log 行 detail 均未脱敏。
- **不一致描述**：用户消息/原因/文件名若含 sk-*/ghp_*/Bearer 形态，会以明文进入 audit_log（intent/route 的 sample 即用户原文 120 字符）。§8 表述为全量审计脱敏，实现只覆盖工具路径。
- **建议**：在 audit_log 统一写入处（或 db 层 helper）对 detail 统一过 redactSecrets；补非工具类审计脱敏自测。

### F11【P2】会话所属壳被停用后：persona/intent 静默回落，而档案层意外套用预设档案 DEFAULT_TASK_PROFILES
- **文档引用**：停用语义（§/附录 D：disable 保留可恢复）；"显式点名才触发档案"（§6.2/附录 B3）。
- **代码位置**：`server/index.js:492-499`（壳查询带 `status="enabled"`，停用→sr 空→convShellCtx=null，persona/intent 回落为无壳）；但 **454-458** 同样查 enabled 壳的 task_profiles，pRow 为空 → `resolveTaskProfile(content, undefined)` → `server/profile.js:12` 回退 `DEFAULT_TASK_PROFILES`（code 壳预置的 small-fix 等）→ 档案命中即改写 wantProvider/Model（461-466）。
- **不一致描述**：停用壳的存量会话既无壳 persona/intent，却又会"按 code 预设档案"自动路由——同一次对话里壳语义被部分摘除、档案却仍生效，口径自相矛盾（档案生效条件本应是"该壳启用的 task_profiles"）。
- **建议**：壳不存在/停用时跳过档案解析（无 profiles 就不调 resolveTaskProfile），并文档化"停用壳会话=完全回落无壳语义"。

### F12【P2】预置任务档案三处复制（DEFAULT_TASK_PROFILES / code pack / 模板）→ 漂移风险
- **文档引用**：§6.2 预置（code 壳）small-fix/refactor-plan/feature-delivery。
- **代码位置**：`server/profile.js:3-7` DEFAULT_TASK_PROFILES；`shellpacks/code/pack.json:34-38` taskProfiles；`templates/{small-fix,feature-delivery}/tpl.json` 又含 small-fix/feature-delivery 的同结构 taskProfile。三份内容同构但无同源约束/同步测试。
- **不一致描述**：代码运行路径中 DEFAULT_TASK_PROFILES 仅在"真实壳但 task_profiles 为空/查不到"时生效（同 F11），其内容却恒等于 code 包预置——同一"预置档案"概念存在 3 个权威副本，改一处（如给档案加 match 词）其余两处静默过期。
- **建议**：profile.js 默认值改为从 shellpacks/code/pack.json 读入（单一权威），或加三源一致性单测。

### F13【P2】`usage_stats` 旁路行（summary/title）不带 shell_id：壳维度对账漏旁路消耗
- **文档引用**：§8"usage_stats/audit_log/tool_calls 增 shell_id（档案/难度主落 usage_stats…）"；附录 C B1"usage(round/续写/折叠)/tool_calls/audit_log 落 shell_id"。
- **代码位置**：round（agent.js:394-395）、续写（agent.js:432-433）、collapse（agent.js:321-322）均带 shell_id；但 summary（`server/tools/index.js:921-922` conv_summarize 路径）与 title（`server/autotitle.js:34-35`）插入**无 shell_id 列**（恒 NULL）。
- **不一致描述**：按壳对账/§6.4 归集会漏掉摘要与自动标题这两类旁路 LLM 消耗的壳归属（虽然观测口径正确排除它们）。
- **建议**：旁路计量行补 shell_id（需从会话带出壳 id），或文档明确"旁路不计壳归属"。

### F14【P3】前端"保存默认模型"会清零同一壳已存的 allowModels/budgetYuan/qualityCostBias
- **文档引用**：M2-①"PATCH /api/shells/:key 扩 modelPolicy（壳默认模型/allowModels/budgetYuan **归一落 JSON**）"。
- **代码位置**：`src/console/ShellDev.jsx:83-85` 只提交 `{defaultProvider, defaultModel}`；`server/shellstore.js:82-86` patch 时把 model_policy 整对象重写为"其余键取默认"（allowModels=[]、budgetYuan=0、qualityCostBias=null）。
- **不一致描述**：若壳 pack 已设 allowModels/budgetYuan，1.3 改一次默认模型即把它们冲掉；"归一落 JSON"语义被前端半量提交破坏。
- **建议**：patchShell 做对象合并（读旧值→仅覆盖传入键），或前端整包回传。

### F15【P3】Dashboard"壳预览"计数含 default，与"default 不计"口径文案冲突
- **文档引用**：附录 M1 B"壳预览（/api/shells，**default 不计**）"。
- **代码位置**：`src/Dashboard.jsx:160` `已启用 {shells.length} 个`（含 default），`:162` 展示时才 `filter(skey!=='default')`。
- **建议**：计数与展示同口径。

### F16【P3】intent 审计"chat 无回显不落审计"与 §6.1"仅入 audit"表述存在未文档化例外
- **文档引用**：§6.1"灰字回显…仅入 audit"。
- **代码位置**：`server/index.js:667` `if (cl.label !== 'chat' || cl.echo)`——label=chat 且无 echo（纯闲聊）不落 audit。闲聊·收尾是正式输出标签之一，但其识别结果不可审计（无法统计"闲聊误判/闲聊率"）。
- **建议**：文档注明"仅产生灰字回显的意图入 audit"；若要 §11 命中率信号，chat 也应入样本。

---

## 双轨/冗余实现

### R1【P2】同一"会话可见知识"谓词 4 处内联 + 1 个无人使用的统一出口（见 F6）——同类 SQL 的重复实现
`index.js:544`、`tools/index.js:605/632/641` 各自手写 `(scope="global" OR (scope="shell" AND shell_id<=>?) OR (scope="conv" AND conversation_id=?))`，`knowledge.js:8-25` 的统一出口只在测试里被调用。

### R2【P2】预置档案三副本（见 F12）
`profile.js DEFAULT_TASK_PROFILES` ↔ `shellpacks/code/pack.json taskProfiles` ↔ `templates/*/tpl.json taskProfile`。

### R3【P3】意图词表双轨：`TOOL_INTENT_RE`（index.js:345，needsTools/light 判定）与 `DEFAULT_INTENT`（intent.js:7-11，意图分类）两套正则并存；文档 §3.3 称"迁移"，旧常量实际未删
语义上各自为政（needsTools 判"是否任务宽 schema"，classifyIntent 判四标签），但两词表无同源校验，改词时需记住两处。

### R4【P3】usage 计量四处分散手写 INSERT（round/collapse/续写 in agent.js；summary in tools/index.js summarizeConversation；title in autotitle.js），kind 字符串硬编码
观测口径依赖 `kind IN ('round','collapse')` 字符串精确拼写（index.js:785），无注册表约束——新增旁路若漏 kind 会被静默计入执行口径（当前 4 类 kind 拼写正确，属风险非现状缺陷）。

### R5【P3】default 壳语义双表示：DB default 壳行（db.js:397-402，persona NULL）+ 代码常量 DEFAULT_INTENT（见 F7）；"中性=无 persona"与"无壳会话（shell_id NULL）"两种"默认"在 telemetry/knowledge/route 中各走各的分支（`shell_id<=>?` 用 NULL 区分），口径易混。

---

## 文档承诺但未实现 / 已实现但文档未提

### 未实现（或实现载体与承诺不符）
| # | 承诺（文档节） | 现状 | 位置 |
|---|---|---|---|
| U1 | intent_samples 表+纠错沉淀（§8/§6.1） | 无表无链路（见 F9） | db.js 全表 |
| U2 | default 壳 intentRules pack 文件权威（§3.3） | 无 default pack、常量在代码（见 F7） | shellpacks/ |
| U3 | modelPolicy 引擎解析 + 壳预算叠加（§3.1/§8） | 仅存储（见 F1） | index.js:447-472、agent.js:344-401 |
| U4 | guardrails/skills.allow/defaultsAutoLoad/工具面 preset∩force/知识 scopes 随包生效（§3.1/§3.4/§4） | 仅 force_off 与 persona/domain/intent/taskProfiles 接线（见 F3；工具面部分被附录 D 边界承认后置） | 全库 grep |
| U5 | intentRules.chatOnly（§3.1 v1.1） | 无实现（见 F5） | intent.js |
| U6 | 任务难度人工勾选（§6.2，小/中/大） | 仅预留 difficulty 列（恒 NULL），无 UI/API；附录已归 M 系列 | index.js:788-789、db.js:329 |
| U7 | 灰字"一键退回默认"已做（M1）✓；灰字纠错/意图样本交互（附录 M1 边界→M2） | M2 未交付 | src/Chat.jsx |
| U8 | 壳级技能目录（pack 自带 skills，"解析路径=全局+壳自带"§3.1） | 运行只有单一 SKILLS_ROOT | tools/index.js:39/852-867 |
| U9 | shell_settings（壳级覆盖）"装配流程 upsert 壳设置"（§3.4/§8 表） | 表存在但全库零写入零读取（死表） | db.js:313-319 |

### 已实现但文档未提（文档滞后）
- **高危→guard 审批联动**已在 index.js:732 + GUARDED_TOOLS 审批（tools/index.js:1093-1121）落地，附录 D B2"边界"仍写"随 M 系列/后续批次"，M1/M2 记录未回填（见 F8）。
- **回显灰字 UI**（M1 记录已含 ✓）与 **console 1.1-1.8 全部八板块**（M2 ✓）与文档一致，通过。
- `hooks_list/undo_checkpoint/repo_map` 等平台工具注册与 meta 一致（通过项见下）。

---

## 核验通过（语义一致）清单

以下重点项经逐行核对**一致**，供审计留底：
1. **意图分级顺序**：高危>只读>动手>兜底（ask/chat）与 §6.1 一致（intent.js:28-39）；壳级词表覆盖默认、优先级用例在 test/intent.test.mjs:26-30 成立；灰字事件不入消息正文/导出、仅 SSE+audit（index.js:666-669、Chat.jsx:493-494/903-915）。
2. **档案路由**：显式(body)>会话保存(C4 绝对锁)>档案建议（仅当壳会话且无显式）>auto；`resolveTaskProfile` 只做"按/用 X"式显式点名，未点名返回 none（profile.js:11-27、index.js:447-472）；档案供应商无 Key 跳过回落（461-466）；route 事件+审计带 shell_id（673-678）。
3. **知识库可见性**：global 全部 + 本会话真壳私有（default 壳无壳私有）+ 本会话 conv 的语义在 F19/kb_add/kb_search/kb_del/上传链四处**当前一致**（含 `shell_id<=>?` NULL 语义、convA/convB 隔离）；scope=shell 上传需启用中 shellKey（index.js:1306-1310）；xlsx 行结构化、txt/md 分段、json 数组与附录一致（knowledge.js）。
4. **观测口径**：chat 收尾在 runAgent 前取 usage_stats MAX(id) 快照、执行后仅归集 `id>快照 AND kind∈(round,collapse)`，COUNT>0 才落行（index.js:735-792）——summary/title 旁路（agent.js collapse、tools/index.js:921、autotitle.js:34 的 kind=summary/title）被正确排除；reviews bug 必填原因、会话归属校验、审计 review:<result>（index.js:1241-1252）；daily 视图与 API 过滤（db.js:405-411、index.js:1265-1279）。
5. **模板/应用**：templates/<key>/tpl.json 与 apps/<key>/app.json 结构与 D9 文档一致；launch=建会话(title=应用名,full/all)→返回 draft→前端跳 /chat 预填（index.js:1411-1432、AppsBoard.jsx:33-43、Chat.jsx:221-233）；ensureProfileOnShell 被 template apply 与 app launch 共用、同 key 覆盖/异 key 追加/技能去重（index.js:1363-1380）；default 壳拒装（1391）。
6. **平台常量一致性**：TOOL_META（63 项）与 TOOLS 注册（60+3 push=63）一一对应，无漏注册/多注册（tools/index.js:122-893/1154-1195 vs meta.js:5-72）；PLATFORM_EXEMPT 单一来源（meta.js:87），toolset UI/启停（index.js:135-160）、hooks enabled_tools_guard（hooks.js:178）、force_off 豁免（tools/index.js:1055）同源使用。
7. **技能引用名**：templates/apps 引用的 task-approach/acceptance-builder/self-audit 与 `packs/rw-core/skills/` 目录名及附录 C 服务器技能目录实测名一致（引用=目录名，无歧义）；风险仅为无"引用存在性"校验（引用悬空静默，属 P3 建议项）。
8. **force_off 拦截**：execTool 执行前拦截、平台豁免除外、MCP 工具同受约束（tools/index.js:1054-1057）；壳停用不可停 default（shellstore.js:69-73）。
9. **M1/M2 网页层**：登录默认落 `/`（总览首页）、`/chat`（?conv 直达）、`/console/*` 四组八项（src/App.jsx:32-63、console/Console.jsx:14-24）；1.6 Agent 广场=应用启动页+折叠模板库（AppsBoard.jsx）；Dashboard 组成与 §7.3 一致（迷你对话复用 /api/chat、日报 #4/周报 #3、壳预览 default 不计展示、待加入新模型卡）。
10. **删除级联**：会话删除级联 12 表含 model_telemetry/reviews（index.js:220），与附录一致。

---

## 统计

- 语义冲突/不一致（F1-F16）：**16 项** —— P1=4（F1-F4），P2=9（F5-F13），P3=3（F14-F16）
- 双轨/冗余实现（R1-R5）：5 项（P2×2、P3×3，均已在 F/R 间交叉计列）
- 文档承诺未实现（U1-U9）：9 项（其中 U1/U2/U3/U4/U5/U7/U8 与 F1-F9 主条目重复计列；独立补充 U6 难度勾选、U9 shell_settings 死表 2 项）
- 已实现文档未提：2 项（高危→guard 联动、回显/八板块一致性通过另列）
- 核验通过清单：10 组
- **最关键 3 条**：① F1 壳 modelPolicy（默认模型/壳预算）引擎零消费，三级路由"壳默认"与 §8 预算叠加是空承诺；② F2 shell pack import/export/clone 往返丢字段（uiBrand 整体丢失等），双写不保真；③ F3 壳包大半字段"存储即终态"（guardrails/技能白名单/工具面 preset∩force 等）与 §3.1 随包语义不符，且 U9 shell_settings 表为死表。
