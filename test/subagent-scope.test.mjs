// test/subagent-scope.test.mjs - RA-12 / RA-13 / RA-14 夹具（§14.4 编排与子代理）
//   RA-12 查库存的子代理，工具清单里**只有**那个工具（其他根本不出现）
//   RA-13 一个子代理失败 → 交付物照出并标注"该块数据未取得"
//   RA-14 子代理只烧自己的额度；父级留汇总；未花完显式回收
// 三条都属于"行为契约"，所以夹具直接打被测单元（纯函数 + 真实 runAgent），不 mock 内部实现。
import { test } from 'node:test';
import assert from 'node:assert';
import { parseToolWhitelist, narrowEnabled, subtoolRefusal } from '../server/subtools.js';
import { subagentOutcome, spawnSubagent, waitSub, subs } from '../server/subagent.js';
import { effectiveSubBudget } from '../server/agent.js';
import { TOOLS, toolDefs, execTool, PLATFORM_EXEMPT } from '../server/tools/index.js';

// ---------- RA-12：工具面收窄 ----------
test('RA-12 白名单：允许逗号/中文逗号/空格/数组四种写法', () => {
  for (const input of ['db_query,kb_search', 'db_query，kb_search', 'db_query kb_search', ['db_query', 'kb_search']]) {
    const s = parseToolWhitelist(input);
    assert.deepEqual([...s].sort(), ['db_query', 'kb_search'], JSON.stringify(input));
  }
});

test('RA-12 白名单：空/缺省 = 不收窄（继承父级），不是"一个都不给"', () => {
  for (const input of [null, undefined, '', '   ', []]) assert.equal(parseToolWhitelist(input), null, String(input));
});

test('RA-12 白名单：写了不存在的工具 → 当场抛错（不许静默给一个更宽的面）', () => {
  assert.throws(() => parseToolWhitelist('db_query,inventory.query'), /未装载的工具：inventory\.query/);
});

test('RA-12 最严者生效：白名单 ∩ 父级启用集（只能更窄，不能越权放开）', () => {
  const parent = new Set(['db_query', 'read_file']);
  assert.deepEqual([...narrowEnabled(parent, parseToolWhitelist('db_query,read_file,kb_search'))].sort(), ['db_query', 'read_file']);
  assert.deepEqual([...narrowEnabled(parent, parseToolWhitelist('db_query'))], ['db_query']);
  assert.equal(narrowEnabled(null, null), null);                                  // 两侧都不限 → 不限
  assert.deepEqual([...narrowEnabled(null, parseToolWhitelist('db_query'))], ['db_query']); // 父级不限 → 用名单
});

test('RA-12 判据：收窄后 schema 里**只有**名单内工具 + 平台豁免底座', () => {
  const wl = parseToolWhitelist('read_file,list_dir');
  const defs = toolDefs('all', narrowEnabled(null, wl), null);
  const names = defs.map((d) => d.function.name);
  // 业务工具面必须被砍到只剩名单
  const biz = names.filter((n) => !PLATFORM_EXEMPT.includes(n)).sort();
  assert.deepEqual(biz, ['list_dir', 'read_file'], '实际下发的业务工具面');
  assert.ok(!names.includes('db_query') && !names.includes('subagent') && !names.includes('run_command'), '名单外业务工具不得出现');
  // 平台豁免底座保留（回滚/取证/护栏手段，不是"模型可自由选的业务能力"）
  assert.deepEqual(names.filter((n) => PLATFORM_EXEMPT.includes(n)).sort(), [...PLATFORM_EXEMPT].sort());
});

test('RA-12 schema 与执行层同口径：schema 里出现的工具，执行层都不得拒绝（防"看得见却调不动"）', () => {
  const wl = parseToolWhitelist('read_file,list_dir');
  for (const d of toolDefs('all', narrowEnabled(null, wl), null)) {
    assert.equal(subtoolRefusal(wl, d.function.name), null, d.function.name + ' 在 schema 里却被执行层拒绝');
  }
  // 反向：不在 schema 里的业务工具，执行层必须拒绝
  for (const n of ['db_query', 'run_command', 'write_file']) assert.ok(subtoolRefusal(wl, n), n + ' 应被拒绝');
});

test('RA-12 判据：执行层同口径拒绝名单外工具（看不见也调不动）', () => {
  const wl = parseToolWhitelist('read_file');
  assert.equal(subtoolRefusal(wl, 'read_file'), null, '名单内放行');
  assert.match(subtoolRefusal(wl, 'db_query'), /不在本子代理的工具清单内/);
  assert.equal(subtoolRefusal(null, 'db_query'), null, '未收窄时不拦');
});

test('RA-12 负例：收窄必须真的改变 MCP/豁免类工具也不放行（名单是白名单，不是"额外允许"）', async () => {
  const wl = parseToolWhitelist('read_file');
  const r = await execTool('db_query', { sql: 'SELECT 1' }, { __subTools: wl, conversationId: 0, accountId: 0 });
  assert.ok(r.error, '名单外工具应被拒绝');
  assert.match(r.error, /不在本子代理的工具清单内/);
});

