# D4 对外形态 · 会话 API 契约方案（只读调研 + 草案）

> 范围：`架构文档冲突登记-20260915.md:142` 的 **D4 → A 会话 API**（先 A 后 B，C 不做）+ 锚点 `RA-42`
> （`幂等键 / 回调 HMAC / 死信落点`）。**本文只调研与起草，不改任何既有文件、不落代码。**
> 原始意图来源：`docs/archive/agent-arch-input-20260915/45-capability-and-scenarios.md:242`（P20）。
> 行号均对当前工作区；每条结论都可指到 `文件:行`。

---

## 一、现状（事实）

### 1.1 对外 HTTP 面到底是什么

- **只有一条 HTTP 面**：`server/index.js` 一个 Express app，全部 122 条路由都在 `/api/*` 下（`grep '^app\.'` = 122 处，
  98 条带 `requireAuth`），静态前端与 SPA 兜底在 `server/index.js:2527-2530`。**没有独立的对外端口、没有 OpenAPI 描述文件、没有版本前缀。**
- **鉴权只有一种**：`Authorization: Bearer <token>`，token = 128 位随机 hex（`server/auth.js:9`），存 `sessions` 表、
  有效期 `SESSION_DAYS`（默认 5 天，`server/config.js:41`），`requireAuth` 只做"token 存在且未过期"（`server/auth.js:65-75`）。
  **没有** API Key、没有 scope/权限位、没有每调用方独立凭证（`server/index.js` 里唯一的非 Bearer 写路由见 1.4）。
- **`POST /api/chat` 是唯一执行入口**（`server/index.js:699`）。请求体：`{conversationId, content, provider?, model?}`
  （`server/index.js:700`）；`conversationId`/`content` 缺失 → `400 {ok:false,message:'参数缺失'}`（`:701`）；
  会话不属于本人 → `404`（`:702-703`）；同账号并发超 `max_concurrent_chats`（默认 5）→ `429`（`:792-796`）。
- **响应是 SSE 流，不是 JSON**：200 头在 `server/index.js:954-959`，帧格式 `[id: <seq>\n]data: <json>\n\n`（`:987`），
  每 15s 无数据发 `: ping\n\n` 注释帧保活（`:963-970`）。`id:` 行**只在载荷带 seq 时**才写（`:985-986`）。
- **续订口 `GET /api/conversations/:id/stream`**（`server/index.js:1341`）：只读、白名单式补发（`Last-Event-ID` 头或 `?after=`，`:1345`），
  先发 `stream_hello`（`:1385`），跟播上限 10 分钟（`:1354`），接不上时发 `stream_gap`。**它绝不触发执行**（`:1334-1336` 注释即此项设计意图）。

### 1.2 事件类型与顺序（事实契约）

`send()` 是**唯一出口**（`server/index.js:973-991`，注释明写"这里是对外事件契约的唯一出口"），事件账本也挂在这里（`:980`）。

| 顺序 | 类型 | 出处 |
|---|---|---|
| 1 | `intent`（B2 意图灰字） | `server/index.js:998` |
| 2 | `route`（仅当档案/壳默认命中） | `:1011` / `:1016` |
| 3 | `run_start` `{v:1,...}` | `:1082-1085` |
| 4.. | `thinking` / `think` / `tool_start` / `tool_done` / `plan` / `approval` / `ask` / `wait_start` / `wait_end` / `fake_done_warn` / `delta` / `llm_retry` / 以及**未知类型原样转发** | `:1131-1167`（转发表）；未知类型照发是刻意的，理由是"账本不能漏事件"（`:1163-1164`） |
| 终 | `done` → `run_end` | `:1232`、`:1236-1243`；**先落库再发**是修正过的竞态（`:1217-1220` 注释） |
| 异常终 | `error` → `run_end{status:'error'}` | `:1295-1296` |
| 停止终 | `stopped` + `run_end{status:'stopped'}` | `:1185`、`:1267-1272` |

