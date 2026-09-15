#!/usr/bin/env node
// scripts/golden-report.mjs —— ⑲「金标随包自检」的**门禁判定 + 结果导出**（v0.3 §4.8「评测结果可导出」）
//
// 为什么要有它（v0.3 §0.4 / §7.1 ⑲，见《v0.3 符合性核对-20260916》§1.4、§3.5⑦）：
//   金标**随包**的载体早已在位（`eval/code.json` + 壳行 `shells.eval_ref`，跑在 `server/canary.js`），
//   但 `scripts/release.mjs` / CI / 安装脚本三处都不跑它，结果也只落一行 `audit_log`（上限 500 行、不可离线带走）
//   ⇒「金标回归随引擎打包（M3 准入前置）」只到"可跑"，没到"门禁"，也没到"可导出"。
//   本脚本把这两件事一起补上：**判定**（门禁用）与**导出**（CI 产物 / 离线对账用）。
//
// 口径（三条，都不发明新标准）：
//   ① **判定判据就是 `passed === total`**（0/1，照抄 `server/canary.js` 的既有语义）——这里**不设通过率阈值**；
//      百分比/基线对比属于 §7.1 ㉔「指标回归门禁」，不是本轮的事（别在这里顺手发明一条通过线）。
//   ② **skipped 不算通过、也不算失败**：金标文件缺失/壳未配 `eval.goldenSetRef`/壳不存在都如实记 skipped
//      （canary.js 已有该语义，不放宽）；**跑不起来 ≠ 通过**，报告里 skipped 单独成一栏。
//   ③ **读不到库不阻断**：跳过并说明原因。理由与 `release.mjs` 的活跃会话检查同款——本仓的库只在
//      开发机/服务器上有，CI 与客户机没有；"本地能跑、CI 判红"久了就没人看门禁了。
//
// 用法：
//   node scripts/golden-report.mjs                          # 跑每个启用的壳，写 tmp/golden-report.json
//   node scripts/golden-report.mjs --only code              # 只跑指定壳（可重复；给不存在的 key 会记 skipped，不假装通过）
//   node scripts/golden-report.mjs --out tmp/x.json         # 指定结果文件路径（CI 拿它当产物）
//   node scripts/golden-report.mjs --quiet                  # 只打印一行结论（release.mjs 用）
// 退出码：0=全绿或如实跳过（含"无壳可跑"/"读不到库"）；1=门禁不过（某壳 passed!==total）；2=用法或环境错误
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../server/config.js';
import { db, pool } from '../server/db.js';
import { runGoldenChecks, loadGoldenItems } from '../server/canary.js';

// 结果文件格式（自描述，参照 `rw-session` 导出物的做法方便将来对账）
export const GOLDEN_REPORT_FORMAT = 'rw-golden-report';
export const GOLDEN_REPORT_VERSION = 1;

/**
 * 金标集的**身份**（sha1 over 条目的规范化 JSON：q / expectIntent / expectTool / expectExposed，按文件顺序）。
 * 为什么需要它（㉔ 指标回归门禁的输入）：只有 `code=9/9` 时判不出"前后跑的是不是同一套金标"——
 * `eval/code.json` 增删一条断言会改 total（**集合变了**），与"同一套金标这次没过"（**行为变了**）是两回事，
 * 处置完全不同（见 server/selfeval/regression-gate.js 的 diffGolden）。
 * 结构化（对象）而不是字符串：门禁要能直接读 count/sha1，不必再解析文本。
 */
export function goldenIdentityOf(ref) {
  let items = null;
  try { items = loadGoldenItems(ref); } catch { items = null; }
  if (!items || !items.length) return { ref: ref ?? null, exists: false, count: 0, sha1_12: null };
  const canon = JSON.stringify(items.map((it) => [it.q, it.expectIntent ?? null, it.expectTool ?? null, it.expectExposed ?? null]));
  return { ref, exists: true, count: items.length, sha1_12: crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12) };
}

/** 人读的身份缩写（`code@a1b2c3d4(9条)`）；读不到就是 `code@缺失` */
function identityTag(identity) {
  if (!identity) return '';
  return identity.exists ? identity.ref + '@' + identity.sha1_12 + '(' + identity.count + '条)' : identity.ref + '@缺失';
}

/**
 * 门禁判定（**纯函数**，夹具锁它）：金标本来就是 0/1 判据 —— `passed === total`。
 * @param {{judged:boolean, shells:Array}} report runGoldenGate 的结果
 * @returns {boolean} true=放行
 */
