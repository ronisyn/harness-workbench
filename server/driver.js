// server/driver.js - 任务契约外部驱动器（责任循环）
// 白天：讨论达成共识 → create_contract 立项（queued, run_at 决定立即或夜间窗口）
// 驱动器每 15s 扫描：queued&到点 → 在专用执行会话里驱动一轮 runAgent：
//   目标未变 + 现场/历史 + 契约注入 + 验收标准；模型只能以 3 种方式结束本轮：
//   (a) 调用 finish_task → 驱动器跑验收钩子 → 通过=candidate_done（等你复测确认）/ 失败=打回继续
//   (b) ask_user/审批（无人值守自动排队 need_input，等你作答）
//   (c) 直接收尾（未 finish_task）→ 驱动器要求继续（最多 N 次无进展后转 need_input 请你裁决）
// 用户复测确认后 status=done；该任务才算真正完成。
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { persistContractEvent } from './eventlog.js';
import { runAgent } from './agent.js';
import { config } from './config.js';
import { RW_WORKSPACE, RW_FS_ROOT } from './env.js';
import { execPlan, execArgv } from './exec/index.js';

const WS = RW_WORKSPACE;
// 驱动器起的契约会话权限档（与下面 ctx.permission 同一出处：无人值守契约会话＝full）
const DRIVER_PERMISSION = 'full';
const MAX_AUTO_ROUNDS = 60;        // 单契约每次激活最多自动轮次（进展型护栏，防失控账单）
const MAX_IDLE_CONCLUDE = 2;       // 连续"没调用 finish_task 就收尾"几次后请你裁决
let running = new Set();           // 正在执行的 contract id（驱动器自身并发 ≤2）

// 契约事实**只从账本走**（v0.3 §0.5「不留两套」的过账判定 C-39 第 ② 条：`contract_events` 与 `events` 同源）：
// 这里不再自己 INSERT `contract_events`，而是把事实交给 `eventlog.persistContractEvent` —— 账本一行
// （`events`，唯一账本）＋ `contract_events` 一行（它的投影，带回指账本行的 `event_id`）由那一次调用写完。
// 失败仍与改造前一样吞掉：契约事件属观测面，不许因为写不进账而让整轮驱动失败（同 eventlog 的落账口径）。
async function addEvent(contractId, kind, detail, conversationId) {
  try { await persistContractEvent(contractId, kind, detail, { conversationId }); } catch { /* ignore */ }
}

async function setStatus(c, status, extra = {}) {
  const sets = ['status=?', 'updated_at=NOW()'];
  const p = [status];
  if (extra.lastResult !== undefined) { sets.push('last_result=?'); p.push(String(extra.lastResult).slice(0, 3000)); }
  if (extra.attempts !== undefined) { sets.push('attempts=?'); p.push(extra.attempts); }
  p.push(c.id);
  await db.query(`UPDATE task_contracts SET ${sets.join(',')} WHERE id=?`, p);
}

async function appendConvMsg(convId, role, content) {
  await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [convId, role, String(content).slice(0, 8000)]);
}

async function findOrCreateConv(c) {
  if (c.conv_id) return c.conv_id;
  const row = (await db.query('SELECT id FROM conversations WHERE channel="task" AND external_id=?', ['contract-' + c.id]))[0];
  if (row) return row.id;
  const r = await db.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (?,"task",?,?,?)', [c.account_id ?? null, 'contract-' + c.id, 'full', '任务：' + (c.title || c.id)]);
  await db.query('UPDATE task_contracts SET conv_id=? WHERE id=?', [r.insertId, c.id]);
  return r.insertId;
}

