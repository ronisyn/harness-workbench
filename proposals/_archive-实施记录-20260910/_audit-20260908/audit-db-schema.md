# DB Schema 审计

审计对象：`server/db.js`（SCHEMA/MIGRATIONS/SEEDS/VIEWS）与全 `server/` 下 db.query/db.run SQL。审计方式：纯静态交叉核对（只读，未改任何文件）。基线 = db.js 内 28 张 CREATE TABLE + 16 条 ALTER + 2 条种子 + 1 个视图。

结论摘要：**所有被引用的列在 initSchema 正常执行后均存在**（含新列 knowledge.shell_id / shells.intent_rules|task_profiles / usage_stats.kind|agent_run_id|cache_miss_tokens|shell_id / messages.reasoning / conversations.provider|model|mode|preset|shell_id / shell_tools.mode(12) / model_telemetry / reviews）。真正的缺陷集中在：①迁移静默吞错无自检 → 列漂移后主链路 500；②会话删除级联非事务且有幽灵表名与漏删项；③settings 键 schema 与消费端割裂；④若干全表扫描/长文本截断/JSON 双解析点。

---

## 缺陷（P1 运行时报错级 / P2 数据一致性级 / P3 设计级）

### P1（运行时报错级）

- **P1-1｜迁移静默吞错 → 新列缺失时主链路直接 500，且零日志难定位**
  - `server/db.js:381-383`：MIGRATIONS 逐条 `try { pool.query } catch { /* 已存在或不可用则跳过 */ }` —— 吞掉的不只是"列已存在"，还有真实失败（权限不足/锁超时/断连/手工建库跳过 initSchema）。而 messages.reasoning、conversations.provider|model|shell_id、usage_stats.shell_id、tool_calls.shell_id、audit_log.shell_id、shells.intent_rules|task_profiles、knowledge.shell_id **只存在于 ALTER、不在 CREATE TABLE**（见"迁移遗漏清单"）。
  - 后果：任一 ALTER 失败 → `server/index.js:811`（chat 存消息带 reasoning）、`index.js:184`（建会话带 provider/model/shell_id）、`tools/index.js:1146`（tool_calls 带 shell_id）等 INSERT 引用未知列 → 500；SCHEMA 的 CREATE 失败也只是 `console.error` 不抛（db.js:353），启动"成功"但结构残缺。
  - 修复建议：MIGRATIONS/SCHEMA 的 catch 里记 `console.error`，并在 initSchema 末尾对关键列做一次 information_schema 校验，缺列即抛错/打醒目标志。

### P2（数据一致性级）

- **P2-1｜会话删除级联清单含幽灵表 `bg_tasks`，且清单与真实表集未对齐**
  - `server/index.js:220`：`for (const t of ['messages',…,'bg_tasks',…,'reviews'])` —— 全仓库（含 db.js SCHEMA/MIGRATIONS、任何历史分支文件）无 `bg_tasks` 表定义；每次删会话都执行 `DELETE FROM bg_tasks WHERE conversation_id=?` 抛 "Table doesn't exist" 被空 catch（index.js:223）吞掉。该清单还漏掉了与 task_contracts 关联的 `contract_events`。
  - 修复建议：删除 `bg_tasks` 项；把清单改为从 information_schema 动态取带 conversation_id/conv_id 的表，或至少与 db.js 表清单同一处维护。

- **P2-2｜会话删除非事务：中途任一 DELETE 失败即静默留下半套孤儿**
  - `server/index.js:220-226`：逐表 try/catch、无事务，最后才删 conversations 主行。子表删除失败不影响"删除成功"返回；knowledge/goals 等有大量行时锁超时/连接中断即漏删。
  - 修复建议：整体包一个事务（或先删子表后删主表且失败回滚），失败返回 500 提示清理未完成。

