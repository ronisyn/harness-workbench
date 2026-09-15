// server/prefix-participants.js - 「缓存影响」声明（引擎方案 v0.3 §4.4.1 规则5 / §7.1 ⑨）
//
// 规则原文：**任何进入请求前缀的组件都必须声明其缓存影响**（学 DS 每个包 README 的强制「KV Cache 影响」小节），
// 并入不变式检查。v0.3 的批次表里 ⑨ 的状态正是「"缓存影响"声明检查**未做**」——本文件补的就是这一条。
//
// 为什么值得单独一张表：前缀缓存按**逐字节**匹配，而"谁在往请求里塞东西"散落在 agent/index/tools 三层。
// 没有这张表，加一个新注入点（比如今天的错题召回）就会在无人察觉的情况下改变前缀行为；
// 有了它，`breaks-prefix` 的名单是**可枚举、可门禁、可评审**的 —— 夹具会核对到源码里那一行真的还在。
//
// 字段：
//   id            组件标识（用于日志/账本/评审）
//   where         system=系统提示（请求最前）｜tools=工具面｜tail=历史之后的尾巴区｜rewrite=整段改写｜out-of-band=不进请求
//   cacheImpact   breaks-prefix=会让整段前缀作废｜tail-only=只影响其后的增量｜warms-prefix=主动把前缀打热｜none=不影响
//   anchors       源码锚点数组（夹具会核对每一条**确实还在**，防这张表烂掉）
//   note          一句实话：为什么是这个影响、有什么已知风险
//
// 2026-09-16 补登记（核对报告 §3.5④：声明表漏登记组件 = C4 的假阴性）：
//   原表 12 条**集中在 agent.js 与尾巴区**，而 `/api/chat` 在历史**之前**还注入了 4 条 system
//   （早期摘要 / 用户自定义指令 / 项目 AGENTS.md / 壳语境），运行期还有 COMPLETION_HINT 与四类护栏、
//   打回提示。它们全部**只追加**（不改写既有消息），但"只追加"这件事本身必须被声明出来 ——
//   否则将来有人把其中任一条改成"插到前面/就地改写"，无人会察觉（老表里根本没有这一行可改）。

// 账本动作名：`prefix:*` 是 C4/C5 的**唯一账本**（audit_log，不新造表）。常量化的理由很实际：
//   写账的三处（agent.js 的 invalidate、index.js 的 assemble、审计分类）各写各的字符串，
//   错一个字母就是**静默不计**——C4 会假装是 0。夹具直接核对常量值，改名人必须一起改。
export const PREFIX_LEDGER = {
  INVALIDATE: 'prefix:invalidate', // C4 非预期：整段前缀作废（首轮/切模型/折叠边界/工具面变更**之外**的断链）
  EXEMPT: 'prefix:exempt',         // C5 豁免：首轮 / 长空闲 / 切模型 / 工具面变更（只报数，不设 0）
  COLLAPSE: 'prefix:collapse',     // C5 豁免：段边界整段折叠（§4.4.1 规则1 允许的那一次改写）
  ASSEMBLE: 'prefix:assemble',     // 2026-09-16 新增：`/api/chat` 组装前缀后的跨轮指纹（**跨 run 改写**的证据）
};

