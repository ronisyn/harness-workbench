// 步8 门禁自证：对三条不变式各注入一次故障，确认门禁**真的会报红**（运行后立即还原）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CASES = [
  {
    id: '① 只追加',
    file: 'server/prefix.js',
    patch: (s) => s.replace('  if (!prev) return null;', '  if (!prev || true) return null; // 注入故障：永远认为只追加'),
    expect: /① 故意破坏：就地改写/,
  },
  {
    id: '② fail-closed',
    file: 'server/tools/hooks.js',
    // 把 run_command 安全网（danger_command_guard）的 failClosed 改成 false —— 门禁必须因此报红
    patch: (s) => s.replace(/(registerHook\('before', 'run_command', 'danger_command_guard'[\s\S]{0,1200}?failClosed: )true/, '$1false'),
    expect: /必须 fail-closed/,
  },
  {
    id: '③ 工具面冻结',
    file: 'server/tools/index.js',
    patch: (s) => s.replace('  const rank = Math.min(convRank, shRank); // 更严者', '  const rank = 2; // 注入故障：档位裁剪失效（standard 与 all 同面）'),
    expect: /裁剪档位不同必须得出不同哈希/,
  },
];

const results = [];
for (const c of CASES) {
  const src = fs.readFileSync(c.file, 'utf8');
  const patched = c.patch(src);
  if (!patched || patched === src) { results.push([c.id, 'MISS 注入未生效（锚点未命中）']); continue; }
  fs.writeFileSync(c.file, patched);
  let out = '';
  try {
    out = execFileSync('node', ['--test', 'test/invariants.test.mjs'], { encoding: 'utf8' });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  fs.writeFileSync(c.file, src); // 立即还原
  const red = /# fail [1-9]/.test(out);
  const matched = c.expect.test(out);
  results.push([c.id, (red && matched ? '✅ 报红' : '❌ 未报红') + '（fail 行=' + (/# fail (\d+)/.exec(out) || [0, '?'])[1] + '，命中预期断言=' + matched + '）']);
}
console.log('注入故障 → 门禁反应：');
for (const [id, r] of results) console.log('  ' + id + ': ' + r);
// 还原后必须全绿
const after = execFileSync('node', ['--test', 'test/invariants.test.mjs'], { encoding: 'utf8' });
console.log('还原后：' + (/^# (pass|fail) \d+$/gm.exec(after) ? after.match(/^# (?:pass|fail) \d+$/gm).join(' / ') : '（未取到）'));
process.exit(0);
