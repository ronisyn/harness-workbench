// test/prefix-assemble.test.mjs - 跨轮前缀指纹：**C4 必须看得见"两次请求之间"的前缀改写**
//
// 为什么单独一条（核对报告 §3.5③）：`server/agent.js` 的 `diffCore/prevCore` 机检**每 run 重置**
//   （`let prevCore = null` 在 runAgent 里），所以它只看得见"一次 run 之内的轮次"。
//   而"同一会话上一次请求发出去的前缀，这一次不见了/换头了"发生在**组装侧**（`/api/chat` 每次重新拼），
//   此前**没有任何机检看得见** —— 实测口径下 C4 机检 = 0 行，而那条 >40 条的滑窗正每轮丢一段中段历史。
//
// 三层保障：
//   ① 纯函数行为（用真数据形状）：只追加 → append；丢中段/换头/变短 → rewrite；换模型/换工具面 → skipped-lane（不误报）；
//   ② 账本行可**机器读回**（写与读是同一份定义，不是正则猜人话）；
//   ③ 组装侧源码不变式：完整历史必须原样进 messages（滑窗与 assistant 静默截断不得复活）+ 账本接线在位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectPrefixRewrite, parsePrefixRecord, formatPrefixRecord, historyFingerprint, isAppendOnly } from '../server/history.js';
import { PREFIX_LEDGER } from '../server/prefix-participants.js';
import { prefixLane } from '../server/prefix-assemble.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 夹具数据：**>40 条**（正好是原滑窗的触发线），内容带序号，便于断言"中段没丢"
const N = 44;
const HIST = Array.from({ length: N }, (_, i) => ({
  id: i + 1,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: '第' + (i + 1) + '条消息的内容-' + String(i + 1).padStart(2, '0'),
}));
const LANE = 'laneA';
const roundTrip = (r) => parsePrefixRecord(formatPrefixRecord(r));

test('只追加：历史尾部增长 → append（合规），且**一条都不许少**', () => {
  const prev = detectPrefixRewrite(null, HIST, LANE);
  assert.equal(prev.state, 'first', '首次没有对照：计为首个记录（首轮缓存重建属 C5 的 first-round）');
  assert.equal(prev.cnt, N);
  const grown = HIST.concat([{ id: 45, role: 'user', content: '第45条消息的内容-45' }]);
  const d = detectPrefixRewrite(roundTrip(prev), grown, LANE);
  assert.equal(d.state, 'append', '尾部追加不得判成改写');
  assert.equal(d.cnt, N + 1);
  assert.ok(isAppendOnly(d.state));
});

test('**反向锁**：原滑窗形态（>40 条只发最近 30 条）必须被判成 rewrite，并如实报出少了多少条', () => {
  const prev = detectPrefixRewrite(null, HIST, LANE);           // 上一轮：完整 44 条
  const windowed = HIST.slice(-30);                             // 这一轮：滑窗后的 30 条（丢的是前 14 条）
  const d = detectPrefixRewrite(roundTrip(prev), windowed, LANE);
  assert.equal(d.state, 'rewrite', '丢中段/丢早期必须被检出——这正是 §3.5③ 要 C4 看见的东西');
  assert.equal(d.lost, N - 30, '要能说出少了多少条（归因，不是只报一个数）');
  // **滑窗会一轮轮往下掉**：lost 必须对照**峰值**而不是上一轮，否则最严重的那次会被越报越小
  // （真实场景：越过 40 条线后每轮都"只发最近 30 条 + 新来的两条" → 上一轮 30 条、这一轮 32 条，
  //   拿上一轮当基准只会说"少了 -2 条"，甚至因为 32 > 30 被判定成 append —— 那等于把这次改写藏起来）
  const nextTurn = HIST.concat([{ id: 45, role: 'user', content: '新消息' }, { id: 46, role: 'assistant', content: '回复' }]).slice(-30);
  const d2 = detectPrefixRewrite(roundTrip(d), nextTurn, LANE);
  assert.equal(d2.state, 'rewrite', '滑窗态会持续改写前缀（每轮都丢中段）');
  assert.equal(d2.lost, Math.max(N, nextTurn.length) - nextTurn.length, 'lost 对照峰值：这一路是 44-30、46-30… 只会越丢越多');
  // 条数没变但头部被换（就地改写早期消息）同样必须检出
  const rewritten = HIST.map((m, i) => (i === 0 ? { ...m, content: '被就地改写的第1条' } : m));
  assert.equal(detectPrefixRewrite(roundTrip(prev), rewritten, LANE).state, 'rewrite', '同条数换头也是改写');
  // 末尾被删（历史变短）
  assert.equal(detectPrefixRewrite(roundTrip(prev), HIST.slice(0, 40), LANE).state, 'rewrite', '历史变短也是改写');
});

