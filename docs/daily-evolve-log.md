# RW 每日自我进化日志

> 服务器无人值守时段（北京时间 05:00）执行摘要。最新条目在底部；commit 均含当日说明。
> 关联：docs/RW行为准则-服务器版.md · docs/Codex与主流CLI-机制借鉴清单-v1.md · docs/记忆架构.md

---

## 2026-09-05（周五 05:00 定时任务，会话 #185）

### 一、侦察（只读）
- git 基线：工作区干净；HEAD 之前 12 条提交均为 09-04/05 夜间会话产出（草稿隔离 9c43fea、标题端点 79fe1e4、占位符守卫 5cef2ce、阅读体验 9e7ad1f 等）。
- 健康自检：`node scripts/selfcheck.mjs` **12/12 通过**（health/login/7 个 GET/会话增删/SSE 真流式）；boot_log 无近期异常，服务自 09-03 07:51 起连续运行未重启。
- 定时链路：scheduled_tasks #4「每日自我进化-05:00」enabled=1，本会话即其 09-05T05:00 触发生成；#3「KPI周报」cron `0 9 * * 0`（scheduler 自定义语义 0=周一）next_run 09-07T01:00Z=周一 09:00 北京，符合预期。
- 用量（近 24h）：usage_stats 1917 行，成本 ¥185.93，tokens in 87.6M / out 1.2M；其中 deepseek-v4-flash ¥176.30（1398 次）、deepseek ¥9.64。按会话：**#184 ¥106.0、#141 ¥67.4**（高强度人工交互会话），其余均 <¥3——无无人值守跑飞迹象，属正常人工用量。
- 活跃度：24h 新会话 5、有消息会话 4、消息 67 条。
- 文档勾选核对：借鉴清单 P1-1 hooks ✅（内置 2 个强制钩子）、P1-2 checkpoint ✅、P2-3 repo_map ✅；P2-4 双模型交叉验证 ⬜、P3 MCP ⬜（状态与代码一致）。记忆架构文档与 scheduler 实现一致。

### 二、发现的问题（按现象→证据→原因→方案→适配性判断）
1. **【已修复】autotitle LLM 起名端点必抛 ReferenceError**
   - 现象：POST /api/conversations/:id/autotitle 一直失败；大量长会话（#141、#159 等）标题停留默认「新对话」。
   - 证据：server/autotitle.js 查询出 `rows`（最近 12 条消息）但从未使用，拼 prompt 时引用**未定义变量 `lines`**（`lines.join('\n')`）→ 必抛 ReferenceError；Chat.jsx:442 `.catch(()=>{})` 吞错，用户无感知。前端 api.js:27 autoTitle → index.js:168 路由。
   - 原因：79fe1e4 夜间新增端点时漏写 rows→lines 映射（死变量+未定义引用）。
   - 方案：补映射——按角色加「用户：/助手：」前缀、时间正序、单条截断 300 字符防超长内容撑爆上下文/烧钱。
   - 适配判断：纯增量小修（无行为回归——此前路径恒失败，修复只可能变好），本轮按任务规则直接修。
2. **【仅记录】新特性未经 E2E 即合入**（9c43fea/79fe1e4/5cef2ce 等均系数小时前夜间会话产出，缺运行时冒烟）——建议次日晨主会话做一轮"新特性回归"（autotitle 起名、草稿隔离、fail-loud 占位符守卫），本轮无人值守不代跑交互冒烟。
3. **【仅记录】cron 周字段语义非标准**：scheduler.js `cronToNext` 用 `(getDay()+6)%7`，**0=周一**（与标准 cron 0=周日不同）；文件头注释未注明，存在误配风险（KPI周报实为周一 09:00，若意图是"周日"则配错——创建者需确认）。建议在 scheduler.js 头部注释补充"周字段 0=周一"。
4. **【仅记录】git remote URL 内嵌 x-access-token**（.git/config，仅服务器本地，push 需要）。不属仓库内容、无泄漏面扩大风险，勿外发该 repo 副本；长期可换 credential helper——暂不动。
5. **【仅记录】成本结构**：¥185.93/24h 由两个人工会话贡献 93%，无定时任务/子代理跑飞。autotitle 修复后每次 send 会多 1 次 LLM 小调用（max_tokens 40、截断 300 字×12 条 ≈ 4K in），成本可忽略；后续如加"仅当默认标题才调"已由 skip 逻辑覆盖。

### 三、本轮改动（全部低风险、已验证）
| 改动 | 文件 | 验证 | commit |
|---|---|---|---|
| 修复 autotitle rows→lines 缺失映射（+截断防烧钱） | server/autotitle.js | `node --check` 通过；独立 node 冒烟确认时间正序/角色前缀/换行折叠逻辑；git 基线干净后提交 | `edc4ac6` |
| TODO.md 头部加每日进化日志指引 | TODO.md | 读回 diff 一致 | 随下条提交 |
| 新建本日志 | docs/daily-evolve-log.md | 新建 | 随下条提交 |

### 四、成本估算（本会话 #185）
- 会话累计 ≈ ¥2.3（36 次 usage 记录）；全平台近 24h ¥185.93（正常人工强度）。

### 五、明日（09-06）建议
1. **reload_platform 使 edc4ac6 生效（本轮无人值守按规未重启）**，随后 E2E：临时会话发 2 条消息 → 调 autotitle 端点 → 断言返回 title；并观察 09-06 新建会话标题是否自动生成。
2. 确认 KPI周报 cron `0 9 * * 0` 语义：意图周一 09:00 还是周日？（当前=周一 09:00 北京）
3. 新特性回归冒烟：草稿隔离（切会话草稿不串）、fail-loud 占位符、9c43fea 起的阅读体验。
4. P2-4 双模型交叉验证仍 ⬜（可评估但非紧迫）；prototype/ 与 README 描述一致，暂保留。
