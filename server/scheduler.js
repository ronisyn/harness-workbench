// server/scheduler.js - 定时任务（F14/C12）
// cron 简化格式："分 时 日 月 周"（* 通配，如每日 2:30 = "30 2 * * *"）
// 调度器每分钟检查一次到期任务 → 创建/复用会话执行 runAgent → 记录结果
import { db } from './db.js';
import { runAgent } from './agent.js';
import { config } from './config.js';

export function cronToNext(cron, from = new Date()) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  const m = (v, lo, hi) => (v === '*' ? null : Number(v));
  const mm = m(min, 0, 59); const hh = m(hour, 0, 23); const dd = m(dom, 1, 31); const mo = m(mon, 1, 12);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    const d = new Date(from.getTime() + i * 60000);
    if (mm !== null && d.getMinutes() !== mm) continue;
    if (hh !== null && d.getHours() !== hh) continue;
    if (dd !== null && d.getDate() !== dd) continue;
    if (mo !== null && d.getMonth() + 1 !== mo) continue;
    if (dow !== '*') { const wd = Number(dow); const dw = (d.getDay() + 6) % 7; if (dw !== wd) continue; }
    return d;
  }
  return null;
}

export function isCronDue(task, now = new Date()) {
  if (!task.next_run) return false;
  return new Date(task.next_run) <= now;
}

export async function computeNextRuns() {
  const tasks = await db.query('SELECT id, cron FROM scheduled_tasks WHERE enabled=1 AND next_run IS NULL');
  for (const t of tasks) {
    const next = cronToNext(t.cron);
    if (next) await db.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [next, t.id]);
  }
}

// 执行一个定时任务
export async function executeScheduledTask(task) {
  console.log(`[scheduler] 执行定时任务 ${task.id}: ${task.name}`);
  const t0 = Date.now();
  let resultText = '';
  try {
    const acc = await db.query('SELECT id FROM accounts WHERE id=?', [task.account_id]);
    if (!acc.length) { resultText = '账号不存在'; }
    else {
      // 创建/复用该任务的专用会话（channel=task）
      let conv = (await db.query('SELECT id FROM conversations WHERE channel="task" AND external_id=?', ['task-' + task.id]))[0];
      if (!conv) {
        const r = await db.query('INSERT INTO conversations (account_id, channel, external_id, permission, title) VALUES (?,"task",?,?,?)', [task.account_id, 'task-' + task.id, task.permission || 'full', '定时任务：' + task.name]);
        conv = { id: r.insertId };
      }
      const ctx = { permission: task.permission || 'full', accountId: task.account_id, conversationId: conv.id, root: task.permission === 'full' ? '/' : (process.env.RW_WORKSPACE || '/srv/rw-workspace') };
      const result = await runAgent({ provider: task.provider, model: task.model, messages: [{ role: 'user', content: task.prompt }], permission: task.permission || 'full', ctx, keys: config.keys, maxRounds: 20 });
      resultText = (result.content || '').slice(0, 5000);
      // 写入会话消息（可回看）
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'user', '【定时任务】' + task.name + '\n' + task.prompt]);
      await db.query('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)', [conv.id, 'assistant', resultText]);
    }
  } catch (e) {
    resultText = '执行失败: ' + e.message;
  }
  const next = cronToNext(task.cron);
  await db.query('UPDATE scheduled_tasks SET last_run=NOW(), last_result=?, next_run=?, enabled=enabled WHERE id=?',
    [resultText.slice(0, 3000), next, task.id]);
  console.log(`[scheduler] 任务 ${task.id} 完成（${Date.now() - t0}ms）`);
  return resultText;
}

// 主调度循环：每分钟检查
export function startScheduler() {
  setInterval(async () => {
    try {
      await computeNextRuns();
      const due = await db.query('SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run IS NOT NULL AND next_run <= NOW()');
      for (const t of due) {
        // 防重入：先把 next_run 推后，避免并发重复执行
        const next = cronToNext(t.cron) || new Date(Date.now() + 60000);
        await db.query('UPDATE scheduled_tasks SET next_run=? WHERE id=?', [next, t.id]);
        executeScheduledTask(t).catch((e) => console.error('[scheduler] 执行异常:', e.message));
      }
    } catch (e) { /* 调度循环容错 */ }
  }, 60000);
  console.log('[scheduler] 定时任务调度器已启动（每分钟检查）');
}
