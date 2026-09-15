# MCP：被第三方 agent 调用 —— 实测（2026-09-16）

> **本文件只增**，记录 v0.3 §0.4 **M2 出口**里那条至今没做的判据 ——「**被别的 agent 当 MCP 工具调用成功一次**」——的落地证据。
> 本轮**只加用户级配置 + 本文档 + `tmp/` 下的临时脚本**；没动 `server/**`、`scripts/**`、`test/**`；没有 commit / push / 部署；**没有调用任何真模型**（怎么做到的见 §2.4 / §3.4）。

被测对象：`scripts/rw-mcp-server.mjs`（stdio JSON-RPC，协议实现 `server/mcp-server.js`），对外 3 个工具：`rw_chat` / `rw_status` / `rw_export`。

## TL;DR

| agent | 接入方式 | 真调过我们的只读工具？ | 结论 |
|---|---|---|---|
| **DSH**（DeepSeek Harness 0.1.5-rc.2，即本机跑我的那个 harness） | 用户级 `~/.dsh/cordis.patch.yml` | ✅ `tools/call rw_status` → 返回真实平台数据 | **成功** |
| **Codex CLI** 0.153.4 | 用户级 `~/.codex/config.toml` | ✅ `mcp: rw/rw_status (completed)` | **成功** |
| **Pi**（earendil-works/pi） | 未装、未接 | ❌ | **未做**，见 §4（本体开源但**明确不做 MCP**，要接得写扩展，且跑起来要模型账号） |
| **Claude Code** | — | ❌ | **本轮不接**，见 §5 |

---

## 0. 环境事实（本轮实测确认）

| 事实 | 值 / 出处 |
|---|---|
| DSH 版本与安装位置 | `@deepseek-ai/dsh` **0.1.5-rc.2**，`C:\Users\颜文\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（**本轮未改动其中任何文件**） |
| DSH 的 MCP **客户端**插件 | `@deepseek-ai/dsh-mcp-client@0.1.5-rc.2`（`…\.dsh\profiles\node_modules\@deepseek-ai\dsh-mcp-client`）——工具名形如 `mcp__<serverName>__<tool>` |
| DSH 的用户级配置面 | `~/.dsh/cordis.patch.yml`（文件第 1-2 行自述："machine-local user patch layer (applies to every profile)"），另加 `~/.dsh/settings.yaml`、`~/.dsh/profiles/<名称>/` |
| DSH 的 `mcp-client` 配置 schema | `…\dsh-mcp-client\lib\index.js:743-761`（`transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError/reconnect`）；字段表见该包 `README.md:55-66` |
| DSH 的非交互入口 | `dsh --profile headless "<任务>"`（"Answer one task … and exit"，`dsh --profile headless --help`）；**没有**"只列 MCP 工具"的子命令 |
| Codex 版本与入口 | `codex-cli 0.153.4`，`codex`（`C:\Users\颜文\AppData\Roaming\npm\codex.ps1`） |
| Codex 的 MCP 配置面 | `~/.codex/config.toml` 的 `[mcp_servers.<name>]`；官方命令 `codex mcp add/get/list/remove` |
| Codex 的 wire 协议 | 0.153 起 `wire_api = "chat"` **被移除**，只剩 `"responses"`（实测报错原文见 §3.4） |
| 平台本身 | **本轮没有启动**（`127.0.0.1:880` 当时无监听）；原因与替代方案见 §7.1 |

---

## 1. 基线：我们自己把 MCP server 跑一遍（不调模型）

临时脚本 `tmp/mcp-probe.mjs`：起子进程 → 按 stdio 发 `initialize` → `notifications/initialized` → `tools/list` → `tools/call`，把每一帧原样打印。

```powershell
# (a) 平台没起、也没有账号时
node tmp/mcp-probe.mjs rw_status '{"conversation_id":"1"}'

