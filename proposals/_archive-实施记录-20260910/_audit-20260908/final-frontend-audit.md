# 前端最终态审计（R1/R2/R5 后）

审计对象：E:\projects\harness-workbench 工作区**当前文件最终态**（read/grep/glob 只读核查，未改任何文件）。
基线 commit db469f5；工作区另有 **2 个未提交 src 改动**（见 §4 附注，属修复性 delta：`M src/Chat.jsx`、`M src/shared/CapSwitches.jsx`，且 web/dist 已重建为 index-D3PBGINt.js，说明 build 已通过）。服务端契约均已对照 server/index.js / settingsSchema.js / tools/index.js 核实。

## 缺陷（P1/P2/P3，每项 文件:行+问题+建议）

- **P2-1 `src/shared/ProposalsManager.jsx:21-25`**：`create()` 丢失旧对话页"`# 提案：`+title 前缀 + 状态行"语义。旧 Chat `submitProposal` 组装 `'# 提案：'+title+'\n\n> 状态：🆕 待审\n\n'+draft` 后 POST；现只 POST 裸 `propDraft`。服务端列表解析（server/index.js:1038-1039）取**首个 `# ` 行**做标题、`状态：…` 做状态：裸正文若无 H1 → 列表标题回退为文件名（如 `20260909-xxx.md` 带日期/扩展名），且文件缺少约定首部（提案 md 还供 agent 工具/模板体系消费）。建议 create 内组装 `'# 提案：' + propTitle + '\n\n> 状态：待审\n\n' + propDraft` 再 POST（注意状态行不要 `🆕 ` 前缀——状态正则 `[^·\n]+` 会把 `🆕 待审` 整个捕获，导致列表 class 判定 `!== '待审'` 走错配色），抽屉与 1.5 同源同修。
- **P3-1 五共享组件 err 残留**：`CapSwitches.jsx:9,19` / `ToolsetEditor.jsx:8,21` / `RulesEditor.jsx:10,26` / `ProposalsManager.jsx:11,24` / `SettingsPanel.jsx:17,26` —— 操作失败置 `err` 后，后续**成功的**保存/开关/加载不清空 `err`，红条滞留误导（如先保存失败、再改对后红条仍在）。建议成功路径 `setErr('')`（或 err 带 ts 自动过期）。
- **P3-2 console 侧成功反馈全静默**：`CapsBoard.jsx:11-13`、`EvoBoard.jsx:46`、`SettingsBoard.jsx:8` 均不传 `onToast`；`ToolsetEditor.jsx:21`/`RulesEditor.jsx:25`/`ProposalsManager.jsx:23` 的"成功"提示只走 `onToast` 分支 → console 保存工具集/规则/提案成功无任何可见反馈（旧 1.5 有 msg 横幅"提案已创建"、旧 Chat 工具有"已启用 x（下轮生效）"）。建议共享组件成功也回写本地 msg，或 console 注入轻量 toast。
- **P3-3 `src/Chat.jsx:306-309` loadMessages 历史轨迹未走 safeJson**：R5 只在抽屉路径（Chat.jsx:1055）对 DB `args` 字符串做 `safeJson`；消息流内历史（DB 行 → TraceCard）`args` 仍是 JSON 字符串 → `humanTarget`(Chat.jsx:1120-1121 要求 object)/📂打开/摘要预览失效（流式轮对象 args 正常）。pre-db469f5 已存在，R5 只修了一半。建议 loadMessages 映射与抽屉同款：`args: safeJson(t.args) ?? {}`。
- **P3-4 `src/Chat.jsx:962-965` caps tab 未给 CapSwitches 传 `onToast`**：开关失败提示从旧全局 toast 变为组件内顶部红条（tab 内若已下滑，红条在视口外不易察觉）。建议 `onToast={setToast}`。
- **P3-5 `src/console/CapsBoard.jsx:10-13` 1.4 视觉/信息密度回归**：旧实现能力开关为 `rw-console-toolbar`+`rw-market-m` 横排 chip（B 组 29 项一屏多列），现共享 `rw-cap-item` 全宽纵向 flex 行（styles.css:201）逐行堆叠 → 能力开关约 60 余行把工具/规则挤到很下方，宽容器下观感差。建议 CapSwitches 加布局开关（console 用 grid/两列、抽屉保持现状）或复用 `rw-toolgrid` 密度。
- **P3-6 `src/shared/CapSwitches.jsx:8,27` `groupNames` 传参已无人使用**：工作区 delta 后 Chat 不再传（Chat.jsx:964），两处均走 `DEF_GROUP_NAMES`（CapSwitches.jsx:6）。属可选冗余 API（保留无碍，删则需同步删 Chat 无引用处——已删干净）。
- **P3-7 `src/console/EvoBoard.jsx:9,13-17,26` err 死路径**：`load` 内两请求各自 `.catch` 兜底 → `Promise.all` 永不 reject → `catch(e){setErr}` 不可达，`err`/红条为死代码（pre-db469f5 同构遗留）。
- **P3-8 `src/console/SettingsBoard.jsx:8-9` 提示语义重复**：SettingsPanel 全尺寸模式自带"护栏键保存即 bump policy_rev…"（SettingsPanel.jsx:76），SettingsBoard 又加"见对应板块"note，两行相邻信息混叠。建议合并或删除其一。
- **P3-9 `src/Chat.jsx:962` 抽屉 caps 外层 `div.rw-cap-group` 与 SettingsPanel 根节点（SettingsPanel.jsx:43）同为 `rw-cap-group` 嵌套**：`margin-bottom:18px`(styles.css:199) 双份、结构冗余；纯样式级，低优先。

