# 43 · 接口与字段规格（岗位包 / 数字员工 / 数据视窗）

> **这份文档解决什么**：独立评审（施工队试读）的第一号阻塞——
> **"我不缺方向，我缺『这个字段叫什么、必不必填』"**。
> 实测：全库 44 份文档里，**只有 1 处写了"必填"，0 处写"选填"**；**岗位包连根级结构都没定义**，写解析器时不知道根节点名。
>
> **本文的性质**：**它是"能照着建表/写解析器"的规格**，不是设计讨论。**字段名以本文为准**（其他文档里叫法不同的，本文给对照）。
>
> 前置：`03`（岗位包九块，装什么）· `36`（生命周期，什么时候填）· `34`（数据视窗，怎么裁）· `37`（怎么生成）
>
> ⚠️ **状态**：**Day 7 首版，覆盖最关键的三个结构**。其余结构（会话 / 运行 / 交付物 / 契约 / 就业账本）**待补**——已登记在 §6。

---

## 0. 三条总则（先定，免得后面反复）

| 总则 | 内容 |
|---|---|
| **① 必填性只有三种标注** | **`M`（必填）** / **`O`（选填）** / **`M*`（条件必填，条件写明）**。**没有标注的一律视为未定义**，出现即缺陷 |
| **② 名字只有一个** | 同一概念**只有一个字段名**。本文给"旧叫法对照"，**实现时用本文的名字** |
| **③ 平台包与客户实例严格分开** | 岗位包**不含任何客户特有取值**（`03` §4.1 结构性内容客户不可改）。**看到客户名/团队名/邮箱/群名出现在岗位包里 = 缺陷** |

---

## 1. 岗位包（Role Package）—— 根级结构 ⭐ 之前完全缺失

### 1.1 它是什么形态

| 问题 | 答案 |
|---|---|
| 一个包 = 一个文件还是多个？ | **一个目录**（可打包成单文件分发） |
| 根节点名 | **`role_package`**（定死） |
| 文件格式 | **YAML**（对人可读；解析器按 YAML 1.2） |
| 主文件名 | **`role.yaml`**（定死） |

### 1.2 目录结构（定死）

```
<包目录>/
├─ role.yaml            # 主文件（本文 §1.3 的结构）      M
├─ prompts/             # 提示词正文（与结构分离，便于评审 diff）  O
│   ├─ system.md        # 系统层提示词                      O
│   └─ persona.md       # 身份与说话方式                     O
├─ schemas/             # 交付物字段定义（JSON Schema）      O
│   └─ <deliverable-id>.json
├─ resources/           # 参考资料、模板、示例集              O
└─ CHANGELOG.md         # 版本变更（`37` §7 的升级 diff 靠它）  O
```

**为什么提示词放独立文件**：**改措辞是最高频的动作**（`03` §4.1 的"表述性"），
放在独立文件里，**评审时 diff 只看那一个文件**，不会被结构噪声淹没。

### 1.3 `role.yaml` 根结构

```yaml
role_package:
  # ── 元数据 ──
  id: <字符串，全局唯一>                      # M  例：replenishment-planner
  version: <语义化版本>                       # M  例：1.2.0
  name: <岗位名>                              # M  例：备货计划专员
  lineage:                                    # O  血缘（`37` §6.1）
    based_on_skeleton: <骨架 id>              # O
    based_on_industry: <行业模板 id>           # O
    forked: <true|false>                      # M  派生包是否已分叉（`37` §5.3）

  identity: { ... }        # M  见 §1.4
  capabilities: { ... }    # M  见 §1.5
  permissions: { ... }     # M  见 §1.6
  deliverables: [ ... ]    # M  见 §1.7（至少一项）
  orchestration: { ... }   # M  见 §1.8
  triggers: [ ... ]        # M  见 §1.9（至少一种）
  runtime: { ... }         # M  见 §1.10
  model_policy: { ... }    # O  见 §1.11
  interaction: { ... }     # O  见 §1.12
  resource_profile: { ... } # O  见 §1.13（`37` §6.2）
```

### 1.4 `identity`（身份）

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | M | 岗位名 |
| `description` | M | 一句话职责 |
| **`boundaries`** | **M** | ⭐ **"我不管什么"的清单**。**结构性内容，客户不可改**（`03` §1.2：它是发权限的依据） |
| `persona_file` | O | 指向 `prompts/persona.md`（表述性，客户可覆盖） |