- `run_end` 有 `{status: saved|stopped|error, messageId, contentLength, finishReason, guard, usage, totals, spentYuan, capabilities}`（`:1237-1242`）。
- **错误外壳**：全部错误是 `{ok:false, message:'中文'}`（例：`:701`、`:795`、`:1275-1296` 的 `error` 帧只有 `message`）。
  **全仓没有结构化错误码**——`server/failures.js:15-44` 的码表只用于**工具/LLM 内部**（`{error, code}`，`:50-54`），**从不进 HTTP 响应**。

### 1.3 「会话导出已都在」不成立（与冲突登记的现状描述不符）

- 真在线的只有 `GET /api/conversations/:id/export`（`server/index.js:407-424`）：返回 `{ok, filename, content}`，
  `content` 是**无格式版本字段、无导入路径**的 JSONL 字符串。同文件 `:405-406` 注释明说 markdown 分支已删、只留机器可读。
- `server/session-export.js` 是**完整实现但零调用方**：`rw-session` + `formatVersion`（`:28-29`）、版本不认识就显式拒绝（`:107-108`）、
  事务化导入且 dryRun 默认（`:162-164`）。全仓 grep `session-export` / `importConversation` / `SessionFormatUnsupportedMigrationError`
  **只命中它自己的文件与注释**——**没有任何路由引用它**。
- 同类"写了没人读"还有一处：`server/eventlog.js:57` 的 `readEvents` **零调用方**（grep 只命中定义）。
  ⇒ 事件账本目前**只写不读**，"可回放"缺读者；这也直接影响 §3.3 的死信载体判断。

### 1.4 事实上的外部调用者（写契约必须对齐的四类）

1. `scripts/selfcheck.mjs`：`POST /api/auth/login`（`:40`）→ 一批 GET 必须 `ok===true`（`:45-48`）→ `POST /api/conversations`（`:51`）
   → `POST /api/chat` 手工切帧（`:60-82`）。**它的帧解析依赖两件事**：`data:` 行存在（`:73`），且 `delta`/`done`/`error` 三种类型名（`:77-79`）。
2. `scripts/agent-smoke.mjs`：同样的切帧方式（`:61-64`），并**硬断言事件序列** `intent→run_start→tool_start→tool_done→done→run_end`
   必须齐全（`:77-78`），且 `run_end.status==='saved'`（`:75`）、`run_end.capabilities.used` 非空（`:76`）。
   ⇒ **改事件名/合并`done`与`run_end`/去掉`capabilities`，这两个脚本必红**（它们是部署后第一件事要跑的检查，见 `:11`）。
3. `server/channels/feishu-webhook.js`：`POST /api/feishu/webhook`（`:105` 挂载，`:63` 处理）——**全仓唯一无 `requireAuth` 的写入路由**
   （实测 grep 只此一处）。它**只做可选 AES 解密**（`:71-73`，密钥缺失时明文照收），**没有签名/来源校验**，**对同一事件无去重**（`:78-98` 每收一次就建会话/跑 agent）。
4. `server/driver.js` + `server/scheduler.js`：会话内的无人值守驱动（见 1.5），不经过 HTTP。

### 1.5 无人值守下的异步交互（RA-42 必须面对的现实）

- 审批 `server/approval.js`：**内存 Map**（`:4`），**5 分钟**超时自动拒绝（`:14-17`）。问询 `server/asks.js`：**内存 Map**（`:4`），**10 分钟**超时（`:14-17`）。
  两者都**不落库**：进程重启即全部丢失，且没有对外可查的持久队列。
- 对外可查的只有 `GET /api/approvals`（`server/index.js:1499`）与 `GET /api/asks`（`:1475`），都读内存 Map，**只有条数与描述**。
- 真正落库的"等人决策"是契约那条线：`task_contracts.status` + `attempts` + `last_ask`（`server/db.js:364-381`），
  经 `POST /api/contracts/:id/answer` 恢复（`server/index.js:1915`）。
- 无人值守判定靠 `ctx.__autonomous`（`server/agent.js:277`），命中时工具**不阻塞等待**而是排队并让模型收尾
  （`server/tools/index.js:1500-1501`，失败码 `TOOL_QUEUED_UNATTENDED` 见 `server/failures.js:24`）。
