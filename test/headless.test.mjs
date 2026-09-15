// test/headless.test.mjs - headless 执行入口（scripts/rw-run.mjs）的对外契约（v0.3 §7.1 ⑬）
//
// 为什么要夹具：这个文件是**给别的程序用的入口**——调用方（脚本/CI/别的 agent）只看得见
// stdout 的那一行 JSON 与退出码。这三样坏了，表现是"调用方拿到半截 JSON / 永远挂住 / 把失败当成功"，
// 而我们的日志里一切正常。所以这里把契约钉死：
//   ① 参数解析：三条取值来源（位置参数/--task/ RW_RUN_TASK）、非法值、缺值、未知选项；
//   ② 输出形状：stdout **恒定一行 JSON**，成功与失败同形（先看 ok）；进度只走 stderr；
//   ③ 失败口径：用法错=退出码 2 且码为 PARAM_MISSING；运行期失败/挂起=退出码 1；
//   ④ 编排事实：任务真的当**用户消息**送进 runAgent（不复制循环逻辑）、结果落库、stdout 只有一个出口。
//
// 纪律：**不连真库、不调模型**。runHeadless 的依赖全部注入（假 db / 假 runAgent），
//      子进程用例只跑"不需要 LLM 与数据库"的那几条（--help、缺参数、未知选项）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, runHeadless, failResult, USAGE } from '../scripts/rw-run.mjs';
import { bootstrapStorage } from '../scripts/rw-run-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'rw-run.mjs');

/** 清空环境变量地跑子进程：免得夹具结果被运行机上的 RW_RUN_* / DB_* 影响 */
const cleanEnv = (extra = {}) => {
  const e = { ...process.env, ...extra };
  for (const k of ['RW_RUN_TASK', 'RW_RUN_CONVERSATION', 'RW_RUN_PERMISSION']) delete e[k];
  for (const k of Object.keys(extra)) e[k] = extra[k];
  return e;
};
const runCli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', cwd: ROOT, env: cleanEnv(opts.env || {}), timeout: 30000,
});

// ---------------------------------------------------------------------------
// ① 参数解析（纯函数，直接喂 argv）
// ---------------------------------------------------------------------------

test('parseArgs：三种取值来源——位置参数、--task、RW_RUN_TASK（选项优先于环境变量）', () => {
  assert.equal(parseArgs(['查一下磁盘占用']).task, '查一下磁盘占用');
  assert.equal(parseArgs(['--task', '出个方案']).task, '出个方案');
  assert.equal(parseArgs([], { RW_RUN_TASK: '环境变量给的任务' }).task, '环境变量给的任务');
  // 两者都给：命令行赢（"这一次怎么跑"压过"这个调用方的默认值"）
  assert.equal(parseArgs(['命令行任务'], { RW_RUN_TASK: '环境变量任务' }).task, '命令行任务');
  // 会话 id / 权限同样两处取，且环境变量也能生效
  assert.equal(parseArgs(['t', '--conversation', '42']).conversationId, 42);
  assert.equal(parseArgs(['t'], { RW_RUN_CONVERSATION: '42' }).conversationId, 42);
  assert.equal(parseArgs(['t', '--permission', 'full']).permission, 'full');
  assert.equal(parseArgs(['t'], { RW_RUN_PERMISSION: 'read' }).permission, 'read');
  // 不给就是不设：由 runHeadless 决定默认（新建会话 write / 既有会话沿用其档位）
  assert.equal(parseArgs(['t']).conversationId, null);
  assert.equal(parseArgs(['t']).permission, null);
  assert.equal(parseArgs(['t']).quiet, false);
  assert.equal(parseArgs(['t', '--quiet']).quiet, true);
});

test('parseArgs：--help 认出即返回，且不做任何校验（-h 同义）', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help', '--permission', 'nonsense']).help, true, '--help 优先于其它校验：帮助永远要给得出来');
});

