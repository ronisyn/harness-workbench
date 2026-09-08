# 今日修复回归审计

- 审计对象：当前 HEAD `970361c`（= db469f5 R1/R2/R5 shared 重构 + 文档回填；其后无代码改动）
- 方式：只读代码核查（read/grep/glob + 少量 git 历史比对），未运行测试/build
- commit 链核对基线：014454a → 925efc9 → 014609c → 67e7a6a → b856edb → db469f5 → 970361c

## 修复点核对表（#项/位置/结论）

| # | 核对点 | 现在代码位置 | 结论 |
|---|---|---|---|
| 1 | App.jsx `go()` 用 `location.pathname`；convParam 初始读 search | `src/App.jsx:35-40`（go 内 pushState 后 `setPath(location.pathname)` 剥 query）；`src/App.jsx:51`（popstate 重读）；`src/App.jsx:66`（`Chat key={convParam}` + initialConvId）；`src/App.jsx:43-47`（enterChat 草稿 rw_draft_） | 存在✓ |
| 2 | api.js `asks()` 返回 `{pending}`；request() 抛错带 note | `src/api.js:62`（`asks: () => request('/api/asks')`）；`src/api.js:16-18`（err.message/err.note 并入 note）；服务端 `server/index.js:923-925`（`{ok:true,pending:listPendingAsks()}`）；providers/test note 透传 `server/index.js:335-346`，前端消费 `src/console/ModelPlaza.jsx:37-38` | 存在✓ |
| 3 | 会话删除级联含 contract_events 预删、无 bg_tasks；迁移 catch 记日志；启动关键列自检 | `server/index.js:218-227`（归属预校验→L221 contract_events 预删→L222 子表清单循环，无 bg_tasks；全库 grep bg_tasks=0）；`server/db.js:385-392`（迁移 catch 仅静默 duplicate，其余记日志）；`server/db.js:425-437`（信息_schema 关键列自检，缺失醒目告警） | 存在✓（自检清单未含 pack_extra，见新发现 D） |
| 4 | patchShell persona JSON 化；index patch 路由 | `server/shellstore.js:82`（`JSON.stringify(persona===null?null:String(persona))`）；`server/index.js:1267-1268`（PATCH → patchShell）；`src/console/ShellDev.jsx:133-134`（persona 原文编辑→服务端序列化）；modelPolicy 归一 `shellstore.js:83-87` | 存在✓（modelPolicy 覆盖语义见新发现 C） |
| 5 | 队列项 convId/uid、flush 只发本会话、删会话清队；横幅 dismissedAt 30s | `src/Chat.jsx:578`（`{convId,text,uid}`）；`:589-599`（flushQueue 只消费 curRef 所属首条）；`:377-378`（delConv 滤队）；`:404-407`（key 相同且 dismissedAt≤30s 不重弹）；`:818`（暂不处理置 dismissedAt） | 存在✓ |
| 6 | failPick 0 保持 0；consecutive_fail_guard=0 → agentLimits 返 0 | `server/agent.js:164-168`（failPick：行存在时 `n>=0` 原样返 0）；`:157`；`:595`（`lim.failGuardN > 0` 才计数）；`server/settingsSchema.js:20`（runtime 组 def 3、0=关） | 存在✓ |
| 7 | F19/chat：壳 modelPolicy 第三级路由 + shellDefault 事件/审计；budgetYuan→__shellBudgetYuan→effBudgetYuan min | `server/index.js:465-477`（读壳 model_policy、budgetYuan>0 才记）；`:486-499`（B3 档案第二级）；`:500-509`（第三级壳默认）；`:703-708`（route 灰字+audit shell-default）；`:769`（agentCtx.__shellBudgetYuan）；`server/agent.js:353-359`（min(全局段阈值,壳上限,24h 剩余)）、`:412-414`（阈值触发） | 接线存在✓，但 Web 主发送路径实际不触发（见新发现 A） |
| 8 | pack_extra 列（CREATE+ALTER）、importShell 列、packToRow/rowToPack merge | `server/db.js:302`（CREATE 含 pack_extra）；`:383`（ALTER）；`server/shellstore.js:22/32`（UPDATE/INSERT 含 pack_extra）；`server/shells.js:76-77`（ui_brand+pack_extra 写）；`:162-165`（rowToPack 补 uiBrand+mergePackExtra）；`:86-107` extractPackExtra、`:110-126` mergePackExtra（tone/terms/mcps/connectors/importRefs/defaultsAutoLoad/approvalMode/sensitiveDefaults/bindings/credentials/shellPackVersion） | 存在✓ |
| 9 | sysline route 支持无 profile；revertToDefault 置 auto | `src/Chat.jsx:883-896`（route 显示条件 `profile \|\| suggestProvider`，echo 覆盖壳默认文案）；`:283-295`（patch null + setProvider('auto')/model('__auto__') + 清 route 灰字） | 存在✓（“退回默认后回落壳默认”语义被新发现 A 打破） |
| 10 | P3 各前端点 | Chat 空态 `:829-830`；切会话先清 msgs/toolcalls/stats/live `:328`；草稿 sessionStorage 前缀 rw_cdraft_ `:156-178`（卸载落盘 `:178`、删除清 `:375`）；auto 下拉 option `:803-808`；Ctrl+Enter 内联过滤 `:434-437`；导出文件名净化 `:424`；Chat 卸载 abort `:225`；Dashboard 用量失败态+重试 `src/Dashboard.jsx:164-166`、迷你 autoTitle `:92-96`、无文本文案 `:132`；Knowledge loaded 态 `src/Knowledge.jsx:23/134-135`、fileRef 清框 `:26/68`、R4 useKnowledgeState+KbBody 唯一体 `:12/85`（KbBoard embedded `src/console/KbBoard.jsx:6`）；P3-19 双类提权 `src/styles.css:353-354`；P3-17 dim 三态 `styles.css:218-231`+`ModelPlaza.jsx:69/90`；P3-18 待审样式 `styles.css:240`；P3-10 console 未知板块回退 `src/console/Console.jsx:32` | 存在✓（全部在位） |
| 11 | shared/ 五组件 + 双端引用；Chat 无重复 state/handler | `src/shared/`：SettingsPanel/CapSwitches/ToolsetEditor/RulesEditor/ProposalsManager；Chat 引用 `src/Chat.jsx:8-12`（抽屉 `:962-1034`）；console 引用：CapsBoard `src/console/CapsBoard.jsx:11-13`（1.4）、EvoBoard `src/console/EvoBoard.jsx:46`（1.5）、SettingsBoard `src/console/SettingsBoard.jsx:8`（1.8）；Chat 内 setCapabilities/saveRules/setToolset/capState 等重复实现 grep=0 残留 | 存在✓ |
| 12 | 交叉冲突：asks 仍在；openDrawer 后 mcp/providers/market/tasks 可达；SettingsPanel bump 语义 | asks 被 `src/Chat.jsx:401` fetchPending 使用、服务端 `server/index.js:923-925` 在 db469f5 后未删；openDrawer 逐 tab 独立加载 `src/Chat.jsx:659-673`（caps/tools/rules/proposals 由共享组件自载，`mcp/providers/market/trace/tasks` 仍在此预载）未误删；SettingsPanel 保存 → PUT /api/settings（`server/index.js:995-1006`）GUARD_KEYS=runtime 组 bump（`setSetting` `:403-405`），组件文案 `src/shared/SettingsPanel.jsx:76` 与之一致 | 存在✓（均可达/语义未破坏） |

