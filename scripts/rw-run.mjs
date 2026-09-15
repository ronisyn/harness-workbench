#!/usr/bin/env node
// scripts/rw-run.mjs - **headless 执行入口**：不起 Express、不连 HTTP，直接跑一次任务并把结构化结果写进 stdout
//
// 依据：`proposals/RW-Agent引擎架构优化方案-v0.3.md`（唯一权威）
//   · §7.1 ⑬「headless 执行形态」（P2，依赖 ①⑦）——"不起 Web 服务跑一次任务并拿结构化结果"；
//   · §0.2 G5 出口 / §0.4 M2 出口——"外部程序 headless 调用拿到结构化结果"；
//   · §4.7 接入面——对外形态是 **headless → MCP server → JSON-RPC**：一个内核 + 多适配器，本文件是
//     这条链的第一级（③ 的 MCP server 现在建在 HTTP 之上，绕开了本级的依赖，⑬ 落地后才有取而代之的余地）。
//
// 为什么是"一个 CLI + 一层薄适配器"，而不是自己写执行循环（照 DSH 的做法）：
//   DSH 的 headless 形态有两件东西——`dsh-headless`（一次性 task 模式：跑一个任务、打最终结果、退出）
//   与 `dsh-sdk-jsonrpc-server`（stdio JSON-RPC：进程外客户端在运行时里开会话并驱动 agent）；
//   它们的 CLI 入口是 `package.json` 的 `bin` 字段 + 一个薄适配器，**绝不在 CLI 里重新实现引擎**。
//   DSH headless runner 的做法逐条照搬到这里：
//     ① `await ctx.get('loader')?.await()` —— 等装配结算（我们对应"先建表/迁移 + 引擎装配完成"，
//        见 main() 里的 initSchema()：与服务启动同一件事，幂等，失败如实抛出）；
//     ② 走**既有装配**拿 provider/model（我们读会话自己的 provider/model，没写就沿用引擎回退值）；
//     ③ 把任务当**普通用户消息**提交给 runAgent —— 提示词与工具面由引擎组装，CLI 一个字都不拼；
//     ④ 驱动到静止（await 返回），再落库，最后才写 stdout 并退出（"durable before printf"）；
//     ⑤ **stdout 只放结果**、进度/推理/错误一律走 stderr（见下面"输出契约"）。
//
// 输出契约（**这是本文件唯一对外承诺**；机器消费的前提是 stdout 干净）：
//   · stdout：**恒定一行 JSON**（`JSON.stringify(...) + '\n'`，不 pretty-print、不夹日志）。成功与失败
//     同一形状、同一行——调用方 `JSON.parse(stdout)` 就能拿到结果，不必先判断退出码再决定怎么解析。
//   · stderr：给人看的进度与诊断（思考/工具/守卫/失败原因）。**不重定向 stderr 时默认会看到它**，
//     machine 场景请 `2>/dev/null` 或用 `--quiet`。
//   · 退出码：0=跑完；1=没跑完（挂起/停止/异常，JSON 里有 status 与 error.code）；2=用法错（缺任务/参数非法）。
//     与 DSH headless 同口径（"任务完成时 0，中止或出错时 1"），另加 2 给"你还没跑，命令行就写错了"。
//
// 用法：
//   node scripts/rw-run.mjs <任务文本> [--conversation <id>] [--permission full|write|read]
//   node scripts/rw-run.mjs --task <任务文本> [同上]
//   node scripts/rw-run.mjs --help
// 环境变量（可替代对应参数；无会话时新建）：
//   RW_RUN_TASK / RW_RUN_CONVERSATION / RW_RUN_PERMISSION
//   RW_RUN_PROVIDER / RW_RUN_MODEL   走哪个厂商与模型（不设=沿用会话既有值，会话也没写则用引擎回退值）
//
// 说明（**刻意不做的事**，v0.3 触发三 + §4.1"不发明参数"）：
//   · 不设超时/轮次上限参数：时间预算、轮次、循环检测、并行度**一律沿用 settings 里的既有护栏**
//     （`agentLimits()` 每轮现读；见 server/agent.js:166）。CLI 再给一个 `--timeout` 只会造出第二套阈值。
//   · 不复制平台侧的注入装配：技能注入、知识召回（kbgate）、错题召回（lessonrecall）、断点现场提示
//     （resumeHint）都留在平台（server/index.js）。headless 只装"少了它模型就会做错事"的那两条：
//     用户自定义指令与项目 AGENTS.md。理由：前四条都是**按需可查**的（模型能用 kb_search/skill_load 现查），
//     后两条是"模型无从查起的约束/事实"——省掉它们不是省事，是换个结果。
//   · 不注入事件账本：headless 的一次性事件流没有订阅方（`ctx.__signal` 之类都缺席）；留痕走既有账本
//     （usage_stats / tool_calls / audit_log 由引擎自己落），不新造一条 stdout 日志通道。
//
// 已知边界（**如实列出，不假装已经解决**）：
//   ① 不能中途停止：`ctx.__signal` 是 HTTP 面 `POST /api/chat/stop` 的入口（server/index.js 的 abortMap），
//      headless 没有它。进程被 kill 时引擎的收尾不会跑（现场留在 agent_runs=interrupted 由人恢复）。
//      一代的处置是"把 kill 接到 AbortController 上"，本轮不做（§7.1 ⑬ 只要"跑一次拿结果"）。
//   ② 技能/知识/错题/断点现场**不在开头注入**（见上一条"刻意不做的事"）；模型仍可用 skill_load/kb_search 现取。
//   ③ 一次调用只跑一个任务：任务得到回答后进程即退出，没有交互式后续（与 DSH headless 同边界）。
//   ④ 建在既有 `runAgent` 之上。同一时刻并行的 ⑭/`server/channels/run-turn.js` 正在把"跑一轮并落账"
//      收成一个共享入口（它已按注入式写好，文件头也点名与本文件的 runHeadless 同做法）——等它落定后，
//      更该做的是**让本文件去调它**（三个适配器共用一个回合入口），而不是继续各写一份装配。
//      本轮不抢先改：那个文件正在被人改，且本入口的契约与夹具已经独立成立。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapStorage } from './rw-run-bootstrap.mjs';

