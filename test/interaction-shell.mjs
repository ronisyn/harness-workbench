// test/interaction-shell.mjs —— 夹具用的**离线模型壳（脚本版）**（`node --import <本文件> server/index.js` 起真服务时预载）
//
// 与 `test/offline-model-shell.mjs` 同源（那一个是"固定脚本"，本文件是"按标记选脚本"）：
//   · ① `chatStreamWithTools.impl`：gateway 自己留的官方 test-hook，换掉真正的模型实现；
//   · ② `globalThis.fetch` 闸门：任何发往非本机地址的请求当场抛错 —— **不真调模型**不靠自觉，靠拦截。
// 为什么要有本文件：本批要证明的几件事都发生在**真事件流**上（tool_done 的溢出字段、progress 帧、
// 续订缺口帧、收尾沉淀卡），而这些帧只有在真跑一轮 agent 循环时才发得出来。夹具侧
// （test/interaction-e2e.test.mjs）用**用户消息里的标记**挑这一轮脚本，于是同一个服务进程能跑完几个场景。
//
// 脚本（标记 → 行为）：
//   【大输出】   第 1 轮 grep_search 命中文档（30 条命中 ≈ 7KB ⇒ 触发外层溢出）；第 2 轮出正文
//   【小结果】   第 1 轮 list_dir（小结果，**不**触发溢出）；第 2 轮出正文
//   【失败后成功】第 1 轮 read_file 读一个不存在的文件（失败）；第 2 轮 read_file 读存在的文件（成功）；第 3 轮出正文
//   【待沉淀】   直接出正文（正文里带完整复盘三段 ⇒ 收尾时"受限自动沉淀"应当抽出候选）
//   【无候选】   第 1 轮 list_dir；第 2 轮出正文（这段经历里没有够格的候选 ⇒ 不许建卡、不许发帧）
//   【有计划】   第 1 轮 plan_tasks（4 步）；第 2 轮 plan_done(1)；第 3 轮出正文（进度帧里的"计划第几步"应当跟着走）
//   其它        直接出正文
//
// ⚠️ 全程只用**只读工具**（read_file / list_dir / grep_search）：本机沙箱在迁移期是显式降级档，
//    `run_command` 那一类会弹审批卡等人（夹具里没人点），所以夹具刻意不碰它 —— 这不是"绕过审批"，
//    而是把这条夹具要验的东西（事件帧）与审批面解耦。
import fs from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(u)) {
    return Promise.reject(new Error('[interaction-shell] 已阻断外部请求（夹具不允许真调模型）: ' + u));
  }
  return realFetch(url, opts);
};

const { chatStreamWithTools } = await import('../server/llm/gateway.js');

const LOG = process.env.RW_INTERACTION_SHELL_LOG || '';
const note = (rec) => { if (LOG) { try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n'); } catch { /* 观测失败不影响对话 */ } } };

const MARK = /【(大输出|小结果|失败后成功|待沉淀|无候选|有计划)】/;
// 剧情状态按**整条用户消息**记（不是按标记）：同一个标记在不同会话里要能重新从第 1 轮开始
// （否则"上一轮已经跑过这个标记"会让这一轮直接出正文，夹具就会看到少一轮的假事实）；
// 而"失败后成功"那条脚本靠的正是**同一句话被反复喂**（同一轮里 n 递增）。
const state = new Map(); // 用户消息 → 这条消息已经跑到第几轮（同一进程内跨请求累计）

let call = 0;
chatStreamWithTools.impl = async (provider, model, msgs, defs, opts = {}) => {
  call += 1;
  const lastUser = [...(msgs || [])].reverse().find((m) => m && m.role === 'user');
  const text = String((lastUser && lastUser.content) || '');
  const hit = MARK.exec(text);
  const key = hit ? hit[1] : '(默认)';
  const n = (state.get(text) || 0) + 1;
  state.set(text, n);
  note({ call, key, round: n, tools: (defs || []).map((d) => d.function && d.function.name).filter(Boolean).length });

  const WS = process.env.RW_WORKSPACE || '.';
  const usage = { tokens_in: 1200, tokens_out: 30, cache_hit: 1000, cache_miss: 200 };
  const done = (t) => {
    if (opts.onContent) opts.onContent(t);
    return { content: t, reasoning: '', finishReason: 'stop', usage, streamed: false };
  };
  const callTool = (name, args) => ({
    content: '', reasoning: '夹具脚本：' + name, finishReason: 'tool_calls',
    toolCalls: [{ id: 'call_fixture_' + encodeURIComponent(key) + '_' + n, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    usage, streamed: false,
  });

  if (key === '大输出') {
    if (n === 1) return callTool('grep_search', { path: WS + '/needles.txt', pattern: 'NEEDLE', maxPerFile: 30 });
    return done('（离线壳回复）大输出的内容已经看过一遍了。');
  }
  if (key === '小结果') {
    if (n === 1) return callTool('list_dir', { path: WS });
    return done('（离线壳回复）目录已列出。');
  }
  if (key === '失败后成功') {
    if (n === 1) return callTool('read_file', { path: WS + '/not-there.txt' });
    if (n === 2) return callTool('read_file', { path: WS + '/small.txt' });
    return done('（离线壳回复）文件读到了。');
  }
  if (key === '无候选') {
    if (n === 1) return callTool('list_dir', { path: WS });
    return done('（离线壳回复）看过目录了，没有别的要沉淀的。');
  }
  if (key === '有计划') {
    if (n === 1) return callTool('plan_tasks', { tasks: '第一步：看目录\n第二步：读文件\n第三步：改代码\n第四步：跑测试' });
    if (n === 2) return callTool('plan_done', { index: 1 });
    return done('（离线壳回复）按计划推进中。');
  }
  return done('（离线壳回复）好的。');
};
