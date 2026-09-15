// RA-08 部署态取证：读设置 + 按当前模型算折叠阈值来源
import { db } from 'file:///srv/harness-workbench/server/db.js';
import { effectiveCollapseChars } from 'file:///srv/harness-workbench/server/modelwindow.js';
const rows = await db.query("SELECT skey, svalue FROM settings WHERE skey LIKE 'collapse%' ORDER BY skey");
console.log('折叠相关设置: ' + rows.map((r) => r.skey + '=' + r.svalue).join(', '));
const model = (await db.query('SELECT model_id FROM usage_stats ORDER BY id DESC LIMIT 1'))[0];
const m = model ? model.model_id : 'deepseek-v4-flash';
for (const abs of [30000]) {
  const r = effectiveCollapseChars(m, abs, 0.15, null);
  console.log('模型 ' + m + ' → 触发阈值 ' + r.chars + ' 字符（来源=' + r.source + '，窗口=' + r.windowTokens + '）｜' + r.note);
}
process.exit(0);
