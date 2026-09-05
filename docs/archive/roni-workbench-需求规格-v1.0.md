# Roni Workbench · 需求规格 v2.0（终稿冻结）

> 版本：v2.0（2026-09-01 晚，第五轮复盘定稿，文档冻结）｜状态：**已确认冻结，待开工**
> 定位：全新 AI 智能体平台（自托管、复刻 DSH 核心能力），平台之上后续开发新工作台。

## 〇、定位声明（v1.8 用户确认，最重要）

1. **RW = 独立的服务器智能体**：与 DSH（3080，本地智能体）**平级独立**，不是 DSH 的子项目；DSH 只是开发 RW 的工具，RW 不属于 DSH
2. **不定义任何身份**：不定义"平台管理员/超级管理员/项目单元/谁服从于谁"、**不预设/不移植具体 skill 内容**（"不定义 skill"=不预设内容；"技能系统"是平台机制=挂载 SKILL.md，二期再定，两者不矛盾）——开发时**只造轮子**（接入 API、打造工具、Markdown 渲染、页面），不给 RW 套身份框架
3. **一期默认 full 权限，不受限**：服务器全权限 + 数据库全权限（含 harness_* 老库，为迁移准备）
4. **老项目（885）是失败品**：RW 开发完成后迁移其数据，老项目废弃

## 〇-B、典型使用场景（2026-09-01 复盘补充）

1. **随时对话**：浏览器打开 IP:880 → 登录 → 选模型 → 对话（无需 SSH/命令行）
2. **多模型切换**：同一对话中切换 DeepSeek/GLM/豆包/Kimi 等，按任务类型用最合适的模型
3. **AI 动手干活**：让 AI 在服务器上读文件、写代码、跑命令、搜网、分析文档（默认 full 不受限，可按需收敛）
4. **渠道对话**：飞书/微信里直接和 RW 对话、发语音/图片/文档让它处理
5. **模型管理**：模型市场查看新厂商/模型，勾选接入即用；各平台余额与充值页入口
6. **与 DSH 的定位差异**：DSH 跑在本地（开发工具，权限=本地文件），RW 是独立的服务器智能体（权限=服务器），两者平级独立、互不隶属

## 一、产品概述

**Roni Workbench（RW）**：一个自托管的 AI 智能体 Web 平台，**账号密码登录**即可随时使用（无需 SSH / 命令行 / 打开 dsh web）。

- **产品名**：Roni Workbench（界面品牌）
- **代码仓库**：`github.com/ronisyn/harness-workbench`（公开，main，不用分支）
- **本地根目录**：`E:\projects\harness-workbench`
- **代号**：RW / 880

**三环境分层**：
- **DEV 本地开发**：`E:\projects\harness-workbench`，`localhost:3000`
- **TEST 测试**：服务器 **880 端口**（IP:880，**已放行 ✅**）
- **PROD 正式**：服务器域名 + nginx + HTTPS（443）

**核心价值**：把"能对话、能切换模型、能动手干活（工具）、能挂载技能"的完整 AI 能力，变成自己服务器上一个随时可用的 Web 应用。

## 二、目标与边界

| 项 | 决定 |
|---|---|
| 形态 | 独立 Web 服务（非 DSH 插件）；三环境：本地 DEV → 880 TEST → 域名 PROD |
| 使用 | 浏览器 + 账号密码登录，随时可用 |
| 能力 | 复刻 DSH 核心能力：对话 / 多厂商多模型 / 会话 / 工具 / 技能 |
| 执行环境 | 服务器执行（Agent 在服务器上真实读写文件、跑命令） |
| 权限体系 | **默认 full 不受限**；read/write/full 保留为**可选设置**（v1.8 用户确认） |
| 安全 | 默认 full + **操作留痕**（软护栏：审计日志/超时/并发限制） |
| 后续 | 在平台上开发新工作台（项目/需求/任务/知识库/看板）→ **迁移 885 数据 → 老项目废弃** |
| 团队化 | 三期开放（含真·站内充值） |

## 三、首版范围（v1.4 定稿）

