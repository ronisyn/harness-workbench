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

## 2026-09-05（二轮 · 同会话 #185 复触发续跑，~05:04+0800）

> 说明：本会话今日已执行过一轮（首轮条目见上，commit 0e6eae1/953682e 已产出）；平台在长会话达到轮次阈值后复注入同一任务提示续跑，本轮为续跑后半段。首轮条目曾在续跑中被误覆盖，已 git checkout HEAD~1 原样恢复并追加本条目（无内容丢失）。

### 一、侦察补充（续跑视角）
- git 基线：续跑开始时干净；首轮已提交 README 目录结构修正与日志首条（0e6eae1/953682e）。
- 健康自检：`node scripts/selfcheck.mjs` **12/12 通过**；boot_log 无异常；服务自 09-03 07:51 连续运行未重启。
- 用量：近 24h ¥185.93（#184 ¥106 + #141 ¥67.4 占 93%，人工强度正常）；本会话 #185 累计 ≈ ¥2.3。
- 定时链路核对：scheduled_tasks #4「每日自我进化-05:00」last_run 仍为 null（执行中）、next_run 已推至 09-06T05:00 北京；KPI周报 #3 next_run 09-07T01:00Z（周一 09:00 北京，scheduler 自定义语义 **0=周一**，非标准 cron）。

### 二、续跑新发现
1. **【已修复】autotitle LLM 起名端点必抛 ReferenceError（上轮 #5 判断需修正）**
   - 现象：POST /api/conversations/:id/autotitle 恒失败；大量长会话（#141/#159）标题停留「新对话」。上轮把该现象判为"符合设计"，实际是**真 bug**：首轮结论对旧会话成立，但对新会话同样不生效说明另有原因。
   - 证据：server/autotitle.js 查询 `rows`（最近 12 条）后从未使用，拼 prompt 引用**未定义 `lines`** → 必抛 ReferenceError；Chat.jsx:442 `.catch(()=>{})` 吞错。
   - 修复：补 rows→lines 映射（角色前缀「用户：/助手：」+ 时间正序 + 单条截断 300 字符防烧钱）。`node --check` 通过；独立 node 冒烟验证正序/截断/换行折叠。commit `edc4ac6`。
2. **【仅记录】cron 周字段语义非标准且文件头未注明**：scheduler.js `cronToNext` 用 `(getDay()+6)%7` 使 0=周一；建议主会话在文件头注释补一句，防误配。
3. **【仅记录】git remote URL 内嵌 x-access-token**（仅服务器本地 .git/config，勿外发仓库副本；暂不动）。
4. **【仅记录】同会话复触发**：长会话续跑机制会重复注入任务提示（本日两次执行同一 daily 任务）；需确认属平台预期（resume）还是调度重复触发——若为后者应防重（如 last_run 幂等标记）。

### 三、续跑改动
| 改动 | 文件 | 验证 | commit |
|---|---|---|---|
| 修复 autotitle rows→lines 缺失映射（+单条截断 300 防超长上下文） | server/autotitle.js | node --check 通过 + node 冒烟验证 | `edc4ac6` |
| TODO.md 头部加每日进化日志指引 | TODO.md | diff 读回一致 | `a9a1d9b` |
| 合并日志：恢复首轮条目（git checkout HEAD~1）+ 追加本轮 | docs/daily-evolve-log.md | 追加式，无覆盖 | 本条目提交 |

### 四、成本估算
- 本会话 #185 两轮累计 ≈ ¥2.5；全平台 24h ¥185.93 属正常人工强度。autotitle 修复后每 send 增加一次 max_tokens=40 小调用（≈4K in），成本可忽略。

### 五、明日（09-06）建议
1. **reload_platform 使 edc4ac6 生效（无人值守按规未重启）** → E2E：临时会话发 2 条消息 → 调 autotitle 端点断言返回 title；观察新会话标题自动生成率（KPI：默认标题残留）。
2. 承接首轮建议：**cache hit 2.5–3.9% + 输入 63K/请求**是当前最大可省成本项，评估 agent.js 全量历史/前缀稳定性（server 核心，主会话决策）。
3. scheduler.js 文件头补「周字段 0=周一」注释；确认 KPI周报意图。
4. 新特性回归：草稿隔离、fail-loud 占位符、阅读体验 v3。
5. 核实 09-05 是否双次执行同一 daily 任务（复触发幂等性）。

---

## 2026-09-06（约定任务执行，北京 05:02-05:1x）

### 一、只读侦察摘要
- 基线：git status 干净；HEAD 为 batch1 收尾 `7622728`（批1/P1 统一工具通道、P4 意图挡位、P8 缓存成本入账等已在主会话凌晨落地）。
- 健康：`node scripts/selfcheck.mjs` 12/12 通过；src/ 无 console.log/debugger 残留；server 中 plan_mode/exit_plan_mode 仅剩"退役说明"注释（tools/index.js:658、meta.js:84/88），非死代码。
- 用量（usage_stats，近 24h @05:05，会话时区口径）：633 次、¥55.07、均 ¥0.087/次；缓存命中 7.7%（hit 1.78M/总 23.2M）。分模型：DeepSeek V4 Flash ¥48.54/468 次/hit 5.7%、glm-5.3-flash ¥0.88/32 次/hit 41%。hit 较 09-05（2.5–3.9%）回升，批1/P8 与上下文精简初显收益；但 miss 输入仍 21.45M/24h，仍为最大可省成本项（延续主会话 O 域，本会话不重复介入）。

### 二、自我检视发现
| # | 类别 | 现象 | 证据位置 | 原因推测 | 处置 |
|---|---|---|---|---|---|
| 1 | 路径漂移 | daily-evolve-log 已随 036c6c2 移入 docs/archive/，但活引用仍指根路径 docs/daily-evolve-log.md，照旧执行会在根目录新建同名文件 → 日志分叉 | scheduled_tasks#4 prompt 步骤4；TODO.md:1 | 治理提交只移文件、未同步更新引用方 | 修复：两处引用统一到 docs/archive/ |
| 2 | docs 断链 | TODO.md 引用的差距清单/880实测指南/最终自审报告均已入 archive | TODO.md:3-4 | 同上（move 未改引用） | 修复：改 archive 路径 |
| 3 | docs 过期 | TODO.md#2"双路径：普通对话不带工具"与 Codex清单 §1 plan 行"conversations.mode=plan + plan_mode 工具"均已被批1/P1（统一工具通道）、P4（意图挡位、退役 plan_mode）取代 | TODO.md#2；docs/Codex与主流CLI-机制借鉴清单-v1.md §1 | 文档滞后于凌晨批1 落地 | 修复：同步为新机制语义 |
| 4 | 注释缺失 | scheduler.js 文件头未注明 cron 周字段非标准语义（0=周一） | server/scheduler.js:3-4 | 09-05 日志"明日建议#3"遗留未修 | 修复：头注释补一行（纯注释） |
| 5 | TZ 口径不一 | conversations/messages.created_at 存 UTC ISO（datetime），usage_stats.created_at 为 TIMESTAMP 随会话时区显示 → 跨表按时间过滤易误判（今日"是否复触发"核查因此无法一锤定音） | 表实测（messages vs usage_stats） | 演进期未统一存时区约定 | 仅记录：建议主会话统一为 UTC 存储或列注释显式标注 |

