// src/console/EvoBoard.jsx - 1.5 Agent 进化（D8：每日自我进化/周报信号 + 提案文件审批 + 审计流水）
import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

export default function EvoBoard() {
  const [proposals, setProposals] = useState([]);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [tasks, setTasks] = useState([]);
  const [audit, setAudit] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, t, a] = await Promise.all([api.proposals().catch(() => ({ proposals: [] })), api.tasks().catch(() => ({ tasks: [] })), api.audit(60).catch(() => ({ audit: [] }))]);
      setProposals(p.proposals || []);
      setTasks(t.tasks || []);
      setAudit(a.audit || []);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const view = async (file) => {
    try { const d = await api.proposalContent(file); setContent(d.content || String(d.raw || '')); }
    catch (e) { setErr(e.message); }
  };
  const create = async () => {
    if (!title.trim() || !draft.trim()) { setErr('标题与正文必填'); return; }
    try { await api.createProposal(title, draft); setMsg('提案已创建：' + title); setTitle(''); setDraft(''); load(); }
    catch (e) { setErr(e.message); }
  };
  const daily = tasks.find((x) => x.id === 4);
  const weekly = tasks.find((x) => x.id === 3);

  return (
    <div className="rw-cap-group">
      <div className="rw-cap-gtitle">进化载体（定时任务：每日自我进化 #4 · 周报 KPI #3）</div>
      {err && <div className="rw-kb-err">{err}</div>}
      {msg && <div className="rw-kb-msg">{msg}</div>}
      <div className="rw-dash-grid" style={{ marginTop: 0 }}>
        {daily && (
          <div className="rw-dash-card">
            <div className="rw-dash-title">每日自我进化（#4 · 05:00）</div>
            <div className="rw-dash-row"><span className={'rw-kb-tag ' + (daily.enabled ? 'global' : 'conv')}>{daily.enabled ? '运行中' : '已暂停'}</span>
              <span className="rw-dash-muted">上次 {daily.last_run ? String(daily.last_run).slice(0, 16) : '未运行'}</span></div>
            {daily.last_result && <div className="rw-dash-result">{String(daily.last_result).slice(0, 200)}</div>}
          </div>
        )}
        {weekly && (
          <div className="rw-dash-card">
            <div className="rw-dash-title">每周周报（#3 · KPI）</div>
            <div className="rw-dash-row"><span className={'rw-kb-tag ' + (weekly.enabled ? 'global' : 'conv')}>{weekly.enabled ? '运行中' : '已暂停'}</span>
              <span className="rw-dash-muted">上次 {weekly.last_run ? String(weekly.last_run).slice(0, 16) : '未运行'}</span></div>
            {weekly.last_result && <div className="rw-dash-result">{String(weekly.last_result).slice(0, 200)}</div>}
          </div>
        )}
      </div>

      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>修订提案（proposals 文件；审批后按 §11 受控合并）</div>
      <div className="rw-console-toolbar" style={{ alignItems: 'flex-start' }}>
        {proposals.map((p) => (
          <button key={p.file} className="rw-btn" onClick={() => view(p.file)} title={p.file}>{p.title}</button>
        ))}
        {proposals.length === 0 && <span className="rw-dash-muted">（暂无提案文件）</span>}
      </div>
      <input className="rw-input" placeholder="新提案标题（如：xxx v1 提案）" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea className="rw-input" rows="4" placeholder="提案正文（markdown）…" style={{ marginTop: 6, width: '100%' }} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button className="rw-btn pri" onClick={create} style={{ marginTop: 6 }}>＋ 创建提案</button>
      {content && (
        <div className="rw-provider" style={{ marginTop: 10 }}>
          <div className="rw-cap-gtitle">提案内容</div>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, maxHeight: 300, overflowY: 'auto' }}>{content.slice(0, 4000)}</pre>
        </div>
      )}

      <div className="rw-cap-gtitle" style={{ marginTop: 16 }}>最近操作审计（audit_log，redactSecrets 脱敏）</div>
      <table className="rw-console-table">
        <thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>
          {audit.slice(0, 30).map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{String(r.created_at).slice(0, 16)}</td>
              <td><code>{r.action}</code></td>
              <td style={{ wordBreak: 'break-all' }}>{String(r.detail || '').slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