test('车道变了不误报：换模型 / 换工具面 / 轻量面翻转 → skipped-lane（已在 prefix:exempt 记过一次，不重复计）', () => {
  const prev = detectPrefixRewrite(null, HIST, LANE);
  for (const lane of ['laneB-model-switch', 'laneB-tool-face', 'laneB-light']) {
    const d = detectPrefixRewrite(roundTrip(prev), HIST.slice(-30), lane);
    assert.equal(d.state, 'skipped-lane', '车道不同 = 新段，缓存本来就要重建：不该计成 C4 非预期失效');
  }
});

test('账本行可机器读回：写与读同一份定义，指纹/条数/峰值/车道/改写标记都要还原', () => {
  const d = detectPrefixRewrite(roundTrip(detectPrefixRewrite(null, HIST, LANE)), HIST.slice(-30), LANE);
  const line = formatPrefixRecord(d);
  const back = parsePrefixRecord(line);
  assert.deepEqual(back, { fp: d.fp, cnt: d.cnt, lane: d.lane, peak: d.peak, rewrite: true });
  // 老账（没有 peak 字段）按 cnt 兜底：语义等价于"当时就是峰值"，不会因为格式升级就解析失败
  assert.deepEqual(parsePrefixRecord('fp=abcdef123456 cnt=7 lane=abc'), { fp: 'abcdef123456', cnt: 7, lane: 'abc', peak: 7, rewrite: false });
  // 解析不出来 → null（当作"无对照"，按首个记录处理）；绝不抛
  assert.equal(parsePrefixRecord('随便一句人话'), null);
  assert.equal(parsePrefixRecord(''), null);
  assert.equal(parsePrefixRecord(null), null);
  // 指纹只认 role+content（id 不进请求，不该影响判定）
  assert.equal(historyFingerprint(HIST, N), historyFingerprint(HIST.map((m) => ({ ...m, id: m.id * 999 })), N));
  assert.notEqual(historyFingerprint(HIST, N), historyFingerprint(HIST, N - 1));
});

