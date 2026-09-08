# RW 可封装 Agent · 行业自审与 ①壳-核分层收口（版 v1 · 待审阅）

> 状态：✅ **已定稿 v1**（2026-09-08 用户确认；壳定义 schema 冻结 v1）
> 日期：2026-09-08 · 依据：用户确认的方向（无身份核心+壳定义一键装配）+ 后台调研 e5db7f88（行业成熟 Agent 平台：OpenAI/Anthropic/Salesforce/微软/Google/Coze·百炼·元器·智谱/OpenRouter/ServiceNow）
> 关联：`proposals/壳核分层总体架构-需求文档-v0.1.md`（决策表 D1/D2/D5✅ + 附 A-F 底稿）、差距基线（对话 2026-09-08）

---

## 0. 目标（用户确认，一句话验收）

**不改核心代码 → 壳主写一份"壳定义"（身份/领域/工具/模型/知识/权限）→ 一键装配 → 该壳里的 RW 立即以壳的语境与能力工作，且对话/思考/工具/护栏/计量/审计核心机制全部照常。**

## 1. 行业自审结论（对照"成熟 agent 服务商怎么做"）

### 1.1 行业共性：三层分离（引擎 / 壳定义 / 运行时）
| 层 | 内容 | 代表 |
|---|---|---|
| 引擎层 | 推理循环/工具调度/上下文/模型路由，**无业务身份** | OpenAI Agents SDK、Foundry Agent Service、我们的 runAgent |
| 壳定义层 | 指令+人设、工具清单、知识源、护栏/审批策略、默认模型与路由偏好、渠道——**是一个可序列化配置对象** | GPTs、Claude 的 CLAUDE.md/Skills/Subagents（随 git 版本化）、Agentforce 声明式元数据、Coze/百炼 Bot 应用（Open API 可程序化创建+一键分享） |
| 运行时层 | 会话/配额/观测/发布/分发 | 各平台控制台；我们的 usage/审计/scheduler/channels |

**启示**：把"壳定义包"做成正式产品公民（声明式 schema + import/export/clone/version + 引擎按包实例化）。**一个引擎可同时以多壳身份运行；壳间只共享引擎二进制、不共享定义。**