test('parseArgs：缺任务 / 未知选项 / 缺值 / 非法值 → 抛带 PARAM_MISSING 码的错（不静默吞）', () => {
  const codeOf = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
  assert.equal(codeOf(() => parseArgs([])), 'PARAM_MISSING', '缺任务');
  assert.equal(codeOf(() => parseArgs(['   '])), 'PARAM_MISSING', '只有空白也算缺任务');
  assert.equal(codeOf(() => parseArgs(['--nope'])), 'PARAM_MISSING', '未知选项不许当任务发出去');
  assert.equal(codeOf(() => parseArgs(['--task'])), 'PARAM_MISSING', '选项缺值');
  // `--task --quiet` 这种"下一个选项被当成值"的写法必须拦住
  assert.equal(codeOf(() => parseArgs(['--task', '--quiet'])), 'PARAM_MISSING');
  assert.equal(codeOf(() => parseArgs(['--conversation', 'abc', 'hi'])), 'PARAM_MISSING', '会话 id 非数字');
  assert.equal(codeOf(() => parseArgs(['--conversation', '0', 'hi'])), 'PARAM_MISSING', '0 不是合法会话 id');
  assert.equal(codeOf(() => parseArgs(['--permission', 'admin', 'hi'])), 'PARAM_MISSING', '权限档位只有三档');
  assert.equal(codeOf(() => parseArgs(['任务一', '任务二'])), 'PARAM_MISSING', '两个位置参数是笔误，不是"多任务"');
  // 单独一个 `-` 是合法的任务文本（有些调用方用它代表 stdin 约定的占位），不该被当成未知选项
  assert.equal(parseArgs(['-']).task, '-');
  // 任务文本以 `--` 开头时，`--` 之后一律当位置参数（否则这种文本没有任何给法）
  assert.equal(parseArgs(['--', '--no-cache 是什么意思']).task, '--no-cache 是什么意思');
  assert.equal(codeOf(() => parseArgs(['--', '--x', '--y'])), 'PARAM_MISSING', '`--` 之后同样是"只能给一个任务"');
  assert.equal(parseArgs(['--', '--quiet']).task, '--quiet', '`--` 之后的 --quiet 是**任务文本**，不是选项');
  assert.equal(parseArgs(['--', '--quiet']).quiet, false);
});

// ---------------------------------------------------------------------------
// ② 输出形状（把 process.stdout 换成收集器，逐次断言"写了几次、是什么"）
// ---------------------------------------------------------------------------

/** 同时收集 stdout 与 stderr（两个流一起换，用来断言"结果与进度各走各的"） */
async function captureBoth(fn) {
  const oo = process.stdout.write, oe = process.stderr.write;
  const so = [], se = [];
  process.stdout.write = (c) => { so.push(String(c)); return true; };
  process.stderr.write = (c) => { se.push(String(c)); return true; };
  try { const ret = await fn(); return { ret, out: so.join(''), err: se.join('') }; }
  finally { process.stdout.write = oo; process.stderr.write = oe; }
}

/** 假 db：按 SQL 里出现的关键字回固定行，并记录所有执行过的语句 */
function fakeDb({ conversation = null, account = { id: 1 }, settings = {}, history = [], assistantInsertError = null } = {}) {
  const sqls = [];
  return {
    sqls,
    query: async (sql) => {
      sqls.push(String(sql));
      const s = String(sql);
      // 顺序有讲究：带守卫的 INSERT ... SELECT ... FROM conversations WHERE id=? 也含"FROM conversations"，
      // 所以 INSERT 分支必须排在"取会话"之前（夹具自己踩过一次，见交付说明）。
      if (/^INSERT INTO conversations/.test(s)) return { insertId: 77 };
      if (/^INSERT INTO messages/.test(s)) {
        // assistant 那条带 reasoning/model/provider 列，用它区分"用户消息"与"回复"两条 INSERT
        if (assistantInsertError && /reasoning/.test(s)) throw new Error(assistantInsertError);
        return { insertId: 555 };
      }
      if (/^SELECT \* FROM conversations WHERE id=\?/.test(s)) return conversation ? [conversation] : [];
      if (/SELECT id FROM accounts/.test(s)) return account ? [account] : [];
      if (/FROM messages WHERE conversation_id/.test(s)) return history;
      if (/FROM settings WHERE skey=\?/.test(s)) return [];
      if (/SELECT COALESCE\(SUM\(cost\)/.test(s)) return [{ c: 0 }];
      return [];
    },
    setting: settings,
  };
}

/** 假引擎：只记录被怎么调用的，返回一份固定 outcome（**不复制循环逻辑**的证明也在这里） */
function fakeRunAgent(outcome = {}) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return { content: '干完了。', toolLog: [], usage: { tokens_in: 10, tokens_out: 3 }, usageTotals: { cost: 0.01, hit_rate: 0.9 }, spentYuan: 0.01, finishReason: 'stop', ...outcome }; };
  fn.calls = calls;
  return fn;
}

