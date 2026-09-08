# 前端页面与交互审计

审计范围：`E:\projects\harness-workbench\src` 全部前端（Vite+React），逐页读代码推理（未实际运行）。
说明：凡涉及"接口真实返回形状/语义"的结论，已对照 `server/index.js`、`server/apps.js`、`server/templates.js` 交叉核实（仅用于消除歧义，行号附在对应条目）。
未改动任何源码，仅产出本报告。

---

## 缺陷

### P1（崩溃 / 功能不可用）

**P1-1 `/chat?conv=<id>` 直达链路整体断裂（含"最近会话"跳转与"应用启动"跳转）**
- 文件:行：`src/App.jsx:38-42`（enterChat）、`33-34`（go 把 query 并入 path 状态）、`61-63`（view 按 state `path` 精确匹配）；受害调用方 `src/Dashboard.jsx:136`、`src/console/AppsBoard.jsx:39`。
- 场景：`enterChat(convId)` 执行 `go('/chat?conv='+id)` → `setPath('/chat?conv=N')`。渲染分支 `if (path === '/chat')` 对 `'/chat?conv=N'` 恒 false，`/console*` 也不匹配 → 落入 `else` 渲染 **Dashboard**。
- 问题：在总览首页点"最近会话"、或在 1.6 启动应用后跳转，URL 变成 `/chat?conv=N` 但页面仍显示总览首页（无任何视觉变化）；功能完全不可用。服务端已确认该链路存在（launch 返回 `conversationId+draft`，`server/index.js:1411-1431`），纯前端断。
- 建议：`go()`/比较一律用 `location.pathname`（pushState 后取 `location.pathname`），或 view 分发改为 `path.split('?')[0] === '/chat'`；query 只经 convParam 传递。

**P1-2 刷新/直开 `/chat?conv=N` 不打开指定会话**
- 文件:行：`src/App.jsx:35`（`useState('')`）、`45-49`（convParam 只在 popstate 时从 URL 读）。
- 场景：直接输入或按 F5 刷新 `/chat?conv=N`：`path`=location.pathname=`'/chat'`（不含 search），Chat 正常渲染，但 `convParam`/`initialConvId` 恒为 null → Chat 页打开了指定会话的"自动打开"effect（`Chat.jsx:223-238`）永不触发，草稿 sessionStorage 也不消费。
- 问题：`?conv=` 深链被静默忽略（打开的是空对话页）。
- 建议：mount 时初始化一次 `convParam`：`useState(() => new URLSearchParams(location.search).get('conv') || '')`。

**P1-3 1.6 Agent 广场启动应用→跳对话页预填草稿 主流程失效（onGoChat 从未传入）**
- 文件:行：`src/console/Console.jsx:14-23`（BOARDS 注册表 `render: () => <AppsBoard />` 不传任何 props）、`60`（`board.render()`）；`src/console/AppsBoard.jsx:7`（声明 `{ onGoChat }`）、`33-43`（doLaunch 依赖 `onGoChat`）。
- 场景：在统一后台 1.6 点「🚀 启动应用」，`r.conversationId/draft` 取回后走 fallback 分支：只 `setMsg`（页面内提示）+ `navigator.clipboard.writeText`；**不跳转、不预填**。Console 顶部虽有「💬 对话页」按钮，但需要用户手动过去粘贴，且 clipboard 在非安全上下文/被拒时静默失败（`?.` 后无 catch）。
- 问题：板块声明了 prop 但父级（板块注册表）从不注入 → 启动→对话页无缝接力这一核心 UX（页面文案"启动后跳「💬 对话页」：开场草稿已预填…"）不可用。
- 建议：Console 对 AppsBoard 注入 `onGoChat`/`onGoHome` 等（板块注册表支持给 render 传 props）；同时 P1-1 修好前跳转也不会成功，两处需一起修。fallback 至少给出明确「去对话页」按钮 + clipboard 失败提示。

### P2（状态错乱 / 易错）

**P2-1 输入队列与会话解绑：排队消息可能发到错误会话 / 删会话后滞留**
- 文件:行：`src/Chat.jsx:526-535`（send 忙时把纯文本 push 进全局 queueRef，不记录归属会话）、`539-548`（flushQueue 用 flush 时刻的 `curRef.current` 发送）、`336-343`（delConv 不清 queue）、`299-324`（openConv 切会话不隔离队列）。
- 场景：会话 A 执行中，用户在 B 输入并回车 → 入队；随后切到 C；A 结束后 flushQueue 把该消息发进 **C**。或在 A 执行中删除当前会话 → 队列滞留，面板上「▶ 开始发送」因 `curRef.current` 为 null 点了无反应；新建会话后又会把旧消息发进新会话。
- 建议：队列项携带 `convId`（发往哪会话），flushQueue 只消费归属==当前会话的首条；删除会话时同步丢弃该会话队列项；队列面板按会话展示。