const PROG = 'rw-run';
// 用法错与运行期失败的区分：用法错的码与 HTTP 面对外口径同表（server/failures.js），不另造一套。
const EXIT_OK = 0, EXIT_RUN = 1, EXIT_USAGE = 2;

export const USAGE = `rw-run —— 不起服务跑一次任务，stdout 一行 JSON（v0.3 §7.1 ⑬ headless 执行形态）

用法：
  node scripts/rw-run.mjs <任务文本> [选项]
  node scripts/rw-run.mjs --task <任务文本> [选项]

选项：
  --task <文本>           任务文本（也可作为第一个位置参数给出）
                          注：取值不能以 **两个连字符** 开头（那是选项的写法）；这种文本请走位置参数：
                          rw-run -- "--no-cache 是什么意思"
  --conversation <id>     目标会话 id；不传=新建一个会话（标题取任务前 40 字）
  --permission <档位>     full | write | read（默认沿用会话既有档位；新建会话默认 write）
  --quiet                 不往 stderr 写进度（stdout 本来就只有那一行 JSON）
  -h, --help              打印本说明（stdout）并以 0 退出

环境变量（与对应选项等价；选项优先）：
  RW_RUN_TASK / RW_RUN_CONVERSATION / RW_RUN_PERMISSION
  RW_RUN_PROVIDER / RW_RUN_MODEL   走哪个厂商/模型（不设=会话既有值 → 引擎回退值）
  （护栏参数没有开关：时间预算/轮次/循环检测一律读 settings 现值，见文件头"刻意不做的事"）

输出（stdout，恒定一行 JSON）：
  { "ok": true, "status": "saved", "task", "conversationId", "conversationCreated",
    "permission", "provider", "model", "content", "contentLength", "messageId", "runId",
    "finishReason", "guard", "toolCalls", "usage", "totals", "spentYuan", "durationMs" }
失败时同一行、形状为：
  { "ok": false, "status": "<failed|bad_usage>", "error": { "code", "message" }, ... }
退出码：0=跑完 ／ 1=没跑完（挂起/停止/异常） ／ 2=用法错
`;

const HELP_TEXT = USAGE;

// ---------------------------------------------------------------------------
// 参数解析（纯函数、可单测：夹具直接喂 argv，不必起子进程）
// ---------------------------------------------------------------------------

/**
 * 解析命令行。
 * @param {string[]} argv 不含 node 与脚本路径的参数
 * @param {Record<string,string|undefined>} [env] 环境变量（默认 process.env）
 * @returns {{help:boolean, task:string, conversationId:number|null, permission:string|null, quiet:boolean}}
 * @throws {Error} 参数非法时抛错，`e.code` 为 server/failures.js 里的登记码
 */
