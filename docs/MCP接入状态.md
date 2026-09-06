# MCP 接入状态（2026-09-06 · 已配置完成）

> 本文记录 RW(880) 当前 MCP 接入状态，供追溯；配置由维护者/用户完成，模型侧只使用。

## 当前已接入

| serverId | 类型 | 命令 | 工具数 | 状态 |
|---|---|---|---|---|
| `github` | GitHub MCP server | `npx -y @modelcontextprotocol/server-github` | 26 | ✅ 已连接可用 |

配置存储：服务器 settings 表 `mcp_servers`（token 仅存服务器，前端不显示明文）。

## 模型侧使用

工具以 `mcp_github_<tool>` 命名暴露，受平台统一权限/纪律层约束。已实测：
- `mcp_github_list_commits` → 成功返回 ronisyn/harness-workbench 真实提交（与远程一致）

## 常用 GitHub 工具（26 个中的代表）

`create_or_update_file` / `search_repositories` / `create_repository` / `get_file_contents` / `push_files` / `create_issue` / `create_pull_request` / `fork_repository` / `create_branch` / `list_commits` / `list_issues` / `update_issue` …

## 重连

配置面板：设置 → MCP（JSON 编辑 + 保存并连接）；或 API `POST /api/mcp/reload`。
服务器重启后若连接丢失，执行一次 reload 即恢复（启动时异步连接亦会自动尝试）。

## 版本注

框架：蓝图 v2.5.5 批5（P11）。配置面板与修复提交：`060f9dc`（UI）、`1d48502`（工具名去重）、`dfe503b`（schema 注册修复）、`8940f91`（名解析修复）。
