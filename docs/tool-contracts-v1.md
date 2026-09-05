# 附录D · 工具契约施工图 v1（WS1 实施图纸 · 撑竿跳方案 1.0）

> 依据：docs/archive/RW撑竿跳方案-执行史-v1.0.md §1 WS1 + §1.5 X1（已归档；决策已并入蓝图 C 域）· Anthropic《Seeing like an agent》：工具是 agent 的眼与手。
> 范围：61 个现存工具（实测 server/tools/index.js TOOLS）+ conv_summarize（WS5 新增）= **62**。
> 每工具字段：tier（core/pro/expert）· when（何时用=它给 agent 什么信息/能力）· not（何时不用+替代）· ex（真实示例）· 备注（参数 schema 建议 enum/items/min/max、门禁、实施注意）。
> 每条过 X1 三问：①这工具是"眼"还是"手"？②描述是否让 agent 在正确时刻选它？③参数能否表达意图（enum/items/长度上限）？
> 交付标准：toolDefs() 描述=description+`何时用:… 勿用:… 例:…`；参数按备注补 enum/items；计数 62 与附录B 同步。

## 一、core（21）——minimal/standard/all 均暴露

| 工具 | when | not | ex | 备注 |
|---|---|---|---|---|
| read_file | 读文本内容、改前先读、查实现 | 大文件超 50KB 用 read_file_range；列目录用 list_dir | `read_file {path:"/srv/harness-workbench/server/agent.js"}` | max 50KB（已有） |
| read_file_range | 大文件按 offset/length 分段读 | 小文件直接 read_file | `read_file_range {path, offset:10000, length:5000}` | — |
| write_file | 新建文件、整体覆盖 | 局部小改用 edit_file；追加用 append_file | `write_file {path, content}` | 会覆盖，先确认 |
| append_file | 末尾追加（日志/渐进内容） | 覆盖/创建用 write_file | `append_file {path, content}` | — |
| edit_file | 精确局部替换（old 必须唯一匹配） | 未读文件不要盲改；大段重写用 write_file | `edit_file {path, old, new}` | 改前先 read_file |
| list_dir | 列目录、确认存在、看结构 | 递归找文件用 find_file；看内容用 read_file | `list_dir {path}` | 默认工作区 |
| mkdir | 建目录 | 文件用 write_file | `mkdir {path}` | — |
| copy_move | 复制/移动文件或目录 | 删除用 delete_file(expert) | `copy_move {src, dst, mode:"copy"}` | mode 加 enum: copy\|move |
| find_file | 按文件名子串定位（不用通配） | 搜内容用 grep_search | `find_file {name:"agent.js"}` | 跳 node_modules/.git（已有） |
| grep_search | 按正则搜文件内容（限代码/文本扩展名） | 按文件名用 find_file；查库用 db_query | `grep_search {pattern:"ensureRun", path}` | — |
| web_search | 查新知识/外部事实/时效信息 | 内部内容用 grep_search/db_query | `web_search {queries:["deepseek v4"]}` | 附来源链接 |
| fetch_url | 抓指定网页正文 | 搜索用 web_search | `fetch_url {url}` | — |
| syntax_check | JS 语法校验，改代码后必跑 | 跑测试用 run_test | `syntax_check {path}` | 服务器与本地同用 |
| run_test | 跑项目测试套件 | 单文件语法用 syntax_check | `run_test {dir}` | 写权限限定工作区 |
| plan_tasks | 多步复杂任务先列清单（>3 步） | 单步小任务直接做 | `plan_tasks {text:"…"}` | 与 plan_done 配套 |
| plan_done | 完成一步勾掉 | 全完成后再 finish_task | `plan_done {index}` | 编号从 1 |
| finish_task | 提测：对照验收自检后提交"完成候选" | 未完成/未验证禁止调用 | `finish_task {summary, selfCheck}` | 驱动器跑验收钩子 |
| ask_user | 需要用户拍板/二选一时 | 可自行查证的事实别问 | `ask_user {question, options}` | 结构化选项 |
| set_goal | 用户要持续推进的大目标（跨轮） | 一次性任务不用 | `set_goal {objective}` | 与 update/get_goal 配套 |
| get_goal | 查看当前活动目标与进度 | — | `get_goal {}` | — |
| update_goal | 汇报进展/标记完成/放弃 | — | `update_goal {progress, status}` | — |