export function goldenGatePass(report) {
  const shells = (report && report.shells) || [];
  // 一条都没判过（无壳可跑 / 全 skipped）：**不算失败**，但也绝不是通过 —— 由调用方如实打印 skipped 原因
  if (!shells.some((s) => s && !s.skipped)) return true;
  // 有判过的：每一条都必须 passed===total（skipped 的壳不参与判定，也不顶替通过）
  return shells.every((s) => s && (s.skipped || s.passed === s.total));
}

/** 门禁是否**真的判过**（用于把"全 skipped"和"全绿"在输出里分开说，别混成一句"通过"） */
export function goldenGateJudged(report) {
  return ((report && report.shells) || []).some((s) => s && !s.skipped);
}

/** 人读的一行结论 */
export function goldenGateLine(report) {
  if (!goldenGateJudged(report)) {
    const why = ((report && report.shells) || []).map((s) => (s.reason || '')).filter(Boolean);
    return 'skipped（未判定：' + (why.join('；') || '没有可跑的壳') + '）';
  }
  const judged = report.shells.filter((s) => !s.skipped);
  const t = judged.reduce((n, s) => n + s.total, 0);
  const p = judged.reduce((n, s) => n + s.passed, 0);
  const sk = report.shells.filter((s) => s.skipped).length;
  // 金标集身份：只有 passed/total 时判不出"前后跑的是不是同一套金标"（㉔ 门禁要区分集合变化与行为变化）
  const ids = (judged.map((s) => s.identity).filter(Boolean)
    .map((x) => identityTag(x)).filter(Boolean));
  const uniq = [...new Set(ids)];
  return 'passed=' + p + '/' + t + '（' + judged.length + ' 个壳' + (sk ? '，另有 ' + sk + ' 个 skipped' : '') + '）'
    + (uniq.length ? ' · 金标集 ' + uniq.join(' ') : '');
}

/**
 * 跑每个启用壳的金标断言（壳的取法与 `server/index.js` 的 `runShellCanaryAndAudit` **逐字同口径**：
 * `shells` 行的 presetBase/intent_rules + `shell_tools` 的 force_on/force_off 三态）—— 门禁必须跑
 * "线上那张壳的脸"，不是跑 pack.json 文件，否则门禁绿了而线上是另一套工具面。
 *
 * @param {{dbc?:object, only?:string[]}} opts dbc 仅夹具用（默认真库）；only 限量壳 key
 * @returns {Promise<object>} 结构化结果（可直接写盘，见 writeGoldenReport）
 */
export async function runGoldenGate({ dbc = db, only = null } = {}) {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const onlyKeys = Array.isArray(only) && only.length ? only.map(String) : null;
  const rows = await dbc.query(
    "SELECT id, skey, name, tools_preset, eval_ref, intent_rules FROM shells WHERE status='enabled' ORDER BY id");
  const enabled = rows.filter((r) => !onlyKeys || onlyKeys.includes(r.skey));
  const shells = [];

  for (const r of enabled) {
    // ① 壳没配金标集 → 如实报 skipped（不阻断、也不假装通过）——与 index.js 的 canary 前置检查同一句话
    if (!r.eval_ref) { shells.push({ shell: r.skey, ref: null, skipped: true, reason: '未配置 eval.goldenSetRef' }); continue; }
    if (!loadGoldenItems(r.eval_ref)) { shells.push({ shell: r.skey, ref: r.eval_ref, skipped: true, reason: '金标文件缺失或为空', identity: goldenIdentityOf(r.eval_ref) }); continue; }
    // ② 壳的三态照 `shell_tools` 读（与 canary:run 同一处口径）
    const tools = await dbc.query('SELECT tool_name, mode FROM shell_tools WHERE shell_id=?', [r.id]);
    const on = [], off = [];
    for (const t of (tools || [])) { if (t.mode === 'force_on') on.push(t.tool_name); else if (t.mode === 'force_off') off.push(t.tool_name); }
    const shell = { id: r.id, presetBase: r.tools_preset || 'standard', forceOn: on, forceOff: off };
    const identity = goldenIdentityOf(r.eval_ref);
    const res = await runGoldenChecks(r.eval_ref, shell);
    if (res.skipped) { shells.push({ shell: r.skey, ref: r.eval_ref, skipped: true, reason: res.reason || '金标文件缺失或为空', identity }); continue; }
    shells.push({
      shell: r.skey, ref: r.eval_ref, skipped: false, passed: res.passed, total: res.total,
      // 金标集身份：判"前后是不是同一套"（㉔ 门禁区分集合变化 vs 行为变化的依据）
      identity,
      // 逐条明细：门禁判红时定位"哪一条断言错了"必须能在产物里直接看到（不然还得回服务器上重跑）
      cases: (res.results || []).map((c) => ({
        i: c._i, q: c.q, pass: Boolean(c.pass),
        ...(c.pass ? {} : { want: c.want, got: c.got }),
      })),
    });
  }
  // ③ only 里点了但库里没有的 key：如实记一行 skipped，**不能静默忽略**（不然 `--only typo` 会显示"全绿"）
  for (const k of (onlyKeys || [])) {
    if (!enabled.some((r) => r.skey === k)) shells.push({ shell: k, ref: null, skipped: true, reason: '壳不存在或未启用' });
  }
  // 金标集清单（去重；供 ㉔ 报告直接引用，不必再解析逐壳字段）
  const seen = new Set();
  const goldenSets = [];
  for (const s of shells) {
    if (!s.identity || !s.identity.ref || seen.has(s.identity.ref)) continue;
    seen.add(s.identity.ref);
    goldenSets.push(s.identity);
  }
  return { format: GOLDEN_REPORT_FORMAT, formatVersion: GOLDEN_REPORT_VERSION, at, shells, goldenSets };
}