- **P2-3｜漏删：删除会话→级联删 task_contracts（conv_id）后，contract_events 全成孤儿**
  - `server/index.js:222` + `db.js:277-284`：contract_events 只有 contract_id、无 FK；契约行被会话级联删除后，其 contract_events（start/finish/need_input/error…）永久残留且不可达（contracts 列表已无此行）。
  - 修复建议：会话级联时先 `DELETE FROM contract_events WHERE contract_id IN (SELECT id FROM task_contracts WHERE conv_id=?)`，或删契约处统一清理。

- **P2-4｜删除会话不覆盖 account_id=NULL 的渠道会话（wechat/feishu），也无法删除、长期堆积**
  - `server/index.js:218`（own 必须 account_id 匹配）→ `DELETE` 只可能命中账号自己的会话；`channels/wechat.js:32`、`feishu-webhook.js:52`、`driver.js:42` 建的会话 account_id 可为 NULL。这些行在 GET /api/conversations（index.js:165 `account_id IS NULL` 分支）对所有账号可见却对任何账号都删不掉（除非 external_id 复用停止增长）。
  - 修复建议：为 NULL-account 会话提供按 channel+external_id 的清理路径（如保留 N 天自动清理）。

- **P2-5｜audit_log 与 tool_calls 同 try 留痕：action/tool_name 截断 → 两条记录一并丢失**
  - `server/tools/index.js:1141-1148`：同一 try 内先后 INSERT audit_log(action VARCHAR(64)) 与 tool_calls(tool_name VARCHAR(64))。MCP/长工具名使 action='tool:'+name 或 tool_name 超 64 字符时（strict 模式报错），catch 吞掉 → **tool_calls 轨迹也丢**。audit_log 其它写点 action 为 `'route:'+profileKey`（index.js:676）等也可能超长。
  - 修复建议：action 扩到 VARCHAR(128)、tool_name 扩到 VARCHAR(128)，两条 INSERT 分开 try 互不牵连。

- **P2-6｜usage_stats / conversations 的 24h 预算与总账口径不一致风险（conversation_id=NULL 行不算会话账）**
  - `server/index.js:717` 预算 SUM 按 `conversation_id=?`；`autotitle.js:34`、`tools/index.js:921` 摘要类按会话记账 OK，但 `agent.js:321-322` 折叠行 conversation_id 传 `ctx.conversationId ?? null` —— 无会话上下文的调用（调度/驱动也最终落在会话上，通常不为空）。真正的问题是 `usage_stats.message_id`、`agent_run_id` 两列没有一致性约束，同一运行可被多次归集（见 P2-7 汇总）。
  - 修复建议：核对所有旁路计量（autotitle/summary）是否都挂 conversation_id，确保 24h 总账不漏。

- **P2-7｜knowledge 幂等去重依赖"先查后写"，无唯一约束 → 并发/重试可重复插入**
  - `server/tools/index.js:605-623`（kb_add 先 SELECT 再 UPDATE/INSERT）与 `server/index.js:1323-1326`（import 同模式）。knowledge 无 UNIQUE(account_id, scope, conversation_id, shell_id, title)，两个并发 kb_add/import 同 title 会插两行；tools 的 kb_add 已做相似度冲突保护，但 import 无。
  - 修复建议：加 UNIQUE KEY uq_kb (account_id, scope, shell_id, conversation_id, title)（NULL 兼容注意 <=> 语义），或用 INSERT … ON DUPLICATE。

- **P2-8｜consecutive_fail_guard=0（关闭）被 `0 || 3` 变成 3：schema 承诺"0=关闭"无法兑现**
  - `server/agent.js:156`：`failGuardN: pick('consecutive_fail_guard', 0) || 3` —— 用户显式设 0 后 pick 返回 0，`0||3` → 3，连续失败保护无法关闭，与 settingsSchema.js:20 hint"0=关闭"矛盾；同类 collapse 键的 `0||默认` 语义是故意的（0=默认值），此处不同。
  - 修复建议：改为 `pick(...)` 后 `(n === 0 && 未设置) ? 3 : n`，或 schema hint 改为"0=默认3"。

