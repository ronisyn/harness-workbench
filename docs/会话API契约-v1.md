# 会话 API 契约 v1

> **结论先行**：对外会话 API 现在就这一条链——登录取 Token → `POST /api/chat`（SSE 流）→ 用 `messageId` 取 `/messages`、用 `id:` 续订 `/stream`、用 `/export` 取机器可读导出。
> 事实源是**代码**，不是方案文档；每条描述都指到 `文件:行`（行号对工作区当前 `server/index.js`，共 2861 行）。
> ⚠️ **行号会随代码增长而漂移**：本文只保证"写这一行时的行号 + 那段代码的形状"（括号里给的是可 grep 的符号锚点）。
> 改了行号不重编本文，**以符号锚点为准**；发现某个锚点 grep 不到，就是这段契约描述已经过期，当场修文档（§6 规则 6）。
> 不确定的写"未确认"，没定的写成触发条件。
> 冻结基线：`scripts/selfcheck.mjs`、`scripts/agent-smoke.mjs` 两个脚本逐条断言的字段与帧顺序（§8），它们红了就是破坏契约。
> 依据：`proposals/架构文档冲突登记-20260915.md:148-167`（D4 拍板）、`proposals/D4-会话API契约-方案.md`。
>
> **2026-09-16 补（核对报告 §3.4/§3.5⑧ 的交互契约漏项）**：溢出提示（§4.1）、逐轮成本事件（§4.2）、
> **可回滚**及其边界（§4.3）、跨端一致的真实状态（§7）。按 v0.3 §4.7 的四要素（可观测/可控制/可信/跨端一致）
> 逐项对齐：**可观测 ✓、可控制 ✓、可信=部分（回滚有边界，见 §4.3）、跨端一致 ✗（未成立，见 §7）**。

---

## 1. 范围与版本

**覆盖**：§3 端点表里的 16 条端点（鉴权、会话执行与停止、续订、消息、两种导出 + 导入、审批/问询、活动、投递）。平台另有 118 条带 `requireAuth` 的路由、125 处路由注册（本文件用 `grep -c` 数出），**不在本契约内**——它们只服务自带前端，随时可能变。

**流协议版本**：`v:1`，落在帧里，不在 URL 里。带 `v` 的是 `run_start`、三处 `run_end` 与 `stream_hello`（续订握手也声明版本）。

**为什么不加 `/api/v1` 路径**（如实登记的偏离：`规范/04-接口规范.md:25` 要求版本放路径）：
- 既有事实：118 条路由带 `requireAuth`（本文件 §3 那 16 条是其中子集），静态前端与 SPA 兜底都在同一套 `/api` 下（`server/index.js:2599-2603`）。
- 现有"对外调用方"**只有我们自己的两个脚本**（`scripts/selfcheck.mjs`、`scripts/agent-smoke.mjs`），没有第三方。
- 因此版本号落在流协议的 `v` 与本文档上。
- **触发条件**（不是承诺）：出现第一个真实第三方调用方时，再加 `/api/v1` 门面——"抽象要由第二个真实使用者逼出来"。

---

## 2. 认证

- Token 来自 `POST /api/auth/login`（§3.1）：入参 `username`/`password`，出参 `{ok:true, token, user}`（`server/index.js:89-96`、`server/auth.js:22-33`）。
- Token 是 24 字节随机 hex = 48 字符（`server/auth.js:9`），存 `sessions` 表，有效期 `SESSION_DAYS`（默认 5 天，`server/config.js:41`，`server/auth.js:28-31`）。
- 之后每个请求带 `Authorization: Bearer <token>`（`server/auth.js:65-75`）。
- **401 两种 + 一种 500**：无 token → `401 {ok:false, message:'未登录'}`（`server/auth.js:68`）；token 未知或已过期 → `401 {message:'登录已过期'}`（`:70`，有效期条件 `:38`）；鉴权查询抛异常 → `500 {message:'鉴权失败'}`（`:74`）。
- **403 当前一条都没有**（全 `server/` grep `status(403)` 零命中；仅 `server/index.js:605-606` 把厂商探测返回的 401/403 当"key 无效"读）。权限不足走两条既有路径：会话归属不符 → **404**（隐藏资源存在性，如 `:741`、`:1417`）；执行期权限不足 → 工具层拒绝（`server/failures.js:21` 的 `TOOL_PERMISSION_DENIED`）。按 `规范/04:110` 的"没身份 401、有身份没权限 403"分工，**这里就是偏离**：没有 403 这一档。

---

## 3. 端点表

