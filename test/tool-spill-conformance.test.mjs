// test/tool-spill-conformance.test.mjs - v0.3 §6.1 通则的机检：「任何"大结果"工具都必须遵守溢出规范」。
//
// §6.1 原文点名的 Excel 处置＝**结构摘要 + 行列信息 + 溢出文件路径**，需要明细时按范围二次取数；
// 符合性核对 §3.2 又列出 5 个"仍用工具级硬截断、被切掉的部分既无定位符也不落 spill"的工具。本夹具就锁两件事：
//   ① 收口后的工具：大结果必须给出**可用的定位符**（文件真的存在、装的是完整明细、能按范围取回）；
//   ② 摘要自身不许超过内联上限（否则会被外层 spill 再切一次，定位符可能被挤出模型可见区）。
// 另外覆盖两条本轮新增的约束：`extract_xlsx` 的返回值形状（摘要/行列/路径三者齐）、
// 以及溢出文件的**会话归属**（别的会话来取 → 必须拒绝）。
//
// 驱动方式：直接调工具的 run（不起 HTTP、不连库、不发真网络请求）。工作区被指到临时目录，
// 溢出文件因此都落在临时目录里，夹具用完删掉自己造的东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// spill.js / env.js 在 import 时读 RW_WORKSPACE ⇒ 必须先设好再动态 import（同 test/spill.test.mjs 的做法）
const TMP = path.join(os.tmpdir(), 'rw-spill-conf-' + Date.now());
process.env.RW_WORKSPACE = TMP;
fs.mkdirSync(TMP, { recursive: true });
const { detailSummary, readSpill, spillOwnerDir, DETAIL_PREVIEW_CHARS, SPILL_DIR } = await import('../server/tools/spill.js');
const { TOOLS } = await import('../server/tools/index.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEAN = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on('exit', CLEAN);
const tool = (n) => TOOLS.find((t) => t.name === n);
const CTX = (permission = 'read') => ({ permission, root: TMP, limitPath: permission !== 'full', conversationId: 123, accountId: 0 });

/** 从任意返回值里收集溢出定位符（spill.path / spill[].path） */
function spillPaths(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  const abs = (p) => typeof p === 'string' && p.startsWith(SPILL_DIR);
  if (abs(v.path)) out.push(v.path);
  for (const x of Object.values(v)) if (x && typeof x === 'object') spillPaths(x, out);
  return out;
}

/** 通用断言（v0.3 §6.1 通则）：被截断过就必须有定位符，文件必须在、必须装得下完整明细、摘要必须仍在内联上限内 */
function assertSpilled(res, { label, detailText, mustContain = [] }) {
  const paths = spillPaths(res);
  assert.ok(paths.length > 0, label + '：明细被截断过就必须给出溢出定位符。实返回：' + JSON.stringify(res).slice(0, 400));
  for (const p of paths) assert.ok(fs.existsSync(p), label + '：定位符指向的文件必须真的存在：' + p);
  const full = paths.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  if (detailText != null) assert.ok(full.length >= detailText.length * 0.99, label + '：溢出文件里必须是完整明细（不许又一份被切过的副本）');
  for (const s of mustContain) assert.ok(full.includes(s), label + '：溢出文件里缺了「' + s + '」——说明有中段/尾部被静默丢掉');
  const j = JSON.stringify(res);
  assert.ok(j.length <= 4000, label + '：摘要自身不该超过内联上限 4000（实为 ' + j.length + '，会被外层再切一次）');
  return full;
}

// ---------- detailSummary 单元（收口的唯一出口） ----------
test('detailSummary：明细全文落盘 + 头部预览 + 精确省略量；小结果不落盘', () => {
  const small = detailSummary('一行\n二行', { tool: 'extract_pdf', conversationId: 123 });
  assert.equal(small.spillPath, null, '没超预览预算就不该落盘');
  assert.equal(small.preview, '一行\n二行');
  assert.equal(small.omittedChars, 0);

  const text = Array.from({ length: 500 }, (_, i) => 'row ' + i + ' ' + 'x'.repeat(30)).join('\n');
  const d = detailSummary(text, { tool: 'extract_pdf', conversationId: 123 });
  assert.ok(d.spillPath && fs.existsSync(d.spillPath), '超预算必须落盘');
  assert.equal(fs.readFileSync(d.spillPath, 'utf8'), text, '落盘内容＝完整明细（模型取回的与工具算出的是同一份）');
  assert.equal(d.chars, text.length);
  assert.equal(d.totalLines, 500);
  assert.ok(d.preview.length <= DETAIL_PREVIEW_CHARS, '预览不许超预算');
  assert.equal(d.preview, text.slice(0, d.preview.length), '预览必须是头部原文（不许中间挖洞）');
  assert.equal(d.omittedChars, text.length - d.preview.length);
});

test('detailSummary：落盘失败不静默丢——返回 degraded 原因，调用方必须如实带出去', () => {
  // 把"会话目录"这个路径占成**文件**，mkdirSync/writeFileSync 必然失败（与 spill.test.mjs 的降级夹具同一手法）
  fs.mkdirSync(SPILL_DIR, { recursive: true });
  fs.writeFileSync(spillOwnerDir(777), 'x');
  const d = detailSummary('y'.repeat(5000), { tool: 'extract_pdf', conversationId: 777 });
  assert.equal(d.spillPath, null);
  assert.ok(d.degraded && d.degraded.length > 0, '必须给出失败原因');
  assert.ok(d.preview.length > 0, '降级时仍要给头部预览（不能什么都不给）');
  fs.rmSync(spillOwnerDir(777), { force: true });
});

// ---------- extract_xlsx：v0.3 §6.1 点名的那一条 ----------
test('extract_xlsx：结构摘要 + 行列信息 + 溢出文件路径三者齐，且明细按范围可取回', async () => {
  // xlsx 是 CJS 包：ESM 互操作下 API 只在 default 上（extract.js 里的同一处坑，这里照同一算式取）
  const mod = await import('xlsx');
  const XLSX = (mod.default && typeof mod.default.readFile === 'function') ? mod.default : mod;
  const file = path.join(TMP, 'fixture.xlsx');
  const wb = XLSX.utils.book_new();
  const detail = [['姓名', '金额', '备注']].concat(Array.from({ length: 400 }, (_, i) => ['甲' + i, String(i), 'r'.repeat(30)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), '明细');
  const summary = [['城市', '单量']].concat(Array.from({ length: 200 }, (_, i) => ['城' + i, String(i)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), '汇总');
  XLSX.writeFile(wb, file);

  const res = await tool('extract_xlsx').run({ path: file }, CTX());
  // ① 结构摘要：两张表，各多少行多少列
  assert.ok(Array.isArray(res.sheets) && res.sheets.length === 2, '必须给出 sheets 结构摘要');
  const s1 = res.sheets.find((s) => s.name === '明细');
  const s2 = res.sheets.find((s) => s.name === '汇总');
  assert.equal(s1.rows, 401);
  assert.equal(s1.cols, 3);
  assert.equal(s2.rows, 201);
  assert.equal(res.totalRows, 602);
  // ② 行列信息：每张表在溢出文件里的字符区间与行区间
  for (const s of [s1, s2]) {
    for (const k of ['offset', 'length', 'fromLine', 'toLine']) assert.equal(typeof s[k], 'number', 'sheet ' + s.name + ' 缺 ' + k);
  }
  assert.equal(s1.offset, 0);
  assert.equal(s2.offset, s1.length + 2, '第二张表的 offset 必须接在第一张之后（表间空行）');
  // ③ 溢出文件路径 + 完整明细
  assert.ok(res.spill && res.spill.path, '必须给出溢出文件路径');
  const full = assertSpilled(res, { label: 'extract_xlsx', detailText: null, mustContain: ['【明细】', '甲0', '甲399', '【汇总】', '城199'] });
  assert.equal(full.length, res.chars, '溢出文件长度＝报告的字符数');
  assert.ok(res.preview.includes('【明细】'), '预览要给到第一张表的表头');
  // 按范围二次取数：用第二张表的区间只取回那张表（这正是"需要明细时按范围取"）
  const part = readSpill(res.spill.path, s2.offset, s2.length, 123);
  assert.equal(part.content.startsWith('【汇总】'), true, '按 sheet 区间取回必须恰好是那张表');
  assert.equal(part.content.includes('甲399'), false, '不许把别的表也带回来');
  assert.ok(part.content.includes('城199'));
  // 负数例：旧行为（整表 slice(0,20000) 直接进上下文）必须不再发生
  assert.equal(typeof res.text, 'undefined', '整表明细不许再直接进上下文');
});

// ---------- extract_pptx：同族（不再各写 slice(0,20000)） ----------
test('extract_pptx：同族改法——预览 + 行数/字节数 + 溢出路径，明细全在溢出文件里', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const file = path.join(TMP, 'fixture.pptx');
  const xml = (i) => strToU8('<a:p>第' + i + '页标题</a:p>' + '<a:p>' + 'p'.repeat(6000) + '</a:p>');
  fs.writeFileSync(file, Buffer.from(zipSync({ 'ppt/slides/slide1.xml': xml(1), 'ppt/slides/slide2.xml': xml(2) })));

  const res = await tool('extract_pptx').run({ path: file }, CTX());
  assert.ok(res.lines > 0 && res.chars > 0 && res.bytes > 0, '要给量：行数/字符数/字节数');
  assert.ok(res.preview && res.preview.includes('第1页标题'));
  assertSpilled(res, { label: 'extract_pptx', detailText: null, mustContain: ['第1页标题', '第2页标题'] });
  assert.equal(typeof res.text, 'undefined');
});

// ---------- repo_map：不再循环中途 break ----------
test('repo_map：地图完整生成并落 spill（尾部文件也在），不再"已达容量上限"式中段丢弃', () => {
  const dir = path.join(TMP, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 80; i++) {
    fs.writeFileSync(path.join(dir, 'mod' + i + '.js'),
      ["import fs from 'node:fs';", "import path from 'node:path';", `export function fn${i}(a) { return a; }`, `export const v${i} = ${i};`, `// ${'填充注释 '.repeat(12)}`].join('\n'), 'utf8');
  }
  const res = tool('repo_map').run({ dir }, CTX());
  return res.then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.summary.files, 80);
    const full = assertSpilled(r, { label: 'repo_map', detailText: null, mustContain: ['mod0.js', 'mod79.js'] });
    assert.equal(full.includes('已达容量上限'), false, '旧的"容量上限"截断痕迹不许再出现');
    assert.equal(typeof r.text, 'undefined', '大仓库不再整份进上下文');
    assert.ok(r.preview.includes('📁'), '预览要给到目录树头部');
    assert.ok(String(r.hint).includes('fetch_spill'));
  });
});