**P2-2 EvoBoard 提案列表把对象当字符串（与 Chat 抽屉同接口两种用法，必有一错）**
- 文件:行：`src/console/EvoBoard.jsx:63-66`（`proposals.map((f) => <button key={f} title={f}>…{String(f).split('/').pop()}`）、`25-28`（`view(f)` → `api.proposalContent(f)`）。
- 交叉核实：GET `/api/proposals` 实际返回对象数组 `{file,title,status,size}`（`server/index.js:994-1006`），Chat 抽屉（`Chat.jsx:1119-1124` 用 `p.file/p.title/p.status`）是正确的。
- 问题：1.5 板块每个按钮显示 `[object Object]`、key 全重复（React 警告 + 列表异常）；点击后 `encodeURIComponent(object)` → 请求 404「提案不存在」。
- 建议：改用 `f.file/f.title/f.status/f.size`；与 Chat 抽屉抽公共 list 组件避免再分叉。

**P2-3 ShellDev 详情输入用非受控 `defaultValue`：切壳后不回显新值，onBlur 可能把 A 壳内容写进 B 壳**
- 文件:行：`src/console/ShellDev.jsx:122-130`（description input / persona textarea 均 `defaultValue` + onBlur 保存）、`117`（detail 条件渲染无 key）。
- 场景：查看壳 A（描述 input 显示 A 文本）→ 点壳 B「查看/配置」：detail 对象被替换但同一位置的 `<input defaultValue=…>` **不会重新应用默认值**（defaultValue 只在 mount 时读一次）→ 输入框仍显示 A 的旧文本；此时用户改一个字再失焦，`onBlur` 按 `detail.shell.skey`（B）保存 → **A 的内容被存进 B**。
- 建议：给 detail 区块加 `key={detail.shell.skey}` 强制重挂载，或改为受控（value+onChange 走 state）。

**P2-4 CapsBoard 平台豁免（defaultOn）工具可被勾选关闭：UI 假状态、语义误导**
- 文件:行：`src/console/CapsBoard.jsx:55-59`（checkbox 无 `disabled={t.defaultOn}`、无豁免过滤）；对照 `src/Chat.jsx:1086-1088`（工具抽屉正确 `disabled={t.defaultOn}`）。
- 交叉核实：GET /api/toolset 对豁免工具恒 `enabled:true`，PUT 服务端过滤 `PLATFORM_EXEMPT`（`server/index.js:141-159`）。
- 问题：1.4 面板上豁免工具的勾可被用户点掉 → 本地乐观 `setTools` 显示为"关"，但服务端恒开；且该假状态会进入后续 toggle 计算（`Chat.jsx:607` 已排除 defaultOn，CapsBoard 未排除）→ 勾选语义与真实生效集不一致，用户以为关掉了高危工具实际没关。
- 建议：CapsBoard 复刻 Chat 逻辑（defaultOn 禁用 + `t.enabled && !t.defaultOn` 计算启用集）。

**P2-5 SettingsBoard 温度滑条几乎不可拖（CSS 15px）+ 键盘调值永不保存 + number 半输入/空串直接落库**
- 文件:行：`src/console/SettingsBoard.jsx:40-46`（range 无内联 flex 撑开）、`styles.css:201-203`（`.rw-cap-item input{width:15px;height:15px}` 会命中该 range，且无更晚覆盖）、`SettingsBoard.jsx:59-61`（number `onBlur` 直接把 `e.target.value` 原样保存）。
- 场景1：1.8 温度滑块被压成 15px 宽，几乎无法操作（Chat 抽屉里同款滑块因内联 `flex:1` 幸存，说明两处表现不一致）。
- 场景2：滑块只监听 `onMouseUp/onTouchEnd` —— 用键盘方向键改值没有 mouseup/touch 事件 → 永不保存。
- 场景3：number 输入中途失焦（如删空、输入"-"）→ `setOne(key,'')` 或 `'-'` 直接写库，不做 clamp/默认回填（Chat 侧 `saveLim` 有 `Math.floor/Math.max(0)` 而此处没有）。
- 建议：给 range 补宽样式（`width:100%` 或 flex:1）；补 `onKeyUp`/`onBlur` 保存；number 保存前 normalize（非有限数/负数/空回退默认值）。

