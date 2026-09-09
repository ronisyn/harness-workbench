// server/shellstore.js - B1 壳库：import/clone/list/get（基于 db + shells 纯函数）
// 依据：总方案 §5.1/§9（旧编号 v2.6 §3/§8，2026-09-10 治理改指）；文件 pack.json 为权威、DB 为运行态镜像（双写原则 §5.2）。
import { db } from './db.js';
import { validatePack, packToRow, rowToPack, isKeyOk, SHELL_DEFAULT_KEY } from './shells.js';

export async function listShells() {
  return db.query('SELECT id, skey, name, description, status, created_at, updated_at FROM shells ORDER BY id');
}

export async function getShellByKey(key) {
  return (await db.query('SELECT * FROM shells WHERE skey=?', [String(key)]))[0] || null;
}

// pack import（upsert by key）：校验 → 写壳行 → 重建三态工具行（force_on/off）
export async function importShell(pack) {
  const v = validatePack(pack);
  if (!v.ok) throw new Error('pack 校验失败: ' + v.errors.join('; '));
  const row = packToRow(pack);
  const existing = await getShellByKey(row.skey);
  if (existing) {
    await db.query(
      `UPDATE shells SET name=?, description=?, persona=?, domain_text=?, model_policy=?, tools_preset=?, tools_force_on=?, tools_force_off=?, knowledge_scopes=?, skills_allow=?, guardrails=?, channels=?, ui_brand=?, pack_extra=?, eval_ref=?, intent_rules=?, task_profiles=?, updated_at=NOW() WHERE id=?`,
      [row.name, row.description, row.persona, row.domain_text, row.model_policy, row.tools_preset,
        row.tools_force_on, row.tools_force_off, row.knowledge_scopes, row.skills_allow, row.guardrails,
        row.channels, row.ui_brand, row.pack_extra, row.eval_ref, row.intent_rules, row.task_profiles, existing.id]
    );
    const id = existing.id;
    await replaceTools(id, row);
    return { id, key: row.skey, mode: 'updated' };
  }
  const r = await db.query(
    `INSERT INTO shells (skey, name, description, persona, domain_text, model_policy, tools_preset, tools_force_on, tools_force_off, knowledge_scopes, skills_allow, guardrails, channels, ui_brand, pack_extra, eval_ref, intent_rules, task_profiles, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [row.skey, row.name, row.description, row.persona, row.domain_text, row.model_policy, row.tools_preset,
      row.tools_force_on, row.tools_force_off, row.knowledge_scopes, row.skills_allow, row.guardrails,
      row.channels, row.ui_brand, row.pack_extra, row.eval_ref, row.intent_rules, row.task_profiles, 'enabled']
  );
  await replaceTools(r.insertId, row);
  return { id: r.insertId, key: row.skey, mode: 'created' };
}

async function replaceTools(shellId, row) {
  const on = (() => { try { return JSON.parse(row.tools_force_on || '[]'); } catch { return []; } })();
  const off = (() => { try { return JSON.parse(row.tools_force_off || '[]'); } catch { return []; } })();
  await db.query('DELETE FROM shell_tools WHERE shell_id=?', [shellId]);
  for (const name of (Array.isArray(on) ? on : [])) {
    await db.query('INSERT IGNORE INTO shell_tools (shell_id, tool_name, mode) VALUES (?,?,?)', [shellId, name, 'force_on']);
  }
  for (const name of (Array.isArray(off) ? off : [])) {
    await db.query('INSERT IGNORE INTO shell_tools (shell_id, tool_name, mode) VALUES (?,?,?)', [shellId, name, 'force_off']);
  }
}

// 克隆：源壳（行+三态）→ 新 key（pack 语义复制后 import）
export async function cloneShell(fromKey, newKey, name) {
  if (!isKeyOk(newKey)) throw new Error('newKey 非法');
  const src = await getShellByKey(fromKey);
  if (!src) throw new Error('源壳不存在: ' + fromKey);
  if (newKey === SHELL_DEFAULT_KEY) throw new Error('不可克隆为保留壳 default');
  const pack = rowToPack(src);
  pack.key = newKey;
  pack.name = name || src.name + '（克隆）';
  const r = await importShell(pack);
  // 三态行已由 importShell 重建（含源 force_on/off）；如需连壳设置一起克隆可在此扩展（B 系列）
  return r;
}

// 软停用（default 壳不可停用）；工具/设置行保留（可恢复）
export async function disableShell(key) {
  if (key === SHELL_DEFAULT_KEY) throw new Error('default 壳不可停用');
  const r = await db.query("UPDATE shells SET status='disabled', updated_at=NOW() WHERE skey=?", [String(key)]);
  return r.affectedRows > 0;
}

// patch：可改 name/description/persona/status/modelPolicy（模型广场"设置壳默认模型"用；pack 其余字段走 import 全量替换）
// persona 为 MySQL JSON 列：入库必须 JSON 序列化（裸文本会 Invalid JSON text）；name/description/status 为标量列直接落
export async function patchShell(key, patch) {
  const set = [], params = [];
  for (const k of ['name', 'description', 'status']) {
    if (patch[k] !== undefined) { set.push(k + '=?'); params.push(typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]); }
  }
  if (patch.persona !== undefined) { set.push('persona=?'); params.push(JSON.stringify(patch.persona === null ? null : String(patch.persona))); }
  if (patch.modelPolicy !== undefined) {
    // 归一写入但保留未提交字段旧值：UI 只存 defaultProvider/defaultModel，若整体重建会抹掉已配 budgetYuan/allowModels
    // （F1 后 budgetYuan 有运行语义——审计 C）；读取旧 model_policy 做缺省保留
    const oldRow = await getShellByKey(String(key));
    let oldMp = {};
    if (oldRow && oldRow.model_policy != null) {
      try { oldMp = typeof oldRow.model_policy === 'string' ? JSON.parse(oldRow.model_policy) : (oldRow.model_policy || {}); } catch { oldMp = {}; }
    }
    const mp = (patch.modelPolicy && typeof patch.modelPolicy === 'object') ? patch.modelPolicy : {};
    set.push('model_policy=?');
    params.push(JSON.stringify({
      defaultProvider: mp.defaultProvider !== undefined ? (mp.defaultProvider || '') : (oldMp.defaultProvider || ''),
      defaultModel: mp.defaultModel !== undefined ? (mp.defaultModel || '') : (oldMp.defaultModel || ''),
      allowModels: Array.isArray(mp.allowModels) ? mp.allowModels : (Array.isArray(oldMp.allowModels) ? oldMp.allowModels : []),
      budgetYuan: mp.budgetYuan !== undefined ? (mp.budgetYuan || 0) : (oldMp.budgetYuan || 0),
      qualityCostBias: mp.qualityCostBias !== undefined ? mp.qualityCostBias : (oldMp.qualityCostBias != null ? oldMp.qualityCostBias : null),
    }));
  }
  if (!set.length) return { ok: true };
  set.push('updated_at=NOW()');
  const r = await db.query(`UPDATE shells SET ${set.join(', ')} WHERE skey=?`, [...params, String(key)]);
  return { ok: r.affectedRows > 0 };
}

// export：壳行 → pack 对象（1.3 壳开发"导出 pack"；DB 镜像为权威当前态，文件权威性见 §3.2 双写）
export async function exportShell(key) {
  const s = await getShellByKey(key);
  if (!s) return null;
  return rowToPack(s);
}

export async function shellTools(key) {
  const s = await getShellByKey(key);
  if (!s) return null;
  return db.query('SELECT tool_name, mode FROM shell_tools WHERE shell_id=? ORDER BY tool_name', [s.id]);
}
