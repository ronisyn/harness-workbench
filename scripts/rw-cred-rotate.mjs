#!/usr/bin/env node
// scripts/rw-cred-rotate.mjs —— 凭据轮换的命令行入口（v0.3 §4.6「客户系统凭证的存放、引用、**轮换**」）
//
// 用法（在平台目录里跑）：
//   RW_CRED_VALUE='新值' node scripts/rw-cred-rotate.mjs --name GITHUB_PERSONAL_ACCESS_TOKEN
//   printf '%s' "$NEW_TOKEN" | node scripts/rw-cred-rotate.mjs --name GITHUB_PERSONAL_ACCESS_TOKEN
//   node scripts/rw-cred-rotate.mjs --help
//
// 为什么**值绝不走命令行参数**：argv 会进 shell 历史（`~/.bash_history`）、进 `ps`/任务管理器的进程命令行，
// 而这两处都不是我们能脱敏的出口——一旦进去，轮换就等于换了把钥匙又把旧钥匙贴在门上。所以只有两条来源：
// 环境变量 `RW_CRED_VALUE` 或 stdin（管道）；两者都没有、stdin 又是交互式终端时**直接拒绝**，不让人当场敲。
// 为什么输出里只有 name/updatedAt/fingerprint：指纹是"换没换"的可核对凭据（见 credentials.js 的 secretFingerprint），
// 入口不该、也无法打印新值——它连看都不看第二眼。
import { pool, db } from '../server/db.js';
import { rotateSecret, describeSecret, credentialsFile, CRED_PREFIX } from '../server/credentials.js';

const USAGE = [
  '用法：RW_CRED_VALUE=<新值> node scripts/rw-cred-rotate.mjs --name <凭据名>',
  '      printf \'%s\' "<新值>" | node scripts/rw-cred-rotate.mjs --name <凭据名>',
  '说明：新值只从环境变量 RW_CRED_VALUE 或 stdin 读——**不接受任何值参数**（argv 会进 shell 历史与 ps）。',
].join('\n');

/** 用法错误（与"轮换失败"分开：一个是没跑起来，一个是跑了没成） */
class UsageError extends Error {}

/**
 * 默认的 stdin 读法。**交互式终端下拒绝**：让人当场敲明文，既会留在终端回显里，
 * 也没有"再确认一次"的机会；管道/重定向才是这条路的用法。
 * （不导出：它是 main 的缺省实现，夹具注入自己的 readStdin 走同一条路。）
 */
async function readStdinValue() {
  if (process.stdin.isTTY) throw new UsageError('stdin 是交互式终端：请用 RW_CRED_VALUE，或把值用管道送进来');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 解析参数。除 `--name` 外**只认 --help**；其余一律报用法错误——这同时挡住了"顺手写了 --value=xxx"，
 * 那种写法泄漏在 argv 里，必须当场拦下而不是默默接受。
 * @returns {{help:boolean, name:string|null}}
 */
function parseArgs(argv) {
  let name = null; let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { help = true; continue; }
    if (a === '--name') { name = argv[++i] || null; continue; }
    if (a.startsWith('--name=')) { name = a.slice('--name='.length) || null; continue; }
    throw new UsageError('不认识的参数：' + a + '（值只从 RW_CRED_VALUE 或 stdin 读，命令行参数会进 shell 历史与 ps）');
  }
  return { help, name };
}

/** 只剥掉一个行尾换行（`printf '%s'` 没有、`echo` 有）：不能 trim——值里的前后空格是值的一部分。 */
const stripOneNewline = (s) => String(s).replace(/\r?\n$/, '');

/**
 * 跑一次轮换。可注入（argv/env/stdin/db/log）——夹具据此在不碰真终端、不连真库的情况下验全程。
 * @returns {Promise<{exitCode:number, result?:{name:string, updatedAt:string, fingerprint:string}}>}
 */
export async function main({ db: database = db, log = console, argv = process.argv.slice(2), env = process.env, readStdin = readStdinValue } = {}) {
  const { help, name } = parseArgs(argv);
  if (help) { log.log(USAGE); return { exitCode: 0 }; }
  if (!name) throw new UsageError('缺少 --name');
  const fromEnv = env.RW_CRED_VALUE;
  const value = (fromEnv !== undefined && fromEnv !== '') ? fromEnv : stripOneNewline(await readStdin());
  if (!value) throw new UsageError('没读到新值（RW_CRED_VALUE 为空且 stdin 没送出内容）——空值不是"已配置的密钥"');
  log.log('[cred] 凭据文档：' + credentialsFile());
  const r = await rotateSecret(name, value, { db: database });
  // 只报"它知道的事"：新值已落文档、指纹是多少。**不替落账宣布成功**——落账失败由 credentials.js 自己出声
  // （那行以 `[cred] 轮换落账失败` 开头）；入口抢着说"审计已落账"，正是在制造一条没人能核对的断言。
  log.log('[cred] 已轮换：' + r.name + '  updatedAt=' + r.updatedAt + '  fingerprint=' + r.fingerprint);
  const st = describeSecret(r.name);
  log.log('[cred] 复核：configured=' + st.configured + ' source=' + st.source + ' writable=' + st.writable
    + '（配置里存的仍是引用 ' + CRED_PREFIX + r.name + '，值只在凭据文档里）');
  return { exitCode: 0, result: r };
}

// 直接执行才跑（被夹具 import 时不跑）
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/rw-cred-rotate.mjs')) {
  let code = 1;
  try {
    code = (await main()).exitCode;
  } catch (e) {
    // 用法错误报用法（exit 2），轮换失败如实报原因（exit 1，**旧值一个字没动**）
    console.error((e instanceof UsageError ? '' : '[' + (e.name || 'Error') + '] ') + e.message);
    if (e instanceof UsageError) console.error(USAGE);
    code = e instanceof UsageError ? 2 : 1;
  } finally {
    try { await pool.end(); } catch { /* 收尾失败不改判上面那个退出码 */ }
  }
  process.exitCode = code;
}
