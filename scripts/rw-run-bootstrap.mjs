// scripts/rw-run-bootstrap.mjs - headless 入口的**启动前置**（可注入的那一小块）
//
// 依据：《RW-Agent引擎架构优化方案 v0.3》§4.1「单进程可启动」——一次性入口不该要求
// "先把 Web 服务起过一遍"才能在干净机器上跑第一条命令。
//
// 为什么单独一个文件（而不是写在 rw-run.mjs 的 main() 里）：main() 会 process.exit，夹具碰不得；
// 而"跑之前必须先把存储备好"是一条**要能机检的语义**——抽成注入式的小函数，夹具才能断言
// "它确实在建表之后才去跑任务"（依赖注入这一做法与 server/channels/run-turn.js 的 runChannelTurn 同一路数）。
//
// 它做的事与 `node server/index.js` 启动时是**同一件**（server/db.js:initSchema）：
//   CREATE TABLE IF NOT EXISTS + INSERT IGNORE + 迁移链上已应用的直接跳过 —— 全部幂等，重复执行无副作用。
// 不吞异常：库里够不着 / 迁移链有缺口时如实抛，由调用方转成结构化失败（"失败必须出声"）。

/**
 * 备好存储：建表 + 迁移 + 种子（幂等）。
 * @param {{initSchema?:Function}} deps 注入点（生产传 server/db.js 的 initSchema；夹具传假的）
 * @returns {Promise<{prepared:boolean, note:string}>} `prepared=false` 只出现在"没注入 initSchema"时——
 *          那是**没做这件事**，不是"做了但没事"，所以照实说明而不是假装成功。
 */
export async function bootstrapStorage({ initSchema } = {}) {
  if (typeof initSchema !== 'function') return { prepared: false, note: '未注入 initSchema（调用方需自行保证库结构就绪）' };
  await initSchema();
  return { prepared: true, note: '建表/迁移已结算（幂等）' };
}