1. **账号登录**：管理员账号（Ronisyn）**直连登录**；邀请码注册**预留接口**（一期不开放注册，团队化三期开放）
2. **多厂商多模型切换**：**D1-D9 全部独立接入**（每家都在 RW 里全新配置，不复用"885 已接"字样；key 均已在服务器）+ **D10 OpenRouter 仅作模型市场数据源**（不接入）；**自研 OpenAI 兼容网关**
3. **会话管理**：新建 / 切换 / 历史 / 重命名 / 删除；流式输出（SSE）；会话持久化（MySQL）
4. **Agent 工具**：**B1-B29 全部一期做完**（29 个，均可开关；危险项留痕）
5. **Markdown 渲染**：A1-A22 全要（可开关）
6. **能力开关系统**：A/B/C/D 每项独立开关（不勾选=不加载/不显示/不产生费用）
7. **模型市场**：厂商自动加载（OpenRouter/SiliconFlow/TokenHub/百炼 每日更新）
8. **实时统计**：对话区下方实时统计（轮数/步数/LLM 耗时/工具耗时/首 token 延迟/tok/s/缓存命中/输入输出 token）——仿 DSH 样式
9. **飞书接入**（一期功能清单见四-C）
10. **微信接入**（一期功能清单见四-C）
11. **联网搜索**：一期 **SearXNG**（用户已确认，接受 AGPL-3.0）

**一期不做**：技能系统（二期在服务器与 AI 重新定义）、充值中心（三期）、知识库向量检索（二期）

## 四、能力清单

### A. Markdown 渲染（A1-A22 全要，可开关）
标题/粗体斜体删除线/列表/任务列表/表格/链接/图片/代码高亮(shiki)/引用/数学公式(KaTeX)/分隔线/脚注/定义列表/上下标/高亮/目录/Mermaid/折叠块/警告块/数据图表(ECharts)/emoji/原始HTML(默认关)
> 全部开源免费（MIT）。

### B. Agent 工具（B1-B29 一期全做，可开关）
1 读文件 / 2 写文件 / 3 追加修改 / 4 列目录 / 5 建删目录 / 6 复制移动重命名 / 7 删除文件(留痕) / 8 查找文件 / 9 代码搜索 / 10 大文件分段 / 11 执行命令 / 12 后台长任务 / 13 终止进程 / 14 联网搜索(SearXNG) / 15 读网页(Readability) / 16 PDF / 17 Word / 18 Excel / 19 PPT / 20 OCR(Tesseract.js) / 21 数据库只读 / 22 数据库写入(留痕) / 23 Git 状态 / 24 Git 提交 / 25 Git 分支 / 26 Git 拉取推送 / 27 语法检查 / 28 运行测试 / 29 上传文件
> 全部开源免费；用工具时的模型调用费另算。

### C. 平台能力（C1-C19 全要，可开关）
多厂商切换/自动路由/流式输出/多会话/会话持久化/长上下文压缩/系统提示词/高级参数/工具调用/技能系统(二期)/子代理(二期)/定时任务/多模态看图/操作留痕/用量统计/并发限制/对话导出/停止生成/快捷键

### D. 模型接入（D1-D9 一期接入 + D10 数据源，均可开关）
| # | 厂商 | 状态 | base URL | 充值入口 |
|---|---|---|---|---|
| D1 | DeepSeek | ✅ 已配（RW 独立接入） | https://api.deepseek.com/v1 | platform.deepseek.com 充值页 |
| D2 | 智谱 GLM | ✅ 已配（RW 独立接入） | https://open.bigmodel.cn/api/paas/v4 | open.bigmodel.cn 费用中心 |
| D3 | 豆包（火山方舟） | ✅ 全通（对话/视觉/生图） | https://ark.cn-beijing.volces.com/api/v3 | console.volcengine.com/ark |
| D4 | Kimi | ✅ kimi-k3 实测 | https://api.moonshot.cn/v1 | platform.moonshot.cn 充值页 |
| D5 | 通义千问 | ✅ 249 模型 | https://dashscope.aliyuncs.com/compatible-mode/v1 | 百炼控制台 |
| D6 | 腾讯 TokenHub | ✅ 121 模型 | https://tokenhub.tencentmaas.com/v1 | 腾讯云控制台 |
| D7 | 百度文心 | ✅ ernie-4.5 实测 | https://qianfan.baidubce.com/v2 | 千帆控制台 |
| D8 | MiniMax | ✅ 8 模型（调用需充值） | https://api.minimaxi.com/v1 | minimaxi 控制台 |
| D9 | 硅基流动 | ✅ 95 模型（调用需充值） | https://api.siliconflow.cn/v1 | siliconflow 控制台 |
| D10 | OpenRouter | 仅作**模型市场数据源**（供参考，不接入） | https://openrouter.ai/api/v1 | openrouter.ai |

