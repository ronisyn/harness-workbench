# API 契约审计

审计对象：`server/index.js` 全部路由（73 个 app.* 路由声明，去重后 72 个 `/api/*` 端点） vs 前端 `src/api.js` + 全部 `src/*.jsx` / `src/console/*.jsx` 调用（无 `fetch('/api/...')` 绕过封装；只有 api.js 内两处 fetch）。纯静态核对 + 推理，未改任何文件。

方法约定：服务端返回体统一为 `{ok:true, ...payload}`；`api.js request()` 在 `!res.ok || data.ok===false` 时 `throw new Error(data.message || '请求失败 ('+status+')')`。

---

## 一致性缺陷（按严重度）

### P1（会坏功能）

**P1-1 前端调用不存在的 api 方法：`api.asks()` 未定义 → “断连补答审批/问询”功能整体失效**
- 文件:行：`src/Chat.jsx:362`（fetchPending 内 `Promise.all([api.approvals(), api.asks()])`，另 :571 每 ~7.5s 轮询触发）；`src/api.js:55-57`（只定义了 `approvals/decideApproval/decideAsk`，**没有 `asks()`**）；后端 `server/index.js:886` GET `/api/asks` 存在。
- 前端→后端调用：`api.approvals()` + `api.asks()`（期望 GET /api/approvals 与 GET /api/asks 并发拉取 `{pending}`）。
- 不一致描述：`api.asks` 是 `undefined`，求值数组字面量时同步抛 `TypeError: api.asks is not a function`，被 fetchPending 的 `catch { /* 忽略 */ }` 吞掉；由于 Promise.all 参数在函数调用前求值，**`api.approvals()` 的结果也一并丢弃** → pends 恒为 null → 审批横幅（Chat.jsx:840-849）与问询补答恢复入口完全不出现，`GET /api/asks` 后端路由实际无前端可达（→ 亦列入冗余清单）。

### P2（字段不符/易错）

**P2-1 `/api/providers/test` 失败原因被 request() 吞成“请求失败 (200)”**
- 文件:行：`src/console/ModelPlaza.jsx:35-37`；`src/api.js:14`；`server/index.js:315-341`。
- 前端→后端调用：`api.providerTest(baseUrl, key)` POST `{baseUrl, apiKey}`（字段名一致）。
- 后端期望/返回：探测失败时返回 **HTTP 200 + `{ok:false, status, note:'鉴权失败(401): …'}`**（index.js:335/339）。
- 不一致描述：`request()` 只认 `data.message`，无 message 时抛通用 `请求失败 (200)`；UI 只显示 “❌ 请求失败 (200)”，服务端排障关键字段 `note`（401/403 key 无效、无法连通 ECONNREFUSED 等）被丢弃。反向：鉴权通过但 400（模型名被拒）时返回 `ok:true`，前端显示 “✅ 连通（400）” 有误导。属于“响应字段 note 存在但前端契约不消费”的 (c) 类缺陷。

**P2-2 壳列表响应缺 `model_policy`，ShellDev 读列表项 → 默认模型下拉恒空白**
- 文件:行：`src/console/ShellDev.jsx:41-44`（`const sh = shells.find(...); mp = JSON.parse(sh.model_policy)`）；`server/index.js:1202-1204` → `server/shellstore.js:6-8`（`listShells()` SELECT 白名单**不含 model_policy/persona**）；而详情 `GET /api/shells/:key`（index.js:1206）返回 `SELECT *` 全行含 model_policy。
- 前端→后端调用：`api.shellGet(key)` 已把 `detail.shell.model_policy` 拿到手，但代码却从列表项 `sh.model_policy` 取 → 恒 `undefined` → `mpSel` 永不初始化 → 详情页“壳默认模型”两下拉恒空（即使壳已配默认模型），该段解析是死代码。正确数据源应为 `detail.shell.model_policy`。

**P2-3 PATCH /api/shells/:key 的 persona 写库失败（JSON 列裸写裸字符串）**
- 文件:行：`src/console/ShellDev.jsx:128-129`（persona onBlur → `api.shellPatch(key,{persona:值})`）；`server/shellstore.js:76-81`（`patchShell` 对 `allow=['name','description','persona','status']` 非对象值**原样入参**，仅对象才 JSON.stringify）；`server/db.js:291`（`persona JSON` 列）。
- 不一致描述：shells.persona 是 MySQL JSON 列，任何合法 JSON 之外的裸文本（用户输入的中文 persona、或清空后的 `''`）都会触发 `Invalid JSON text` 报错（import 路径 packToRow 是 JSON.stringify 后才落库，patch 路径漏了）。效果：UI 上修改/清空 persona 恒失败（400），DB 保留旧值——契约(b)/(c)类“前端以为已保存、实际未保存”。

