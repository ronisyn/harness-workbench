# Codex CLI 的 prompt/prefix 缓存优化 · 研究结论 v1

> 日期：2026-10（研究时点）｜方法：官方文档（OpenAI / Anthropic / DeepSeek / Google）+ Codex 源码与测试套件 + **本机 `codex.exe` 0.153.4 字符串取证** + Roni 平台侧已有考证。
> 证据约定：**官方文档/源码 > 本机二进制 > 第三方审计**；凡推断处均标「推断」。查不到的写「未找到可靠来源」。

---

## 0. 结论先行（六条）

1. **Codex 对缓存的核心做法只有两条**：① `prompt_cache_key` = 会话 `session_id` 且**终身不变**；② 固定前缀（tools + `base_instructions`）**逐字节稳定、无时间戳/无 per-request 数据**。没有 `cache_control` 断点（那是 Anthropic 概念），OpenAI 前缀缓存是全自动的。
2. **OpenAI 的缓存生命周期 = 30 分钟**（GPT-5.6 及以后 `ttl` 唯一支持值 `30m`，也是默认）；更早模型 `in_memory` ≈ **空闲 5–10 分钟**（最长 1 小时），`24h` 档典型 ~30 分钟、最长 24 小时。**「复用即续期，且不额外收写入费。」**
3. **DeepSeek 官方不给固定 TTL**：「不再使用后自动清除，通常**几小时到几天**」。所以 Roni 的 **30 分钟空闲掉到 17.6%** 与 OpenAI 的 `30m` 边界高度吻合，而**不是** DeepSeek 文档的「几小时到几天」——这条值得单独查证（见 §5）。
4. **「保温心跳」有官方背书**：Anthropic 文档专设 **Pre-warming the cache** 一节，用 `max_tokens: 0` 写入缓存、零输出 token 计费；并明确「默认 5 分钟 TTL 时，**至少每 5 分钟发一次预热请求**保持缓存温热」。所以这不是灰色做法。
5. **但业界的更优解不是心跳，是「趁缓存还热时动手」**：volute#379 提出空闲 ~50 分钟时**先压缩再闲置**——压缩这一轮走 0.1× 缓存价而非全价重算，且顺带把下次冷启动的上下文变小。**这比心跳省钱，因为它花的是本来就要花的钱。**
6. **Roni 的现状诊断**：`docs/dsh-cache-hit-99.8-report.md` 已证明 DSH 侧前缀工程做到极致（动态内容分流、工具 code-unit 排序、压缩伪装成会话续写），但 **§2.7 明确「预热/保温/心跳：未找到」**。也就是说 DSH 只做了「避免失效」，**没做「失效之后怎么办」**。
   > **⚠️ 2026-09-15 事后更正（本条的归因已被实测证伪）**：这里原本写"这正是 30 分钟悬崖的成因"。后续用真实生产数据做的自然实验推翻了它——见 `../proposals/缓存追平DSH-方案-v1-20260915.md` §2：缓存存活 **≥167.9 小时**（会话 269 空闲 7 天后未命中仅 2.9%），而同一会话在**前缀变了 +46 tokens** 的那天 24 小时空闲后未命中 **92.8%**；十天内"前缀是否逐字节未变"与"冷/热"**9/9 完全一致**。⇒ **悬崖的成因是前缀面变更（部署改 ENV_MAP/工具面），不是空闲超时**；本节第 2、3、4 条关于 TTL 的结论对 OpenAI/Anthropic 仍然成立，但**不适用于我们这条 DeepSeek 路由**（实测一周仍命中）。

---

## 1. Codex 的上下文组装顺序：稳定前缀 / 每轮变动

**答案：tools 与 instructions 是稳定前缀且排在请求最前；一切易变量都不在这两处，而是作为 input 数组的后续条目追加。**

### 1.1 证据 A — 源码 `build_responses_request`（main 分支，本机 0.153.4 同构）

`codex-rs/core/src/client.rs`（`https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/client.rs`，拉取于研究时点，共 2690 行）：