const deps = (over = {}) => ({
  db: fakeDb(), runAgent: fakeRunAgent(), keys: {}, config: {},
  RW_WORKSPACE: 'E:/tmp/ws', RW_FS_ROOT: 'E:/',
  ensureRun: async () => ({ id: 9001 }), markRun: async () => {},
  env: {}, now: (() => { let t = 1000; return () => (t += 7); })(),
  ...over,
});

test('runHeadless：成功时结果形状就是文档里承诺的那份（runHeadless 只**返回**结果，落 stdout 是外壳的事）', async () => {
  const runAgent = fakeRunAgent({ toolLog: [{ name: 'read_file', status: 'done', code: null, durationMs: 12, result: '（一坨不该出现在结果里的工具正文）' }] });
  const { payload, exitCode } = await runHeadless({ ...deps({ runAgent }), task: '看一眼磁盘', quiet: true });

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, 'saved');
  assert.equal(payload.task, '看一眼磁盘');
  assert.equal(payload.conversationId, 77);
  assert.equal(payload.conversationCreated, true);
  assert.equal(payload.permission, 'write', '新建会话默认 write（最小可用，要 full 得显式给）');
  assert.equal(payload.messageId, 555);
  assert.equal(payload.runId, 9001);
  assert.equal(payload.content, '干完了。');
  assert.equal(payload.contentLength, 4);
  assert.equal(payload.finishReason, 'stop');
  assert.deepEqual(payload.usage, { tokens_in: 10, tokens_out: 3 });
  assert.equal(payload.totals.cost, 0.01);
  assert.equal(payload.spentYuan, 0.01);
  assert.equal(typeof payload.durationMs, 'number');
  // 工具摘要只留"用了什么、成没成、花多久"；工具正文不进结果（大结果走 spill/账本，不塞进 stdout）
  assert.deepEqual(payload.toolCalls, [{ name: 'read_file', status: 'done', code: null, durationMs: 12 }]);
  assert.equal(JSON.stringify(payload).includes('不该出现在结果里'), false);
});

test('runHeadless：任务真的当**用户消息**送进 runAgent，且上下文与平台侧同源（不另造一套）', async () => {
  const runAgent = fakeRunAgent();
  const db = fakeDb();
  await runHeadless({ ...deps({ runAgent, db }), task: '把 A 改成 B', quiet: true });

  assert.equal(runAgent.calls.length, 1, '一次调用只跑一次引擎（循环在引擎里，CLI 不自己转）');
  const call = runAgent.calls[0];
  assert.equal(call.messages.at(-1).role, 'user', '任务必须以用户消息提交（模型侧看不到"这是 CLI"）');
  assert.equal(call.messages.at(-1).content, '把 A 改成 B');
  assert.equal(call.ctx.conversationId, 77);
  assert.equal(call.ctx.permission, 'write');
  assert.equal(call.ctx.root, 'E:/tmp/ws', 'write 档的 root 是工作区，不是盘根');
  assert.equal(call.ctx.__autonomous, true, 'headless 没有人按审批 → 必须走无人值守（轮次/时间熔断才生效、审批才走排队）');
  assert.equal(call.ctx.__light, false, 'headless 是"让它干活"的入口 → 全量工具面');
  assert.equal(call.permission, 'write');
  assert.ok(typeof call.emit === 'function', '进度事件要走 emit（不然 stderr 上什么都看不见）');
  // 用户消息必须**先落库**（引擎挂起/失败时，"用户说了什么"也得在账上）
  const userIdx = db.sqls.findIndex((s) => /INSERT INTO messages/.test(s));
  assert.ok(userIdx >= 0, '用户消息要落库');
});

