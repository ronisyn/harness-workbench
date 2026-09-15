// test/no-sync-subprocess.test.mjs - 请求路径上禁止同步子进程（2026-09-15）
//
// 为什么要有这条：`execFileSync/execSync/spawnSync` 会**冻住整个 Node 进程**——不是冻住一个请求，
// 而是所有会话的 SSE 流、心跳、别的用户一起停摆。今天在 server/ 里抓到三处真问题：
//   ① tools/hooks.js 的语法检查钩子（挂在 write_file/edit_file 的 after 上，**agent 写代码的必经之路**，超时 8s）
//   ② index.js 的模板 git 同步（`git push` 是网络操作，超时 60s）
//   ③ runtrack.js 的 git 状态摘要（三条命令各 3s，在 /api/chat 请求路径上）
// 三处都已改成异步。这条夹具是"边界由机器强制"的落点（学 CD 的编译期约束、DSH 的强制声明小节）：
// **以后谁再往 server/ 里加同步子进程，CI 直接报红**，附上正确写法。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAD = /\b(execSync|execFileSync|spawnSync)\s*\(/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('server/ 里不得出现同步子进程调用（会冻住整个进程，不是只冻一个请求）', () => {
  const hits = [];
  for (const f of walk(path.join(ROOT, 'server'))) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (BAD.test(line)) hits.push(path.relative(ROOT, f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 100));
    });
  }
  assert.deepEqual(hits, [],
    '同步子进程会冻住整个 Node 进程（所有会话一起卡）。正确写法：\n'
    + "  import { execFile } from 'node:child_process'; import { promisify } from 'node:util';\n"
    + '  const run = promisify(execFile); await run(cmd, args, { timeout: 6000 });\n'
    + '命中处：\n' + hits.join('\n'));
});

test('正例（反向核对）：三处历史问题确实已改成异步 —— 不只看"没命中"，还要看"改对了"', () => {
  const hooks = fs.readFileSync(path.join(ROOT, 'server/tools/hooks.js'), 'utf8');
  assert.match(hooks, /await execFileAsync\('node', \['--check'/, '语法检查钩子必须 await 异步执行');
  assert.match(hooks, /timeoutMs: 8000/, '钩子超时要 ≥ 内层命令超时，否则永远走不到命令自己超时');
  const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(idx, /await run\('git', \['push', 'origin', 'main'\]/, '模板同步的 git push 必须 await');
  const rt = fs.readFileSync(path.join(ROOT, 'server/runtrack.js'), 'utf8');
  assert.match(rt, /await gitStateSummary\(\)/, 'resumeHint 里必须 await（否则拿到的是 Promise）');
});
