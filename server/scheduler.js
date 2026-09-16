// server/scheduler.js - 定时任务（F14/C12）+ 空闲会话自动归档（WS5e P2 触发）
// cron 简化格式："分 时 日 月 周"（* 通配，如每日 2:30 = "30 2 * * *"）
// 周字段非标准：0=周一（常规 cron 为 0=周日），内部以周一为一周起点；如"周一 05:00"="0 5 * * 0"（2026-09-06 注）
// 调度器每分钟检查一次到期任务 → 创建/复用会话执行 runAgent → 记录结果
import { db } from './db.js';
import { storage } from './storage/index.js'; // v0.3 §4.1「存储走接口」：归档后的沉淀提案读会话经历走接口
import { runAgent } from './agent.js';
import { summarizeConversation } from './tools/index.js';
import { sinkSessionKnowledge } from './selfeval/knowledge-sink.js';
import { config } from './config.js';
import { RW_WORKSPACE, RW_FS_ROOT } from './env.js';
// 编排面（v0.3 §4.5）：定时档的**源**就在这个 cron 循环里——每轮扫描触发一次 `schedule`，
// 手动跑一次（`__manual`，入口是 `POST /api/tasks/:id/run`）触发一次 `manual`。
// handler 归使用方写（本文件一个都不注册）；投递走 `fireSafely`：**fire-and-forget 且永不抛错**
// ⇒ 触发面坏一次不许打断本轮扫描，更不许把一次定时执行变成失败。
import { fireSafely } from './triggers.js';

export function cronToNext(cron, from = new Date()) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  // 解析每个字段：支持 *、*/n（步进）、固定值
  const parse = (v) => {
    if (v === '*') return { val: null, step: 1 };
    if (/^\*\//.test(v)) return { val: null, step: Math.max(1, Number(v.slice(2)) || 1) };
    const n = Number(v);
    if (Number.isNaN(n)) return { val: -1, step: 1 };
    return { val: n, step: 1 };
  };
  const [mm, hh, dd, mo, dw] = parts.map(parse);
  if ([mm, hh, dd, mo, dw].some((x) => x.val === -1)) return null;
  const match = (unit, x, lo, hi) => {
    if (x.val !== null) return unit === x.val;
    return x.step > 1 ? unit % x.step === 0 : true;
  };
  for (let i = 0; i < 60 * 24 * 366; i++) {
    const d = new Date(from.getTime() + i * 60000);
    if (!match(d.getMinutes(), mm, 0, 59)) continue;
    if (!match(d.getHours(), hh, 0, 23)) continue;
    if (!match(d.getDate(), dd, 1, 31)) continue;
    if (!match(d.getMonth() + 1, mo, 1, 12)) continue;
    const cw = (d.getDay() + 6) % 7; // 0=周一
    if (dw.val !== null && cw !== dw.val) continue;
    if (dw.val === null && dw.step > 1 && cw % dw.step !== 0) continue;
    return d;
  }
  return null;
}

export function isCronDue(task, now = new Date()) {
  if (!task.next_run) return false;
  return new Date(task.next_run) <= now;
}

/** 给"该有 next_run 却没有"的任务补算下次运行时刻（`database` 可注入：夹具用假库驱动一轮扫描） */
export async function computeNextRuns(database = db) {
  const tasks = await database.query('SELECT id, cron FROM scheduled_tasks WHERE enabled=1 AND next_run IS NULL');
  for (const t of tasks) {
    const next = cronToNext(t.cron);
    if (next) await database.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [next, t.id]);
  }
}

/**
 * 定时任务的执行上下文（纯函数，可夹具直测）。
 * **必须显式带 permission**：execTool 是按 `ctx.permission` 决定是否限制路径的
 * （tools/index.js：`limitPath = ctx.permission === 'read' || ctx.permission === 'write'`）。
 * 这里原先漏了它，于是所有定时任务都被当成受限会话、一律被围栏限制在 RW_WORKSPACE 内，
 * 与任务配置的 permission=full 不符（实测：task#7 连错 7 次"路径超出工作区"）。
 * @param {{account_id:number, permission?:string}} task
 * @param {number} conversationId
 * @param {{shell_id?:number}|null} conv 任务会话行（可带 shell_id）
 */
export function taskExecContext(task, conversationId, conv = null, accessRules = null) {
  const permission = task.permission || 'full';
  return {
    permission,
    accountId: task.account_id,
    conversationId,
    root: permission === 'full' ? RW_FS_ROOT : RW_WORKSPACE,
    __accessRules: accessRules,
    shellId: (conv && conv.shell_id != null) ? conv.shell_id : null,
    // 2026-09-15：定时任务**本来就是无人值守**，此前漏标 `__autonomous`（driver 标了、scheduler 没标）。
    // 它决定两件事：① 轮次/时间熔断是否生效（只在无人值守时生效 —— 人在场的会话改用"无进展轮数"判据）
    // ② 需要授权时是"排队等下次"还是"干等一个人来点"（见 tools/index.js 的无人值守分支）。
    // 对定时任务来说两者都该按"无人"处理：等一个不会来的人，只会占着调度槽位到超时。
    __autonomous: true,
  };
}

