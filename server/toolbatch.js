// server/toolbatch.js - 一步内多个工具调用的**分批**规则（v0.3 §7.1 ⑤「并行声明化」的唯一消费点）
//
// 为什么单独成文件：这条规则是纯函数（名字列表 + 上限 → 批次），夹具要能直接打它。
// 为了验一条排序规则而把整个 agent 循环（连同 db 连接池）拖进测试，是没必要的重。
//
// 语义照 DSH 两处实现（2026-09-17 读包核对，`@deepseek-ai/dsh` 0.1.5）：
//   · `dsh-tools` 的 executionMode：`isConcurrencySafe(args) === true` 才算可并行；
//     未声明 / 未注册 / 非法一律 exclusive（"an exact `true` is parallel"）；
//   · `dsh-agent-loop` 的 executeToolCalls / runGroup：独占调用是**屏障**（单独跑），
//     可并行调用在有界池里并发，而提交顺序恒为模型顺序。
// 本仓清单是逐条**显式**声明 parallelSafe 的静态判据，不存在 DSH 那种"按参数现场重判"
// 的入口——清单 schema 里没有这个字段，凭空加一个就是发明（要加得先改清单规范）。
/**
 * 把一步里的调用按"能否并发"分批。
 * 返回的批次**必须顺序执行**；每批内部可并发。批次按下标升序切分，故把结果拍平后仍是模型顺序
 * （提交顺序不变这条不变式就落在这里）。
 * @param {string[]} names 模型顺序的工具名
 * @param {number} maxPar 同一步最大并发数（<=0 / 非法 = 串行，与 settings `max_parallel_tools` 同口径）
 * @param {(name: string) => boolean} isSafe 该工具是否**显式**声明可并行
 * @returns {number[][]} 批次（每批是原始下标，升序）
 */
export function planToolBatches(names, maxPar, isSafe) {
  const n = Number(maxPar);
  const par = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1; // 0/负数/NaN = 串行
  const list = Array.isArray(names) ? names : [];
  const batches = [];
  let pool = [];
  const flush = () => {
    for (let i = 0; i < pool.length; i += par) batches.push(pool.slice(i, i + par));
    pool = [];
  };
  for (let i = 0; i < list.length; i++) {
    // 判据只看"显式 true"：未声明、名字不认识、判据本身抛错 —— 一律按独占（宁可慢，不许踩）
    let safe = false;
    try { safe = isSafe(list[i]) === true; } catch { safe = false; }
    if (safe) { pool.push(i); continue; }
    flush();
    batches.push([i]); // 独占：单独一批，前后都不与别的调用同时在跑
  }
  flush();
  return batches;
}