| # | 方法 | 路径 | 认证 | 用途 |
|---|---|---|---|---|
| 1 | GET | `/api/health` | 无 | 存活探测（`server/index.js:1947-1949`） |
| 2 | POST | `/api/auth/login` | 无 | 换 Token（`:89`） |
| 3 | POST | `/api/auth/logout` | Bearer | 作废当前 Token（`:98`） |
| 4 | GET | `/api/auth/me` | 无（自解析头） | 查当前身份（`:103`） |
| 5 | POST | `/api/conversations` | Bearer | 建会话（`:317`） |
| 6 | POST | `/api/chat` | Bearer | **唯一执行入口**，响应是 SSE 流（`:737`） |
| 7 | POST | `/api/chat/stop` | Bearer | 中止本轮（`:1564`） |
| 8 | GET | `/api/conversations/:id/stream` | Bearer | 断线续订（只读，绝不触发执行）（`:1414`） |
| 9 | GET | `/api/conversations/:id/messages` | Bearer | 读落库消息（`:400`） |
| 10 | GET | `/api/conversations/:id/export` | Bearer | JSONL 导出（**冻结不动**）（`:411`） |
| 11 | GET | `/api/conversations/:id/export-full` | Bearer | 带版本自描述导出（`:434`） |
| 12 | POST | `/api/conversations/import` | Bearer | 导入自描述导出物（默认 dry-run）（`:444`） |
| 13 | GET | `/api/approvals` | Bearer | 待审批列表（`:1572`） |
| 14 | GET | `/api/asks` | Bearer | 待问询列表（`:1548`） |
| 15 | GET | `/api/conversations/:id/activity` | Bearer | 事件环增量轮询（`:564`） |
| 16 | GET | `/api/deliveries` | Bearer | 投递记录/死信落点（`:457`） |

### 3.1 鉴权与建会话

- `GET /api/health` → `200 {ok:true, service:'rw', ts}`，无错误码（`:1947-1949`）。
- `POST /api/auth/login` → `{ok:true, token:"<48位hex>", user:{id, username, role}}`；缺字段或账号/密码错 → **400** `{message}`（`:92`、`:95`，`server/auth.js:24,26` 的中文原因直接进 message）。本批**没给它加 `code`**。
- `POST /api/auth/logout` → `{ok:true}`（`:98-101`）。
- `POST /api/conversations`，体 `{title?, permission?, preset?, provider?, model?, project?, shell?}` → `{ok:true, id:<number>, shellId}`（`:317-336`）。错误：`permission` 不在 `read|write|guard|full` → **400**，**无 `code`**（`:322`）。`preset` 非法值**不报错**，静默归 `all`（`:333`）——这是行为，不是承诺。

### 3.2 `POST /api/chat`（唯二要注意的端点之一）

请求体：`{conversationId, content, provider?, model?}`（`:738`）；`provider:'auto'` / `model:'__auto__'` 是"自动路由"哨兵，归一为 null（`:750-751`）。**响应是 SSE 流**（不是 JSON）：200 头 `Content-Type: text/event-stream`（`:1016-1021`）。可选请求头 `Idempotency-Key`：见 §5.1。
错误（这一层是普通 JSON，**已带 `code`**）：缺 `conversationId` 或 `content` → **400** `PARAM_MISSING`（`:739`）；会话不属于本人（或不存在）→ **404** `CONV_NOT_FOUND`（`:741`）；同账号同时在跑 ≥ `settings.max_concurrent_chats`（默认 5，0=不限）→ **429** `CONCURRENCY_LIMIT`（`:830-831`、`:857`）。

### 3.3 `POST /api/chat/stop`

体 `{conversationId}` → `{ok:true, stopped:<boolean>}`（`:1564-1569`）。没有对应运行中的轮次时 `stopped:false`，仍是 200。**没有 4xx，也没有 `code`**。

### 3.4 `GET /api/conversations/:id/stream`（续订）

入参：`Last-Event-ID` 头，回退 `?after=`（`:1418-1420`）；非数字或负数按 0 处理。
帧序：`stream_hello` → 补发 `seq > after` 的事件 → 跟播 → `stream_end`（`:1458`、`:1445-1448`、`:1438`）。
`stream_end.reason ∈ idle|timeout|error:*`（`:1452`、`:1454-1455`、`:1438`）。跟播上限 **10 分钟**（`:1427`），到点以 `timeout` 收尾，客户端应重连一次。**本端点绝不触发执行**（设计意图见 `:1407-1409`）。错误：会话不属于本人 → **404**，**无 `code`**（`:1417`）。
**`stream_gap` 目前发不出来**：注释里说有（`:1413`），实际全 `server/` grep 只命中那两行注释——没实现（见 §7）。

### 3.5 `GET /api/conversations/:id/messages`