- **P2-9｜GET /api/conversations/:id/messages 与 /toolcalls 无归属校验 → 跨账号读消息/轨迹**
  - `server/index.js:229-231`、`285-288`：直接按 conversation_id 查 messages/tool_calls，未校验 account_id（export/activity/autotitle 均有校验）；任何登录用户可枚举会话 id 读他人消息与工具参数（tool_calls.args 可能含路径/参数）。
  - 修复建议：两处加 conversations 归属前置校验（与 index.js:293 一致）。

- **P2-10｜视图 v_model_telemetry_daily 无账号维度 + 路由不过滤 account → 多账号部署时跨账号用量可见**
  - `server/db.js:406-410`（视图按 shell_id/provider/model/d 聚合，不含 account_id）；`server/index.js:1266-1279` conds 仅 days/shell_id/provider/model。单管理员场景无影响，多账号时任意用户可见全局聚合。
  - 修复建议：视图/查询按 account_id 维度过滤（telemetry 表有 account_id），或路由显式单账号。

- **P2-11｜scheduled_tasks.name（VARCHAR(128)）与 conversations.title（VARCHAR(255)）写库不截断 → 超长输入打 500**
  - `server/index.js:1111-1112`：POST /api/tasks 的 name 未 slice（128 超长即 strict 报错，路由无 try → 500）；`index.js:193` PATCH title 未 slice（255）；`index.js:1426` app:launch 有 slice 但 apps name 截 60 没问题。
  - 修复建议：入参统一 `.slice(0, 128/255)` 再写库（validateSetting 同层）。

- **P2-12｜JSON 双解析脆弱点：settings.svalue 已被 mysql2 自动 parse，再 JSON.parse 会把"合法 JSON 文本型字符串"静默转类型**
  - `server/index.js:393/954`、`mcp.js:15`、`scheduler.js:70`、`driver.js:140`、`agent.js:144`、`db.js:31`：settings.svalue 是 JSON 列，mysql2 读回已是对象/数字/字符串；外层再 `JSON.parse(r.svalue)` 对对象必 throw 落入 catch（返回原值——碰巧正确），但字符串值恰为合法 JSON 文本时（如 systemPrompt 内容 "123"、"[…]"、"{…}"）会被静默解析成 number/array/object 造成类型错乱；对未用 jsafe 的 shells JSON 列（index.js:496 intent_rules、456 task_profiles）若为 legacy 双编码文本则直接失效。
  - 修复建议：统一走 jsafe（shells.js:17 模式：非 string 直接用、string 才 parse、失败按原文），settings 读取同理；写入统一 JSON.stringify 保证单编码。

### P3（设计级）

