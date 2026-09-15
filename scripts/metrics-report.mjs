#!/usr/bin/env node
// scripts/metrics-report.mjs —— ㉔「指标回归门禁」的**产出那一半**：每次发布都产出一份结构化指标报告
//
// ── 为什么要有它（v0.3 §0.4 / §7.1 ㉔，见《v0.3-符合性核对-20260916》与㉒㉓ 代理列的接口点①②⑤）──
//   §0.4 M3 出口标准要求「**每条附前后指标对比**」，准入前置要求「**金标回归 + 失效监控（C4）必须在位**」。
//   要"前后对比"，先得有"前"：原先只有 `selfeval-collect.mjs --out tmp/snap.json` 这种**临时文件**，
//   第二次采集就把第一次覆盖掉 ⇒ 永远没有"改动前"。所以本脚本把每次采集写成**不可变**的一份：
//     tmp/metrics/<batchId>/<codeId>/snapshot.json    （batchId=哪个窗口，codeId=哪一版代码）
//     tmp/metrics/latest.json                         （指针：最新一份在哪，供门禁/CI 定位）
//   落 tmp/ 的理由：`.gitignore` 已有 `tmp/`，门禁写盘不许把工作区搞脏（release.mjs 第 1 步就查工作区干净）。
//
// ── 口径（照既有脚本，一条都不新造）──────────────────────────────────────────────────────
//   ① 读数**全部复用** `server/selfeval/collect.js` 的 `collectSnapshot`（与 `selfeval-collect.mjs`
//      同一处口径；分档、失败率、C4 机检口径都不复制）。
//   ② 报告头照 `scripts/golden-report.mjs` 的形状约定：`format/formatVersion/at` + 数据。
//   ③ **读不到库不阻断**（与 golden-report / release 的活跃会话检查同款）：如实记 skipped 与原因 ——
//      **跳过不等于通过**；金标那一步读不到就写 `{ skipped: true, reason }`，绝不写 passed:0 冒充成绩。
//   ④ 金标码**复用** `scripts/golden-report.mjs`（同一实现、同一 `eval/` 文件），不另立一套。
//
// 用法：
//   node scripts/metrics-report.mjs                         # 近 7 天：读库 + 跑金标，写不可变快照 + 指针
//   node scripts/metrics-report.mjs --days 30 --quiet        # release.mjs 用（只打一行结论）
//   node scripts/metrics-report.mjs --no-db                  # 不读库（只跑金标）：没有 MySQL 的机器/CI
//   node scripts/metrics-report.mjs --no-golden              # 不跑金标（只读库）
//   node scripts/metrics-report.mjs --out tmp/x.json         # 另存一份（导出到仓库外做留档）
// 退出码：0=采集完成；3=库读不到（**没判定**，不是通过）；2=用法/环境错误（如 git 锚都取不到仍要继续时用 --allow-nogit）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../server/config.js';
import { pool } from '../server/db.js';
import { collectSnapshot } from '../server/selfeval/collect.js';
import {
  buildMetricsReport, snapshotRef, normalizeCodeId, goldenInPlace, c4InPlace,
} from '../server/selfeval/regression-gate.js';

// 报告头（形状照 golden-report.mjs；`format` 是机器认的那一个，`kind` 沿用 collect.js 的批次口径）
export const METRICS_REPORT_FORMAT = 'rw-metrics-report';
export const METRICS_REPORT_VERSION = 1;
/** 不可变快照根目录（相对 ROOT） */
export const METRICS_ROOT = 'tmp/metrics';

/**
 * 代码版本锚（㉒㉓ 代理接口点②）：git sha + 工作区是否脏。
 * 读不到 git（客户机没装/git 不在 PATH/不是仓库）就如实记 error，**不编一个假版本**。
 * @returns {{commit:string|null, dirty:boolean, at:string, error?:string}}
 */
export function detectCodeAnchor({ cwd = ROOT, now = new Date() } = {}) {
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const opts = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 };
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
    let dirty = false;
    try { dirty = execFileSync('git', ['status', '--porcelain'], opts).trim() !== ''; } catch { dirty = true; }
    return { commit, dirty, at };
  } catch (e) {
    return { commit: null, dirty: false, at, error: String((e && e.message) || e).slice(0, 160) };
  }
}

/**
 * 金标档（㉒㉓ 代理接口点⑤：要有**身份**，不能只有 `code=9/9`）。
 * 判"在位"复用 `regression-gate.js` 的 `goldenInPlace`（skipped/跑不起来都不算在位）。
 * @param {object} report `scripts/golden-report.mjs` 的 runGoldenGate 结果；读不到时给 null
 * @param {string} reason 读不到/没跑的原因（**必须**写清，报告里不许出现"无缘无故的 skipped"）
 */
