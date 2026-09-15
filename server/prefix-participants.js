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
    note: '段边界整段替换一次 —— 这是唯一允许的改写（§5.3 纪律1）。属预期失效：落 prefix:collapse 账本、不计 C4',
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