export const PREFIX_PARTICIPANTS = [
  {
    id: 'system-prompt', where: 'system', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/agent.js', pattern: 'export const buildEnvFor' }],
    note: '系统提示是请求第 0 条，也是**唯一**由 buildEnvFor 拼装的内容（节点 0 在会话内逐字节恒定）。ENV 任一字节变化 = 换纪元：**所有会话**下次请求整段重建（实测：+46 tokens 即触发）',
  },
  {
    id: 'skill-load', where: 'tail', cacheImpact: 'tail-only',
    anchors: [
      { file: 'server/agent.js', pattern: 'const appendNewSkills = () => {' },
      { file: 'server/index.js', pattern: '【已载入技能: ' },
    ],
    note: '**2026-09-15 改**：技能全文原先被拼进节点 0（载一次技能 = 前缀作废）。现在两条路径都是"追加到历史之后"——开跑前由 index.js 推进 messages，运行期由 appendNewSkills 推在工具结果之后；角色仍是 system，权威性不变，而它前面的历史照样命中',
  },
  {
    id: 'tools-face', where: 'tools', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/agent.js', pattern: 'toolDefs(ctx.preset' }],
    note: '工具面在请求最前。增删工具/换档位/换壳/MCP 装载 = 新段；轻量面与全量面相差 9,600 tokens。已按 v0.3 §4.4.1 规则3 改为"会话内单向粘滞"（conversations.face_full）：**至多翻转一次**，此后固定',
  },
  {
    id: 'collapse', where: 'rewrite', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/agent.js', pattern: 'maybeCollapseEarly' }],
    note: '段边界整段替换一次 —— 这是唯一允许的改写（§5.3 纪律1）。属预期失效：落 prefix:collapse 账本、不计 C4。'
      + ' 2026-09-16 起它也是 /api/chat 长会话**唯一**的体积控制手段：原来那条"历史 >40 条就只发最近 30 条"的滑窗已按 §4.4.1 规则1 删除（见 index.js 组装段注释）',
  },
  {
    id: 'epoch-warmup', where: 'out-of-band', cacheImpact: 'warms-prefix',
    anchors: [{ file: 'server/epoch.js', pattern: 'checkEpochAndWarm' }],
    note: '不进任何真实请求；换纪元/首次记录后主动发一次最小请求把新前缀打热，避免让第一个真实用户承担重建（如实记费 kind=warmup）',
  },
  {
    id: 'runtime-snapshot', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/agent.js', pattern: '【运行时快照】' }],
    note: '每轮重建但 append 到尾部（早期版本插在历史前会击穿其后全部历史，已改）',
  },
  {
    id: 'bg-notice', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/agent.js', pattern: '【后台任务完成】' }],
    note: '后台任务/子代理完成通知，追加尾部（bgNotices）',
  },
  {
    id: 'knowledge', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/kbgate.js', pattern: 'export function kbBlock' }],
    note: '按需召回三档（explicit/index/none）；注入位置在尾巴区，且 none 档一个字节都不注入（RA-09）',
  },
  {
    id: 'lesson-recall', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/lessonrecall.js', pattern: 'export function lessonBlock' }],
    note: '错题本按需召回（OP-12）；只给沾边的标题级条目，正文留库',
  },
  {
    id: 'resume-hint', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/index.js', pattern: 'resumeHint(' }],
    note: '断点恢复现场提示，追加尾部',
  },
  {
    id: 'history-early-summary', where: 'system', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/index.js', pattern: '【早期对话摘要，无需回复】' }],
    note: '**2026-09-16 补登记**：长会话（>40 条）的早期摘要注入在历史之前。它只在"摘要刚生成/刚变化"那一次让前缀分叉一次，此后摘要内容不变 ⇒ 前缀稳定；跨轮有没有真的改写，看 prefix:assemble 的指纹判定（不在这里写死数字，数字会过期）',
  },
  {
    id: 'history-user-prompt', where: 'system', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/index.js', pattern: '【用户自定义指令】' }],
    note: '**2026-09-16 补登记**：settings.systemPrompt 注入在历史之前，改一次它=换前缀（与改系统提示同级）。它不在会话内变，所以不会每轮断链；但改设置后所有会话下次请求都会整段重建——这一条必须被看见',
  },
  {
    id: 'history-project-agents', where: 'system', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/index.js', pattern: '说明（AGENTS.md）】' }],
    note: '**2026-09-16 补登记**：projects/<project>/AGENTS.md 全文（≤16000 字符）注入在历史之前。文件一改，该项目的每条会话下次请求都整段重建——这就是"进前缀就必须声明"的典型例子',
  },
  {
    id: 'history-shell-context', where: 'system', cacheImpact: 'breaks-prefix',
    anchors: [{ file: 'server/index.js', pattern: '【壳语境：' }],
    note: '**2026-09-16 补登记**：壳 persona/领域说明注入在历史之前（非 default 壳才注入）。换壳=换前缀（§4.4.1 规则3 的"新段"同源）',
  },
  {
    id: 'completion-hint', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/agent.js', pattern: 'const COMPLETION_HINT = [' }],
    note: '**2026-09-16 补登记**：每轮工具结果后的"完成度评估"提示。按 5.8 消息卫生**每轮只保留最新一条**（pop 旧条 + 追加新条）：新条在尾部、旧条在被 pop 的位置——但两者内容**逐字节相同**（常量），所以前缀一个字节都不变，仍是只追加',
  },
  {
    id: 'guard-hints', where: 'tail', cacheImpact: 'tail-only',
    anchors: [
      { file: 'server/agent.js', pattern: '【平台强制检测：本轮声称完成但无工具调用】' },
      { file: 'server/agent.js', pattern: '【平台强制检测：本轮只输出行动承诺、未调用任何工具】' },
      { file: 'server/agent.js', pattern: '请【停止原样重试】' },
      { file: 'server/agent.js', pattern: '请【改变策略】' },
      { file: 'server/agent.js', pattern: '【新段】' },
    ],
    note: '**2026-09-16 补登记**：护栏与打回提示（假完成打回 / 假开始打回 / 连败提示 / 死循环提示 / 新段提示）全部 append 到尾部；它们出现与否只影响其后的增量，不改写任何既有消息（原表连一条都没登记，等于"这些注入点无人看着"）',
  },
  {
    id: 'prefix-assemble', where: 'out-of-band', cacheImpact: 'none',
    anchors: [
      { file: 'server/history.js', pattern: 'export function detectPrefixRewrite' },
      { file: 'server/index.js', pattern: 'PREFIX_RECORD_ACTION' },
    ],
    note: '**2026-09-16 新增（核对报告 §3.5③ 的地基）**：不进请求，只在每次组装完前缀后落一行跨轮指纹（prefix:assemble）。它是 **C4 在"跨 run"维度上的唯一机检** —— agent.js 的 diffCore 每 run 重置 prevCore，看不见"同一会话两次请求之间历史被改短/换头"。判据不设阈值：上一轮记的 cnt 条必须逐字节仍是本轮前缀的开头，否则记 prefix:invalidate',
  },
  {
    id: 'readonly-intent', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/index.js', pattern: '【只读规划意图（本轮）】' }],
    note: '本轮只读意图约束，追加尾部；无持久状态',
  },
  {
    id: 'tool-result', where: 'tail', cacheImpact: 'tail-only',
    anchors: [{ file: 'server/tools/spill.js', pattern: 'export function spillToolResult' }],
    note: '工具结果接在历史之后；体积由 cap + 派生字节天花板约束，超限溢出到 spill/ 并只留预览+定位符',
  },
];

/** 声明检查（可被启动自检或夹具调用）：结构合法性 + 前缀破坏者名单。 */
export function auditPrefixDeclarations() {
  const WHERE = ['system', 'tools', 'tail', 'rewrite', 'out-of-band'];
  const IMPACT = ['breaks-prefix', 'tail-only', 'warms-prefix', 'none'];
  const bad = [];
  for (const p of PREFIX_PARTICIPANTS) {
    if (!p.id) bad.push('缺 id');
    if (!WHERE.includes(p.where)) bad.push((p.id || '?') + ' where 非法: ' + p.where);
    if (!IMPACT.includes(p.cacheImpact)) bad.push((p.id || '?') + ' cacheImpact 非法: ' + p.cacheImpact);
    if (!Array.isArray(p.anchors) || !p.anchors.length) bad.push((p.id || '?') + ' 缺源码锚点');
    else for (const a of p.anchors) if (!a || !a.file || !a.pattern) bad.push((p.id || '?') + ' 锚点结构非法');
    if (!p.note || p.note.length < 8) bad.push((p.id || '?') + ' 缺一句实话（note）');
  }
  return {
    n: PREFIX_PARTICIPANTS.length,
    bad,
    breakers: PREFIX_PARTICIPANTS.filter((p) => p.cacheImpact === 'breaks-prefix').map((p) => p.id).sort(),
    tailOnly: PREFIX_PARTICIPANTS.filter((p) => p.cacheImpact === 'tail-only').length,
  };
}