成功：`200 {ok:true, messages:[{id, role, content, reasoning, model, provider, created_at}]}`，按 `id` 升序（`:404-405`）。**没有 `runId`、没有 `seq`**——无法从返回里判断某条消息属于哪一次执行。
错误：会话不存在或无权查看 → **404**，**无 `code`**（`:403`）。
归属口径：本端点认"本人 **或** 渠道共享会话（`account_id IS NULL` 且非 `web`）"（`:402`），与会话列表口径一致。

### 3.6 两种导出 + 导入（并存，`/export` 冻结不动）

- `GET /api/conversations/:id/export` → `{ok:true, filename:"<标题>.jsonl", content:"<每行一个 JSON 对象的字符串>"}`（`:411-426`）。行形状：`{type:'message', id, role, content, [reasoning], [model, provider, tokens_in, tokens_out], created_at, tool_calls:[{tool, args, result, status, duration_ms}]}`（`:419-425`）。**没有格式版本字段、没有导入路径**。错误：会话不存在 → **404**；构造失败 → **400**；**两条都没 `code`**（`:414`、`:427`）。
- `GET /api/conversations/:id/export-full` → `{ok:true, filename:'rw-session-<id>.json', content:{format:'rw-session', formatVersion:1, exportedAt, conversation, messages, toolCalls, events, usage:{rows}}}`（`:434-441`；形状出自 `server/session-export.js:66-88`）。`formatVersion` 不认识时**显式拒绝**、不降级读取、不部分导入（`server/session-export.js:99-108`）。错误：会话不存在 → **404** `CONV_NOT_FOUND`；导出失败 → **400** `EXPORT_FAILED`（`:437`、`:440`）。
- `POST /api/conversations/import`，体 `content`（导出物）→ `{ok:true, dryRun, ...}`；**默认 dry-run（只校验不写库）**，要真写必须显式 `?dryRun=0`（`:444-453`）。错误：校验/导入失败 → **400** `IMPORT_FAILED`。

### 3.7 审批 / 问询 / 活动（都是只读或很薄的一层）

- `GET /api/approvals` → `{ok:true, pending:[{id, desc, createdAt}]}`（`:1572`，实现 `server/approval.js:37-39`）。**项里没有 `conversationId`**，多会话同时待批时无法直接分辨归属。
- `GET /api/asks` → `{ok:true, pending:[{id, question, options, createdAt}]}`（`:1548-1551`，`server/asks.js:38-40`）。
- 裁决：`POST /api/approvals/:id` 体 `{decision:'approve'|'reject'}`；`POST /api/asks/:id` 体 `{option}` → `{ok:true, decided:<boolean>}`；参数不合法 → **400**（`:1573-1583`、`:1552-1561`）。`decided:false` 表示该 id 已不在队列（超时/已答），不是错误。四个端点**都没有 `code`**。
- `GET /api/conversations/:id/activity?after=<seq>` → `{ok:true, items:[...], seq}`（`:564-572`，实现 `server/agent.js:103-108`）。SSE 之外的第二条投影；错误：会话不属于本人 → **404**，抛异常 → **400**，**都无 `code`**（`:567`、`:571`）。

### 3.8 `GET /api/deliveries`（死信落点）

`?state=<pending|running|succeeded|failed>` 过滤、`?limit=`（默认 20，上限 100，`server/deliveries.js:28`）。失败投递的判据是 `state=failed`；回应 `{ok:true, deliveries:[...]}`，每行字段（`server/deliveries.js:103-109`）：
`{id:<string>, conversationId, idemKey, state, attempts:<number>, messageId, runId, lastError, lastErrorCode, createdAt, updatedAt}`。
错误：只读端点无参数校验，异常 → **500** `INTERNAL`（`:462`）。
**不设"几次算死"的自动阈值**：`failed` 就是死信落点，由人看列表决定。**重放 = 同一个幂等键重发 `POST /api/chat`**，不另造重放 API（`:455-456`、`server/deliveries.js:97`）。`?state=` 取值不校验——给个没见过的值就是空列表，不是错误。
---

## 4. SSE 流协议