export function parseArgs(argv, env = process.env) {
  const bad = (code, message) => { const e = new Error(message); e.code = code; return e; };
  // 选项优先于环境变量：命令行是"这一次怎么跑"，环境变量是"这个调用方的默认值"（与 selfcheck/agent-smoke 同序）
  let task = '';
  let conversationId = null;   // 解码后的值（数字）
  let rawConversation = null;  // 原文：**到解析结束再解码**——`--help` 之后的写法要求"帮助永远给得出来"
  let permission = null;
  let rawPermission = null;
  let quiet = false;
  let help = false;
  let onlyPositional = false; // 见过 `--`：其后一律当位置参数（任务文本刚好以 `--` 开头时唯一的给法）

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (onlyPositional) { if (task) throw bad('PARAM_MISSING', '任务文本只能给一个'); task = a; continue; }
    if (a === '--') { onlyPositional = true; continue; }
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--quiet') { quiet = true; continue; }
    if (a === '--task' || a === '--conversation' || a === '--permission') {
      const v = argv[i + 1];
      // 缺值必须当场报错：`--task --quiet` 这种"下一个选项被当成值"的写法会把选项名当任务发出去
      if (v === undefined || String(v).startsWith('--')) throw bad('PARAM_MISSING', a + ' 缺少取值');
      i++;
      if (a === '--task') task = String(v);
      else if (a === '--conversation') rawConversation = v;
      else rawPermission = v;
      continue;
    }
    if (a.startsWith('-') && a !== '-') throw bad('PARAM_MISSING', '未知选项：' + a + '（用 --help 看用法）');
    if (task) throw bad('PARAM_MISSING', '任务文本只能给一个（多余的：' + a.slice(0, 40) + '）');
    task = a;
  }

  // `--help` 到此为止：**取值合法性一律不校验**（帮助的目的是告诉人怎么用；因为后面跟了个错字就给不出帮助，
  // 正是最需要帮助的时候没有帮助）。
  if (help) return { help: true, task, conversationId: null, permission: null, quiet };

  if (rawConversation !== null) conversationId = parseConversationId(rawConversation);
  else if (env.RW_RUN_CONVERSATION) conversationId = parseConversationId(env.RW_RUN_CONVERSATION);
  if (rawPermission !== null) permission = parsePermission(rawPermission);
  else if (env.RW_RUN_PERMISSION) permission = parsePermission(env.RW_RUN_PERMISSION);

  if (!task && env.RW_RUN_TASK) task = String(env.RW_RUN_TASK);
  if (!String(task).trim()) throw bad('PARAM_MISSING', '缺任务文本（位置参数、--task 或 RW_RUN_TASK 三选一；--help 看用法）');
  return { help: false, task: String(task), conversationId, permission, quiet };
}

function parseConversationId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    const e = new Error('会话 id 必须是正整数，收到：' + JSON.stringify(String(v)));
    e.code = 'PARAM_MISSING';
    throw e;
  }
  return n;
}

function parsePermission(v) {
  const p = String(v);
  if (!['full', 'write', 'read'].includes(p)) {
    const e = new Error('权限档位只能是 full | write | read，收到：' + JSON.stringify(p));
    e.code = 'PARAM_MISSING';
    throw e;
  }
  return p;
}

// ---------------------------------------------------------------------------
// 输出与诊断
// ---------------------------------------------------------------------------

