# 审计修复计划（草稿，随审计返回更新）

## 已确认（人工 + API 契约审计）
| # | 级别 | 缺陷 | 修复 |
|---|---|---|---|
| F1 | P1 | api.asks 缺失 → 断连补答横幅失效 | **已修**（src/api.js 补 asks） |
| F2 | P2 | providers/test 失败 note 被 request() 吞（显示"请求失败(200)"） | api.js request 补 data.note 抛错；ModelPlaza 显示 note；400+ok:true 语义歧义→服务端 400 也 ok:false？按 401/403 鉴权失败、400=鉴权过模型名错 调整提示文案 |
| F3 | P2 | ShellDev 默认模型从 listShells 读（无 model_policy）恒空 | 改从 detail.shell 读（getShellByKey SELECT * 已有） |
| F4 | P2 | patchShell persona 裸写 JSON 列 → Invalid JSON text | shellstore patchShell 对 persona JSON.stringify |
| F5 | P2 | market 接入 selModels 跨源串号 | selModels 键改为 `${source}:${id}` 或按 source 提交时过滤归属 |
| F6 | P3 | Dashboard 迷你对话无 approval/ask/plan/tool 处理器 | 补 onApproval/onAsk 至少（提示去对话页或渲染简单卡片） |
| F7 | P3 | abortMap 单槽位双标签打偏 | key 加连接序号或 stop 遍历 abort 该 conv 全部 |
| F8 | P2 | 删会话未清 contract_events | 级联清单补 contract_events（按 contract_id，需子查询先删其 contract 再删 events；直接对 task_contracts conv_id 删 + contract_events 中 contract_id 属已删 contract） |
| F9 | P3 | logout 不调服务端 session 不失效 | App 登出调 api.logout()（best effort） |
| F10 | P3 | SSE stopped 未消费（跨标签停止悬挂） | api.js 加 stopped→onStopped；Chat onStopped 收尾 |
| F11 | 数据 | 历史孤儿 usage51/tool_calls82/messages6 + 残留壳 tmpcode/b1dup | 服务器 SQL 清理（一次性） |
| F12 | 冗余 | api.js 未用 models/logout/upload/reviewsAdd；服务端闲置路由 | logout 用上(F9)；models() 删除或保留供 1.1；upload/reviewsAdd 保留为就绪能力（不算缺陷，记录）；不删服务端路由（可能用于外部/后续） |

## 待 3 路审计返回合并