- `:805-816` `use_responses_lite` 分支里，**先构造 `tools`**；
- `:817-824` 把 tools 包成 `ResponseItem::AdditionalTools { role: "developer", tools }`，成为 `prefix` 的第 0 项；
- `:825-834` 把 `prompt.base_instructions.text` 作为第 1 项压入 prefix；
- `:835` `input.splice(0..0, prefix);` —— **整个稳定前缀被插到 input 最前面**；
- `:812-815` `create_tools_json_for_responses_api(&prompt.tools)` 每轮重算，但见 1.2：结果被证明逐字节一致。
- 非 lite 分支（`:837-842`）：`instructions = prompt.base_instructions.text`，`tools = create_tools_raw_json_for_responses_api(...)`，即**标准 Responses API 的顶层 `instructions` + `tools` 字段**，二者都在请求最前，天然是缓存前缀。
- `:881-898` 最终请求体：`model / instructions / input / tools / tool_choice / reasoning / store / stream / include / service_tier / prompt_cache_key / ...`。**注意 `store: false` + `include: ["reasoning.encrypted_content"]`**，且 `prompt_cache_key` 是显式字段。

### 1.2 证据 B — Codex 自己的测试在**断言前缀稳定**

`codex-rs/core/tests/suite/prompt_caching.rs`（`https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/tests/suite/prompt_caching.rs`，1182 行）——**这个文件的存在本身就是最强的「有意为之」证据**：

| 行号 | 测试名 | 断言什么 |
|---|---|---|
| `:132` | `prompt_tools_are_consistent_across_requests` | `body0["instructions"] == base_instructions` 且**两次请求 tool 名序列完全相同**（`assert_tool_names(&body0, ...)` / `&body1`） |
| `:383` | `prefixes_context_and_instructions_once_and_consistently_across_requests` | 环境上下文与 instructions **只注入一次且跨请求一致** |
| `:478` | `overrides_turn_context_but_keeps_cached_prefix_and_key_constant` | 覆盖 turn context 时**缓存前缀与 key 都不变** |
| `:555` | （注释） | `// prompt_cache_key should remain constant across overrides` |
| `:751` | `per_turn_overrides_keep_cached_prefix_and_key_constant` | 逐轮覆盖同样保持前缀 + key 恒定；`:825` 同款注释 |
| `:881` | `send_user_turn_with_no_changes_does_not_send_environment_context` | **环境上下文「没变就不发」** |
| `:1014` | `send_user_turn_with_changes_sends_environment_context` | **变了才发** |

`:881` / `:1014` 这一对是最有信息量的：**Codex 把 cwd/环境这类易变量做成「按需追加」而不是「每轮重发」**——和 Roni 在 `docs/dsh-cache-hit-99.8-report.md:93-101` 记录的 DSH 做法（未变 ⇒ 零事件）是同一手法。

### 1.3 证据 C — 本机二进制字符串

本机 `C:\Users\颜文\AppData\Roaming\npm\node_modules\@openai\codex\`（版本 **0.153.4**，`package.json`）。原生可执行文件：
`...\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`（295,408,944 字节）。

`findstr` 命中（Rust 字符串表，非源文件）：

- 请求字段序列 `...stream_options / include / service_tier / **prompt_cache_key** / generate / client_metadata / access_programs ...` → 证明**发往 Responses API 的请求体里带 `prompt_cache_key`**；
- `usage / prompt_tokens_details / **cached_tokens** / **cache_write_tokens**` → 证明 Codex **同时读缓存命中与缓存写入两个计量桶**；
- 会话历史字段 `...base_instruction / **parent_thread_id** / forked_from_ordinal ...` → 证明**父子线程关系在协议层存在**（子代理缓存归属可继承）。

> ⚠️ **与第三方审计的一处出入（重要）**：第三方审计 `https://github.com/OnlyTerp/prompt-cache-skills/blob/main/audits/codex-cli.md`（审计提交 `6111791d`，2026-05-27）称 `prompt_cache_key = self.state.thread_id.to_string()`（其引 `client.rs:752`）。但**当前 main 分支源码**是：
> ```rust
> fn prompt_cache_key(&self, responses_metadata: &CodexResponsesMetadata) -> String {
>     if let Some(prompt_cache_key) = &self.prompt_cache_key_override { return prompt_cache_key.clone(); }
>     if let SessionSource::Internal(source) = &self.state.session_source
>         && let Some(parent_thread_id) = responses_metadata.parent_thread_id {
>         return format!("{source}:{parent_thread_id}");     // 子代理继承父会话缓存
>     }
>     responses_metadata.session_id.clone()
> }
> ```
> （`client.rs:497-509`；`prompt_cache_key_override` 字段见 `:250`、构造见 `:489-495`）
> 结论不变且**更强**：key 仍按会话稳定，且**子代理显式共享父会话的缓存归属**；审计里「未暴露为 CLI flag」的说法在 main 分支需重新核对（存在 override 机制）。

