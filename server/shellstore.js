// server/shellstore.js - B1 壳库：import/clone/list/get（基于 db + shells 纯函数）
// 依据：v2.6 §3/§8；文件 pack.json 为权威、DB 为运行态镜像（双写原则 §3.2）。
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
      `UPDATE shells SET name=?, description=?, persona=?, domain_text=?, model_policy=?, tools_preset=?, tools_force_on=?, tools_force_off=?, knowledge_scopes=?, skills_allow=?, guardrails=?, channels=?, ui_brand=?, eval_ref=?, updated_at=NOW() WHERE id=?`,
      [row.name, row.description, row.persona, row.domain_text, row.model_policy, row.tools_preset,
        row.tools_force_on, row.tools_force_off, row.knowledge_scopes, row.skills_allow, row.guardrails,
        row.channels, row.ui_brand, row.eval_ref, existing.id]
    );
    const id = existing.id;
    await replaceTools(id, row);
    return { id, key: row.skey, mode: 'updated' };
  }
  const r = await db.query(
    `INSERT INTO shells (skey, name, description, persona, domain_text, model_policy, tools_preset, tools_force_on, tools_force_off, knowledge_scopes, skills_allow, guardrails, channels, ui_brand, eval_ref, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
    [row.skey, row.name, row.description, row.persona, row.domain_text, row.model_policy, row.tools_preset,
      row.tools_force_on, row.tools_force_off, row.knowledge_scopes, row.skills_allow, row.guardrails,
      row.channels, row.ui_brand, row.eval_ref, 'enabled']
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

export async function patchShell(key, patch) {
  const allow = ['name', 'description', 'persona', 'status'];
  const set = [], params = [];
  for (const k of allow) {
    if (patch[k] !== undefined) { set.push(k + '=?'); params.push(typeof patch[k] === 'object' ? JSON.stringify(patch[k]) : patch[k]); }
  }
  if (!set.length) return { ok: true };
  if (set.includes('status=') && String(patch.status) === 'enabled') { /* fine */ }
  set.push('updated_at=NOW()');
  const r = await db.query(`UPDATE shells SET ${set.join(', ')} WHERE skey=?`, [...params, String(key)]);
  return { ok: r.affectedRows > 0 };
}

export async function shellTools(key) {
  const s = await getShellByKey(key);
  if (!s) return null;
  return db.query('SELECT tool_name, mode FROM shell_tools WHERE shell_id=? ORDER BY tool_name', [s.id]);
}