**P2-4 模型市场“接入选中模型”跨源串号（前端状态串源 → 错源入库）**
- 文件:行：`src/Chat.jsx:1060-1074`（`selModels` 单一对象、以 model id 为 key、跨 source 共享）；`server/index.js:1092-1098`（POST `/api/market/connect {source, modelIds}`）。
- 不一致描述：每个 source 区块的“接入选中模型”按钮都提交 `Object.keys(selModels)` 里**全部已勾选 id**（含其它 source 勾选）。用户在源 A 勾选后在源 B 点接入 → B 的 provider 名下插入 A 的 model_id（market.js:94-101 快照查不到则 name=mid 兜底写）→ 模型目录被污染、归属错误。属参数语义（modelIds 与 source 未绑定）缺陷。

### P3（轻微）

**P3-1 Dashboard 迷你对话 SSE 处理器集与 Chat 不一致（guard 会话无审批/问询卡片）**
- 文件:行：`src/Dashboard.jsx:82-88` 只挂 onThinking/onDelta/onDone/onError；对比 `src/Chat.jsx:484-491`。
- 不一致描述：迷你对话复用同一 `/api/chat`；当绑定会话 permission=guard 时，服务端照发 `approval/ask`（index.js:751-754），但 Dashboard 无 onApproval/onAsk/onPlan/onToolStart/onToolDone → 高风险工具挂起 5 分钟自动拒绝、结构化问询 10 分钟超时，用户无任何卡片可点（主 Chat 页能看到才算可答）。

**P3-2 `/api/chat/stop` 中止竞态：abortMap 单槽位，多实例/双标签同会话时停止打偏**
- 文件:行：`server/index.js:41/684-686`（key=`accountId:conversationId` → 1 个 AbortController）；`server/index.js:902-906`。
- 不一致描述：同账号同会话并发两路 SSE（双标签/首页迷你+对话页同会话）时，后发请求覆盖 abortMap 槽位；POST /api/chat/stop 只 abort 最近注册的控制器，先发的那路继续跑完（烧 token/落两条 assistant）。前端 stopGen（Chat.jsx:399-415）只停本地 abortRef，另一标签无感知。属 (f) 并发/竞态明显隐患。
- 附带：`server/index.js:482`（inflight++）与 :694（try 起点）之间的异常无 finally 递减，理论上存在 inflight 泄漏窗口（当前中间代码多已自包 try/catch，风险低）。

---

## 前端未消费的 SSE 事件

`src/api.js:117-128` 解析：delta / thinking / think / tool_start / tool_done / plan / approval / ask / intent / route / done / error。
服务端 `server/index.js /api/chat` 全部 `send({type})`：intent(:666) / route(:675) / thinking / think / tool_start / tool_done / plan / approval(:752, 含 id,desc) / ask(:754, 含 id,question,options) / delta / **stopped(:778)** / done / error。

| 事件 | 服务端发送点 | 前端是否消费 | 影响评估 |
|---|---|---|---|
| stopped | index.js:778（用户停止/中断收尾） | **未消费** | 低~中。api.js 事件链无 stopped 分支；正常路径用户点“停止”时前端 stopGen 已本地 abort（Chat.jsx:403-404）+ 800ms 后 loadMessages 拉库对齐，故本标签页无感。但停止由**其它入口**触发（另一标签、服务端侧中断时 SSE 未断流）时，本端不会因 stopped 收尾 → busy 状态/流式占位可能悬挂到本地超时。建议 api.js 增加 stopped→onDone/onStopped 收尾。 |
| intent / route | :666 / :675 | 消费（Chat onIntent/onRoute，Dashboard 无） | Dashboard 无灰字回显（影响小） |
| plan / approval / ask / tool_* | agent emit 转发 | Chat 全消费；Dashboard 无（见 P3-1） | — |

心跳注释帧 `: ping`（index.js:649）无 `data:` 前缀，api.js 按段 split 后正确跳过，无影响。

---

## 后端未使用的路由 / api.js 未使用方法（冗余清单）

### 后端有路由、前端无任何调用方
| 路由 | 位置 | 说明 |
|---|---|---|
| GET /api/models | index.js:85 | 返回 `{providers:[{...,defaultModel}]}`；前端组件 0 调用（模型菜单走 /api/providers）；api.js `models()` 也无人用 → 双端闲置。 |
| GET /api/conversations/:id/export | index.js:235 | 服务端 Markdown/JSONL 导出完整实现，但 Chat 导出走本地 Blob（Chat.jsx:370-386，注释亦自述“前端亦可用本地 Blob”）；api.js 无对应方法。JSONL 机器可读导出（?format=jsonl）因此无人消费。 |
| GET /api/asks | index.js:886 | 设计给 fetchPending 补拉，但 api.js 缺 `asks()`（P1-1）→ 前端不可达。 |
| GET/POST /api/contracts、GET /api/contracts/:id/events、POST /api/contracts/:id/confirm、POST /api/contracts/:id/answer | index.js:1143-1199 | 任务契约全家（driver 的后端配套）无任何前端板块/调用方（Console BOARDS 无对应项；预计契约 UI 后置）。 |
| GET /api/health | index.js:1138 | 无前端调用（自检/运维语义，保留合理）。 |
| POST /api/upload | index.js:1064 | api.js 有 `upload()` 但组件从未调用（文件上传仅服务端 agent 工具场景）；前端无上传 UI 入口。 |
| POST /api/auth/logout | index.js:73 | 前端登出仅 `clearToken()` 本地清理（App.jsx:58），不调 logout → 服务端 sessions 行不删除，token 存活至过期（会话可复用/不失效）。 |