- **SSE 断连即中止本轮**：`req.on('close')`/`res.on('close')` → `actrl.abort('disconnect')`（`server/index.js:1042-1044`）。
  这是外部调用者最需要知道的一条：**调用方断开 = 活停下**，不是"后台继续跑"。

---

## 二、「固化契约」具体要固化什么（只列真的缺的）

判定依据：`E:/projects/_global/规范/04-接口规范.md`（§一 版本放路径、§二 统一响应体、§三 状态码 + 业务码、§八 只增不改）。
**与本平台现状冲突的地方，以"既有调用者不破"为先**（§1.4 两个脚本就是既有调用者）。

### 2.1 已经稳定、**不要动**的

- `POST /api/chat` 的请求体三字段、`GET /api/conversations/:id/stream` 的续订语义、SSE 帧格式 `[id:]data:`、`: ping` 保活、
  `intent→run_start→…→done→run_end` 的顺序、`run_end` 的字段集。理由：§1.4 的脚本逐条断言这些，且 `run_end` 顺序修的是真实竞态（`:1217-1220`）。
- `{ok:true, ...}` 的外壳（成功路径）。§二 要求 `data` 包裹，但**本平台 98 条路由都不是**；改壳＝破坏 `selfcheck` 的 `ok===true` 断言之外的全体前端。

### 2.2 真的缺、且现在补齐不会破坏任何调用者（**建议补**）

| # | 缺什么 | 证据 | 补法（只增不改） |
|---|---|---|---|
| C1 | **没有版本标识**：§一 要求 `/api/v1/…`，实际无前缀；`run_start`/`run_end` 各自带 `v:1`，**只覆盖流内两帧** | `server/index.js:1083`、`:1237` | 不动 URL；把 `v` 正式定义为**流协议版本**并在 `stream_hello` 也带上。协议版本与 URL 版本分离，避免全站改路径 |
| C2 | **错误没有机器可读码**：§三 要求"状态码表大类 + 业务码说具体"，实际只有中文 `message` | 全仓 grep：`failures.js` 的码从不进 HTTP 响应 | **只增一个新字段** `code`（不删 `message`、不改 `ok`）。第一批码建议只覆盖调用方真会分支的：`PARAM_MISSING`/`CONV_NOT_FOUND`/`CONCURRENCY_LIMIT`/`INTERNAL`。**要你拍板**（见 §5-D2） |
| C3 | **`id:` 只在带 seq 时才有**，`intent`/`route`/`done`/`error` 无 seq；且 seq 来自**进程内存计数器**（`server/agent.js:54` 的 `actSeq`，重启归零） | `server/index.js:985-986`、`server/agent.js:54-55` | 由 C1 的协议版本承诺"续订只对带 seq 的帧成立"，或在账本侧改用**持久 id**做续订锚。**要你拍板**（§5-D3） |
| C4 | **没有 `GET 状态` 的对外口**：§P20-2 要求"异步 + 回调 + 状态查询"，`/activity` 只认本人账号（`server/index.js:528`），且环是内存、300 条、结束后 60s 回收（`server/agent.js:55`、`:100`） | 同左 | 这就是 §3.3 死信落点的另一半：外部调用者要能拿 `run_id` 查"跑成没跑成" |
| C5 | **没有限流/退避的对外声明**：429 已经会返回（`:794-796`）但**不带 `Retry-After`** | `:795` | 加响应头即可（§七 要求客户端退避，但没说服务端必须给）；**只加头不改体**，零破坏 |

### 2.3 明确**不建议**现在动的

- 错误体改成 §二 的 `{ok:false, error:{code,message,detail}}` 嵌套形状：会破坏**全部**现有前端与两个脚本的解析，收益（合规）不抵代价。
- URL 加 `/v1`：同上。
- 字段名从 camelCase 改 snake_case（§五）：同上，且 `conversationId`/`messageId`/`runId` 已在两个脚本与前端里用死。

---

## 三、RA-42 三件的最小设计

> 纪律：三件都先写清**它防的是哪一种真实故障**；**窗口/阈值一律不自己拍**。