### 1.2 最值得抄的两个范式
1. **Claude Code："定义以文件住在项目里"**（CLAUDE.md + skills/ + .claude/agents/*.md + 权限 settings/hooks 随仓库版本化）→ RW 的壳包天然可走 git 版本化；
2. **Agentforce："壳的元数据生命周期 + 评测门禁 + 质量指标"**（Agent=Instructions+Topics+Actions+Guardrails；发布前 Testing Center 评测集回归；Analyzer 质量指标：围堵/转人工/解决率）→ RW 的壳包内嵌金标评测集、改壳/换模型先回放对比（canary），每壳质量报告、人工复核回流评测。

### 1.3 可观测三机制（直接可抄）
- 结构化 trace 一步到位（OpenAI/Foundry：每步模型调用/工具入参出参/token/耗时/成本 + 会话回放 + OTel 导出）→ RW 已有 usage/tool_calls/audit，补"按壳可查的回放视图"即可；
- 评测集+回归门禁（Agentforce Testing Center / Foundry 离线评测）→ 壳包带 golden 集；
- 质量仪表板+人工反馈回收（Analyzer / CSAT）→ 复测放行/打回数据回流为质量信号（与我们的 E1-E3/观测式评测天然同构）。

### 1.4 我们不必学的（SaaS 专属）
多租户计费、商店分成、全球多渠道矩阵、云上统一观测、零保留合规。

### 1.5 我们反而更该坚持的（自托管优势）
数据不出域、可离线、审批精确到命令/工具参数（hooks/access_rules 现成）、进程/壳级隔离与全量审计、**壳包 git 版本化 + 评测集随包**、无供应商锁定（壳只声明模型偏好，引擎按策略解析——OpenRouter Presets 同款思路）。

## 2. 差距修订（在原 10 项基线上的增补，均来自 §1）

| # | 原缺口 | 行业修订/增补 |
|---|---|---|
| 1/2 | 身份注入接缝；壳定义缺失 | 壳定义=**声明式 pack（见 §3）**；身份 persona 可空（中性），Claude 式"文件随项目"可选实现 |
| 3 | 工具注册表化 | 明确：**工具/MCP/连接器以 manifest 入 pack.tools**；引擎只按包暴露（壳间不共享启用面） |
| 4/5 | 画像路由/意图 | 模型偏好是**壳包字段**（default+allow_models+质量-成本偏好），引擎按策略解析——路由决策留在引擎层、策略留在壳层（OpenRouter/Agentforce 同款边界） |
| 6 | 知识按壳 | 知识源**显式绑定**在 pack.knowledge（global+shell+project），随包可携带导入清单 |
| 7 | 观测/评测 | 增补：**pack.eval 金标评测集 + 发布前回放回归（canary）+ 每壳质量报告**（§1.2/1.3）——这就是 ⑤模型测评的壳级形态 |
| 9 | 管理面 | 统一后台管壳目录/勾选/用量/评测；壳包 import/export/clone 即其核心操作 |
| 10 | 一键部署 | 壳包 = packs/apply-pack 的升级：**校验 schema → 建壳 → 会话装配即生效**；Claude 式可再落 git |
| 新 | — | **护栏/审批策略随包**（pack.guardrails：access_rules+审批模式），审批可精确到工具参数（我们强项） |

## 3. ①壳定义（Shell-pack）最小字段集 v1（草案 schema）

```jsonc
{
  "shellPackVersion": 1,
  "key": "code",                    // 唯一；default=系统保留（中性壳）
  "name": "代码壳",
  "description": "",

  "identity": {                     // 可空：空=完全中性（默认壳语义）
    "persona": null,                // 人设文本（有壳才注入；长度/占位符检疫）
    "tone": "", "forbidden": []
  },

  "domain": {                       // 领域语境
    "agendsText": "",               // AGENTS 式领域说明（或引用 AGENTS 路径）
    "terms": []
  },

  "modelPolicy": {                  // 引擎解析，壳只声明偏好
    "defaultProvider": "", "defaultModel": "",
    "allowModels": [],              // 空=全部启用模型
    "budgetYuan": 0,                // 0=跟随全局
    "qualityCostBias": null         // 0-10 质量-成本偏好（OpenRouter Auto Router 同款；null=不启用画像路由）
  },

  "tools": {                        // 三层：底座 preset + 强制增删 + 插件(manifest)
    "presetBase": "standard",       // minimal | standard | all
    "forceOn": [], "forceOff": [],  // GUARDED 高危默认建议 forceOff（可人工放开）
    "mcps": [], "connectors": []    // 插件项（MCP 配置引用/连接器适配器引用）
  },

  "knowledge": {                    // 知识源显式绑定
    "scopes": ["global", "shell"],  // conv 不随包；shell=本壳知识库 scope
    "importRefs": []                // 随包导入的知识清单（文档/表格，L2）
  },

  "skills": { "allow": [], "defaultsAutoLoad": [] },   // 技能白名单+开工自动载

  "guardrails": {                   // 随包的护栏/审批策略（引擎强项）
    "accessRules": [],              // allow/deny 正则（复用现有规则层）
    "approvalMode": "default",      // default | every-action | whitelist(工具白名单免审)
    "sensitiveDefaults": []
  },

  "channels": { "domainHosts": [], "bindings": {} },   // 域名/微信/飞书（壳绑定）
  "uiBrand": null,                  // 名称/主题（可选，后置）
  "eval": { "goldenSetRef": null }  // 金标评测集引用（改包/换模型前回放，canary）
}
```

### 3.1 壳包 git 版本化 · 实现说明（2026-09-08 用户问答后确认补入）

**为什么**：壳定义是"要长期演进、多机协作、能回滚"的配置资产——git 提供 diff（改了什么）/ tag（可引用版本）/ revert（回滚）/ branch（试验）/ PR 评审 / push-pull（多机同步=一键在别处开用的传输通道），审计可记"当前装配 @ commit"。参照 Claude Code：CLAUDE.md + skills + subagents 以文件住进项目仓库随 git 版本化。

**目录形态（每个壳=一个目录，目录名=壳 key）**：
```
shellpacks/（git 仓库，可独立或并入主仓库）
├── code/pack.json            ← 壳定义主文件（本 schema）
├── code/AGENTS.md            ← 领域说明（可选）
├── code/skills/…/SKILL.md    ← 壳专属技能（可选）
├── code/knowledge/import/…   ← 随包知识导入源
├── code/eval/golden.jsonl    ← 金标评测集（canary）
└── scm/…  video/…            ← 其余壳
```
引擎侧部署目录 `RW_SHELLPACKS` = git clone 的工作区，装配时读取。

**文件-DB 双层（不冲突）**：git 内 pack.json=权威副本（史书：diff/tag/回滚/同步）；装配器（校验 schema+占位符检疫）落地为 DB 的 shells/shell_tools/shell_settings=运行时现况（引擎查询用）；每次变更在 audit_log 记 `shell_pack_applied commit=xxx`（可复现）。与 hello"业务真相=文件+MySQL 镜像"原则同构。

**生效链路**：改 pack.json → commit → 引擎 reload（复用 policy_rev 机制，最快 5s 新会话生效）→ DB 镜像同步。v1 采用"文件=权威、DB=镜像"双写；完全文件驱动（读时解析、DB 只存派生）列为远期选项。

**渐进三档落地**：档1 = 统一后台"导出壳"生成 pack 目录 / "导入"装回，git 仓库手动 commit；档2 = 装配器以 `shellpacks/<key>/pack.json` 为源 + DB 镜像 + watch 变更自动 reload；档3（远期）= 多实例共享远程 shellpacks 仓库 + 版本钉住（实例钉 tag 不追新）+ 壳变更 PR 评审流。

**装配流程 v1**（引擎不变，新增"壳包装配器"）：
```
写包(pack.json) → import/校验(schema+占位符检疫) → upsert 壳行+壳设置+壳工具三态
→ 会话创建带 shell_key → 引擎按包执行：身份注入(persona 空则中性)/知识过滤/技能白名单/
  工具面(preset∩force∩插件)/模型解析(显式>壳默认>画像)/护栏(access_rules+审批模式)
→ 自检冒烟(新壳一个代表任务) → 输出装配报告（含 10 分钟验收单）
```
**验收（10 分钟新壳可用）**：克隆 code 壳→改名改 persona→改 tools.forceOff→改 modelPolicy→改 domainHosts→save→新会话验证：语境生效/被禁工具不可用/模型按策略/审计与用量带壳 ID/中性壳无 persona 回归通过。

## 4. 三件套去留声明（✅ 已确认 2026-09-08）

**保留为底稿**：`壳核分层总体架构-需求文档-v0.1.md` 的决策表（D1=方案 D 先 D 后 A、D2=885→code.ronisyn.com、D5=L2 不出服务器）+ 附 C（连接器三层：引擎+适配器注册表+壳勾选）+ 附 E（Issue=任务真相、打回必填原因、拆子 issue、观测式评测口径）+ 附 D（直接/工单两模式、谁执行谁遵守）。
**升级/吸收**：差距基线 10 项 + §2 修订 → 本文件 §2/§3。
**作废（不再讨论）**：附 F 系列 code 壳 UI/IA 与原型（v1/v1.1/v2 HTML）；885 植入"封装面五件/headless/Q1-Q4"框架（未来做 885 对接时以本收口的壳包+现有 SSE 事件为接口即可，不必另立架构）。
**后置**：统一后台 UI、意图重构、任务档案路由、知识库 L2、任务资产市场、企业级工具链——均以"壳包"为装配单元逐个展开。

## 5. 状态与下一步（2026-09-08 更新）

✅ **①壳-核分层收口已完成并定稿**：壳定义 schema（§3，含 §3.1 git 版本化实现说明）冻结 v1；去留声明确认（§4）；本文件转「已定稿」。

**下一步候选（按依赖顺序，待你选择）**：
1. 进入 **②意图重构**（对话层根本，推荐下一题）；
2. 先做**壳包装配的最小代码原型**（把 §3 schema + §3.1 装配器做出可跑的最小闭环，验证"10 分钟新壳可用"）——需你明确"可以出码"；
3. 其它你点名的议题（③任务档案路由 / ④知识库 / ⑤模型测评 / ⑥任务资产市场 / 统一后台）。