**P2-6 待处理审批/问询横幅「暂不处理」后无法再恢复（同 key 静默压制）**
- 文件:行：`src/Chat.jsx:360-367`（fetchPending 按 key 去重保留 prev）、`847`（「暂不处理」只清空 items）。
- 场景：断连恢复出现待处理审批 → 点「暂不处理」→ `pends.items=[]`；随后每 ~7.5s 轮询再次拉到**相同的** pending 集合，`prev.key === key` → 直接返回 prev（items 空）→ 横幅永远不再出现。而这些审批没有对应的消息内卡片（消息卡片只在当次 SSE 内存在），本会话内将**无法再批准/拒绝**，只能等集合变化或刷新页面。
- 建议：dismiss 记一个不透明的时间戳/标志，超过 N 秒或集合变化后允许重新弹出；或提供「重新显示待处理」入口。

### P3（体验 / 边界）

- **P3-1 新会话无消息时空态缺失**：`Chat.jsx:857` 只在 `!cur` 时显示"← 新建或选择左侧会话"；打开一个新会话（cur 有值、msgs 空）时对话区完全空白，无引导文案。
- **P3-2 切换会话瞬间旧会话数据残留**：`Chat.jsx:299-322` openConv 先 `setCur` 再异步 `loadMessages`，期间 stats（`rw-stats`）、轨迹抽屉 toolcalls、甚至消息内容仍是上一会话的，直到 fetch 返回才覆盖（弱网下可见明显错位）。
- **P3-3 loadConvs/newConv/openConv 顶层无异常处理**：`Chat.jsx:195-198 / 326-334 / 299-324` 无 try/catch；会话列表请求失败=未处理 rejection，且界面表现为"没有任何会话"（误导为真没有），与真实错误不可区分。
- **P3-4 设置抽屉 openDrawer 前置 await 无 catch，单点失败中断整个 tab**：`Chat.jsx:616-641`：`await api.capabilities()`（618）与 trace（632）、tasks（633）分支无 `.catch`；capabilities 接口一旦失败，openDrawer 提前抛错，后续 tools/rules/proposals/trace/tasks 内容全部不加载且无任何提示（仅控制台报未处理 rejection）。
- **P3-5 抽屉 caps 开关失败无提示且乐观更新不回滚**：`Chat.jsx:747-750` toggleCap 无 catch（对照 1.4 CapsBoard 有 err）；勾选后接口失败时 UI 停留在错误的勾选态。
- **P3-6 流式请求在组件卸载时不 abort**：`Chat.jsx:443-444`（runText 的 AbortController）、`Dashboard.jsx:69-71`；页面切走（首页/后台）后旧 SSE 继续在后台跑完，返回时忙碌/停止按钮状态丢失，只剩轮询兜底；Dashboard 的 mini 请求同样无 unmount abort。
- **P3-7 草稿仅存内存**：`Chat.jsx:145` draftsRef 只随组件存活；Chat→首页→再进对话页（App key 变化重挂载，`App.jsx:61`）后，各会话未发送草稿全部丢失。
- **P3-8 "自动路由"下模型下拉值不匹配**：`Chat.jsx:836-838` 选项只有 `<option value="">默认</option>` 而 state `model='__auto__'`（`267-269`）→ select 无匹配 option，下拉显示空白/无法表达"自动"；服务端确实按 `__auto__` 哨兵语义处理（`server/index.js:403-424`），问题只在展示层。
- **P3-9 无显式模型的会话被"传染"上一会话显式选择**：`Chat.jsx:311-321`（openConv 只在 `c.provider` 有值时才恢复，无值则保留当前模型栏）＋ `448`（发送时 `provider/model` 恒带 body）；服务端 body 优先于会话存储（`server/index.js:443-447`）→ 一个"退回默认/无显式"会话在打开后首次发送仍带着上一个会话选定的厂商模型，形成事实上的显式锁。
- **P3-10 Console 板块导航交互缺角**：`Console.jsx:31-32`（未知 `/console/xyz` 静默回退 models-plaza 且 nav 无高亮）、`50-53`（点击当前板块不触发任何刷新，无手动刷新入口）；从首页「🎛 后台」进入的是 `/console`（无板块路径），同样无 nav 高亮。
- **P3-11 ShellDev 两处细节**：`ShellDev.jsx:53` doImport 后直连 `loadDetail(r.key)` 而不走 `showDetail` → `mpSel` 未初始化，新导入壳的"默认模型"下拉空白（需重新点「查看/配置」才可见）；`58-66` doExport 立即 `revokeObjectURL`，无 Chat 侧特意加的 1500ms 延迟（`Chat.jsx:384` 注释说明会偶发截断下载）。
- **P3-12 Dashboard 数据卡失败态缺失**：`Dashboard.jsx:31-41` 各接口独立 try/catch 全部静默；`147-154` 用量看板在失败时永久显示"加载中…"，其余卡片显示 0/空而无错误或重试提示。
- **P3-13 Dashboard mini "无文本输出"误导**：`Dashboard.jsx:122` —— 工具型回答结束时显示"（无文本输出）"，且 mini 完全不展示工具轨迹，用户无法得知 Agent 实际做了文件操作等。
- **P3-14 Chat 消息"无文本输出"文案错指**：`Chat.jsx:894` —— 仅 think/仅 ask 且无工具轨迹的结尾消息也显示"结果见上方工具轨迹"，指向不存在的轨迹。
- **P3-15 Knowledge embedded 导入后文件框未清空 + 首载空态闪现**：`Knowledge.jsx:68-69` 用 `document.getElementById('kb-file')` 清 input，但 embedded（KbBoard）模式实际 id 是 `kb-file-embed`（104 行）→ 清空失败，同一文件再次选择可能不触发 change、无法二次导入；`129/202` 列表加载完成前闪现"（无条目）"。
- **P3-16 console 板块普遍无加载态，首屏闪现"暂无 X"**：`ModelPlaza.jsx:77`、`ModelObs.jsx:46`、`AppsBoard.jsx:52`、`TemplateBoard.jsx:56`、`ShellDev`（列表区空白）都在数据到达前把空态当结果渲染，弱网下误导为"确实没有"。
- **P3-17 零散小样式/反馈**：`ModelPlaza.jsx:89` 用 `dim` class 但 `styles.css` 无 `.rw-provider-model.dim`（"未接入"无视觉区分）；`CapsBoard.jsx:9-10` msg 状态从未被 set（成功无任何反馈）。
- **P3-18 提案状态"待审"无样式**：`Chat.jsx:1121` `rw-trace-status.pending` 在 `styles.css:232-234` 只有 `.done/.fail` 两态 → 待审提案标签无底色区分。
- **P3-19 样式后段重复定义覆盖知识库弹层意图**：`styles.css:341-345`（整页化 `.rw-mask`/`.rw-drawer`：背景改为纯色、宽 100%/1240px）同特异性晚于 `.rw-kb-mask/.rw-kb-panel`（242-243，深色遮罩 + 620px 窄面板）→ 知识库弹层实际变成与设置抽屉同款"整页"，居中窄弹层 + 半透明遮罩的设计失效（功能仍可用，视觉与注释意图不符）。
- **P3-20 全局 Ctrl+Enter 干扰行内重命名**：`Chat.jsx:389-397`（window 级 keydown）＋ `808-812`（重命名 input 的 stopPropagation 只挡组件层）→ 在重命名输入框内按 Ctrl+Enter 会同时触发当前会话 send。
- **P3-21 流式中 ThinkBox/TracePanel 无法保持收起**：`Chat.jsx:1273/1291` details `open={streaming || undefined}` 受控；流式期间用户点摘要收起，下一帧内容更新又会强制展开。
- **P3-22 导出文件名未净化**：`Chat.jsx:378-384` 以 `curTitle` 直接作下载文件名，标题含 `/\:*?"<>|` 时 download 属性异常。
- **P3-23 首页迷你对话新建会话永不智能命名**：`Dashboard.jsx:82-88` streamChat 的 `onDone` 未调用 `api.autoTitle`（Chat 侧 504 行有），"首页速问"标题会永久保留。