### 1.4 组装顺序总表

| 位置 | 内容 | 稳定性 |
|---|---|---|
| 请求最前 | `tools`（developer/AdditionalTools） | **稳定前缀**（跨请求断言一致） |
| 紧随其后 | `base_instructions`（instructions / developer msg） | **稳定前缀**（无时间戳、无 per-request 数据） |
| input 数组 | 会话消息、工具结果、推理项 | **只追加**（`:803` `get_formatted_input_for_request`） |
| 条件追加 | 环境/cwd 上下文 | **仅当变化时追加**（`:881` vs `:1014`） |
| 请求级参数 | `prompt_cache_key`（会话级恒定）、`reasoning`、`text.verbosity` | 会话内恒定 |

---

## 2. Codex 对缓存做了什么显式优化

1. **稳定 `prompt_cache_key`**：会话内恒定（`client.rs:497-509`），且**压缩/覆盖后不变**——测试 `:478`、`:751` 专门断言。**压缩时不换 key 是关键的「非显然」设计**：朴素实现会在重写历史时新铸 session id，直接把缓存打没。
2. **子代理继承父会话缓存归属**：`SessionSource::Internal(source) + parent_thread_id` → key = `"{source}:{parent_thread_id}"`（`client.rs:502-506`）；对应请求头常量 `X_CODEX_PARENT_THREAD_ID_HEADER = "x-codex-parent-thread-id"`（`client.rs:156`，本机二进制亦命中 `x-codex-parent-thread-id` 与 `forked_from_ordinal`）。子代理启动提示因此能命中父会话的暖缓存。
3. **instructions 逐字节稳定**：`client.rs:825-834` 直接用 `prompt.base_instructions.text` 克隆，**不注入时间戳、不注入统计**。
4. **工具 schema 稳定**：测试 `:132` 直接断言 tool 名序列跨请求一致；`create_tools_json_for_responses_api` 每轮重算但结果确定。
5. **每轮只追加**：`input` 来自 `prompt.get_formatted_input_for_request(...)`（`client.rs:803`），代码里没有对既有 input 的原地改写（除 `:843-854` 对**非 OpenAI provider** 清除加密元数据的兼容分支）。
6. **易变量按需追加**：环境上下文「无变化则不发」（测试 `:881`）。
7. **压缩不重建缓存**：保留 key；`codex-rs/core/tests/suite/compact_remote.rs` 有 `..._reuses_prompt_cache_key` 测试（`compact_remote.rs:750`、`:767`，第三方审计引用，未逐字复核）。OpenAI 官方也承认压缩会伤缓存：「第一次压缩后的请求可能复用更少的前次缓存」，但**建议比较压缩前后的总输入成本，而不是只看命中率**（`prompt-caching#compaction-can-reduce-cache-reuse`）。
8. **`prompt_cache_key` 的隐藏作用是路由**：官方说明缓存存在**单机**，>15 req/min 会溢出路由；key 帮助**相关请求落到同一台持有该缓存的机器**。**key 不保证命中**（`prompt-caching#prompt-cache-keys`）。
9. **Codex 二进制内置了一份模型迁移/caching 指南**（本机 `codex.exe` 内嵌文本，含标题 `## Prompt caching`），要点值得直接抄：
   - `keep reusable prefixes stable`；`do not churn large system prompts unnecessarily`；
   - `compare old and new cached_tokens, cache_write_tokens, latency, and cost`；
   - `use explicit cache breakpoints only when a measured workload has a stable boundary that implicit caching misses`；
   - `do not globally convert every prompt to explicit caching`；
   - `Cache writes cost more than ordinary uncached input, so a lower hit rate can be both slower and more expensive.`
   - 并指出 GPT-5.6 起「隐式断点靠近最新 user/tool 消息、不再依赖 128-token 取整」，因此**大稳定前缀 + 变化后缀的写法可能反而丢命中**——这是一条容易被忽略的陷阱。