test('repo_map：小地图照旧原样给 text（别把简单事做复杂）', () => {
  const dir = path.join(TMP, 'repo-small');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function a() {}\n', 'utf8');
  return tool('repo_map').run({ dir }, CTX()).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(typeof r.text, 'string');
    assert.equal(r.spill, undefined, '没超预算就不该落盘');
    assert.ok(Array.isArray(r.files));
  });
});

// ---------- fetch_url：不再 slice(0,8000) 静默丢尾 ----------
test('fetch_url：长网页落 spill 并给定位符（尾部可达），短网页照旧 inline', async () => {
  const orig = globalThis.fetch;
  const body = 'ABCDEF '.repeat(6000); // 约 42k 字符
  globalThis.fetch = async () => ({ ok: true, text: async () => '<html><head><title>夹具页</title></head><body>' + body + '尾部标记END</body></html>' });
  try {
    const res = await tool('fetch_url').run({ url: 'https://example.invalid/x' }, CTX());
    assert.equal(res.title, '夹具页');
    assert.ok(res.chars > 8000, '夹具本身要够长（旧写法会在 8000 处截断）');
    const full = assertSpilled(res, { label: 'fetch_url', detailText: null, mustContain: ['尾部标记END'] });
    assert.equal(full.length, res.chars);
    assert.equal(typeof res.text, 'undefined');
    // 短网页：原样给 text（老行为不变）
    globalThis.fetch = async () => ({ ok: true, text: async () => '<html><title>短</title><body>短正文</body></html>' });
    const small = await tool('fetch_url').run({ url: 'https://example.invalid/s' }, CTX());
    assert.ok(small.text.includes('短正文'), '小结果照旧内联：' + JSON.stringify(small));
    assert.equal(small.spill, undefined);
  } finally { globalThis.fetch = orig; }
});