# (b) 有只读后端与账号时（见 §7.1 的桩）
$env:RW_MCP_USER='x'; $env:RW_MCP_PASS='y'
node tmp/mcp-probe.mjs rw_status '{"conversation_id":"625","limit":2}'
```

**原始输出 (a)**（`[server stderr]` 那行是 server 自己打的就绪日志）：

```
[server stderr] [mcp-server] rw-platform MCP server 已就绪（stdio，base=http://127.0.0.1:880，新建会话权限=read）
--- RAW stdio responses (one JSON object per line) ---
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"rw-platform","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"rw_chat","description":"在 Roni Workbench 平台上跑一轮对话（平台侧 Agent 会真的用工具干活）。给 conversation_id 就是追问同一个会话；不给则新建一个会话。","inputSchema":{"type":"object","properties":{"message":{"type":"string","description":"要对平台说的话（任务/问题）"},"conversation_id":{"type":"string","description":"可选：继续某个已有会话；不传=新建"},"wait_seconds":{"type":"number","description":"最多等多久（秒）。超时不算失败：会返回 status=running 与 conversation_id，之后用 rw_status 查或再 rw_chat 追问"}},"required":["message"],"additionalProperties":false}},{"name":"rw_status","description":"查一个会话最近的状态与最后一条回复（长任务用它在 rw_chat 超时后轮询）。","inputSchema":{"type":"object","properties":{"conversation_id":{"type":"string","description":"会话 id"},"limit":{"type":"number","description":"返回最近几条消息（默认 5）"}},"required":["conversation_id"],"additionalProperties":false}},{"name":"rw_export","description":"导出一个会话（带格式版本的自描述包，可被 POST /api/conversations/import 导回）。","inputSchema":{"type":"object","properties":{"conversation_id":{"type":"string","description":"会话 id"}},"required":["conversation_id"],"additionalProperties":false}}]}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"工具执行失败：缺账号：设 RW_MCP_USER/RW_MCP_PASS（或 RW_ADMIN_USER/RW_ADMIN_PASS），或在运行账户家目录放 .rw-keys.env"}],"isError":true}}
```

**原始输出 (b)**（第 3 帧是成功的 `tools/call`，`id:3`；这里只截了正文头部，完整帧见 `tmp/mcp-traffic.log` 的 `S→C` 行）：

```
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\n  \"conversation_id\": \"625\",\n  \"count\": 22,\n  \"messages\": [\n    {\n      \"id\": \"1616\",\n      \"role\": \"user\",\n      \"content\": \"【定时任务】RA35样本-真实调度路径（手动跑一次）…\",\n      \"created_at\": \"2026-09-15T10:58:10.000Z\"\n    },\n …(略)…  ]\n}"}]}}
```

**结论**：握手、能力协商、`tools/list` 全对；`tools/call` 的成功与失败都按 MCP 口径走（失败走结果里的 `isError`，不走 JSON-RPC error）。**server 是好的**，缺的只是"平台在跑 + 有账号"。

---

## 2. DSH（DeepSeek Harness）

### 2.1 配置面在哪

- 机器级用户层：`~/.dsh/cordis.patch.yml` —— 它**对每个 profile 生效**（web / headless / tui 都吃它）。已实测：`dsh --profile headless --dump-config` 的末尾能看到同一条 `mcp-rw`。
- 该文件里原本已有一条同构的 `mcp-feishu`（`~/.dsh/cordis.patch.yml:16-31`），本轮照它的形状加第二条。
- 相关的 plugin 是 `@deepseek-ai/dsh-mcp-client`；它的 `config` 字段由 `…\dsh-mcp-client\lib\index.js:743-761` 定义（**没猜格式**）。

### 2.2 加了什么（逐字）

文件：`C:\Users\颜文\.dsh\cordis.patch.yml`，**新增第 32-52 行**（原文件 1-31 行一字未动）：

```yaml
# RW (Roni Workbench) MCP server: 把 E:\projects\harness-workbench 的平台当 MCP server
# 接进来，工具以 mcp__rw__* 暴露（rw_chat / rw_status / rw_export）。
# - 条目由 2026-09-16 的「M2 出口·被别的 agent 当 MCP 工具调用」批次加；原文件已备份为
#   cordis.patch.yml.bak-mcp-rw-20260916（同目录）。
# - 与上面 mcp-feishu 同构：一条 insert 一行 plugin，serverName 决定工具前缀。
# - 本条目本身**不含任何密钥**：平台账号由 <运行账户家目录>/.rw-keys.env，或由 dsh 进程环境里的
#   RW_MCP_USER/RW_MCP_PASS（也可用 RW_ADMIN_USER/RW_ADMIN_PASS）提供。两者都没有时，
#   tools/call 会返回 isError「缺账号」——工具本身仍能握手与 tools/list。
# - 想让 tools/call 真返回结果，平台必须在 http://127.0.0.1:880 上跑着（默认 BASE_URL）。
#   要改地址就加 env: { RW_MCP_BASE_URL: 'http://host:port' }。
- insert:
    - id: mcp-rw
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rw
        transport: stdio
        command: node
        args:
          - 'E:/projects/harness-workbench/scripts/rw-mcp-server.mjs'
        reconnect:
          maxAttempts: 5