## 二、pro（32 = 31 现存 + conv_summarize）——standard/all 暴露

| 工具 | when | not | ex | 备注 |
|---|---|---|---|---|
| ocr_image | 图片含文字需提取（截图/扫描件） | 普通图片理解用 view_image | `ocr_image {path}` | 走视觉模型 |
| view_image | 视觉理解图片内容 | 纯文字提取用 ocr_image/read 系 | `view_image {path}` | 可自动路由 |
| extract_pdf/docx/xlsx/pptx | 解析对应文档类型文本 | 普通 txt 用 read_file | `extract_pdf {path}` | 各限 20KB 文本 |
| db_query | 只读查询（SELECT；用量/会话/工具统计/信息_schema） | 写库用 db_write(expert)；文件内容用 grep | `db_query {sql:"SELECT tool_name,COUNT(*) FROM tool_calls GROUP BY 1 ORDER BY 2 DESC LIMIT 10"}` | 仅允许 SELECT（已有） |
| git_status | 提交前看工作区状态 | 看历史用 run_command git log | `git_status {dir}` | — |
| git_commit | 小步提交（自改纪律要求先 commit） | 未验证的代码不要提交 | `git_commit {dir, message}` | 每次自改前先提交当前状态 |
| git_branch | 分支 list/create/checkout | 推送用 git_pull_push(expert) | `git_branch {action:"create", branch}` | action 加 enum |
| run_long_task | 长命令后台执行不阻塞 | 短命令/需交互用 run_command | `run_long_task {command}` | 超时/轮次内管理 |
| job_list | 列出后台任务状态 | — | `job_list {}` | — |
| job_output | 读后台任务输出 | 已完成结果在最终回答里 | `job_output {jobId}` | 最近 8000 字符 |
| subagent | 委派独立子任务（隔离上下文） | 简单查询自己做；批量用 fanout | `subagent {prompt, mode:"sync"}` | 3 层嵌套上限已有 |
| subagent_fork | 让子代理延续本会话上下文深挖 | 全新任务用 subagent | `subagent_fork {prompt}` | — |
| subagent_fanout | 同模板批量派发（{{item}}） | 条目 <3 时直接逐个做 | `subagent_fanout {items, prompt}` | — |
| subagent_join | 收口多个异步子代理 | 单个结果用 subagent_output | `subagent_join {ids}` | — |
| subagent_output | 取异步子代理结果 | 未完成就继续等/join | `subagent_output {id}` | — |
| subagent_report | 复盘/审计取子代理全步骤 | 取结论用 output | `subagent_report {id}` | — |
| subagent_list | 查看全部子代理状态 | — | `subagent_list {}` | — |
| kb_add | 沉淀"记住/以后都按…"（global/conv） | 复盘条目标题带"打回复盘:"（KPI3） | `kb_add {title, body, scope:"global"}` | 标题≤200 字 |
| kb_search | 找记忆/历史决策/偏好（先搜再用） | 新知识直接问用户 | `kb_search {q}` | — |
| kb_del | 删除错误/过期记忆 | — | `kb_del {id}` | — |
| create_contract | 立项：验收先成文、驱动器无人值守执行 | 小任务/讨论中不用 | `create_contract {goal, acceptance, boundaries}` | acceptance 用 WS9 DSL |
| skills_list | 用户提"技能/方法"先查 | 已确定技能直接 skill_load | `skills_list {}` | — |
| skill_load | 载入技能（会话级注入） | 长期全局约定用 kb_add | `skill_load {name}` | — |
| skill_save | 新建/更新技能（复盘结论固化） | 一次性经验用 kb_add | `skill_save {name, description, body}` | 落 SKILL.md |
| ralph | 目标难题多轮全新视角逼近 | 常规任务别用（成本高） | `ralph {objective}` | 预算敏感 |
| conv_summarize | 长会话收尾/跨周 resume 前归档摘要 | 短会话不需要 | `conv_summarize {}` | 写 conv_summaries；WS5 新增 |
| feishu_doc_read | 读飞书文档/知识库 | 非飞书内容用 fetch_url | `feishu_doc_read {url}` | — |
| feishu_sheet_read | 读飞书表格 | — | `feishu_sheet_read {url, range}` | — |
| feishu_bitable_read | 读飞书多维表格 | — | `feishu_bitable_read {appToken, tableId}` | — |

