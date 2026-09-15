# DSH「缓存命中 99.8%」源码考证

源码根（下称 `$PKG`）：`C:\Users\颜文\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`。全程只读，未修改任何文件。

## 0. 一句话结论

99.8% 不是 provider 直接报的原始比率，而是 `prompt_cache_hit_tokens / prompt_tokens`（**整会话累计**）经过一个**「绝不四舍五入到 100%」的显示函数**渲染的结果。只有当真实命中率 > 99.5%（整数位会凑成 100）时，右侧才会出现 `99.x`。

## 1. 指标定义（分子 / 分母 / 在哪算）

**显示点**：右下角 pill = `UsagePill`。文案 `$PKG\dsh-client-ui-chat\lib\client.js:2630` → `"stats.cacheHit": "缓存命中 {percent}%"`

`$PKG\dsh-client-ui-chat\lib\client.js:4014`
```js
function UsagePill({ usage, t, dialog }) {
    const total = billedInputTokens(usage) + usage.outputTokens;
    const cacheHit = cacheHitPercent(usage);
    const cacheHitText = cacheHit !== null ? t("stats.cacheHit", { percent: cacheHit }) : null;
```
**分子分母** `$PKG\dsh-client-ui-chat\lib\client.js:3926,3932,3941`
```js
/** Display-ready cache-hit share of prompt-side input over the whole durable log. */
function cacheHitPercent(usage) { return formatCacheHitPercent(usage.cacheReadTokens, billedInputTokens(usage)); }
/** Sum the three disjoint prompt-side billing buckets. */
function billedInputTokens(usage) { return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens; }
```
分母 = 会话日志累计的 prompt 侧三桶之和（DeepSeek 无 cacheWrite ⇒ 即 `prompt_tokens` 累计）；分子 = `cacheReadTokens` 累计。**按会话累计，非单次请求。**

**累计值来源（host 侧 durable 折叠）** `$PKG\dsh-token-meter\lib\index.js:428`
```js
if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return state;
const sample = usageOf(event); if (sample === void 0) return state;
const buckets = bucketsFrom(sample);
const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last.buckets : void 0;
if (previous !== void 0 && bucketsEqual(previous, buckets)) return state;
return { totals: addReplacing(state.totals, previous, buckets), last: { turn, step, buckets } };
```
`:424` 重试语义：`llm/retry-started` 置空 `last`，避免同一 step 重复累加。

**桶的换算（算错这里全盘错）** `$PKG\dsh-llm-deepseek\lib\index.js:1145`
```js
/* DeepSeek's `prompt_tokens` INCLUDES cache hits
   (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`);
   the harness TokenUsage convention is DISJOINT counts, so cache reads are
   subtracted out of `inputTokens`. */
const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
return { inputTokens: usage.prompt_tokens - (cacheRead ?? 0), ...,
         ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {} };
