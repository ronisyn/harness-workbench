// server/epoch.js - M2「换纪元」检测与一次预热（2026-09-15）
//
// ── 为什么需要它（实测，不是推测）──────────────────────────────────────────────
// 前缀缓存按**逐字节前缀**匹配。会话 185 每天 05:00 复用同一会话跑一次，十天里空闲时长恒为
// 23.9~24.0 小时，唯一变量是"这一轮的前缀和上一轮是不是同一串字节"：
//   没变 ⇒ 首轮未命中 ≤142（1.0%）；变了 ⇒ 未命中 ≥8,964（92.8%），其中 09-09 只差 **+46 个 token**。
// 9/9 与"前缀变没变"完全一致，与空闲时长完全无关 —— 且受控实验证明 30 分钟空闲后前缀**完好无损**。
// ⇒ 冷启动不是"缓存过期"，是**我们改了前缀面**（每次部署动到 ENV_MAP / 工具面 = 换纪元）。
//   而换纪元的影响是**全局**的：所有会话的下一次请求都要整段重建那 ~10.5k 的公共前缀。
//
// ── 本模块做什么 ──────────────────────────────────────────────────────────────
// 1. 启动时按泳道比对纪元键（system 提示 + 工具面指纹），变了就落 `prefix:epoch-change` 账本；
// 2. 对变化的泳道**立刻预热一次**：发一个只带固定前缀、只要 1~2 个输出 token 的最小请求，
//    把新纪元的前缀打热 —— 而不是让接下来第一个真实用户/定时任务替我们承担整段重建。
// 3. 预热本身也入账（kind='warmup'），所以"预热有没有用、花了多少"都可查，不是黑账。
//
// ── 边界（如实说明，别当成全覆盖）──────────────────────────────────────────────
// · 只覆盖 **preset 基准工具面**（`toolDefs(preset, null, null)`）。被"启用集收窄 / 壳 schema 裁剪"
//   的会话，其工具面与基准不同 ⇒ 预热对它无效（这类会话的指纹仍会逐轮落库，可查但未预热）。
// · 泳道 = (permission, preset)：身份层随 permission 变，所以不同 permission 是**不同前缀**，必须分开预热。
// · 只预热"近 7 天真实用过"的泳道（见 lanesInUse），不给没人用的组合白花钱。
// · 预热失败绝不影响启动（全部 try/catch，只打日志 + 落账）。
import { db } from './db.js';
import { prefixHash, epochKey, laneKey, isEpochChange, needsWarm } from './prefix.js';
import { buildEnvFor, lightDefs } from './agent.js';
import { toolDefs } from './tools/index.js';
import { chatOnceWithTools } from './llm/gateway.js';
import { config } from './config.js';
import { REAL_WHERE } from './cohort.js';

const SETTINGS_PREFIX = 'prefix_epoch:';

/** 工具面的两种形态 —— 与 agent.js 里的 `defs` 表达式必须逐字节一致（那是唯一判据）。 */
export const FACES = [
  { light: false, name: '全量面', defs: (preset) => toolDefs(preset, null, null) },
  // 轻量面：agent.js 的 lightDefs() 忽略 preset（固定按 all 档取再按 LIGHT_TOOLSET 裁）
  { light: true, name: '轻量面', defs: () => lightDefs() },
];

/**
 * 某泳道 × 某工具面的当前纪元信息。纯计算（不碰 DB），便于测试与复用。
 * @returns {{lane:string, permission:string, preset:string, light:boolean, env:string, defs:object[], sysHash:string, toolsHash:string, key:string}}
 */
export function laneEpoch(permission = 'full', preset = 'all', light = false) {
  const env = buildEnvFor(permission);
  const face = FACES.find((f) => f.light === !!light) || FACES[0];
  const defs = face.defs(preset);
  const sysHash = prefixHash(env);
  const toolsHash = prefixHash(JSON.stringify(defs));
  return { lane: laneKey(permission, preset, light), permission, preset, light: !!light, env, defs, sysHash, toolsHash, key: epochKey(env, toolsHash) };
}

/**
 * 近 7 天真实用过的泳道（按真实流量口径，探针/孤儿不计）。
 * 查不到就回退到默认泳道 —— 冷启动的第一天也有得预热。
 */