## 残留死代码/重复实现

- 已删 state/handler（caps/toolList/rules/proposals/prop*/temperature/sysPrompt/lim*/settingsSchema/sval、toggleCap/toggleTool/saveRules/viewProposal/submitProposal/setTemp/saveSysPrompt/saveLim/debounced/saveTimer/ruleText 等）在 **Chat.jsx 零残留引用**（全量 grep 确认仅 shared/ 与 api.js 内同名新实现）；Chat 8 个 import 全部被使用。
- 5 个 shared 组件仅被 Chat.jsx:8-12 与 CapsBoard/SettingsBoard/EvoBoard 引用，全 src 无第二份本地实现（grep `api.capabilities|getToolset|getRules|createProposal|rw-toolgrid` 级联确认）。
- CapsBoard(16 行)/SettingsBoard(12 行)/EvoBoard(63 行) 旧本地 UI 已清（diff 级核对），仅剩 EvoBoard err 死路径（P3-7）。
- 死 CSS：`styles.css:207-209` `.rw-limrow`（旧四护栏内联行，已无 JSX 使用）；`styles.css:287-288` `.rw-diff-details`（R5 后抽屉 diff 改走 TraceCard `rw-diff`/`DiffBlock`，Chat.jsx:48-61,115-117）；`styles.css:242` `.rw-trace-args`（旧抽屉明文参数行，现 TraceCard 用 `rw-trace-line`；同规则 `.rw-trace-res` 仍被 ProposalsManager:33 使用，勿删整行）。
- TraceCard 内 `FILE_TOOLS/oneLine/isDiffLike/DiffBlock/safeJson` 现两路径共用，无重复。

## 行为差异点

1. **提案标题/首部语义丢失**（见 P2-1）——对话页新建提案文件缺 `# 提案：` 行，列表标题回退文件名；console 旧实现本就有此缺陷，统一组件继承了较差语义。
2. **caps 组名**：delta 后统一用共享 `DEF_GROUP_NAMES`（渲染能力/工具能力/平台能力）——抽屉与旧 Chat 显示一致；console 由旧"无分组名"变为中文组名（更好）；`groupNames` 契约保留但无调用方（P3-6）。
3. **工具 tab**：`rw-toolgrid`+`em.rw-tool-tier`+disabled 豁免项 title 全部保留（ToolsetEditor.jsx:28-36 = 旧抽屉 markup）；差异仅旧 Chat 每勾选成功有 toast → 现无（P3-2）。
4. **规则 tab**：Chat 路径 `onToast=setToast` 成功 toast "规则已保存（下轮生效）"保留（RulesEditor.jsx:25）；console 路径成功静默（P3-2）。
5. **caps 开关失败反馈位置**：Chat 由全局 toast → 组件内红条（P3-4）；回滚逻辑两处均保留。
6. **高级参数区**：运行护栏由旧 Chat 4 项硬编码 → schema 全量（新增 fake_continue_warn/consecutive_fail_guard/max_concurrent_chats 可见，更完整）；温度/系统提示词保存时机由"击键 debounce"→"失焦/松开"（blur 前关抽屉有丢失窗口，极小概率，可接受）；滑块 0.05 步进 vs 旧 0.1，无实质影响。compact 参数（SettingsPanel.jsx:76）仅控制一条 bump 说明注记显隐，语义偏弱但两处用途合理（抽屉藏、console 显）。
7. **提案查看**：旧抽屉全文显示 → 现 `.slice(0,12000)`；旧 console 4000 → 统一 12000。查看旧内容后新建提案不清空 `content`（旧抽屉会清），展开区滞留旧提案（P3 级 UX，可并入 P2-1 修复）。
8. **R5 轨迹 tab**：DB 行单卡折叠式 TraceCard（中文名/摘要/diff/📂打开均生效，比旧明文行信息密度更好）；状态由文字徽章变图标（fail ✕/running ●/done ✓），`status||'done'` 对非三态值兜底为 ✓；时长 `duration_ms||0`。
9. **抽屉打开策略**：openDrawer（Chat.jsx:658-672）不再预载 caps/settings/tools/rules/proposals，仅 providers/market/trace/tasks/mcp——共享面板挂载即自载；单点失败不再拖垮整抽屉（P3-4 语义更稳）。

## 统计

- 核查文件：Chat.jsx（1173 行）+ shared×5 + console×3 + api.js + styles.css + server 契约 4 处 = 全量覆盖核查点 A-F。
- 缺陷：**P1 = 0**（无编译错误、无崩溃/数据损坏；build 产物已重建），**P2 = 1**（提案 `# 提案：` 前缀语义丢失），**P3 = 9**。
- 残留死代码/重复实现：Chat 内 0；死 CSS 3 处（rw-limrow / rw-diff-details / rw-trace-args）；EvoBoard err 死路径 1；共享实现无重复。
- 附注（需提交）：`M src/Chat.jsx`、`M src/shared/CapSwitches.jsx`（GROUP_NAME 下沉 DEF_GROUP_NAMES + 去传参，修复 console 组名缺失）尚未 commit；对应 web/dist 新产物 index-D3PBGINt.js 为未跟踪文件，提交时需一并纳入。