```

- **备份**：`C:\Users\颜文\.dsh\cordis.patch.yml.bak-mcp-rw-20260916`（1377 字节，改前原样）。
- **回退**：把 `.bak-mcp-rw-20260916` 复制回 `cordis.patch.yml` 即可（或只删掉上面的 block）。
- 没有动 `node_modules` 里的任何东西，没有重装/升级 DSH。

### 2.3 怎么调的（命令）

**(1) 只读核对：配置真的进了 composition**（不启动、不调模型）

```powershell
dsh --profile web --dump-config | Select-String -Pattern "mcp-rw" -Context 0,10
```

原始输出（节选）：

```
> - id: mcp-rw
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: rw
      transport: stdio
      command: node
      args:
        - E:/projects/harness-workbench/scripts/rw-mcp-server.mjs
      reconnect:
        maxAttempts: 5
```

**(2) 真调一次：`dsh --profile headless` + 本地假 LLM**（agent loop 是真的，模型是脚本化的）

用一个**隔离的 `DSH_HOME`**（`tmp/dsh-home/`，`profiles` 是指向真实 `~/.dsh/profiles` 的 junction），
这样完全不碰正在跑我的那个 DSH 实例；配置内容与真配置**逐字相同**，只把 `args` 换成抓帧包装器。

```powershell
$env:DSH_HOME='E:\projects\harness-workbench\tmp\dsh-home'
$env:DSH_PERMISSION_MODE='danger-full-access'
$env:RW_MOCK_LLM_KEY='sk-mock-local-000000000000000000'   # 假 key：万一 baseURL 没生效也只会 401，不花钱
$env:RW_MCP_USER='stub'; $env:RW_MCP_PASS='stub'
$env:MCP_WRAP_LOG='E:\projects\harness-workbench\tmp\mcp-traffic.log'
$env:MOCK_LOG='E:\projects\harness-workbench\tmp\mock-llm.log'
dsh --profile headless `
  --patch E:\projects\harness-workbench\tmp\verify-llm.patch.yml `
  "use the rw_status MCP tool to read conversation 625"
```

`tmp/verify-llm.patch.yml` 只有两行是"机关"（把 provider 端点指到本地假 LLM，见 §2.4）：

```yaml
- id: llm-deepseek
  config:
    baseURL: http://127.0.0.1:8899
    apiKeyEnv: RW_MOCK_LLM_KEY
```

**原始输出**（`tmp/mcp-traffic.log` 的抓帧 + 命令本身的 stdout；这里按发生顺序，中文原样）：

```
[wrap] BOOT spawn E:/projects/harness-workbench/scripts/rw-mcp-server.mjs pid=31200
[srv] [mcp-server] rw-platform MCP server 已就绪（stdio，base=http://127.0.0.1:880，新建会话权限=read）
C→S {"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"dsh-mcp-client","version":"0.0.1"}},"jsonrpc":"2.0","id":0}
S→C {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"rw-platform","version":"0.1.0"}}}
C→S {"method":"notifications/initialized","jsonrpc":"2.0"}
C→S {"method":"tools/list","jsonrpc":"2.0","id":1}
S→C {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"rw_chat",…},{"name":"rw_status",…},{"name":"rw_export",…}]}}
C→S {"method":"tools/call","params":{"name":"rw_status","arguments":{"conversation_id":"625","limit":2}},"jsonrpc":"2.0","id":2}
S→C {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\n  \"conversation_id\": \"625\",\n  \"count\": 22,\n  \"messages\": [ …真实消息… ]\n}"}]}}
[wrap] EXIT code=0 signal=null

