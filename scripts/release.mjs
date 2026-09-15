#!/usr/bin/env node
// scripts/release.mjs - 发布流水线雏形（2026-09 批5，P15）
// 用法: node scripts/release.mjs [--check-only]
// 流程：①语法全检 → ②前端构建 → ③受控部署说明（git push/服务器 pull/reload 走 C5）；真实冒烟（node scripts/selfcheck.mjs）需运行中服务器+账号，作为部署后人工/驱动步骤执行
// 只做只读+校验+构建；部署动作（reload）由人工/C5 决策，脚本不自动执行。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check-only');
const ok = [];
const fail = [];
const step = (name, cond, extra = '') => {
  // cond 必须是布尔：门禁的判定函数（如金标 goldenGatePass）一旦返回对象/undefined 这种"真值但非 true"，
  // `cond ? ok : fail` 会静默算通过 —— 那正是"门禁看着在、其实没拦"的形态，宁可当场报错。
  if (typeof cond !== 'boolean') throw new TypeError('门禁判定必须是布尔（' + name + ' 收到 ' + typeof cond + '）');
  (cond ? ok : fail).push(name);
  console.log((cond ? '✅' : '❌') + ' ' + name + (extra ? ' — ' + extra : ''));
};
const run = (bin, a, opts = {}) => {
  try { execFileSync(bin, a, { cwd: ROOT, stdio: 'ignore', ...opts }); return true; }
  catch { return false; }
};

console.log('=== RW 发布流水线（P15 雏形）===');
// 1. 工作区干净（发布基线）
try {
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  step('工作区干净（无未提交改动）', st.trim() === '', st.trim() ? '有 ' + st.trim().split('\n').length + ' 项未提交' : '');
} catch { step('git 状态可读', false); }

// 2. 语法全检（server + scripts）
const codeFiles = [];
const walk = (d) => {
  for (const it of fs.readdirSync(d, { withFileTypes: true })) {
    if (it.name === 'node_modules' || it.name === 'web' || it.name === 'proposals' || it.name === '.git') continue;
    const p = path.join(d, it.name);
    if (it.isDirectory()) walk(p);
    else if (/\.(js|mjs|cjs)$/.test(it.name) && !p.includes('web/dist')) codeFiles.push(p);
  }
};
walk(path.join(ROOT, 'server')); walk(path.join(ROOT, 'scripts'));
let syntaxFail = 0;
for (const f of codeFiles) { if (!run('node', ['--check', f])) { syntaxFail++; console.log('  ❌ syntax ' + path.relative(ROOT, f)); } }
step('语法全检（server+scripts ' + codeFiles.length + ' 文件）', syntaxFail === 0, syntaxFail ? syntaxFail + ' 失败' : '');

// 2.5 安全基线自检（P15b：密钥/危险面/安全网/绝对锁）
const secOk = (() => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts/security-check.mjs')], { cwd: ROOT, stdio: 'inherit' }); return true; }
  catch { return false; }
})();
step('安全基线自检（security-check.mjs）', secOk);

// 2.6 金标门禁（v0.3 §4.8「金标回归随引擎打包」/ §0.4 M3 准入前置「金标回归 + 失效监控必须在位」）
// 为什么在这里阻断：金标是**行为级**回归（壳的意图词表 + 工具面暴露），随包在 eval/ 里，跑一次零 LLM 成本；
// 判据就是 canary.js 的既有语义 `passed === total`（0/1，**不设通过线**——阈值属 §7.1 ㉔ 指标回归门禁，本轮不做）。
// 与 security-check / vite build 同级：不过就退出码 1，阻断发布。
// 为什么"读不到库"不阻断：库只在开发机/服务器上有，CI 与客户机没有；照本仓既有做法（下面的活跃会话检查）
// 如实报 skipped 并说明——**跳过不等于通过**，所以这里必须区分"判过了"与"没得判"。
const goldenReportPath = path.join(ROOT, 'tmp', 'golden-report.json');
const golden = await import('./golden-report.mjs');
const GOLDEN_STEP = '金标门禁（随包自检：passed===total）'; // 单一出处：夹具据此断言"门禁确实在阻断路径上"
let goldenReport = null;
try {
  goldenReport = await golden.runGoldenGate();
  // 判定归判定、写盘归写盘：写不进 tmp/（磁盘满/权限）不该把发布判成金标不通过
  try { golden.writeGoldenReport(goldenReport, goldenReportPath); console.log('   结果：' + path.relative(ROOT, goldenReportPath) + '（同一份格式给 CI 产物与离线对账用）'); }
  catch (e) { console.log('   （结果写盘失败，不影响门禁判定：' + String((e && e.message) || e).slice(0, 60) + '）'); }
  if (!golden.goldenGateJudged(goldenReport)) {
    const why = goldenReport.shells.map((s) => (s.shell ? s.shell + '：' : '') + (s.reason || '')).filter(Boolean).join('；');
    step(GOLDEN_STEP, true, 'skipped —— ' + (why || '没有可跑的壳'));
  } else {
    step(GOLDEN_STEP, golden.goldenGatePass(goldenReport), golden.goldenGateLine(goldenReport));
  }
  // 逐条失败明细直接打出来：判红时要能当场看到是哪一条断言的期望/实际不一致
  for (const s of (goldenReport.shells || [])) {
    for (const c of (s.cases || []).filter((x) => !x.pass)) console.log('   ❌ ' + s.shell + ' 第' + c.i + '条 ' + c.q + ' → 期望 ' + c.want + '，实际 ' + c.got);
  }
} catch (e) {
  step(GOLDEN_STEP, true, 'skipped —— 读不到库：' + String((e && e.message) || e).slice(0, 80));
}