// 执行一个定时任务
// A8：写 task_history（执行历史/失败告警数据源）；手动补跑（task.__manual=true）不推进 next_run
export async function executeScheduledTask(task) {
  console.log(`[scheduler] 执行定时任务 ${task.id}: ${task.name}${task.__manual ? '（手动跑一次）' : ''}`);
  const t0 = Date.now();
  let resultText = '';
  let histId = null;
  try {
    try {
      const h = await db.query('INSERT INTO task_history (task_id, started_at, ok) VALUES (?, NOW(), 0)', [task.id]);
      histId = h.insertId;
    } catch { /* task_history 不可用不影响执行 */ }
    const acc = await db.query('SELECT id FROM accounts WHERE id=?', [task.account_id]);
    if (!acc.length) { resultText = '账号不存在'; }
    else {
      // 创建/复用该任务的专用会话（channel=task）
      let conv = (await db.query('SELECT id FROM conversations WHERE channel="task" AND external_id=?', ['task-' + task.id]))[0];
      if (!conv) {
        const r = await db.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (?,"task",?,?,?)', [task.account_id, 'task-' + task.id, task.permission || 'full', '定时任务：' + task.name]);
        conv = { id: r.insertId };
      }
      let accessRules = null;
      try { const ar = await db.query("SELECT svalue FROM settings WHERE skey='access_rules'"); if (ar[0]) { const v = JSON.parse(ar[0].svalue); if (Array.isArray(v)) accessRules = v; } } catch { accessRules = null; }
      // A7/A8：任务绑定的进化目标（勾选目标 → 逐条拼进指令，一次跑完所有勾选目标；无绑定=仅跑原 prompt）
      let goalLines = '';
      try {
        const gs = await db.query('SELECT g.name, g.descr FROM evo_goal_tasks b JOIN evo_goals g ON g.id=b.goal_id WHERE b.task_id=? AND g.status="active"', [task.id]);
        if (gs.length) goalLines = '\n\n【本次须执行的目标（进化集勾选，逐条完成）】\n' + gs.map((g, i) => (i + 1) + '. ' + g.name + (g.descr ? '——' + String(g.descr).slice(0, 300) : '')).join('\n');
      } catch { /* 目标绑定不可用则忽略 */ }
      // 2026-09-15 修：ctx 必须带 permission —— 见 taskExecContext 的注释（原实现漏了它，
      // 于是所有定时任务都被当成受限会话、一律被围栏限制在 RW_WORKSPACE 内，与 permission=full 不符）。
      const effectivePermission = task.permission || 'full';
      const ctx = taskExecContext(task, conv.id, conv, accessRules);
      // 编排面（v0.3 §4.5）**手动档的源**：`task.__manual` 只有一条路能置上——`server/index.js` 里
      // `POST /api/tasks/:id/run` 那个处理器（任务列表的 ▶ 跑一次；行号随该文件演进会漂，按端点名找）。
      // 它本来就是"人主动触发一次执行"，与 `schedule` 档（cron 到点）是两件事，所以在这里分清后再投递。
      // 载荷只带排障要用的标识（任务 id / 名字 / 会话 id），**不带 prompt 正文、不带任何凭据**。
      fireSafely(task.__manual ? 'manual' : 'schedule',
        { taskId: task.id, name: task.name, conversationId: conv.id },
        { source: task.__manual ? 'http' : 'cron' });
      const result = await runAgent({ provider: task.provider, model: task.model, messages: [{ role: 'user', content: task.prompt + goalLines }], permission: effectivePermission, ctx, keys: config.keys });
      resultText = (result.content || '').slice(0, 5000);
      // 写入会话消息（可回看）
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'user', '【定时任务】' + task.name + (task.__manual ? '（手动跑一次）' : '') + '\n' + task.prompt + goalLines]);
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'assistant', resultText]);
    }
  } catch (e) {
    resultText = '执行失败: ' + e.message;
  }
  const failed = /^执行失败/.test(resultText);
  const next = cronToNext(task.cron);
  // 手动跑一次：保留既有 next_run（不因补跑打乱排程）
  if (task.__manual) {
    await db.query('UPDATE scheduled_tasks SET last_run=NOW(), last_result=?, enabled=enabled WHERE id=?', [resultText.slice(0, 3000), task.id]);
  } else {
    await db.query('UPDATE scheduled_tasks SET last_run=NOW(), last_result=?, next_run=?, enabled=enabled WHERE id=?',
      [resultText.slice(0, 3000), next, task.id]);
  }
  try {
    if (histId) await db.query('UPDATE task_history SET finished_at=NOW(), ok=?, note=? WHERE id=?', [failed ? 0 : 1, resultText.slice(0, 1000), histId]);
    else await db.query('INSERT INTO task_history (task_id, started_at, finished_at, ok, note) VALUES (?, NOW(), NOW(), ?, ?)', [task.id, failed ? 0 : 1, resultText.slice(0, 1000)]);
  } catch { /* 历史写失败不影响任务 */ }
  console.log(`[scheduler] 任务 ${task.id} 完成（${Date.now() - t0}ms${failed ? '，失败' : ''}）`);
  return resultText;
}

