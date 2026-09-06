# MCP 外部工具接入指南（P11 · 2026-09-06）

RW 支持连接外部 MCP（Model Context Protocol）server，把外部工具（GitHub/浏览器/数据库等）接入后供模型调用。

## 配置入口（可视化）

**设置 → MCP**（页面右上 ⚙ 设置 → MCP tab）：
1. 在 JSON 编辑框写入 server 配置数组
2. 点「保存并连接」——配置存服务器 settings（`mcp_servers`），并自动重连
3. 下方显示连接状态与注册的工具数

> 旧版入口（无 MCP tab 前）：通过任意 settings API 写 `mcp_servers` 键。当前版本直接用设置面板即可。

## 配置格式

```json
[
  {
    "id": "github",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "你的 GitHub token" }
  }
]
```

- `id`：唯一标识（字母数字下划线连字符）；其工具以 `mcp_github_<tool>` 名暴露给模型
- `command` + `args`：启动 MCP server 的命令（服务器上可执行，npx/docker/node 均可）
- `env`：传给 server 的环境变量（token 等；只存服务器 settings，不进前端 localStorage）

## 首批推荐 server

| server | 配置要点 |
|---|---|
| GitHub（官方） | `npx -y @modelcontextprotocol/server-github`，env 需 `GITHUB_PERSONAL_ACCESS_TOKEN` |
| Playwright（浏览器自动化） | `npx -y @playwright/mcp@latest`（需服务器可跑浏览器） |
| 任意自建 stdio MCP | 遵循 MCP 协议（stdio JSON-RPC：initialize → tools/list → tools/call）即可接入 |

## 安全说明

- MCP server 由**管理员配置**（settings），模型不能自行添加
- MCP 工具走平台统一权限/纪律层（preset/启用集/审批/Access 规则仍生效）
- token 只存服务器 settings 表，前端仅显示配置形态不暴露 token 明文
- 断开：把数组里该 server 删掉 →「保存并连接」即断开

## 管理 API

- `GET /api/mcp` —— 查看已配置与连接状态
- `POST /api/mcp/reload` —— 按配置重连全部

## 模型侧用法

连接成功后，模型在任务中直接调用 `mcp_<serverId>_<toolName>`（如 GitHub server 的 `mcp_github_get_issue`），与普通工具同样受纪律层约束；工具描述来自 server 的 tools/list。

> 版本注：框架落地于蓝图 v2.5.5 批5（P11）；UI 配置面板为 2026-09-06 补充。
