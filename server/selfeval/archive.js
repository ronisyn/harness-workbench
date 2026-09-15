// server/selfeval/archive.js —— 指标快照/提案记录的**仓库内归档约定**（v0.3 §0.4 M3 的"落地记录"载体）
//
// ── 为什么快照要进仓库（而不是只落 tmp/）──────────────────────────────────────────────────
//   ㉔ 的落盘位置（`tmp/metrics/<batchId>/<codeId>/snapshot.json`，见 `regression-gate.js` ⑥）是为**门禁**
//   设计的：写盘不许把工作区搞脏（`scripts/release.mjs` 第 1 步就查 `git status --porcelain` 为空）。
//   但 M3 出口标准要的是**跨周期的前后对比**（"连续两个周期…每条附前后指标对比"）——
//   那个对比对象必须**活得比 tmp/ 久**：`tmp/` 是可重建、会被清掉的中间产物，拿它当审计证据
//   等于证据随机器一起蒸发。
//   ⇒ 于是分两个位置，各管一件事（**不是两套口径**）：
//     · `tmp/metrics/…`       ：门禁工作区（默认，逐次采集，可被清理，不进 git）
//     · `proposals/metrics/…` ：**归档区**（本文件；进仓库、对审计有价值、随 `proposals/` 永不删）
//   同一个 `writeMetricsSnapshot` 实现写两处（靠 `root` 参数），所以"哪个文件叫什么"只有一处代码。
//
// ── 为什么必须小 ─────────────────────────────────────────────────────────────────────────
//   进仓库的文件会**永久留在历史里**（`proposals/` 永不删）。所以这里只落**结构化小快照**：
//   逐项读数（C1–C5/失败率/金标读数）、窗口、代码版本锚、金标集身份 —— 都是标量与短数组。
//   **不含**：逐轮 token 明细、`audit_log` 明细行、逐条金标问答（后台 rollup 才需要的东西）。
//   实测一份真报告 ≈ 11.5 KB（`tmp/metrics/selfeval-2026-09-16-7d/*/snapshot.json`），
//   远小于仓库里现有文档（最大的一份 106 KB）。上限取 `M3_ARCHIVE_MAX_BYTES`＝256 KiB：
//   超了**不截断、不静默丢弃**，而是如实报 `skipped` 让调用方去处置（截断过的快照拿去比前后，
//   等于把对比对象弄残 —— 那比不归档更糟）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { snapshotRef, normalizeCodeId } from './regression-gate.js';

/** 归档根目录（**仓库内**；`proposals/` 对审计有价值且本仓永不删） */
export const M3_ARCHIVE_ROOT = 'proposals/metrics';
/** 归档根的说明文件（人读；跟着快照一起进仓库，解释"为什么在这里、为什么这么小"） */
export const M3_ARCHIVE_README = M3_ARCHIVE_ROOT + '/README.md';
/** 指针文件：指向最近一次归档的快照（形状照 `tmp/metrics/latest.json`，多一个 `kind` 好认） */
export const M3_ARCHIVE_POINTER = M3_ARCHIVE_ROOT + '/latest.json';
/** 归档体积上限（字节）。**不是判定线，是落盘纪律**：超了不归档并如实报，绝不截断 */
export const M3_ARCHIVE_MAX_BYTES = 256 * 1024;

/** 归档区里一份快照的引用（字段与 `regression-gate.snapshotRef` 同款，只换根目录与 URL） */
export function archiveFileRef({ batchId, codeId, root = ROOT } = {}) {
  const batch = batchId || 'unknown';
  const code = codeId || 'nogit';
  const p = [M3_ARCHIVE_ROOT, batch, code, 'snapshot.json'].join('/');
  return {
    path: p,
    url: 'file:///' + path.join(root, p).replace(/\\/g, '/'),
    batchId: batch, codeId: code,
  };
}

/** 同秒撞名时用的稳定后缀：报告自带的内容指纹（`ref.hash`，由 `composeReport` 算出来）优先 */
function stampOf(report) {
  return String((report && report.at) || new Date().toISOString())
    .replace(/[:.]/g, '').replace(/-/g, '').replace('T', '-').replace('Z', '');
}