> **未找到可靠来源**：Codex 源码中的「工具 schema 显式排序」语句（Roni 的 DSH 侧有 `compareToolNames` code-unit 排序；Codex 只有「跨请求一致」的测试断言，未见到排序实现本身）。**未找到** Codex 任何形式的「保温/心跳」实现。

---

## 3. 缓存 TTL 与空闲失效（三个厂商各一个数字 + 出处）

| 厂商/模型 | 缓存有效期 | 空闲多久失效 | 续期行为 | 出处 |
|---|---|---|---|---|
| **OpenAI GPT-5.6+** | `prompt_cache_options.ttl`，**唯一支持值 `30m`，也是默认**；可能保留更久 | **最近一次写入或复用后 30 分钟** | **复用即刷新生命周期，且不重复收写入费** | [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)（本地存档 `docs/_research_openai_prompt_caching.txt:164-165`） |
| **OpenAI 早期模型** `in_memory` | 最长 1 小时 | **典型空闲 5–10 分钟**失效 | 同上 | 同上（`:167`、`:182`） |
| **OpenAI 早期模型** `24h` | **最长 24 小时** | 典型 **~30 分钟** | 同上 | 同上（`:168`、`:182`） |
| **Anthropic** | 默认 **5 分钟**；可选 **1 小时**（写入价 2×，5 分钟档 1.25×） | 5 分钟 / 1 小时 | **每次被使用即免费刷新** | [Claude prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)（本地存档 `docs/_research_anthropic.txt:32`、`:42`、`:619`） |
| **DeepSeek** | **官方不给固定 TTL** | 「不再使用后自动清除，**通常几小时到几天**」 | 未明确说明；命中靠「完全匹配一个 cache prefix unit」 | [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)（本地存档 `docs/_research_deepseek_en.txt:35-36`） |
| **Google Gemini** | 隐式缓存**未公布 TTL**；官方只说「短时间内发相似前缀的请求」以提高命中 | 未找到可靠来源（隐式）；显式缓存 TTL 文档另见 | 未找到可靠来源 | [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)（本地存档 `docs/_research_gemini.txt:159-186`） |

### 3.1 关于「1024 token 步进」的精确表述

OpenAI 官方现在的说法是**最小可缓存前缀长度**，不是「按 1024 步进」：

- **GPT-5.6 及以后：1,024 个可见输入 token**（隐藏 system 内容不计入）；
- 早期模型：**随请求设置而变**；
- 隐式断点：GPT-5.5 及更早「按规则间隔（**早期模型为 2,048 token**）」；
- **计量取整**：GPT-5.5 及更早的 `cached_tokens` 会**向下取整到 128 的倍数**；GPT-5.6+ 报「精确边界、排除隐藏 token」。
出处：同一 OpenAI 页面的 `Minimum cacheable prefix` 与 `Behavior` 对比表（本地存档 `:43`、`:182`）。

> 另外：**缓存命中仍计入 TPM 限流**；**不能手动清缓存**（OpenAI FAQ，存档 `:583-584`）。

### 3.2 与 Roni 的观测对齐（推断）

Roni 的三个数字——**同执行内 98.5% / 30 分钟空闲后首个请求 17.6% / 300 秒间隔仍 98.5%**——与厂商文档的对照：

- **`300 秒间隔仍 98.5%` ⇒ 厂商 TTL ≥ 5 分钟。** 排除 Anthropic 默认 5 分钟档「刚好卡线」的可能，说明 TTL 明显大于 5 分钟。
- **`30 分钟空闲 ⇒ 17.6%` ⇒ TTL 边界就在 30 分钟附近。** 这与 **OpenAI `30m`** 或 OpenAI 早期模型的 **`24h` 档「典型 ~30 分钟」** 精确吻合。
- **但与 DeepSeek 官方「几小时到几天」不吻合。**

因此：若 Roni 走 DeepSeek 官方 API，则「30 分钟悬崖」**不是官方文档描述的通用行为**，而可能是该路由的实际缓存淘汰策略、或命中判定为「完全匹配 cache prefix unit」导致的**边界效应**（DeepSeek 命中要求**完整匹配**某个前缀单元；长前缀被按固定 token 间隔切块，错一块即整块不命中）。**建议用 `usage` 读数做一次定标实验（§5）再决定投入方向**，不要直接照抄 OpenAI 的数字。