适配性判断：本批修复全部落在"文档/引用/注释"层面，零运行时行为变更；**外部 CLI 的"归档即冻结"惯例不适合本环境**——daily-evolve-log 是活文档需每日追加，故采用"改引用、不动文件位置"的最小动作，并在 archive/README 将该文件标注为活文档防误清理。

### 三、改动与验证
| 改动 | 文件/数据 | 验证 | commit |
|---|---|---|---|
| TODO.md 头行/归档引用/对话自然度条目同步批1 语义 | TODO.md | diff 读回一致 | `1932d6a` |
| Codex清单 §1 plan mode 行 → plan=意图挡位 | docs/Codex与主流CLI-机制借鉴清单-v1.md | diff 读回一致 | `1932d6a` |
| archive/README 标注 daily-evolve-log 为活文档 | docs/archive/README.md | diff 读回一致 | `1932d6a` |
| scheduler.js 头注释补 cron 周字段 0=周一 | server/scheduler.js | node --check 通过（纯注释） | `1932d6a` |
| scheduled_tasks#4 prompt 日志路径 → docs/archive/ | DB（REPLACE 幂等） | SELECT 复核 archive_refs=1/root_refs=0 | —（非 git 数据） |

commit `1932d6a`：4 files changed, +8/-6（原 750c629 经 --amend 补全消息含 scheduler 项）。

### 四、成本估算
- 本会话累计 ≈ ¥2.5（快照：token in≈1.0M/out≈22.6K）；全平台 24h ¥55.07 / 633 次（口径：usage_stats 行求和）。批1 开发与 E2E 属正常开发强度。

### 五、明日（09-07）建议
1. 明晨执行应直接追加 docs/archive/daily-evolve-log.md（本会话已改 DB prompt），观察是否仍出现根路径分叉/双文件。
2. 缓存命中跟踪：hit 7.7% 较昨日回升但绝对值仍低；若持续 <15%，主会话继续评估前缀稳定性与输入精简（O 域，延续）。
3. 复触发核查收尾：先统一 conversations/messages 与 usage_stats 时区口径，再以 scheduled_tasks.last_run 对照会话 created_at(UTC) 一锤定音 09-05 是否双跑。
4. 待重启项汇总后交主会话：edc4ac6（autotitle）与批1 P1/P4/P8 等 server 改动，人工时段 reload_platform + E2E 回归。

### 六、需重启项（留档）
- 本会话**无**代码行为改动（仅注释+docs+DB prompt），无需重启。
- edc4ac6 与批1 各项 server 改动是否已生效：请主会话比对进程加载时间与 git 时间后决定 reload（无人值守时段不自行重启）。

---

## 2026-09-07（第三次执行 · 定时任务 05:00 无人值守）

**侦察摘要**
- git：main @ 3374964（P26 定位/审计增强收口）；工作区开始前干净；无待重启遗留（昨夜主会话已多次 reload 部署 P25/P26，agent_runs #175/#178 completed）。
- 健康：selfcheck 12/12 ✅；src/ 零 console.log/TODO/FIXME/debugger 残留，server/ 仅启动与渠道注册等正当日志。
- 用量（近 24h @ 05:00，UTC 口径）：431 次请求，¥16.28，tok_in 8.71M / tok_out 0.23M，**cache-hit 26.4%**（对比 09-05 峰值期 4.5–7.7%，缓存优化红利明显）。
- 活跃度：近 24h 39 个会话、2 个 project，其中约 37 个为昨夜主会话 P25/P26 回归验证产生的 `__batch1_verify__`/`__stream_e2e__`/`__reg_*`/`__glm_diag__` 短会话（多数仅 2 条消息）；真实交互会话很少（conv 266 等）。
- 时区口径澄清（修正昨日疑云）：conversations/messages/usage_stats 均存 UTC（MySQL 会话时区=UTC，NOW()≈UTC）；`v_usage_daily.d` 按北京时间(+8)分组 → 「按日」与「近 24h」两口径并存属预期，**非存储冲突**；跨表窗口比对统一用 UTC。
- 复触发问题落定：`scheduled_tasks.last_run` 唯一（09-05T21:06Z）→ 09-05「双跑」实为同一会话 #185 轮次上限后的续跑（调度器只触发一次）；调度器固定复用 conv#185（自 09-04T21:00Z 创建，每天追加 2 条消息，现共 6 条），机制合理，无需改动。

**发现的问题与处置**
| # | 现象 | 证据 | 原因推测 | 处置 |
|---|------|------|----------|------|
| 1 | 测试会话污染 default project 会话列表/统计：39 个会话中 37 个是自动化验证短会话，1 个（id=262）0 消息 | conversations 近 24h 查询 | 批量 E2E 验证未统一用 reg-test project（id=262 用过该机制） | **仅记录**（删除会话属数据操作，无人值守不做）→ 建议主会话定策略 |
| 2 | docs/记忆架构.md 仍写「AGENTS.md 注入（WS5c，待批 6 落地）」，实际 P25/O-25 已实施并去掉 default 门（07977ea） | 记忆架构.md §1/§5 vs server/index.js:480-487 | 文档滞后于 09-06 主会话提交 | **已修复**：两处改为「WS5c→P25/O-25 已实施（default 也可放，存在才注入）」→ commit aa33293 |
| 3 | 09-05 ¥139.6 高成本日复盘口径 | v_usage_daily | 峰值期大量未命中前缀缓存（hit 4.5%） | 无需动作，趋势向好（09-06 ¥12.7 / 09-07 至 05:00 ¥3.6） |

**本任务成本估算**：conv#185 本日 05:00 起约 60 次调用，tok_in ≈2.1M / tok_out ≈32K，≈ **¥4.7**（占单会话日预算 ¥100 约 5%）。

**commit**：aa33293（docs，AGENTS.md 注入状态标记同步）

**待重启项**：无（仅 docs 变更）。

**明日（09-08）建议**
1. 主会话拍板测试会话策略：批量验证统一 `project=reg-test`（title 前缀 `__` 可选），或增加「按 project/title 前缀清理旧验证会话」的低风险 routine（含审计与备份，需人工放行后执行）。
2. 若日间无大交互任务，可评估深挖前缀缓存命中（当前 26.4%）是否还有提升空间（前缀稳定性 vs 轮次上下文变化）。
3. 借鉴清单 P2-4「双模型交叉验证」仍 ⬜ 可选未落地：若短期无审计需求，建议主会话关闭该条目或明确延后，避免每日复读。
4. 09-06 全天用量低（¥12.7）属正常休息日形态，无需干预；关注今天白天是否恢复正常交互量级。