---

## 空态/加载/错误提示缺失清单

| 页面/组件 | 现状 | 缺口 |
| --- | --- | --- |
| Chat 对话区（新会话无消息） | 无任何空态 | 建议"开始对话吧"引导（P3-1） |
| Chat 会话列表加载失败 | 显示成"无会话" | 无错误/重试提示（P3-3） |
| Chat 设置抽屉各 tab 加载失败 | 静默/未处理 rejection | 无失败提示（P3-4/3-5） |
| Chat 流式工具型回答 | "（本轮未产生文本输出）" | 无"仅工具执行"说明文案（P3-14） |
| Dashboard 用量看板加载失败 | 永久"加载中…" | 无错误/重试（P3-12） |
| Dashboard 市场/任务/壳/知识卡失败 | 显示 0/空 | 全部静默（P3-12） |
| Dashboard 迷你工具回答 | "（无文本输出）" | 不展示轨迹（P3-13） |
| ModelPlaza / ModelObs / Apps / Template / ShellDev 首载 | 闪现"暂无 X" | 无 loading 态（P3-16） |
| Knowledge（两种形态）首载 | 闪现"（无条目）" | 无 loading 态（P3-15） |
| Console 未知板块/默认进入 | 回退模型广场 | 无提示、无高亮（P3-10） |
| 全站 401/会话过期 | 仅控制台未处理 rejection | 无统一登出跳转或提示 |

