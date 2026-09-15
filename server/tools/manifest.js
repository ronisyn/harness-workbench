// server/tools/manifest.js - 工具能力清单（**唯一的声明式权威**）：改名/改档/改提示/上下线，只改这里
// 定位（架构 §4.1/§4.3 工具三层分离 + 声明式装载）：
//   · 契约面（name/description/params/permission）与实现**同处**在 tools/index.js 的处理器里——它们必须同步演进，拆开只会漂移；
//   · 本清单拥有**策略与生命周期**：档位(tier)/中文名/选择提示(when·not·ex)/默认启用(defaultOn)/平台豁免(exempt)/轻量集(light)/上下线(enabled)；
//   · 装载器 tools/registry.js 一次性装配并校验：清单与实现不一致**当场报错**，不再靠人记。
// 上下线一个工具（零代码改动）：
//   · 删掉这一行 → 工具从"模型可见面(toolDefs)"与"可执行面(execTool)"同时消失（默认拒绝）；
//   · 或写 enabled: false → 保留声明与理由，同样不装载（推荐：留痕式下线）。
// 字段缺省：tier 必填；when/not/ex 选填；defaultOn/exempt/light 缺省 false；enabled 缺省 true。

export const TOOL_MANIFEST = {
  // ===== core(25) =====
  append_file: { tier: 'core', cn: '追加内容', when: '文件末尾追加（日志/渐进内容）', not: '覆盖/创建用 write_file', ex: 'append_file {path, content}', defaultOn: true, light: true },
  ask_user: { tier: 'core', cn: '向你提问', when: '需要用户拍板/方案选择', not: '可自行查证的事实不要问', ex: 'ask_user {question, options}', defaultOn: true, light: true },
  copy_move: { tier: 'core', cn: '复制/移动', when: '复制或移动文件/目录', not: '删除用 delete_file', ex: 'copy_move {src, dst, mode:"copy"}', light: true },
  edit_file: { tier: 'core', cn: '修改文件', when: '精确局部替换（old 需与文件内容唯一匹配）', not: '未先 read_file 不要盲改；大段重写用 write_file', ex: 'edit_file {path, old, new}', defaultOn: true, light: true },
  fetch_spill: { tier: 'core', cn: '取回溢出结果', when: '上下文提示"全文已存 <路径>"时，按范围取回被溢出的工具结果全文', not: '读取类工具溢出的定位符是源文件路径，用 read_file_range 直接读', ex: 'fetch_spill {path:"/srv/rw-workspace/spill/12/db_query-x.txt", offset:0, length:20000}', exempt: true },
  fetch_url: { tier: 'core', cn: '抓取网页', when: '抓取指定网页正文', not: '找网页用 web_search', ex: 'fetch_url {url}', defaultOn: true, light: true },
  find_file: { tier: 'core', cn: '查找文件', when: '按文件名子串定位（免通配符）', not: '按内容搜索用 grep_search', ex: 'find_file {path, name:"agent.js"}', defaultOn: true, light: true },
  finish_task: { tier: 'core', cn: '任务提测', when: '提测：对照验收自检后提交"完成候选"', not: '未完成/未验证禁止调用', ex: 'finish_task {summary, selfCheck}', defaultOn: true, light: true },
  get_goal: { tier: 'core', cn: '查看目标', when: '查看当前活动目标与进度', not: '—', ex: 'get_goal {}' },
  grep_search: { tier: 'core', cn: '搜索内容', when: '按正则搜文件内容（代码/文本文件）', not: '按文件名用 find_file；查库用 db_query', ex: 'grep_search {path, pattern:"ensureRun"}', defaultOn: true, light: true },
  hooks_list: { tier: 'core', cn: '查看钩子', when: '查看已注册 hooks（工具被"已被 hook 拦截"时排查是哪个纪律钩子）', not: '清除/调整钩子属平台管理，模型侧只读', ex: 'hooks_list {}', defaultOn: true, exempt: true },
  list_dir: { tier: 'core', cn: '列出目录', when: '列目录看结构、确认路径存在', not: '递归找文件用 find_file', ex: 'list_dir {path}', defaultOn: true, light: true },
  mkdir: { tier: 'core', cn: '创建目录', when: '创建目录', not: '创建文件用 write_file', ex: 'mkdir {path}', light: true },
  plan_done: { tier: 'core', cn: '标记步骤', when: '标记清单第 N 步已完成（从 1 开始）', not: '全部完成后用 finish_task 提测', ex: 'plan_done {index:1}', defaultOn: true, light: true },
  plan_tasks: { tier: 'core', cn: '规划任务', when: '多步复杂任务先列清单（>3 步）', not: '单步小任务直接做', ex: 'plan_tasks {tasks:"步骤列表"}', defaultOn: true, light: true },
  read_file: { tier: 'core', cn: '读取文件', when: '读文本内容、改前先读、查实现细节', not: '大文件超限用 read_file_range；列目录用 list_dir', ex: 'read_file {path:"/srv/harness-workbench/server/agent.js"}', defaultOn: true, light: true },
  read_file_range: { tier: 'core', cn: '分段读取', when: '大文件按 offset/length 分段读', not: '小文件直接用 read_file', ex: 'read_file_range {path, offset:10000, length:5000}', light: true },
  repo_map: { tier: 'core', cn: '代码地图', when: '大仓库/陌生目录任务开始时先取结构地图（目录树+行数+imports+符号）', not: '小目录直接 list_dir；找符号位置用 grep_search', ex: 'repo_map {dir:"/srv/harness-workbench"}', defaultOn: true, light: true },
  run_test: { tier: 'core', cn: '运行测试', when: '运行项目测试套件', not: '单文件语法用 syntax_check', ex: 'run_test {dir}', defaultOn: true, light: true },
  set_goal: { tier: 'core', cn: '设定目标', when: '用户要求持续推进的跨轮大目标', not: '一次性任务用 plan_tasks', ex: 'set_goal {objective}', defaultOn: true },
  syntax_check: { tier: 'core', cn: '语法检查', when: 'JS 语法校验（改代码后必跑）', not: '跑测试套件用 run_test', ex: 'syntax_check {path}', defaultOn: true, light: true },
  undo_checkpoint: { tier: 'core', cn: '撤销快照', when: '改坏文件/代码时回滚自动快照（写类工具执行前系统已自动快照）', not: '正常小错用 edit_file 直接修', ex: 'undo_checkpoint {list:true} 或 {n:1}', defaultOn: true, exempt: true },
  update_goal: { tier: 'core', cn: '更新目标', when: '汇报目标进展/标记完成/放弃', not: '—', ex: 'update_goal {progress, status:"done"}' },
  web_search: { tier: 'core', cn: '联网搜索', when: '查外部新知/事实/时效信息', not: '查内部内容用 grep_search/db_query', ex: 'web_search {queries:["deepseek v4"]}', defaultOn: true, light: true },
  write_file: { tier: 'core', cn: '写入文件', when: '新建文件或整体覆盖', not: '局部小改用 edit_file；追加用 append_file', ex: 'write_file {path, content}', defaultOn: true, light: true },
  // ===== pro(33) =====
  conv_summarize: { tier: 'pro', cn: '归档会话', when: '长会话收尾/跨周 resume 前归档摘要（已注册）', not: '短会话不需要', ex: 'conv_summarize {}' },
  create_contract: { tier: 'pro', cn: '创建任务契约', when: '立项：验收先成文，驱动器无人值守执行', not: '小任务或讨论中不要用', ex: 'create_contract {goal, acceptance, boundaries}' },
  db_query: { tier: 'pro', cn: '查询数据库', when: '只读查库（单条 SELECT；用量/会话/工具统计）', not: '写库用 db_write；SHOW/多语句不支持；表列结构先查 information_schema，勿猜列名', ex: 'db_query {sql:"SELECT COUNT(*) FROM usage_stats"}', defaultOn: true, light: true },
  extract_docx: { tier: 'pro', cn: '解析Word', when: '解析 Word 文本', not: '文本文件用 read_file', ex: 'extract_docx {path}' },
  extract_pdf: { tier: 'pro', cn: '解析PDF', when: '解析 PDF 文本', not: '文本文件用 read_file', ex: 'extract_pdf {path}' },
  extract_pptx: { tier: 'pro', cn: '解析PPT', when: '解析 PPT 文本', not: '文本文件用 read_file', ex: 'extract_pptx {path}' },
  extract_xlsx: { tier: 'pro', cn: '解析Excel', when: '解析 Excel 内容', not: '文本文件用 read_file', ex: 'extract_xlsx {path}' },
  feishu_bitable_read: { tier: 'pro', cn: '读飞书多维表', when: '读飞书多维表格', not: '—', ex: 'feishu_bitable_read {appToken, tableId}' },
  feishu_doc_read: { tier: 'pro', cn: '读飞书文档', when: '读飞书云文档/知识库内容', not: '非飞书用 fetch_url', ex: 'feishu_doc_read {url}' },
  feishu_sheet_read: { tier: 'pro', cn: '读飞书表格', when: '读飞书电子表格', not: '—', ex: 'feishu_sheet_read {url, range}' },
  git_branch: { tier: 'pro', cn: 'Git分支', when: '分支 list/create/checkout', not: '推送用 git_pull_push', ex: 'git_branch {dir, action:"list"}' },
  git_commit: { tier: 'pro', cn: '提交Git', when: '小步提交（自改纪律：改前先提交当前状态）', not: '未验证代码不提交', ex: 'git_commit {dir, message}', defaultOn: true, light: true },
  git_status: { tier: 'pro', cn: '查看Git状态', when: '提交前查看工作区状态', not: '看提交历史用 run_command git log', ex: 'git_status {dir}', defaultOn: true, light: true },
  intake_submit: { tier: 'pro', cn: '提交开发需求', when: 'intake 技能（plugin/app/shell-dev-intake）采集齐 触发场景/期望效果/涉及壳/代码动作类型 后提交开发需求', not: '字段未齐/未载入对应 intake 技能（会被硬闸拦）；未审批不得自行开发', ex: 'intake_submit {assetType:"plugin", scene, effect, shells, actionType}', exempt: true },
  job_list: { tier: 'pro', cn: '后台任务列表', when: '列出后台任务状态', not: '—', ex: 'job_list {}' },
  job_output: { tier: 'pro', cn: '查看后台输出', when: '读后台任务输出（最近 8000 字符）', not: '已完成的结果在任务返回里', ex: 'job_output {jobId}' },
  kb_add: { tier: 'pro', cn: '写入知识', when: '沉淀"记住/以后都按…"（global 或本会话）', not: '复盘条目标题加"打回复盘:"前缀（度量）', ex: 'kb_add {title, body, scope:"global"}', defaultOn: true, light: true },
  kb_del: { tier: 'pro', cn: '删除知识', when: '删除错误/过期记忆', not: '—', ex: 'kb_del {id}' },
  kb_search: { tier: 'pro', cn: '搜索知识', when: '找记忆/历史决策/用户偏好（先搜再用）', not: '—', ex: 'kb_search {q}', defaultOn: true, light: true },
  ocr_image: { tier: 'pro', cn: 'OCR识图', when: '图片含文字需提取（截图/扫描件）', not: '图片理解用 view_image', ex: 'ocr_image {path}', light: true },
  ralph: { tier: 'pro', cn: '多轮全新视角', when: '难题多轮"全新视角"逼近（每轮无历史）', not: '常规任务别用（成本高）', ex: 'ralph {objective}' },
  run_long_task: { tier: 'pro', cn: '后台长任务', when: '长命令后台执行不阻塞', not: '短命令用 run_command', ex: 'run_long_task {command}' },
  skill_load: { tier: 'pro', cn: '载入技能', when: '载入技能（全文入系统提示，会话内持续生效）', not: '一次性约定用 kb_add', ex: 'skill_load {name}', defaultOn: true, light: true },
  skill_save: { tier: 'pro', cn: '保存技能', when: '新建/更新技能（复盘结论固化）', not: '零散经验用 kb_add', ex: 'skill_save {name, description, body}', defaultOn: true },
  skills_list: { tier: 'pro', cn: '技能列表', when: '用户提"技能/方法"时先查可用技能', not: '已确定直接 skill_load', ex: 'skills_list {}', light: true },
  subagent: { tier: 'pro', cn: '子代理执行', when: '委派独立子任务（隔离上下文）', not: '小查询自己做；批量用 subagent_fanout', ex: 'subagent {prompt, mode:"sync"}', defaultOn: true },
  subagent_fanout: { tier: 'pro', cn: '批量派发子代理', when: '同模板批量派发（{{item}} 占位）', not: '条目少时逐个做', ex: 'subagent_fanout {items, prompt}' },
  subagent_fork: { tier: 'pro', cn: '子代理续上下文', when: '子代理延续本会话上下文继续深挖', not: '全新任务用 subagent', ex: 'subagent_fork {prompt}' },
  subagent_join: { tier: 'pro', cn: '汇总子代理', when: '收口多个异步子代理结果', not: '单个结果用 subagent_output', ex: 'subagent_join {ids}' },
  subagent_list: { tier: 'pro', cn: '子代理列表', when: '查看全部子代理状态（编排/排查）', not: '—', ex: 'subagent_list {}' },
  subagent_output: { tier: 'pro', cn: '取子代理结果', when: '取异步子代理结果（running/done）', not: '未完成可稍候重试或 join', ex: 'subagent_output {id}' },
  subagent_report: { tier: 'pro', cn: '子代理复盘', when: '复盘/审计：取子代理全步骤明细', not: '只要结论用 subagent_output', ex: 'subagent_report {id}' },
  view_image: { tier: 'pro', cn: '看图', when: '视觉理解图片内容', not: '纯文字提取用 ocr_image', ex: 'view_image {path}', light: true },
  // ===== expert(7) =====
  db_write: { tier: 'expert', cn: '写入数据库', when: '数据库写入/迁移（非 SELECT）', not: '读用 db_query；写前先 SELECT 复核影响面', ex: 'db_write {sql, params}' },
  delete_file: { tier: 'expert', cn: '删除文件', when: '删除文件/目录（确认过；高危留痕）', not: '保留内容用 copy_move 移走', ex: 'delete_file {path}' },
  git_pull_push: { tier: 'expert', cn: 'Git推送/拉取', when: '拉取/推送远程（push 前先 pull 防分叉）', not: '本地提交用 git_commit', ex: 'git_pull_push {dir, action:"push"}' },
  kill_process: { tier: 'expert', cn: '终止进程', when: '终止失控/废弃后台任务', not: '正常任务等它自己结束', ex: 'kill_process {jobId}' },
  reload_platform: { tier: 'expert', cn: '重载平台', when: '自改代码生效（先 syntax_check+git commit）', not: '仅改配置/数据不需要', ex: 'reload_platform {}', exempt: true },
  run_command: { tier: 'expert', cn: '执行命令', when: '无专门工具覆盖的系统操作（npm/部署/systemctl）', not: 'cat/ls/grep/sed/head/tail/find/cd/echo 用专门工具', ex: 'run_command {command:"npm install"}', defaultOn: true },
  set_limits: { tier: 'expert', cn: '调整护栏', when: '用户要求调整护栏（0=不限；先解释再改）', not: '未经请求不要自行放宽', ex: 'set_limits {minutes:0}', exempt: true },
};

// 档位中文名（后台展示用）
export const TOOL_TIER_CN = { core: '基础', pro: '专业', expert: '高危' };
