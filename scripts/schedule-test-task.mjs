// scripts/schedule-test-task.mjs - 建一个"5 分钟后跑一次"的定时任务，用于产出改造后的**真实流量**样本
// 用途（RA-35）：`scripts/ra35-report.mjs` 的"新段真实流量"要有货才判得了；真实使用不可控，
//   所以用**平台自己的定时任务**造一个可控、可复现、会留下 usage_stats 的真实执行。
// 口径归属：这种 task 会话的标题是「定时任务：<name>」，落在"真实流量 / 定时任务"档（不是探针——
//   它走的就是生产调度路径）。但它确实是**测试**，所以报告里用 external_id 把它单独标出来（TEST_TASK_EXT）。
//
// 用法：
//   node scripts/schedule-test-task.mjs            # 建任务（默认 5 分钟后）
//   node scripts/schedule-test-task.mjs --in 5     # 指定多少分钟后
//   node scripts/schedule-test-task.mjs --disable  # 停用本脚本建的任务（可重复执行）
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const MIN = Number((argv.includes('--in') ? argv[argv.indexOf('--in') + 1] : 5)) || 5;
const DISABLE = argv.includes('--disable');
const NAME = 'RA35样本-真实调度路径';

// 这几条是本次要造样本用的提示：自包含、只用只读工具、步数可控（避免变成烧钱长任务）
const PROMPT = [
  '这是平台自检的**只读**采样任务（用于成本口径取样，不做任何改动、不写文件、不提交）。',
  '请按顺序做 5 步，每步用对应工具，最后给一段 3 行小结：',
  '1) run_command: `git -C /srv/harness-workbench log --oneline -5`',
  '2) db_query: `SELECT COUNT(*) n, ROUND(SUM(cost),4) cost FROM usage_stats WHERE created_at > NOW() - INTERVAL 7 DAY`',
  '3) list_dir: `/srv/harness-workbench/scripts`',
  '4) read_file: `/srv/harness-workbench/scripts/cohort.mjs`（只读前 60 行）',
  '5) db_query: `SELECT COUNT(*) c FROM conversations`',
  '做完就停，不要追加探索、不要读取其它文件。',
].join('\n');

if (DISABLE) {
  const r = await db.query('UPDATE scheduled_tasks SET enabled=0 WHERE name=?', [NAME]);
  console.log(`已停用「${NAME}」：${r.affectedRows} 行`);
  process.exit(0);
}

const acc = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
if (!acc) { console.error('库里没有账号'); process.exit(1); }

// 幂等：同名任务已存在则复用（只改 next_run 与 prompt），不重复建
const exist = (await db.query('SELECT id FROM scheduled_tasks WHERE name=?', [NAME]))[0];
const nextRun = new Date(Date.now() + MIN * 60 * 1000);
if (exist) {
  await db.query('UPDATE scheduled_tasks SET enabled=1, cron=?, prompt=?, next_run=?, provider="deepseek", model="deepseek-v4-flash", permission="read" WHERE id=?',
    ['*/5 * * * *', PROMPT, nextRun, exist.id]);
  console.log(`复用已存在任务 #${exist.id}，next_run 改为 ${nextRun.toISOString()}（库本地 ${new Date(nextRun.getTime() + 8 * 3600e3).toISOString().slice(0, 19)}）`);
} else {
  const r = await db.query(
    `INSERT INTO scheduled_tasks (account_id, name, cron, prompt, provider, model, permission, enabled, next_run)
     VALUES (?,?,?,?,?,?,?,1,?)`,
    [acc.id, NAME, '*/5 * * * *', PROMPT, 'deepseek', 'deepseek-v4-flash', 'read', nextRun]);
  console.log(`已创建任务 #${r.insertId}，next_run = ${nextRun.toISOString()}（库本地 ${new Date(nextRun.getTime() + 8 * 3600e3).toISOString().slice(0, 19)}）`);
}
console.log('注意：DB 里的 DATETIME 是**库本地时间（UTC+8）**，node 传来的 Date 会被 mysql2 按本地时区序列化，故上面的"库本地"就是真实落库值。');
console.log('调度器每分钟检查一次，到点后会自动执行；执行期间可在服务器 `journalctl -u rw-test -f | grep scheduler` 观察。');
process.exit(0);