**对话主力**：DeepSeek V4 Flash（便宜/快/代码强）。

**重能力**：视觉看图+生图一期接入默认关；视频生成二期；接入不充值=不扣费。

### D+2. 充值中心与统计（v1.4 调整）
- **一期只做「统计」**：每次调用记录 token/费用 + 对话区下方实时统计（轮数/步数/LLM 耗时/工具耗时/首 token 延迟/tok/s/缓存命中/输入输出 token）
  - 开发标注（v2.0）：**"轮数"= 用户消息数**；"步数"= tool_calls 记录数；**会话删除时级联删除该会话 messages**；**模型市场每日更新由 server 内置定时器执行**（每日 0 点拉取快照）
- **充值中心本体挪三期**（团队化 + 真·站内支付需企业资质）
- **充值页链接**（一期设置页提供一键跳转）：DeepSeek / 智谱清言 / Kimi 单独列出（见 D 表），其余平台控制台
- **聚合充值引导**：硅基流动/TokenHub/百炼（充一次多用）

### 四-C. 渠道接入（一期定稿 2026-09-01）
**飞书一期（11 项）**：F1 机器人收发文本 / F2 富文本/卡片 / F3 收发图片 / F4 语音消息收发+识别 / F5 收发文件文档 / F7 云文档读取 / F8 云文档写入创建 / F9 知识库 wiki / F10 表格读写 / F11 多维表格 / F19 ASR/翻译/OCR
> 不要：F6 事件订阅、F12 幻灯片、F13 日历、F14 任务、F15 审批、F16 通讯录、F17 云空间、F18 邮件、F20 定时推送（以后需要再说）

**微信一期（6 项，个人微信 iLink 路线）**：W1 扫码登录 / W2 收发文本 / W3 收图片 / W4 收链接文档 / W5 语音消息（需实测）/ W6 流式回复
> 不要：W7 定时任务、公众号(W8-W11)、企业微信(W12-W14)（以后需要再说）；⛔ 视频/入群平台不支持

### 四-D. 权限体系（v1.8 修订：默认 full 不受限，分级为可选设置）

**定位（v1.8）**：RW 为独立智能体，**一期默认 full 权限不受限**（服务器 + 数据库全权限）；read/write/full 三级**保留为可选设置**（设置页可切换，供用户需要时收敛）。RW 运行在服务器，天然无法访问用户本地电脑。

| 级别 | 能力 | 放行的工具（B 清单） | 说明 |
|---|---|---|---|
| **full**（**默认**） | 完全：不受限 | 全部工具（含删文件/任意命令/后台任务/数据库全权限） | 一期默认，不设限 |
| **write**（可选） | 读写 | read 全部 + B2 写 / B3 追加 / B5 建删目录 / B6 复制移动 / B24 Git 提交 / B25 Git 分支 / B26 拉取推送 / B28 运行测试(工作区内) / B29 上传文件(写) | 用户需要收敛时可选 |
| **read**（可选） | 只读 | B1 读 / B4 列目录 / B8 查找 / B9 搜索 / B10 大文件分段(读) / B14 联网搜 / B15 读网页 / B16-19 文档解析 / B20 OCR / B23 Git 状态 / B27 语法检查 | 用户需要收敛时可选 |
| **数据库工具**（B21/B22） | 全局全权限 | 可读写**全部库**（rw_* + harness_* 老库，为迁移准备；v1.8 确认授权全部） | 不受 read/write/full 限制 |