export function buildGoldenSection(report, reason = null) {
  if (!report || !Array.isArray(report.shells)) {
    return { skipped: true, reason: reason || '本次没有金标读数（未跑 / 结果文件不存在）', shells: [], identity: null, identityOf: 'none', total: null, passed: null };
  }
  const items = ([] ).filter((g) => g && g.exists && g.sha1_12);
  // 兼容没有 goldenSets 字段的金标报告（例如夹具里手写的替身）：从逐壳的 identity 合成同一形状。
  // **不是**第二套口径：两块数据都来自 golden-report.mjs 的 `goldenIdentityOf`，这里只是换个摆法。
  if (!items.length) {
    const seen = new Set();
    for (const s of (report.shells || [])) {
      const id = s && s.identity;
      if (!id || !id.exists || !id.sha1_12 || seen.has(id.ref)) continue;
      seen.add(id.ref);
      items.push(id);
    }
  }
  // 身份口径：**一份**报告可能挂多个金标集（多壳），把 (ref,sha1,count) 规范化后合成一个 id。
  // 为什么合成：门禁比的是"前后是不是同一套"，多个集合时逐个比会把问题拆散；合成后任一集合变即整体变。
  const identityOf = items.length ? 'goldenSets' : 'none';
  const identity = items.length
    ? crypto.createHash('sha1').update(JSON.stringify(items.map((g) => [g.ref, g.sha1_12, g.count]).sort())).digest('hex').slice(0, 12)
    : null;
  const shells = report.shells || [];
  const judged = shells.filter((s) => s && !s.skipped);
  return {
    skipped: shells.length === 0,
    reason: shells.length === 0 ? (reason || '没有可跑的金标壳') : null,
    at: report.at || null,
    goldenSets: items,
    identity, identityOf,
    // 集合大小（**不是成绩**）：total 会随金标集扩充而变，门禁据此区分"集合变了"与"行为变了"
    total: judged.length ? judged.reduce((n, s) => n + (s.total || 0), 0) : null,
    passed: judged.length ? judged.reduce((n, s) => n + (s.passed || 0), 0) : null,
    shellsJudged: judged.length,
    shells,
  };
}

/**
 * 组装完整报告（纯函数，夹具直测）：`collectSnapshot` 的快照 + 金标档 + 代码锚 + 可寻址引用。
 * 返回的 `full` 是**不含自身 hash** 的报告体；`hash` 是它的 sha1_12 —— 前后对比时核对"比的是不是同一份"。
 */
export function composeReport(snapshot, goldenSection, code) {
  const report = buildMetricsReport({ ...(snapshot || {}), golden: goldenSection, code: (code ?? (snapshot && snapshot.code) ?? null) });
  report.format = METRICS_REPORT_FORMAT;
  report.formatVersion = METRICS_REPORT_VERSION;
  const canon = JSON.stringify({ ...report, ref: { ...report.ref, hash: null } });
  const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12);
  report.ref = { ...report.ref, hash };
  return report;
}

/** 读当前指针（**不改**）：门禁要用它当"改动前"的那一份 */
export function readLatestPointer({ root = ROOT } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, METRICS_ROOT, 'latest.json'), 'utf8'));
    return (j && j.path) ? { path: j.path, hash: j.hash || null, batchId: j.batchId || null, codeId: j.codeId || null } : null;
  } catch { return null; }
}

