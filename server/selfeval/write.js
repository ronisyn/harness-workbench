// server/selfeval/write.js —— ㉓ 的**落库**那一半：提案 → `extension_demands`（待审）或 `evo_goals`
//
// ── 为什么把落库单独放一个文件 ────────────────────────────────────────────────────────────
// ① 铁律需要一个**唯一**的写入口，好被夹具锁住（grep 这一处就能证明"没有别的路径会写库"）；
// ② `propose.js` 保持纯函数（不碰库），dry-run 才能真正只读；
// ③ 表结构要给"只允许这两张表"留下一个显式的白名单，而不是散在调用点。
//
// ── 表结构核对（2026-09-16 读 `server/db.js`，本轮**不改表**）────────────────────────────
//   · `extension_demands`（db.js:547-556）：asset_key/kind/source/content/status/create_at。
//     `kind` 注释枚举＝ hard|soft|manual（`server/index.js:2630` 同口径）；`status` 默认 '待审'，
//     枚举＝ 待审|采纳|驳回|升级（`server/index.js:2564`）。**没有**唯一约束、没有指纹列。
//   · `evo_goals`（db.js:490-498）：account_id/name/descr/status('active'|'paused')/created_at/updated_at。
//     account_id **NOT NULL**（`server/index.js:1968` 按账号过滤）。**没有**唯一约束。
//   ⇒ 两张表都没有唯一约束可利用 ⇒ 幂等只能靠"内容指纹 + 写入前 EXISTS 查一次"，
//     指纹以 `fprint:<16 位>` 写进内容里（`extension_demands.content` / `evo_goals.descr`），
//     顺带让人在审批台上也能看见"这两条是不是同一件事"。
import { config } from '../config.js';
import { db } from '../db.js';
import { checkIronLaw, renderDemandContent, renderGoal, SOURCE_CN, fingerprintMark } from './propose.js';

/**
 * **唯一**允许本模块写入的表（v0.3 §0.4 铁律：产出物只落提案载体，不落代码、不落新表）。
 * 任何别的表名一律拒绝——包括"顺手记一条审计"这种看起来无害的动作（审计由平台的既有入口写）。
 */
export const WRITABLE_TABLES = Object.freeze(['extension_demands', 'evo_goals']);

/** 表名白名单检查（也当 SQL 注入闸门：表名是拼进 SQL 的，不允许来自自由文本） */
export function assertWritableTable(table) {
  if (!WRITABLE_TABLES.includes(table)) {
    throw new Error(`拒绝写入表「${table}」：v0.3 §0.4 铁律只允许写 ${WRITABLE_TABLES.join(' / ')}（提案载体）`);
  }
  return table;
}

/**
 * 解析目标账号：`evo_goals.account_id` 是 NOT NULL，CLI 下没有登录态，得显式指定。
 * 未指定时回落到配置里的管理员账号（`config.admin.user`，与 `server/index.js:2860` 的种子口径同源）。
 */
export async function resolveAccountId({ dbc = db, accountId = null } = {}) {
  if (Number.isInteger(accountId) && accountId > 0) return Number(accountId);
  const rows = await dbc.query('SELECT id FROM accounts WHERE username=? LIMIT 1', [config.admin.user]);
  const id = rows && rows[0] && Number(rows[0].id);
  if (!id) throw new Error(`解析账号失败：accounts 里找不到 username=${config.admin.user}；请用 --account <id> 显式指定（evo_goals.account_id 为 NOT NULL）`);
  return id;
}

/** 幂等检查：同批次同一条提案是否已经落过（按**与渲染同一个函数**产出的指纹标记查，见 C-71） */
export async function findExisting({ dbc = db, proposal } = {}) {
  const like = `%${fingerprintMark(proposal.fingerprint)}%`;
  const [demand] = await dbc.query('SELECT id, status FROM extension_demands WHERE content LIKE ? LIMIT 1', [like]);
  if (demand) return { table: 'extension_demands', id: demand.id, status: demand.status, fingerprint: proposal.fingerprint };
  const [goal] = await dbc.query('SELECT id, status FROM evo_goals WHERE descr LIKE ? LIMIT 1', [like]);
  if (goal) return { table: 'evo_goals', id: goal.id, status: goal.status, fingerprint: proposal.fingerprint };
  return null;
}

/**
 * 落一条提案（幂等：已存在则跳过）。
 * @returns {Promise<{action:'created'|'skipped-duplicate', table:string, id?:number}>}
 * @throws 铁律/必填不合格、表名不在白名单、account 解析失败
 */
export async function writeProposal(proposal, { dbc = db, accountId = null } = {}) {
  // ① 铁律 + 必填：缺"验证方式"或出现"自动提交"字样，一律拒（夹具锁这条）
  const chk = checkIronLaw(proposal);
  if (!chk.ok) {
    const why = [...chk.missing.map((f) => `缺必填字段 ${f}`), ...chk.violations].join('；');
    throw new Error(`提案不合格，拒绝落库：${proposal && proposal.title ? proposal.title + ' → ' : ''}${why}`);
  }
  const table = assertWritableTable(proposal.route.table);
  // ② 幂等
  const dup = await findExisting({ dbc, proposal });
  if (dup) return { action: 'skipped-duplicate', table: dup.table, id: dup.id, status: dup.status };

  // ③ 落库（两张表各自的形状）
  if (table === 'extension_demands') {
    const content = renderDemandContent(proposal);
    const r = await dbc.query(
      'INSERT INTO extension_demands (asset_key, kind, source, content) VALUES (?,?,?,?)',
      [null, proposal.kind || 'manual', String(`自我体检/采集(${SOURCE_CN[proposal.source] || proposal.source})`).slice(0, 24), content.slice(0, 2000)]);
    // status 走表默认 '待审'（`server/db.js:553`）——**不显式写**，免得哪天默认值变了这里变成第二个事实源
    return { action: 'created', table, id: r.insertId, status: '待审' };
  }
  const goal = renderGoal(proposal);
  const aid = await resolveAccountId({ dbc, accountId });
  const r = await dbc.query('INSERT INTO evo_goals (account_id, name, descr) VALUES (?,?,?)', [aid, goal.name, goal.descr]);
  return { action: 'created', table, id: r.insertId, status: 'active' };
}

/** 批量落库（逐条 try/catch：一条不合格不许拖垮整批，但**必须如实报告**） */
export async function writeProposals(proposals, { dbc = db, accountId = null } = {}) {
  const out = { created: [], skipped: [], failed: [] };
  for (const p of proposals || []) {
    try {
      const r = await writeProposal(p, { dbc, accountId });
      if (r.action === 'created') out.created.push({ id: r.id, table: r.table, title: p.title });
      else out.skipped.push({ id: r.id, table: r.table, title: p.title });
    } catch (e) {
      out.failed.push({ title: p && p.title, error: String((e && e.message) || e) });
    }
  }
  return out;
}
