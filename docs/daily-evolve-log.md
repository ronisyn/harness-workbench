# RW 每日自我进化 · 执行日志

> 约定任务：北京时间每日 05:00 无人值守执行（scheduled_tasks id=4，cron `0 5 * * *`）。
> 每次执行以「日期」开头条目追加；内容=侦察摘要 / 发现问题 / 修复与 commit / 成本 / 明日建议。

---

## 2026-09-05（首次执行）

### 侦察摘要
- git：基线干净；最近 12 提交为昨晚（09-05 00:57–02:41）交互与阅读体验批次
  （草稿隔离 9c43fea / autotitle 端点 79fe1e4 / 占位符 fail-loud 5cef2ce / 阅读体验v3 9e7ad1f / 首条自动命名 94e536a / 多行输入队列 73e6b86…）。
- 健康基线：`node scripts/selfcheck.mjs` **12/12 通过**；`vite build` 通过（278 模块，791ms）；880 服务 /api/health ok。
- 文档-实现一致性核验：借鉴清单声称均属实——hooks 已内置 2 个强制钩子（danger_command_guard / system_write_guard，见 server/tools/hooks.js）；自动 checkpoint/undo（tools/checkpoint.js）；repo_map（tools/repomap.js）；scheduler.js 空闲长会话自动归档逻辑与 docs/记忆架构.md §4 描述一致。
- 代码卫生：src/ 与 server/ 全量检索无 TODO/FIXME/HACK/console.log/debugger 残留。

### 用量与成本（近 24h，v_usage_daily）
| 日(本地) | 请求数 | 输入 token | 输出 token | 成本 ¥ | cache hit |
|---|---|---|---|---|---|
| 09-04 | 1567 | 63.5M | 1.0M | 112.2 | 2.5% |
| 09-05(至05:00) | 607 | 38.1M | 0.42M | 87.8 | 3.9% |

- 24h 合计约 **¥185**（deepseek-v4-flash 占 ¥175.7 / 1386 次；deepseek 后备 ¥9.6 / 519 次）。
- 会话活跃度：近 24h 仅 1 个会话活跃（web），但用量巨大 → 单请求输入均值 ~63K token、缓存命中率仅 2.5–3.9%。
- **异常观察**：前缀缓存命中率异常低 + 输入 token 量级大，是当前成本主因（推测：长会话全量历史反复送审、多会话并发导致公共前缀被频繁打断）。属 server 核心上下文策略范畴 → 未擅动，转明日建议。

### 发现问题与处置
| # | 类型 | 现象/证据 | 处置 |
|---|---|---|---|
| 1 | docs 过期 | README.md「目录结构」仍写 server/routes/ 与 web/ 前端源码；实测 server/ 扁平无 routes/、前端在 src/、web/dist 仅为构建产物 | ✅ 已修（见 commit） |
| 2 | 成本异常 | 见上表：cache hit 2.5–3.9%、¥185/24h | 记录，转主会话评估（改 server 上下文/缓存策略属核心逻辑） |
| 3 | 性能提示 | vite 警告单 chunk 633KB > 500KB | 记录：建议后续 code-split（React 懒加载），非紧急 |
| 4 | 工具疑点 | grep_search 单文件路径搜索返回空、多模式正则偶漏匹配（Chat.jsx 内 useEffect/function 检索为空，目录级 ReactMarkdown 可命中） | 记录观察，不判定为 bug（可能为工具语义限制）；人工核验以 read_file 为准 |
| 5 | 历史数据 | 多个旧「新对话」会话（autotitle 功能上线前创建）无自动命名 | 符合设计（仅默认标题/force 生效，保护手动命名），不动 |
| 6 | 调度状态 | 本任务 id=4 为首次执行（last_run 原为 null）；KPI 周报 id=3 正常排期 09-07 | 正常，无需处理 |

### 修复与 commit
- README.md：目录结构段按实测更新（server/ 扁平结构 + src/ + web/dist + tools/channels/llm 子目录等）。
- commit：`0e6eae1`（docs: README 目录结构对齐现状 + 新增每日自我进化执行日志首条 —— 2026-09-05）

### 成本估算
- 本次执行 ≈ ¥2–3（侦察 LLM 用量 + selfcheck 真实对话最小调用 2 delta），低于单日预算占比可忽略。

### 明日建议
1. **优先评估成本问题**：cache hit 2.5% + 输入 63K/请求 → 检查 agent.js 是否每次都带全量历史/ENV_MAP/工具说明，验证「提示词前缀稳定性」（同会话同模型前缀应命中缓存）；若并发交错打断前缀，可考虑同会话串行化或精简注入。这是目前最大可省成本项（¥185/24h 中大部分是重复输入）。
2. 前端 chunk 633KB → 建议对设置页等低频路由做 React.lazy code-split（低风险，可主会话做）。
3. grep_search 行为核实：若确为单文件路径不支持，宜在工具说明中标注「传目录」以免误导（属 docs/工具层小改，主会话可顺手做）。
4. 无需要重启 server 的改动（本次仅改 docs/README）。

---
