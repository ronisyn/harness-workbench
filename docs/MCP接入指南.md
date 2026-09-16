# MCP 外部工具接入指南（P11 · 2026-09-06）

> 🔀 接缝状态注（2026-09-10 治理）：本文档=现网 MCP 配置**操作细则**（入口当前=后台→**应用→扩展中心→MCP 外部服务接入**）。按《RW-Agent 平台化改造总方案》(B) 定版，MCP 归 **扩展中心**（§8.8）、设置页只留运行时参数（§8.10）——入口已于 2026-09-11 A8 批（`39a3d8486`）自设置页迁至扩展中心，本文同步；凭证按 B §9 铁律（不进 DB 明文、只存引用，运行时密钥库随连接器机制）届时改写本文"env 密钥"节——现网 token 明文存 settings 为 B 已知待治理现状，**GitHub PAT 轮换待办见 B §11.4**。机制权威=B §8.8/§9；本文档为操作细则。

RW 支持连接外部 MCP（Model Context Protocol）server，把外部工具（GitHub/浏览器/数据库等）接入后供模型调用。

## 配置入口（可视化）

**🎛 后台 → 应用 → 扩展中心 → MCP 外部服务接入**（对话页⚙设置抽屉已于 2026-09-09 退役；MCP 管理于 2026-09-11 A8 批自「设置页」迁至「扩展中心」，后台为唯一设置中心）：
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
- 断开：把数组里该 server 删掉 →「保存并连接」即断开（声明面是唯一出处：不在声明里的源一律撤掉——MCP server 与连接器同一条纪律）

## 管理 API

- `GET /api/mcp` —— 查看已配置与连接状态
- `POST /api/mcp/reload` —— **按声明重连**（2026-09-17 起同时管两份声明：`settings.mcp_servers` + `settings.connectors`）
  - 鉴权：沿用该端点原有 `requireAuth`（**没有新增权限面**，也没有放宽）。
  - 行为：重新读声明 → 撤掉不在声明里的源 → 装载新增/变更的源；**同一进程内生效，不重启**。
    不在声明里的 `connector:*` 源一律撤掉；`kind=mcp` 的连接器不在声明里就不重连，其 `mcp_<id>_*` 工具随之从工具面消失。
  - 失败如实报、不留半态：`settings.connectors` 声明非法时，**连接器那半边冻结**（上一代工具面保持、一个源都不撤），
    错误原文在 `connectorError`、说明在 `notes`；`mcp_servers` 那半边照常生效。
  - 响应字段：`ok` · `results`（mcp_servers 逐条）· `registeredTools` · `connectors`（连接器逐条，冻结时为 `null`）·
    `connectorError` · `disconnected` · `sources`（当前动态来源 id）· `failures` · `notes`。
    前三个是老字段，**逐字保留**（`src/console/McpManager.jsx` 在用）；其余为本次新增，只增不改。
  - 唯一实现是 `server/connectors.js` 的 `reloadDeclaredSources()`（端点是薄壳，只做鉴权与转呈）；
    验收见 `test/connectors-reload.test.mjs`（加/改/删 + 不在声明里即撤 + 非法声明冻结 + 鉴权不变）。

### 连接器声明（`settings.connectors`）改完怎么生效

连接器＝带凭证的执行后端（v0.3 §4.2），两条路：`kind:"mcp"`（复用同一客户端池与同一注册路径）与
`kind:"http"`（`baseUrl` + 凭据引用 + 允许的动作，动作注册成 `conn_<id>_<动作>`）。声明形状与校验的唯一出处是
`server/connectors.js` 的 `validateConnectors`（非法当场报，报错指到具体条目）。

**改完调一次 `POST /api/mcp/reload` 即生效，不需要重启**：HTTP 路整源替换（动作增删改即时可见），
MCP 路先断开再按新声明连（同 id 换了 `command`/`args` 也会生效）。

## 模型侧用法

连接成功后，模型在任务中直接调用 `mcp_<serverId>_<toolName>`（如 GitHub server 的 `mcp_github_get_issue`），与普通工具同样受纪律层约束；工具描述来自 server 的 tools/list。

> 版本注：框架落地于蓝图 v2.5.5 批5（P11）；UI 配置面板为 2026-09-06 补充。
