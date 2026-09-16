// test/tool-parallel.test.mjs - v0.3 §7.1 ⑤「并行声明化」的**消费者**夹具
//
// 为什么要有这份夹具：清单逐条声明了 `parallelSafe`（`test/manifest-fields.test.mjs` 只保证"声明写全了、
// 是布尔"），但"声明"与"声明被谁读"是两件事——2026-09-16 之前，引擎是**每 maxPar 个切一块、无差别并发**，
// 于是 `parallelSafe:false` 的写入类工具会和兄弟调用同时在改同一份文件、同一张表。声明没人读＝白写。
// 本夹具钉住三件事：
//   ① 分批规则本体（纯函数 planToolBatches）：可并行的进池、独占的单独一批、判据一律"显式 true"；
//   ② 判据单一出处（registry.isParallelSafe）：静态问清单、动态问条目、认不出来=独占；
//   ③ **真代码路径**（agent.runToolBatches）：用"记录同时在跑几个"的方式证明独占真的不与他人重叠，
//      并证明提交顺序恒为模型顺序（照 DSH `dsh-agent-loop` 的不变式：dispatch overlap，result 保持模型序）。
// 语义基准（2026-09-17 读包核对 @deepseek-ai/dsh 0.1.5，两处）：
//   · `dsh-tools` executionMode："an exact `true` is parallel; unknown, hidden, undeclared, invalid ⇒ exclusive"；
//   · `dsh-agent-loop` executeToolCalls/runGroup：独占调用是屏障，可并行调用走有界池。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planToolBatches } from '../server/toolbatch.js';
import { isParallelSafe, registerDynamicTools, unregisterDynamicTools } from '../server/tools/registry.js';
import { runToolBatches } from '../server/agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 源码级判据先去注释再匹配（本仓既有写法）：注释里"提到"某个字符串不算"代码里有"
const stripComments = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// 真实清单里的三种工具名（不另造名字：夹具必须用**生产里真会出现的**判据去打）
const SAFE = ['read_file', 'grep_search', 'list_dir'];   // 清单里 parallelSafe:true
const EXCLUSIVE = ['write_file', 'edit_file'];           // 清单里 parallelSafe:false

const isSafeOf = (names) => (n) => names.includes(n);

// ---------------------------------------------------------------------------
// ① 分批规则本体
// ---------------------------------------------------------------------------

test('① 全可并行：按 maxPar 有界切批（批间顺序执行、批内并发）', () => {
  const batches = planToolBatches([...SAFE, 'read_file', 'grep_search'], 3, isSafeOf(SAFE));
  assert.deepEqual(batches, [[0, 1, 2], [3, 4]]);
  // maxPar=2：切得更细；maxPar 大于调用数：一批装完
  assert.deepEqual(planToolBatches(SAFE, 2, isSafeOf(SAFE)), [[0, 1], [2]]);
  assert.deepEqual(planToolBatches(SAFE, 99, isSafeOf(SAFE)), [[0, 1, 2]]);
});

test('① 独占＝屏障：单独一批，且**不与前后可并行调用合并**（合并＝它和别人同时在跑）', () => {
  // read_file, write_file, grep_search —— 独占夹在中间，左右两侧不许被并成一批
  const batches = planToolBatches(['read_file', 'write_file', 'grep_search'], 5, isSafeOf(SAFE));
  assert.deepEqual(batches, [[0], [1], [2]], '独占两侧的可并行调用不得跨过它合并成一批');
  // 独占在开头/结尾同样单独成批
  assert.deepEqual(planToolBatches(['write_file', 'read_file', 'grep_search'], 5, isSafeOf(SAFE)), [[0], [1, 2]]);
  assert.deepEqual(planToolBatches(['read_file', 'write_file'], 5, isSafeOf(SAFE)), [[0], [1]]);
  // 两个独占相邻：各占一批（不许凑成"一对独占并发跑"）
  assert.deepEqual(planToolBatches(['write_file', 'edit_file'], 5, isSafeOf(SAFE)), [[0], [1]]);
});