### 1.5 `capabilities`（能力）

| 字段 | 必填 | 说明 |
|---|---|---|
| `connectors` | M | 需要的连接器能力清单（**写语义能力名，不写具体系统/站点**，`39` §3.2） |
| `skills` | O | 引用的技能 id 列表 |
| `knowledge_sets` | O | 需要的知识集（`33` §4.3） |
| `tools.tier` | M | **工具分档**（`03` §1.4）：`basic` / `pro` / `high_risk` 的组合 |

### 1.6 `permissions`（权限）—— ⚠️ 只许"声明"，不许"写死"

| 字段 | 必填 | 说明 |
|---|---|---|
| `data_requirements` | M | **数据要求**：`[{dimension_class: <某类归属维度>, sensitivity: <敏感级>}]`。**不写具体维度名与取值** |
| `write_level` | M | 最高写级别：`L0`/`L1`/`L2`/`L3`/`L4`（`06` §2） |
| `egress` | M | 能否外发：`none` / `internal_only` / `allowlisted` |

> **旧叫法对照**：`数据视窗取值`（`36`）/`数据视窗`/`数据要求`（`03`）——**统一叫 `data_requirements`**，**取值层面的东西不在岗位包里**（在实例里）。

### 1.7 `deliverables`（交付物）—— 每项一个 map

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | M | 交付物类型 id |
| `schema` | M | 指向 `schemas/<id>.json` |
| `export` | M | 导出外观：`[xlsx]` / `[pdf]` / … |
| `state_machine` | M | **定死四态**：`草稿 → 复核中 → 已确认 → 已交付`（+`作废`）。**`03`/`28`/`38` 三处写法统一为此** |
| `visible_to` | M | 谁能看（权限，**不是送达**） |
| **`acceptance_criteria`** | **M** | ⭐ **验收标准**（`37` §4.1）。**缺失则不许发布**（质量门 G5） |
| `review` | M | `required` / `optional` / `none` |
| `explain` | M | `required` / `optional` |
| **`applicants`** | O | ⭐ **谁能提申请**（`38` §2 的"申请人"角色）。`{roles: [...], channels: [...]}` |
| **`delivery`** | M | ⭐ 送达声明（`38` §4）：`{base: 界面, push: [{channel_class, target_roles, timing, attachment}]}`。**只写渠道类与角色类，不写具体地址** |

### 1.8 `orchestration`（任务编排）

```yaml
orchestration:
  mode: parallel | serial | mixed        # M
  steps:                                 # M
    - id: <步骤 id>                       # M
      kind: subagent | tool | human       # M
      capability: <能力名>                 # M*  kind=tool/subagent 时必填
      depends_on: [<步骤 id>]              # O
  aggregate:                             # M
    strategy: merge | vote | first_valid  # M
```

### 1.9 `triggers`（触发方式）—— 至少一种

| 值 | 说明 |
|---|---|
| `manual` | 人手动 |
| `schedule` | ⚠️ **定时的实现在平台自研调度器**（`16` §1.1）——这里只声明"要定时"，**规则在实例里填** |
| `event` | 事件 |
| `api` | 接口 |
| `batch` | 批量（同模板 × N） |

### 1.10 `runtime`（运行环境）

| 字段 | 必填 | 说明 |
|---|---|---|
| `profile` | M | 沙箱规格名（`05` §1.1）：`pure_compute`/`read_only_fetch`/`dev_workspace`/`integration_test` |
| **`runtime_tier`** | **M** | ⭐ **运行时档**（`05` §1.2）：`R0`/`R1`/`R2`/`R3`。**默认 `R0`；客户岗位 ≤ `R2`** |
| `limits` | M | `{max_minutes, max_cost, max_concurrency}` |

> **旧叫法对照**：`上限（成本/时长/频次/并发）` vs `成本/时长/并发上限`——**统一为 `limits`，四项固定**（原来"频次"只在一处出现，归入 `triggers.batch` 的配置，不单独设字段）。

### 1.11 `model_policy`

| 字段 | 必填 | 说明 |
|---|---|---|
| `routing` | O | 分级：`{plan: <档>, extract: <档>}`（`30` §3） |
| `sensitivity` | M | 数据敏感级 → 决定可用模型范围（`30` §1.1） |
| **`engine.preferred`/`engine.fallback`** | O | ⚠️ **暂标"未启用"**——`architecture` §11.3 已定：一期只用 roni，路由规则与适配器契约待补。**字段留着，不写实现** |

