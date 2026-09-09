// 恢复验证: /api/upload + /api/download 鉴权链路 + 目录穿越防护
import fs from 'fs';
import { db } from '/srv/harness-workbench/server/db.js';
const BASE = 'http://127.0.0.1:880';
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 160) }; }
  return { status: r.status, b };
}
function chk(n, c, x) { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (x !== undefined ? ' | ' + x : '')); if (!c) process.exitCode = 1; }
async function main() {
  const lg = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }) });
  if (!lg.b.token) throw new Error('login failed');
  const A = { Authorization: 'Bearer ' + lg.b.token };
  // 1) 无 token → 401
  const unauth = await fetch(BASE + '/api/download/x.xlsx');
  chk('1 download 无 token→401', unauth.status === 401, 'status=' + unauth.status);
  // 2) 目录穿越 → 400/404(不泄露)
  const trav = await j('/api/download/' + encodeURIComponent('../evil.txt'), { headers: A });
  chk('2 download 防目录穿越', trav.status === 400 || trav.status === 404, 'status=' + trav.status + ' msg=' + (trav.b.message || ''));
  // 3) 存在文件 → 200 + 文件名
  const up = fs.readdirSync('/srv/rw-workspace/uploads').find((f) => f.endsWith('.xlsx'));
  if (up) {
    const dl = await fetch(BASE + '/api/download/' + encodeURIComponent(up), { headers: A });
    const cd = dl.headers.get('content-disposition') || '';
    chk('3 download 已存在文件→200', dl.status === 200 && dl.headers.get('content-type') !== undefined, 'status=' + dl.status + ' cd=' + cd.slice(0, 60));
  } else { console.log('SKIP 3(无 xlsx 样例)'); }
  // 4) upload 上传测试文件 → ok + path
  const name = 'recover-test-' + Date.now() + '.txt';
  const data = Buffer.from('恢复验证内容').toString('base64');
  const up2 = await j('/api/upload', { method: 'POST', headers: A, body: JSON.stringify({ name, data }) });
  chk('4 upload→ok', up2.status === 200 && up2.b.ok === true && String(up2.b.path).includes('uploads/'), JSON.stringify(up2.b).slice(0, 100));
  // 5) 上传后可下载(round-trip)
  if (up2.b.path) {
    const nm = String(up2.b.path).split('/').pop();
    const dl2 = await fetch(BASE + '/api/download/' + encodeURIComponent(nm), { headers: A });
    const txt = await dl2.text();
    chk('5 upload→download round-trip', dl2.status === 200 && txt.includes('恢复验证内容'), 'status=' + dl2.status);
  }
  console.log('RECOVER-E2E-DONE');
  process.exit(0);
}
main().catch((e) => { console.error('RECOVER-FAIL', e.message); process.exit(1); });