---

## 4. 业界怎么处理「空闲导致缓存失效」

### 4.1 有官方背书的「预热」——Anthropic 专章

Anthropic 文档设有 **Pre-warming the cache** 一节（本地存档 `docs/_research_anthropic_prewarm.txt`）：

- **做法**：`max_tokens: 0`。API 把 prompt 读入模型并在 `cache_control` 断点写入缓存，**立刻返回、不生成任何输出**（`content: []`、`stop_reason: "max_tokens"`、`usage` 完整）。
- **计费**：**零输出 token 计费**；若前缀尚未缓存，则付一次正常的**缓存写入费**（用 `usage.cache_creation_input_tokens` 确认；`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` 可分辨档位）。
- **保温频率**：官方 FAQ 明确「默认 5 分钟缓存时，**至少每 5 分钟发一次预热请求**保持缓存温热」。→ **心跳是被厂商允许并写进文档的**。
- **断点位置**：必须打在**与后续真实请求共享的最后一块**上（通常是 system prompt / 工具定义），**不能打在占位 user 消息上**，否则缓存被 key 到占位内容，真实请求命中不了。
- **配置必须一致**：thinking 配置与 `output_config.effort` 会被渲染进 prompt，**预热时的配置必须与真实请求相同**，否则写出来的条目真实流量永远命中不到。
- **限制**：`max_tokens: 0` 在以下情况被拒（`invalid_request_error`）：`stream: true`、扩展思考、结构化输出、`tool_choice` 为指定/任意工具；**Batches 请求内也被拒**。
- **历史**：`max_tokens: 0` 之前，业界用 `max_tokens: 1` 预热——官方明说 `0` 更优（无输出要丢弃、无输出计费、意图明确）。

### 4.2 社区落地与争议（真实翻车点很具体）

**(a) claude-code-hub #567「透明化缓存预热」（已 Closed as not planned）** — https://github.com/ding113/claude-code-hub/issues/567

- 思路：在 TTL 即将到期前发**极小 keep-alive 请求**（近乎零输出、只付缓存读/刷新价）续期。
- **经济性判据**（`:113-115`）：设 `R`=缓存读价、`W`=缓存写价、`T`=被保温的前缀 token 数、`O`=保温请求自身开销、`p`=用户在下个 TTL 窗口内再次请求的概率，则单次保温划算的条件是 **`p * (W - R) * T > R * T + O`**。→ **小缓存（T 小）时 `O` 占比过高，不该保温**（`:120`）；故设 `MIN_CACHED_TOKENS` 门槛。
- **最大风险 = 把「刷新」做成「重建」**（`:100-104`）：迟到的保温请求会变成**投机性缓存写入**（更贵）。防护：迟到就跳过；**若保温请求没有产生 cache read tokens，视为 miss 并永久停止该会话保温**；失败即止。
- 排期：`last_cache_access + (TTL - buffer)`；每个会话并发一个保温 job；**保温请求按普通请求计费与限流**（不做隐藏成本通道）。
- 未采用替代方案（`:299-302`）：客户端侧 keepalive（服务端更简单但难统一记账）、**一直保温**（会话结束后浪费）、1 小时 TTL（当前条件不可用）。

**(b) volute #379「趁缓存还热时压缩」← 我认为这是最值得抄的一条** — https://github.com/mimsy/volute/issues/379

- 事实基础：Claude Agent SDK **把 prompt caching 钉在 1 小时 TTL 且无开关**，缓存读 ≈ 0.1× 输入价，1h 写入 = 2×。
- 代价：**任何超过 1 小时的空闲会让下一轮冷读整份 transcript**（全价输入 + 2× 重写缓存）；10 万 token Opus 级 ≈ 单轮 **$1.00**，而温热时 ≈ **$0.05**。
- **关键洞察**：若一个会话已空闲 ~50 分钟，**缓存无论如何都将过期**，那么**现在就压缩**——压缩这一轮走 0.1× 缓存读价而非全价；且压缩后上下文变小，**下次冷启动的重建成本也变小**。触发条件：`idleMinutes`（默认 ~50，落在 60 分钟 TTL 内）+ `contextTokens` 下限（默认 ~50k，避免为空上下文瞎折腾）。
- 评测收益（`:833`）：10 万 token 主会话、每天 3 次心跳 + 若干冷启动 ≈ **$3–5/天冷输入**；改为空闲压缩到 ~15k 基线后 **< $1/天**；压缩本身每次 ≈ **$0.05–0.10**。
- **为什么这比心跳好**：心跳是「为了保温而花一笔本来不必要的钱」；空闲压缩是「**在必然要付费的那个时刻，把付费方式从全价换成缓存价**」，且顺带降低后续成本。**它严格优于「新建会话 + 只带最近消息尾巴」**（后者丢连续性）。