---

## 冗余组件或重复逻辑

- **R1 对话页设置抽屉 与 console 板块双实现且已分叉**：能力开关（Chat `747-750` vs CapsBoard）、工具启用集（Chat `606-614` 带豁免禁用 vs CapsBoard 不带，见 P2-4）、规则编辑（Chat 可编辑 vs CapsBoard 只读表）、提案（Chat 抽屉 vs EvoBoard，且列表形状已不一致见 P2-2）。同一份数据两套 UI，后续必再分叉，建议抽公共组件/单一事实源。
- **R2 settings schema 双份渲染**：Chat 抽屉 caps"高级参数"（`Chat.jsx:983-1013`，debounce 保存）与 SettingsBoard 1.8（blur/mouseup 保存）渲染同一份 `/api/settings` schema；温度/系统提示词/四护栏每处一套状态与保存策略（`Chat.jsx:693-723` vs `SettingsBoard.jsx:29-33`），行为已不一致。
- **R3 定时任务/日报周报三处展示**：Dashboard 卡片、Chat 抽屉定时 tab、EvoBoard 1.5 卡片对同一批 tasks 做三份查找渲染（`tasks.find(id===4/3)` 逻辑复制于 `Dashboard.jsx:95-96`、`EvoBoard.jsx:34-35`）。
- **R4 Knowledge.jsx 双形态大量重复 JSX**：embedded 与非 embedded 两份几乎相同结构（上传区 + 过滤 + 列表各重复一次，~100 行），仅外层容器不同；抽内部面板组件可减半且消除 P3-15 的 id 不一致。
- **R5 工具轨迹两套展示**：消息内 `TracePanel/TraceCard`（`Chat.jsx:52-125,1279-1294`）与抽屉 trace tab（`Chat.jsx:1154-1174`）对同一 toolcalls 数据各自渲染/各自解析 args/结果 diff，且组件内维护 `traces`、组件外又维护 `toolcalls` 双状态，容易出现两边不一致。
- **R6 死代码/纯冗余**：`Console.jsx:26-28` Placeholder 组件已无板块使用；`Chat.jsx:1215-1226` 两大段完全相同的旧注释块；`Chat.jsx:190,900` bottomRef 只挂 div 未使用；`styles.css:71-72` `.rw-side-model`（侧栏模型区）已迁移为 `.rw-chat-modelbar`，CSS 残留；会话模型恢复逻辑在 `Chat.jsx:311-321` 与 `switchProvider`（240-249）中重复解析。

---

## 其他

- **模型选择链路核实**：`__auto__`/`auto` 是服务端显式支持的哨兵（`server/index.js:403-424`），前端发送 `{provider:'auto', model:'__auto__'}` 语义正确，问题仅在展示层（P3-8）；revertToDefault（`Chat.jsx:261-273`）服务端语义成立。
- **"模型跟会话走"的边界**：选择只在用户手动切换或新建会话（`Chat.jsx:252-258,329`）时写入；发送/恢复不落库，跨会话选择传播见 P3-9——建议在 modelbar 上对"无显式模型"会话显示当前生效路由而非上一会话选择。
- **登出后落点**：登出只清 token 与 user，`path` 状态保留（`App.jsx:58`），从 console 登出再登录会回到 console 而非注释声称的"默认落首页"，可接受但与注释不符。
- **一致性提醒**：Chat 导出延迟 revoke（`Chat.jsx:384`）而 ShellDev 立即 revoke（见 P3-11）；抽屉 caps 温度滑块内联 `flex:1` 幸存而 SettingsBoard 被压窄（P2-5）——同款控件两处表现不同的根因都是样式作用域不统一。
- 本审计为只读推理；对 API 形状的三处关键判断（proposals 对象、toolset 豁免恒开、launch 返回 conversationId+draft、chat 的 auto 语义）已对照 server 源码，其余以代码内自洽性为准。

---

## 统计

| 级别 | 数量 |
| --- | --- |
| P1（崩溃/功能不可用） | 3 |
| P2（状态错乱/易错） | 6 |
| P3（体验/边界） | 23 |
| **总计** | **32** |
