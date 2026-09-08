// src/console/TemplateBoard.jsx - 1.6 Agent 广场（应用/模板库；§6.5 ⑥：模板=应用的半成品）
// 功能：模板浏览（应用形态说明卡）+ 详情（档案/技能/验收/guide）+ 应用至壳 + 开任务指令。
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function TemplateBoard() {
  const [templates, setTemplates] = useState([]);
  const [cur, setCur] = useState(null);       // 当前查看模板（完整）
  const [shells, setShells] = useState([]);
  const [targetShell, setTargetShell] = useState('');
  const [goal, setGoal] = useState('');
  const [prompt, setPrompt] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api.templates(), api.shells().catch(() => ({ shells: [] }))]);
      setTemplates(t.templates || []);
      const usable = (s.shells || []).filter((x) => x.status === 'enabled' && x.skey !== 'default');
      setShells(usable);
      if (usable.length) setTargetShell((v) => v || usable[0].skey);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openTpl = async (key) => {
    setErr(''); setMsg(''); setPrompt(''); setGoal('');
    try { const d = await api.templateGet(key); setCur(d.template); }
    catch (e) { setErr(e.message); }
  };

  const doApply = async () => {
    if (!cur || !targetShell) { setErr('请先选模板与目标壳'); return; }
    try {
      const r = await api.templateApply(cur.key, targetShell);
      setMsg('已装配到壳 ' + targetShell + '：档案「' + r.profile + '」生效（该壳会话点名即可路由）');
    } catch (e) { setErr(e.message); }
  };

  const doPrompt = async () => {
    if (!cur) return;
    try { const r = await api.templatePrompt(cur.key, goal); setPrompt(r.prompt); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">任务模板库（⑥ · 模板=应用的半成品；随仓库 git 管理 §6.5）</div>
      <div className="rw-dash-muted" style={{ marginBottom: 10 }}>
        D9 命名：壳=容器 / 应用=业务单元 / 档案+技能+验收=应用组成件。v1 承载=模板包（taskProfile+技能+验收+说明）；可执行应用形态随后续。
      </div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-dash-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
        {templates.length === 0 && <div className="rw-console-ph"><div>暂无模板（仓库 templates/ 目录为空）</div></div>}
        {templates.map((t) => (
          <div key={t.key} className="rw-dash-card" style={{ cursor: 'pointer' }} onClick={() => openTpl(t.key)}>
            <div className="rw-dash-title">🧩 {t.name || t.key}</div>
            <div className="rw-dash-muted" style={{ fontSize: 12 }}>{String(t.description || '').slice(0, 90)}</div>
            <div className="rw-provider-models" style={{ marginTop: 6 }}>
              {t.profileKey && <span className="rw-provider-model">档案: {t.profileKey}</span>}
              {(t.skills || []).map((s) => <span key={s} className="rw-provider-model">技能: {s}</span>)}
              <span className="rw-provider-model">验收点: {t.checks || 0}</span>
              {t.targetShell && <span className="rw-provider-model">建议壳: {t.targetShell}</span>}
            </div>
          </div>
        ))}
      </div>

      {cur && (
        <div className="rw-provider" style={{ marginTop: 14 }}>
          <div className="rw-dash-title">{cur.name}（{cur.key}）</div>
          <div className="rw-dash-muted">{cur.description}</div>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>档案（taskProfile）</div>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: 'var(--rw-bg)', borderRadius: 8, padding: 8 }}>{JSON.stringify(cur.taskProfile, null, 2)}</pre>
          <div className="rw-cap-gtitle" style={{ marginTop: 8 }}>技能 + 验收</div>
          <div className="rw-provider-models">{(cur.skills || []).map((s) => <span key={s} className="rw-provider-model">{s}</span>)}</div>
          <ol style={{ fontSize: 12.5, paddingLeft: 18 }}>
            {(cur.acceptanceTemplate?.checks || []).map((c, i) => <li key={i}>{c}</li>)}
          </ol>
          {cur.guide && <div className="rw-dash-result" style={{ marginTop: 8 }}>说明：{cur.guide}</div>}

          <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>应用至壳（壳会话点名该档案即按模板路由/受技能约束）</div>
          <div className="rw-console-toolbar">
            <select className="rw-select" value={targetShell} onChange={(e) => setTargetShell(e.target.value)}>
              {shells.map((s) => <option key={s.skey} value={s.skey}>{s.name}（{s.skey}）</option>)}
            </select>
            <button className="rw-btn pri" onClick={doApply}>装配到该壳</button>
          </div>

          <div className="rw-cap-gtitle" style={{ marginTop: 12 }}>从模板开任务（生成开任务指令 → 复制到对话页发送）</div>
          <div className="rw-console-toolbar">
            <input className="rw-input" style={{ flex: 1 }} placeholder="本次具体目标（可空，如：修复登录按钮失效）" value={goal} onChange={(e) => setGoal(e.target.value)} />
            <button className="rw-btn" onClick={doPrompt}>生成指令</button>
          </div>
          {prompt && (
            <div className="rw-provider" style={{ marginTop: 8 }}>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5 }}>{prompt}</pre>
              <button className="rw-btn" onClick={() => { navigator.clipboard?.writeText(prompt); setMsg('已复制指令，去「💬 对话页」粘贴发送即从模板开任务'); }}>复制指令</button>
            </div>
          )}
          <div className="rw-console-toolbar" style={{ marginTop: 8 }}>
            <button className="rw-btn" onClick={() => setCur(null)}>← 收起</button>
          </div>
        </div>
      )}
      <div className="rw-console-note">模板包随仓库 git 版本管理（templates/&lt;key&gt;/tpl.json）：新增/修订=仓库提交后部署生效；模板=档案+技能+验收+说明，回流与分发见 §10。可执行应用形态（独立运行/挂壳/共享）=D9 后置。</div>
    </div>
  );
}
