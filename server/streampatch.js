// server/streampatch.js - RA-37 G1 补流对账（纯函数，不碰 HTTP／不碰 DB）
// 问题：`delta` 原本只覆盖"模型真流出来的正文"，而落库正文还会被后置加工——
//   C4 自动续写段、finish_reason=length 的截断提示、假完成的强制加注前缀、空答兜底摘要。
//   这些字节从不经过 delta，于是"事件流拼出来的正文 ≠ 落库正文"，"仅靠事件流重建"就是空话。
// 解法：拿本轮**实际流过**的文本与**将要落库**的正文对账，只补发差额，不整段重发。
//
// 为什么单独成模块：这段判断原来内联在 2400 行的 /api/chat 里，既抄了一份到实测脚本，
//   又因为内联而把一个 const 的块作用域写错（result 越出作用域 → 每轮对话都在 done 前中断）。
//   抽成纯函数后，它可被夹具逐条验证，也不用再靠"跑一次真对话"才能发现。

/**
 * 计算"还差哪一段没发给客户端"。
 * @param {string} stored 将要落库的正文（`answer`）
 * @param {string} streamed 本轮真正经 delta 发出去的文本（`result.streamedText`）
 * @returns {{head:string, tail:string, mode:string}} 需要补发的前缀与后缀；mode 用于归因日志
 */
export function streamPatch(stored, streamed) {
  const answer = String(stored ?? '');
  const sent = String(streamed ?? '');
  if (!answer) return { head: '', tail: '', mode: 'empty' };
  if (!sent) return { head: '', tail: answer, mode: 'no-stream' };          // 声称流式却没记到 → 整段补发
  if (answer === sent) return { head: '', tail: '', mode: 'exact' };         // 完全一致 → 什么都不补
  if (answer.startsWith(sent)) return { head: '', tail: answer.slice(sent.length), mode: 'appended' };   // 后置追加
  if (answer.endsWith(sent)) return { head: answer.slice(0, answer.length - sent.length), tail: '', mode: 'prefixed' }; // 前置加注
  if (answer.includes(sent)) {                                              // 中间夹了东西：头尾都补
    const at = answer.indexOf(sent);
    return { head: answer.slice(0, at), tail: answer.slice(at + sent.length), mode: 'wrapped' };
  }
  return { head: '', tail: answer, mode: 'mismatch' };                      // 对不上账：整段补发，由调用方告警
}
