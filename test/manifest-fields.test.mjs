// test/manifest-fields.test.mjs - v0.3 §7.1 ③⑤「清单补声明」的机检：
//   ① 审批（approval）声明化：受控工具＝清单里 approval:true 的 7 项，**与改造前的硬编码集合逐项一致**（行为不变）；
//   ② 超时（timeoutMs）声明化：8 个界限只在清单里声明，工具定义上读到的是同一份值（一个界限一个出处）；
//   ③ 缓存影响（cacheImpact）：逐条声明"是否进请求前缀"，且能与 server/prefix-participants.js 的 tools-face 对上；
//   ④ 执行后端（execBackend）：值域 none|local，逐条如实登记（② 的落地位，本期不改行为）；
//   ⑤ 并行安全（parallelSafe）：逐条显式布尔（照 DSH `isConcurrencySafe`：只有显式 true 才算可并行）。
// 外加**负例**：缺字段/非法值/声明与实现漂移，都必须在装配期被拦下（默认拒绝不放宽）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_MANIFEST } from '../server/tools/manifest.js';
import { TOOLS, toolDefs, APPROVAL_REQUIRED, TOOL_POLICY, LIGHT_TOOLSET, PLATFORM_EXEMPT, DEFAULT_TOOLSET } from '../server/tools/index.js';
import { validateManifest, assembleTools } from '../server/tools/registry.js';
import { PREFIX_PARTICIPANTS } from '../server/prefix-participants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = Object.entries(TOOL_MANIFEST);
// 去注释时先规范化换行：仓库文件是 CRLF，而 `.` 不匹配 \r ⇒ `/\/\/.*$/` 在行尾带 \r 时**永远不匹配**
// （夹具自己被这条绊过一次：注释里的 `timeoutMs: 90000` 被当成真字面量报了出来）。
const codeOnly = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');

// 改造前的两处硬编码/散落值（O-15 补齐后的现状）——本批**行为不变**，所以拿它们当基准：
const GUARDED_BEFORE = ['delete_file', 'db_write', 'git_pull_push', 'run_command', 'kill_process', 'reload_platform', 'set_limits'];
const TIMEOUTS_BEFORE = {
  web_search: 15000, fetch_url: 20000, ocr_image: 90000, view_image: 60000,
  feishu_doc_read: 55000, feishu_sheet_read: 55000, feishu_bitable_read: 55000, run_command: 300000,
};

test('① 审批声明化：受控工具＝清单 approval:true，与改造前的硬编码 7 项逐项一致', () => {
  assert.deepEqual([...APPROVAL_REQUIRED].sort(), [...GUARDED_BEFORE].sort(), '受控工具集合不许变（行为不变是本次的硬约束）');
  // approval 缺省＝false（不弹卡）：只有这 7 条显式写了 true
  assert.deepEqual(ENTRIES.filter(([, m]) => m.approval === true).map(([n]) => n).sort(), [...GUARDED_BEFORE].sort());
  for (const [n, m] of ENTRIES) if (m.approval !== undefined) assert.equal(typeof m.approval, 'boolean', n + ' approval 必须是布尔');
  // 高危/受控面必须真的挂着审批（防"清单漏标"）：这几个是最不该静默放行的
  for (const n of ['delete_file', 'db_write', 'run_command', 'kill_process', 'reload_platform', 'set_limits', 'git_pull_push']) {
    assert.equal(TOOL_POLICY[n].approval, true, n + ' 必须在清单里标 approval:true');
  }
});

test('② 超时声明化：8 个界限只在清单里，工具定义上读到的是同一份值（一个界限一个出处）', () => {
  const declared = Object.fromEntries(ENTRIES.filter(([, m]) => m.timeoutMs !== undefined).map(([n, m]) => [n, m.timeoutMs]));
  assert.deepEqual(declared, TIMEOUTS_BEFORE, '声明集合与值必须与改造前逐项一致');
  for (const [n, ms] of Object.entries(TIMEOUTS_BEFORE)) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n + ' 不在工具面里');
    assert.equal(t.timeoutMs, ms, n + ' 工具定义上的值必须由清单装配而来（实现里不许再写一份）');
  }
  assert.equal(TOOLS.find((t) => t.name === 'ask_user').timeoutMs, undefined, '等人工的工具不许被设线');
  // 源码级：工具定义那一行不许再出现界限字面量（旧写法＝`{ name: 'x', …, timeoutMs: 90000, …`，一个界限散一处）。
  // 刻意只扫"工具条目行"而不是全文：别处合法地出现 timeoutMs 是正常的——LLM 调用参数（conv_summarize 的 chatOnce）、
  // MCP 动态来源的常量（不在静态清单里）、以及注释里的说明文字。
  const code = codeOnly(fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8'));
  const bad = code.split('\n').filter((l) => /name:\s*'/.test(l) && /timeoutMs:/.test(l));
  assert.deepEqual(bad.map((l) => l.trim().slice(0, 80)), [], '工具定义里还有界限字面量（会与清单形成两处声明）');
});