**规则**：
1. 权限作用于**会话/项目级**（设置页切换，**默认 full，可调**）
2. 命令执行分级（选择 write/read 时生效）：read 只读命令（cat/ls/git status/curl GET）；write 项目内命令；full 任意命令
3. **操作留痕**（审计日志）持续记录；full 级关键操作（删文件/写库/任意命令）强制留痕
4. **工作区定义**（write 级收敛时生效）：= /srv/rw-workspace 作业区 + /srv/harness-workbench 项目代码；write 限定工作区内，read 只读路径，full 无限制
5. 与能力开关联动：权限是"能否"，开关是"是否加载"
6. **架构隔离**：RW 进程运行在服务器，天然无法访问用户本地电脑文件
7. **渠道消息权限**：飞书/微信来的指令默认 **read**，**设置页可配置渠道权限级**（提权到 write/full 后即可执行建项目/安排任务等写操作）
8. **数据库全局权限**：B21/B22 不受 read/write/full 限制；**授权全部库**（rw_* + harness_*，v1.8 用户确认直接开全部）
9. **自动路由默认规则（设置页可改）**：工具调用→GLM/TokenHub；长文本/推理→Kimi；视觉→豆包；默认对话→DeepSeek
10. **路由×开关联动**：自动路由**只在"已启用"的模型中选择**
11. **B28 运行测试边界**：write 级仅运行**工作区内**测试命令；full 任意命令
12. **渠道会话统一模型（v1.9 定稿）**：飞书/微信对话与 Web 对话共用 conversations/messages 表（channel/external_id/permission 字段）
13. **不定义身份（v1.8）**：RW 不定义角色/层级/服从关系，开发只造轮子（API/工具/渲染/页面）
14. **渠道执行能力（v1.9）**：渠道消息**触发 RW 执行并回复**（非仅记录）——如"建项目/查进度/安排任务"在提权后可直接执行，结果经渠道回复；渠道会话 **account_id=NULL（匿名）**；Web 端渠道会话**只读回看、不代发回复**（回复在渠道内进行）
15. **模型市场归属（v1.9）**：从聚合平台（TokenHub/硅基流动/百炼）勾选的模型**归属该聚合平台 provider**（用它的 key/计费），非原厂商
16. **渠道操作留痕（v1.9）**：渠道指令执行工具（尤其提权后）**一律写 audit_log**（记录 channel 来源）

## 四-B、服务器资源规划与隔离

**原则**：RW 独立部署、与 885 老系统**共存**；老系统为失败品，RW 完成后迁移其数据，老项目废弃。迁移前**不动老系统数据**（可只读）。

| 资源 | 新项目分配 |
|---|---|
| 代码目录 | /srv/harness-workbench（独立目录，代码隔离） |
| 数据库 | rw_test + rw_prod（RW 自己的库） |
| DB 用户 | rw_app（仅 127.0.0.1，**授权全部库**：rw_* + harness_*，v1.8 确认，为迁移准备） |
| systemd | rw-test.service(880) + rw-prod.service(域名) |
| 端口 | 880（已放行）+ PROD 走 nginx 443 |
| 凭据 | /root/.rw-keys.env（已有 10 项） |
| Agent 工作区 | /srv/rw-workspace/ |
| 搜索 | SearXNG 独立服务（端口另定，如 8888） |

**共存规则（v1.9 澄清）**：迁移完成前不修改 harness_workbench / hb_p* 数据（可读）；不停 dsh-web / feishu-webhook / hh-server；不占 885/3080/3091/3345 端口；**迁移完成后老项目废弃**。注：此规则为**行为层自律（Agent 提示词约束），非技术限制**（符合"不设限"定位）；如需技术保护可临时只读账号，默认不设限。

## 五、开源优先策略与授权提示

**原则**：优先开源免费；付费能力配开关。**每个开源组件标注许可证 + 商业化影响，由用户确认**（2026-09-01 机制）。

| 组件 | 许可证 | 商业化影响 | 用户决定 |
|---|---|---|---|
| **SearXNG** | **AGPL-3.0** | ⚠️ 网络服务传染；独立部署影响小 | ✅ **已确认使用（2026-09-01）** |
| Tesseract.js | Apache-2.0 | 可闭源商用 | ✅ 用 |
| Whisper/Edge-TTS | MIT | 可闭源商用 | ✅ 用 |
| react-markdown/shiki/KaTeX/mermaid | MIT | 可闭源商用 | ✅ 用 |
| Readability | Apache-2.0 | 可闭源商用 | ✅ 用 |
| Chroma（二期） | Apache-2.0 | 可闭源商用 | 二期定 |
| React/Vite/Express/mysql2/bcryptjs | MIT | 可闭源商用 | ✅ 用 |

> 若未来商业化需自研替代或接受条款的开源组件，会单独提示用户决策。

## 六、技术架构（v1.4 定稿）