**核心结论**：12 项清单中的修复点在 HEAD 上全部仍存在、无被后续提交直接删除/反向覆盖；逐点位引用见上表。交叉扫描发现 1 个中危语义矛盾（A）与若干低危项，详见下。

## 新发现缺陷

- **A【中危·跨批冲突】Chat 发送路径携带 `provider:'auto'`，使 F1 壳默认/任务档案路由对 Web 主对话永不生效**。
  `src/Chat.jsx:494` `streamChat({... provider, model})` 原样发送 provider 状态；而三条“无显式/回落”路径（openConv 无显式会话 `:350-351`、revertToDefault `:288-291`、switchProvider('auto') `:263`）都把 UI 状态设为 `'auto'`。服务端 `server/index.js:454` `wantProvider = provider||convProvider` 得到真值 `'auto'`，`:486`/`:501` 两级“无显式才路由”条件 `!wantProvider` 均被跳过 → 永不进第三级壳 modelPolicy、也不发 `route:shell-default` 灰字/审计，直接落 `resolveRoute('auto')` 全局默认（`server/index.js:413-422` 亦把 auto 当“自动路由”而非“未选择”）。
  后果：挂壳且壳配了 modelPolicy/taskProfiles 的会话，从对话页发消息永远按全局默认跑（F1 只对 body 不带 provider 的请求生效，例如 Dashboard 迷你对话 `provider:undefined` `src/Dashboard.jsx:88`）；且 sysline“🧩 壳默认模型”灰字在对话页主路径不会出现；revertToDefault 承诺的“回落壳默认”不兑现。属 014609c(F1) 与 67e7a6a(P3-9/C4 auto 展示语义) 之间的接线矛盾。修复方向：Chat 在 provider==='auto' 时发送 `undefined`（或服务端把 body `'auto'` 视同未显式继续走 2/3 级）。