- **P3-1｜CREATE TABLE 与 MIGRATIONS 双写不同步**：db.js 中 conversations/messages/usage_stats/tool_calls/audit_log/shells/knowledge/shell_tools 的新列只在 MIGRATIONS（部分与 CREATE 重复，部分 CREATE 根本没有），全新安装强依赖 boot 顺序执行 ALTER；建议把"仅 ALTER 存在"的列并入 CREATE 语句、只保留"老库升级"专用 ALTER。
- **P3-2｜死表**：`shell_settings`（db.js:313，全库零读写）、`price_table`（db.js:163，零读写）——壳级设置与价格表均无消费端，属占位死表（或计划中功能未接线）。
- **P3-3｜任务提及的 v_usage_* 视图不存在**：全库仅 v_model_telemetry_daily 一个视图；v_usage_*（若有设计文档）未实现，无引用。视图 v_model_telemetry_daily 的 9 列（shell_id/provider/model/d/execs/tokens_in/tokens_out/cost/duration_ms）与 model_telemetry 真实列完全一致、与消费端 index.js:1274/1276 一致——本项无缺陷。
- **P3-4｜knowledge.scope 枚举与壳包 schema 声明不一致**：shells.js:50 校验 pack 的 knowledge.scopes 允许 "global|shell|project"，knowledge 表（db.js:233）实际只实现 global/shell/conv 语义，'project' 无对应实现且壳行 knowledge_scopes 字段（db.js:297）全库只写不读。
- **P3-5｜conversations.mode='plan' 残留语义**：tools/index.js:702-704 注明 plan 模式已废弃、存量值忽略，但 conversations.mode 仍可写 'plan'、快照注入仍会显示 mode=plan；建议迁移期做值归一或文档标注。
- **P3-6｜死/未用索引面**：goals 无 conversation_id 索引（index.js:524、tools/index.js:387/397/408 每请求扫）；knowledge conv 维度无 conversation_id 索引（conv 查询靠 idx_kb_scope 前缀）；scheduled_tasks 无 (account_id)/(enabled,next_run) 索引。
- **P3-7｜缺去重/幂等的边角**：goals 的"active 唯一"靠 tools/index.js:387 先查后改（无约束，并发双 active）；reviews 允许同会话无限多条（业务上可能想要历史，但前端双击会产生重复 bug 记录）；agent_runs 每会话多行 history 属设计（latestRun 取最新）。
- **P3-8｜market 外部数据直写长度未控**：llm/market.js:49-50 外部 model_id/name/provider_name 未按 VARCHAR(128/128/255/128) 截断（openrouter 类源长名可能超）；llm/providers.js:85 capabilities 已 stringify OK。
- **P3-9｜无保留策略**：audit_log/tool_calls/usage_stats/model_telemetry 无清理/归档任务，只增不删（无 LIMIT 的审计查询与全表聚合会随时间变慢）。
- **P3-10｜会话列表无 account 索引 + OR 条件**：index.js:164-165 `WHERE account_id=? OR (channel!='web' AND account_id IS NULL) ORDER BY updated_at DESC` 无 (account_id, updated_at) 索引；且 account_id=NULL 的渠道会话对所有账号列表可见（多账号时属泄漏）。
- **P3-11｜find-or-create 无唯一约束竞态**：wechat/feishu/scheduler/driver 按 (channel, external_id) 先查后插（wechat.js:30-32 等），并发入站可能建两条同 external_id 会话，消息分流到两个会话。

---

## 迁移遗漏清单

> 结论：initSchema 全量跑完后所有列都存在；下表区分"仅 ALTER 提供（真漂移风险）"与"CREATE 已含（冗余 ALTER，无害）"。

仅 ALTER 提供、CREATE TABLE 缺列（全新库依赖 boot 顺序执行 ALTER；手工建库/跳过 initSchema 即缺列 → 运行时 Unknown column，见 P1-1）：

| 表 | 列 | CREATE 行 | ALTER 行 |
|---|---|---|---|
| messages | reasoning | db.js:73-85 缺 | db.js:357 |
| conversations | provider / model / shell_id | db.js:60-72 缺（mode/preset 在 CREATE） | db.js:364 / 365 / 367 |
| usage_stats | shell_id | db.js:132-151 缺 | db.js:371 |
| tool_calls | shell_id | db.js:152-162 缺 | db.js:372 |
| audit_log | shell_id | db.js:86-92 缺 | db.js:373 |
| shells | intent_rules / task_profiles | db.js:286-306 缺 | db.js:375 / 377 |
| knowledge | shell_id | db.js:230-241 **已含**(235) | db.js:379（冗余） |
| shell_tools | mode VARCHAR(12) NOT NULL | db.js:307-312 **已含** | db.js:369（冗余，老库 10→12 修复） |
| usage_stats | kind / agent_run_id / cache_miss_tokens | db.js **已含**(136/146/147) | db.js:360-362（冗余，仅老库需要） |
| conversations | mode / preset | db.js **已含**(66/67) | db.js:358-359（冗余） |