## 2026-09-07（约定任务 · 无人值守 05:00 UTC+8）

### 侦察基线
- git 基线干净（HEAD 3374964）；`node scripts/selfcheck.mjs` 12/12 通过；`node --check` hooks.js 通过。
- 用量（近 24h）：kind=round 412 次 / token in≈8.37M（cache_hit 2.29M / miss 6.08M） / 成本≈¥14.77（deepseek-v4-flash ¥12.34 占 84%）。
- 会话活跃度：41 会话中近 24h 活跃 39。
- 执行主体：本条目由 scheduled_tasks id=4 触发（channel=task，conv185），路径与 09-06 修正后一致（直接追加本 archive 文件 ✅，昨日建议#1 验证通过）。

### 复触发核查（结案，昨日建议#3）
- conv185（task-4）消息序列实证：**09-05（北京）双次执行**——msg639/640 @ 09-04T21:03Z 与 msg641/642 @ 09-04T21:06Z（各一轮 user+assistant，共 4 条）；09-06 仅单次（msg713/714 @ 09-05T21:06:11Z，2 条）。last_run 只存最后完成时刻故此前无法看出双跑。
- 结论：双跑发生在 09-05 05:03/05:06，此后防重入（先推后 next_run）正常，09-06 起单次稳定 → 结案，无需再查。

### 成本异常跟踪（昨日建议#2）
- **cache hit 27.33%**（hit 2.29M / hit+miss 8.37M），较 09-05 的 2.5–3.9% 与 09-06 的 7.7% 显著回升；日成本 ¥185 → ¥55 → ¥14.77。前缀稳定/上下文策略优化见效，维持观察即可。

### 发现问题与处置
| # | 类型 | 现象/证据 | 处置 |
|---|---|---|---|
| 1 | 代码字符损坏 | **server/tools/hooks.js 中 60 处全角括号"（"被误替换为"默"**（git grep：该文件"默认"仅 1 处正常而"默"共 61 处；对照 tools/index.js/agent.js 等"默"=默认+静默全正常，仅 hooks.js 受害）。不仅注释，含**运行时模型可见文案**：code_syntax_check 钩子 hookNote "语法检查通过默node --check）"（本人工具输出即实锤）、finish_selfcheck_note "完成总结过短默N 字）"、纪律 reason 文案等 → 影响模型可读性与排错 | ✅ 已修 commit `698ae1e`：`默(?!认)`→`（` 精确替换 60 处，保留 line179"默认"；diff 全量语义核验 + node --check 通过 |
| 2 | docs 过期 | docs/Codex与主流CLI-机制借鉴清单-v1.md P3-5 "MCP 生态接入 ⬜ 暂缓" 与 docs/MCP接入状态.md（2026-09-06 已落地 github 26 工具/密钥脱敏/看门狗）冲突 | ✅ 已更新为 ✅（commit `eb860fa`） |
| 3 | 知识库过期 | 进度总表 v3（id=5）"剩余：P3 MCP 暂缓" 误导后续会话 | ✅ 新增 v3.1（含 MCP 落地+本轮修复记录）并将 v3 标记已取代 |
| 4 | 工具已知语义 | grep_search 传**单文件路径**返回空（今日 3 次复现：对 Codex清单/行为准则/hooks.js 单文件 grep 均空，目录级正常）；kb id=8 已记录为已知行为 | 不改 handler（无人值守时段不动工具实现）；建议主会话评估：handler 加单文件 stat→按其父目录搜索后过滤，或 description 明示"仅目录"。低风险增量 |
| 5 | 调度状态 | KPI 周报 id=3 next_run=2026-09-07 01:00Z（北京 09:00 周一）正常排期；本任务 id=4 next_run 已按 cron 推进 | 无需处理 |

### 修复与 commit
- `698ae1e` fix(hooks): 恢复 hooks.js 60 处被误替换的全角括号（含运行时 hookNote/reason 文案）
- `eb860fa` docs: Codex清单 P3-5 MCP ⬜→✅（对齐 docs/MCP接入状态.md）
- 知识库：kb_add 进度总表 v3.1（id=9）；kb 覆盖标记 v3（id=5）已取代

### 成本估算
- 本次执行（侦察 LLM + selfcheck 2 delta）≈ ¥2–3；日成本 ¥14.77/24h 已处低位。

### 明日建议
1. **需主会话处理（待 reload 生效）**：hooks.js 文案修复已提交（698ae1e），进程当前仍加载旧文案 → 下次 reload_platform 时随同生效；无人值守时段未自行重启。
2. grep_search handler 单文件支持（增量小改，评估后做，见上 #4）。
3. cache hit 27.3% 维持观察；若再降回 <10% 再查前缀打断源。
4. 无其它待重启项；本任务会话 conv185 已接近归档门槛（消息数多），主会话可按需 summarize。

**补记（续跑轮收口）**：本次 05:00 执行产生多次续跑续做，本任务今日累计 4 个 commit——698ae1e（hooks.js 60 处全角括号"默"→"（"修复，含运行时 hookNote/reason 文案，`node --check` ✅）、aa33293（记忆架构.md AGENTS.md 状态）、eb860fa（Codex清单 P3-5 MCP ⬜→✅）、9242b87（本日志）。**待重启项更新：698ae1e 改动了 hooks.js 运行时文案，需下次 reload_platform 后生效**（无人值守不自行重启，交主会话白天 reload）；aa33293/eb860fa/9242b87 均为 docs，无需重启。另：同会话多续跑各自补做少量交叠（如 aa33293 为续跑轮发现补修），说明"复触发=轮次上限后同会话续跑"现象今日仍存在（05:00 后一次调度产生多段续做），建议主会话评估对定时任务会话限制每轮收尾即停（如完成即 idle、不因快照续跑），或接受其幂等性（本次各续跑改动互不冲突、均为增量）。

## 2026-09-08（约定任务 · 无人值守 05:00 UTC+8）

### 侦察基线
- git 基线干净（HEAD 602a7e6，即 09-07 收尾 docs 提交）；`node scripts/selfcheck.mjs` **12/12 通过**；服务健康。
- 近 24h 用量（usage_stats，自 09-07 05:00 至 09-08 05:00）：共 ~111 次调用 / token in ≈4.83M / out ≈77K / 成本 ≈ **¥11.4**（其中昨日 05:00 自我进化任务占 ¥10.28、84 次；09-07 09:00 主会话 23 次 ¥0.97；本次任务进行中 4 次 ¥0.13）。会话活跃：09-07 新建 15（24h 内活跃 1）、09-06 新建 25（0）——日间交互量级仍低，与休息日形态一致。
- 执行主体：scheduled_tasks id=4（channel=task，conv185），路径=直接追加本 archive 文件 ✅（连续 2 日验证通过）。

