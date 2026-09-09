// src/console/AppsBoard.jsx - 应用（D9）：浏览应用 → 启动（建挂壳会话+预填开场草稿，跳对话页）
// 模板库（⑥ 半成品）子区已按 §7.5 定案 A 迁至 Agent（壳）页 —— 本页专注应用启动。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function AppsBoard({ onGoChat }) {
  const [apps, setApps] = useState([]);
  const [cur, setCur] = useState(null);
  const [shells, setShells] = useState([]);
  const [goal, setGoal] = useState('');
  const [launchShell, setLaunchShell] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([api.apps(), api.shells().catch(() => ({ shells: [] }))]);
      setApps(a.apps || []);
      const usable = (s.shells || []).filter((x) => x.status === 'enabled' && x.skey !== 'default');
      setShells(usable);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openApp = async (key) => {
    setErr(''); setMsg(''); setGoal('');
    try { const d = await api.appGet(key); setCur(d.app); setLaunchShell(d.app.targetShell || (shells[0]?.skey || '')); }
    catch (e) { setErr(e.message); }
  };

  const doLaunch = async () => {
    if (!cur) return;
    setBusy(cur.key); setErr(''); setMsg('');
    try {
      const r = await api.appLaunch(cur.key, { goal, shellKey: launchShell || undefined });
      // 跳对话页并预填开场草稿（经 sessionStorage 传递，用户可编辑后发送）
      if (onGoChat) onGoChat(r.conversationId, r.draft || '');
      else { setMsg('已启动会话 #' + r.conversationId + '；开场草稿已复制：请到对话页粘贴后发送'); navigator.clipboard?.writeText(r.draft || ''); }
    } catch (e) { setErr(e.message); }
    finally { setBusy(''); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">应用（D9：壳=容器 / 应用=业务单元；可一键启动）</div>
      <div className="rw-dash-muted" style={{ marginBottom: 10 }}>启动=在目标壳下新建会话并预填应用开场（复用现有对话链路，不建第二套会话体系）；无人值守执行（契约 driver 跑到验收）为后续形态。任务模板库（应用半成品）见「Agent（壳）」页子区（§7.5 定案 A）。</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
        {apps.length === 0 && <div className="rw-console-ph"><div>暂无应用（仓库 apps/ 目录为空）</div></div>}
        {apps.map((a) => (
          <div key={a.key} className="rw-dash-card" style={{ cursor: 'pointer' }} onClick={() => openApp(a.key)}>
            <div className="rw-dash-title">🚀 {a.name || a.key}</div>
            <div className="rw-dash-muted" style={{ fontSize: 12 }}>{String(a.description || '').slice(0, 80)}</div>
            <div className="rw-provider-models" style={{ marginTop: 6 }}>
              {a.entryProfileKey && <span className="rw-provider-model">入口档案: {a.entryProfileKey}</span>}
              {(a.skills || []).map((s) => <span key={s} className="rw-provider-model">技能: {s}</span>)}
              {a.targetShell && <span className="rw-provider-model">目标壳: {a.targetShell}</span>}
            </div>
          </div>
        ))}
      </div>

      {cur && (
        <div className="rw-provider" style={{ marginTop: 14 }}>
          <div className="rw-dash-title">{cur.name}（{cur.key}）</div>
          <div className="rw-dash-muted">{cur.description}</div>
          {cur.persona && <div className="rw-dash-result" style={{ marginTop: 8 }}>人格：{cur.persona}</div>}
          {cur.entryProfile && <div className="rw-dash-result" style={{ marginTop: 6 }}>入口档案：{cur.entryProfile.name}（模型 {cur.entryProfile.modelHint?.defaultProvider}/{cur.entryProfile.modelHint?.defaultModel}）</div>}
          {(cur.acceptance?.checks || []).length > 0 && (
            <>
              <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>验收（组成件）</div>
              <ol style={{ fontSize: 12.5, paddingLeft: 18 }}>{(cur.acceptance.checks).map((c, i) => <li key={i}>{c}</li>)}</ol>
            </>
          )}
          <div className="rw-cap-gtitle" style={{ marginTop: 10 }}>启动（目标壳：无壳=通用会话）</div>
          <div className="rw-console-toolbar">
            <select className="rw-select" value={launchShell} onChange={(e) => setLaunchShell(e.target.value)}>
              <option value="">无壳（通用）</option>
              {shells.map((s) => <option key={s.skey} value={s.skey}>{s.name}（{s.skey}）</option>)}
            </select>
            <input className="rw-input" style={{ flex: 1 }} placeholder="本次目标（可空）" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <button className="rw-btn pri" disabled={busy === cur.key} onClick={doLaunch}>{busy === cur.key ? '启动中…' : '🚀 启动应用'}</button>
            <button className="rw-btn" onClick={() => setCur(null)}>收起</button>
          </div>
          <div className="rw-dash-muted" style={{ marginTop: 6 }}>启动后跳「💬 对话页」：开场草稿已预填输入框，可补充目标后按 Enter 发送即在本会话按应用语境工作。</div>
        </div>
      )}
      <div className="rw-console-note">应用随仓库 git 管理（apps/&lt;key&gt;/app.json）；应用=壳内点开的成品业务单元，扩展中心（A3）将统一资产化管理。任务模板=应用半成品 →「Agent（壳）」页子区可查看/装配档案。</div>
    </div>
  );
}