// 2.7 指标回归门禁（v0.3 §7.1 ㉔ / §0.4 M3 准入前置「金标回归 + 失效监控（C4）必须在位」）
// 为什么要有这一步：金标门禁（2.6）只回答"行为有没有回退"，它**不回答**"自进化改动的准入前置在不在位"。
//   ㉔ 的准入前置要求两样：金标回归**在位** + 失效监控（C4）**在位**；"在位"＝机制真的读到了数，
//   跳过/读不到**不算在位**（否则就是 §0.4 说的"盲改"）。所以这一步单独判，且缺了就红。
// 判定只允许两种形态（《架构文档冲突登记-20260915》C-31 规则4：只报数不设线，不发明阈值）：
//   (a) 在位性判定：金标+C4 在位、每条提案附了前后指标对比（缺了就红）；
//   (b) 只报数不设线：指标变好/变差照实打出来（`scripts/metrics-gate.mjs`），**不阻断**。
// "变差多少算回归"这条线 v0.3 没给 ⇒ 本步不设线，需要线时单列给人拍板。
// 顺序说明：**先落盘本次报告、再取基线**，所以 release 这次得到的基线是"上一次的指针"（见 metrics-report.mjs
//   的 `readLatestPointer`）；要显式比某两份，用 `node scripts/metrics-gate.mjs --current <a> --baseline <b>`。
const METRICS_STEP = '指标回归门禁（㉔：金标+C4 在位；变差只报数不设线）'; // 单一出处：夹具据此断言"门禁在阻断路径上"
const PROPOSALS_PATH = path.join(ROOT, 'tmp', 'metrics', 'proposals.json');   // 本批入闸提案（可选；有才判"每条附前后对比"）
try {
  const reg = await import('../server/selfeval/regression-gate.js');
  const mrep = await import('./metrics-report.mjs');
  // **每次发布都产出一份新的指标报告**（㉔ 的交付物）：复用 2.6 刚跑过的金标结果，不再重跑第二遍；
  // 指标读数走 collect.js 的同一处口径。写盘与判定分开：写不进 tmp/ 不该把发布判成"指标不通过"。
  let current = null;
  try {
    const { report } = await mrep.collectReport({ days: 7, goldenReport });
    try {
      const w = mrep.writeMetricsSnapshot(report);
      console.log('   本次指标报告：' + w.rel + '（指针 tmp/metrics/latest.json）');
    } catch (e) { console.log('   （报告写盘失败，不影响门禁判定：' + String((e && e.message) || e).slice(0, 60) + '）'); }
    current = report;
  } catch (e) { current = null; }
  if (!current) {
    step(METRICS_STEP, true, 'skipped —— 本次没有指标报告（先跑 node scripts/metrics-report.mjs）：**未判**，不判定也不放行');
  } else {
    const base = await reg.resolveBaselinePath();
    // 指针在写盘时已被本次覆盖 ⇒ 报告里的 baselineRef 才是"改动前"那一份（写盘前读的）
    const basePath = current.baselineRef ? path.resolve(ROOT, String(current.baselineRef).split(/[\\/]/).join(path.sep)) : null;
    const baseline = (basePath && fs.existsSync(basePath)) ? await reg.loadMetricsReport(basePath) : null;
    let proposals = [];
    let propNote = '';
    try {
      const j = JSON.parse(fs.readFileSync(PROPOSALS_PATH, 'utf8'));
      proposals = Array.isArray(j) ? j : (Array.isArray(j.proposals) ? j.proposals : []);
      propNote = ' · 本批提案 ' + proposals.length + ' 条（' + path.relative(ROOT, PROPOSALS_PATH) + '）';
    } catch { propNote = ' · 本批没有提案清单（' + path.relative(ROOT, PROPOSALS_PATH) + ' 不存在）'; }
    const g = reg.evaluateGate({ current, baseline: (baseline && !baseline.__err) ? baseline : null, proposals });
    const gi = reg.goldenInPlace(current), ci = reg.c4InPlace(current);
    console.log('   指标：金标' + (gi.inPlace ? '在位' : '**不在位**') + ' · C4 监控' + (ci.inPlace ? '在位' : '**不在位**')
      + ' · 基线 ' + (baseline && !baseline.__err ? path.relative(ROOT, basePath) : '无（本次是第一份）') + propNote);
    if (Array.isArray(current.collectErrors) && current.collectErrors.length) console.log('   采集未取到 ' + current.collectErrors.length + ' 项（如实列在报告里，不静默）');
    // 只报数不设线：变差照实打出来，但**不进** ok/fail
    const diff = reg.diffMetrics((baseline && !baseline.__err) ? baseline : null, current);
    const degraded = diff.rows.filter((r) => r.state === 'degraded');
    if (degraded.length) console.log('   ⚠️ 变差（**只报数不设线**，不阻断；要不要处置需人判）：' + degraded.map((r) => r.path + ' ' + r.from + '→' + r.to).join('；'));
    // 硬条件缺位 ⇒ fail；窗口不可比或缺基线 ⇒ undecided；**未判也不放行**（"不知道"不许读成"没问题"）
    step(METRICS_STEP, !reg.gateBlocks(g), reg.gateLine(g));
  }
} catch (e) {
  step(METRICS_STEP, true, 'skipped —— 指标门禁跑不起来：' + String((e && e.message) || e).slice(0, 80));
}

