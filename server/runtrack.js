// server/runtrack.js - 长任务现场持久化（断点恢复外壳）
// 每个会话一条 agent_runs：running → completed | interrupted | paused
// 服务启动时把遗留 running 标为 interrupted（重启自检）；下次用户消息注入"上次任务现场"提醒，
// 模型基于持久化历史 + 现场信息从断点继续；循环检测不再杀任务而是 soft 提示→仍无效则 paused 挂起
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { db } from './db.js';

// P16 唤醒包（2026-09 批1）：恢复任务时注入工作区 git 状态摘要——模型知道"改到哪、脏区在哪、HEAD 在哪"，
// 避免恢复后盲目重读/重做或误判现场。工作区非 git 仓库/不可读时静默返回空（不阻塞恢复）。
function gitStateSummary() {
  const ws = process.env.RW_WORKSPACE || '/srv/rw-workspace';
  try {
    if (!fs.existsSync(ws)) return '';
    const run = (args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = run(['rev-parse', '--short', 'HEAD']);
    const status = run(['status', '--short']);
    const lines = status.split('\n').filter(Boolean).slice(0, 15); // 脏区最多列 15 行，防摘要过长
    const parts = ['工作区 git 状态（' + ws + '）：HEAD=' + head];
    if (lines.length) parts.push('未提交改动 ' + lines.length + ' 项：\n' + lines.map((l) => '  ' + l.slice(0, 100)).join('\n'));
    else parts.push('工作区干净（无未提交改动）');
    return parts.join('\n');
  } catch { return ''; } // 非 git 仓库 / git 不可用 / 超时 → 静默跳过
}

export async function latestRun(conversationId) {
  const rows = await db.query('SELECT * FROM agent_runs WHERE conversation_id=? ORDER BY id DESC LIMIT 1', [conversationId]);
  return rows[0] || null;
}

export async function ensureRun({ conversationId, accountId, goal }) {
  const cur = await latestRun(conversationId);
  if (cur && cur.status === 'running') return cur;
  if (cur && (cur.status === 'interrupted' || cur.status === 'paused')) {
    // 复用现场：恢复为 running（新一轮推进；"继续/接着/恢复"等短指令不覆盖原目标）
    const g = String(goal || '');
    const resumePhrase = g.length <= 40 && /继续|接着|恢复|resume|继续任务/i.test(g);
    const keep = resumePhrase && cur.goal ? cur.goal : (g || cur.goal || '');
    await db.query('UPDATE agent_runs SET status="running", goal=?, reason=NULL, heartbeat_at=NOW(), updated_at=NOW() WHERE id=?',
      [String(keep).slice(0, 2000), cur.id]);
    return { ...cur, status: 'running' };
  }
  const r = await db.query('INSERT INTO agent_runs (conversation_id, account_id, goal, status) VALUES (?,?,?,"running")',
    [conversationId, accountId, String(goal || '').slice(0, 2000)]);
  return { id: r.insertId, conversation_id: conversationId, status: 'running' };
}

// 心跳+现场（每轮调用一次，轻量单行 UPDATE）
export async function checkpoint(runId, { rounds, lastStep, toolCounts }) {
  await db.query('UPDATE agent_runs SET rounds=?, last_step=?, tool_counts=?, heartbeat_at=NOW(), updated_at=NOW() WHERE id=?',
    [rounds || 0, String(lastStep || '').slice(0, 500), JSON.stringify(toolCounts || {}), runId]);
}

export async function markRun(runId, status, reason) {
  await db.query('UPDATE agent_runs SET status=?, reason=?, updated_at=NOW() WHERE id=?', [status, String(reason || '').slice(0, 300), runId]);
}

// 重启自检：服务启动时所有 running 的现场（属于被杀进程）→ interrupted
export async function interruptStaleOnBoot() {
  await db.query("UPDATE agent_runs SET status='interrupted', reason='服务重启，任务中断（现场已保存）', updated_at=NOW() WHERE status='running'");
  const n = await db.query('SELECT COUNT(*) c FROM agent_runs WHERE status="interrupted"');
  if (n[0]?.c) console.log('[runtrack] 重启自检：' + n[0].c + ' 个任务现场标记为 interrupted（可恢复）');
}

// 会话有可恢复现场时生成提醒（注入下一轮；P16 唤醒包含工作区 git 状态摘要）
export async function resumeHint(conversationId) {
  const r = await latestRun(conversationId);
  if (!r || !['interrupted', 'paused'].includes(r.status)) return null;
  const counts = (() => { try { return JSON.parse(r.tool_counts || '{}'); } catch { return {}; } })();
  const cText = Object.entries(counts).map(([k, v]) => k + '×' + v).join('、');
  const git = gitStateSummary();
  return '【上次任务现场】目标：' + String(r.goal || '').slice(0, 300)
    + '\n状态：' + r.status + (r.reason ? '（' + r.reason + '）' : '')
    + '；已执行 ' + (r.rounds || 0) + ' 轮工具调用' + (cText ? '：' + cText : '')
    + (r.last_step ? '\n最后步骤：' + String(r.last_step).slice(0, 300) : '')
    + (git ? '\n' + git : '')
    + '\n若用户要"继续任务"，基于以上现场/历史/git 状态从断点接着推进（先看未完成步骤与工作区现状再动手）；若是新指令则执行新指令。';
}
