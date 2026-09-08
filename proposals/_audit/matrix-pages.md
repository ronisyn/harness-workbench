# 页面 ↔ 数据表 闭环矩阵（2026-09-08 人工核对）

> 逐板块列出：前端入口 → API → 主表 → 写入/读取 → 一致结论。

| 页面/板块 | 前端入口 | API | 主数据表 | 写/读 | 一致性 |
|---|---|---|---|---|---|
| 登录 | Login.jsx | /api/auth/login·me·logout | accounts/sessions | RW | ✅ |
| 总览首页 | Dashboard.jsx | conversations/usage/stats/shells/knowledge/tasks/providers/market | conversations+usage_stats+shells+knowledge+scheduled_tasks+providers+market_snapshot | R | ✅（迷你对话走 /api/chat→messages） |
| 对话页 | Chat.jsx | conversations CRUD/messages/toolcalls/chat/usage/approvals/asks/toolset/settings/autotitle/export/activity/stop/knowledge/shells | conversations+messages+tool_calls+usage_stats+agent_runs+asks/approvals(内存)+knowledge+shells+autotitle | RW | ✅（**发现 api.asks 缺封装已补**） |
| 1.1 模型广场 | ModelPlaza.jsx | providers/models(PUT)/providers/test/market | providers+models+market_snapshot | RW(启停/test 不落库) | ✅ |
| 1.2 模型观测 | ModelObs.jsx | telemetry/daily+reviews | model_telemetry(视图)+reviews | R | ✅（一次通过率未展示=待办） |
| 1.3 壳开发 | ShellDev.jsx | shells CRUD+export+shellTools | shells+shell_tools | RW | ✅ |
| 1.4 Agent 能力 | CapsBoard.jsx | capabilities/toolset/access-rules | capabilities+settings(toolset_enabled/access_rules) | RW | ✅（规则只读） |
| 1.5 Agent 进化 | EvoBoard.jsx | proposals/tasks/audit | proposals 文件+scheduled_tasks+audit_log | RW(proposals 文件) | ✅ |
| 1.6 Agent 广场 | AppsBoard+TemplateBoard | apps(list/get/launch)+templates(list/get/prompt/apply) | apps/模板文件→conversations/shells(装配) | RW | ✅ |
| 1.7 知识库 | KbBoard(Knowledge embedded) | knowledge(list/import/delete) | knowledge | RW | ✅ |
| 1.8 设置 | SettingsBoard.jsx | settings(GET/PUT) | settings | RW | ✅ |

## 数据表完整性（orphan 审计 2026-09-08）
- 无孤儿：model_telemetry 0 / reviews 0 / knowledge 0 / agent_runs 0 / shell_tools 0
- **历史残留孤儿（SQL 直删会话时代遗留）**：usage_stats 51 / tool_calls 82 / messages 6 → 待清理（工具：一次 SQL 删除无主会话的行）
- 残留 disabled 测试壳：tmpcode、b1dup（无引用）→ 待清理

## 级联删除缺口（人工确认）
- 会话删除清 12 表，**缺 contract_events**（task_contracts 子表）→ P2 修复项