（命令自身 stdout 的最后一行，由假 LLM 按工具返回生成）
【mock-llm】已通过 MCP 工具 mcp__rw__rw_status 拿到结果，长度 1473 字符。开头：{ "conversation_id": "625", "count": 22, "messages": [ { "id": "1616", "role": "user", "content": "【定时任务】RA35样本…" …
```

（`tools/list` 的三个工具在这段里被我缩成 `…`，完整帧见 `tmp/mcp-traffic.log` 原文与 §1 的 (a)。）

### 2.4 结论与"没调真模型"的依据

- **成功**：DSH 的 MCP 客户端完成了 `initialize` → `notifications/initialized` → `tools/list` → **`tools/call rw_status`** → 拿到真实数据，并把结果喂回 agent loop 产出最终回答。
- 注意命名差异（正常现象）：DSH 给模型看的名字是 `mcp__rw__rw_status`，但**发给 server 的 `tools/call` 用的是原始名 `rw_status`**。
- **零真模型调用**的证据：假 LLM 的日志 `tmp/mock-llm.log` 里两次请求都是打到 `127.0.0.1:8899`，且第 1 条记录的 `tools` 列表里出现了 `mcp__rw__rw_chat / mcp__rw__rw_export / mcp__rw__rw_status` —— 即"DSH 真的把我们的工具注册进了模型可见的工具面"：

```json
{"dir":"request","url":"/chat/completions","model":"deepseek-flash","stream":true,"nMessages":3,
 "tools":["create_goal","edit",…,"mcp__rw__rw_chat","mcp__rw__rw_export","mcp__rw__rw_status","pwsh",…],
 "toolResults":[]}
{"dir":"request",…,"nMessages":5,"toolResults":[{"tool_call_id":"call_mock_1","content":"{\n  \"conversation_id\": \"625\", …"}]}
```

---

## 3. Codex CLI

### 3.1 配置面在哪

- 用户级配置：`~/.codex/config.toml` 的 `[mcp_servers.<name>]` 表（原文件已有一条 `[mcp_servers.node_repl]`，见 `config.toml:21-40`）。
- 官方子命令：`codex mcp add|get|list|remove`（`codex mcp --help`），本轮用 `codex mcp add` 写的，**没有手改 TOML**。

### 3.2 加了什么（逐字）

命令：

```powershell
codex mcp add rw -- node E:/projects/harness-workbench/scripts/rw-mcp-server.mjs
# → Added global MCP server 'rw'.
```

结果：`C:\Users\颜文\.codex\config.toml` **新增第 42-44 行**（原 1-41 行一字未动）：

```toml
[mcp_servers.rw]
command = "node"
args = ["E:/projects/harness-workbench/scripts/rw-mcp-server.mjs"]
```

- **备份**：`C:\Users\颜文\.codex\config.toml.bak-mcp-rw-20260916`（1908 字节，改前原样）。
- **回退**：`codex mcp remove rw`，或把 `.bak-mcp-rw-20260916` 复制回去。
- 没有密钥：账号机制同 §2.2（环境变量 / `~/.rw-keys.env`）。

### 3.3 怎么调的（命令）

**(1) 只读核对**

```powershell
codex mcp get rw --json
```

原始输出：

```json
{
  "name": "rw",
  "enabled": true,
  "disabled_reason": null,
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": [
      "E:/projects/harness-workbench/scripts/rw-mcp-server.mjs"
    ],
    "env": null,
    "env_vars": [],
    "cwd": null
  },
  "enabled_tools": null,
  "disabled_tools": null,
  "startup_timeout_sec": null,
  "tool_timeout_sec": null
}
```

**(2) 真调一次：`codex exec` + 本地假 LLM**

```powershell
$env:RW_MOCK_LLM_KEY='sk-mock-local-000000000000000000'
$env:RW_MCP_USER='stub'; $env:RW_MCP_PASS='stub'
codex exec `
  -c model_provider=mock `
  -c 'model_providers.mock.name="mock"' `
  -c 'model_providers.mock.base_url="http://127.0.0.1:8900/v1"' `
  -c 'model_providers.mock.wire_api="responses"' `
  -c 'model_providers.mock.env_key="RW_MOCK_LLM_KEY"' `
  -c 'model_providers.mock.requires_openai_auth=false' `
  -c 'approval_policy="never"' `
  -s danger-full-access `
  "use the rw_status MCP tool for conversation 625"
```

**原始输出**（`codex exec` 的 stdout）：

```
OpenAI Codex v0.153.4
--------
workdir: E:\projects\harness-workbench
model: gpt-6-astra
provider: mock
approval: never
sandbox: danger-full-access
reasoning effort: none
reasoning summaries: none
session id: 01a0a740-da57-7061-b5f5-ea52e07db8f4
--------
user
use the rw_status MCP tool for conversation 625
mcp: rw/rw_status started
mcp: rw/rw_status (completed)
codex
【mock-llm/responses】已通过 MCP 工具 mcp__rw__rw_status 拿到结果，长度 31 字符。开头：[object Object],[object Object] …
tokens used
240
```

（最后那行"长度 31 字符 / [object Object]"是**我那个假 LLM 的显示 bug**，不是工具失败：Codex 自己的 `mcp: rw/rw_status (completed)` 与 §3.4 的抓帧都表明工具完整跑完并返回了真数据。假 LLM 的脚本是把结果丢给自己的 `text()` 时没渲染好。）

**(3) 抓帧**（把 `-c 'mcp_servers.rw.args=[…]'` 临时换成走 `tmp/mcp-logwrap.mjs`）—— 与真配置只差 `args` 多一层包装：

```
[wrap] BOOT spawn E:/projects/harness-workbench/scripts/rw-mcp-server.mjs pid=27708
C→S {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.153.4"}}}
S→C {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"rw-platform","version":"0.1.0"}}}
C→S {"jsonrpc":"2.0","method":"notifications/initialized"}
C→S {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
S→C {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"rw_chat",…},{"name":"rw_status",…},{"name":"rw_export",…}]}}
C→S {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"callId":"exec-c0a49571-…","x-codex-turn-metadata":{"session_id":"01a0a73f-…","turn_id":"01a0a73f-…","workspaces":{"E:\\projects\\harness-workbench":{…}},"sandbox_mode":"danger-full-access","model":"gpt-6-astra"}},"name":"rw_status","arguments":{"conversation_id":"625","limit":2}}}
S→C {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\n  \"conversation_id\": \"625\",\n  \"count\": 22,\n  \"messages\": [ …真实消息… ]\n}"}]}}
```

### 3.4 结论 + 三条 Codex 特有的坑（都是实测）

1. **成功**：`codex exec` 真的起了我们的 server、握手、`tools/list`、**`tools/call rw_status`** 并把结果喂回。
2. **`wire_api="chat"` 已被移除**。实测报错原文：
   ```
   Error loading config.toml: `wire_api = "chat"` is no longer supported.
   How to fix: set `wire_api = "responses"` in your provider config.
   ```
   所以本轮给 Codex 配的假 LLM 说的是 **Responses API**（`tmp/mock-llm-responses.mjs`），不是 chat-completions。
3. **Codex 0.153 不把 MCP 工具做成顶层工具**：它把 MCP 工具**嵌进自己的 `exec`（code-mode，JS）工具**里，模型要写
   `await tools.mcp__rw__rw_status({...})`。证据是抓到的原始请求里 `input` 的 `additional_tools` 条目（命名空间只有 `functions/clock/collaboration/mcp__cua_repl`，**没有** `mcp__rw`），而 `tools.mcp__rw__rw_status(...)` 却能跑通。
   直接让模型以顶层名字调用会得到 `ERROR codex_core::tools::router: error=unsupported call: mcp__rw__rw_status`。
4. **权限门**：`-s read-only` 下调用 MCP 工具会被拒：
   ```
   mcp: rw/rw_status started
   mcp: rw/rw_status (failed)
   MCP tool call requires approval, but approval policy is never
   ```
   本轮成功的那次用的是 `-s danger-full-access` + `-c 'approval_policy="never"'`。

---

## 4. Pi —— 未做（含原因与所需条件）

**"PI"指哪个**：`earendil-works/pi` 的 **Pi**，官网 <https://pi.dev>，自称 *"a minimal agent harness"*，作者 Mario Zechner / Earendil Inc.，**MIT License**，仓库 <https://github.com/earendil-works/pi>，npm 包 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)。

**它开不开源**：**开源**（MIT，源码在 GitHub，装法：`curl -fsSL https://pi.dev/install.sh | sh`，或 npm/pnpm/bun 装上面那个包）。

**它支不支持 MCP**：**核心明确"不做 MCP"**。官网 "What we didn't build" 第一条就是 **"No MCP"**，原文建议："Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."。也就是说 Pi 本体**没有** MCP 客户端，要接得**自己写一个 Pi 扩展**（TypeScript 模块），或用社区的 `pi-mcp` / `pi-mcp-extension` 这类第三方包（第三方来源，本轮按"不装来源不明的东西"没有采用）。

**本轮为什么没接**（三条，任一条都足以卡住）：

1. **本机没装 Pi**。装它要 `curl | sh` 或 `npm i -g`，**属于改系统**，超出"只改用户级配置"的授权范围。
2. **跑一轮 Pi 需要模型账号**（15+ provider 的 API key 或 OAuth）。本轮硬规则是"不许真调模型 / 不花钱"。
3. **"接上"不是加配置而是写代码**。Pi 没有 MCP 配置面可填；要么写扩展（新造代码，本轮规定不新造），要么装第三方包（来源不明，规定不装）。

**要什么条件才能接上**：① 装 Pi（官方 install.sh 或 `npm i -g @earendil-works/pi-coding-agent`）；② 一个模型 provider 的 key/OAuth；③ 一个实现 MCP client 的 Pi 扩展（自写 TypeScript 扩展，或审计过来源的社区包）；④ 然后用 `pi -p "<任务>"`（print 模式）就能像 §2/§3 那样跑出被调用的证据。

---

## 5. Claude Code —— 本轮不接

Claude Code 本机未安装、且**闭源**（npm 上只有分发包，没有可审阅源码），按本轮"只在官方/npm 官方包范围内尝试、不绕过分发限制"的口径**不接**，一行说明即可。

---

## 6. 换一台机器要改哪几处

1. **DSH**：`~/.dsh/cordis.patch.yml` 里 `args:` 那一条路径 —— `E:/projects/harness-workbench/scripts/rw-mcp-server.mjs` 换成新机器的**仓库绝对路径**（用正斜杠，与同文件 `mcp-feishu` 的写法一致）。其余字段不用动。
2. **Codex**：`~/.codex/config.toml` 里 `[mcp_servers.rw] args` 同一处路径。建议改完跑 `codex mcp get rw --json` 核对。
3. **平台地址**：两边默认都是平台自己的 `http://127.0.0.1:880`。若平台不在本机/不在 880：
   - DSH：给该条目加 `env: { RW_MCP_BASE_URL: 'http://host:port' }`；
   - Codex：加 `[mcp_servers.rw.env]` 表，键同上。
4. **账号**（两台 agent 通用，二选一）：新建 `<运行账户家目录>/.rw-keys.env` 写 `RW_ADMIN_USER=` / `RW_ADMIN_PASS=`；或把 `RW_MCP_USER` / `RW_MCP_PASS` 放进 agent 进程的环境里（**别写进配置文件**）。
   - 注意 DSH 的 mcp-client 会**清掉**环境里名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量再传给子进程（`dsh-mcp-client/README.md:134`）；`RW_MCP_USER` / `RW_MCP_PASS` 不匹配，能透传（本轮实测通过）。
5. **DSH 要重启生效**：web profile 的 `hmr` 是 `disabled: true`（`dsh --profile web --dump-config` 可见），所以改了 `cordis.patch.yml` 要**重开 `dsh web`**，正在跑的进程不会热加载。
6. **Codex 的权限**：read-only/workspace-write 沙箱下 MCP 工具调用要审批；非交互场景要么给 `-s danger-full-access`，要么让审批策略允许（本轮 raw 报错见 §3.4 第 4 条）。

---

## 7. 没能验证的部分

### 7.1 平台进程本身没跑起来 —— `tools/call` 的成功是用"只读桩"验的

- 现状：本轮开始时 `127.0.0.1:880` **无监听**，`~/.rw-keys.env` 也不存在。
- 我**没有**用 `npm start` 起真平台，原因是它的启动副作用超出本轮授权：`server/index.js:2963-3013` 在 `listen` 前后会拉起 `startDriver()`（任务契约驱动器）、微信渠道、按 settings 连接外部 MCP、以及 `checkEpochAndWarm()` 前缀预热（**可能真的发起模型调用**）。
- 替代：`tmp/rw-stub-platform.mjs` —— 一个**只读**桩，监听 880，只实现我们的 MCP server 真正会用的三个端点（`POST /api/auth/login`、`GET /api/conversations/:id/messages`、`GET /api/conversations/:id/export-full`），数据**真从平台库 SELECT 出来**（只读、不写库、不建会话、不跑任何平台子系统）。
- **因此**：`tools/call` 这一段证明的是"**MCP 协议面 + 我们 server 的代码路径**全通，返回的是真数据"；它**不**证明"真平台进程能用"。
- 要补齐：起真平台（`npm start`）后重跑 §1(b) / §2.3(2) / §3.3(2)，把桩换掉即可；如果不想让它调模型，起之前先确认 `checkEpochAndWarm()` 的指纹是否会变（`server/index.js:2976-2981` 注释：无变化时零调用）。

### 7.2 三个工具的另外两个没被第三方调过

`rw_chat` / `rw_export` **只验证到 `tools/list` 里出现**，没有真被第三方 agent 调用（`rw_chat` 会真的让平台跑一轮对话＝真烧模型，本轮禁止）。

### 7.3 第三方 agent 用的是"脚本化模型"，不是真模型

DSH 与 Codex 两侧的 agent loop 是真的（真注册工具、真 `tools/call`、真把结果喂回去），但**决定"调用哪个工具"的是我写的本地假 LLM**，不是真模型。这样做的唯一目的是满足"不许真调模型"的硬规则。
要换成真模型跑一遍（这是真正意义上的"别的 agent 自主调用"），成本是：DSH 侧一次 `deepseek-flash` 单轮工具调用（**约几厘～几分钱人民币**，本项目自用 key）；Codex 侧一次它自己订阅额度内的调用（**0 额外现金**，走 ChatGPT 订阅）。两条命令就是把 `--patch tmp/verify-llm.patch.yml` / `-c model_provider=mock …` 去掉，其余照抄。

### 7.4 没验证"平台侧权限/纪律层对 MCP 工具的限制"

`docs/MCP接入指南.md:44` 说"平台侧 MCP 工具走统一权限层（含 `mcp_github_*`）"——那是**平台当 MCP 客户端**的方向；本轮做的是**平台当 MCP server**，方向相反，与那套权限层无关，没有交叉验证。

---

## 8. 旁支发现（**只报告，不改**）

1. **我们的 MCP server 没有"离线只读"工具**。三个工具都要"平台在跑 + 有账号"。所以任何一次"接一个新 agent 试试"都隐含依赖平台在线；本轮靠桩绕开了，长期看要么起平台、要么加一个不依赖后端的只读工具（**本轮未改代码**）。
2. **我们的 server 需要账号凭证，配置里却放不下（也不该放）**。任务简报里写"我们 server 不需要（密钥）"——严格说不对：`scripts/rw-mcp-server.mjs:30-42,47` 在登录前就要求 `RW_MCP_USER/PASS`（或 `~/.rw-keys.env`），缺了直接 `isError`。本轮配置留空、由环境变量供，是可行的（已实测），但**部署文档里得写清这一条**。
3. **`docs/MCP接入状态.md` / `docs/MCP接入指南.md` 讲的是反方向**（平台当 MCP **客户端**接 GitHub）。本文是"平台当 MCP **server** 被别人调"。两份文档都在 `docs/` 下、都以"MCP 接入"开头，**容易被后来的人看串**（是否要加交叉链接，请定夺，本轮没动那两份）。
4. **DSH 的 `--patch` overlay 可以覆盖 `llm-deepseek` 的 `baseURL`/`apiKeyEnv`**（`dsh-llm-deepseek/lib/index.js:1884-1913,1993`）。这是个很好用的测试缝：可以在**不烧模型**的前提下跑通整条 agent loop。本轮就是靠它做的验证（`tmp/verify-llm.patch.yml`）。
5. **`@deepseek-ai/dsh-llm-pi-ai` 与 Pi 编码 agent 是"同源但不同物"**：前者的依赖是 `@earendil-works/pi-ai@^0.85.1`（Earendil 的 LLM SDK 层），管的是**模型 provider 路由**，跟"Pi 这个 agent harness 有没有 MCP"无关。查"PI 支不支持 MCP"时别被这个包名带偏。
6. **本机 `~/.dsh/cordis.patch.yml` 里有明文飞书密钥**（`mcp-feishu` 那段的 `FEISHU_APP_SECRET`，第 28 行）。文件自述理由是"local personal machine"。本轮**没动它**，也未把它抄进本文档 —— 但它已经在你截图/分享配置时容易被带出去，值得单独处理。
7. **Codex 0.153 的 MCP 工具是"延迟工具"**：不出现在 `additional_tools` 的命名空间列表里，只能经 `exec` 的 `tools.*` 调用（§3.4 第 3 条）。这会影响任何"给 Codex 写 MCP 用法说明"的文档——照 Claude Code 的写法会写错。
8. **这个工作区当时有其他会话在同时改代码**。本轮做完时 `git status` 里有一大批 `M`/`??`（`server/**`、`scripts/**`、`test/**`、`src/**` …），**都不是本批次写的**：它们的 mtime 落在 6:41–6:47（我会话进行中），而本批次只写了 `docs/MCP-被第三方agent调用-实测.md` 与 `tmp/**`。顺带一提，`scripts/rw-mcp-server.mjs` 在 6:42:58 被别的会话改过一版——也就是说 §1 的基线(6:37) 与 §3 的 Codex 验证(6:45+) 可能跑在**两个不同版本**上（两次都成功，但严格说不是同一个 build）。要让本文的证据"钉死在一个 commit 上"，得在一个干净的树上重跑一遍。

---

## 附：本轮新增/使用的临时件（都在 `tmp/`，未提交、可随时删）

| 文件 | 作用 |
|---|---|
| `tmp/mcp-probe.mjs` | 直接以 stdio 驱动我们的 server，打印原始 JSON-RPC（§1） |
| `tmp/mcp-logwrap.mjs` | MCP stdio 抓帧包装器，日志落 `tmp/mcp-traffic.log` |
| `tmp/rw-stub-platform.mjs` | **只读**桩平台（监听 880，真从库 SELECT） |
| `tmp/mock-llm.mjs` | 假 LLM，chat-completions（给 DSH 用） |
| `tmp/mock-llm-responses.mjs` | 假 LLM，Responses API（给 Codex 用，0.153 只吃这个） |
| `tmp/verify-llm.patch.yml` | 把 DSH 的 `deepseek-official` 端点指到假 LLM 的 overlay |
| `tmp/dsh-home/` | 隔离的 `DSH_HOME`（`profiles` 是 junction，不复制不污染真 home） |
| `tmp/mcp-traffic.log` / `tmp/mock-llm.log` / `tmp/mock-llm-responses.log` | 原始证据日志 |