### api.js 有方法、组件从未使用
- `api.models()`（无调用；见上）
- `api.logout()`（无调用）
- `api.upload()`（无调用）
- `api.reviewsAdd(conversationId, result, bugReason)`（无调用 → POST /api/reviews 无前端写入口，ModelObs 只读 reviewsList；“打回必填原因”的复测闭环目前只有后端 API 形态）

### 反向缺失（前端要调用但 api.js 未封装）
- `api.asks` —— 缺失（P1-1）。另：`/api/conversations/:id/export` 亦无封装（Chat 本地实现，未算缺失）。

---

## 其他发现

1. **核对一致（无缺陷）的重点项**（逐一比对通过）：conversations POST `{title,permission,preset,provider,model,project,shell}`（index.js:169-188，含 shell 名→shellId、permission 白名单、project 清洗）；chat POST `{conversationId,content,provider,model}`；settings PUT `{updates}`；capabilities PUT `{updates:{key:bool}}`；toolset PUT `{enabled:[names]}`；access-rules PUT `{rules}`；models PUT `/api/models/:id {enabled}`；providers/test `{baseUrl,apiKey}`（字段名一致，问题仅在错误返回语义，P2-1）；shells PATCH `{name,description,persona,status,modelPolicy}`（字段名一致，问题仅在 persona JSON 落库，P2-3）；knowledge import `{name,data,scope,shellKey,conversationId,hasHeader}`（FE 只暴露 global/shell 两种 scope，conv 分支后端就绪前端未用）；reviews POST `{conversationId,result,bugReason}`；templates list/get、apply POST `{shellKey}`、prompt POST `{goal}`；apps launch POST `{goal,shellKey}`（服务端 shellKey 缺省回落 a.targetShell）。响应字段抽查一致：telemetry/daily `{days,total,rows}`、reviews `{reviews}`、audit `{audit}`、market/list `{sources:[{source,count,models:[{id,name,providerName,domain,connected}]}]}`、providers `{providers:[{connected,models:[{id,provider_id,model_id,name,capabilities,enabled}]}]}`、shells export `{pack}`、usage/stats `{stats:{rounds,steps,llmMs,tokensIn,tokensOut,cost}}`、autotitle `{ok,title}`。
2. **persona 展示的引号问题（存疑低危）**：persona/model_policy 均为 JSON 列（db.js:291/293），mysql2 自动解析后 GET 详情返回对象/字符串，ShellDev 展示正常；但若经非 import 途径写入裸 JSON 文本（如旧数据），`jsafe` 兜底逻辑只在 shells.js 内，前端拿到的可能是带引号 JSON 文本——静态核对无法判定，提示 B1 数据迁移注意。
3. **fetchPending 高频空转**：P1-1 修复前，每次轮询（每 ~7.5s，Chat.jsx:571）与每次 openConv 都会抛一次被吞的 TypeError；修复时建议 `api.asks()` 补上（返回 `{pending}`）而非删除调用。
4. **（f）多实例状态小结**：abortMap 单槽位竞态见 P3-2；`inflight` 并发计数按账号全局（合理）；`autoOpenedRef`（Chat.jsx:222-238）在 App.jsx 按 `key={convParam||'chat'}` 重挂载语义下每挂载一次、有 `convs.length` 守卫，未见明显问题；Chat 输入队列/草稿均已 ref 同步，未发现明显竞态。

---

## 统计

- 一致性缺陷：**7**（P1=1，P2=4，P3=2）
- 前端未消费 SSE 事件：**1**（stopped；另 Dashboard 处理器集差异计入 P3-1）
- 后端无前端调用的路由：**7** 条（/api/models、/api/conversations/:id/export、/api/asks、/api/contracts 全家×5、/api/health、/api/upload、/api/auth/logout）
- api.js 未使用方法：**4**（models、logout、upload、reviewsAdd）；反向缺失封装 1（asks）
- 其他发现：**4**
- 合计：7（缺陷）+ 1（SSE）+ 12（冗余：7 路由 + 4 方法 + 1 缺封装）+ 4（其他）= **24 项**