// ---------- RA-13：失败也照出，并标注"该块未取得" ----------
const FAILED = {
  id: 'sub-test-1', name: '查库存', kind: 'spawn', status: 'error',
  error: '上游超时', result: '## 结论\n已查到 3 个 SKU 的库存，第 4 个查询超时。',
  durationMs: 12345, toolLog: [{ name: 'db_query', status: 'done' }, { name: 'db_query', status: 'fail' }],
  tools: ['db_query'], budgetYuan: 0.5, spentYuan: 0.2,
};

test('RA-13 失败子代理：交付物照出（含部分正文）+ 明确标注该块未取得', () => {
  const o = subagentOutcome(FAILED);
  assert.equal(o.degraded, true);
  assert.equal(o.status, 'error');
  assert.match(o.error, /上游超时/);
  assert.match(o.result, /已查到 3 个 SKU/, '子代理已产出的部分内容必须原样带出，不能因为失败就丢掉');
  assert.match(o.note, /该块数据未取得/);
  assert.match(o.note, /不要静默省略、也不要伪造其结论/);
  assert.equal(o.toolSteps, 2, '已完成的工具步骤要能数出来');
});

test('RA-13 成功子代理：不带 degraded，正常给出结论', () => {
  const o = subagentOutcome({ ...FAILED, status: 'done', error: undefined, result: '## 结论\n库存正常。' });
  assert.ok(!o.degraded);
  assert.match(o.result, /库存正常/);
});

test('RA-13 记录已被 TTL 清理：也给一份可照出的降级结果，而不是抛异常', () => {
  const o = subagentOutcome(undefined);
  assert.equal(o.degraded, true);
  assert.match(o.reason, /TTL/);
});

// ---------- RA-14：额度切分与显式回收 ----------
test('RA-14 收支回执：切了多少 / 花了多少 / 回收多少，三者可对账', () => {
  const o = subagentOutcome(FAILED);
  assert.equal(o.budgetYuan, 0.5);
  assert.equal(o.spentYuan, 0.2);
  assert.equal(o.refundYuan, 0.3, '未花完的部分必须显式回收');
});

test('RA-14 生效额度：与段阈值取 min（只能更严，不能越过父级段阈值）', () => {
  assert.equal(effectiveSubBudget(0.5, 20), 0.5, '段阈值更宽 → 用切的额度');
  assert.equal(effectiveSubBudget(50, 20), 20, '切的额度更宽 → 被段阈值收紧');
  assert.equal(effectiveSubBudget(0.5, 0), 0.5, '段阈值不限(0) → 用切的额度');
  assert.equal(effectiveSubBudget(0, 20), 0, '不切额度 → 0（不设子额度）');
  assert.equal(effectiveSubBudget(null, 20), 0);
  assert.equal(effectiveSubBudget(-1, 20), 0, '负数不当作额度');
  assert.equal(effectiveSubBudget('0.3', 20), 0.3, '字符串数字也应被接受');
});

test('RA-14 派发即切分：额度写进子代理记录（父级可对账），且失败时也给出收支三项', async () => {
  // 注：本仓库测试环境没有厂商 API Key → 子代理必然在第一次调用前失败，正好覆盖"失败也要有账"的路径
  const { id, promise } = await spawnSubagent({
    prompt: '（夹具：不实际执行，只看派发时的账面）', name: 'quota-book',
    provider: 'deepseek', model: 'deepseek-v4-flash', parentCtx: { conversationId: 0 }, keys: {},
    budgetYuan: 0.25, tools: ['read_file'],
  });
  const rec = await promise; // 等结算完成 —— 不等会留下在跑的子代理（夹具进程不退出）
  assert.equal(rec.budgetYuan, 0.25, '派发台账要记下切了多少');
  assert.deepEqual(rec.tools, ['read_file'], '派发台账要记下工具面');
  const o = subagentOutcome(subs.get(id));
  assert.equal(o.budgetYuan, 0.25);
  assert.ok(o.spentYuan != null && o.refundYuan != null, '收支三项都要能给出（失败路径也要有）');
  assert.equal(o.refundYuan, 0.25, '一步没走 → 全额回收');
});

test('RA-14 不给额度 = 行为不变（不引入新的默认限制）', () => {
  const o = subagentOutcome({ ...FAILED, status: 'done', budgetYuan: null, spentYuan: null });
  assert.equal(o.budgetYuan, null);
  assert.equal(o.refundYuan, null);
});

// ---------- 工具面自洽：所有子代理族工具的 tools/budgetYuan 参数确实声明了 ----------
test('RA-12/14 参数已声明：subagent / subagent_fork / subagent_fanout 都能收窄与切额度', () => {
  for (const name of ['subagent', 'subagent_fork', 'subagent_fanout']) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, name + ' 应已装载');
    assert.ok(t.params.tools, name + ' 缺 tools 参数');
    assert.ok(t.params.budgetYuan, name + ' 缺 budgetYuan 参数');
  }
});