// ---------- run_command：execFile 那一臂落 spill；shell 那一臂如实标注"中段在更早一层就丢了" ----------
test('run_command（read/write 档）：完整输出落 spill + 定位符，中段不丢', async () => {
  const big = path.join(TMP, 'big.txt');
  const lines = Array.from({ length: 2000 }, (_, i) => 'line' + i + ' ' + 'z'.repeat(20));
  fs.writeFileSync(big, lines.join('\n'), 'utf8');
  // 白名单里的读命令（跨平台）：POSIX grep / Windows findstr，都按行原样打印
  const cmd = (process.platform === 'win32' ? 'findstr . ' : 'grep . ') + big;
  const res = await tool('run_command').run({ cmd }, CTX('write'));
  assert.ok(Array.isArray(res.spill) && res.spill.some((s) => s.stream === 'stdout'), 'stdout 被截断就必须落 spill：' + JSON.stringify(res).slice(0, 300));
  const full = assertSpilled(res, { label: 'run_command', detailText: null, mustContain: ['line0 ', 'line1999 '] });
  assert.equal(full.includes('已截断中段'), false, '本臂拿得到完整输出，不该出现"截断中段"');
  assert.ok(String(res.hint).includes('fetch_spill'));
  assert.equal(typeof res.stdout, 'string', 'stdout 键仍在（值＝预览）——下游按 result.stdout 取正文的老口径不破');
});