// 主调度循环：每分钟检查（到期任务并发上限 2，防停机积压并发风暴；未执行的下轮补）
let schedulerRunning = 0;
// 在跑任务集（2026-09-15 修）：`due` 是**查询那一刻**的快照，其 next_run 是旧值。
// 若任务执行超过一分钟，下一轮扫描拿到的还是同一个旧 next_run → 同一个任务被**再排一次**。
// 2026-09-09 那次修复只挡住了"同一分钟内并发双跑"（钳制推进量 ≥ 当前+60s），
// 但"执行时长 > 60s"的**顺序双跑**仍会发生——实测证据：task_history 里 #4 在 8/11 天各跑两次
// （如 09-15 05:00:49 与 05:01:49），#3 两次运行也都是双跑。真实浪费。
const inFlight = new Set();
export function isTaskInFlight(id) { return inFlight.has(Number(id)); }

/**
 * **一轮扫描**（原先是 `startScheduler` 里 `setInterval` 的回调体，2026-09-16 原样抽出）：
 * 补算 next_run → 取到期任务 → 逐个推后 next_run 并发起执行。
 * 抽出来的唯一理由：编排面（v0.3 §4.5）的**定时档源**就在这一轮里，而"源接线了没有"
 * 必须能被夹具驱动一次真扫描确证——`setInterval` 的回调体在夹具里够不着，抽成一个具名函数即可
 * （`db` 是既有单例、可参数注入：夹具传假库驱动一轮，**不需要**在本文件里加任何测试专用分支）。
 *
 * 行为与抽出前**逐字一致**（单轮防重入、并发上限 2、推进量钳制三处一个字没动）：
 * 唯一新增的是真的发起执行时往编排面投递一次 `schedule`（载荷＝任务 id/名字/名字/本轮到期数/本轮总数，
 * **不带 prompt 与凭据**）；投递是 fire-and-forget，且**内部已兜住一切异常**
 * ⇒ 它既不改变本轮的推进决定，也不会让扫描提前结束。
 *
 * @param {{db?:{query:Function}, runner?:(task:object) => Promise<any>}} [deps]
 *   `db`：数据库单例（默认本文件的既有依赖）；`runner`：单个任务的执行器（默认 `executeScheduledTask`）
 * @returns {Promise<{scanned:number, due:number, started:number, failed:number}>} 本轮读数（观测用）
 */