- **服务端**：Node.js (>=18) + Express + mysql2 + bcryptjs
- **LLM 网关**：自研 OpenAI 兼容适配层（gateway.js 已写：chatOnce/chatStream/fetchModels）
- **前端**：**React + Vite**（一次到位，2026-09-01 用户确认）；react-markdown + remark-gfm + shiki + KaTeX + mermaid 渲染；太阳大地色对话 SPA
- **数据**：MySQL（表结构见「六-B 数据模型」）
- **搜索**：SearXNG（独立服务，AGPL 已确认）
- **渠道**：飞书（feishu-mcp 复用/扩展）+ 微信（iLink 桥接，复用 885 经验）
- **Agent 运行时**：工具注册体系 + 执行循环 + 会话/记忆 + 成本与并发控制
- **部署**：DEV localhost:3000 / TEST 880 / PROD 域名+nginx+HTTPS

### 六-B. 数据模型（v1.7 补全，MySQL）

**基础表（已建）**：
| 表 | 字段 | 说明 |
|---|---|---|
| accounts | id / username / pass_hash / role / created_at | 账号（管理员+预留注册） |
| sessions | token / account_id / created_at / expires_at | 登录会话（5 天） |
| invites | code / created_by / used_by / used_at / created_at | 邀请码（一期预留接口） |
| audit_log | id / account_id / action / detail / created_at | 操作留痕（full 级强制写） |
| capabilities | account_id / cap_key / enabled | 能力开关（按账号） |

**会话与消息（已建 + v1.7 扩展）**：
| 表 | 字段 | 说明 |
|---|---|---|
| conversations | id / account_id / **channel**(web·feishu·wechat) / **external_id**(渠道侧ID) / **permission**(read·write·full) / project / title / created_at / updated_at | 统一会话模型（v1.7：加 channel/external_id/permission） |
| messages | id / conversation_id / role / content / model / provider / tokens_in / tokens_out / created_at | 消息（Web+渠道统一存储） |

**模型与市场（v1.7 新增）**：
| 表 | 字段 | 说明 |
|---|---|---|
| providers | id / provider_key(唯一) / name / base_url / api_key_env / enabled / sort_order / created_at | 已接入厂商（模型市场写回） |
| models | id / provider_id / model_id / name / capabilities(JSON) / enabled / added_at / last_seen_at | 已接入模型+能力（chat/vision/image/…） |
| market_snapshot | id / source(openrouter·siliconflow·tokenhub·dashscope) / model_id / name / provider_name / domain / snapshot_date / UNIQUE(source,model_id) | 每日市场快照（模型市场数据源） |

**用量与统计（v1.7 新增）**：
| 表 | 字段 | 说明 |
|---|---|---|
| usage_stats | id / account_id / conversation_id / message_id / provider_id / model_id / tokens_in / tokens_out / cost / duration_ms / first_token_ms / cache_hit_tokens / created_at | 每次 LLM 调用一条（统计条/费用） |
| tool_calls | id / conversation_id / message_id / tool_name / args(JSON) / result_summary / duration_ms / status / created_at | 工具调用记录（统计条"步数/工具耗时"） |
| price_table | id / provider_id / model_pattern / price_in_per_million / price_out_per_million / currency / updated_at | 各家单价（费用计算依据，默认表可参考 885 PRICE_TABLE_V1） |

**配置（v1.7 新增）**：
| 表 | 字段 | 说明 |
|---|---|---|
| settings | skey(唯一) / svalue(JSON) / updated_at（**实际字段名**，避开 MySQL 关键字 key/value） | 全局配置：自动路由规则/默认权限/渠道权限/全局默认值 |

**二期预留（一期不建）**：projects / requirements / tasks（新工作台，二期再定）。

### 目录结构
```
E:\projects\harness-workbench\
├── package.json / .gitignore / .env.example / README.md   ✅
├── docs\roni-workbench-需求规格-v1.0.md                    ✅ v1.4
├── server\
│   ├── config.js / db.js / auth.js                         ✅
│   └── llm\providers.js / gateway.js                       ✅
├── src/（React 前端，待建）
└── scripts/（部署脚本，待建）
```

## 七、UI/交互

- 风格：**太阳大地色**（橘红 #E2542B / 藤黄 #C98B2E / 米白底）对话式全屏沉浸
- **布局**：左侧**会话列表**（一期仅"新建对话"，**项目概念二期加入**）+ 中间主对话区（流式输出/停止/导出/统计条）+ 右侧**设置抽屉**（设置按钮呼出，可收起）
- **设置交互（v1.7 定稿）**：**两层结构**——设置页（大：模型市场/权限默认/路由规则/充值链接/渠道配置）+ 抽屉（常用：能力开关快捷切换/当前会话权限），抽屉放不下的大项引导进设置页
- 交互：能力开关即时生效、模型切换下拉、**对话区下方实时统计条**、渠道会话与 Web 会话统一列表展示