**帧格式**：`[id: <seq>\n]data: <json>\n\n`（`:1045-1050`）。`id:` 行只在载荷带正整数 `seq` 时才写（`:1047-1048`）。保活是注释帧 `: ping\n\n`，每 15s 一次（`:1023-1031`）。
**顺序**（正常路径）：`intent` →(`route`，仅档案/壳默认命中时)`→`run_start` → `thinking`/`think`/`tool_start`/`tool_done`/`plan`/`approval`/`ask`/`wait_start`/`wait_end`/`fake_done_warn`/`delta`/`llm_retry` →`done` → `run_end{status:'saved'}`。
- `intent`（`:1060`）：`{type, label, echo, hit}`，**无 seq**。
- `route`（`:1073`/`:1078`）：仅档案或壳默认命中时出现，**无 seq**。
- `run_start`（`:1144-1147`）：`{type, v:1, conversationId, runId, light, provider, model, preset, permission}`。
- 中转帧（`:1194-1228`）：**未知类型原样转发**，刻意不白名单过滤（`:1225-1228`）——客户端必须能忽略不认识的 `type`。
- `done`（`:1294`）：`{type, usage, messageId, runId, totals}`，**无 seq**。它在 assistant 落库**之后**才发（`:1285-1294`），判断本轮成功请用它。
- `run_end`（`:1303-1310`）：`{type, v:1, conversationId, runId, status:'saved', messageId, contentLength, finishReason, guard, usage, totals, spentYuan, capabilities}`。其他终态：`stopped`+`run_end{status:'stopped', reason:'user'|'disconnect', reasonText, messageId, totals, capabilities}`（`:1247`、`:1334-1338`）；`error{message}` + `run_end{status:'error', reason:'exception', reasonText, messageId, capabilities}`（`:1366-1367`）。**`usage` 只在 `saved` 分支出现**，`stopped`/`error` 分支没有。

**`id:` 与 `seq` 的语义（如实写）**：`seq` 是 `server/agent.js:54` 的 `actSeq`——**进程内存的全局单调计数器，重启归零**；事件环只留最近 300 条、本轮结束后 60s 回收（`server/agent.js:55`、`85`、`100`）。所以**续订只对"带 `id:` 的帧"成立**，且只在**同一进程、事件还在环里**时成立；跨重启接不上；无 seq 的帧（`intent`/`route`/`done`/`error`）本来就无法当锚点。

**断连即中止（最要命的一条）**：`req.on('close')` / `res.on('close')` → `actrl.abort('disconnect')`（`server/index.js:1135-1136`，`onDisconnect`）。**调用方在收到 `done` 之前断开，活就停下**，不是"后台继续跑"。服务端随后落一条中断占位消息并给 `run_end{status:'stopped', reason:'disconnect'}`（`:1326-1338`）。

### 4.1 溢出提示（v0.3 §7.1 ⑩ 点名；此前契约与前端全 0 命中）

工具结果超过内联上限时，**不是硬截断丢弃**，而是换成"预览 + 精确省略量 + 定位符"再进上下文
（`server/tools/spill.js` 的 `spillToolResult`，调用点在 `server/agent.js:832`）。
⚠️ **本节用文案本身当锚点、不写 `spill.js` 的行号**：那个文件正在被并行改动（行号当天就漂了），
而下面这三句提示**就是**接口面本身 —— grep 文案比 grep 行号可靠。三种形态的**原文**（逐字节，客户端要照它识别）：

| 形态 | 触发 | 上下文里的提示（前缀） | 取回方式 |
|---|---|---|---|
| 读取类 | 工具在 `READER_TOOLS` 且带 `path` 参数 | `全文即源文件 <绝对路径>（共 <N> 字节）；用 read_file_range 带 offset/length 分段读` | 同路径直接 `read_file_range` 分段读 |
| 已落盘 | 其余工具超限 | `全文已存 <绝对路径>（<N> 字节），取回：fetch_spill {path:"<绝对路径>", offset:0, length:20000}` | `fetch_spill` 按 offset/length 分段取回 |
| 降级 | 落盘失败 | `⚠️ 全文未能存盘（<原因>），已按内联截断降级：请改用分段/过滤参数缩小结果，或自行落盘后再读` | **取不回**：这是显式降级，不是静默截断（登记在 `server/capabilities.js:89` 的 `spill-degraded`） |

- **提示的位置**：它是**工具结果内容本身**（`tool` 角色的消息），不是新的事件帧 —— 所以客户端**不需要**新增帧类型；模型能否自己取回取决于它的工具面里有没有 `fetch_spill`（会话级工具集/壳裁剪会收窄工具面）。
- **溢出文件的保留期与清理**（`server/tools/spill.js` 的 `cleanupSpill` / `SPILL_MAX_AGE_DAYS`、`server/index.js` 的 `runSpillCleanup`）：按龄 **7 天**、按量 **64MB**，启动跑一次 + 每 6h 一次，清理结果落 `spill:cleanup` 审计。**这条直接决定"定位符能用多久"**：超过 7 天的 `全文已存 …` 路径可能已被清理，取回会失败——客户端此时应如实提示"该溢出文件已过期"，不要假装成功。
- **不进本契约的部分**：前端目前**不展示**溢出提示（`src/` 全 0 命中），它只在对话正文里由模型转述。这是如实登记的缺口，不是"已达成"。
- **一处实现坑（如实登记，防复现）**：原 `/api/chat` 在生成早期摘要时写的是 `hist.slice(0, -30)` ——
  那取的是"**去掉最后 30 条**"（几乎全部历史），而作者显然想取"早期那段"。它只影响喂给摘要模型的输入、
  不影响发给主模型的历史，所以此前没被发现；2026-09-16 已随滑窗一并删除。**这类"切片方向写反"的坑在本仓出现过两次**，
  改这里时请直接看语义（要"早期"就 `slice(0, N)`），别信注释。

### 4.2 逐轮成本可见（帧序里此前没写的那一帧）

帧序里除了 `done` / `run_end` 带的成本，还有一条**每轮**都发的成本帧（`server/agent.js:544`，在每轮 LLM 调用**之前**发）：

- `agent_thinking`：`{type, round, costCum}` —— `round` 从 1 起；`costCum` = **本次任务累计费用（元，四舍五入到 2 位）**，取值时点在调用**之前**，所以它**不含本轮**的消耗（本轮的消耗要等 `done`/`run_end`）。
- **口径别混**（四个数不是一回事）：`agent_thinking.costCum` = 本任务累计；`done.totals` = 本任务总计（含本轮）；`run_end.spentYuan` = 本次执行的增量；`GET /api/usage/stats` = 账号/会话累计（含折叠、摘要等旁路 kind）。
- 另有段级指纹帧 `prefix_face`（`server/agent.js:566`）：只在**每段第一轮**发一次，`{type, toolsHash, sysHash, nTools, light, preset, permission}` —— 它的用途是"当时那条前缀面到底是什么"的可对账证据（`usage_stats.prefix_tools_hash` 记的是整份工具定义面，两者不同源）。

### 4.3 可回滚（v0.3 §4.7「可信」要求：说清有什么、以及边界在哪）

**没有统一的"撤销这一轮"接口**。现有的回滚手段是三条**作用域完全不同**的机制，各自的边界必须一起读：

| 层次 | 手段 | 能回滚什么 | 边界（不得当成"都能撤"） |
|---|---|---|---|
| 文件 | `undo_checkpoint` 工具（`server/tools/checkpoint.js:88-117`） | 写类工具执行**前**的自动快照：`existed=true` 恢复原内容；`existed=false`（新建）删除该文件 | ① 只覆盖 `write_file`/`append_file`/`edit_file`/`delete_file` 四类（`checkpoint.js:15`）；② 单次最多 20 个文件、单文件 >5MB **不快照**（`:16-17`）；③ 每会话只保留最近 60 个快照，超出淘汰最旧（`:18`）；④ **只回滚文件系统**：shell 命令的副作用、`db_write`、git 推送、`reload_platform` 重启一律**撤不回** |
| 会话 | `/export` 与 `/export-full` + `POST /api/conversations/import`（§3.6） | 会话的**副本**：导出一份、以后导回成一个**新会话** | **不是原地回滚**：没有 `rollback`/`restore` 端点，也不能把已有会话退回某个 `messageId`。`formatVersion` 不认识时显式拒绝（不降级、不部分导入） |
| 现场 | `agent_runs` 现场 + `resumeHint` 注入（`server/runtrack.js`、`server/index.js:1007` 的 `resumeHint(conversationId)`） | 中断/挂起的任务**接着跑**（续，不是退） | 它是"接着往下做"，不撤销已做的动作 |

- **契约面缺一项（如实登记）**：目前**没有** `POST /api/conversations/:id/rollback` 这类端点，也没有"回滚到第 N 条消息"的语义。
  触发条件：出现真实调用方需要"整轮撤销"（而不是"改坏了用 `undo_checkpoint` 回文件"）时再立项——按 §6 规则 1，新增端点属只增不改。
- **模型侧的自述不可信**：模型说"已回滚"只能当线索，最终以文件系统/DB 实时查询为准（`server/capabilities.js:133` 的 `selfReportUntrusted`）。

---

## 5. 幂等与重试 · 限流 · 错误码

### 5.1 `Idempotency-Key`

位置在"参数已校验、并发槽还没占、库还没写"这个**还没有任何副作用**的时点（`:832-852`）。语义（实现 `server/deliveries.js:40-81`，表 `server/db.js:269-286`）：

| 情形 | 结果 |
|---|---|
| 同一 `账号 + key`，上次已**成功** | **回放原始接受结果**：`{ok:true, replayed:true, messageId, runId, content, usage}`；不再落消息、不再跑一轮（`:847-850`；`content/usage` 来自 `:1298` 存的 `response_json`，缺失时退化为 `{messageId, runId}`，`server/deliveries.js:51`） |
| 同一 key，上次**仍在进行中** | **409** + `code:'IDEMPOTENT_IN_PROGRESS'`（`:841-843`） |
| 同一 key，**请求体不同** | **409** + `code:'IDEMPOTENT_KEY_REUSED'`（`:844-846`；指纹含 `conversationId/content/provider/model`，`:839`） |
| 同一 key，上次以 **`failed`** 结束 | **允许重发**，`attempts+1` 并回到 `running`——这就是死信的人工重放路径（`server/deliveries.js:62-68`） |

**不设时间窗口**：键随会话寿命存在（唯一键 `(account_id, idem_key)`）。行清理策略等出现真实增长再定。**回放的是非流式结果**：流不可重放，调用方要事件就按 `messageId` 走 `/messages` 与 `/stream` 补（`:848`）。
**它防不了什么（务必别误信）**：① 浏览器在 `done` 前断开 → 服务端本来就会中止本轮（§4），**此时没有可重放的结果**；② 进程崩溃 → 不保护（各有既有机制：现场登记 `ensureRun` `:1138`、断点回填 `resumeHint` `:977`、中断占位消息 `:1330`）。幂等键防的是"**已经派出去的活被再做一遍**"（重复花钱 + 有副作用的工具执行两遍），不是"断线也不丢"。

### 5.2 限流

同账号同时在跑的轮次 ≥ `settings.max_concurrent_chats`（默认 5，`0`=不限）→ **429** `CONCURRENCY_LIMIT`（`:830-831`、`:857`）。计数在写库前占位（`:859`），收尾释放（`:1374`）。
**故意不给 `Retry-After`**（`:855-856` 的裁决）：槽位何时释放取决于别人的对话跑多久，服务端给不出真值，编一个数只会误导调用方。客户端按 `规范/04:146` 指数退避重试；**4xx 不要重试**。

### 5.3 错误码表

错误响应**新增** `code` 字段（机器可读），`message` 与 `ok` 语义**不变**。D4-2 定的第一批六个：

| code | 含义 | 出处 | 客户端该怎么处理 |
|---|---|---|---|
| `PARAM_MISSING` | 必填参数缺失 | `:739` | 不重试，补齐字段 |
| `CONV_NOT_FOUND` | 会话不存在或不属于本人 | `:437`、`:741` | 不重试，检查 id / 换账号 |
| `CONCURRENCY_LIMIT` | 并发达上限 | `:857` | 退避后重试；先停一个在跑的轮次 |
| `IDEMPOTENT_IN_PROGRESS` | 同 key 上一轮还在跑 | `:842` | 等待并**用同一个 key** 重试；**不要换 key**（会真跑第二遍） |
| `IDEMPOTENT_KEY_REUSED` | 同 key 换了请求体 | `:845` | 不重试；换一个新 key，或原样重发上次那个请求 |
| `INTERNAL` | 服务端未预期异常 | `:462`、`:1369` | 可退避重试；持续失败报障 |

**落地范围（别当成"所有 4xx 都带 code"）**：带 `code` 的是会话 API 的主力路径 + **鉴权** —— `/api/chat`、`/export-full`、`/import`、`/deliveries`、`requireAuth` 的 401/500（`UNAUTHORIZED`/`TOKEN_EXPIRED`/`INTERNAL`）、以及 Express 兜底 500（`INTERNAL`）。**暂时没有 `code` 的**：登录/停止/续订/消息/活动/审批/问询的 4xx（§3 各处已标注）。本批另有 `EXPORT_FAILED`、`IMPORT_FAILED`。**与 `server/failures.js` 的关系**：HTTP 响应里的码**全部登记**在 `server/failures.js` 的 FAIL 表（同一张表是"码的唯一出处"，夹具 `test/failures.test.mjs` 交叉核对"源码里出现的码都在表里"）；表里的 `TOOL_*`/`LLM_*` 只用于工具与 LLM 的内部结果 `{error, code}`，**不进 HTTP 响应**——两套码共用一张表，不共用出口。

---

## 6. 变更规则

1. **只增不改**：不加不删、不改既有字段的含义或类型；**新字段必须可选**（老客户端不认识也不会崩）。
2. **枚举只增不减**：`run_end.status`、`stream_end.reason`、`run_end.reason`、`deliveries.state`、错误 `code` 都是只增；客户端对未知取值必须有兜底分支。
3. **未知帧类型必须忽略**：服务端刻意原样转发未知事件类型（`:1225-1228`），白名单式客户端会自己坏掉。
4. **废弃流程**：先标注（文档 + 响应头），观察无调用方后再下线；不静默下线。
5. **破坏性变更**：新开端点或新开路径版本（`规范/04:154`），旧的至少并行保留一个迭代周期。
6. 本文档与代码不一致时，**以代码为准**，并当场改文档。
7. **新增"进请求前缀"的注入点必须同时登记缓存影响**（v0.3 §4.4.1 规则5）：在 `server/prefix-participants.js` 的声明表里加一行，
   `where`/`cacheImpact` 二选一并附**源码锚点**；夹具 `test/prefix-participants.test.mjs` 会核对锚点是否还在。
   2026-09-16 起，`/api/chat` 每次组装前缀后还会落一行 `prefix:assemble`（跨轮指纹），
   上一轮的 cnt 条若不再逐字节是本轮前缀的开头 → 记 `prefix:invalidate`（C4 非预期，`server/history.js` 的判据）。
   **这条是"只追加"纪律在跨 run 维度上的唯一机检**——agent.js 的 `diffCore` 每 run 重置，看不见这一层。

---

## 7. 已知限制与不做的事（如实）

- **无路径版本**（§1）；**无出站回调**：`POST /api/chat` 是流式同步返回，"活干完通知你"**目前不存在**。要做是一件新能力（回调地址 + 重试语义 + 签名），不是给现有响应加个字段；**触发条件**：出现第二个真实第三方调用方且它无法保持长连接时再立项。
- **死信不自动重试**：`deliveries` 只记 `state=failed` + `attempts`，**没有重试引擎**，没人看列表就不会有人重放（§3.8、§5.1）。
- **审批/问询队列在内存里**：`server/approval.js:4`、`server/asks.js:4` 都是进程内 `Map`——**进程重启即全部丢失**；超时分别 5 分钟（`server/approval.js:17`）与 10 分钟（`server/asks.js:17`）。两个列表端点**不按账号过滤**，任何已登录账号都能看到全部待批项。
- **`events` 账本只写不读**：`server/eventlog.js:57` 的 `readEvents` **零调用方**（全仓 grep 只命中定义）；对外也没有读事件的端点。
- **续订的物理边界**：事件环 300 条 / 结束 60s 回收 / `seq` 进程内存值 / 跟播上限 10 分钟（§4）。注释里写的 `stream_gap` 帧**未实现**——续订只按 `seq > after` 补发，客户端拿不到"你接丢了一段"的信号。
- **`GET .../messages` 不带执行归属**：没有 `runId`/`seq`（§3.5）；**`code` 只覆盖部分路径**（§5.3）；429 **故意不给 `Retry-After`**（§5.2）。
- **`GET /api/deliveries` 没有分页游标**：只有 `limit`（≤100）与 `state` 过滤（`server/deliveries.js:98-102`），行数涨上去后翻不动。
- **跨端一致**❌ **仍未成立**（v0.3 §4.7 的第四要素；2026-09-16 核对报告 §3.5① 当初是用代码反证的）。
  飞书与微信**不走本契约**：各自是 `POST /api/feishu/webhook`（webhook）与 iLink 长轮询（`client.on('message')`），
  没有 SSE 通道，所以 §4 的帧与续订语义**在渠道上不存在**。**2026-09-16 已改（这一条按改动后的实情写）**：
  两个渠道改走共享入口 `server/channels/run-turn.js`（`runChannelTurn`），与 `/api/chat` **语义对齐**的部分：
  ① **可观测**：事件落 `events` 账本（`run_start` = 含 `channel`/provider/model/permission → 引擎侧 emit 逐条 → 终结事件 `run_end`/`stopped`/`error`），形状与 `/api/chat` 的对应帧同字段；`events.seq` 为 **0**（`seq` 是 `server/agent.js` 内存事件环的计数器，渠道不走那条环，不是"漏写"）。
  ② **可信**：投递记录照记（`beginDelivery`/`finishDelivery`，`account_id=NULL`）——成功 `succeeded` 并存接受结果，失败 `failed` + `code`（`STOPPED_BY_USER`/`ABORTED`/`INTERNAL`，取自 `server/failures.js`）；渠道**没有幂等键**，所以 §5.1 的回放/重发语义**对渠道不成立**，投递记录在这里只是留证。
  ③ **可控制（一半）**：每轮登记 `agent_runs` 现场（`ensureRun`/`markRun`），"可续"的前提有了；停止只有**进程内**入口 `abortChannelTurn()`（`run-turn.js`），**HTTP 面没有接线**——`POST /api/chat/stop` 读的是 `server/index.js` 的私有 `abortMap`（键 `accountId:conversationId`；渠道会话的 `account_id` 是 NULL），本轮按"不改 `/api/chat` 那条链"的约束**没有动它**。
  ④ **仍未做（逐条如实）**：**运行中打断 = 无入口**（只有进程内函数）；**`/api/chat/stop` 停不了渠道会话**；**续订 = 无**（渠道没有 SSE 与事件环，要事件只能读 `events` 表，而 `readEvents` 至今零调用方，见上一条）；**审批/问询 = 只有一半**——卡片事件现在会落账本，但 `GET /api/approvals`、`GET /api/asks` 与 `POST /api/asks/:id`（§3.7）**都没有按渠道路由**，所以渠道里发起的 `ask` 既不在渠道里回答、也没有一个"这个问询属于飞书会话"的入口；人在渠道里**无法**回答 agent 的提问（要登录 GUI 才看得到、答得上）。
  三端现在共用的仍是**内核 + 这一层语义**；契约面与端上 UX（谁发事件、谁来答问询）仍未收敛到一处。
  **收口方向**（未做）：渠道改走 `POST /api/chat` 拿事件流，或按 v0.3 §4.7 的对外形态（headless → MCP → JSON-RPC）做同一个适配器面。
  在收口完成之前，**"端到端语义完全一致"这个结论仍然是错的**；本契约的帧序、停止、幂等三节只覆盖 `/api/chat` 这一条链。
  **本轮改了哪一半**：两侧行为由夹具 `test/channel-turn.test.mjs` 锁住（事件入账本 / 投递随成败 / 失败码 / 模型取自会话不再硬编码 / 中止与后续轮次）；**渠道真机收发消息本轮没有条件验证**——夹具只证明"语义这一层"，不证明飞书/微信的线上链路。
- **能力清单的诚实性字段只在两条出口**：`promptInjection` / `dataEgress` 走 `/api/agent/capabilities` 与 `run_end.capabilities`（给人看），
  **不进模型上下文**（`server/capabilities.js:30-31`、`:50`）——所以别拿它当"模型也知道自己受什么约束"的证据。

---

## 8. 兼容基线（改了就让这两个脚本报红）

两个脚本的解析方式本身就是兼容面：按 `\n\n` 切帧，取以 `data:` 开头的那一行、`JSON.parse(line.slice(5))`（`selfcheck.mjs:72-76`、`agent-smoke.mjs:61-64`）——所以 `id:` 行加在 `data:` **之前**安全，加在之后会破。

**`scripts/selfcheck.mjs` 断言**（行号同文件）：
- `:37` `GET /api/health` → `ok===true` 且 `service==='rw'`；`:42` 登录返回 `token`；`:52` 建会话返回 `id`；`:89` 删会话返回 `ok===true`。
- `:45-48` `GET /api/models`、`/api/providers`、`/api/toolset`、`/api/settings`、`/api/tasks`、`/api/approvals`、`/api/market/list` **都** `ok===true`。
- `:73`、`:77-79`、`:85` `POST /api/chat` 流里**同时**出现 `data:` 行、至少一个 `type==='delta'`、一个 `type==='done'`。破坏它：改响应外壳/字段名、去掉 `data:` 前缀、改 `delta`/`done` 类型名。

**`scripts/agent-smoke.mjs` 断言**（行号同文件）：
- `:44` 登录返回 `token`；`:49` 建会话返回 `id`；`:74`、`:82` 两轮都收到 `done` 且**无** `error` 帧；`:75` `run_end.status==='saved'`。
- `:76` `run_end.capabilities.used.length > 0`（形状见 `server/capabilities.js` 的 `capabilitySummary`：`{enforcement, promptInjection, layers, used}`）。
- `:77-78` 帧类型集合**包含全部**：`intent`、`run_start`、`tool_start`、`tool_done`、`done`、`run_end`。
- `:85-87` 工具调用落 `tool_calls` 账（≥2 条，这是"静默丢账"的回归锁）；`:88-89` 落 `audit_log` 的 `tool:<名>` 行（≥2 条）。
- `:92-93` 每轮 `usage_stats.kind='round'` 行都带 `prefix_sys_hash` 与 `prefix_tools_hash`；`:94-95` 同一会话工具面指纹 ≤ 2 种（单向粘滞）；`:96-100` 每请求缓存命中率中位 ≥ 50%。破坏它：改任一事件名、合并 `done` 与 `run_end`、拿掉 `capabilities`、不发 `intent`/`run_start`、改落账路径、去掉前缀指纹、让工具面来回翻。

**最容易被顺手改掉的四条**：`done` 与 `run_end` 合并成一条；`capabilities` 从 `run_end` 里拿掉；`intent`/`run_start` 被"优化"掉；帧里不再带 `data:` 前缀。任一条都会让部署后第一件事要跑的检查变红。