/** 写结果文件（JSON；父目录自动建）——CI 拿它当产物，离线时也能直接看 */
export function writeGoldenReport(report, outPath) {
  const p = path.resolve(outPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(report, null, 2) + '\n');
  return p;
}

/** 默认结果文件路径：`tmp/`（已 gitignore —— 门禁写盘不许把工作区搞脏，release.mjs 第 1 步就查这个） */
const defaultOut = () => path.join(ROOT, 'tmp', 'golden-report.json');

async function main() {
  const argv = process.argv.slice(2);
  const opts = { only: [], out: defaultOut(), quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--only') opts.only.push(argv[++i]);
    else if (a === '--quiet') opts.quiet = true;
    else { console.error('未知参数：' + a + '\n用法：node scripts/golden-report.mjs [--only <壳key>]... [--out <文件>] [--quiet]'); process.exitCode = 2; return; }
  }

  let report;
  try {
    report = await runGoldenGate({ only: opts.only });
  } catch (e) {
    // 读不到库：如实 skip 并说明（CI 与客户机没有 MySQL；本地隧道没开也一样）。
    // 这份"跳过"也要落盘，CI 的产物才解释得清"为什么这次没判定"。
    report = {
      format: GOLDEN_REPORT_FORMAT, formatVersion: GOLDEN_REPORT_VERSION,
      at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      shells: [{ shell: null, ref: null, skipped: true, reason: '读不到库：' + String((e && e.message) || e).slice(0, 160) }],
    };
    if (!opts.quiet) console.log('⚠️ 金标未判定（读不到库）：' + String((e && e.message) || e).slice(0, 160));
  }

  const file = writeGoldenReport(report, opts.out);
  const rel = path.relative(ROOT, file) || file;
  const pass = goldenGatePass(report);
  if (!opts.quiet) {
    // 逐壳一行（人读）；skipped 与 fail 分列，别混成一句"失败"
    for (const s of report.shells) {
      const head = s.skipped ? '⏭️ ' + (s.shell || '（整体）') + ' skipped' : (s.passed === s.total ? '✅ ' : '❌ ') + s.shell + ' ' + s.passed + '/' + s.total;
      console.log(head + (s.skipped ? ' — ' + s.reason : (s.ref ? '（ref=' + s.ref + '）' : '')));
      for (const c of (s.cases || []).filter((x) => !x.pass)) console.log('   ❌ 第' + c.i + '条 ' + c.q + ' → 期望 ' + c.want + '，实际 ' + c.got);
    }
  }
  console.log('金标' + (goldenGateJudged(report) ? (pass ? '通过' : '**未通过**') : '未判定') + '：' + goldenGateLine(report) + ' · 结果已写 ' + rel);
  process.exitCode = pass ? 0 : 1;
}

// 直接执行才是 CLI；被 release.mjs import 时只取函数，不跑一遍
// （判定写法照 scripts/migrate-c18.mjs：比路径后缀，不依赖调用方的 cwd）
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith(SELF)) {
  try { await main(); } catch (e) { console.error('[' + (e.name || 'Error') + '] ' + String((e && e.message) || e)); process.exitCode = 2; }
  await pool.end();
}
