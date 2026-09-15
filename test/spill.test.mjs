// test/spill.test.mjs - 步6 工具结果溢出（spill）：触发条件 / 预览与省略量 / 定位符与取回 / 存盘失败降级 / 路径围栏
// 纯函数 + 真实临时目录，不依赖数据库与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// spill.js 的工作目录来自 env.js（读 process.env.RW_WORKSPACE），必须在 import 之前设好
const TMP = path.join(os.tmpdir(), 'rw-spill-test-' + Date.now());
process.env.RW_WORKSPACE = TMP;
const { spillToolResult, readSpill, cleanupSpill, SPILL_DIR, SPILL_BYTES, byteCeiling, SPILL_BYTES_PER_CHAR } = await import('../server/tools/spill.js');

const CLEAN = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } };

test('小结果原样进上下文，不落盘', () => {
  CLEAN();
  const text = JSON.stringify({ ok: true, content: '短结果' });
  assert.equal(spillToolResult(text, 4000, { tool: 'list_dir', conversationId: 7, callId: 'c1' }), text);
  assert.equal(fs.existsSync(SPILL_DIR), false);
});

test('超内联上限 → 预览 + 精确省略量 + 定位符；全文落盘且可取回', () => {
  CLEAN();
  const text = JSON.stringify({ text: 'A'.repeat(9000) }); // 约 9k 字符 > cap 4000
  const out = spillToolResult(text, 4000, { tool: 'repo_map', conversationId: 7, callId: 'call-2' });
  assert.match(out, /已省略 \d+ 字节（\d+ 字符）/);           // 精确省略量（字节 + 字符）
  assert.match(out, /全文已存 .+\.txt/);                      // 定位符
  assert.match(out, /fetch_spill \{path:/);                   // 取回指引
  assert.ok(out.length < text.length, '溢出后上下文文本必须显著变小');
  assert.ok(out.includes('AAAA'), '预览需保留头部内容');
  const file = /全文已存 ([^（]+)（/.exec(out)[1];
  assert.equal(fs.readFileSync(file, 'utf8'), text, '落盘内容 = 原全文（模型看到的同一份）');
  // 按定位符分段取回
  const part = readSpill(file, 100, 50);
  assert.equal(part.total, text.length);
  assert.equal(part.content, text.slice(100, 150));
});

test('字节天花板生效：字符未超 cap 但中文字节数超 SPILL_BYTES 仍溢出', () => {
  CLEAN();
  const cn = '中'.repeat(12000); // 12000 字符 = 36000 字节 > 天花板
  assert.ok(Buffer.byteLength(cn) > SPILL_BYTES);
  const out = spillToolResult(cn, 12000, { tool: 'extract_docx', conversationId: 7, callId: 'call-3' });
  assert.match(out, /全文已存/);
});

// ── RA-05b 拍板后的几何断言（2026-09-15）────────────────────────────────────────────
// 旧常量 SPILL_BYTES=32768 在普通路径（cap=4000 ⇒ 字节 ∈ [4000,12000]）上**几何上不可能触发**。
// 现在天花板按 cap 派生，本组夹具锁住"它真的在判定里"，且不误伤现有量级的 ASCII 结果。
test('RA-05b 正例：普通路径（cap=4000）天花板 = 8000 字节 —— CJK 重结果会被字节条件拦下', () => {
  CLEAN();
  assert.equal(SPILL_BYTES_PER_CHAR, 2);
  assert.equal(byteCeiling(4000), 8000);
  assert.equal(SPILL_BYTES, 8000, 'SPILL_BYTES 现在等价于普通路径的实际天花板（兼容旧引用）');
  // 3000 个汉字 = 9000 字节 > 8000，且 3000 字符 ≤ cap 4000 ⇒ 只有字节条件能拦下它
  const cn = '汉'.repeat(3000);
  assert.ok(cn.length <= 4000 && Buffer.byteLength(cn, 'utf8') > byteCeiling(4000));
  const out = spillToolResult(cn, 4000, { tool: 'extract_docx', conversationId: 7, callId: 'call-cjk' });
  assert.match(out, /全文已存/, 'CJK 重结果必须被字节天花板拦下');
});

test('RA-05b 负例：3000 字节的 ASCII 结果（同字符数）不得被拦 —— 天花板不该误伤便宜的结果', () => {
  CLEAN();
  const ascii = 'A'.repeat(3000); // 3000 字符 = 3000 字节 < 8000
  assert.equal(spillToolResult(ascii, 4000, { tool: 'run_command', conversationId: 7, callId: 'call-ascii' }), ascii);
  assert.equal(fs.existsSync(SPILL_DIR), false, '未超限就不该落盘');
});

// ── OP-17 溢出文件保留与清理 ──────────────────────────────────────────────────────────
test('OP-17 按龄清理：过期文件删、新鲜文件留；不碰溢出目录之外', () => {
  CLEAN();
  const dir = path.join(TMP, 'spill-retention');
  fs.mkdirSync(path.join(dir, '11'), { recursive: true });
  const oldF = path.join(dir, '11', 'old.txt');
  const newF = path.join(dir, '11', 'new.txt');
  fs.writeFileSync(oldF, 'x'.repeat(100));
  fs.writeFileSync(newF, 'y'.repeat(50));
  const now = Date.now();
  fs.utimesSync(oldF, new Date(now - 9 * 86400000), new Date(now - 9 * 86400000)); // 9 天前
  const outside = path.join(TMP, 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  const r = cleanupSpill({ dir, maxAgeDays: 7, now });
  assert.equal(r.deletedAge, 1);
  assert.equal(r.kept, 1);
  assert.equal(fs.existsSync(oldF), false, '过期文件必须被删');
  assert.equal(fs.existsSync(newF), true, '新鲜文件必须保留');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me', '目录之外的任何文件都不得被碰');
});

test('OP-17 按量清理：超额度时从最旧开始删；额度内一个都不删', () => {
  CLEAN();
  const dir = path.join(TMP, 'spill-retention2');
  fs.mkdirSync(path.join(dir, '12'), { recursive: true });
  const now = Date.now();
  const mk = (name, size, ageDays) => {
    const f = path.join(dir, '12', name);
    fs.writeFileSync(f, 'z'.repeat(size));
    fs.utimesSync(f, new Date(now - ageDays * 86400000), new Date(now - ageDays * 86400000));
    return f;
  };
  const a = mk('a.txt', 300, 3), b = mk('b.txt', 300, 2), c = mk('c.txt', 300, 1);
  // 额度 500：三个共 900 ⇒ 必须删到 ≤500，即删最旧的 a（-300 → 600）再删 b（-300 → 300）
  const r = cleanupSpill({ dir, maxAgeDays: 30, maxTotalBytes: 500, now });
  assert.equal(r.deletedAge, 0, '按龄不删（都在保留期内）');
  assert.equal(r.deletedQuota, 2);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
  assert.equal(fs.existsSync(c), true, '最新的一份优先保留（取回多半还指着它）');
  assert.ok(r.totalBytes <= 500);
  // 额度充足时：一个都不删
  const r2 = cleanupSpill({ dir, maxAgeDays: 30, maxTotalBytes: 1e6, now });
  assert.equal(r2.deletedQuota + r2.deletedAge, 0);
  assert.equal(r2.kept, 1);
});

test('OP-17 负例：目录不存在时安静返回（不是异常，也不是把 cwd 当溢出目录）', () => {
  const r = cleanupSpill({ dir: path.join(TMP, 'no-such-dir-' + Date.now()) });
  assert.equal(r.scanned, 0);
  assert.equal(r.deletedAge + r.deletedQuota, 0);
  assert.deepEqual(r.errors, []);
});

test('读取类工具不复制落盘，定位符指向源文件', () => {
  CLEAN();
  const out = spillToolResult('B'.repeat(9000), 4000, { tool: 'read_file', args: { path: '/srv/rw-workspace/big.txt' }, conversationId: 7, callId: 'call-4' });
  assert.match(out, /全文即源文件 \/srv\/rw-workspace\/big\.txt/);
  assert.match(out, /read_file_range/);
  assert.equal(fs.existsSync(SPILL_DIR), false, '读取类不该产生溢出文件');
});

test('落盘失败不改工具成败：降级为内联截断并如实提示', () => {
  CLEAN();
  fs.mkdirSync(path.dirname(SPILL_DIR), { recursive: true });
  fs.writeFileSync(SPILL_DIR, 'x'); // 用同名文件占位，使 mkdirSync/写入必然失败
  const out = spillToolResult('C'.repeat(9000), 4000, { tool: 'run_command', conversationId: 7, callId: 'call-5' });
  assert.match(out, /⚠️ 全文未能存盘/);
  assert.match(out, /已省略 \d+ 字节/);
  assert.ok(out.includes('CCCC'), '降级路径仍保留预览');
});

test('readSpill 拒绝溢出目录之外的路径', () => {
  CLEAN();
  assert.throws(() => readSpill('/etc/passwd', 0, 100), /只能读取溢出目录内的文件/);
  assert.throws(() => readSpill(path.join(SPILL_DIR, '..', '..', 'etc', 'passwd'), 0, 100), /只能读取溢出目录内的文件/);
});

process.on('exit', CLEAN);