### 3.1 幂等键（Idempotency-Key）

- **防的真实故障**：调用方已发出 `POST /api/chat`、连接在收 `done` 之前断掉（或超时），它**无法判断活有没有派出去**，
  于是重发一次 → 现在会**再落一条 user 消息并再跑一轮 agent**（`:804` 无条件 INSERT，`:1069` 起再执行）。
  代价是重复花钱 + 有副作用的工具（写文件/提交/部署）**被执行两遍**。这正是 P20-3「客户重试不会重复干活」。
- **它防不了的（要写进契约，防止误信）**：① 浏览器在 `done` 前断开 → 服务端本来就会中止本轮（`:1042-1044`），
  此时**没有可重放的结果**；② 进程崩溃。这两种各有既有机制（现场保留 `:1262-1263`、`ensureRun`/`resumeHint` `:1076`/`:915`），
  **不要**把幂等键说成"断线也不丢"的银弹。
- **落地位置**：`POST /api/chat` 的**最前面**（`:701` 参数校验之后、`:804` INSERT 之前）——这是现在唯一"还没产生副作用"的时点。
- **存哪 / 重放什么**（**推荐**，但需你点头）：新增一张 `idempotency_keys(key, account_id, conversation_id, request_hash, state, response_json, created_at)`，
  唯一键 `(account_id, key)`；命中且 `state=done` 时**直接回放**原响应的**非流式**形态
  `{ok:true, messageId, runId, content, usage}`（不允许回放 SSE——流不可重放；调用方若要事件，用 `messageId` 走 `/messages` 与 `/stream` 补）。命中且 `state=running` → `409`。
- **窗口多久 ⇒ 无依据，需你定。** 理由：本仓唯一同类口径是审计/事件账本的 **90 天**（`server/eventlog.js:72` 明确"沿用 audit_log 那一条，不自己发明天数"），
  但那是**归档**口径，不是幂等窗口；`sessions` 的 5 天（`server/config.js:41`）是登录寿命，也不是。**故不拍数字**，见 §5-D1。

### 3.2 回调 HMAC

- **防的真实故障**（两个方向要分开说）：
  - **入站（有人来调我们）**：`POST /api/feishu/webhook` 现在**无签名无来源校验**（§1.4-3）。任何人知道 URL 就能让平台**新建会话并跑 agent**
    （`server/channels/feishu-webhook.js:91-97`），即"让我们的服务器替我执行工具调用"。
  - **出站（我们回调客户）**：现在**一条回调都不存在**——`POST /api/chat` 是流式同步返回，没有"活干完通知你"的入口。
    出站 HMAC 是**新增能力**，必须先有回调地址与重试语义（§P20-2），不能只做签名。
- **怎么签 / 怎么防重放**（照 DSH 的做法，不自己发明，见 §4）：DSH 的 GitHub 适配器是
  **在解析 JSON 之前**验证 `X-Hub-Signature-256`，失败 `401`，且**不记录密钥/签名/payload**
  （`dsh-webhook-github/lib/types/handler.js:71-88`）。我们要跟的就是这四条：原始 body 签名（不是重序列化后）、
  验签先于解析、失败 401、日志脱敏（本仓已有 `redactSecrets`，`server/index.js:12`）。
- **防重放**：DSH **没有**做时间戳/一次性 nonce；它只验签。要防重放得**自己加**，而格式必须跟**对接方（飞书）的规范**走，不能自创。
  ⇒ **飞书的签名头/算法/是否有时间戳，本次未查证**（见 §6），**无依据，需定**（§5-D4）。

### 3.3 死信落点