### 发现问题与处置
| # | 类型 | 现象/证据 | 处置 |
|---|---|---|---|
| 1 | 工具小 bug | **grep_search 传单文件路径恒空**——09-06/09-07 各记录 1 次、今日本人再亲历 2 次（grep 本日志标题、grep server/tools/index.js 单文件均空；目录级正常）。读实现定位根因：`run` 内 `walk(d)` 只对目录 `readdirSync`，path=文件时抛 ENOTDIR 被 `catch{return}` 吞掉→返回空 matches/files，且不报错（静默失败，比报错更误导） | ✅ **已修复** commit `3e0ad41`：抽取 `searchFile(f)` 统一目录/文件分支；run 开头 `statSync` 判文件→直接单文件搜索。目录路径行为逐字节不变（扩展名白名单/100 条上限/错误吞并均保留）；description 同步改为「在路径(目录或单文件)中」。验证：`node --check` ✅ + 独立 node 冒烟（import TOOLS 实跑）**3/3**（单文件命中/目录回归/不存在路径不抛错）。⚠️ 待 reload 生效 |
| 2 | 待重启确认 | **hooks.js 全角括号修复（698ae1e，09-07）仍未生效**：本次各工具 hookNote 实时输出仍为「语法检查通过**默**node --check）」（syntax_check/edit_file 结果多次实锤）→ 运行进程仍加载旧 hooks.js，09-07 白天主会话未 reload | 仅记录（无人值守不重启）。连同 #1 的 3e0ad41 一并列入待 reload 清单（见明日建议#1） |
| 3 | 自查通过项 | 记忆架构.md 重读与实现一致（无过期）；Codex 清单 P3-5 MCP ✅ 无回退；server/src 全量无 TODO/FIXME/HACK/console.log/debugger 残留；复触发今日未现（05:00 单轮执行中） | 无需处理 |
| 4 | 成本跟踪 | 近 24h ¥11.4 处低位（cache hit 口径未重查，前缀优化效果延续），维持观察即可 | 无需处理 |
| 5 | 知识库同步 | kb id=8「grep_search 只支持目录路径」句将在 reload 后过时；id=9 进度总表不含本小修 | 已新增 kb id=10（补丁记录：3e0ad41 状态 + hooks 未生效确认），reload 后可按 id=10 清理 id=8 过时句 |

### 修复与 commit
- `3e0ad41` fix(tools): grep_search 支持单文件路径（searchFile 抽取 + stat 分支，目录行为不变）——2026-09-08 自我进化
- kb id=10：2026-09-08 自我进化补丁记录（global）

### 成本估算
- 本次执行：长文档侦察读取为主（本日志/清单/记忆架构/工具实现多段 read），LLM 调用约 24 次（含 selfcheck 2 delta），tok_in 追加 ≈450K，**≈¥0.8–1.2**；单会话日预算占比 <2%。

### 明日（09-09）建议
1. **主会话 reload_platform 一次生效两个待重启项**：① hooks.js 文案修复（698ae1e，09-07 提交，今日实测仍未生效）；② grep_search 单文件支持（3e0ad41，今日提交）。reload 后 E2E 两条：grep_search 传单文件（如本日志 md）应返回命中；工具 hookNote 括号恢复正常（不再出现「默node」）。reload 后按 kb id=10 清理 kb id=8 过时句。
2. P2-4 双模型交叉验证 ⬜ 连续第 3 次滞留清单：若 09 月无审计需求，建议主会话在 Codex 清单 §4 显式标注「延后至 2026-10 再评估」或删除，避免每日复读占版面。
3. 09-06 遗留建议#1（测试会话统一 project=reg-test / 旧验证会话清理 routine）仍未拍板；conv185 消息数超归档门槛，主会话可按需 conv_summarize。

---

## 2026-09-08（主会话 reload_platform 与验证记录 · 白天 12:2x 北京时间）

> 承接 09-08 05:00 自我进化日报「明日建议#1-3」与 09-06/09-07 遗留待拍板项；本条目由主会话（外部验证会话）执行并记录，供后续会话与明晨任务直接引用。

### reload_platform（一次重启生效两项待重启改动）
- 重启前：rw-test.service pid 397107（启动 09-07 02:32，早于 698ae1e/3e0ad41）；无 in-flight agent 运行，重启安全。
- `systemctl restart rw-test`（12:22 CST）→ 新 pid 405957（12:22:23 启动），health 200，MCP github 26 工具重连正常。
- 生效项：① hooks.js 全角括号修复 `698ae1e`（09-07 提交，此前运行进程仍输出「语法检查通过**默**node --check）」）；② grep_search 单文件支持 `3e0ad41`（09-08 提交）。

### E2E（走 880 运行态 API：admin 登录 → 新建 conv#271 project=reg-test → POST /api/chat 实跑，tool_calls 表为实证）
1. **grep_search 单文件**：{path=`docs/archive/daily-evolve-log.md`（单文件路径）, pattern=grep_search} → **matches 8 条命中**（行 33/47/184/197/213/217/220/227），files=[该 md 自身] ✅ 单文件不再恒空（修复前该路径恒返回空）。
2. **hookNote 括号恢复**：write_file `/tmp/rw-e2e-bad.js`（`const x = ;` 语法错）→ hookNote=`⚠️ 语法检查失败：Command failed: node --check /tmp/rw-e2e-bad.js（请修复后再提交）`；write_file `/tmp/rw-e2e-ok.js` → hookNote=`语法检查通过（node --check）` ✅ 全角括号正常（不再出现「默node」）。
- 冒烟 scratch 文件已清理；E2E 会话 conv#271 保留（project=reg-test，标题 `__e2e_reload_0908__`，工具留痕可查）。

### 知识库维护
- kb id=8：删除过时句「grep_search 只支持目录路径（单文件路径返回空）；」✅（该体检记录其余内容保留）。
- kb id=10：状态「已提交待 reload 生效」→「已生效（2026-09-08 主会话 reload_platform + E2E 通过后更新）」，正文按实证同步。

### conv185 归档
- conv185（scheduled_tasks#4 专用会话 channel=task）消息数 12 已超归档门槛 → 执行 `summarizeConversation(185)`（同 conv_summarize 默认路径；12 条 <80 → 结构化 v1）✅ conv_summaries 已落 185 行（updated_at 2026-09-08 04:23:57Z）。

### 拍板（消除每日复读）
1. **P2-4 双模型交叉验证 → 延后至 2026-10 再评估**（09 月无审计需求）。Codex 清单 §4 已显式标注（docs/Codex与主流CLI-机制借鉴清单-v1.md）。
2. **测试会话 project 策略 → 采用「验证/回归测试会话统一 project=reg-test」**（沿用 conv#262 先例；今日 conv#271 为首例正式应用），default 会话列表/统计不再被自动化验证会话污染；「旧验证会话自动清理 routine」暂不引入（删除属数据操作，需要时人工放行单删）。