### 1.12 `interaction` / 1.13 `resource_profile`

```yaml
interaction:
  form: chat | list                     # O  默认 chat
  confirm_where: in_app | im            # O  默认 in_app
resource_profile:                       # O  供 `22` 编排与 `05` 选规格用
  typical_duration: seconds | minutes | tens_of_minutes   # O
  parallelism: single | multi           # O
  data_volume: small | medium | large   # O
  suggested_profile: <沙箱规格名>         # O
```

---

## 2. 数字员工实例（Digital Employee）—— 客户侧配置

> **岗位包是模板（平台资产）**；**实例是"这家客户的这个员工"**。`03` §1.3、`36` §3。

### 2.1 字段表（含必填性 ⭐）

| 字段 | 必填 | 说明 | 谁填 |
|---|---|---|---|
| `id` | M | 实例 id | 系统 |
| `workspace` | **M** | 所属工作区。**终生不可迁移**（`architecture` §3） | 客户技术团队 |
| `name` | M | 显示名（例："备货专员-A团队"） | 客户技术团队 |
| `role_package_ref` | **M** | `{id, version}` —— **钉在哪个版本**（`37` §7 的"钉版"） | 客户技术团队 |
| `data_view` | **M** | 数据视窗取值（见 §3） | 客户技术团队 |
| `connector_bindings` | M | 连接器实例绑定：`[{connector_id, environment: prod/staging}]` | 客户技术团队 |
| `knowledge_set_bindings` | O | 挂哪些知识集 | 客户技术团队 |
| `overrides` | O | **覆盖层**（`03` §4.1：**只能改表述性与取值性**） | 客户技术团队 |
| `limits_override` | O | 上限的客户级覆盖（**只能更严**，`26` §2.3） | 客户技术团队 |
| `delivery_bindings` | M | **送达的具体地址**（`38` §4）：`{im: [...], email: [...], reviewers: [...]}` | 客户技术团队 |
| `contacts` | M | 相关人：复核人 / 申请人（角色 → 人） | 客户技术团队 |
| `service_identity` | M | 服务身份 id（**不是凭据本身**） | 系统 |
| `credentials` | M | **凭据的引用**（不存明文；`30` §2） | 系统 |
| `status` | **M** | `draft`/`active`/`suspended`/`retired`/`destroyed`（`36` §2 五态） | 系统 |
| `contract_version` | M | 当前权责契约版本（`36` §5） | 系统 |
| `maturity` | M* | 每个不可逆能力的成熟度档（`06` §2.3.7）。**有 L3+ 能力时必填** | 系统 |
| `created_by` / `approved_by` / `created_at` / `basis` | M | 创建人 / 批准人 / 时间 / 依据（审计） | 系统 |

### 2.2 必填性的判定依据（不是随手标的）

| 标记 | 依据 |
|---|---|
| `workspace` 必填 | 归属链（`26` §1.2）第一位是客户、第二位是工作区——**没有它，审计和计费都归不了集** |
| `role_package_ref` 必填 | `36` §5：**没有版本就说不清"上个月它能干什么"** |
| `data_view` 必填 | `36` §4 上岗审核第 2 项：**配全才许上岗**；`34` §3.4 漏一个数据源就是后门 |
| `delivery_bindings` 必填 | `38`：**界面是底座**，但推送地址不填则只有底座（合法）；**故为 M 但允许空数组** |
| `maturity` 条件必填 | 只有 L3+ 才需要（`06` §2.3.7） |

> ⚠️ **之前 44 份文档里没有这张表**——施工队无法建表。**本文是那处空白的填补。**

---

## 3. 数据视窗（Data View）—— 结构与指纹 ⭐ 之前只有抽象说法

### 3.1 序列化结构（定死）

```yaml
data_view:
  rows:                                  # M  行过滤
    - dimension: <维度类型 id>            # M  例：ownership_team
      op: in                             # M  目前只允许 in / not_in
      values: [<取值>, ...]               # M
  columns:                               # M  列规则
    - field: <字段路径>                   # M  例：cost_price
      rule: visible | masked | derived   # M  ⭐ 三选一（`34` §2.2）
      masking:                           # M*  rule=masked 时必填
        reason_code: <原因码>             # M  让用户知道"为什么看不到"
      derive:                            # M*  rule=derived 时必填
        expression: <表达式的 id>         # M  ⚠️ 不是自由公式，是注册过的表达式 id
        expose_as: <对外字段名>           # M
        params_hidden: [<字段路径>, ...]  # M  ⭐ 派生用到的参数必须同时遮蔽（防反推，`34` §2.2）
  aggregate:                             # M  聚合规则
    cross_scope: forbid | tiered          # M  ⭐ 默认 forbid（`34` §2.3）
  environment: <env_id>                   # M  ⭐ 视窗按环境各配一份（`34` §3.5）
```