- **防的真实故障**：外部调用失败/无人值守下需要授权而排队（`TOOL_QUEUED_UNATTENDED`）/agent 抛异常（`:1275-1299`）之后，
  **没有任何一条记录说得清"哪一次外部调用没做完、能不能重来"**。现有的三处都不是它：
  - `events` 表：append-only、有 `conversation_id/seq/type/payload`（`server/db.js:248-256`），**结构上最像**，
    但 ① 它只存"帧"，**没有调用方身份**（`payload` 里没有 caller/key/attempt）；② `readEvents` **零调用方**（§1.3）；③ seq 是进程内存值（`server/agent.js:54`）。
    ⇒ **能当"事实证据"，不能当"死信队列"**（缺"谁的事、试了几次、怎么重放"三样）。
  - `agent_runs`（现场，`server/index.js:1252`）：有状态但无"外部调用"维度。
  - `task_contracts` + `contract_events`（`server/db.js:364-389`）：**已有 `status` + `attempts` + `last_ask` 与驱动器重试**
    （`server/driver.js`、`server/index.js:1915-1937`）——**全仓唯一现成的"失败可重试"载体**，但它是**任务契约**语义，不是外部调用语义。
- **建议（需你拍板，§5-D5）**：新增 `deliveries(id, account_id, conversation_id, run_id, idempotency_key NULL, state, attempts, last_error, last_error_code, payload, created_at, updated_at)`，
  `state ∈ pending|running|succeeded|failed|dead`。写入点：`/api/chat` 收尾处（成功 `:1232`、停止 `:1267`、异常 `:1295` 三处各写一次结果）。
  - **谁来看**：`GET /api/deliveries?state=dead`（requireAuth，沿用现有鉴权，不新造凭证体系）。
  - **怎么重放**：复用**同一 `Idempotency-Key`** 重发 `POST /api/chat`，由 §3.1 保证不重复执行——**重放入口只有一个，不另造重放 API**。
  - **失败进 dead 的判据（几次算死）⇒ 无依据，需你定**：既有可参照的只有 `attempts`（契约）与 `llm_max_retries`（默认 1，`server/settingsSchema.js:12`、`server/agent.js:595`），
    都不是"外部投递"的次数口径。见 §5-D6。

---

## 四、DSH 对照

| 问题 | DSH 有什么（证据） | 我们跟不跟 / 为什么 |
|---|---|---|
| 对外暴露会话 API？ | **没有对外 REST 会话 API。** 两条既有通道：① **stdio JSON-RPC**——`dsh-sdk-jsonrpc-server`（"进程外 SDK 客户端在运行时中打开会话并驱动 agent 的 stdio JSON-RPC 服务插件"，每个 `sessionId` 一个会话）与 `dsh-acp`（Agent Client Protocol，同样 stdio）；② Web GUI 的 `/api` 是**浏览器↔宿主内部桥**，服务器**"不携带 TLS、认证或来源策略"**，`host` 只接受 `127.0.0.1`/`0.0.0.0`，绑定非回环就是"向该网络公开未受保护的 route"（`dsh-host-webserver/README.zh.md:39,113`） | **形态不同，不照搬。** 我们是 HTTP+SSE 单进程 Web 平台，会话 API 就是 `/api/chat`；DSH 的 stdio JSON-RPC 是"同机进程外驱动"，不解决"互联网上的第三方系统调我们"。**结论：A 这块 DSH 不能给我们现成答案** |
| 幂等键？ | **HTTP 层没有幂等键。** 有**幂等语义**的两处：`ctx.sessionController` 的 `createOrAdopt`（"Create or idempotently adopt one ordinary Session"）与 prompt 的 `requestId`（"Prompt retries whose `requestId` is already queued or logged return the original acceptance without inserting another message"）；`dsh-webhook` README「已知限制」**明写"无内置去重 — 提供方重复交付可能创建重复 Session；需要幂等性的规则自行负责"**（`dsh-webhook/README.zh.md:72`） | **跟语义、不跟字面。** 值得抄的是"**用调用方给的 id 去重、返回**原始接受结果**而不是再执行一遍**"这条语义（正好也是我们 §3.1 的重放形态）。头名 `Idempotency-Key` 来自 `规范/04-接口规范.md:143`，不是 DSH |
| 回调签名（HMAC）？ | **有，且是唯一成型的一处。** `dsh-webhook-github`：要求 `X-Hub-Signature-256`，**解析 JSON 之前**验签，失败 `401`，绝不记录密钥/签名/payload（`lib/types/handler.js:71-88`）；密钥从凭据引用每次请求重解析，故轮换即时生效（README `:35`） | **跟。** 我们入站的 `feishu-webhook` 现在裸奔（§3.2），照这四条收口是**净收益、且不破坏任何现有调用者**（飞书侧配置要动，见 §5-D4） |
| 重试？ | **有，但在 LLM 层不在投递层。** `dsh-llm-retry` 的策略是 `{mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}`，核心两条"只对 `retryableCodes` 重试"+"重试前把意图落进会话并做**可取消**等待" | **已经在跟。** `server/llm/gateway.js:128-135` 明写"照做①②；退避参数**暂不引入**，因为 DSH 仓库里没有实际取值，编一个就是莫须有的值"；`server/agent.js:595-615` 是落地。**投递层重试 DSH 没有对应物**，别去它那儿找答案 |
| 死信 / 队列 / 重放？ | **没有对应物。** `dsh-webhook` 已知限制原文："**仅限进程内 fire-and-forget** —— 崩溃会丢失尚未接纳提示词的规则调用；**不存在队列、重放或重试**"（`dsh-webhook/README.zh.md:71`）；`dsh-webhook-github` 也不"向提供方确认下游工作"，`202` 先于任意规则调用（`README.zh.md:74`）。全包 grep `deadLetter`/`dead-letter` 零命中 | **不做对照结论，就是没有。** §3.3 必须我们自己定，且**没有可抄的先例**——这也是它该被拍板而不是被默认的原因 |
| MCP server（B，本次不做） | DSH **只有 MCP 客户端**：`dsh-mcp-client`。它自己作为 server 的通道是 **stdio JSON-RPC / ACP**，不是 MCP | 与冲突登记 `:113`「MCP 我们只有客户端，服务端要新写」一致；**我们跟它的 stdio JSON-RPC 还是自己写 MCP server，是 B 阶段的第一问**，本次不答 |