export async function runSchedulerTick({ db: database = db, runner = executeScheduledTask } = {}) {
  const out = { scanned: 0, due: 0, started: 0, failed: 0 };
  // 扫描计数只用于触发载荷（"这一轮一共在看多少条"）：它单独一次查询，**不改** computeNextRuns 里那条
  // 既有查询；不用 `due.length` 冒充"任务总数"——那会把载荷写成一句听起来对、其实说错的读数。
  const all = await database.query('SELECT COUNT(*) AS n FROM scheduled_tasks WHERE enabled=1 AND next_run IS NOT NULL');
  out.scanned = Number((all[0] && all[0].n) || 0);
  await computeNextRuns(database);
  const due = await database.query('SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run IS NOT NULL AND next_run <= NOW()');
  out.due = due.length;
  for (const t of due) {
    if (schedulerRunning >= 2) break;
    if (inFlight.has(t.id)) { console.log(`[scheduler] 任务 ${t.id} 仍在执行中，跳过本轮（防双跑）`); continue; }
    // 防重入：先把 next_run 推后，避免并发重复执行
    // 2026-09-09 修复：cronToNext 在 cron 分钟（如 05:00:xx）内被调用时返回"当前已过/当前"时刻
    // （循环从 from+0 开始且不强制未来），导致 next_run 推进后仍 <= NOW → 下一轮 60s 检查再次入队。
    // 钳制：推进值必须 ≥ 当前+60s。
    // 2026-09-15 补：推进值必须**真正跨过本次排程点**，且据"已决定的推进值"计算下一轮，
    // 而不是再据 now 算一次（否则仍会落回本分钟）。两者合起来才保证"一次排程只跑一次"。
    let next = cronToNext(t.cron);
    if (!next || next.getTime() <= Date.now() + 60000) next = new Date(Date.now() + 60000);
    const anchor = new Date(Math.max(next.getTime(), Date.now() + 60000));
    const nextAfterAnchor = cronToNext(t.cron, new Date(anchor.getTime() + 60000));
    next = nextAfterAnchor && nextAfterAnchor.getTime() > anchor.getTime() ? nextAfterAnchor : anchor;
    await database.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [next, t.id]);
    schedulerRunning += 1;
    inFlight.add(t.id);
    out.started += 1;
    // 编排面（v0.3 §4.5）**定时档的源**：本轮真的发起执行时投递一次 `schedule`。
    // 载荷只带排障要的四格（任务 id / 名字 / 本次推进到的 next_run / 本轮读数），**不带 prompt、不带凭据**。
    // 编排面（v0.3 §4.5）**定时档的源**：本轮真的发起执行时投递一次 `schedule`。
    // 载荷只带排障要的四格（任务 id / 名字 / 本次推进到的 next_run / 本轮读数），**不带 prompt、不带凭据**。
    fireSafely('schedule',
      { taskId: t.id, name: t.name, nextRun: next.toISOString(), due: out.due, scanned: out.scanned },
      { source: 'cron', due: out.due, scanned: out.scanned });
    // `Promise.resolve().then(...)` 不是为了好看：`runner` 若**同步抛错**（夹具注入的执行器、或将来某个
    // 非 async 的实现），直接 `runner(t).catch(...)` 会在挂 `.catch` 之前就抛出，于是这一轮的
    // `schedulerRunning` 与 `inFlight` **永久留一条**（此后并发上限被吃掉一格，任务再也排不满）。
    // 包一层之后"同步抛"变成"拒绝"，`.finally` 一定会跑，两个计数一定会回落。
    Promise.resolve().then(() => runner(t))
      .catch((e) => { out.failed += 1; console.error('[scheduler] 执行异常:', e.message); })
      .finally(() => { schedulerRunning = Math.max(0, schedulerRunning - 1); inFlight.delete(t.id); });
  }
  return out;
}

export function startScheduler() {
  setInterval(async () => {
    // 容错口径**保持原样**（原先那个空 catch 就是"调度循环容错"）：本轮任何异常只记一行，
    // 60s 后照常进入下一轮。触发面的异常到不了这里（`fireSafely` 自己已兜住）。
    try { await runSchedulerTick(); } catch (e) { console.error('[scheduler] 扫描异常（下轮照常）:', (e && e.message) || e); }
  }, 60000);
  console.log('[scheduler] 定时任务调度器已启动（每分钟检查，并发≤2）');
  // WS5e P2 自动归档：每 10 分钟扫"24h 无消息且消息数>60 且摘要落后于最后活动"的会话，自动 summarizeConversation（最多 3 个/轮）
  setInterval(async () => {
    try {
      const cands = await db.query(
        `SELECT c.id FROM conversations c
         WHERE c.channel='web'
           AND c.updated_at < NOW() - INTERVAL 24 HOUR
           AND (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) > 60
           AND NOT EXISTS (SELECT 1 FROM conv_summaries s WHERE s.conversation_id=c.id AND s.updated_at > c.updated_at)
         ORDER BY c.updated_at ASC LIMIT 3`);
      for (const c of cands) {
        try {
          await summarizeConversation(c.id, { semantic: true, keys: config.keys });
          // 「受限自动沉淀」接线点之二（v0.3 §4.3 记忆行；选点理由见 server/selfeval/knowledge-sink.js 文件头）：
          // **摘要刚生成**就是"这段经历哪些值得留下"最清楚的时刻——与 /api/chat 收尾那条是同一个时机，
          // 所以调的是同一个 `sinkSessionKnowledge`（产出**待审卡片**，不写库）。
          // 这里不传 `emit`：那一端没有连着的客户端。卡片照常落在既有待答队列里（`GET /api/asks`），
          // GUI 打开时照常看得到——不为"没有观众的帧"造一条假投递。
          // 失败/无候选一律静默跳过（只记一行日志），不许把一次自动归档弄失败。
          const sink = await sinkSessionKnowledge({ conversationId: c.id, storage, dbc: db });
          if (sink.errors.length) console.warn('[knowledge-sink] 归档后沉淀提案未完全成功 conv#' + c.id + '：' + sink.errors.join('；'));
        } catch (e) { console.error('[scheduler] 归档失败 conv#' + c.id + ':', e.message); }
      }
      if (cands.length) console.log('[scheduler] 自动归档', cands.length, '个空闲长会话');
    } catch (e) { /* 归档扫描容错 */ }
  }, 600000);
  console.log('[scheduler] 空闲会话自动归档已启动（每 10 分钟）');
}