test('① 判据只认「显式 true」：未声明 / 不认识 / 判据抛错一律独占（fail-closed）', () => {
  // 未声明（谓词对谁都 false）＝ 串行
  assert.deepEqual(planToolBatches(SAFE, 5, () => false), [[0], [1], [2]]);
  // 返回真值但不是 true（1 / 'yes' / {}）不算——照 DSH "an exact `true` is parallel"
  for (const v of [1, 'yes', {}, [], 'true']) {
    assert.deepEqual(planToolBatches(['read_file'], 5, () => v), [[0]], JSON.stringify(v) + ' 不是显式 true，不许当可并行');
  }
  // 判据自己抛错：不许把整轮带崩，也不许当成可并行
  assert.deepEqual(planToolBatches(['read_file', 'grep_search'], 5, () => { throw new Error('判据坏了'); }), [[0], [1]]);
  // 名字缺失/空列表：不炸，返回空
  assert.deepEqual(planToolBatches([], 5, () => true), []);
  assert.deepEqual(planToolBatches(null, 5, () => true), []);
});

test('① maxPar<=0/非法 = 串行（与 settings max_parallel_tools 同口径：0=关并行）', () => {
  for (const v of [0, -1, undefined, null, NaN, 'abc']) {
    assert.deepEqual(planToolBatches(SAFE, v, isSafeOf(SAFE)), [[0], [1], [2]], 'maxPar=' + String(v) + ' 必须是串行');
  }
});

test('① 拍平后恒为模型顺序 0..n-1（提交顺序不变式落在这里）', () => {
  const names = ['read_file', 'write_file', 'grep_search', 'list_dir', 'edit_file', 'read_file'];
  const flat = planToolBatches(names, 4, isSafeOf(SAFE)).flat();
  assert.deepEqual(flat, [0, 1, 2, 3, 4, 5], '批次顺序＋批内升序 ⇒ 拍平后仍是模型顺序');
  for (const b of planToolBatches(names, 4, isSafeOf(SAFE))) {
    assert.deepEqual([...b].sort((x, y) => x - y), b, '批内必须升序');
    // 独占的批次只能有一条：出现两条就等于两个不可并行工具在同一批里并发
    if (b.some((i) => !isSafeOf(SAFE)(names[i]))) assert.equal(b.length, 1, '独占工具必须单独占一批');
  }
});

// ---------------------------------------------------------------------------
// ② 判据的单一出处：静态问清单、动态问条目、认不出来=独占
// ---------------------------------------------------------------------------

test('② isParallelSafe：静态工具问清单（显式 true 才算），写入类一律独占', () => {
  for (const n of SAFE) assert.equal(isParallelSafe(n), true, n + ' 清单里声明了 parallelSafe:true');
  for (const n of EXCLUSIVE) assert.equal(isParallelSafe(n), false, n + ' 清单里声明了 parallelSafe:false');
  // run_command / delete_file 这类"改环境/独占资源"的必须独占
  for (const n of ['run_command', 'delete_file', 'db_write', 'kb_add', 'subagent_fanout']) {
    assert.equal(isParallelSafe(n), false, n + ' 不得可并行（并发时会互相踩）');
  }
  // 认不出来（幽灵/已卸载/拼错）＝独占，不是"可并行"
  assert.equal(isParallelSafe('mcp_没注册过_do_thing'), false);
  assert.equal(isParallelSafe('不存在的工具'), false);
  assert.equal(isParallelSafe(undefined), false);
});

test('② isParallelSafe：动态来源（MCP/连接器）问条目自己的声明，不声明即独占（照 DSH：MCP 工具未声明=独占）', () => {
  const mk = (name, extra) => ({ name, description: '夹具动态工具', permission: 'write', params: {}, run: async () => ({ content: 'x' }), ...extra });
  try {
    registerDynamicTools('test-parallel', [mk('t_dyn_safe', { parallelSafe: true }), mk('t_dyn_plain')]);
    assert.equal(isParallelSafe('t_dyn_safe'), true, '条目显式声明 true ⇒ 可并行');
    assert.equal(isParallelSafe('t_dyn_plain'), false, '条目没声明 ⇒ 独占（不替外部工具猜它安全）');
  } finally {
    unregisterDynamicTools('test-parallel');
  }
  assert.equal(isParallelSafe('t_dyn_safe'), false, '来源卸载后回到"认不出来=独占"');
});