**(c) 心跳的工程形态确实存在**：`shore-daemon` 有完整的 `cache_keepalive.rs` 模块（https://docs.rs/shore-daemon/15.0.0/src/shore_daemon/cache_keepalive.rs.html），说明「守护进程定期保鲜」已是可复用的工程模式。

**(d) 没有 key 的代价可量化**：nearai/ironclaw #7921 实测——OpenAI 系后端**不发 `prompt_cache_key`** 时，KV 缓存命中率在**单次运行约 200 次模型调用后从 ~82% 崩到 29%**（≈**3.5× 输入成本**）（https://github.com/nearai/ironclaw/issues/7921）。该 issue 同时指出**key 稳定 ≠ 前缀稳定**：「固定 key + 不稳定前缀依然 miss；稳定前缀 + 无 key 依然有路由风险」，两者必须同时成立。

---

## 5. 横向对比表

| 维度 | **OpenAI Codex CLI** | **Claude Code / Anthropic** | **DeepSeek Harness（本机 99.8% 考证）** | **Roni（我们的平台）** |
|---|---|---|---|---|
| 前缀策略 | tools + `base_instructions` 置于请求最前并**逐字节稳定**；环境量「未变不发」（测试 `:132`/`:383`/`:881`） | tools → system → messages **层级式**，`cache_control` 显式断点；「快照进 user 消息」 | 动态量（时间/环境）**分流为追加式 user 快照**，未变零事件；工具 **code-unit 名排序** | 沿用 DSH 分层：静态 sections → 系统提示，动态 contexts → 追加式 user 快照 |
| 路由/亲和 | **`prompt_cache_key` = 会话 id，终身不变**；子代理共享父 key（`client.rs:497-509`） | 无 key 概念；靠**同机器 + 断点哈希**；官方提示「缓存按机器存放」 | 不适用（DeepSeek 服务端按前缀单元匹配） | 未使用 `prompt_cache_key`（Roni 侧无此字段；gateway 只读 usage 计量，`server/llm/gateway.js:26-30`） |
| 压缩/改写如何避免整段失效 | **压缩保留同一 key**（测试 `:478`/`:751`） | 官方承认压缩会伤缓存，建议**比总成本而非命中率** | **压缩器伪装成会话续写**：保留原 system+tools+前导消息，压缩指令作最后一条 user 消息 → 压缩请求是原请求的**真前缀** | 已有「段边界折叠」轮次与 `server/prefix.js` 断链机检（`isUnexpectedBreak`） |
| TTL / 空闲失效 | **30 分钟（GPT-5.6+）**；早期 5–10 分钟 / 最长 24h | **5 分钟**默认，可选 **1 小时** | 官方「几小时到几天」；**实测 30 分钟掉到 17.6%** | 同上（走 DeepSeek 路由，`server/llm/providers.js:7`） |
| 续期方式 | **复用即自动续期，不重复收写入费** | **被使用即免费刷新** | 未明确 | 未明确（同上） |
| 保温/预热 | **未找到**（无心跳、无预热；只有 session 启动预热 **WebSocket 传输**，非缓存） | **官方 Pre-warming 专章**：`max_tokens: 0`、零输出计费、建议每 5 分钟一次 | **未找到**（`dsh-cache-hit-99.8-report.md` §2.7 明确「预热/保温/心跳：未找到」） | **未找到**；无 TTL 配置、无空闲处理 |
| 跨会话共享前缀 | 子代理/内存整合等内部会话共享父 key（`client.rs:502-506`） | 支持（同前缀 + 同机器即可） | **仅 fork seed**：子会话首条消息是父会话**严格前缀**，首次请求即全前缀命中（`dsh-subagent-fork-in-process`） | 有 subagent / fork 能力，可复用同机制 |
| 计量诚实性 | 读 `cached_tokens` + `cache_write_tokens` 两桶 | 读 `cache_creation_input_tokens` / `cache_read_input_tokens` | 互斥三桶归一，显示端**禁止把部分命中四舍五入成 100%** | 已有 `cache_hit_tokens` / `cache_miss_tokens` 字段与 `cache_hit_rate_target` 告警（`server/settingsSchema.js:25`） |

