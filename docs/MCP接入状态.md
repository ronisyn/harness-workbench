# MCP 接入状态（2026-09-06 · 已配置完成）

> 📌 状态快照（2026-09-10 治理标注）：本文=一次性接入状态快照/追溯记录，事实与现码一致（脱敏/占位回存/看门狗/主通道均在位），时点过时。**它是总方案 B §11.4「轮换曾明文入库的 GitHub PAT」待办的事实出处**——token 明文仅存服务器 settings 表=现网已知现状；按 B §9 凭证铁律（不进 DB 明文、只存引用）将在扩展中心/连接器批次改造，届时本快照退役入 docs/archive。

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

## C1 轮换登记（2026-09-11，平台外一次性操作）

- **状态：待用户执行 / 平台侧无法核实**——轮换属平台外操作（GitHub 侧生成新 PAT + 服务器改配置），本次自动化批次不改代码、不代执行；在用户完成前，上文"token 明文仅存 server settings"的现状依旧成立。
- **轮换步骤**（平台外，约 2 分钟）：
  1. GitHub → Settings → Developer settings → Personal access tokens：吊销旧 token，生成新 token（最小权限：repo 只读或按需）；
  2. 服务器编辑 settings `mcp_servers` 中 `github.env.GITHUB_PERSONAL_ACCESS_TOKEN`（后台：应用 → 扩展中心 → MCP 外部服务接入；或 `PUT /api/settings` 后 `POST /api/mcp/reload`）；
  3. 验证：会话内调用 `mcp_github_list_commits` 返回真实提交即成功（`mcp_assetize`/资产卡的健康度指标同源可见）。
- **登记落点**：总方案 §11.4 运维待办；轮换完成后在本节补一行"已完成 日期 + 验证动作"，并把本文按 §8 治理退役入 `docs/archive/`（改造为凭证引用后）。
- **关联现状（2026-09-11 A3 批）**：MCP 已资产化登记（`extensions` type=mcp，`meta.untrustedInput=true` 记录"外部不可信输入"提示注入触发条件），但**凭证引用化（§9 credentials_ref）仍随 D10 连接器批后置**——在此之前明文现状不变。

## 版本注

框架：蓝图 v2.5.5 批5（P11）。现行总纲注（2026-09-10）：=《RW-Agent 平台化改造总方案》B；本文为快照，凭证口径以 B §9/§11.4 为准。配置面板与修复提交：`060f9dc`（UI）、`1d48502`（工具名去重）、`dfe503b`（schema 注册修复）、`8940f91`（名解析修复）、`68968c5`（密钥脱敏）、`6b7219c`（占位提示）、`a31d715`（重连看门狗）。