test('③ 缓存影响：逐条声明是否进前缀，且与 prefix-participants 的 tools-face 对得上', () => {
  const tf = PREFIX_PARTICIPANTS.find((p) => p.id === 'tools-face');
  assert.ok(tf, 'prefix-participants 必须有 tools-face 这一条（否则工具面的缓存影响无处声明）');
  assert.equal(tf.where, 'tools');
  assert.equal(tf.cacheImpact, 'breaks-prefix', '工具面进请求前缀：改这批字节 = 整段前缀作废');
  for (const [n, m] of ENTRIES) {
    // 声明 none（不进前缀）却会出现在工具面里 = 说谎；装配期会拦（见下面负例）。这里先锁"今天全部进前缀"这个事实。
    if (m.cacheImpact === 'none') continue;
    assert.equal(m.cacheImpact, 'tools-face', n + ' cacheImpact 非法或缺失');
  }
  const inFace = new Set(toolDefs('all', null, null).map((d) => d.function.name));
  for (const [n, m] of ENTRIES) {
    if (m.cacheImpact !== 'none') continue;
    assert.equal(inFace.has(n), false, n + ' 声明不进前缀，却又出现在工具面里（声明与实现漂移）');
  }
});

test('④ 执行后端：值域 none|local，逐条如实登记（本批只留字段，不改行为）', () => {
  for (const [n, m] of ENTRIES) assert.ok(['none', 'local'].includes(m.execBackend), n + ' execBackend 非法或缺失：' + m.execBackend);
  // 真正要落本机后端的（文件/命令/网络/数据库）必须 local——否则 ② 换实现时会漏掉它们
  for (const n of ['read_file', 'write_file', 'edit_file', 'delete_file', 'run_command', 'run_long_task', 'kill_process', 'repo_map', 'extract_xlsx', 'fetch_url', 'web_search', 'db_query', 'db_write', 'git_commit', 'skill_save', 'fetch_spill']) {
    assert.equal(TOOL_MANIFEST[n].execBackend, 'local', n + ' 要落本机后端');
  }
  // 纯内存态/上下文编排的必须 none——否则"该声明"退化成一律 local，等于没声明
  for (const n of ['plan_tasks', 'plan_done', 'hooks_list', 'ask_user', 'subagent', 'subagent_output', 'subagent_list']) {
    assert.equal(TOOL_MANIFEST[n].execBackend, 'none', n + ' 自身不落任何执行后端');
  }
  assert.deepEqual([...new Set(ENTRIES.map(([, m]) => m.execBackend))].sort(), ['local', 'none'], '两种取值都要真实出现（证明它不是常量）');
});

test('⑤ 并行安全：逐条显式布尔；写/命令/等人/共享状态必须 false，只读查询必须 true', () => {
  for (const [n, m] of ENTRIES) assert.equal(typeof m.parallelSafe, 'boolean', n + ' parallelSafe 必须显式声明布尔');
  for (const n of ['write_file', 'append_file', 'edit_file', 'delete_file', 'copy_move', 'mkdir', 'undo_checkpoint', 'run_command', 'run_long_task', 'kill_process', 'run_test', 'db_write', 'kb_add', 'kb_del', 'git_commit', 'git_pull_push', 'git_branch', 'git_status'.replace('git_status', 'skill_save'), 'skill_load', 'ask_user', 'plan_tasks', 'plan_done', 'set_goal', 'update_goal', 'set_limits', 'reload_platform', 'conv_summarize', 'create_contract', 'finish_task', 'subagent_fanout', 'ralph']) {
    assert.equal(TOOL_MANIFEST[n].parallelSafe, false, n + ' 与兄弟调用并发会互相踩/占独享资源，必须声明 false');
  }
  for (const n of ['read_file', 'read_file_range', 'list_dir', 'grep_search', 'find_file', 'repo_map', 'db_query', 'fetch_url', 'web_search', 'fetch_spill', 'hooks_list', 'get_goal', 'kb_search', 'job_list', 'job_output', 'subagent', 'subagent_output', 'syntax_check', 'git_status']) {
    assert.equal(TOOL_MANIFEST[n].parallelSafe, true, n + ' 只读且无共享可变状态，应声明可并行');
  }
  assert.deepEqual([...new Set(ENTRIES.map(([, m]) => m.parallelSafe))].sort(), [false, true], '两种取值都要真实出现（证明它不是常量）');
});