export async function lanesInUse(days = 7) {
  try {
    const rows = await db.query(
      `SELECT c.permission p, c.preset pre, COUNT(*) n
         FROM usage_stats u JOIN conversations c ON c.id = u.conversation_id
        WHERE u.kind='round' AND u.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND (${REAL_WHERE('u')})
        GROUP BY c.permission, c.preset ORDER BY n DESC LIMIT 6`, [days]);
    const lanes = rows.filter((r) => r && r.p).map((r) => ({ permission: String(r.p), preset: String(r.pre || 'all') }));
    return lanes.length ? lanes : [{ permission: 'read', preset: 'all' }];
  } catch {
    return [{ permission: 'read', preset: 'all' }];
  }
}

/** 读上一次记录的纪元键（无记录 = 首次，不算变更）。
 *  ⚠️ `settings.svalue` 是 **JSON 列**：写入必须 `JSON.stringify`，否则 12 位十六进制串会被 MySQL 判成
 *  非法 JSON 直接报错（实测踩到："Invalid JSON text ... at position 2"）。读取时 mysql2 已把 JSON 解回 JS 值。 */
async function readPrev(lane) {
  try {
    const r = await db.query('SELECT svalue FROM settings WHERE skey=?', [SETTINGS_PREFIX + lane]);
    if (!r || !r[0] || r[0].svalue == null) return null;
    return String(r[0].svalue);
  } catch { return null; }
}

/** 写下本次纪元键（幂等 upsert；值按 JSON 列要求编码）。 */
async function writePrev(lane, keyV) {
  try {
    await db.query('INSERT INTO settings (skey, svalue, updated_at) VALUES (?,CAST(? AS JSON),NOW()) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_at=NOW()',
      [SETTINGS_PREFIX + lane, JSON.stringify(String(keyV))]);
  } catch (e) { console.warn('[epoch] 纪元键写入失败 ' + lane + ': ' + e.message); }
}

/**
 * 预热一条泳道：发一个"只带固定前缀"的最小请求。
 * 请求体 = [system: 与真实请求逐字节相同的 ENV][user: 一句话]，tools = 该泳道基准工具面。
 * 共享前缀 = [tools][system] —— 正是跨会话那段 ~10.5k，也正是冷启动最贵的部分。
 * 计费：命中则几乎免费（实测 ~¥0.002），未命中则付一次前缀重建价（这正是我们要提前付掉的那笔）。
 */
export async function warmLane(lane, { provider = 'deepseek', model = 'deepseek-v4-flash' } = {}) {
  const e = laneEpoch(lane.permission, lane.preset, lane.light);
  const t0 = Date.now();
  try {
    const r = await chatOnceWithTools(provider, model,
      [{ role: 'system', content: e.env }, { role: 'user', content: '缓存预热：只回复 ok' }],
      e.defs, config.keys, 0);
    const u = r.usage || {};
    const hit = Number(u.cache_hit || 0), miss = Number(u.cache_miss != null ? u.cache_miss : 0);
    // 入账 kind='warmup'：**不进任何 cohort**（REAL/PROBE 档都按 kind='round' 过滤），也不冒充真实轮次
    try {
      await db.query(`INSERT INTO usage_stats (account_id, conversation_id, agent_run_id, provider_id, model_id,
                       tokens_in, tokens_out, cache_hit_tokens, cache_miss_tokens, cost, duration_ms, created_at, kind, shell_id,
                       prefix_sys_hash, prefix_tools_hash)
                     VALUES (NULL,NULL,NULL,?,?,?,?,?,?,0,?,NOW(),"warmup",NULL,?,?)`,
        [provider, model, u.tokens_in || 0, u.tokens_out || 0, hit, miss, Date.now() - t0, e.sysHash, e.toolsHash]);
    } catch { /* 计量失败不影响预热 */ }
    const note = `lane=${e.lane} sys=${e.sysHash} tools=${e.toolsHash} nTools=${e.defs.length} hit=${hit} miss=${miss} ms=${Date.now() - t0}`;
    db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [null, 'prefix:warmup', note]).catch(() => {});
    console.log('[epoch] 预热完成 ' + note + (miss > 8000 ? '（本次未命中=新纪元首次重建，属预期）' : '（命中，几乎免费）'));
    return { ok: true, lane: e.lane, hit, miss, sysHash: e.sysHash, toolsHash: e.toolsHash };
  } catch (err) {
    const msg = String((err && err.message) || err).slice(0, 200);
    console.warn('[epoch] 预热失败 lane=' + e.lane + '：' + msg);
    db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)', [null, 'prefix:warmup-fail', 'lane=' + e.lane + ' err=' + msg]).catch(() => {});
    return { ok: false, lane: e.lane, error: msg };
  }
}

