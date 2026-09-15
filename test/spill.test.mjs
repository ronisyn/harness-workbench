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
const { spillToolResult, readSpill, SPILL_DIR, SPILL_BYTES } = await import('../server/tools/spill.js');

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
  const cn = '中'.repeat(12000); // 12000 字符 = 36000 字节 > 32768
  assert.ok(Buffer.byteLength(cn) > SPILL_BYTES);
  const out = spillToolResult(cn, 12000, { tool: 'extract_docx', conversationId: 7, callId: 'call-3' });
  assert.match(out, /全文已存/);
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