## 八、安全与性能

- bcrypt 密码；session token（5 天）；邀请码注册（预留）；**权限：默认 full 不受限（read/write/full 可选设置）**；操作留痕（关键操作强制）；命令超时；并发上限；会话隔离
- 凭据只存服务器 /root/.rw-keys.env（chmod 600），禁止明文入文档/代码/仓库
- SSE 流式；长对话压缩；MySQL 连接池；慢查询优化

## 九、分期

- **一期**：登录 + D1-D9（D10 数据源）+ 会话 + A/B/C（29 工具全做）+ **三级权限（read/write/full，默认 full）** + SearXNG + 模型市场 + 实时统计 + **飞书/微信基础接入** + React 前端
- **二期**：在平台上开发新工作台（项目/需求/任务/看板）→ 迁移 885 数据 → **老项目废弃**；技能系统；知识库（向量检索）；渠道深化；多 Agent 并行；视频生成
- **三期**：团队化（组织/成员/权限）+ 充值中心（真·站内支付，需企业资质）

## 九-C、开发里程碑与工期（v1.4 更新，合计约 3.5-4 周）

| 阶段 | 内容 | 工期 | 验收点 |
|---|---|---|---|
| P1 核心闭环 | 登录 + 多模型对话(SSE) + 会话 + React 界面 + 实时统计 | 4-5 天 | 浏览器登录→选模型→对话，统计条可见 |
| P2 工具与能力 | 29 工具全做 + 能力开关(A/B/C) + SearXNG 部署 | 5-7 天 | Agent 能读写文件/跑命令/搜网/分析文档 |
| P3 模型市场 | 厂商自动加载 + 每日更新 + 视觉/生图接入 + 充值页跳转 | 3-4 天 | 设置页加载未接入厂商→勾选→即用 |
| P4 渠道接入 | 飞书 F 清单 **11 项** + 微信 W1-W6 + 语音实测 | 4-6 天 | 飞书/微信里和 RW 对话 |
| P5 部署联调 | 880 TEST 部署 + 三环境 + 全链路测试 + 修 bug | 2-3 天 | IP:880 全功能可用 |
| P6 上 PROD | 域名 + nginx + HTTPS + 体验优化 | 2-3 天（可与 P5 并行） | 域名正式访问 |

## 十、当前进度

- ✅ 需求文档 v2.0（本文档，终稿冻结，不再改动除非二期需求变化）
- ✅ 仓库 ronisyn/harness-workbench 已建（公开，main）
- ✅ 9 家模型 key 验证（7 家实测可对话；D10 OpenRouter 无 key 仅作数据源）
- ✅ 骨架 5 模块已写：config / db / auth / providers / gateway
- ✅ 880 已放行
- ⬜ React 前端（src/）
- ⬜ server/index.js（Express 入口 + 路由）
- ⬜ 渠道接入（飞书/微信）
- ⬜ SearXNG 部署
- ⬜ P1-P6 剩余

## 十一、待办

- [x] 880 放行、8+2 模型 key、管理员账号、文档确认
- [x] 五次复盘 + v2.0 终稿冻结（独立智能体、默认 full、渠道执行、模型市场归属、数字/命名统一）
- [ ] **开工（用户晚上回家后）**：git init + push → P1 核心闭环
- [ ] 按六-B 数据模型更新 db.js（providers/models/market_snapshot/usage_stats/tool_calls/price_table/settings 建表）
- [ ] SearXNG 部署（一期）
- [ ] 飞书/微信接入开发（一期）
- [ ] OpenRouter key（可后补）
- [ ] 域名（PROD 阶段再定）

## 十二、参考

- 885 资产（迁移候选，非参考模板）：6 个 skill 方法论、知识库、设计规范 v3.0、原型 M1-M6
- 开源组件授权：SearXNG(AGPL-3.0 已确认) / Tesseract(Apache-2.0) / Whisper(MIT) 等
- 聚合平台（模型市场源）：OpenRouter / SiliconFlow / TokenHub / 百炼
- 需求确认过程：2026-08-31~09-01 多轮沟通 + **五次五维复盘** + v2.0 终稿冻结（独立智能体、默认 full、渠道执行、不定义身份）
