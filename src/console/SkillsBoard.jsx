// src/console/SkillsBoard.jsx - A5 §8.6 技能库页：SKILL.md 文件权威管理（列表/新建/编辑/停用/删除 + 三层校验①静态②冲突③运行回环冒烟）
// 提示：技能目录=平台共享（/srv/rw-workspace/skills）；壳级技能装配在 Agent（壳）页装配向导 step5 勾选。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function SkillsBoard() {
  const [skills, setSkills] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [cur, setCur] = useState(null);     // 正在编辑/查看：{name, raw}
  const [busy, setBusy] = useState('');
  const [conflictWarns, setConflictWarns] = useState([]);
  const [smoke, setSmoke] = useState(null); // 运行回环结果

  const load = useCallback(async () => {
    setErr('');
    try { const d = await api.skillsList(); setSkills(d.skills || []); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openNew = () => setCur({ name: '', raw: '---\nname: my-skill\ndescription: 一句话说明何时用\nversion: 1.0.0\nenabled: true\nwhen: \nnot: \n---\n\n# 步骤\n1. \n\n## 完成定义\n- ' });
  const openEdit = async (name) => {
    setErr(''); setMsg(''); setSmoke(null); setConflictWarns([]);
    try { const d = await api.skillGet(name); setCur({ name, raw: d.skill.raw || '' }); }
    catch (e) { setErr(e.message); }
  };
  const save = async () => {
    if (!cur) return;
    setBusy('save'); setErr(''); setMsg(''); setConflictWarns([]); setSmoke(null);
    try {
      const r = await api.skillSave(cur.name, cur.raw);
      setConflictWarns(r.conflictWarnings || []);
      setMsg('已保存技能 ' + cur.name + '（frontmatter enabled=' + (r.enabled ? 'true' : 'false') + '）');
      load();
    } catch (e) { setErr('静态校验失败：' + e.message); }
    finally { setBusy(''); }
  };
  const toggleEnabled = async (s) => {
    setBusy(s.name); setErr('');
    try { await api.skillPatch(s.name, { enabled: !s.enabled }); setMsg((s.enabled ? '已停用' : '已启用') + ' ' + s.name + '（软停：文件保留，列表/载入跳过）'); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const doDelete = async (s) => {
    if (!confirm('删除技能 ' + s.name + '？（须先停用）')) return;
    setBusy(s.name); setErr('');
    try { await api.skillDelete(s.name); setMsg('已删除 ' + s.name); load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };
  const runSmoke = async () => {
    if (!cur) return;
    setBusy('smoke'); setErr(''); setSmoke(null);
    try { const r = await api.skillSmoke(cur.name); setSmoke(r); }
    catch (e) { setErr('冒烟异常：' + e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">技能库（§8.6：skills/&lt;名&gt;/SKILL.md 文件权威；三层校验 ①静态 ②冲突 ③运行回环）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-console-toolbar" style={{ marginBottom: 8 }}>
        <button className="rw-btn pri" onClick={openNew}>＋ 新建技能（SKILL.md）</button>
        <span className="rw-dash-muted">已上架 {skills.filter((s) => s.enabled).length} / 全部 {skills.length}；停用=enabled:false 软停；平台技能=全局通用，壳技能装配见 Agent 页 step5。</span>
      </div>

      {cur && (
        <div className="rw-provider" style={{ marginBottom: 12 }}>
          <div className="rw-dash-title">编辑技能：{cur.name || '（新技能）'}</div>
          <div className="rw-cap-item col">
            <span>技能目录名（小写字母数字连字符；保存后不可改目录=用新建替代）</span>
            <input className="rw-input" value={cur.name} onChange={(e) => setCur((c) => ({ ...c, name: e.target.value }))} disabled={!!(cur.raw && cur.name && cur.raw.includes('name: ' + cur.name)) && false} placeholder="my-skill" />
          </div>
          <div className="rw-cap-item col">
            <span>SKILL.md 全文（frontmatter: name/description/version/enabled/when/not + 正文步骤/完成定义）</span>
            <textarea className="rw-input" rows="18" style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} value={cur.raw}
              onChange={(e) => setCur((c) => ({ ...c, raw: e.target.value }))} />
          </div>
          <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
            <button className="rw-btn pri" disabled={busy === 'save'} onClick={save}>{busy === 'save' ? '保存中…' : '保存（静态校验）'}</button>
            {cur.name && <button className="rw-btn" disabled={busy === 'smoke'} onClick={runSmoke}>{busy === 'smoke' ? '冒烟中…' : '▶ 运行回环冒烟'}</button>}
            <button className="rw-btn" onClick={() => { setCur(null); setConflictWarns([]); setSmoke(null); }}>收起</button>
          </div>
          {conflictWarns.length > 0 && <div className="rw-kb-msg" style={{ background: '#fff8e6', color: '#8a6d1a' }}>⚠️ 冲突提示（不阻断保存）：{conflictWarns.map((w) => <div key={w} style={{ fontSize: 12 }}>{w}</div>)}</div>}
          {smoke && (
            <div className="rw-provider" style={{ marginTop: 8 }}>
              <div className="rw-dash-title">运行回环（第③层）：{smoke.passed ? '✅ 可载入' : '❌ 载入/执行异常'}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{smoke.summary}</pre>
            </div>
          )}
        </div>
      )}

      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))' }}>
        {skills.length === 0 && <div className="rw-console-ph"><div>暂无技能（skills/ 目录为空）</div></div>}
        {skills.map((s) => (
          <div key={s.name} className={'rw-dash-card' + (s.enabled ? '' : ' off')} style={!s.enabled ? { opacity: 0.55 } : {}}>
            <div className="rw-dash-title">🧰 {s.description ? s.name : s.name}
              <span className={'rw-kb-tag ' + (s.enabled ? 'global' : 'conv')}>{s.enabled ? '已上架' : '已停用'}</span>
              <span className="rw-dash-sub">v{s.version || '1.0.0'}</span>
            </div>
            <div className="rw-dash-muted" style={{ fontSize: 12 }}>{s.description}</div>
            {s.when && <div className="rw-dash-muted" style={{ fontSize: 11 }}>适用：{s.when}</div>}
            <div className="rw-console-toolbar" style={{ marginTop: 6 }}>
              <button className="rw-btn" onClick={() => openEdit(s.name)}>编辑</button>
              <button className="rw-btn" onClick={() => toggleEnabled(s)} disabled={busy === s.name}>{s.enabled ? '停用' : '启用'}</button>
              <button className="rw-btn" onClick={() => doDelete(s)} disabled={busy === s.name}>删除</button>
            </div>
          </div>
        ))}
      </div>
      <div className="rw-console-note">三层校验：保存即做 ①静态（frontmatter/正文/占位符）与 ②冲突（与既有技能描述重叠/命名空间）；「运行回环冒烟」=③ 用真实会话载入该技能验证可执行。停用后 skills_list/skill_load 跳过、文件保留；删除需先停用。发布源另有 packs/rw-core/skills（git），运行时=技能目录（可随部署同步）。</div>
    </div>
  );
}
