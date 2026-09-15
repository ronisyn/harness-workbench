// scripts/child-emit.js - 子代理事件转发（纯函数，无依赖，被 server/subagent.js 与 RA-37 实测脚本共用）
// 抽出来的原因：RA-37 的"仅靠事件流重建"实测需要**与线上同一条**事件转发路径，
// 而不是在脚本里另写一份等价逻辑（另写一份就等于没测线上那条）。
// 转发规则（前缀标记，展示为 "子:工具名"，与直播效果等效）：
//   tool_start/tool_done → 工具名加 "子:"、seq 平移到该子代理独占的号段、附 sub=子代理 id
//   think → 加 "[<名称>思考] " 前缀
//   approval/ask → desc/question 加 "[<名称>] " 前缀（保证前端能看出是谁在问）
//   agent_thinking → 附 sub（轮次事件不共享连续号，不需要平移）
export function childEmit(parentEmit, subId, label, seqBase) {
  if (!parentEmit) return null;
  return (ev) => {
    if (ev.type === 'tool_start') parentEmit({ type: 'tool_start', tool: { name: '子:' + ev.tool.name, args: ev.tool.args, seq: seqBase + ev.tool.seq, status: 'running', sub: subId } });
    else if (ev.type === 'tool_done') parentEmit({ type: 'tool_done', tool: { ...ev.tool, name: '子:' + ev.tool.name, seq: seqBase + ev.tool.seq, sub: subId } });
    else if (ev.type === 'think') parentEmit({ type: 'think', text: '[' + label + '思考] ' + ev.text });
    else if (ev.type === 'approval') parentEmit({ type: 'approval', id: ev.id, desc: '[' + label + '] ' + ev.desc });
    else if (ev.type === 'ask') parentEmit({ type: 'ask', id: ev.id, question: '[' + label + '] ' + ev.question, options: ev.options });
    else if (ev.type === 'agent_thinking') parentEmit({ type: 'agent_thinking', round: ev.round, sub: subId });
  };
}