test('runHeadless：既有会话 —— 显式档位覆盖会话档位，取不到会话是 CONV_NOT_FOUND', async () => {
  const runAgent = fakeRunAgent();
  const db = fakeDb({ conversation: { id: 42, permission: 'read', provider: 'glm', model: 'glm-4.5', project: 'default' } });
  const { exitCode } = await runHeadless({ ...deps({ runAgent, db }), task: 'x', conversationId: 42, permission: 'full', quiet: true });
  const call = runAgent.calls[0];
  assert.equal(exitCode, 0);
  assert.equal(call.ctx.permission, 'full', '显式 --permission 覆盖会话既有档位');
  assert.equal(call.ctx.root, 'E:/', 'full 档的 root 是文件系统根');
  assert.equal(call.provider, 'glm', '不传 provider/model 时沿用会话自己的（引擎既有装配，不在 CLI 里另立默认表）');
  assert.equal(call.model, 'glm-4.5');

  const empty = fakeDb({ conversation: null });
  const e = await runHeadless({ ...deps({ db: empty }), task: 'x', conversationId: 42, quiet: true }).then(() => null, (err) => err);
  assert.equal(e && e.code, 'CONV_NOT_FOUND', '会话不存在是**带码的**运行期失败（由 CLI 外壳转成 ok:false / 退出码 1）');
  assert.equal(empty.sqls.some((s) => /^INSERT INTO conversations/.test(s)), false, '指定了会话就不该偷偷建一个新的');
});

test('runHeadless：环境变量可覆盖厂商/模型（RW_RUN_PROVIDER / RW_RUN_MODEL）', async () => {
  const runAgent = fakeRunAgent();
  const { exitCode } = await runHeadless({
    ...deps({ runAgent, env: { RW_RUN_PROVIDER: 'dashscope', RW_RUN_MODEL: 'qwen3-max' } }),
    task: 'x', quiet: true,
  });
  assert.equal(exitCode, 0);
  assert.equal(runAgent.calls[0].provider, 'dashscope');
  assert.equal(runAgent.calls[0].model, 'qwen3-max');
});

test('runHeadless：挂起（护栏/无进展）→ ok:false + 退出码 1，且 guard/reason 如实带出', async () => {
  const runAgent = fakeRunAgent({ content: '（任务已挂起：连续 3 轮重复调用）', paused: true, reason: '连续重复无进展', guard: 'no-progress' });
  const { payload, exitCode } = await runHeadless({ ...deps({ runAgent }), task: 'x', quiet: true });
  assert.equal(payload.ok, false, '挂起不是成功：调用方要能靠 ok 判断，不必解析中文');
  assert.equal(payload.status, 'paused');
  assert.equal(payload.reason, '连续重复无进展');
  assert.equal(payload.guard, 'no-progress');
  assert.equal(payload.content.length > 0, true, '挂起也有正文（现场说明），不能丢');
  assert.equal(exitCode, 1);
});

test('runHeadless：被停止 → status=stopped、退出码 1', async () => {
  const runAgent = fakeRunAgent({ content: '', stopped: true });
  const { payload, exitCode } = await runHeadless({ ...deps({ runAgent }), task: 'x', quiet: true });
  assert.equal(payload.status, 'stopped');
  assert.equal(payload.ok, false);
  assert.equal(exitCode, 1);
});

test('runHeadless：库里没有账号 → 结构性失败（不伪造 account_id 污染分账口径）', async () => {
  const db = fakeDb({ account: null });
  const e = await runHeadless({ ...deps({ db }), task: 'x', quiet: true }).then(() => null, (err) => err);
  assert.ok(e, '没有账号时必须失败，而不是编一个 account_id 出来');
  assert.equal(e.code, 'INTERNAL');
  assert.match(e.message, /账号/);
});

test('进度只走 stderr：emit 到 stderr，stdout 一个字节都不写', async () => {
  const runAgent = async (args) => {
    args.emit({ type: 'tool_start', tool: { name: 'run_command', seq: 1, args: {} } });
    args.emit({ type: 'tool_done', tool: { name: 'run_command', seq: 1, status: 'done', durationMs: 5, result: 'x' } });
    args.emit({ type: 'agent_thinking', round: 1, costCum: 0.1 });
    return { content: '好了', toolLog: [], usage: {}, usageTotals: {}, spentYuan: 0 };
  };
  const so = await captureBoth(() => runHeadless({ ...deps({ runAgent }), task: 'x' }));
  assert.equal(so.out, '', 'stdout 是"结果"的专线：进度混进来，"可被机器消费"就不成立');
  assert.equal(so.ret.payload.content, '好了');
  assert.match(so.err, /rw-run: 工具 → run_command/, 'stderr 上要有人看得懂的进度');
  assert.match(so.err, /rw-run: 工具 ← run_command \[done\] 5ms/);
  assert.match(so.err, /rw-run: 思考中/);
});

