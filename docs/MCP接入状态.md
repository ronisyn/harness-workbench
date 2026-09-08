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

配置面板：🎛 后台 → 系统 → 1.8 设置 → MCP 管理（JSON 编辑 + 保存并连接）；或 API `POST /api/mcp/reload`。
自愈：进程启动时自动连接已配置 server；运行中任一 client 意外退出后，**看门狗 60s 内自动重连并同步工具**（`a31d715`），无需人工干预。

## 密钥脱敏（安全）

MCP server 的 env 中含密钥的键（键名匹配 `token|secret|key|password|passwd|apikey`）**永不下发前端**：
- `GET /api/settings` 与 `GET /api/mcp` 响应中统一显示为 `__REDACTED__` 占位符（明文仅存服务器 settings 表）；
- 前端保存时若该键仍为占位符 → 服务端保留 DB 原值不覆盖；填入新值才替换；
- 已实测：占位回存 + reload 后 `mcp_github_list_commits` 仍返回真实提交（token 有效，commit `68968c5` 修复 / `6b7219c` UI 提示）。

## 版本注

框架：蓝图 v2.5.5 批5（P11；现行总纲=蓝图 v2.9）。配置面板与修复提交：`060f9dc`（UI）、`1d48502`（工具名去重）、`dfe503b`（schema 注册修复）、`8940f91`（名解析修复）、`68968c5`（密钥脱敏）、`6b7219c`（占位提示）、`a31d715`（重连看门狗）。