/**
 * 把一份指标报告写进**仓库内归档区**（不可变：同名不覆盖，撞名加内容指纹后缀）。
 *
 * 返回的报告（`doc`）与传入的报告**只差引用**：`ref.path` / `ref.url` 指向归档位置，
 * `baselineRef` 若是 `tmp/` 下的也一并指到归档位置（若有对应文件）。**读数一个字不改** ——
 * 归档件必须还是同一份"能过 `checkMetricsReport` 的指标报告"，否则它就不能当对比对象。
 *
 * @param {object} report `scripts/metrics-report.mjs` 的 `composeReport` 产物
 * @param {{root?:string, archiveRoot?:string, maxBytes?:number}} [opts]
 * @returns {{skipped:boolean, reason?:string, file?:string, rel?:string, bytes?:number, ref?:object, doc?:object, pointer?:string}}
 */
export function writeArchivedSnapshot(report, { root = ROOT, archiveRoot = M3_ARCHIVE_ROOT, maxBytes = M3_ARCHIVE_MAX_BYTES } = {}) {
  if (!report || typeof report !== 'object') return { skipped: true, reason: '没有报告可归档' };
  const batch = report.batchId || 'unknown';
  const code = normalizeCodeId(report.code);
  const dir = path.join(root, archiveRoot, batch, code);
  const hash = (report.ref && report.ref.hash) || null;
  // 撞名策略：默认 `snapshot.json`（人读友好）；已存在则加 `snapshot-<时间>-<指纹>.json`。
  // 为什么带内容指纹而不只带时间：同一秒内两次归档（真发生过：夹具与发布脚本连着写）
  // 会算出同一个名字，第二次就把第一次**覆盖**掉 —— 那正是"不可变"要防的事。
  let file = path.join(dir, 'snapshot.json');
  if (fs.existsSync(file)) file = path.join(dir, `snapshot-${stampOf(report)}${hash ? '-' + hash : ''}.json`);
  const rel = path.relative(root, file).split(path.sep).join('/');
  const doc = archiveDoc(report, { rel, root, archiveRoot });
  const text = JSON.stringify(doc, null, 2) + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    // 超限就**不归档**（也不截断）：调用方拿到 skipped 与真实体积，去决定是删读数还是别的地方落
    return { skipped: true, reason: `归档件 ${bytes} 字节 > 上限 ${maxBytes}（不截断、不静默丢弃），未归档`, bytes, rel };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  const pointer = path.join(root, M3_ARCHIVE_POINTER);
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  fs.writeFileSync(pointer, JSON.stringify({
    kind: 'rw-metrics-archive',
    path: rel,
    url: 'file:///' + path.resolve(file).replace(/\\/g, '/'),
    batchId: batch, codeId: code, commit: (report.code && report.code.commit) || null,
    dirty: Boolean(report.code && report.code.dirty), at: report.at || null,
    hash, bytes,
  }, null, 2) + '\n', 'utf8');
  return { skipped: false, file, rel, bytes, ref: doc.ref, doc, pointer: M3_ARCHIVE_POINTER };
}

/**
 * 归档件（纯函数）：把报告的引用改指到归档位置，**其它字段原样**。
 * 只改两处，都只该由归档方改：`ref.path`/`ref.url`（这份文件现在住在哪）与 `baselineRef`
 * （若"改动前"那份也已归档，指向归档区里的那一份，让**快照在仓库里能自洽地互相引用**）。
 * 为什么"改动前"要找一找再改：`ref.path` 是"可寻址位置"（㉒㉓ 接口点③），
 * 指着一个仓库里不存在的 tmp 路径，跨机器/半年后谁也对不上。
 */
export function archiveDoc(report, { rel, root = ROOT, archiveRoot = M3_ARCHIVE_ROOT } = {}) {
  const doc = { ...report, ref: { ...(report.ref || {}), path: rel, url: 'file:///' + path.join(root, rel).replace(/\\/g, '/') } };
  const base = typeof report.baselineRef === 'string' ? report.baselineRef : null;
  if (base) {
    const tail = base.split('/').slice(3).join('/');   // `tmp/metrics/<batch>/<code>/<file>` → `<batch>/<code>/<file>`
    const cand = [archiveRoot, tail].join('/');
    if (fs.existsSync(path.join(root, cand))) doc.baselineRef = cand;
  }
  return doc;
}