### 3.2 视窗指纹（fingerprint）—— 三处依赖它，之前没定义

**被依赖的地方**：`34` §4（防推演）、`34` §6（记忆召回）、`30` §4（缓存键）。**之前从未给构成**，施工队写不出接口。

**定义**：

```
fingerprint = sha256(  规范化JSON({
    客户 id,
    工作区 id,
    环境 id,                              # ⭐ 含环境（施工队指出：不含则测试与生产互相命中）
    rows（按 dimension 排序后）,
    columns（按 field 排序后）,
    aggregate.cross_scope
}) )
```

**三条规则**：

| 规则 | 理由 |
|---|---|
| **输入按 key 排序后序列化** | 否则同配置不同书写顺序会算出不同指纹（同 harness 的"深度 key 排序"做法） |
| **含客户 id** | ⭐ **P0-3**：缓存与记忆跨客户永不复用（`30` §4） |
| **含环境 id** | 测试与生产的视窗不同，指纹必须不同 |

> **旧叫法对照**：`数据视窗指纹` / `视窗指纹`——**统一叫 `fingerprint`**，算法如上。

---

## 4. 字段名对照表（旧叫法 → 本文名字）

| 旧叫法（散在各文档） | 本文名字 | 出处 |
|---|---|---|
| `数据视窗取值` / `数据视窗` / `数据要求` | **`data_requirements`**（岗位包）· **`data_view`**（实例） | `36` / `03` |
| `上限（成本/时长/频次/并发）` / `成本/时长/并发上限` | **`limits`**（四项固定） | `36` |
| `复核人` | **`contacts.reviewers`** | `36` |
| `送达配置` / `推送目标` | **`delivery_bindings`** | `38` |
| `成熟度档位` | **`maturity`** | `06` |
| `工具档位` | **`capabilities.tools.tier`** | `03` |
| 契约 v1 签在 ⑥ 还是 ⑦ | **⑦「上岗」**（`36` §3.1 八步的第 ⑦ 步） | `36` |

---

## 5. 验收标准

| # | 标准 |
|---|---|
| W1 | `role.yaml` **能被解析**，根节点是 `role_package`，且本文 §1.3 的**必填字段全在** |
| W2 | 岗位包里**不含任何客户特有取值**（团队名/邮箱/群名/阈值取值）——机器可校验 |
| W3 | 实例的必填字段按 §2.1 校验；**缺 `data_view` 不许上岗** |
| W4 | **数据视窗能被序列化成 §3.1 的结构**，且**同一配置算出的 `fingerprint` 稳定**、**不同客户/不同环境算出的必然不同** |
| W5 | 导出物在**两个客户、同岗位包、同权限**下：**缓存命中率为 0**（P0-3） |
| W6 | 字段名的**旧叫法在实现里不出现**——只允许 §4 对照表里的新名字 |

---

## 6. 还没写规格的（施工队会用到的，按优先级）

| # | 结构 | 什么时候要 |
|---|---|---|
| 1 | **任务池 / 任务对象**（"未分配 → 某员工在执行"这段链路**全文空白**） | ⭐ **Phase 0 就要**（没有它，触发→执行串不起来） |
| 2 | **权责契约**（`36` §5） | M0 |
| 3 | **交付物实例**（`28` §1 已给字段说明，未给类型与必填性） | M0 |
| 4 | **配送达记录**（`38` §8） | M0 |
| 5 | **就业账本事件**（`36` §10） | M1 |
| 6 | **会话 / 运行 / 检查点**（`13`） | M0 |
| 7 | **审计事件五要素的具体类型**（`26` §3.1） | M0 |
| 8 | **维度类型的注册结构**（`34` §3.3 说"客户自定义"，但没给数据结构，也没说**怎么映射到各数据源字段**） | M0（数据视窗落地时） |

> **本文的定位**：**这是"设计 → 施工"的第一块砖**。
> 后面每补一个结构，就进本文；**实现的字段名以本文为准**。