/** stdout 的唯一出口：**一行 JSON**。所有结果（成功/失败）都从这里出去。 */
export function emitResult(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

/** stderr 的唯一出口：给人看的进度。带上程序名前缀，便于和引擎自己的日志（rw-run 之外）分开。 */
function logLine(text, quiet) { if (!quiet) process.stderr.write(PROG + ': ' + String(text).replace(/\s+/g, ' ').trim() + '\n'); }

/**
 * 构造失败结果（**形状与成功结果同层**：调用方永远先看 `ok`）。
 * 码取自 server/failures.js 的登记表（PARAM_MISSING / CONV_NOT_FOUND / INTERNAL / ABORTED），
 * 不新造词——失败码表是唯一出处，多一套码就多一处对不上。
 */
export function failResult(code, message, extra) {
  return { ok: false, status: code === 'PARAM_MISSING' ? 'bad_usage' : 'failed', error: { code, message: String(message) }, ...(extra || {}) };
}

/** runAgent 的返回值 → 对外状态。与 server/index.js 的 run_end.status 同一判据。 */
function statusOf(outcome) {
  if (outcome.stopped) return 'stopped';
  if (outcome.paused) return 'paused';
  if (outcome.guard) return 'guard';
  return 'saved';
}

/** 推理/工具/守卫 → stderr 进度。刻意与 DSH headless 同风格（`dsh: reasoning:`）。 */
function makeEmitter(quiet) {
  const tools = new Map(); // seq → {name, ms}：tool_done 只有耗时，名字要靠 tool_start 的那一份补上
  return {
    tools,
    emit(ev) {
      if (!ev || quiet) return;
      if (ev.type === 'agent_thinking') { logLine('思考中（第 ' + (ev.round || '?') + ' 轮，累计 ¥' + (ev.costCum ?? '-') + '）', quiet); return; }
      if (ev.type === 'think') { process.stderr.write(ev.text); return; }
      if (ev.type === 'tool_start') { tools.set(ev.tool && ev.tool.seq, { name: ev.tool && ev.tool.name, t: Date.now() }); logLine('工具 → ' + (ev.tool && ev.tool.name), quiet); return; }
      if (ev.type === 'tool_done') { const t = ev.tool || {}; logLine('工具 ← ' + (t.name || (tools.get(t.seq) || {}).name || '?') + ' [' + t.status + '] ' + (t.durationMs ?? '?') + 'ms' + (t.code ? ' code=' + t.code : ''), quiet); return; }
      if (ev.type === 'llm_retry') { logLine('LLM 重试（' + (ev.retry && ev.retry.attempt) + '/' + (ev.retry && ev.retry.max) + '）：' + (ev.retry && ev.retry.reason), quiet); return; }
      if (ev.type === 'wait_start' || ev.type === 'wait_end') { logLine('等待人工（' + ev.type + '）', quiet); return; }
      if (ev.type === 'fake_done_warn') { logLine('平台检测：' + ev.text, quiet); return; }
    },
  };
}

// ---------------------------------------------------------------------------
// 主流程：一次 headless 执行
// ---------------------------------------------------------------------------

/** settings 取值（与 server/index.js:getSetting 同语义：JSON 优先、失败回落默认值；不抛）。 */
async function setting(db, key, def) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', [key]);
    if (!r[0]) return def;
    try { return JSON.parse(r[0].svalue); } catch { return r[0].svalue; }
  } catch { return def; }
}

/** 目标会话：显式给了就取（取不到即失败），没给就建一个——与 MCP 的 rw_chat 同语义（不传=新建）。 */
async function resolveConversation(db, { conversationId, permission, task }) {
  if (conversationId !== null) {
    const rows = await db.query('SELECT * FROM conversations WHERE id=?', [conversationId]);
    if (!rows.length) {
      const e = new Error('会话不存在：' + conversationId);
      e.code = 'CONV_NOT_FOUND';
      throw e;
    }
    const c = rows[0];
    return {
      id: c.id, created: false,
      permission: permission || c.permission || 'write',
      provider: c.provider || null, model: c.model || null, project: c.project || 'default',
    };
  }
  // 权限默认 write：**最小可用**——它能干活，又不等于 full（无限制）。要 full 由调用方显式 --permission full。
  const perm = permission || 'write';
  const accountId = await defaultAccountId(db);
  const r = await db.query(
    'INSERT INTO conversations (account_id, title, permission, mode, preset, project) VALUES (?,?,?,?,?,?)',
    [accountId, 'rw-run: ' + String(task).replace(/\s+/g, ' ').slice(0, 40), perm, 'chat', 'all', 'default']);
  return { id: r.insertId, created: true, permission: perm, provider: null, model: null, project: 'default' };
}

/**
 * 归属账号。headless 没有登录态（HTTP 面靠 req.user.id），故取库里第一个账号——
 * 与既有探针脚本同一口径（scripts/cache-ttl-probe.mjs:24）。一个都没有时**显式失败**，
 * 不伪造账号：会话/账本/知识都按 account_id 归集，编一个出来会污染全部分账口径。
 */
async function defaultAccountId(db) {
  const rows = await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1');
  if (!rows.length) {
    const e = new Error('库里没有任何账号：headless 没有登录态，需要一个归属账号（先在网页端注册，或造一个）');
    e.code = 'INTERNAL';
    throw e;
  }
  return rows[0].id;
}