test('组装侧不变式①：完整历史原样进 messages —— 滑窗与 assistant 静默截断**不得复活**', () => {
  const src = read('server/index.js');
  // (a) 那条滑窗的指纹：`hist = hist.slice(-N)`（历史被裁成最近 N 条）
  assert.ok(!/hist\s*=\s*hist\.slice\(-\d+\)/.test(src), '滑窗（hist = hist.slice(-N)）不得复活：它每轮丢一段中段历史 = 会话内改写前缀');
  // (b) 入 messages 的那一步必须**原样透传** DB 内容：不许出现中间变量加工（旧实现在这里截断 &
  //     贴「…[历史消息过长已截断…]…」标记，那段代码的形状就是这两条指纹）。
  //     注：本文件自己的注释里也会出现这两个符号，所以判据看的是**代码形状**而不是关键词。
  assert.ok(!/let\s+c\s*=\s*String\(m\.content/.test(src), '历史内容不得先落到中间变量再加工（旧截断实现在这里改字节）');
  assert.ok(!/历史消息过长已截断/.test(src), '不得重新贴回截断标记');
  assert.ok(/for \(const m of hist\) \{\s*\n\s*messages\.push\(\{ role: m\.role, content: String\(m\.content \|\| ''\) \}\)/.test(src),
    '历史必须原样进 messages：`messages.push({ role: m.role, content: String(m.content || \'\') })`');
  // 强不变式：截断若回来，必然命中某条 >4000 字符的 assistant 历史消息——用夹具数据证明"原样进 = 一字不改"
  const long = '原'.repeat(4600);
  const withLong = HIST.concat([{ id: 99, role: 'assistant', content: long }]);
  const prev = detectPrefixRewrite(null, withLong, LANE);
  assert.equal(detectPrefixRewrite(roundTrip(prev), withLong, LANE).state, 'append', '超长历史消息原样重放必须是 append（截断一回来这里必然报 rewrite）');
});

test('组装侧不变式②：账本接线在位 —— 落 prefix:assemble，改写时落 prefix:invalidate（src=assemble）', () => {
  const src = read('server/index.js');
  assert.ok(src.includes('detectPrefixRewrite'), 'index.js 必须调用跨轮判定（否则 C4 在跨 run 维度上仍是盲的）');
  assert.ok(src.includes('PREFIX_RECORD_ACTION'), '组装账的动作名必须来自声明表常量（各写各的字符串会静默不计账）');
  assert.match(src, /PREFIX_LEDGER\.INVALIDATE/, '跨轮改写必须落 C4 账（prefix:invalidate）');
  assert.match(src, /src=assemble/, 'C4 行要标明来源（区别于 agent.js 的 run 内断链），否则两种失效混在一起没法归因');
  assert.equal(PREFIX_LEDGER.ASSEMBLE, 'prefix:assemble');
  assert.equal(PREFIX_LEDGER.INVALIDATE, 'prefix:invalidate');
  // 位置：账本必须落在 light/enabledTools 定型之后（lane 与真正发出去的工具面同源）
  // 2026-09-16 改判据形状（**判据本身没放宽**）：这段逻辑收进了共享模块
  // `server/prefix-assemble.js`（三条入口同源），所以 index.js 里不再有 `laneSrc` 那一行；
  // 位置关系改看落账调用点。**lane 内容**由行为判据兜底（下面那两条），比"源码里出现过哪一行"更硬。
  const ledger = src.indexOf('await recordPrefixAssemble({');
  // 锚点改成"赋值形状"而不是"`const` 声明"：`light` 现在**在 try 之外声明、在 try 内赋值**
  // （异常帧也要用它 —— 写成 try 体内的 const 会让 catch 自己抛 ReferenceError，2026-09-16 真机日志实测）。
  // 判据没变：落账必须发生在 light 定型之后。
  const lightLine = src.search(/^\s*(?:const\s+)?light = !needsTools\(content\)/m);
  assert.ok(ledger > 0 && lightLine > 0 && ledger > lightLine, 'lane 必须在 light 定型之后才算（否则轻量面翻转会被误判成改写）');
});

test('lane 的源件含轻量面与工具启用集：翻转其中任一项 ⇒ lane 必须变（位置不变式的行为版判据）', () => {
  const base = {
    provider: 'deepseek', model: 'deepseek-v4-flash', light: false, preset: 'all', mode: 'chat',
    permission: 'full', shellKey: null, enabledTools: new Set(['read_file', 'run_command']), shellSchema: null,
  };
  const lane = prefixLane(base);
  assert.match(lane, /^[0-9a-f]{12}$/, 'lane 是 12 位十六进制（落账本一列，够短不撞）');
  assert.equal(prefixLane({ ...base }), lane, '同一份源件必须得到同一个 lane（纯函数，无隐藏状态）');
  assert.notEqual(prefixLane({ ...base, light: true }), lane, '轻量面翻转 = 换车道（两面差 9,600 tokens，本就该跳过比较）');
  assert.notEqual(prefixLane({ ...base, model: 'deepseek-v4-pro' }), lane, '换模型 = 换车道（C4 豁免项之一）');
  assert.notEqual(prefixLane({ ...base, permission: 'read' }), lane, '换权限 = 换前缀（身份层随 permission 变）');
  assert.notEqual(prefixLane({ ...base, enabledTools: new Set(['read_file']) }), lane, '工具启用集变了 = 换工具面');
  // 集合的**顺序**不该影响车道（Set/数组语义相同：同一个工具面 ≠ 两条车道）
  assert.equal(prefixLane({ ...base, enabledTools: ['run_command', 'read_file'] }), lane, '启用集只按内容比，顺序不参与');
  // 壳 schema 也是源件（非 default 壳才裁剪）
  assert.notEqual(prefixLane({ ...base, shellSchema: { presetBase: 'std', forceOn: new Set(['a']), forceOff: new Set(), mcpAllow: null } }), lane, '壳 schema 裁剪 = 换工具面');
});