```
**「99.8」怎么印出来** `$PKG\dsh-client-ui-chat\lib\client.js:3353`（doc：`Display-ready cache-hit share without rounding a partial hit to 100%.`）
```js
function formatCacheHitPercent(cacheReadTokens, promptTokens, decimalPlaces = 0) {
    if (promptTokens === 0) return null;
    const missedInputTokens = promptTokens - cacheReadTokens;
    if (missedInputTokens === 0) return "100";
    const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
    if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
    let distinguishingPlaces = 1, scaledDoubleGap = missedInputTokens * 200;
    const denominatorTens = Math.floor(promptTokens / 10);
    while (scaledDoubleGap <= denominatorTens) { scaledDoubleGap *= 10; distinguishingPlaces += 1; }
    const denominatorOnes = promptTokens % 10;
    let roundedLoss = 5;
    for (let loss = 1; loss < 5; loss += 1) {
        const factor = loss * 2 + 1;
        const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
        if (scaledDoubleGap <= threshold) { roundedLoss = loss; break; }
    }
    return `99.${"9".repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}
```
读法：pill 用 `decimalPlaces=0`，整数一旦会进位成 `100` 就走诚实分支，输出永远是 `99.9 / 99.8 / 99.99…`（保证 <100 的最少小数位）；miss 越少 nines 越多。**显示 99.8 ⇒ 真实累计命中率 ≈[99.75%, 99.85%)**。turn 级气泡同函数、`decimalPlaces=1`、分母 `totalTokens - outputTokens`（`client.js:3492`）。

## 2. 靠什么把命中率做高

### 2.1 系统提示逐字节稳定 —— 动态内容被分流到另一条通道
`$PKG\dsh-system-prompt\lib\index.js:331`（assemble 的产物；`:96` 是 section 排序 `a.order - b.order || compareNames(a.name, b.name)`）
```js
const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections);
const assembly = {
    sections: sectionDefinitions.map((section) => ({ name: section.name, text: ... })),        // → system prompt
    contexts: runtimeContextSuppressed ? [] : [...contextByName.values()].sort((a, b) => a.order - b.order).map(...),  // → 追加式 user 消息
    tools: orderTools(collected, this.toolOrder, knownNames), variables
};
```
`$PKG\dsh-system-prompt\lib\index.js:130`
```js
function joinContextSections(sections) {
    const body = sections.map((section) => section.text).join("\n\n");
    if (body.length === 0) return "";
    return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
}
```
⇒ 时间/环境这类每轮会变的量**不写进 system prompt**，而是变成一个 user 消息。且只在真变时追加 `$PKG\dsh-agent-loop\lib\index.js:336`
```js
project(current, sections) {
    if (this.retained === void 0 && current.length === 0) return;
    const snapshot = current.length === 0 ? CLEARED : current;
    if (this.retained?.text === snapshot) return;      // 未变 ⇒ 零事件
    return createUserMessage({ content: [{ type: "text", text: snapshot }], source: ... });
}
```
时间上下文走的正是这条通道 `$PKG\dsh-time-context\lib\index.js:95`：`Eligible steps add durable, source-attributed time readings to the request history.`

### 2.2 系统提示更新用「追加」而不是「改写」（DeepSeek 路由专属）
`$PKG\dsh-llm-deepseek\lib\index.js:1849` → `{ id: "deepseek-flash", ..., systemPromptUpdate: "in-history" }`；类型唯一取值 `$PKG\dsh-llm\lib\typert.host.js:471` → `export type SystemPromptUpdate = 'in-history';`
`$PKG\dsh-agent-loop\lib\index.js:233`（类文档）
```
* A capable continuing series appends changed nonempty text after the
* cached history. An incapable route, broken series, or cleared prompt instead
* normalizes the first system node and empties later active nodes.
```
`$PKG\dsh-agent-loop\lib\index.js:274`
```js
if (!input.inHistory || input.startsSeries || rendered.length === 0) {
    const updates = nodes.slice(1).filter((node) => node.text !== "").map((node) => this.replace(node.seq, ""));
    if (head.text !== rendered) updates.push(this.replace(head.seq, rendered));
    return updates;                       // ← 破坏性路径
}
if (latest.text === rendered) return [];  // ← 无变化 ⇒ 零事件
return [{ message: createSystemMessage(rendered, SOURCE), intent: { surfaceOp: "append" } }];  // ← 追加，保前缀
```
前缀何时算断了 `$PKG\dsh-agent-loop\lib\index.js:1021`：`startsSeries: startsRequestSeries || this.requestSurfaceGeneration !== this.session.surface.replaceGeneration || this.toolsChanged(assembly.tools)`；`toolsChanged` 在 `:909` 用 `!headerEquals(baseline, canonicalHeader({ ...baseline, tools: [...tools] }))` 判定。

### 2.3 工具定义稳定 + 每轮重排出同一结果
`$PKG\dsh-system-prompt\lib\index.js:84,91,99`
```js
if (toolOrder === void 0) return tools.sort(compareToolNames);
/** Code-unit name comparison — locale-independent, so the order is identical on every machine. */
function compareNames(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** Order tool schemas lexicographically by name. */
function compareToolNames(a, b) { return compareNames(a.name, b.name); }
```
`dsh-tools` 同款 `$PKG\dsh-tools\lib\index.js:300`：`// Regenerate from the calling scope's visible tools in stable order.`

### 2.4 消息历史：默认只追加，改写只在三个条件下发生
surface 只有两种操作（`$PKG\dsh-token-meter\lib\index.js:154` `planSurfaceTokens`）：`"append"` 与 `replace(startSeq,endSeq)`。**replace 来源仅三类**：① 系统提示头规范化（2.2）② compaction summary ③ tool-result pruner。
前缀断裂被显式记账 `$PKG\dsh-agent-loop\lib\index.js:1175`
```js
const startsSeries = startsRequestSeries || this.requestSurfaceGeneration !== surfaceGeneration;
if (!this.requestHeaderLogged) { this.session.append("request/header", { header, reason: baseline === void 0 ? "initial" : "resume" }); ... }
else if (baseline === void 0 || !headerEquals(baseline, header)) this.session.append("request/header", { header, reason: "change", ...startsSeries ? { startsSeries: true } : {} });
else if (startsSeries) this.session.append("request/header", { header, reason: "series" });
```
路由配置被当缓存敏感量 `$PKG\dsh-llm\lib\types\call-config.js:1`
```
* Provider routing, model, reasoning effort, and sampling values are request-header
* state that can affect cache reuse; request waterfalls replace them and the loop
* logs changed snapshots instead of allowing silent per-call drift.
```
请求与消息深冻结后跨轮复用 `$PKG\dsh-agent-loop\lib\index.js:1204`：`for (const message of session.deriveMessages()) { if (this.frozenMessages.has(message)) continue; deepFreeze(message); this.frozenMessages.add(message); }`

### 2.5 工具结果进上下文：三道闸
**① spill（默认 50KB，落盘 + head/tail 预览）** `$PKG\dsh-base\cordis.patch.yml:383` → `- id: spill-policy / name: '@deepseek-ai/dsh-spill-policy' / config: { maxInlineBytes: 50000 }`
`$PKG\dsh-spill-policy\lib\index.js:27`
```
* a `tools/post-execute` result transformer that keeps oversized plain-text tool
* results out of the model's context. When a final result's UTF-8 size exceeds
* `maxInlineBytes`, it saves the FULL text to a session-scoped spill artifact
* (`ctx.spillStore`) and replaces the model-facing result with a bounded
* head/tail preview plus the backend's locator and retrieval guidance.
```
**② tool-result pruner（8192 字符，只挖中段）** `$PKG\dsh-compaction-tool-result-pruner\lib\index.js:8,10,126`
```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const DEFAULTS = deepFreeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
/* Prune every over-budget tool result from one stable current-surface snapshot.
   Each replacement preserves the complete event data except for `content`, cites
   the shadowed node so replay can recover the replacement input, and is
   immediately preceded by a `compaction/prune` shadow-price event pricing the ... */
```
预设实配 `$PKG\dsh-agent-presets\presets\standard\agent.cordis.yml:151` → `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024`。
**③ 通用有界截断库** `$PKG\dsh-output-retention\lib\index.js:2`：`A dependency-light **retention** library: bounded model-facing output for tools that must cap how much context they return.`

### 2.6 compaction：阈值 / 保留尾 / 「压缩请求本身也吃缓存」
`$PKG\dsh-compaction-basic\lib\index.js:15` → `DEFAULT_THRESHOLD_RATIO = .8;` `DEFAULT_RETAIN_RATIO = .16;`；`:111` → `thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio)`。
system 头永不被压 `$PKG\dsh-compaction-basic\lib\index.js:383` → `A system/message at surface node 0 is never inside the range`，实现 `const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1;`
压缩**不重建缓存，而是伪装成同一会话的续写** `$PKG\dsh-compaction-basic\lib\index.js:213`
```
* The summarization directive, delivered as the FINAL user message after the
* replayed conversation rather than as a distinct summarizer system prompt.
* Keeping the conversation's own system prompt, tools, and message prefix in
* front of it makes the auxiliary call a genuine prefix of the last routed
* request, so the provider's KV cache is reused instead of invalidated.
```
`:654` 同义：`The summarizer appends only the compaction instruction after this, so the call is a genuine prefix of the conversation and reuses the provider's KV cache.`；`:848`：`…whose prefix reuses the conversation's own system prompt, tools, and messages so the provider's KV cache is not invalidated.`
⇒ 一次压缩 ≈ 一次几乎全命中的请求，成本只算新写的 summary 输出。

### 2.7 预热 / 保温 / 空闲失效
**未找到。** 全 host 侧 `dsh-*` 包检索 `warm/prewarm/keepalive/ping/heartbeat/prefill/idle TTL`：`warm` 只命中 `dsh-compaction-basic:261` 的注释（指复用暖前缀，非主动保温）与 `dsh-client-ui-commands`/`dsh-client-ui-input-trigger` 的**命令目录预取**（与 prompt cache 无关）；`keepAlive` 只在 `dsh-api-gateway` 的 WebSocket 重连里。**没有任何空闲过期处理、心跳续期或 TTL 配置。**

## 3. 最有价值的「踩坑」注释（逐条抄录）

1. `$PKG\dsh-agent-loop\lib\index.js:233` — `A capable continuing series appends changed nonempty text after the cached history. An incapable route, broken series, or cleared prompt instead normalizes the first system node and empties later active nodes.`
2. `$PKG\dsh-compaction-basic\lib\index.js:213` — `…makes the auxiliary call a genuine prefix of the last routed request, so the provider's KV cache is reused instead of invalidated.`（压缩器必须伪装成会话续写，否则整段缓存作废）
3. `$PKG\dsh-compaction-basic\lib\index.js:848` — `…so the provider's KV cache is not invalidated.`
4. `$PKG\dsh-llm\lib\types\call-config.js:1` — `…can affect cache reuse; request waterfalls replace them and the loop logs changed snapshots instead of allowing silent per-call drift.`
5. `$PKG\dsh-llm-deepseek\lib\index.js:1145` — `DeepSeek's prompt_tokens INCLUDES cache hits … the harness TokenUsage convention is DISJOINT counts, so cache reads are subtracted out of inputTokens.`
6. `$PKG\dsh-client-ui-chat\lib\client.js:3353` — `Display-ready cache-hit share without rounding a partial hit to 100%.`（宁可印 99.8 也不印 100）
7. `$PKG\dsh-spill-policy\lib\index.js:54,58` — `read is skipped by the model-facing arm to avoid a read → spill → read again loop`；`A spill failure must NEVER turn a successful tool call into an isError or hide the inline result.`
8. `$PKG\dsh-system-prompt\lib\index.js:91` — `Code-unit name comparison — locale-independent, so the order is identical on every machine.`
9. `$PKG\dsh-compaction-basic\lib\index.js:383` — `A system/message at surface node 0 is never inside the range`（保留 system 头 = 保留缓存前缀）

## 4. 会话之间：新会话的第一个请求

- **没有跨会话共享前缀缓存的显式机制（未找到）**：无 `canonical prefix`、无跨会话 pin。跨会话能命中的只有字节级天然相同的前缀（同 preset ⇒ 同 system prompt + 同 tool schema）。
- 显式复用的唯一形态是 **fork 子代理** `$PKG\dsh-subagent-fork-in-process\lib\index.js:4,23`
```js
* runs each child as a child Agent SEEDED with a prefix of the parent's session
* log … The seed ends at the last `turn/end`: the current tool-call turn is
* unbalanced and cannot be replayed as a valid child session.
function completedTurnPrefix(parent) {
    const events = parent.session.snapshotEvents();
    const lastEnd = events.findLast((e) => e.type === "turn/end");
    if (lastEnd === void 0) return [];
    return events.slice(0, lastEnd.seq + 1);
}
```
⇒ 子会话首条消息序列是父会话的**严格前缀**，第一次请求即全前缀命中。resume 走同一套 seed（`$PKG\dsh-session\lib\index.js:1086` 落 `session/end-seed`）。
- 「固定前缀单独缓存」的思想存在但形式不同：**前缀里的每一段都必须是 surface 上的不可变节点** —— system prompt 占 node 0 且永不进压缩范围，tool schema 走 request header 而非消息体，动态量走 context 快照通道（2.1）。**没有独立的"前缀缓存对象"。**

## 5. 可移植到另一个 agent 平台的 5 条做法（按 收益/成本 排序）

1. **把动态内容从 system prompt 里赶出去**：静态 sections → 系统提示；动态 contexts → 追加式 user 快照，内容相等则零事件。收益最高、成本最低（一次提示词装配分层）。
2. **工具 schema 每轮确定性排序**（code-unit 比较，非 locale），并把 schema 当"缓存敏感量"记账；集合一变就显式声明新链条开始。收益高、成本低。
3. **压缩器必须是会话本身的"续写"**：保留原 system prompt + tools + 前导消息，压缩指令作为最后一条 user 消息追加，使压缩请求 = 原请求的真前缀。收益高（压缩从全量重算变近似全命中）、成本中。
4. **三层有界化**：工具自带预算（retention）→ 超 50KB 落盘并只回 head/tail 预览 + 定位符（spill）→ 最后才允许改写历史（pruner 8192 字符，只挖中段、事件可回放）。收益中高、成本中高。
5. **指标诚实性**：分母做互斥桶归一（`uncached + cacheRead + cacheWrite`），显示端禁止把部分命中四舍五入成 100%（整数会凑 100 时自动提高小数位，输出保证 <100 的最紧值）。收益中、成本极低（一个纯函数）。

## 6. 明确「未找到」

| 项 | 结论 |
|---|---|
| 缓存预热 / 保温 / 心跳 / warmup 请求 | 未找到 |
| 空闲多久缓存失效的处理 | 未找到（无 TTL 配置、无相关注释） |
| 跨会话共享公共前缀的显式机制 | 未找到（唯一形态是 fork seed 父会话前缀） |
| 显式 `cache_control` 断点标记 | 仅 `dsh-llm-pi-ai`（Anthropic 格式）有 `cacheControlFormat`/`supportsCacheControlOnTools`；DeepSeek 路由不使用 |
| 主动"重建缓存"逻辑 | 未找到（策略是**避免**失效，而非重建） |
