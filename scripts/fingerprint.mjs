// scripts/fingerprint.mjs - RA-36 升级演练的"指纹"：一张表一眼看清库有没有变
// 用途：升级**前后**各跑一次，逐项比对。口径=行数 + 主键范围（不搬数据、不落盘）。
// 为什么指纹要包含"最老/最新 id"：只看行数会漏掉"删旧行+插新行"这种净变化为 0 的情况。
import { db } from '../server/db.js';

const TABLES = ['accounts', 'conversations', 'messages', 'usage_stats', 'tool_calls', 'audit_log', 'audit_log_archive',
  'knowledge', 'agent_runs', 'shells', 'settings', 'models', 'providers', 'model_telemetry', 'reviews'];

const out = {};
for (const t of TABLES) {
  try {
    const r = (await db.query(`SELECT COUNT(*) n, MIN(id) mn, MAX(id) mx FROM ${t}`))[0] || {};
    out[t] = { n: Number(r.n || 0), min: r.mn == null ? null : Number(r.mn), max: r.mx == null ? null : Number(r.mx) };
  } catch (e) { out[t] = { err: String(e.message || e).slice(0, 60) }; }
}
// 会话可读性：最老/最新会话各取一条标题（证明"老会话还能读出来"）
try {
  const c = await db.query('SELECT id, title FROM conversations ORDER BY id ASC LIMIT 1');
  const d = await db.query('SELECT id, title FROM conversations ORDER BY id DESC LIMIT 1');
  out.__oldestConv = c[0] ? { id: c[0].id, title: String(c[0].title || '').slice(0, 30) } : null;
  out.__newestConv = d[0] ? { id: d[0].id, title: String(d[0].title || '').slice(0, 30) } : null;
} catch { /* ignore */ }
try { out.__resultBytesCol = ((await db.query("SELECT COUNT(*) c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tool_calls' AND COLUMN_NAME='result_bytes'"))[0] || {}).c ? 'present' : 'absent'; } catch { out.__resultBytesCol = 'unknown'; }

console.log(JSON.stringify(out, null, process.argv.includes('--pretty') ? 2 : 0));
process.exit(0);