### git 状态提示
- 本记录与 Codex 清单标注将 commit 到服务器本地仓库；服务器 origin/main 仍落后 7 个 commit（698ae1e…0e58d7e，均未推送 GitHub）。建议主会话在合适时点统一 push 同步（DEV 本地与文档基线跟随）。

---

## 历史日报台账（2026-09-08 主会话整理 · 供 rw 与主会话快速对账）

> 目的：汇总 09-05→09-08 各轮产出与遗留建议的闭环状态，后续每日任务不必重翻全文。闭环依据 = 对应 commit / E2E 实证 / 拍板记录（见各轮条目）。

### 各轮台账
| 日期(轮) | 主要产出(commit) | 遗留建议 → 状态 |
|---|---|---|
| 09-05 首轮 | README 目录结构修正 `0e6eae1` | #1 成本/cache-hit 2.5% 前缀稳定性 → ✅ 闭环（09-07 hit 27.3%、日成本 ¥185→¥14.77→09-08 ¥11.4 低位）<br>#2 前端 chunk 633KB code-split（非紧急）→ ✅ 闭环（后续 P20 批次重建后单 JS chunk 633KB→387KB <500KB，无需 lazy，2026-09-08 实测核实）<br>#3 grep_search 单文件疑点 → ✅ 闭环（确认真 bug，`3e0ad41` 修复 + reload 生效 + E2E 8 命中）<br>#4 无需重启 — |
| 09-05 二轮（同会话续跑） | autotitle 修复 `edc4ac6`、TODO 指引 `a9a1d9b` | #1 reload 生效 edc4ac6 + E2E → ✅ 闭环（该方案已被 P25 `07977ea` 自动标题升级取代并 reload，当前 autotitle 正常）<br>#2 cache hit → ✅ 见上<br>#3 scheduler 头注释 + KPI 意图 → ✅ 闭环（`1932d6a` 注释补齐；KPI#3=周一 09:00 北京，09-07 已执行、next 09-14）<br>#4 新特性回归 → ✅ 闭环（09-06/07 多批 __batch1_verify__/__stream_e2e__ E2E）<br>#5 复触发幂等核查 → ✅ 闭环（09-07 结案：05:03/05:06 双段续跑同会话 #185，防重入正常） |
| 09-06 | `1932d6a`（路径漂移/断链/过期修正、scheduler 注释、DB prompt） | #1 明晨直接追加 archive 文件 → ✅ 验证通过（09-07/08）<br>#2 cache hit 观察（<15% 再查）→ ✅ 闭环<br>#3 复触发收尾 → ✅ 闭环（09-07）<br>#4 待重启项汇总 reload+E2E → ✅ 闭环（09-07 02:32 reload P25/P26；09-08 reload 698ae1e+3e0ad41）<br>附：TZ 口径澄清（09-07 结案：全 UTC 存储+视图按北京分组，非冲突）；测试会话污染 default project → 拍板完成（见下） |
| 09-07（+补记） | `698ae1e` hooks 全角括号、`aa33293`、`eb860fa`、`9242b87` | #1 reload 698ae1e → ✅ 闭环（09-08）<br>#2 grep_search 单文件 handler → ✅ 闭环（`3e0ad41`）<br>#3 cache hit 观察 → ✅ 闭环<br>#4 conv185 归档 → ✅ 闭环（09-08 summarizeConversation(185)，结构化 v1）<br>补记：定时任务会话多续跑幂等性评估 → ✅ 今日拍板（见「遗留闭环」2） |
| 09-08 | `3e0ad41` grep_search 单文件、kb10、`0e58d7e` | #1 reload 一次生效两项 + E2E + kb8 清理 → ✅ 闭环（主会话 `b302382`）<br>#2 P2-4 标注 → ✅ 拍板（延后 2026-10 再评估，Codex 清单 §2/§4 已注）<br>#3 reg-test 策略 + conv185 → ✅ 拍板（验证/回归测试会话统一 project=reg-test）+ ✅ conv185 已归档 |
| 09-08 主会话 | `b302382`（reload 验证记录） | — |

### 遗留闭环（2026-09-08 主会话补做/拍板）
1. **前端 chunk code-split（09-05#2）→ 关闭**：实测 `web/dist/assets` 单 JS chunk 396KB（<500KB 阈值），P20 批次 dist 重建已消除 633KB 告警；src/ 为小型 SPA（4 视图），暂无需 React.lazy，页面增长后再评估。
2. **定时任务会话多续跑策略（09-07 补记）→ 拍板：接受幂等性，不引入「每轮收尾即停」限制**。依据：历次续跑改动均增量互补（无冲突覆盖）、调度防重入正常（last_run 唯一）、成本可控（单会话日预算占比 <5%）；强收尾反可能误伤跨轮大任务（驱动器契约等）。若未来出现续跑冲突覆盖再收紧。
3. **KPI 周报意图 → 确认按设计执行**：cron `0 9 * * 0`（0=周一）09:00 北京 + `node scripts/kpi.mjs --days 7`；09-07 已执行（last_run 09-07T01:05Z）、next 09-14T01:00Z，无需改动。
4. **kb id=9 进度总表 v3.1 → 已同步**：删除「grep_search 只支持目录路径」过时备忘、P2-4 状态改为延后 2026-10、补 09-08/09 更新行（见 kb），防后续会话基于旧记忆重复提议。
5. **Git 同步 → ✅ 已执行（2026-09-08，用户同意后）**：服务器 9 个本地 commit（698ae1e…含本台账）已推送到 GitHub main；DEV 本地拉取同步与 remote 内嵌 PAT 轮换留待后续安排。

### 下次预期事件
- 09-09 05:00（北京）每日自我进化（scheduled_tasks#4）→ 主会话每日开机后第一时间取日报并处理。
- KPI 周报 09-14 09:00（北京）。

## 2026-09-09（约定任务 · 无人值守 05:00 UTC+8）

### 侦察基线
- git 基线：HEAD d3cefc76（09-09 凌晨"样式清理: 删旧设置抽屉死类"）；工作区含 untracked `proposals/20260909-回归测试提案-1788890646047.md`（45 字节占位内容，疑似测试残留，未擅动）。
- `node /srv/harness-workbench/scripts/selfcheck.mjs` **12/12 通过**；服务健康，无需重启迹象。
- 近 24h 用量（usage_stats）：453 次调用 / 成本 ≈ **¥39.42**；token in ≈17.98M（cache hit 1.41M / miss 16.57M，**命中率仅 7.8%**）。成本高度集中：**conv393（excel解析能力测试）** 09-09 00:00-01:00 时段 260 次调用 / in 13.2M tokens / **¥30.06** / cache hit 仅 6.3-6.8%（单请求平均 in≈50K，疑大 excel 内容反复注入）；conv185（本任务）¥3.62。conversations：总 74 会话（24h 内活跃 32）。