## 三、expert（9）——仅 all 暴露；standard/minimal 调用 → 指引错误

| 工具 | when | not | ex | 备注 |
|---|---|---|---|---|
| delete_file | 删除文件/目录（确认过、留痕） | 移走用 copy_move | `delete_file {path}` | 高危；GUARDED（已有） |
| db_write | 库写入/迁移（非 SELECT） | 读用 db_query；先 SELECT 复核影响面 | `db_write {sql, params}` | 高危；GUARDED；仅 SELECT 外的 DML/DDL |
| run_command | 无专门工具覆盖的系统操作（npm/部署/systemctl/git log） | cat/ls/grep/sed/head/tail/find/cd 用专门工具 | `run_command {command:"npm install"}` | 软门禁：preset≠all 拦白名单首词（WS1d） |
| kill_process | 终止失控/废弃任务 | 正常退出等 job 结束 | `kill_process {jobId}` | GUARDED |
| git_pull_push | 拉取/推送远程 | 提交用 git_commit | `git_pull_push {dir, action:"push"}` | GUARDED；push 前先 pull 防分叉 |
| reload_platform | 自改代码生效（先 syntax_check+commit） | 仅改配置/数据不需要 | `reload_platform {}` | 回复结束后 3-4s 重启（已有） |
| set_limits | 用户要求调护栏（0=不限） | 不要未经请求自行放宽 | `set_limits {minutes, rounds, loop, parallel}` | 护栏=保险丝可调可关（WS2 哲学）；走 WS4 validate |
| plan_mode | 用户要求先规划只读 | 普通任务不要进入 | `plan_mode {}` | 写类工具全拒（已有） |
| exit_plan_mode | 提交计划并退出只读 | 未查证完不要提交 | `exit_plan_mode {plan}` | 计划全文作为回答展示 |

## 四、实施检查清单（批2b 用）
1. toolDefs() 描述拼接：`description + ' 何时用:…；勿用:…；例:…'`（when/not/ex 存于 TOOLS 条目，description 保留原句防破坏性变更）。
2. 参数透传白名单：`enum/items/min/max/desc`；params 默认 `required:false`，显式 required 才入 required 数组（保持现状兼容）。
3. tier 过滤：`toolDefs(expose)`——expose=all 返回全部（零回归）；standard=core+pro；minimal=core。execTool 不拦（防回归），隐藏工具被调用 → 指引错误。
4. enum 落地首批：copy_move.mode(copy|move)、git_branch.action(list|create|checkout)、kb_add.scope(global|conv)、subagent.mode(sync|async)。
5. 计数核对：62 = core21+pro32+expert9；附录B 同步。
6. 回归闸门：改完 syntax_check → reload_platform → selfcheck.mjs + 2 条代表任务（all 默认）行为不变 → 健康度榜对比无异常新失败。
7. conv_summarize 待 WS5 实施时注册（本批先预留 tier 位，不提前实现避免超批）。