// 3. 前端构建（vite build）
// 跨平台：直接 node 调 vite 的 js 入口（.cmd 在 Windows execFileSync 会 EINVAL）
const buildOk = (() => {
  try { execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'ignore' }); return true; }
  catch { return false; }
})();
step('前端构建（vite build）', buildOk);

// 4. 部署前检查：服务器活跃会话（只读提示，不自动 reload）
step('部署走 C5 受控（git push → 服务器 pull → 人工/受控 reload）', true, '本脚本不自动部署');

// 4.5 换纪元的代价，在**决策点**说出来（2026-09-16，C-31 实测驱动）
// 为什么放这里：实测 214 次"整段重建"集中在一条 432 轮的会话上（量级 ≈14M tokens），成因就是**在它活跃期间反复部署**。
// 判据不发明阈值：`agent_runs.status='running'` 就是"活跃"的权威定义（不设时间窗口）；读不到库就如实说跳过，不阻断发布。
try {
  const { db, pool } = await import('../server/db.js');
  const rows = await db.query("SELECT conversation_id cid, goal, rounds, updated_at FROM agent_runs WHERE status='running' ORDER BY updated_at DESC LIMIT 20");
  if (rows.length) {
    console.log('\n⚠️ 当前有 ' + rows.length + ' 个会话在跑 —— 本次发布若改了工具面/系统提示，会换纪元，**它们的前缀会整段重建**：');
    for (const r of rows) console.log('   conv=' + r.cid + ' 轮次=' + (r.rounds || 0) + ' 最后活动=' + String(r.updated_at).slice(5, 16) + ' ' + String(r.goal || '').replace(/\s+/g, ' ').slice(0, 40));
    console.log('   建议：把同类工具面改动攒成一批再发；或等这些会话结束。');
  } else {
    console.log('\n✓ 当前没有 running 的会话 —— 此时换纪元不会作废任何活跃前缀（发布的好时机）。');
  }
  await pool.end();
} catch (e) {
  console.log('\n（跳过活跃会话检查：读不到库 —— ' + String((e && e.message) || e).slice(0, 80) + '）');
}

console.log('\n=== 结果: ' + ok.length + ' 通过 / ' + fail.length + ' 失败 ===');
if (fail.length) {
  console.log('失败项：' + fail.join(', '));
  process.exit(1);
}
if (!CHECK_ONLY) {
  console.log('\n发布检查通过。若需部署到服务器：');
  console.log('  1) git push origin main');
  console.log('  2) 服务器: cd /srv/harness-workbench && git pull origin main --no-rebase');
  console.log('  3) node --check 关键文件 + node scripts/selfcheck.mjs（真实冒烟）');
  console.log('  4) 确认无活跃会话后受控 reload（C5）');
}