/**
 * 组装送进引擎的消息（**与 server/index.js 同序**：固定注入 → 历史 → 尾巴区）。
 * 只装两条"模型无从查起的"注入，其余平台侧注入留在平台（理由见文件头）。
 */
async function assembleMessages({ db, conv, task, RW_WORKSPACE }) {
  const messages = [];
  const sp = await setting(db, 'systemPrompt', '');
  if (String(sp).trim()) messages.push({ role: 'system', content: '【用户自定义指令】\n' + String(sp) });
  if (conv.project) {
    try {
      const agp = path.join(RW_WORKSPACE, 'projects', conv.project, 'AGENTS.md');
      if (fs.existsSync(agp)) {
        messages.push({ role: 'system', content: '【项目 ' + conv.project + ' 说明（AGENTS.md）】\n' + fs.readFileSync(agp, 'utf8').slice(0, 16000) });
      }
    } catch { /* 项目说明不可用时跳过（与平台侧同处置，不因此中断一次执行） */ }
  }
  // 历史：最近 30 条（长会话压缩口径见平台侧 /api/chat；headless 不做摘要生成——那是旁路 LLM 成本，
  // 不该由"跑一次任务"悄悄产生）。当前这条用户消息刚落库，所以它天然在最后一条。
  const hist = await db.query('SELECT id, role, content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 30', [conv.id]);
  for (const m of hist.reverse()) {
    let c = String(m.content || '');
    if (m.role === 'assistant' && c.length > 4000) {
      c = c.slice(0, 2400) + `\n…[历史消息过长已截断 ${c.length - 4000} 字符，原文在 messages 表可按 id=${m.id} 查询]…\n` + c.slice(-1600);
    }
    messages.push({ role: m.role, content: c });
  }
  if (!hist.length) messages.push({ role: 'user', content: task }); // 兜底：历史为空也不会把任务丢了
  return messages;
}

/**
 * 跑一次 headless 执行。**所有依赖都从参数注入**（夹具因此可以不碰真库、不调模型）。
 * @returns {Promise<{payload:object, exitCode:number}>}
 */