/**
 * 启动入口：检测换纪元 → 落账本 → 预热变化过的泳道。
 * 每个泳道会检查**两种工具面**（全量面 / 轻量面）—— `light` 是按每条消息内容算的，
 * 所以同一个泳道随时可能以两种前缀出现，只预热一种等于漏掉一半真实请求。
 * 全程只读 + 每条变化的面各一次最小预热；任何一步失败都不抛（启动不该被观测功能拖垮）。
 * @returns {Promise<{checked:number, changed:Array, warm:Array}>}
 */
export async function checkEpochAndWarm({ provider = 'deepseek', model = 'deepseek-v4-flash', lanes = null } = {}) {
  const out = { checked: 0, changed: [], warm: [] };
  let list = lanes;
  if (!list) { try { list = await lanesInUse(); } catch { list = [{ permission: 'read', preset: 'all' }]; } }
  for (const lane of list) {
    for (const face of FACES) {
      try {
        const e = laneEpoch(lane.permission, lane.preset, face.light);
        const prev = await readPrev(e.lane);
        out.checked++;
        if (isEpochChange(prev, e.key)) {
          out.changed.push({ lane: e.lane, prev, cur: e.key, sysHash: e.sysHash, toolsHash: e.toolsHash, nTools: e.defs.length });
          console.warn('[epoch] 换纪元：' + e.lane + '（' + face.name + '，工具 ' + e.defs.length + ' 个）' + prev + ' → ' + e.key
            + '　前缀面变了 ⇒ 该面前缀作废；已发一次预热，别让真实用户承担这笔重建');
          // 账本里带上工具数与面名：MCP 是 `npx -y` 拉的（工具清单随外部包版本漂移），
          // 而轻量面/全量面会随会话消息内容切换 —— 这两件事都是"换纪元"的常见来源。
          db.query('INSERT INTO audit_log (account_id, action, detail) VALUES (?,?,?)',
            [null, 'prefix:epoch-change', `lane=${e.lane} face=${face.name} ${prev}→${e.key} sys=${e.sysHash} tools=${e.toolsHash} nTools=${e.defs.length}`]).catch(() => {});
        }
        await writePrev(e.lane, e.key);
        // 预热条件比"变更"宽一档：**没有记录也要预热**（我们从没为这个面做过保温，它多半是冷的）。
        // 但"没变化"绝不预热 —— 否则每次重启都白花钱（实测第二次重启：零调用）。
        if (needsWarm(prev, e.key)) out.warm.push(await warmLane({ permission: lane.permission, preset: lane.preset, light: face.light }, { provider, model }));
      } catch (err) {
        console.warn('[epoch] 检查失败 lane=' + JSON.stringify(lane) + ' light=' + face.light + '：' + String((err && err.message) || err).slice(0, 160));
      }
    }
  }
  // 日志如实区分三态（此前只按 changed 判，会出现"报了预热完成、却仍打印'未产生任何调用'"的自相矛盾）：
  //   · 有换纪元 → 上面每条已经各自报过；这里不重复
  //   · 没换纪元但有首次记录的面 → 说清是"补齐新面"，别让人以为是白跑
  //   · 两者都没有 → 才是真正的零调用
  if (!out.changed.length && !out.warm.length) console.log('[epoch] 前缀面无变化（已核对 ' + out.checked + ' 条泳道×面，未产生任何调用）');
  else if (!out.changed.length) console.log('[epoch] 无换纪元，但补齐了 ' + out.warm.length + ' 个从未记录过的面（已各预热一次；已核对 ' + out.checked + ' 条泳道×面）');
  return out;
}
