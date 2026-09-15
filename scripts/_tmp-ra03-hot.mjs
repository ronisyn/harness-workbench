// RA-03 验收：清单热重载——改 tools/manifest.js 后**不重启服务**，工具面即时变化（走 /api/toolset 实读运行进程）
import fs from 'node:fs';
const FILE = '/srv/harness-workbench/server/tools/manifest.js';
const BASE = 'http://127.0.0.1:880';
const lg = await (await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }), signal: AbortSignal.timeout(20000) })).json();
const H = { Authorization: 'Bearer ' + lg.token, 'Content-Type': 'application/json' };
const tools = async () => {
  const r = await (await fetch(BASE + '/api/toolset', { headers: H, signal: AbortSignal.timeout(20000) })).json();
  const list = (r.tools || []).map((t) => t.name);
  return { n: list.length, hasRepo: list.includes('repo_map') };
};
const toggle = (on) => {
  let s = fs.readFileSync(FILE, 'utf8');
  const before = s;
  s = on ? s.replace(/^  \/\/ repo_map:/m, '  repo_map:') : s.replace(/^  repo_map:/m, '  // repo_map:');
  if (s === before) throw new Error('未命中 repo_map 行（on=' + on + '）');
  fs.writeFileSync(FILE, s);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('对照组（改前）：' + JSON.stringify(await tools()));
toggle(false);
await wait(2500);
console.log('注释掉 repo_map 一行后（未重启）：' + JSON.stringify(await tools()));
toggle(true);
await wait(2500);
console.log('还原后（未重启）：' + JSON.stringify(await tools()));
process.exit(0);