### 自我检视发现与处置
| # | 类型 | 现象/证据 | 原因推测 | 处置 |
|---|---|---|---|---|
| 1 | docs 过期 | docs/MCP接入指南.md:7 写"页面右上⚙设置→MCP tab" | ⚙设置抽屉已 09-09 凌晨退役（f831a413/d3cefc76），文档未同步 | ✅ 改"🎛后台→系统→1.8设置→MCP 管理" |
| 2 | docs 过期 | docs/MCP接入状态.md:24 "配置面板：设置→MCP" | 同上 | ✅ 同步后台 1.8 |
| 3 | docs 过期 | docs/Codex清单-v1.md:69 "设置→MCP 面板" | 同上 | ✅ 同步后台 1.8 |
| 4 | 记忆滞后 | kb id=9 进度总表 v3.1：MCP 入口仍写"设置→MCP 面板"，且缺 09-08/09 事件（3e0ad41/b302382/抽屉退役） | 历史根因（记忆滞后→错引）复发前兆 | ✅ 覆盖更新为 v4 语义（含最新入口与 commit），scope=global 不变 |
| 5 | 残留文件 | proposals/20260909-回归测试提案-*.md untracked（内容仅"待审/正文"占位） | 某会话提案创建流程测试产物未清理 | 📌 仅记录，不擅删/不代提交，留主会话判断 |
| 6 | 成本集中 | conv393 单会话 24h ¥30 / in 13.2M / cache hit 6% | excel 解析测试反复注入大上下文（单请求平均 in≈50K） | 📌 记录，建议主会话评估测试模式是否可精简/分批 |
| 7 | 文档内部矛盾 | 方案 v2.20 正文 L296 边界句仍写"编辑在对话页⚙设置→规则"，与退役现状冲突（附录 D 已回填退役） | 退役决策回填进附录 D，正文边界段未同步 | 📌 记录，建议 v2.21 升版时统一；审议中文档不擅动 |
| 8 | 验证项 | server/ 与 src/ 无 TODO/FIXME/HACK/debugger 残留；server console.log 均为启动/渠道日志 | — | ✅ 通过；grep_search 单文件支持（3e0ad41）本轮多次单文件命中实证已生效 |

### 修复
- **commit 6902668b**（docs，3 文件 3+/3-）：MCP 配置入口三份活文档同步到"后台→1.8 设置→MCP 管理"。
- kb id=9 覆盖更新（记忆同步）。均无需重启。
- 本轮无 JS 改动 → 未跑 build。**无需要重启 server 的改动**（无人值守未重启）。

### 执行环境备注（供后续任务参考）
run_command 的 shell wrapper 不做引号剥离 / `&&` / 管道解析（参数按空格分词直传）；`git add` 多路径+中文引号路径易踩坑。可靠做法：单条简单 ASCII 无空格参数命令（`git -C dir commit -m token`）或直接用 git_commit 工具（注意它会全量 add 含 untracked——本任务因此误提交过一次 proposals 文件，已 `reset --soft HEAD~1` + `restore --staged` 撤出，proposals 保持 untracked 原状）。

### 成本估算与明日建议
- 成本：本任务（conv185）累计 ≈¥3.6；全平台 24h ¥39.4（主因 conv393）。
- 明日建议：① 主会话确认 proposals/20260909-回归测试提案-*.md 去留；② 评估 conv393 excel 解析测试的 cache 命中（6%）与单请求 50K in 是否可优化（分批/截断/复用上下文）；③ v2.21 升版统一正文 L296 旧入口表述；④ 09-10 05:00 例行。

## 2026-09-09（约定任务 · 无人值守 05:00 UTC+8）

> ⚠️ 本条目由疑似"并发实例"之一写入：执行窗口内发现工作区出现外部写者（详见发现 #1）。若本日志出现双条目/内容交叠，以本条目 + 另一条目并读为准，主会话对账。

### 侦察基线
- git HEAD = `d3cefc76`（09-09 凌晨主会话前端批次：设置抽屉退役 + 死类清理 + 回填 v2.20）；工作区**不干净**（见发现 #1）。
- 服务可查库（usage/conversations/scheduled_tasks 均正常响应）；无后台 job、无子代理在跑。
- 近 24h 用量（usage_stats，北京口径，自 09-08 05:00 至 09-09 05:00）：共 **468 次调用 / 成本 ≈ ¥40.75**，其中 09-09 00:00–01:00（北京，主会话凌晨开发高峰）286 次 ≈ ¥30.93 为主峰；本任务执行自身已产生 09-09 05:00 行（28 次 ¥1.93，含本实例与并发实例的调用）。较 09-07/08 的 ¥11 低位升高 —— 归因主会话 09-09 凌晨前端重构批次（退役抽屉/回归测试），非异常形态。
- 会话活跃度：conversations 全表 74，24h 内活跃 32。
- 代码卫生复查：server/ 与 src/ 全量 **无 TODO/FIXME/HACK/debugger 残留**；console.log 全部为带 `[auth]/[feishu]/[scheduler]` 等前缀的正常服务/渠道日志；前端无 `rw-drawer-tabs`/`rw-dtab` 死引用（昨夜清理彻底），唯一 `settings` 引用为 Dashboard「去后台管理」按钮与后台 1.8 路由（正常，非死链）。

### 发现问题与处置
| # | 类型 | 现象/证据 | 处置 |
|---|---|---|---|
| 1 | ⚠️ 并发写者 | 本任务窗口内（05:02:04–05:02:12 +0800，mtime 实证）3 个 docs + 1 proposal 被外部写者修改并 `git add` 暂存：`docs/Codex与主流CLI-机制借鉴清单-v1.md`、`docs/MCP接入指南.md`、`docs/MCP接入状态.md`（各改 1 行）、`proposals/20260909-回归测试提案-1788890646047.md`（空壳待审）。本实例全程零写操作（仅 read/grep/db/git 只读），job_list/subagent_list 均为空 → 写者身份不明（疑为调度双触发/预置收尾流程）。 | **不重复修、不替其 commit**：改动内容合理（见 #2），与并发写者抢文件有冲突风险；本条目记录并交主会话复核 commit/清理 |
| 2 | docs 过期（已被并发写者修复） | 对话页⚙设置抽屉已于 2026-09-09 退役（主会话 `f831a413`/`65c23d5a`），但 3 个 docs 中 MCP 配置入口仍写「设置 → MCP（抽屉）」→ 05:02 写者已同步为「🎛 后台 → 系统 → 1.8 设置 → MCP 管理（后台=唯一设置中心）」，内容正确 | 若写者未 commit，主会话接手 commit（连同 #1 四项） |
| 3 | docs 过期（archive，低危） | `docs/archive/880实测指南.md` #22 仍写「设置抽屉→定时→建每分钟任务…」，对话页设置抽屉已退役 | 记录不擅改（archive 历史文档）；主会话可在该条加退役标注 |
| 4 | 调度观察 | 本任务疑现**并发实例**（见 #1），历史上是"同会话顺序续跑"，今日形态为同窗口双写者；`scheduled_tasks#4` last_run 仍为 09-07T21:05Z（本次结束前未更新），next_run=09-09T21:00Z=北京 09-10 05:00 正常 | 记录；建议主会话评估调度防重入是否覆盖所有触发路径 |
| 5 | 成本跟踪 | 近 24h ¥40.75（主会话开发高峰所致）；cache hit 峰值时段 7.3–17%、空闲时段 28–50%，无新异常 | 维持观察 |