/** 不可变落盘：写 `<dir>/snapshot.json`，**已存在就追加时间戳后缀**（绝不覆盖上次的读数） */
export function writeMetricsSnapshot(report, { root = ROOT } = {}) {
  const batch = report.batchId || 'unknown';
  const code = normalizeCodeId(report.code);
  let dir = path.join(root, METRICS_ROOT, batch, code);
  let file = path.join(dir, 'snapshot.json');
  if (fs.existsSync(file)) {
    const stamp = String(report.at || new Date().toISOString()).replace(/[:.]/g, '').replace(/-/g, '').replace('T', '-').replace('Z', '');
    file = path.join(dir, 'snapshot-' + stamp + '.json');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  // 指针：最新一份（门禁默认拿它当"改动后"；"改动前"由 --baseline 显式给，或上一次的指针）
  const ptr = path.join(root, METRICS_ROOT, 'latest.json');
  fs.mkdirSync(path.dirname(ptr), { recursive: true });
  const rel = path.relative(root, file).replace(/\\/g, '/');
  fs.writeFileSync(ptr, JSON.stringify({
    path: rel, url: 'file:///' + path.resolve(file).replace(/\\/g, '/'),
    batchId: batch, codeId: code, commit: (report.code && report.code.commit) || null,
    dirty: Boolean(report.code && report.code.dirty), at: report.at, hash: report.ref ? report.ref.hash : null,
  }, null, 2) + '\n', 'utf8');
  return { file, rel, ptr };
}

/** 人读摘要（每行一件事；缺数就说缺数，不粉饰） */
export function formatReport(report) {
  const L = [];
  const m = report.metrics || {};
  const c = ((m.c1c2 || {}).cohorts) || {};
  const real = c.real || {};
  const pct = (x) => (x == null ? '  -  ' : (x * 100).toFixed(2) + '%');
  const num = (x) => (x == null ? '-' : Number(x).toLocaleString('en-US'));
  L.push(`=== 指标报告 ${report.batchId}（近 ${(report.window || {}).days} 天，库本地时间）· 代码 ${normalizeCodeId(report.code)}${report.code && report.code.dirty ? '(脏工作区)' : ''} ===`);
  L.push(`C1 真实流量命中率 ${pct(real.c1)} · C2 中位 ${num(real.c2Median)} / P95 ${num(real.c2P95)} · 轮次 ${num(real.rounds)}${(real.rounds || 0) >= 30 ? '' : ' ⚠ 轮次<30：不可判'}`);
  L.push(`C3 每 run ${(m.c3 || {}).perRun == null ? '-' : '¥' + Number(m.c3.perRun).toFixed(4)} · 累计 ¥${Number(((m.c3 || {}).total) || 0).toFixed(4)}`);
  L.push(`C4 非预期失效 ${num((m.c4c5 || {}).c4Invalidate)} 次（台账${(m.c4c5 || {}).available === true ? '已读到' : '**没读到**'}）· C5 豁免 ${num((m.c4c5 || {}).c5Exempt)} / collapse ${num((m.c4c5 || {}).c5Collapse)}`);
  L.push(`失败率 ${(m.failures || {}).failRate == null ? '无分母（不算 0%）' : (m.failures.failRate * 100).toFixed(1) + '%'}（${num((m.failures || {}).fails)}/${num((m.failures || {}).calls)}）`);
  const g = report.golden || {};
  L.push('金标：' + (g.total == null ? '未判定（' + (g.reason || '没有可跑的壳') + '）'
    : g.passed + '/' + g.total + '（' + g.shellsJudged + ' 个壳真判过，身份 ' + (g.identity || '无') + '）'));
  L.push(`库：${report.databaseAvailable === false ? '**读不到**（连接级错误）' : (report.databaseAvailable === true ? '已读到' : '**本次没读**（--no-db）')}` + (report.collectErrors && report.collectErrors.length ? ` · 采集未取到 ${report.collectErrors.length} 项` : ''));
  L.push('（**只报数不设线**：v0.3 未给"变差多少算回归"的线，判定见 scripts/metrics-gate.mjs —— 只在位性判定）');
  return L.join('\n');
}

/** 池子是懒连接的：先探再关（照 selfeval-collect.mjs，不重复造） */
async function closePool() {
  try { if (typeof pool._idleTimeout === 'number') await pool.close(); else await pool.end(); } catch { /* 关不掉不影响结论 */ }
}

/**
 * 采集并**只组装**一份报告（不写盘）——release.mjs 第 2.7 步用它（那里已经跑过金标，不该重跑第二遍）。
 * 写盘由调用方决定（CLI 用 `writeMetricsSnapshot`，release 先在内存里判）。
 * @param {{days?:number, cutoff?:string, at?:Date, noDb?:boolean, noGolden?:boolean, goldenReport?:object}} opts
 * @returns {Promise<{report:object, snapshot:object, golden:object|null, goldenReason:string|null, minutes:object}>}
 */
export async function collectReport(opts = {}) {
  const DAYS = Math.max(1, Number(opts.days) || 7);
  const CUTOFF = opts.cutoff ?? null;
  const at = (opts.at instanceof Date) ? opts.at : new Date();
  const code = opts.code || detectCodeAnchor({ now: at });
  /** `--no-db` 用的空壳（**不假装读过库**：databaseAvailable=null 表示"本次没读"） */
  const blankSnapshot = () => ({
    schema: 1, kind: 'rw-selfeval-snapshot',
    batchId: 'selfeval-' + at.toISOString().slice(0, 10) + '-' + DAYS + 'd',
    generatedAt: at.toISOString(), at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    code, window: { days: DAYS, cutoff: CUTOFF, unit: '库本地时间(UTC+8)' },
    databaseAvailable: null, metrics: {}, benchmarkSources: [],
    collectErrors: ['--no-db：本次按要求**没有读库**（跳过不等于通过）'],
  });
  // ① 读数：复用 collect.js 的同一处口径（真读不到库时它自己会如实记 no-data + collectErrors）
  let snapshot;
  if (opts.noDb) {
    snapshot = blankSnapshot();
  } else {
    try {
      snapshot = await collectSnapshot({ days: DAYS, cutoff: CUTOFF, at, code });
    } catch (e) {
      // 连 collectSnapshot 本身都抛了（连池子都建不起来）：也要产出报告，否则"这次没读数"没有痕迹
      snapshot = blankSnapshot();
      snapshot.databaseAvailable = false;
      snapshot.collectErrors = ['连库都没建起来：' + String((e && e.message) || e).slice(0, 160)];
    }
  }
  // ② 金标码：复用 golden-report.mjs（同一实现、同一 eval/ 文件）；能复用调用方给的那份就不重跑
  let golden = opts.goldenReport || null;
  let goldenReason = null;
  if (opts.noGolden) {
    goldenReason = '--no-golden：本次按要求不跑金标（**跳过不等于通过**）';
  } else if (opts.noDb) {
    goldenReason = '--no-db：金标要读壳表，本次跳过（**跳过不等于通过**）';
  } else if (golden) {
    goldenReason = null;
    // 复用调用方给的金标结果时补上**金标集身份**（`runGoldenGate` 直接调用方没有 `goldenSets`）：
    // 身份是门禁区分"集合变了 vs 行为变了"的唯一依据，缺了它这一整块就退化成"只有 9/9"。
    if (!Array.isArray(golden.goldenSets)) {
      const { goldenSetIdentities } = await import('../server/selfeval/collect.js');
      golden.goldenSets = goldenSetIdentities((golden.shells || []).filter((s) => !s.skipped).map((s) => ({ ref: s.ref })));
    }
  } else {
    try {
      const mod = await import('./golden-report.mjs');
      golden = await mod.runGoldenGate();
    } catch (e) {
      goldenReason = '读不到库 / 金标跑不起来：' + String((e && e.message) || e).slice(0, 160);
    }
  }
  const report = composeReport(snapshot, buildGoldenSection(golden, goldenReason), code);
  // 基线指针（"改动前"是哪一份）：**在覆盖指针之前**读旧值，并写进报告 —— 否则"前后对比"永远找不到"前"。
  // 只要有上一份就写上（哪怕同窗口同代码：那正是"同一窗口的两次读数"；可不可比由 metrics-gate.mjs 的
  // compareWindows 判，别在这里替它下结论）。
  const prev = readLatestPointer();
  if (prev && prev.path) report.baselineRef = prev.path;
  return { report, snapshot, golden, goldenReason, code };
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] ?? '') : d; };
  const DAYS = Math.max(1, Number(val('days', 7)) || 7);
  const CUTOFF = val('cutoff');
  const OUT = val('out');
  const QUIET = argv.includes('--quiet');
  const NO_DB = argv.includes('--no-db');
  const NO_GOLDEN = argv.includes('--no-golden');

  const { report } = await collectReport({ days: DAYS, cutoff: CUTOFF, noDb: NO_DB, noGolden: NO_GOLDEN });

  // ③ 落盘（不可变 + 指针）
  let where;
  try { where = writeMetricsSnapshot(report); }
  catch (e) { console.error('❌ 写盘失败：' + String((e && e.message) || e).slice(0, 160)); await closePool(); process.exitCode = 2; return; }
  if (OUT) {
    const p = path.isAbsolute(OUT) ? OUT : path.join(ROOT, OUT);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }

  if (!QUIET) console.log(formatReport(report));
  const gi = goldenInPlace(report), ci = c4InPlace(report);
  console.log('指标报告已写 ' + where.rel + '（指针 tmp/metrics/latest.json）· 金标' + (gi.inPlace ? '在位' : '**不在位**')
    + ' · C4 监控' + (ci.inPlace ? '在位' : '**不在位**'));
  // 退出码：**采集本身**失败（库读不到）单独一个码，好让 CI/装机把它和"门禁不过"分开说
  if (report.databaseAvailable === false) {
    console.log('⚠️ 库读不到：' + ((report.collectErrors || [])[0] || '原因未记录') + ' —— 未判定，**不是通过**');
    process.exitCode = 3;
  }
  await closePool();
}

const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith(SELF)) {
  try {
    await main();
    // 池子：连上过就必须关（MySQL 的空闲连接不回收）；没连上时 close() 直接结束、end() 会去握手可能挂住 —— 照 selfeval-collect.mjs
    await closePool();
    process.exit(process.exitCode || 0);
  } catch (e) {
    console.error('[' + (e.name || 'Error') + '] ' + String((e && e.message) || e));
    await closePool();
    process.exit(2);
  }
}