export async function runHeadless({
  task, conversationId = null, permission = null, quiet = false,
  db, runAgent, keys, config, RW_WORKSPACE, RW_FS_ROOT, ensureRun, markRun,
  env = process.env, now = () => Date.now(),
}) {
  const t0 = now();
  const bad = (code, message, extra) => { const e = new Error(message); e.code = code; Object.assign(e, extra); throw e; };
  if (!String(task || '').trim()) bad('PARAM_MISSING', '缺任务文本');

  const conv = await resolveConversation(db, { conversationId, permission, task });
  // 落用户消息：**先落库再送引擎**（引擎的返回也可能失败/挂起，而"用户说了什么"必须已经在账上；
  // 平台侧 /api/chat 也是这个顺序，见 server/index.js:874）。原子守卫防"并发删会话"产生孤儿消息。
  await db.query('INSERT INTO messages (conversation_id, role, content) SELECT ?,?,? FROM conversations WHERE id=?',
    [conv.id, 'user', String(task), conv.id]);
  await db.query('UPDATE conversations SET updated_at=NOW() WHERE id=?', [conv.id]);

  const messages = await assembleMessages({ db, conv, task, RW_WORKSPACE });
  // 长任务现场（断点恢复外壳）：与平台侧同口径（server/index.js:1147），非轻量档一律登记。
  const run = ensureRun ? await ensureRun({ conversationId: conv.id, accountId: await defaultAccountId(db), goal: task }).catch(() => null) : null;

  // 预算融合（§4.1「不发明参数」：阈值全部读 settings 现值，CLI 不设自己的数）
  let budgetRemain = null;
  try {
    const total = Number(await setting(db, 'task_budget_total', 100)) || 0;
    if (total > 0) {
      const spent = (await db.query('SELECT COALESCE(SUM(cost),0) c FROM usage_stats WHERE conversation_id=? AND created_at > NOW() - INTERVAL 24 HOUR', [conv.id]))[0] || {};
      budgetRemain = Math.max(0, total - Number(spent.c || 0));
    }
  } catch { /* 预算查询失败不阻断（null=不限），与平台侧同处置 */ }

  // 工具启用集与 allow/deny 规则：**平台的操作者配置**，headless 不能绕开（绕开=同一个任务在
  // CLI 里能用的工具比网页里多，那是权限口径分叉）。两处取值与 server/index.js:1167-1184 同源同默认。
  let enabledTools = null;
  try {
    const saved = await setting(db, 'toolset_enabled', null);
    const arr = Array.isArray(saved) ? saved : null;
    if (arr && arr.length) enabledTools = new Set(arr.filter((x) => typeof x === 'string'));
  } catch { enabledTools = null; }
  let accessRules = null;
  try { const ar = await setting(db, 'access_rules', null); accessRules = Array.isArray(ar) ? ar : null; } catch { accessRules = null; }

  const provider = env.RW_RUN_PROVIDER || conv.provider || 'deepseek';
  const model = env.RW_RUN_MODEL || conv.model || 'deepseek-v4-flash';
  const ctx = {
    permission: conv.permission,
    conversationId: conv.id,
    root: conv.permission === 'full' ? RW_FS_ROOT : RW_WORKSPACE,
    accountId: await defaultAccountId(db),
    __runId: run ? run.id : null,
    __budgetRemain: budgetRemain,
    __enabledTools: enabledTools,
    __accessRules: accessRules,
    // 无人值守：headless 的调用方是脚本/CI/别的程序，**没有人坐在那里按审批**。这一位决定
    // 轮次与时间熔断是否生效（server/agent.js:277/531）——不置位则"打转的任务"会一直跑下去，
    // 而 headless 没有"点停止"的入口。审批/问询在无人值守下走**排队**语义（tools/index.js），
    // 由平台上的人在网页端处理，不是静默放行。
    __autonomous: true,
    __light: false, // 全量工具面：headless 是"让它干活"的入口，纯问答也能跑（模型可选择不调工具）
    mode: 'chat', preset: 'all',
  };
  const trace = makeEmitter(quiet);
  logLine('会话 ' + conv.id + (conv.created ? '（新建）' : '') + ' · ' + provider + '/' + model + ' · permission=' + conv.permission, quiet);
  const outcome = await runAgent({
    provider, model, messages, permission: conv.permission, ctx, keys, temperature: 0.4, emit: trace.emit,
  });

  // 落 assistant 回复（含思考）：与平台侧同一条 INSERT 形状，落完再写 stdout ——
  // "durable before printf"：stdout 一旦出现这一行，调用方就会认为结果已经落定，此刻它必须真的落了。
  const status = statusOf(outcome);
  const content = String(outcome.content || '');
  let messageId = null;
  try {
    const r = await db.query('INSERT INTO messages (conversation_id, role, content, reasoning, model, provider, tokens_in, tokens_out) SELECT ?,?,?,?,?,?,?,? FROM conversations WHERE id=?',
      [conv.id, 'assistant', content, null, model || provider, provider,
        (outcome.usage && outcome.usage.tokens_in) || 0, (outcome.usage && outcome.usage.tokens_out) || 0, conv.id]);
    messageId = (r && r.insertId) || null;
    if (messageId) await db.query('UPDATE tool_calls SET message_id=? WHERE conversation_id=? AND message_id IS NULL', [messageId, conv.id]);
  } catch (e) {
    // 落库失败**必须出声**，但结果仍在（内容在 stdout 里）——如实把失败写进 stderr，不让它静默。
    process.stderr.write(PROG + ': assistant 落库失败（结果仍已输出，但会话历史里缺这一条）：' + ((e && e.message) || e) + '\n');
  }
  if (run && markRun) {
    try {
      await markRun(run.id, outcome.stopped ? 'interrupted' : outcome.paused ? 'paused' : 'completed',
        outcome.stopped ? '调用方中止' : outcome.paused ? (outcome.reason || '挂起') : (outcome.guard ? '护栏：' + outcome.guard : ''));
    } catch { /* 现场状态登记失败不影响结果 */ }
  }

  const toolCalls = (outcome.toolLog || []).map((t) => ({ name: t.name, status: t.status, code: t.code || null, durationMs: t.durationMs ?? null }));
  const payload = {
    ok: status === 'saved',
    status,
    task: String(task),
    conversationId: conv.id,
    conversationCreated: conv.created,
    permission: conv.permission,
    provider, model,
    content,
    contentLength: content.length,
    messageId,
    runId: run ? run.id : null,
    finishReason: outcome.finishReason || '',
    guard: outcome.guard || null,
    reason: outcome.reason || null,
    toolCalls,
    usage: outcome.usage || {},
    totals: outcome.usageTotals || null,
    spentYuan: outcome.spentYuan ?? null,
    durationMs: now() - t0,
  };
  return { payload, exitCode: payload.ok ? EXIT_OK : EXIT_RUN };
}

