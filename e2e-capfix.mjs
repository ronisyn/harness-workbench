import { db } from '/srv/harness-workbench/server/db.js';
const BASE = 'http://127.0.0.1:880';
async function j(path, opts = {}) {
  const r = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = { raw: t.slice(0, 120) }; }
  return { status: r.status, b };
}
function chk(n, c, x) { console.log((c ? '[PASS] ' : '[FAIL] ') + n + (x !== undefined ? ' | ' + x : '')); if (!c) process.exitCode = 1; }
const lg = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.RW_ADMIN_USER, password: process.env.RW_ADMIN_PASS }) });
if (!lg.b.token) throw new Error('login failed');
const A = { Authorization: 'Bearer ' + lg.b.token };
// 1) capabilities 已移除 → 404/路由不存在
const cap = await j('/api/capabilities', { headers: A });
chk('1 capabilities 端点已移除(404)', cap.status === 404, 'status=' + cap.status);
// 2) toolset 真实字段
const ts = await j('/api/toolset', { headers: A });
const tools = ts.b.tools || [];
const first = tools[0] || {};
chk('2 toolset 人读字段(cn/when/tier/exempt)', tools.length > 20 && typeof first.cn === 'string' && first.cn.length > 0 && typeof first.when === 'string' && typeof first.platformExempt === 'boolean', 'n=' + tools.length + ' e.g.' + (first.cn || ''));
const ex = tools.find((t) => t.platformExempt);
chk('3 平台豁免工具恒开(勾选为真)', !!ex && ex.enabled === true, ex && (ex.cn + '=' + ex.enabled));
// 4) 分组导航 code 均可达
for (const p of ['/console/agent-caps', '/console/agent-evo', '/console/agent-dev', '/console/agent-apps', '/console/plugins', '/console/kb', '/console/settings', '/console/models-plaza']) {
  const r = await fetch(BASE + p, { headers: A });
  if (r.status !== 200) chk('route ' + p, false, 'status=' + r.status);
}
console.log('ROUTES OK');
// 5) capabilities 表已 DROP
const tbl = await db.query("SELECT COUNT(*) c FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='capabilities'");
chk('5 capabilities 表已清理', Number(tbl[0].c) === 0, 'rows=' + tbl[0].c);
process.exit(0);