// ---------------------------------------------------------------------------
// ③ 真代码路径：agent.runToolBatches（生产循环调用的就是它）
// ---------------------------------------------------------------------------

/** 跑一步，记录"同时在跑几个"的峰值与提交顺序；delay 可让后面的先跑完（验证提交不看完成先后） */
async function runStep(names, maxPar, delayOf = () => 5) {
  const active = { now: 0, peak: 0 };
  const order = [];
  const calls = names.map((n, i) => ({ id: 'call_' + i, function: { name: n, arguments: '{}' } }));
  const execOne = async (_call, idx) => {
    active.now++;
    active.peak = Math.max(active.peak, active.now);
    await new Promise((r) => setTimeout(r, delayOf(idx)));
    active.now--;
    return { idx };
  };
  await runToolBatches({ calls, maxPar, execOne, commitOne: (idx) => order.push(idx) });
  return { peak: active.peak, order };
}

test('③ 独占工具在真实调度里**不与他人重叠**：read_file + write_file + grep_search ⇒ 峰值 1', async () => {
  const { peak, order } = await runStep(['read_file', 'write_file', 'grep_search'], 5);
  assert.equal(peak, 1, '这一步里有 write_file（parallelSafe:false）⇒ 三条都不许同时在跑（改前峰值是 3）');
  assert.deepEqual(order, [0, 1, 2], '提交顺序仍是模型顺序');
});

test('③ 可并行工具确实并发：三条只读 + 上限 5 ⇒ 峰值 3（改完不许变成串行）', async () => {
  const r3 = await runStep(['read_file', 'grep_search', 'list_dir'], 5);
  assert.equal(r3.peak, 3, 'all parallelSafe:true ⇒ 真的并发（这条防"为了安全把并行整个关掉"）');
  // 上限仍然生效：上限 2 ⇒ 峰值恰好 2
  const r2 = await runStep(['read_file', 'grep_search', 'list_dir', 'read_file'], 2);
  assert.equal(r2.peak, 2, 'maxPar 仍是并发的上界');
  // 0 = 关并行 ⇒ 峰值 1（既有语义不变）
  const r0 = await runStep(['read_file', 'grep_search'], 0);
  assert.equal(r0.peak, 1, 'max_parallel_tools=0 的"串行"语义不变');
});

test('③ 提交顺序恒为模型顺序：让后面的先跑完，提交仍是 0,1,2', async () => {
  // 第 0 条最慢、第 1/2 条几乎立刻返回：按完成先后提交会得到 [1,2,0]（DSH 明确禁止）
  const { peak, order } = await runStep(['read_file', 'grep_search', 'list_dir'], 5, (i) => (i === 0 ? 40 : 1));
  assert.equal(peak, 3, '这一条要在真并发下验提交顺序（串行的话它就证明不了什么）');
  assert.deepEqual(order, [0, 1, 2], '结果与上下文必须按模型顺序提交（toolLog/msgs 的顺序契约）');
});

test('③ 生产循环真的走这条路径：agent.js 里是 runToolBatches，不是"每 maxPar 个切一块"', () => {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent.js'), 'utf8'));
  // 判据按**语义**写、不锚死格式（本仓被"锚点子串"咬过：换个换行/空格就假红，见 C-50）
  assert.match(src, /await\s+runToolBatches\s*\(/, '工具轮必须调用 runToolBatches（否则本文件 ③ 那几条证的是没人用的函数）');
  assert.equal(/calls\.slice\(start,\s*start \+ maxPar\)/.test(src), false, '旧的"无差别并发"切块写法不得复活（它不读 parallelSafe 声明）');
  assert.match(src, /isParallelSafe/, '判据来自注册表（一个判据一个出处）');
});
