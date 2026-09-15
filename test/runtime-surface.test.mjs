// test/runtime-surface.test.mjs - v0.3 §4.1 运行面「**有版本号与变更说明**」的机检（"有版本号"那一半）
//
// 现状（本夹具要治的）：`package.json` 有 `version`，但**全仓零读取点**——对外形态
//   （MCP `initialize` 的 `serverInfo` / JSON-RPC `system.capabilities` / 启动日志）都不报版本，
//   客户机排障时"对面跑的是哪一版"只能靠猜（`/api/health` 也只回 ok/service/ts）。
// 判据（**单一出处**，不是"每处各写一份能对上"）：
//   ① `server/env.js` 的 `RW_VERSION` 必须**真的等于** `package.json` 的 `version`（改版本只改一个文件）；
//   ② 三处对外形态都转引它，而不是各写一个字面量：mcp-server 的 `SERVER_INFO.version`、
//      jsonrpc 的注册表方法表（`system.capabilities` 的握手块）、index.js 那一行启动日志的模板串；
//   ③ 读不到 `package.json` 时**如实**退回 '0.0.0'（不猜、不编），且不把进程带崩。
// 反面对照（不许放宽）：把 `version` 从 package.json 摘掉 ⇒ ① 的两端不再相等（本夹具红）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RW_VERSION, platformVersion } from '../server/env.js';
import { SERVER_INFO } from '../server/mcp-server.js';
import { METHODS, createRegistry } from '../server/jsonrpc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('① 版本号单一出处：RW_VERSION === package.json 的 version', () => {
  assert.equal(typeof PKG.version, 'string');
  assert.ok(PKG.version.trim().length, 'package.json 必须有非空 version（它是对外报的版本号的唯一出处）');
  assert.equal(RW_VERSION, PKG.version, 'RW_VERSION 必须由 package.json 的 version 而来（改版本只改这一个文件）');
  assert.equal(platformVersion(path.join(ROOT, 'package.json')), PKG.version, 'platformVersion() 读的就是它');
});

test('② 三处对外形态都转引 RW_VERSION，而不是各写一个字面量', (t) => {
  // ②-1 MCP 握手：serverInfo.version（客户端据它判断对面是哪一版 build）
  assert.equal(SERVER_INFO.version, RW_VERSION, 'MCP SERVER_INFO.version 必须＝平台版本');
  assert.equal(SERVER_INFO.name, 'rw-platform', '服务身份不变（只补版本，不改身份）');

  // ②-2 JSON-RPC 握手：方法表逐条带 version ⇒ 适配器把它摊平进 `system.capabilities` 的响应
  const backend = {
    'system.capabilities': async (a, ctx) => ({ server: 'x', methods: ctx.registry.face() }),
    'session.chat': async () => ({}), 'session.stop': async () => ({}), 'session.status': async () => ({}),
    'session.export': async () => ({}), 'session.activity': async () => ({}),
  };
  const registry = createRegistry(backend);
  const caps = registry.get('system.capabilities');
  assert.equal(caps.version, RW_VERSION, 'system.capabilities 必须报平台版本');
  assert.ok(caps.params && caps.params.type === 'object' && Array.isArray(caps.params.required),
    '补版本不得破坏既有的方法契约声明（params 参数表照旧）——否则夹具 test/jsonrpc.test.mjs 会红');
  for (const m of registry.face()) assert.equal(m.version, RW_VERSION, m.name + ' 的方法表条目必须带同一个版本');
  for (const m of METHODS) assert.equal(m.version, RW_VERSION, 'METHODS 里 ' + m.name + ' 的版本必须＝RW_VERSION（不是另写的字面量）');

  // ②-3 启动日志那一行：模板串里必须真的插值 RW_VERSION（**去掉注释再扫**，免得命中注释里的文字）
  const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
  assert.match(code('server/env.js'), /export const RW_VERSION = platformVersion\(\)/,
    'env.js 必须导出 RW_VERSION（派生于 platformVersion()，不另写字面量）');
  const logLine = code('server/index.js').split('\n').find((l) => l.includes('[RW] 环境:'));
  assert.ok(logLine, 'index.js 那一行环境日志不见了（本夹具的锚点失效——先修解析，别让它假装通过）');
  // 集成时已补齐这一处，因此这里是**硬断言**：谁把插值拿掉，夹具当场红（不再"如实跳过"）
  assert.match(logLine, /\$\{RW_VERSION\}/, '启动日志要插值 env.js 的 RW_VERSION，而不是写死版本号');
});

test('③ 读不到 package.json 时如实退回 0.0.0 并告警（不猜、不编、不崩）', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(platformVersion(path.join(ROOT, 'no-such-package-' + Date.now() + '.json')), '0.0.0',
      '读不到就必须如实报 0.0.0——编一个版本号比没有版本号更糟');
  } finally { console.warn = orig; }
  assert.equal(warns.length, 1, '必须留下一条告警（静默退回会把"我没读到"变成查不出来的事）');
  assert.match(warns[0], /读不到平台版本/);
});
