# RW 发行物与调教包设计 v1（发布设计文档）

> 前置：体检优化全绿（5.1-5.8 + 界面实时 + conv 自动归档 + schema UI，服务器 8df007b 已加载）。
> 目标（用户确认）：**把调教好的 RW 制作成可复制的发行物**——每个工作台（code/media/book）独立部署一份 RW 实例，
> 新实例应用同一份"调教包"后开箱即得同等行为/安全/性能（换混元/豆包/GLM/千问等模型不影响 CLI 调教）；
> 领域数据与界面归各工作台自行定制；对话列表/对话框=发行版 UI 标准件（固定布局）。

---

## 1. 概念模型
```
harness-workbench 仓库 = 代码发行物（模板）        调教包 packs/rw-core/ = 行为资产（随仓库版本化）
        │ git clone / git pull                          │ 一键应用
        ▼                                                ▼
┌─ code 工作台实例 ─┐  ┌─ media 工作台实例 ─┐  ┌─ book 工作台实例 ─┐
│ .env(独立DB/key)  │  │ 独立库/领域表       │  │ …                 │
│ 领域层(状态机/壳)  │  │ 默认模型:混元/豆包   │  │                   │
│ 共享:规则/技能/    │  │ 共享:同一调教包      │  │                   │
│ 护栏/25启用集     │  │                    │  │                   │
└──────────────────┘  └────────────────────┘  └───────────────────┘
```
- **核心独立**：CLI/护栏/记忆/上下文/预算/审计在实例间行为一致，模型可换（provider 路由层解耦）。
- **领域归工作台**：状态机/字段/UI 是各实例的定制层，通过 project/AGENTS.md 上下文与工具暴露给 RW。

## 2. 发行物组成
### 2.1 代码发行物（即 harness-workbench 仓库 main）
server/（agent 循环/工具 62/驱动器/调度/渠道/网关）· src+web/（标准 UI 壳：对话列表/对话框/设置/轨迹，**固定布局=各工作台共用**）· scripts/（kpi/selfcheck/verify/apply-pack）· docs/（方案与准则文档）。

### 2.2 调教包 packs/rw-core/（随仓库版本化，apply 时展开）
| 资产 | 源 | 应用到 |
|---|---|---|
| 行为准则 | docs/RW行为准则-服务器版.md | 实例 docs/ + ENV_MAP 引用（agent.js 内置） |
| 信任契约 | docs/信任契约-v1.md | 实例 docs/ |
| 记忆架构 | docs/记忆架构.md | 实例 docs/ |
| 权限与沙箱 | docs/权限与沙箱-服务器版.md | 实例 docs/ |
| 平台设计蓝图（唯一总纲） | docs/平台开发全集清单-v1.md | 实例 docs/ |
| 复盘/验收模板 | docs/复盘模板.md、docs/templates/验收模板.md | 实例 docs/ |
| 工具契约施工图 | docs/tool-contracts-v1.md（62 条 when/not/ex） | 实例 docs/（施工参照） |
| 技能（SKILL.md×5） | packs/rw-core/skills/{explore-discipline,self-audit,task-approach,subagent-prompt,acceptance-builder}/SKILL.md | 实例 $RW_SKILLS/（运行时技能目录） |
| 护栏/预算默认 | server/settingsSchema.js（代码内 def）+ db.js SEEDS | 自动（initSchema） |
| 工具启用集默认 25 | server/tools/meta.js DEFAULT_TOOLSET（代码内） | 自动 |
| 政策版本/阈值种子 | db.js SEEDS：__policy_rev=1、task_budget_yuan=0（单段提醒默认关）、task_budget_total=100 | 自动（initSchema） |

### 2.3 环境差异位（实例化必填，不随调教包）
| 位 | 说明 |
|---|---|
| PORT | 实例端口（如 880/8081…） |
| DB_NAME/DB_* | 每实例独立库（rw_dev/rw_code/rw_media…） |
| RW_ADMIN_USER/PASS | 管理员（每实例独立或同账号名） |
| 模型厂商 API keys | DEEPSEEK/GLM/ARK/MOONSHOT…（media 实例可只配混元/豆包） |
| RW_WORKSPACE | 每实例独立工作区（/srv/rw-workspace-code…） |
| git 通道 | 服务器专属 xray socks5（部署脚本内可配 proxy 行）或 hosts |
| 渠道（飞书/微信） | 按实例需要 |

## 3. 一键应用与校验
1. `git clone 模板 → 实例目录`；写 `.env`（按 2.3 差异位）。
2. `node scripts/apply-pack.mjs <instanceRoot>`：把 packs/rw-core 展开（docs 复制、skills 复制到 RW_SKILLS、校验 settingsSchema/默认值一致）→ 输出校验单。
3. `npm run build && node server/index.js`（systemd unit 参照 scripts/PROD-DEPLOY.md 改端口/库名）。
4. 自检：`node scripts/selfcheck.mjs`（HTTP 冒烟 12 项）+ `node scripts/kpi.mjs`（首次基线）+ 三档 preset 断言（rw-verify-preset 逻辑）。
5. 行为等价抽查单：快照含成本/rev；工具默认 25+4；预算键 3 个可见；技能 skills_list=5；准则文件存在且 grep 无 windows 残留；会话级 preset 切换生效。

## 4. 工作台壳指南（领域层模式）
每个工作台实例的定制物：
- `projects/<域>/AGENTS.md`：领域说明（对象/术语/状态机/默认模型偏好），RW 自动注入。
- 领域状态机由实例侧实现为数据+约定（存实例自己的表/文件），通过任务描述与验收进入 RW；RW 保持通用 agent，不内置业务状态机。
- 示例状态机：
  - code 域：todo(待办) → 技术方案 → 测试用例 → 编码 → 自测(verify) → finish_task → 用户复测(done/打回)。
  - media 域：选题 → 脚本 → 分镜 → 素材/帧 → 剪辑包 → 发布检查；默认模型配置到混元/豆包（provider 路由按会话 project 默认）。
  - book 域：大纲 → 章/节 → 素材卡 → 初稿 → 润色 → 终稿。
- 默认模型偏好建议做成会话/域级 settings（project 维默认 provider/model；v1 用会话级 provider/model 由用户或壳选择）。

## 5. 运维与回流
- 模板升级：实例 `git pull + reload_platform`（git 通道按 2.3）。
- **调教回流**：某实例新增技能/规则经验证有价值 → 回 packs/rw-core + docs（PR 式），其它实例 pull+apply 获得。
- 观察期：每实例跑自己的 kpi 周报（scheduled_tasks），横向对比实例质量。
- 审计：usage_stats/tool_calls/audit_log 每实例独立，SQL 可查。

## 6. 已知边界（v1 明示）
- 多实例=多 DB/多工作区/多端口：资源共享（同服务器）时注意磁盘与内存（每实例独立 node 进程）。
- 技能/知识不跨实例自动同步（靠调教包回流机制）；跨实例共享未来可做（core 服务化=另一路线，v1 不选）。
- 37 条 3080 准则原文差异表：原文在用户打印存档，保持分组级（取得后可逐条回填 packs 文档）。

## 7. 首批试点
- 目标：hello 项目作为第一个 code 工作台实例（RW 自己开发）：clone 模板→rw_code 库/工作区→apply-pack→由 RW 按其 AGENTS/状态机实现领域壳与任务流。
- 交付判定：hello 实例可独立跑通"待办→方案→用例→编码→自测→复测"一个完整闭环，且 kpi/行为=主实例等价抽查单通过。
