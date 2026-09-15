// scripts/migrate-c18.mjs - C-18 迁移：把 settings.mcp_servers[].env 里的明文密钥搬进凭据文档
//
// 跑法（部署机上，平台目录里）：`node scripts/migrate-c18.mjs`
// 幂等：跑第二遍只会"把已就位的引用写回"，不再搬任何明文。
// 失败不破坏现状：任何一步抛错都不写 settings（现有连接照旧，兼容读取还在）。
//
// 输出里**只有名字与计数，没有任何值**——迁移日志本身就是一条容易泄漏的出口。
import { db } from '../server/db.js';
import { migrateMcpSecrets, credentialsFile, redactSummary, listSecretNames, readMcpConfig } from '../server/credentials.js';

export async function main({ db: database = db, log = console } = {}) {
  const file = credentialsFile();
  log.log('[c18] 凭据文档：' + file);
  const r = await migrateMcpSecrets(database);
  log.log('[c18] 已搬入：' + (r.migrated.length ? r.migrated.join(', ') : '（无）'));
  log.log('[c18] 跳过（已是引用/已在文档里）：' + (r.skipped.length ? r.skipped.join(', ') : '（无）'));
  for (const f of r.failed) log.error('[c18] 失败：' + f.name + ' -> ' + f.error);
  log.log('[c18] settings 已改写为引用：' + (r.applied ? '是' : '否（无可搬项）'));
  log.log('[c18] 文档现有凭据名：' + (listSecretNames().join(', ') || '（空）'));
  // 复核：迁移**之后**配置里的引用都解析得到（只有名字与状态，没有值）
  const sum = redactSummary(await readMcpConfig(database));
  log.log('[c18] 复核摘要：' + JSON.stringify(sum));
  if (sum.missing.length) log.error('[c18] 仍未配置的凭据：' + sum.missing.join(', ') + '（MCP 会如实报"缺少凭据"而不是静默降级）');
  if (r.failed.length) {
    log.error('[c18] 有失败项 ⇒ settings 未改写，现状未被破坏。修掉原因后重跑本脚本即可（幂等）。');
    return { ...r, exitCode: 1 };
  }
  log.log('[c18] 完成。别忘了：①轮换曾明文入库的那把 GitHub PAT；②确认 ' + file + ' 权限为 600 且未进版本库。');
  return { ...r, exitCode: 0 };
}

// 直接执行才跑（被夹具 import 时不跑）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/migrate-c18.mjs')) {
  main().then((r) => process.exit(r.exitCode)).catch((e) => { console.error('[c18] 迁移失败：' + ((e && e.message) || e)); process.exit(1); });
}