test('轻量面闭环：fetch_spill 在轻量集里（否则轻量会话溢出后取不回）', () => {
  assert.ok(LIGHT_TOOLSET.includes('fetch_spill'), '轻量面必须有取回端（符合性核对 §3.5 缺陷⑤）');
  assert.ok(LIGHT_TOOLSET.includes('repo_map'), 'repo_map 本来就在轻量面（它溢出后要靠 fetch_spill 取回）');
  const light = toolDefs('all', null, null).filter((d) => LIGHT_TOOLSET.includes(d.function.name)).map((d) => d.function.name);
  assert.ok(light.includes('fetch_spill'), '轻量会话的工具面里必须真的看得见 fetch_spill');
  assert.ok(PLATFORM_EXEMPT.includes('fetch_spill') && DEFAULT_TOOLSET.includes('fetch_spill') === false, '既有豁免/默认集口径不变（它恒可用但不进默认 28 项）');
});

// ---------- 负例：清单自身字段非法 ----------
test('负例：清单缺字段/非法值 → validateManifest 逐条报出（装配期抛错，不放行）', () => {
  const ok = { tier: 'core', cn: '夹具', cacheImpact: 'tools-face', execBackend: 'none', parallelSafe: true };
  assert.deepEqual(validateManifest({ ok: ok }), [], '合规条目不该报问题');
  assert.match(validateManifest({ a: { ...ok, parallelSafe: undefined } }).join('\n'), /parallelSafe 必须显式声明布尔/);
  assert.match(validateManifest({ a: { ...ok, parallelSafe: 'yes' } }).join('\n'), /parallelSafe 必须显式声明布尔/);
  assert.match(validateManifest({ a: { ...ok, cacheImpact: undefined } }).join('\n'), /cacheImpact 必须声明/);
  assert.match(validateManifest({ a: { ...ok, cacheImpact: 'tail-only' } }).join('\n'), /cacheImpact 必须声明/);
  assert.match(validateManifest({ a: { ...ok, execBackend: 'remote' } }).join('\n'), /execBackend 必须声明/);
  assert.match(validateManifest({ a: { ...ok, approval: 'true' } }).join('\n'), /approval 必须是布尔/);
  assert.match(validateManifest({ a: { ...ok, timeoutMs: 0 } }).join('\n'), /timeoutMs 必须是正有限数/);
  assert.match(validateManifest({ a: { ...ok, tier: 'gold' } }).join('\n'), /档位非法/);
  assert.deepEqual(validateManifest(TOOL_MANIFEST), [], '真实清单必须零问题');
});

test('负例：cacheImpact 声明不进前缀，却装载了 → 装配期抛错（清单与实现漂移被拦下）', () => {
  const tweak = { ...TOOL_MANIFEST, repo_map: { ...TOOL_MANIFEST.repo_map, cacheImpact: 'none' } };
  assert.throws(() => assembleTools(TOOLS, tweak), /cacheImpact 声明不进前缀，但实现会进工具面（请求的 tools 数组）：repo_map/);
  assert.doesNotThrow(() => assembleTools(TOOLS, TOOL_MANIFEST), '原清单必须照常装载');
});

test('负例：实现里自带 timeoutMs 字面量（两处声明）→ 装配期抛错', () => {
  const fake = TOOLS.map((t) => (t.name === 'repo_map' ? { ...t, timeoutMs: 12345 } : t));
  assert.throws(() => assembleTools(fake, TOOL_MANIFEST), /工具界限两处声明（timeoutMs 只允许在 tools\/manifest\.js 声明，实现里不要写）：repo_map/);
  assert.doesNotThrow(() => assembleTools(TOOLS, TOOL_MANIFEST), '不改实现时不受影响（热重载会重复装配，不能误报）');
});

test('负例：清单声明了不存在的工具 → 装配期抛错（既有的默认拒绝语义不放宽）', () => {
  const tweak = { ...TOOL_MANIFEST, ghost_tool: { tier: 'core', cn: '幽灵', cacheImpact: 'tools-face', execBackend: 'none', parallelSafe: true } };
  assert.throws(() => assembleTools(TOOLS, tweak), /清单声明了不存在的工具（无实现）：ghost_tool/);
});