---

## 五、需要你拍板的决策清单

| # | 问题 | 选项 | 代价 | 我的建议（一句话） |
|---|---|---|---|---|
| **D1** | 幂等键窗口多久？ | (a) 与 `sessions` 同寿命（默认 5 天，`server/config.js:41`）(b) 与审计账本 90 天同口径（`server/eventlog.js:72`）(c) 按真实重试间隔数据定 | (a) 短，长任务（无人值守可跨夜）会漏；(b) 表会长期驻留、需跟着做归档；(c) 要先有数据 | **无依据，需你定。** 我倾向先 (a) 最省事，但**无人值守任务跨夜重试会被漏**，这条得你确认能否接受 |
| **D2** | 是否给错误响应加机器可读 `code`？ | (a) 只加 `code` 字段、保留 `message` 与 `ok`（b) 不动，维持纯中文 message (c) 按 `规范` §二 改成 `error:{...}` 嵌套 | (a) 小、零破坏；(b) 外部调用方只能靠中文串匹配；(c) 破坏全部前端与两个脚本 | **(a)**：`规范/04:82-88` 的意图是"能定位"，加一个字段就够，不必改壳 |
| **D3** | 续订锚点用什么？ | (a) 维持现状：只对带 seq 的帧承诺续订，并如实说明 seq 是**进程内存值**（重启归零）(b) 改用 `events` 表的持久 `id` 做续订锚（需补读路径） | (a) 跨重启续订接不上（现在就是）；(b) 要动 `agent.js` 的事件环与 `/stream`，属改动执行链 | **(a) 先如实写进契约**，把 (b) 留到真有"跨重启续订"需求时——现在没有调用方要求它 |
| **D4** | 入站 HMAC 按谁的规范？ | (a) 跟**飞书**官方的签名头/算法（需先查证其规范）(b) 自定一套 `X-RW-Signature` 头（我们自己发凭证给调用方）(c) 暂不做入站签名，只做 Bearer | (a) 与既有 `feishu-webhook` 天然对齐，但要先读飞书文档且其配置要改；(b) 通用但要调用方适配、且**等于自创协议**；(c) 裸奔入口继续存在 | **(a) 或 (b) 需你选**；不管选哪个，**"验签先于解析 JSON、失败 401、不记签名"三条照 DSH 抄**。飞书签名规范**本次未查证**（§6） |
| **D5** | 死信载体：新增 `deliveries` 表，还是复用现成的？ | (a) 新增 `deliveries`（§3.3 草案）(b) 复用 `events` 表 + 补调用方字段 (c) 复用 `task_contracts`/`contract_events` | (a) 语义干净，但多一张表 + 三处写入点；(b) 省表，但 `events` 是**只追加的事实账本**，塞"状态机"会污染它的语义（`server/eventlog.js:10-15` 的三条口径）；(c) 零新增，但把"外部调用"硬塞进"任务契约"，两者寿命与归属不同 | **(a)**：`events` 的三条口径（唯一写入点/只追加/投影源）是它值钱的地方，别为了省一张表把它变成状态表 |
| **D6** | 投递失败几次算死信？ | (a) 永不死，只标 `failed` 等人工 (b) 参照 `llm_max_retries`（默认 1）(c) 参照契约 `attempts`（无硬上限，靠人工复测） | (a) 需要人天天看列表；(b) 1 次就死太激进；(c) 不可比（契约是"同一条任务反复修"，投递是"同一次调用反复发"） | **无依据，需你定。** 三个参照物都不是投递次数口径，我不编 |
| **D7** | 两条导出口径怎么收口？ | (a) 保留 `/export`（JSONL）不动，把 `session-export.js` 接到**新** `GET /api/v1/sessions/:id/export`（版本化）(b) 删掉未接线的 `session-export.js`，只留 JSONL (c) 用 `session-export.js` 的格式替换 `/export` | (a) 两条并存（`session-export.js:17-19` 自己就写着"两者并存是**留给人的决策**"）；(b) 扔掉一份带版本/可导入的完整实现；(c) 破坏 JSONL 的既有形状 | **(a)**：`session-export.js:18-19` 的原作者已经把这个决策挂起来了，该由你拍 |
| **D8** | `RA-42` 的验收锚点写成什么？ | 现在两个锚点（`proposals/验收锚点.json:464-478`）都是 `kind:'milestone'`、**无 `anchors`**，等于不可机检 | 建议等上面 D1–D6 定完再补锚点，否则锚点会锁死还没定的设计 | 先定 D1–D6，再补锚点（**顺序反了会返工**） |