test('--quiet 只关 stderr 进度，不动结果', async () => {
  const runAgent = async (args) => { args.emit({ type: 'tool_start', tool: { name: 'read_file', seq: 1 } }); return { content: 'y', toolLog: [], usage: {} }; };
  const so = await captureBoth(() => runHeadless({ ...deps({ runAgent }), task: 'x', quiet: true }));
  assert.equal(so.err, '', '--quiet 下 stderr 应为空');
  assert.equal(so.ret.payload.content, 'y');
});

// ---------------------------------------------------------------------------
// ③ 失败结果形状（纯函数）
// ---------------------------------------------------------------------------

test('failResult：成功/失败**同形**（先看 ok），失败码沿用 server/failures.js 的登记码', () => {
  const r = failResult('PARAM_MISSING', '缺任务文本');
  assert.equal(r.ok, false);
  assert.equal(r.status, 'bad_usage');
  assert.deepEqual(r.error, { code: 'PARAM_MISSING', message: '缺任务文本' });
  assert.equal(failResult('INTERNAL', '炸了').status, 'failed');
  assert.equal(failResult('CONV_NOT_FOUND', '会话不存在：9').status, 'failed');
  // 额外字段能带出去（如调用方要回显自己给的会话 id）
  assert.equal(failResult('INTERNAL', 'x', { conversationId: 9 }).conversationId, 9);
  // 码必须能在失败码表里查到——否则调用方拿到的分类是没人认识的（表是唯一出处）
  for (const c of ['PARAM_MISSING', 'CONV_NOT_FOUND', 'INTERNAL', 'ABORTED']) {
    assert.ok(failResult(c, 'x').error.code === c);
  }
});

// ---------------------------------------------------------------------------
// ④ 子进程用例：真实退出码 + 真实 stdout（不需要 LLM、不碰数据库）
// ---------------------------------------------------------------------------

test('子进程：--help → 退出码 0，说明走 stdout，**不连库**（一条帮助命令不该去碰数据库）', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /headless/);
  assert.equal(r.stdout, USAGE, '打印的就是文件里那份用法说明（一处事实源）');
  assert.equal(r.stdout.includes('ok'), true);
  assert.doesNotMatch(r.stderr, /Er?ror|ECONNREFUSED|Access denied/i, '帮助路径不该有任何连接尝试：' + r.stderr);
});

test('子进程：缺任务 → 退出码 2 + stdout 一行可解析的 PARAM_MISSING', () => {
  const r = runCli([]);
  assert.equal(r.status, 2, '用法错用 2 与"跑了但没跑完"（1）分开');
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.status, 'bad_usage');
  assert.equal(j.error.code, 'PARAM_MISSING');
  assert.match(r.stderr, /rw-run: /, '给人看的说明在 stderr');
});

test('子进程：未知选项 / 非法权限 → 退出码 2（同样一行 JSON，不启动引擎）', () => {
  for (const args of [['--nope'], ['--permission', 'admin', 'hi'], ['--conversation', 'abc', 'hi']]) {
    const r = runCli(args);
    assert.equal(r.status, 2, JSON.stringify(args) + ' → ' + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.error.code, 'PARAM_MISSING');
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|Access denied/, '用法错不该走到连库那一步：' + r.stderr);
  }
});

test('子进程：--help 后面跟着非法取值也照样给帮助（最需要帮助的时候不能没有帮助）', () => {
  const r = runCli(['--help', '--permission', 'nonsense']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, USAGE);
});

// ---------------------------------------------------------------------------
// ⑤ 契约的反向锁：这些断言在"实现被改坏"时必须报红（反向核对见交付说明）
// ---------------------------------------------------------------------------

/** 只想把任务发出去、不想真跑引擎时用它 */
const badDbEnv = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_USER: 'nobody', DB_PASS: '', DB_NAME: 'nope' };