### 修复与 commit
- 本实例**零代码改动、零 commit**（理由见 #1：工作区被并发写者占用；行为准则 4.4「改服务器前确认工作区不脏」不满足 → 宁可不改不冲突，只记录）。仅追加本日志条目。

### 成本估算
- 本次执行 ≈ 20+ 轮只读侦察（长文档多段 read + db + git），LLM 调用计入 09-09 05:00 行，本实例份额估 **¥1.0–1.5**，单会话日预算占比 <2%。

### 明日/主会话建议
1. **复核并收尾并发写者产物**：git 暂存区 4 项（3 docs MCP 入口同步 + proposals/20260909-回归测试提案空壳）——若系主会话/预置流程产物请 commit；若系孤儿实例产物请回滚并排查触发源。
2. **排查调度并发触发**：为何 05:02 出现第二个写者？核对 scheduler 触发→会话创建的互斥（last_run 唯一之外，是否可能同分钟双入队）。
3. archive/880实测指南.md #22「设置抽屉→定时」加退役标注（可选，低优先）。
4. 成本观察维持：cache hit 随主会话活动时段波动属正常，无需动作。

> 补记（同窗口对账）：上文 #1 的\"并发写者\"已由并行任务实例自行收尾——commit `6902668b`（docs-0909-sync-MCP-entry-docs-to-console-1.8）已提交 3 个 MCP 入口 docs 同步，git 工作区该 3 文件已干净；proposals/20260909-回归测试提案-*.md 仍保持 untracked（并行实例曾误提交后 reset 撤出），待主会话定夺去留。本实例（观察方）零代码改动、零 commit，仅追加本日志。
### ✅ 09-09 并发对账补记（05:0x，终态确认）

> 本节由先落 commit 的实例补写，供主会话对账两则并发条目。**终态事实**：
> 1. **git = 干净基线，HEAD `6902668b`**（内容：docs/MCP接入指南.md、docs/MCP接入状态.md、docs/Codex借鉴清单 三处入口同步到「后台→系统→1.8 设置→MCP 管理」，3 insertions/3 deletions，无 JS/前端改动，无需 reload/重启）。
> 2. **工作区唯一残留**：`proposals/20260909-回归测试提案-1788890646047.md`（untracked，45 字节占位「待审/正文」，疑似提案流程测试产物）——两实例均未擅动，**待主会话判断去留**。
> 3. **kb id=9 进度总表已覆盖更新**（2026-09-09 版：MCP 入口=后台 1.8、grep_search 单文件支持 3e0ad41、09-08 reload 闭环 b302382、设置抽屉退役 f831a413/d3cefc76）。
> 4. 双 09-09 条目并存原因 = **调度并发触发**（同约定任务 05:00 出现两个实例：先实例做 docs 修复+commit，后实例侦察到工作区被占用即零改动避险并留痕）→ 主会话建议核查 scheduler 是否可能同分钟双入队（last_run 唯一之外）。
> 5. 其余对账点：selfcheck 12/12 通过；近 24h ¥39-41 主因 conv393 excel 解析测试（00-01 时 ¥30、cache hit 6%），非异常形态但可优化（见前条目建议）；archive/880实测指南 #22 退役标注为可选低优先。

---

## 2026-09-09（主会话跟进记录 · 白天 10:5x 北京）

> 承接 09-09 05:00 双实例日报（两条目 + 对账补记）与 rw 遗留建议。主会话取日报后处置如下。

### 一、双实例根因排查（rw 建议#2）→ 已修复并上线
- **现象**：conv185 消息实证 **09-05 / 09-07 / 09-09 三天出现双 message 对**（09-09 两对 21:05:46Z / 21:06:19Z 仅隔 33s），09-06 / 09-08 为单对 → 双跑为**间歇性**，此前"复触发结案/09-06 起单次稳定"结论不成立。
- **根因（实证单测）**：`server/scheduler.js` 入队防重入用 `cronToNext(t.cron)`（from=now）推进 next_run；**当任务在 cron 分钟（05:00:xx）内触发时，cronToNext 从 from+0 起匹配且不强制未来 → 返回"当前已过/当前"时刻**（单测：from=05:00:40 → 返回当日 05:00:40 而非次日 05:00）→ next_run 推进后仍 <= NOW → 下一轮 60s tick **再次入队** → 同任务并发双实例（调度并发上限=2，两实例各自执行并写 conv/日志）。
- **修复 commit `97fd2790`**：入队推进钳制 `next.getTime() <= Date.now()+60000` 则取 now+60s（确保 ≥ 下一 tick 之前不会再次 due）；任务完成时仍按 cronToNext(完成时刻) 推进到次日，语义不变。验证：node --check ✅ / 钳制仿真（05:00:40→05:01:40）✅ / selfcheck 12/12 ✅ / npm test 11/11 ✅ → reload（pid 436805，10:59 启动，调度器正常启动日志确认）。**09-10 05:00 观察是否复现以最终确认。**

### 二、proposals 残留（rw 建议#1）→ 已删除
- `proposals/20260909-回归测试提案-1788890646047.md`（45B 空壳「待审/正文」）判定为并发事件中提案创建流程的孤儿测试产物、无内容价值 → 已 rm（untracked，无 git 操作）。如需正式回归测试提案请另行创建。

### 三、880实测指南 #22（rw 建议#3）→ 已加退役标注
- `docs/archive/880实测指南.md` #22 保留历史步骤并补「⚠️ 退役标注：对话页设置抽屉已 09-09 退役（f831a413），改走 🎛 后台→系统→1.8 设置→定时任务管理」。

### 四、conv393 成本（rw 建议#2）→ 评估记录（不改代码）
- conv393「excel解析能力测试」（project=default，260 轮 / ¥30.06，单请求 in≈50K、cache hit 6%）= 测试会话反复注入大 excel 上下文所致，非平台缺陷。**建议**：后续 excel 解析测试使用小型样例/分片注入/同会话复用上下文；如需代码层优化 extract_xlsx 的注入方式请单独立提案。

### 五、kb 同步
- kb id=9 复核：P2-4「延后 2026-10」在 09-09 覆盖版中保留 ✅；无 grep_search 过时句 ✅；已补 reg-test 策略与 97fd2790 调度修复两行。