改进建议：把"仅 ALTER"的列并入各自 CREATE TABLE，MIGRATIONS 只保留老库升级语义；迁移失败需打日志 + 启动自检（P1-1）。

---

## 孤儿风险表（会话删除未级联的）

DELETE /api/conversations/:id（index.js:220-226）清单 vs 全表 conversation 关联：

| 表 | 关联列 | 删除会话后 | 处理 |
|---|---|---|---|
| messages / tool_calls / usage_stats / agent_runs / conv_summaries / conv_skills / goals / knowledge(conv) / model_telemetry / reviews | conversation_id | 已级联删除 | ✅（均入清单） |
| task_contracts | conv_id | 已级联（index.js:222 特判 conv_id） | ✅，但见下 |
| **contract_events** | contract_id（间接经 task_contracts） | **孤儿残留**（契约被级联删后事件不可达） | ❌ 漏删（P2-3） |
| audit_log | 无 conversation_id（detail 文本含 conversation=N） | 有意保留审计 | 按设计（建议注释明确） |
| scheduled_tasks | 无 conversation_id（task 为会话的父；会话删除后下轮 find-or-create 重建） | 不产生孤儿 | 反向：DELETE /api/tasks（index.js:1132）不清理其 channel='task' 会话/messages → 会话孤儿（P2-4 变体） |
| bg_tasks | — | 表不存在，每删必抛错被吞 | 幽灵清单项（P2-1） |
| knowledge(scope=shell/global) | shell_id/NULL | 不随会话删除（壳私有知识跨会话共享） | 正确 |
| sessions/invites/capabilities/long_jobs/shells/shell_tools/shell_settings/price_table/market_snapshot/providers/models | 无 conversation 关联 | 无影响 | — |

---

## settings 键消费对照缺口

SETTINGS_SCHEMA 注册键（settingsSchema.js:5-23，14 个）｜db.js SEEDS（`__policy_rev`/`task_budget_yuan`/`task_budget_total`）｜全 server 读取点。

**被读但未注册 schema/无种子（"开放键"旁路，validateSetting 放行但 UI/校验缺位）：**

| 键 | 读取点 | 备注 |
|---|---|---|
| default_models | index.js:87, 451 | 注释（index.js:86）写 `default_model_<provider>`，实际键是 default_models，文档与实现不一致 |
| toolset_enabled | index.js:137, 724 | |
| temperature | index.js:474 | 无 schema，默认 0.4 硬编码两处 |
| systemPrompt | index.js:569 | |
| access_rules | index.js:731, 974；scheduler.js:70；driver.js:140 | 策略类键，写时 bump（index.js:986） |
| mcp_servers | mcp.js:99；index.js:965, 1035, 1521 | 含密钥，写读均有脱敏处理 |
| __policy_rev | db.js:30-33；agent.js:140,157 | 种子有、schema 无（内部键，合理但应显式 exempt） |

**注册但代码从不读：**

| 键 | 注册 | 消费 |
|---|---|---|
| selfchange_budget_yuan | settingsSchema.js:13 | 全仓库无读取（含 web/src）→ 死键，UI 可配但无效 |

**语义缺口（读≠schema 意图）：**
- consecutive_fail_guard：hint"0=关闭"但 agent.js:156 `pick(...) || 3` 使 0→3（P2-8）。
- task_budget_yuan：schema def/种子=0（关），agent.js:149 兜底默认 20 —— 行缺失时与声明不符。
- GUARD_KEYS（index.js:960）只含 group='runtime' 6 键 → budget 组键变更不 bump __policy_rev，与 agent 每轮自读的 13 键集不对称（bump 语义=模型可见性，budget 键不进快照属于设计取舍，建议注释确认）。

---

## 其他

