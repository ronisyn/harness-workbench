// scripts/run-ra35-sample.mjs - 一条命令完成：建/改样本任务 → 到点自动执行 → 等完成 → 打印证据
// 背景：RA-35 的"新段真实流量"要有货才判得了；真实使用不可控，所以用**平台自己的调度路径**造可控样本。
// 上一轮踩的两个坑（本脚本已修正，留痕）：
//   ① permission=read 却在提示里让模型跑 run_command → run_command 需 full 权限，任务半失败；
//      read 权限还会把 list_dir/read_file 限定在工作区内。样本任务本质是自检采样，用 full（与 #3/#4 一致），
//      但提示里**明确禁止任何写操作/提交**。
//   ② 服务器上这份代码可能落后于本地 → 任务定义（含 prompt）必须由**同一条部署**写入，
//      否则会出现"代码是新的、任务是旧的"这种最难查的错配。本脚本先打印服务器 HEAD 供核对。
//
// 用法：
//   node scripts/run-ra35-sample.mjs            # 建/改任务并等到跑完（默认 3 分钟后触发）
//   node scripts/run-ra35-sample.mjs --in 3
//   node scripts/run-ra35-sample.mjs --in 3 --wait 600   # 等待上限（秒）
import { db } from '../server/db.js';

const argv = process.argv.slice(2);
const IN_MIN = Number(argv.includes('--in') ? argv[argv.indexOf('--in') + 1] : 3) || 3;
const WAIT_S = Number(argv.includes('--wait') ? argv[argv.indexOf('--wait') + 1] : 600) || 600;
const NAME = 'RA35样本-真实调度路径';

const PROMPT = [
  '这是平台自检的**只读**采样任务：用于成本口径取样。',
  '硬约束：**不得**写文件、不得改代码、不得 git commit/push、不得改数据库（只允许 SELECT）。做完就停，不要追加探索。',
  '请按顺序做 5 步，最后给 3 行小结：',
  '1) run_command: `git -C /srv/harness-workbench log --oneline -5`',
  '2) db_query: `SELECT COUNT(*) n, ROUND(SUM(cost),4) cost FROM usage_stats WHERE created_at > NOW() - INTERVAL 7 DAY`',
  '3) list_dir: `/srv/harness-workbench/scripts`',
  '4) read_file: `/srv/harness-workbench/scripts/cohort.mjs`（只读前 60 行）',
  '5) db_query: `SELECT COUNT(*) c FROM conversations`',
].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('en-US'));

const acc = (await db.query('SELECT id FROM accounts ORDER BY id LIMIT 1'))[0];
if (!acc) { console.error('库里没有账号'); process.exit(1); }
const exist = (await db.query('SELECT id FROM scheduled_tasks WHERE name=?', [NAME]))[0];
const nextRun = new Date(Date.now() + IN_MIN * 60 * 1000);
if (exist) {
  await db.query('UPDATE scheduled_tasks SET enabled=1, cron=?, prompt=?, next_run=?, provider="deepseek", model="deepseek-v4-flash", permission="full" WHERE id=?',
    ['*/5 * * * *', PROMPT, nextRun, exist.id]);
  console.log(`复用任务 #${exist.id}，permission=full，next_run=${nextRun.toISOString()}`);
} else {
  const r = await db.query(
    `INSERT INTO scheduled_tasks (account_id, name, cron, prompt, provider, model, permission, enabled, next_run)
     VALUES (?,?,?,?,?,?,?,1,?)`,
    [acc.id, NAME, '*/5 * * * *', PROMPT, 'deepseek', 'deepseek-v4-flash', 'full', nextRun]);
  console.log(`已创建任务 #${r.insertId}，permission=full，next_run=${nextRun.toISOString()}`);
}
const TASK_ID = exist ? exist.id : (await db.query('SELECT id FROM scheduled_tasks WHERE name=?', [NAME]))[0].id;
const histBefore = Number((await db.query('SELECT COUNT(*) n FROM task_history WHERE task_id=?', [TASK_ID]))[0].n);

console.log(`等待执行（最多 ${WAIT_S}s）… 期间调度器每 60s 扫一次，到点自动跑。`);
const t0 = Date.now();
let finished = false;
while ((Date.now() - t0) / 1000 < WAIT_S) {
  const h = Number((await db.query('SELECT COUNT(*) n FROM task_history WHERE task_id=? AND finished_at IS NOT NULL', [TASK_ID]))[0].n);
  if (h > histBefore) { finished = true; break; }
  await sleep(15000);
}

const hist = await db.query('SELECT id, started_at, finished_at, ok, LEFT(note,120) note FROM task_history WHERE task_id=? ORDER BY id', [TASK_ID]);
const newHist = hist.slice(histBefore);
console.log(`\n本次新增执行记录：${newHist.length} 条 ${newHist.length === 1 ? '（✅ 单跑）' : '（⚠️ 多跑，防双跑未生效）'}`);
for (const h of newHist) console.log('  ' + JSON.stringify(h));
console.log(`累计执行次数 = ${hist.length}；finished=${finished}`);

const conv = (await db.query('SELECT id, title FROM conversations WHERE external_id=?', ['task-' + TASK_ID]))[0];
if (!conv) { console.log('（没有对应会话）'); process.exit(finished ? 0 : 1); }
const agg = (await db.query(`SELECT COUNT(*) rounds, SUM(cache_hit_tokens) hit, SUM(cache_miss_tokens) miss, ROUND(SUM(cost),4) cost
                             FROM usage_stats WHERE conversation_id=? AND kind='round'`, [conv.id]))[0];
const c1 = (Number(agg.hit) + Number(agg.miss)) > 0 ? Number(agg.hit) / (Number(agg.hit) + Number(agg.miss)) : null;
console.log(`\n会话 conv=${conv.id} 轮 ${agg.rounds} · C1 ${c1 == null ? '-' : (c1 * 100).toFixed(2) + '%'} · 命中 ${fmt(agg.hit)} / 未命中 ${fmt(agg.miss)} · ¥${agg.cost}`);
console.log('逐轮：');
for (const r of await db.query(`SELECT cache_hit_tokens hit, cache_miss_tokens miss, tokens_in, cost FROM usage_stats
                                WHERE conversation_id=? AND kind='round' ORDER BY id`, [conv.id])) {
  console.log(`  命中 ${String(r.hit).padStart(7)} / 未命中 ${String(r.miss).padStart(7)} / 输入 ${String(r.tokens_in).padStart(7)}  ¥${r.cost}`);
}
console.log('工具：');
for (const r of await db.query('SELECT tool_name, status, duration_ms FROM tool_calls WHERE conversation_id=? ORDER BY id', [conv.id])) {
  console.log(`  ${r.tool_name} ${r.status} ${r.duration_ms}ms`);
}
process.exit(finished ? 0 : 1);