**Roni 的独特优势（别浪费）**：`server/prefix.js` 已经能**机检前缀是否断裂**，`usage_stats` 已按 `provider × model × 日` 聚合 `cache_hit`/`cache_miss`（`server/db.js:519-525`）。**做保温/空闲压缩所需的观测基建已经齐了**——缺的只是决策与执行。

---

## 6. 给 Roni 的建议

### 6.1 先做实验，别先写功能（成本：半天）

用现有 `usage_stats` 拉一次**空闲间隔 vs 首个请求命中率**的散点（横轴 = 距上次请求的秒数，纵轴 = 该请求的 `cache_hit/(hit+miss)`），做**定标**：

- 若悬崖出现在 **~30 分钟** ⇒ 上行 TTL 是 30 分钟档；心跳/压缩的节拍按 30 分钟设。
- 若出现在 **~5 分钟** ⇒ 按 5 分钟设。
- 若实测与「几小时到几天」一致、30 分钟那次 17.6% 只是 `cache prefix unit` 未对齐的孤例 ⇒ **不要做保温**，去做「前缀单元对齐」（见 6.3 第三种做法）。

**这一条必须先做**，因为 §3.2 显示现有三个数字与 DeepSeek 官方文档**不一致**，而三个方案的成本差一个数量级。

### 6.2 主建议：**优先「趁热压缩」，次选「心跳」**

按收益/成本排序：

| 方案 | 何时用 | 代价 | 风险 |
|---|---|---|---|
| **① 空闲压缩（推荐首选）** | 会话空闲接近实测 TTL（如 0.7–0.85 × TTL）且上下文超过下限 | 一轮**缓存价**的读 + 摘要输出（≈ 0.1× 全价读） | 低。花的是「反正要花的钱」，且**下次冷启动更便宜** |
| **② 心跳保温** | 会话**被判定即将被继续使用**（`p` 高）且缓存足够大（`T` 大） | 每 TTL 窗口一次缓存读价 + `O` | 中。**迟到会退化成投机性写入（更贵）**；会话已结束时纯浪费；需按 6.2.1 的护栏 |
| ③ 都不做 | 空闲会话、短会话、小上下文 | 0 | 无 |

**①②不是二选一**：正确组合是 **①先压缩（把上下文降到基线）→ 若仍判定用户会回来，再用②在更小的 `T` 上保温**——压缩之后 `T` 变小，②的收益条件 `p*(W-R)*T > R*T + O` 更难满足，**往往②就被①自然取代了**。这正是 volute#379 的隐含结论。

#### 6.2.1 若确实要加心跳，必须带这五条护栏（抄 claude-code-hub #567）

1. **迟到即跳过**：`now > last_access + TTL - buffer` 时**不发**，宁可冷启也不投机写入。
2. **无 cache read 即止损**：保温请求 `cache_read` 为 0 ⇒ 视为 miss，**永久停止该会话保温**（防止静默变成「投机性缓存写入」）。
3. **`MIN_CACHED_TOKENS` 门槛**：`T` 太小不保温（`O` 吃掉全部收益）。
4. **一次失败即止** + 每会话同时只允许一个保温 job。
5. **记账不隐藏**：保温请求照常写 `usage_stats`（`kind` 建议新增 `'keepalive'`，与 `'round'`/`'collapse'`/`'title'` 并列），并按普通请求限流。**否则命中率指标会被自己污染**。

### 6.3 第三种（可能更好的）做法：**跨会话共享最小公共前缀**

现状的空闲问题之所以疼，是因为**每个会话的缓存彼此独立，一个会话的空闲就作废一整套昂贵前缀**。三条比心跳更根本的改造：