- **N+1/全表扫描热点（明显级）**：
  - `index.js:814`：每 agent 轮 `UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL` —— tool_calls **无 conversation_id 索引**（db.js:152-162 仅 PK），每轮全表扫（多会话/长会话时明显）；导出与轨迹读取（index.js:240/286）同样无索引。建议 `KEY idx_tc_conv (conversation_id, message_id)`。
  - `index.js:869`：GET /api/usage/stats 无 conversationId 时 `SUM(...) FROM usage_stats WHERE account_id=?` —— 无 (account_id, created_at) 索引 → 全表聚合；usage_stats 现仅有 (created_at)/(conversation_id)。
  - `index.js:1274-1276`：v_model_telemetry_daily 非物化，`d >= …` 谓词在 DATE(created_at) 派生列上，created_at 索引难下推 → 每次请求全量聚合 model_telemetry（数据量上来后明显）。
  - `index.js:509`：chat 每请求 `SELECT … FROM messages WHERE conversation_id=? ORDER BY id` 全量加载后再 slice(-30)（无 LIMIT）；wechat.js:63、feishu-webhook.js:91 每条入站消息全量拉历史（无 LIMIT）→ 超长会话 IO/内存随会话线性涨。
  - `scheduler.js:47/94`、`driver.js:203`：每分钟/每 15s 的 due 扫描无 (enabled,next_run)/(status,run_at) 索引（scheduled_tasks 无任何非 PK 索引）；scheduler.js:111-117 自动归档相关子查询每 10 分钟对全部 >24h 静默会话计数。
  - 会话列表 index.js:164、knowledge 可见性查询 index.js:544 依赖 account 前缀索引（conversations 无 account 索引）。
- **review/export/usage 接口跨账号计数泄漏**：GET /api/usage/stats（index.js:871）的 messages/tool_calls 计数不按账号过滤（输入任意 conversationId 可得他人计数）——量级轻微，建议顺手加归属校验（同 P2-9）。
- 视图 v_model_telemetry_daily 与 model_telemetry 列一致 ✅；difficulty 列从未写入（index.js:788 恒 NULL）——观测维度半成品，建议要么接线要么移除列。
- 会话标题/模型列宽均够（title 255 / model 128 / provider 32），主要截断点在 P2-5/P2-11。
- DECIMAL(10,4)（cost）与 DECIMAL(6,2) 类无精度风险（单行成本远低于上限）；SUM 溢出仅在极端累计，无需处理。

---

## 统计

- 缺陷总数：**24**
  - P1 运行时报错级：**1**（迁移静默吞错 → 列漂移后主链路 500）
  - P2 数据一致性级：**12**（级联幽灵表 bg_tasks / 非事务级联 / contract_events 漏删 / NULL-account 会话不可删 / audit+tool_calls 同 try 丢留痕 / knowledge 无唯一约束去重竞态 / fail_guard 0→3 / 跨账号读接口 / telemetry 无账号维度 / 超长输入 500 ×2 / JSON 双解析）
  - P3 设计级：**11**（CREATE 与 MIGRATIONS 双写不同步、shell_settings+price_table 死表、v_usage_* 不存在、scope 'project' 未实现、mode='plan' 残留、索引面缺失、market 外部长度、无保留策略、会话列表 OR 索引、find-or-create 竞态等）
- 迁移遗漏清单：10 项（7 项"仅 ALTER 提供"为真风险，3 项 CREATE/ALTER 冗余）
- 孤儿表：contract_events 1 张真实漏删；bg_tasks 为幽灵；audit_log/scheduled_tasks 属按设计保留
- settings 键：6 个被读未注册、1 个注册未读（selfchange_budget_yuan）、2 个语义不一致

> 说明：P1 为"条件触发"级——正常 initSchema 下无即时故障，但迁移错误被静默吞掉 + 关键列仅靠 ALTER 提供，一旦出现（权限/手工建库/中断）即为不可自愈的运行时 500，属本审计最值得先修项。所有 P2/P3 建议修复均不涉及外键引入（当前库无 FK 约束，靠应用层级联），若要根治可考虑加 FK ON DELETE CASCADE。