test('runHeadless：任务落库失败就**当场失败**（不能变成"跑了但账上没有这次任务"）', async () => {
  const db = fakeDb({ assistantInsertError: null });
  const broken = { ...db, query: async (sql) => { if (/^INSERT INTO messages/.test(String(sql))) throw new Error('messages 表不可用'); return db.query(sql); } };
  const e = await runHeadless({ ...deps({ db: broken }), task: 'x', quiet: true }).then(() => null, (err) => err);
  assert.ok(e, '用户消息落不下去时必须失败：否则引擎跑完了，而"用户说了什么"永远查不到');
  assert.match(e.message, /messages/);
});

test('runHeadless：回复落库失败**必须出声**，但结果不丢（stdout 里仍有内容，退出码仍是 0）', async () => {
  const db = fakeDb({ assistantInsertError: 'INSERT 被拒绝（磁盘满/权限）' });
  const so = await captureBoth(() => runHeadless({ ...deps({ db }), task: 'x', quiet: true }));
  assert.equal(so.ret.payload.content, '干完了。', '结果已经产出，不能因为落库失败就把它丢了');
  assert.equal(so.ret.payload.messageId, null, '落库失败时如实给 null，不编一个 id');
  assert.equal(so.ret.exitCode, 0);
  assert.match(so.err, /assistant 落库失败/, '静默 catch 是本仓库栽过两次的坑（agent-smoke 的存在理由）');

  // 反向：库里正常时必须**没有**这条告警（否则"出声"会退化成永远在叫的狼）
  const ok = await captureBoth(() => runHeadless({ ...deps(), task: 'x', quiet: true }));
  assert.doesNotMatch(ok.err, /落库失败/);
  assert.equal(ok.ret.payload.messageId, 555);
});

test('子进程：装载/连库失败时也要**一行 JSON + 退出码 1**（不崩、不静默、不挂住）', () => {
  // 这里把库指到一个必然连不上的地址，但**断言的是契约本身**（而不是"失败原因一定是连不上库"）：
  // 头一次跑这条用例时，真正先抛的是"工具清单字段非法"（并入的 registry 在装配期校验）——
  // 那同样属于"还没跑到任务就失败了"，而 CLI 的处置必须是同一个：一行结构化失败 + 退出码 1。
  const r = runCli(['随便一个任务'], { env: badDbEnv });
  assert.equal(r.status, 1, '运行期失败用 1（2 只留给用法错）：stdout=' + r.stdout + ' stderr=' + r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, '失败也必须只有一行 JSON（换行必须在 JSON 字符串里转义）：' + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.status, 'failed');
  assert.ok(j.error && j.error.code, '失败要带机器可读的码，不能只有一句中文');
  assert.ok(j.error.message.length > 0);
  // 失败时也要回显"这次让它跑的是什么"：调用方最想知道的正是这个（尤其一条长任务刚发出去）
  assert.equal(j.task, '随便一个任务');
  assert.match(r.stderr, /rw-run: /, '给人看的堆栈在 stderr');
});

test('bootstrapStorage：跑任务之前**必须先备好存储**（干净机器上第一条命令不该撞 Unknown table）', async () => {
  // 语义机检（v0.3 §4.1「单进程可启动」在 headless 这一级上的落点）：把 initSchema 换成探针，断言它真被调了。
  const order = [];
  const boot = await bootstrapStorage({ initSchema: async () => { order.push('initSchema'); } });  assert.deepEqual(boot, { prepared: true, note: '建表/迁移已结算（幂等）' });
  assert.deepEqual(order, ['initSchema']);

  // 没注入 initSchema 时如实说明"没做"，不假装成功（静默降级是本仓库明令禁止的）
  const none = await bootstrapStorage({});
  assert.equal(none.prepared, false);
  assert.match(none.note, /未注入/);

  // 抛错必须原样出去（库里够不着 / 迁移链有缺口时，调用方要拿到原因）
  const e = await bootstrapStorage({ initSchema: async () => { throw new Error('迁移链校验失败：跳号'); } }).then(() => null, (err) => err);
  assert.ok(e, '建表失败不能吞');
  assert.match(e.message, /跳号/);
});

test('runHeadless 自己不写 stdout（结果与"怎么输出"分开：可测的编排 vs 会退出的外壳）', async () => {
  const so = await captureBoth(() => runHeadless({ ...deps(), task: 'x', quiet: true }));
  assert.equal(so.out, '', '编排函数一旦自己写 stdout，就再也没法在进程内断言它（本夹具一半的用例会因此写不出来）');
});