test('run_command（full 档）：shell 层先截断时如实标注并给出取全文的正路（不假装拿全了）', async () => {
  const cmd = 'node -e "process.stdout.write(\'q\'.repeat(20000))"';
  const res = await tool('run_command').run({ cmd }, CTX('full'));
  assert.deepEqual(res.clippedByShell, ['stdout'], 'shell.js 的 clip 标记必须被认出来并如实上报：' + JSON.stringify(res).slice(0, 300));
  assert.ok(/run_long_task/.test(String(res.hint)) && /read_file_range/.test(String(res.hint)), '必须给出"要全文该怎么走"');
  assert.ok(JSON.stringify(res).length <= 4000, '结果自身仍要守内联上限');
});

// ---------- 收口清单：实现里不许再有工具级硬截断 ----------
test('收口清单：大结果工具统一走 detailSummary，旧的工具级硬截断痕迹必须消失', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/tools/index.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = src.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.ok(/detailSummary\(/.test(code), '收口出口必须在位');
  assert.equal(/slice\(0, 20000\)/.test(code), false, '旧的 20000 字符硬切必须消失（§6.1 点名的那条）');
  assert.equal(/text: text\.slice\(0, 8000\)/.test(code), false, 'fetch_url 的 8000 硬切必须消失');
  assert.equal(/rows: rows\.slice\(0, 50\)/.test(code), false, 'db_query 的"只给前 50 行、其余静默丢"必须消失');
  // extract 四件同族同出口（定义一个 + 四个调用点）
  assert.ok((code.match(/extractToolResult\(/g) || []).length >= 5, '四个 extract_* 必须同族同出口');
  // 实现侧的 extract.js 不许再截断
  const ext = fs.readFileSync(path.join(ROOT, 'server/tools/extract.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(/\.slice\(0,\s*\d{4,}\)/.test(ext), false, 'extract.js 不许再做长度截断（上限归上层溢出）');
  // repomap.js 不许再按字符上限中途 break（注释里提到旧常量不算，只看代码）
  const rmSrc = fs.readFileSync(path.join(ROOT, 'server/tools/repomap.js'), 'utf8').replace(/\r\n/g, '\n');
  const rm = rmSrc.split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.equal(/MAX_TEXT/.test(rm), false, 'repomap.js 的 MAX_TEXT 中途截断必须消失');
});

// ---------- 溢出文件的会话归属（v0.3 §4.4「溢出文件的权限」；符合性核对 §3.5 缺陷②） ----------
test('溢出文件按会话隔离：别的会话来取必须拒绝（如实报错，不返回空内容）', () => {
  const text = JSON.stringify({ text: 'S'.repeat(9000) });
  const d = detailSummary(text, { tool: 'extract_xlsx', conversationId: 123 });
  assert.ok(d.spillPath);
  assert.equal(readSpill(d.spillPath, 0, 10, 123).content, text.slice(0, 10), '本会话取得到');
  assert.throws(() => readSpill(d.spillPath, 0, 10, 456), /只能取回本会话自己的溢出文件/, '别的会话必须被拒绝');
  assert.throws(() => readSpill(d.spillPath, 0, 10), /只能取回本会话自己的溢出文件/, '不带会话 id（anon 口径）同样拒绝');
  // 反面：anon 会话自己的溢出文件仍然取得到（读写两侧同一个算式，不然自己就把自己锁死了）
  const anon = detailSummary(text, { tool: 'extract_xlsx' });
  assert.equal(readSpill(anon.spillPath, 0, 8).content, text.slice(0, 8));
});