- **B【低危·竞态】Chat mount 厂商首载覆盖会话显式/auto 状态**。`src/Chat.jsx:226-240` 的 providers() 效果无条件 `setProvider(active[0].provider_key)` 等，未判当前是否已开会话；`/chat?conv=N` 直达 auto（无显式）会话时若 /api/providers 晚于 openConv 返回，会把“自动路由”显示覆盖为第一家厂商默认并影响下一轮发送（显式化），与 P3-9 防传染意图相抵（窄时间窗，需网络序触发）。

- **C【中低·存量放大】patchShell 的 modelPolicy 归一化整体覆盖，UI 保存默认模型会静默抹掉壳预算帽/白名单**。`server/shellstore.js:83-87` 把 model_policy 重建为仅含 defaultProvider/defaultModel/空 allowModels/budgetYuan=0/qualityCostBias=null；`src/console/ShellDev.jsx:90` 只传 defaultProvider/defaultModel → 已配 `budgetYuan`（F1 后具备运行语义：`server/agent.js:353-359` 收紧段预算）或 `allowModels` 的壳，在 1.3 面板点一次“保存默认模型”即被清零。归一逻辑自 79b6bae 已有（先于今日链），F1 赋予 budgetYuan 实际语义后风险放大。应改为读旧值合并（缺省字段保留原值）。

- **D【低危】启动自检关键列清单未含 `shells.pack_extra`**。`server/db.js:428-431` 检查列列表停在 intent_rules/task_profiles/knowledge.shell_id；pack_extra 为 F2(014609c) 后增列，若某库迁移被跳过：import 时 UPDATE/INSERT 显式引用该列直接报错（响亮），export/clone 则**静默丢扩展字段**（rowToPack 读到 undefined 跳过），建议补入自检清单。

- **E【低危·存量】PATCH /api/conversations/:id 越权静默成功**。`server/index.js:190-208` 用 `WHERE id=? AND account_id=?` 但未查 affectedRows，非本人会话返回 `{ok:true}`（0 行），与同文件 DELETE/messages 的 404 口径不一致（无安全风险，仅口径问题）。

- **F【低危·存量边界】删除正在流式执行的会话未中止本地/远端流**。`src/Chat.jsx:370-381` delConv 未 `abortRef.current.abort()`；若删除 busy 的当前会话，SSE 继续跑完、服务端仍会写 assistant 消息/usage（孤儿行）并继续烧 token。队列清理（P2-1）已覆盖排队项，但流未断。

## 统计

- 核对项：12 项清单逐子点核对，**全部存在✓（40/40 子点，含 2 处“存在但附带观察”标注：#3 自检清单、#9 语义见 A）**；未发现清单内修复点被后续提交删除/反向覆盖。
- 新发现：1 中危（A，F1×P3-9 接线矛盾）+ 1 中低（C，modelPolicy 覆盖）+ 4 低危（B/D/E/F），其中 A、C 建议在下一批修复中优先处理（A 可加单测：POST /api/chat 带 `provider:'auto'` 时 shell modelPolicy 是否生效）。
- 本审计只读完成，未改动任何代码文件。