---

## 六、我没能确认的东西

1. **飞书事件订阅的签名规范**：本次**未查证**（没读飞书开放平台文档，也不在仓库里）。仓库现状只有 AES 解密（`server/channels/feishu-webhook.js:15-23`）。
   ⇒ §3.2 的"签什么、用什么头、有没有时间戳"**全部无依据**，需查飞书文档或由你给定。
2. **幂等窗口的真实依据**：没有找到任何"外部调用重试间隔"的历史数据或配置。§5-D1 的三个选项都是从**别的口径**借来的。
3. **`session-export.js` 为什么没接线**：只确认了"零调用方"（grep 全仓）。是遗留、是等决策、还是被漏掉，**文件里没写**（`:17-19` 只说了"两者并存留给人的决策"）。
4. **`POST /api/contracts/:id/answer` 之后驱动器的重试次数与上限**：只读到 `attempts` 字段存在（`server/db.js:375`），**没有确认有没有上限逻辑**（未通读 `server/driver.js` 全部 380 行）。
5. **`GET /api/activity` 的 300 条环在真实外部调用场景下够不够**：`ACT_MAX=300`（`server/agent.js:55`）是事实，但"够不够"取决于未定的外部调用形态，**无依据**。
6. **DSH 是否有非 stdio 的对外会话 API**：只确认了 stdio JSON-RPC/ACP 与 Web 内部 `/api` 桥两条，**没有穷举 DSH 全部安装形态**（例如是否存在其他 profile 暴露 HTTP）。
7. **`dsh-webhook` 的 `deliveryId` 到底有没有被任何内置消费者用来去重**：README 明确说"重复交付会再次运行规则"（`:30`），但**规则作者能否拿到它做去重**我只从类型名判断，没读调用示例。