async function runShellCmd(line) {
  // 验收命令行按**本机 shell**执行，argv 与 execFile 选项都取自执行后端（server/exec 的 argv 级接缝）：
  // 平台事实（Linux 是 bash -c，Windows 是 PowerShell -Command）只落在后端实现里，⑰ 沙箱也只包这一层
  // ——驱动器这条验收路径才不会成为绕过沙箱的第二个入口。
  // 为什么不用后端现成的 execShell 动词：它的截断口径（stdout 8000 / stderr 2000，且超时额外补一句"命令已被
  // 终止"）是 run_command 那条路的**模型可见形状**；验收结果的形状是 out≤2000 / err≤1000 且超时不多话，
  // 两者口径不同，故这里取 argv 接缝 + 自己的形状，行为与改造前逐字相同。
  // （此前那个 `ch.on('error')` 分支是**到不了的**：带回调时 execFile 先把启动失败交给回调，
  //   实测 `definitely-not-a-real-exe` 的顺序是 callback(ENOENT) → error 事件，而 Promise 只认第一次 resolve。）
  const plan = execPlan({ line: String(line).slice(0, 2000), cwd: WS, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const r = await execArgv([plan.command, ...plan.args], { ...plan.options, permission: DRIVER_PERMISSION, workspaceRoot: WS });
  return { ok: r.ok, code: r.code, out: String(r.out || '').slice(0, 2000), err: String(r.err || '').slice(0, 1000) };
}

// WS9 验收行 DSL：无前缀或 cmd:=bash（向后兼容）；file-exists:<path>；grep:<re>|<path>；node:<repo相对脚本>；kpi:<dotpath> <op> <num>
async function checkLine(line) {
  const m = /^(cmd|file-exists|grep|node|kpi):(.*)$/s.exec(String(line));
  if (!m) return runShellCmd(String(line)); // 兼容旧格式
  const kind = m[1];
  const rest = String(m[2] || '').trim();
  const runNode = async (script, args = []) => {
    // 验收 DSL 的 node: 分支收的是**契约里写的脚本路径**（模型/用户写进验收行的东西）⇒ argv 可能被模型影响
    // ⇒ 经执行后端的 argv 动词（⑰ 沙箱在这里包）。驱动器会话的权限档是 full（见下面 ctx 的 permission），
    // 按 ⑰ 的口径 full 是"按设计不沙箱"——但仍逐次如实上报 enforcement，不假装隔离。
    const r = await execArgv(['node', path.join(config.root, script), ...args],
      { cwd: config.root, timeout: 90000, maxBuffer: 4 * 1024 * 1024, permission: DRIVER_PERMISSION, workspaceRoot: WS });
    return { ok: r.ok, code: r.code, out: String(r.out || '').slice(0, 2000), err: String(r.err || '').slice(0, 1000) };
  };
  if (kind === 'cmd') return runShellCmd(rest);
  if (kind === 'file-exists') {
    const ok = fs.existsSync(rest);
    return { ok, code: ok ? 0 : 1, out: ok ? '存在: ' + rest : '', err: ok ? '' : '文件/路径不存在: ' + rest };
  }
  if (kind === 'grep') {
    const [re, p] = rest.split('|').map((s) => s.trim());
    try {
      const c = fs.readFileSync(p, 'utf8');
      const ok = new RegExp(re).test(c);
      return { ok, code: ok ? 0 : 1, out: ok ? '匹配: ' + re + ' in ' + p : '', err: ok ? '' : '未匹配 ' + re + ' in ' + p };
    } catch (e) { return { ok: false, code: 1, out: '', err: e.message }; }
  }
  if (kind === 'node') return runNode(rest);
  if (kind === 'kpi') {
    const mm = /^([\w.]+)\s*(<=|>=|<|>|==|!=)\s*([\d.]+)$/.exec(rest);
    if (!mm) return { ok: false, code: 1, out: '', err: 'kpi DSL 语法: kpi:<指标点路径> <op> <数值>，如 kpi:usage.cost < 5' };
    const r = await runNode('scripts/kpi.mjs', ['--days', '30', '--json']);
    if (!r.ok) return { ok: false, code: 1, out: '', err: 'kpi 执行失败: ' + r.err };
    let data;
    try { data = JSON.parse(r.out); } catch { return { ok: false, code: 1, out: '', err: 'kpi 输出解析失败' }; }
    const val = mm[1].split('.').reduce((o, k) => (o == null ? o : o[k]), data);
    if (typeof val !== 'number') return { ok: false, code: 1, out: '', err: '指标不存在或非数值: ' + mm[1] };
    const ops = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
    const ok = ops[mm[2]](val, Number(mm[3]));
    return { ok, code: ok ? 0 : 1, out: mm[1] + '=' + val + ' ' + mm[2] + ' ' + mm[3], err: ok ? '' : mm[1] + '=' + val + ' 不满足 ' + mm[2] + ' ' + mm[3] };
  }
  return runShellCmd(rest);
}

async function runAcceptance(c) {
  const lines = (() => { try { return JSON.parse(c.acceptance || '[]'); } catch { return []; } })();
  const results = [];
  for (const line of lines) {
    const r = await checkLine(line);
    results.push({ check: String(line).slice(0, 150), ok: r.ok, detail: r.ok ? (String(r.out || '').slice(0, 150)) : (String(r.err || ('exit ' + r.code)).slice(0, 200)) });
    if (!r.ok) break;
  }
  return { pass: lines.length === 0 || results.every((x) => x.ok), results };
}

// 无人值守时用户输入的排队钩子（ask_user / 审批 触发）
async function needInput(c, payload, conversationId) {
  await db.query('UPDATE task_contracts SET last_ask=?, status="need_input", updated_at=NOW() WHERE id=?', [JSON.stringify(payload), c.id]);
  await addEvent(c.id, 'need_input', JSON.stringify(payload).slice(0, 500), conversationId);
}

async function driveContract(c) {
  if (running.has(c.id)) return;
  running.add(c.id);
  // 契约事实的归属会话：账本按会话归属（见 addEvent），所以它在 try 外先声明 —— 异常路径也要能报出
  // 归属；首次执行时 `task_contracts.conv_id` 还是 NULL，会话是下面 findOrCreateConv 才建的。
  let convId = null;
  try {
    await setStatus(c, 'running');
    // 先取/建会话再落 'start'：顺序反过来（改造前的写法）意味着第一条契约事实没有归属会话可写，
    // 而账本不接受无归属的账（eventlog 的既有口径）—— 那就会丢掉这轮执行的起点。
    convId = await findOrCreateConv(c);
    await addEvent(c.id, 'start', '驱动器开始一轮执行', convId);
    // 历史：**全量、原样**（v0.3 §4.4.1 规则1「只追加：禁止中途改写早期消息；折叠只在**段边界整段替换一次**」）。
    // 2026-09-16 改（与 `/api/chat`、headless 同一口径）：这里原有**两道**窗口，都已删除 ——
    //   ① SQL 的 `ORDER BY id DESC LIMIT 30`（只取最近 30 条，再 `reverse()`）；
    //   ② `hist.length > 26 ? [一行提示, ...hist.slice(-26)] : hist`（越过 26 条就把最老的换成一行提示）。
    // 为什么它们是缺陷：历史一旦越过 26 条，**每一轮**的前缀头一条都被换掉 —— 前缀按逐字节匹配，
    //   被换掉之处起的整段缓存作废。这与规则1 的"只追加"直接冲突，且成本由每一轮重复支付。
    // **不在这里发明新的窗口/阈值**：要压体积用既有机制——`agent.js` 的 `maybeCollapseEarly`
    //   （段边界**整段替换一次**，落 `prefix:collapse`、不计 C4）与工具结果 spill（§4.4.1 规则4）。
    // 如实记一条（与 C-59 同源，登记见 `proposals/架构文档冲突登记-20260915.md` 的 C-60）：这条路径
    //   **没有组装侧跨轮账**（不在 web/headless/渠道那三条入口里）—— 改完"只追加"是靠口径一致，
    //   不是靠机检看得见；要不要把它也接上那套账，是另一件事。
    const msgs = await db.query('SELECT role, content FROM messages WHERE conversation_id=? AND role IN ("user","assistant") ORDER BY id', [convId]);
    const goal = String(c.goal || '').slice(0, 3000);
    const accLines = (() => { try { return JSON.parse(c.acceptance || '[]'); } catch { return []; } })();
    msgs.push({
      role: 'system',
      content: [
        '【任务契约 · 你在无人值守模式下执行】',
        '目标：' + goal,
        (c.boundaries ? '边界/约束：' + String(c.boundaries).slice(0, 1000) : ''),
        (accLines.length ? '验收标准（完成前必须逐条满足）：\n' + accLines.map((x, i) => (i + 1) + '. ' + x).join('\n') : '验收标准：未配置，按目标合理自检。'),
        '执行规则：',
        '- 使用工具真实完成目标；完成后【必须调用 finish_task 工具】提交自检与总结；驱动器会用验收标准自动核验。',
        '- 只有真正需要用户拍板（选择/授权/需求冲突）才调用 ask_user——无人值守下会自动排队通知用户。',
        '- 一轮做不完可以继续多轮；每轮结束给一句进展，直到 finish_task 成功或遇到必须用户介入的事。',
      ].join('\n'),
    });
    // 无人值守上下文：ask/审批排队而非阻塞
    let accessRules = null;
    try { const ar = await db.query("SELECT svalue FROM settings WHERE skey='access_rules'"); if (ar[0]) { const v = JSON.parse(ar[0].svalue); if (Array.isArray(v)) accessRules = v; } } catch { accessRules = null; }
    const ctx = {
      permission: DRIVER_PERMISSION, accountId: c.account_id ?? null, conversationId: convId, root: RW_FS_ROOT,
      __autonomous: true, __accessRules: accessRules,
      __needInput: (payload) => needInput(c, payload, convId),
    };
    const result = await runAgent({ provider: c.provider || 'deepseek', model: c.model || 'deepseek-v4-flash', messages: msgs, permission: 'full', ctx, keys: config.keys });
    const finished = (result.toolLog || []).some((t) => t.name === 'finish_task');
    const toolNames = [...new Set((result.toolLog || []).map((t) => t.name))];
    const summary = String(result.content || '').slice(0, 3000);
    const refresh = (await db.query('SELECT * FROM task_contracts WHERE id=?', [c.id]))[0] || c;
    if (refresh.status === 'need_input') { // ask/审批已排队
      await appendConvMsg(convId, 'assistant', summary || '（等待用户答复后继续）');
      return;
    }
    const attempts = (refresh.attempts || 0) + 1;
    if (finished) {
      // Q3=A：跑验收钩子
      const acc = await runAcceptance(refresh);
      await addEvent(c.id, 'finish_task', '自检完成；验收' + (acc.pass ? '通过' : '未通过'), convId);
      if (acc.pass) {
        await appendConvMsg(convId, 'assistant', summary + (acc.results.length ? '\n\n[验收钩子全部通过 ✅]' : ''));
        await setStatus(refresh, 'candidate_done', { lastResult: summary, attempts });
        await addEvent(c.id, 'candidate_done', '等待用户复测确认', convId);
      } else {
        await appendConvMsg(convId, 'user', '【驱动器验收未通过】\n' + acc.results.filter((r) => !r.ok).map((r) => '- ' + r.check + ' → ' + r.detail).join('\n') + '\n请修复后重新调用 finish_task。');
        await setStatus(refresh, 'queued', { attempts });
        await addEvent(c.id, 'acceptance_fail', '打回修复', convId);
      }
    } else if ((result.toolLog || []).length === 0) {
      // 直接收尾且没干活 → 驱动器要求继续（进展型护栏；连续多次后请你裁决）
      if ((refresh.attempts || 0) >= MAX_IDLE_CONCLUDE) {
        await appendConvMsg(convId, 'assistant', summary);
        await db.query('UPDATE task_contracts SET last_ask=?, status="need_input", updated_at=NOW() WHERE id=?',
          [JSON.stringify({ kind: 'judge', question: '任务未完成但 Agent 已停止（连续多次未继续）。接受当前结果结束，还是让它继续？', options: [{ label: '接受并结束', value: 'accept' }, { label: '让它继续', value: 'continue' }] }), c.id]);
        await addEvent(c.id, 'need_input', '请用户裁决：接受当前结果或继续', convId);
      } else {
        await appendConvMsg(convId, 'user', '【驱动器】目标尚未验收完成且本轮未调用 finish_task。请继续执行直到完成并调用 finish_task（可先说明卡点）。');
        await setStatus(refresh, 'queued', { attempts });
      }
    } else {
      // 干了活但没收尾 → 继续
      await appendConvMsg(convId, 'user', '【驱动器】本轮执行了：' + (toolNames.join('、') || '工具') + '，但尚未调用 finish_task。请继续完成目标，完成后调用 finish_task。');
      await setStatus(refresh, 'queued', { attempts });
      await addEvent(c.id, 'continue', '已驱动下一轮', convId);
    }
    if (attempts >= MAX_AUTO_ROUNDS && refresh.status === 'queued') {
      await setStatus(refresh, 'blocked', { lastResult: '超过自动轮次上限(' + MAX_AUTO_ROUNDS + ')，已停止。' });
      await addEvent(c.id, 'blocked', '超过自动轮次上限', convId);
    }
  } catch (e) {
    // 会话还没建起来时（findOrCreateConv 自己失败）没有归属可写 ⇒ 这条事实落不了账（eventlog 明确返回
    // false，不是假装写了）；错误本身仍在下一行的 last_result 里留痕，不是静默丢。
    await addEvent(c.id, 'error', '驱动器执行异常: ' + e.message.slice(0, 300), convId);
    try { await setStatus(c, 'queued', { lastResult: '驱动器异常：' + e.message.slice(0, 300) }); } catch { /* ignore */ }
  } finally {
    running.delete(c.id);
  }
}

async function tick() {
  try {
    if (running.size >= 2) return;
    // 崩溃恢复：running 状态但心跳旧（>3min）→ 回到 queued
    await db.query("UPDATE task_contracts SET status='queued', updated_at=NOW() WHERE status='running' AND updated_at < DATE_SUB(NOW(), INTERVAL 3 MINUTE)");
    const due = await db.query('SELECT * FROM task_contracts WHERE status="queued" AND (run_at IS NULL OR run_at <= NOW()) ORDER BY id LIMIT 3');
    for (const c of due) {
      if (running.size >= 2) break;
      driveContract(c).catch((e) => console.error('[driver] 驱动失败:', e.message));
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch (e) { console.error('[driver] tick 异常:', e.message); }
}

export function startDriver() {
  setInterval(tick, 15000);
  tick();
  console.log('[driver] 任务契约驱动器已启动（15s 扫描，并发≤2，自动轮次≤' + MAX_AUTO_ROUNDS + '）');
}

// 供 API 使用
export async function driverTickNow() { return tick(); }