// ---------------------------------------------------------------------------
// CLI 外壳：解析 → 动态装载引擎 → 跑 → 输出 → 关连接池 → 退出
// ---------------------------------------------------------------------------

async function main() {
  let args = null; // 作用域提到 try 之外：catch 里要靠它回显"这次让它跑的是什么"
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    // 用法错：结构化结果照给（stdout 一行），说明也照给（stderr），退出码 2
    emitResult(failResult(e.code || 'PARAM_MISSING', e.message));
    process.stderr.write(PROG + ': ' + e.message + '\n');
    return EXIT_USAGE;
  }
  if (args.help) { process.stdout.write(HELP_TEXT); return EXIT_OK; }

  let pool = null;
  try {
    // 动态 import：`--help` 与用法错**绝不碰数据库连接池**（否则一条帮助命令也会去连库、还可能挂住）
    const [{ db, pool: p, initSchema }, { runAgent }, { config }, envMod, runtrack] = await Promise.all([
      import('../server/db.js'),
      import('../server/agent.js'),
      import('../server/config.js'),
      import('../server/env.js'),
      import('../server/runtrack.js'),
    ]);
    pool = p;
    // 建表/迁移：与服务启动是**同一件事**（server/index.js 启动时也调它），且全部幂等
    // （CREATE TABLE IF NOT EXISTS / INSERT IGNORE / 链上已应用的迁移直接跳过）。
    // 为什么 headless 也要做：v0.3 §4.1「单进程可启动」——一次性入口不该要求"先把 Web 服务起过一遍"，
    // 否则在干净机器上（G1 出口）第一条命令就撞 Unknown table，而报错还看不出该去起服务。
    // 失败必须出声：库里够不着/迁移链有缺口时如实抛出，由下面的 catch 转成结构化失败。
    await bootstrapStorage({ initSchema });
    const { payload, exitCode } = await runHeadless({
      task: args.task, conversationId: args.conversationId, permission: args.permission, quiet: args.quiet,
      db, runAgent, keys: config.keys, config,
      RW_WORKSPACE: envMod.RW_WORKSPACE, RW_FS_ROOT: envMod.RW_FS_ROOT,
      ensureRun: runtrack.ensureRun, markRun: runtrack.markRun,
    });
    emitResult(payload);
    if (!payload.ok) process.stderr.write(PROG + ': 未跑完（status=' + payload.status + (payload.guard ? ' guard=' + payload.guard : '') + (payload.reason ? ' reason=' + payload.reason : '') + '）\n');
    return exitCode;
  } catch (e) {
    // 异常一律**结构化**出去：调用方拿到的是可路由的码，不是一句中文。
    // 带上这次请求的入参（任务/会话）：失败时调用方最想知道的正是"我让它跑的是什么"，
    // 参数解析阶段就失败时它们还没解出来，如实给 null。
    emitResult(failResult(e && e.code ? e.code : 'INTERNAL', (e && e.message) || String(e), {
      task: args ? args.task : null,
      conversationId: args ? args.conversationId : null,
      permission: args ? args.permission : null,
    }));
    process.stderr.write(PROG + ': ' + ((e && e.stack) || e) + '\n');
    return e && e.code === 'PARAM_MISSING' ? EXIT_USAGE : EXIT_RUN;
  } finally {
    // 等连接池收干净再退：引擎里有若干 fire-and-forget 的账本写（如 prefix:invalidate/collapse），
    // 直接 process.exit() 会把它们连同尚未落盘的账一起丢掉（这正是 agent-smoke 那条"静默丢账"教训的同一类）。
    if (pool) { try { await pool.end(); } catch { /* 收尾失败不影响已输出的结果 */ } }
  }
}

// 只有被直接执行时才跑（被 import 做单测时不产生副作用）
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  // 显式 process.exit：stdout 已写完，且池子已 end；这里退出是为了不留下任何把手（定时器/连接）
  main().then((code) => { process.exit(code); }).catch((e) => {
    emitResult(failResult('INTERNAL', (e && e.message) || String(e)));
    process.stderr.write(PROG + ': ' + ((e && e.stack) || e) + '\n');
    process.exit(EXIT_RUN);
  });
}