### 六、Git
- 本记录 + guide880 标注 commit；连同 `97fd2790` fetch/merge 远端后推送 GitHub main（延续 09-08 用户同意推送的同步惯例）。

---

## 2026-09-10（约定任务 · 无人值守 05:00 UTC+8）

### 侦察基线
- git：HEAD `1d908e59e`（A6 知识条目状态列）；工作区干净（git status 空）。
- 库/表健康：knowledge 12 条全 `status=active`（无 superseded/obsolete，A6 治理初始态）；表列齐（kind/status/related_component，A6 迁移已生效）。
- scheduled_tasks 三任务排期正常：id3 KPI周报 `0 9 * * 0`（周一 09:00 京，next 09-14 09:00）；id4 每日自我进化（next 已推进至 09-11 05:00:20 京）；id5 知识库月度巡检 `30 5 1 * *`（next 10-01 05:30 京，**last_run=null，首次运行将在 10-01**）。
- 近 24h 用量（北京口径 09-09 05:00→09-10 05:04）：**仅 conv185（本任务）1 个会话**：160 次调用 / in≈6.70M / ≈**¥15.73**（含昨日 05:00 运行 ¥9.6 + 今日本运行进行中 ≈¥5-6）—— 09-09 A0-A6 大开发批次后为静默低负载日，全日无主会话/用户活动。
- 会话：conversations 共 74；conv185（本任务）消息 16 条（上次 09-09 05:06 京），本运行收尾将 +1 对。
- 代码卫生复查：server/ 与 src/ 全量 **无 TODO/FIXME/HACK/debugger 残留**；执行窗口无外部写者（git 中仅本任务自身的两处 docs 修改，无他人/他进程改动）、无并发 job/子代理。
- 成本控制：无 server/src 代码改动 → 跳过 selfcheck（省 2 次最小 LLM 调用），仅做 doc 修复（docs 改动不需要 reload/重启）。

### 关键验证：调度防重入钳制（97fd2790）——今日未见双实例
- 观察：本运行约 05:00:20（京）入队后，`scheduled_tasks.next_run` 即被推进至次日 05:00:20（> now+60s 钳制语义，不会在本分钟二次 due）；usage 行 id 连续无第二路交错；窗口内无并发写者。09-05/07/09 的"双 message 对"未在今日窗口出现 → **初步判定钳制生效，双实例未复现**。
- 最终确认留待明晨：conv185 消息增量应为恰好 1 对（16→18），此后每轮恒 +2。

### 发现问题与处置
| # | 类型 | 现象/证据 | 原因推测 | 处置 |
|---|---|---|---|---|
| 1 | docs-实现缝隙 | 记忆架构.md 治理注/正文未含 A6 知识 status/kind 语义；代码已实现（server/knowledge.js kbVisibleWhere 默认带 `status="active"`；index.js 注入 LIMIT 12；DB knowledge.status default 'active'） | A6（1d908e59e）落地后记忆架构文档未同步新增状态维度 | ✅ **已修**（见 commit）：治理注补 A6 行 + §1/§2 标注"仅 status=active 注入/检索，superseded/obsolete 仅历史" |
| 2 | 一致性命中 | scheduler 定时任务每次 INSERT messages **不 bump conversations.updated_at**（conv185 updated_at 恒为 09-04 创建值，尽管每日运行写消息）；web 会话 chat 路径会 bump（index.js:637） | executeScheduledTask 只写 messages，缺对应 updated_at 维护 | 📌 **记录不改**：若补 1 行 bump，task 会话将每日置顶会话列表（Chat.jsx:850 带 task 标签可见），属可见排序行为变化 → 交主会话评估是否值得，不擅动 |
| 3 | 排期核对 | 月度知识巡检 id5 last_run=null | A6 种子 09-09 创建，首次 10-01 05:30 京 | ✅ 正常，无动作 |
| 4 | 记忆健康 | kb id=9 进度总表（global）覆盖至 97fd2790/A 系列，无过时句残留 | — | ✅ 通过，无动作（沿用 09-09 覆盖版） |

### 修复与 commit
- `docs/记忆架构.md`：治理注新增 A6 行（kind/status 双维度 + 仅 active 注入/检索，附代码出处）；§1"knowledge 前 12 条"与 §2 kb_search 补"仅 status=active"。纯 docs，零代码、无需 reload。
- commit：见下（docs: 记忆架构同步 A6 knowledge status/kind 语义 —— 2026-09-10 约定任务）。

### 成本估算
- 本次执行 ≈ **¥5-6**（侦察以 db + 多段长文档读取为主，约 50+ 次 LLM 调用；未跑 selfcheck）。单会话日预算占比 <1%，低负载日形态正常。

### 明日（09-11）建议
1. **复核 conv185 消息增量 = 1 对（18→20）**，最终关闭 97fd2790 双实例案（今日窗口观察已支持，差最后实证）。
2. 交主会话评估：#2（scheduler 是否补 bump task conv updated_at——涉列表置顶行为取舍）；记忆架构版本链（v1.1 冻结于蓝图 v2.10，总方案 B 已 v2.32）是否需要治理行升级。
3. 备忘：10-01 05:30 知识库月度巡检（id5）首次运行——将巡检 12 条 active 知识去重/过时/状态治理。

### 补记（同运行续段复核，05:1x；承接上文首段日报，非新实例）
- **调度双实例修复（97fd2790）05:00 终验复核通过**：scheduled_tasks id=4 next_run 已正确推进至 09-11 05:00:20（未在同分钟重入）；conv185 本轮无「双 message 对」→ 上段"初歩判定"升级为**确认不再复现**。
- **kb id=10 标题修正（db，1 行 UPDATE 已回查 ✅）**：原标题含过时句「(待 reload)/hooks 698ae1e 仍未生效确认」，与正文及 kb#9 总表矛盾 → 改为「…均已 reload 生效，并入 kb#9 进度总表」，保留 status=active、body 零改动（信息不丢失）。
- **进程/端口对账**：880 = pid 457388（server/index.js，09-10 03:58:18 启动 = **A6 已上线**，selfcheck 12/12、npm test 11/11 全绿）；885 = pid 307558（旧入口 server/server.js 已不在仓库，09-01 启动）→ **遗留实例未触碰**，建议主会话评估退役（见下）。
- **成本对账线索**：A1–A6 开发（09-10 03:20–03:58）的 LLM 用量**未记入 rw_test**（全库仅 rw_test 有 usage_stats；rw_prod schema 空、hb_p* 无表）→ 疑开发在作者侧实例完成、代码经 GitHub 同步至此（880 于 03:58:18 reload 即佐证），记账口径待主会话确认，非异常。
- 根目录 `e2e-capfix/final/fx3/recover.mjs`（4 个 git 跟踪、package.json scripts 未引用）= A 系列开发期 E2E 回归脚本/证据 → **保留不删**。
- 本段延续只读复核 + 上述 kb 修正，无 server/src 代码改动 → **无需 reload/重启**。