1. **把「固定前缀」做成跨会话共享对象**：Roni 的 system prompt + 工具 schema 在同 preset 下**天然字节相同**（`docs/dsh-cache-hit-99.8-report.md:205` 已指出：「跨会话能命中的只有字节级天然相同的前缀（同 preset ⇒ 同 system prompt + 同 tool schema）」）。**把它显式化**：把高频不变的 system+skills+工具面收敛成一个**受版本控制的 canonical prefix**，让它成为所有会话的公共前 2–4k token。这样**一个新会话的第一条请求就能命中公共前缀**，而 30 分钟空闲只损失「会话私有尾巴」，不损失公共头部。**收益最大、且与「保温」正交**。
   - 落地要点：canonical prefix 需带**版本号**，改版才失效；变更应**成批发布**而非随时热改，避免所有在飞会话同时被击穿。
2. **长驻会话（把「会话」和「执行」解耦）**：Roni 的痛点描述是「**同执行内** 98.5%」——即命中率是按**执行**度量的，执行结束 = 前缀作废。改成**按项目/工作区常驻的会话线**（同一工作区复用同一 session，新执行只追加新 turn），空闲失效的代价就从「整份 system+历史」降到「仅新增部分」。这正是 Codex「thread_id 终身不变」的直接推论（`client.rs:497-509`）。
3. **对齐 DeepSeek 的 cache prefix unit**（若 6.1 定标显示悬崖源于「未完全匹配前缀单元」）：DeepSeek 命中要求**完整匹配某个持久化单元**，单元在「user 输入末尾 / 模型输出末尾 / 固定 token 间隔」处产生（[DeepSeek 文档](https://api-docs.deepseek.com/guides/kv_cache)）。因此**不要在会话中途改写早期消息**（tool-result pruner 就是改写！）——pruner 触发的每一轮都等于**亲手销毁一个 cache prefix unit**。这三道闸（spill / pruner / compaction）的**触发时机**值得和缓存边界一起看：**把改写集中到「反正要付全价」的时刻（如空闲压缩那一轮），而不是零散地在中途挖中段。**

### 6.4 不建议做的事

- **不要「一直保温」**：会话结束后纯浪费（hub #567 明确列为被否方案）。
- **不要把 5 分钟档的节拍照抄到 DeepSeek 路由**：不同厂商 TTL 差 6–288 倍，节拍必须由 6.1 的实测定标决定。
- **不要为了拉高命中率而牺牲前缀的语义正确性**：OpenAI 官方原话——**「更少的输入 token 即使命中率下降也可能更省钱」**（`prompt-caching#compaction-can-reduce-cache-reuse`）。**命中率是手段，不是指标**；Roni 现有的 `cache_hit_rate_target` 告警（`server/settingsSchema.js:25`）应配套一个**「单位任务总输入成本」**指标，否则会激励出「保温刷命中率」这种负收益行为。

---

## 附：本地证据索引

| 文件 | 内容 |
|---|---|
| `docs/_research_openai_prompt_caching.txt` | OpenAI prompt caching 官方页纯文本（含 Cache lifetime / 对比表 / FAQ） |
| `docs/_research_anthropic.txt`、`docs/_research_anthropic_prewarm.txt` | Anthropic 缓存文档 + Pre-warming 章节 |
| `docs/_research_deepseek_en.txt` | DeepSeek Context Caching 官方页 |
| `docs/_research_gemini.txt` | Gemini context caching 官方页 |
| `docs/_research_codex_client.rs` | `openai/codex` main 分支 `core/src/client.rs`（2690 行） |
| `docs/_research_codex_client_common.rs`、`docs/_research_codex_tools_mod.rs` | Codex prompt/tools 结构定义 |
| `docs/_research_codex_binary_cache_section.txt` | 本机 `codex.exe` 内嵌 caching 指南节选 |
| `docs/_research_codex_audit.md` | 第三方 Codex 缓存审计（含与 main 分支的出入） |
| `docs/_research_hub567.txt`、`docs/_research_volute379.txt`、`docs/_research_ironclaw7921.txt` | 保温/空闲压缩/无 key 的实测与设计 |
| `dsh-cache-hit-99.8-report.md` | Roni 侧 DSH 前缀工程源码考证（§2.7 无保温、§6「未找到」表） |
